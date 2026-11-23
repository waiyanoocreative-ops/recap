import { Type } from '@google/genai';
import { z } from 'zod';
import type {
  SpeechStyle,
  TargetLang,
} from '../../shared/projectTypes.ts';
import { hashString, readProjectCache, writeProjectCache } from '../analyze/cache.ts';
import { getConfig } from '../config.ts';
import { countSyllables, type MergedDubCue } from '../dub/syllables.ts';
import type { TranslatedCueItem } from '../dub/translate.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { executeResilientGeminiCall } from '../gemini/resilientClient.ts';
import { getProject } from '../storage/projectStore.ts';
import { withExponentialBackoffRetry } from '../utils/retry.ts';

const BatchRecapSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      translation: z.string(),
    }),
  ),
});

const SingleRecapSchema = z.object({
  translation: z.string().min(1),
});

const BANNED_VERBOSE_BURMESE_RE =
  /(?:ခံခဲ့ရပါတယ်ခင်ဗျာ|ပါတယ်ခင်ဗျာ|ပါတယ်ရှင်|စေခဲ့ပါတယ်|ခင်ဗျာ|ရှင့်|ပါရှင်)/;

const RECAP_TRANSITION_PREFIXES = [
  'ရုတ်တရက်ဆိုသလို',
  'ရုတ်တရက်',
  'အဲ့ဒီနောက်မှာတော့',
  'အဲ့ဒီနောက်',
  'ဒါကိုမြင်တော့',
  'ဒီလိုနဲ့',
  'ဒါပေမဲ့',
  'မကြာခင်မှာပဲ',
  'အဲ့ဒီအချိန်မှာပဲ',
  'ဒီတစ်ခါမှာတော့',
  'မထင်မှတ်ဘဲ',
  'တစ်ဖက်မှာတော့',
  'ဒီအတွက်ကြောင့်',
  'ဒါကြောင့်',
  'နောက်ဆုံးမှာတော့',
];

export function detectLeadingRecapTransition(text: string): string | null {
  const trimmed = text.trim();
  for (const prefix of RECAP_TRANSITION_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return prefix.startsWith('ရုတ်တရက်') ? 'ရုတ်တရက်' : prefix;
    }
  }
  return null;
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

/**
 * Strict Burmese recap syllable budget per beat slot_ms.
 */
export function computeRecapMaxSyllables(slotMs: number): number {
  const safeSlotMs = Math.max(200, Math.round(slotMs));
  return Math.max(8, Math.floor((safeSlotMs / 1000) * 3.8));
}

/**
 * Prepares Recap Mode cues in strict chronological order:
 * - Never drops the opening segment (00:00 to the first cue): anchors Cue #1 start_ms to 0.
 * - Guarantees non-overlapping beats (cue[i].end_ms <= cue[i+1].start_ms) with >= 200ms slot_ms.
 */
export function prepareRecapCues(
  rawCues: MergedDubCue[],
  videoDurationMs: number,
  opts: { anchorOpeningToZero?: boolean } = {},
): MergedDubCue[] {
  if (rawCues.length === 0) return [];

  const anchorOpening = opts.anchorOpeningToZero ?? true;
  const sorted = [...rawCues]
    .filter((c) => c.text.trim().length > 0 && c.end_ms > c.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((c) => ({ ...c }));

  if (sorted.length === 0) return [];

  if (anchorOpening && sorted[0].start_ms > 0) {
    sorted[0].start_ms = 0;
  }

  const maxEnd = videoDurationMs > 0 ? videoDurationMs : Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i];
    if (cur.end_ms < cur.start_ms + 200) {
      cur.end_ms = Math.min(maxEnd, cur.start_ms + 200);
    }
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (cur.end_ms > next.start_ms) {
        if (next.start_ms >= cur.start_ms + 200) {
          cur.end_ms = next.start_ms;
        } else {
          cur.end_ms = Math.min(maxEnd, cur.start_ms + 200);
          next.start_ms = cur.end_ms;
          if (next.end_ms < next.start_ms + 200) {
            next.end_ms = Math.min(maxEnd, next.start_ms + 200);
          }
        }
      }
    }
  }

  return sorted;
}

export function normalizeRecapText(text: string, lang: TargetLang): string {
  let cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  if (lang === 'my-MM') {
    cleaned = cleaned.replace(/(?:ခင်ဗျာ|ရှင့်|ရှင်)[။.]*\s*$/g, '').trim();
    cleaned = cleaned.replace(/\.+$/, '။');
    if (!/[။]$/.test(cleaned)) {
      cleaned = `${cleaned.replace(/[!?！？,၊…]+$/g, '').trim()}။`;
    }
  } else if (!/[.!?]["'”’)\]]*$/.test(cleaned)) {
    cleaned = `${cleaned}.`;
  }

  return cleaned;
}

export function validateRecapTranslation(
  text: string,
  slotMs: number,
  lang: TargetLang,
): { valid: boolean; reason?: string; syllables: number; maxSyllables: number } {
  const maxSyllables = computeRecapMaxSyllables(slotMs);
  const cleaned = text.trim();
  const syllables = countSyllables(cleaned, lang);

  if (!cleaned) {
    return { valid: false, reason: 'Empty recap narration.', syllables: 0, maxSyllables };
  }

  if (lang === 'my-MM') {
    if (!/[။]["'”’)\]]*$/.test(cleaned)) {
      return {
        valid: false,
        reason: 'Recap sentence must end cleanly with ။.',
        syllables,
        maxSyllables,
      };
    }
    if (BANNED_VERBOSE_BURMESE_RE.test(cleaned)) {
      return {
        valid: false,
        reason: 'Avoid verbose polite endings (use punchy recap storytelling tone).',
        syllables,
        maxSyllables,
      };
    }
    const sentenceCount = (cleaned.match(/။/g) ?? []).length;
    if (sentenceCount > 1) {
      return {
        valid: false,
        reason: `Recap cue must be ONE single concise sentence (got ${sentenceCount}).`,
        syllables,
        maxSyllables,
      };
    }
  } else if (!/[.!?]["'”’)\]]*$/.test(cleaned)) {
    return {
      valid: false,
      reason: 'English recap line must end with terminal punctuation (. / ? / !).',
      syllables,
      maxSyllables,
    };
  }

  if (syllables > maxSyllables) {
    return {
      valid: false,
      reason: `Exceeds recap syllable budget (${syllables} > ${maxSyllables} max_syllables for ${(slotMs / 1000).toFixed(1)}s slot).`,
      syllables,
      maxSyllables,
    };
  }

  return { valid: true, syllables, maxSyllables };
}

function buildRecapSystemInstruction(targetLang: TargetLang): string {
  if (targetLang === 'my-MM') {
    return [
      'You are an acclaimed Burmese movie-recap voiceover narrator (like top viral Burmese film recap storytellers).',
      'Always read the entire sequence of beats together and craft ONE continuous, flowing, emotionally gripping Burmese story — NEVER isolated bullet-point translations.',
      'Link consecutive beats seamlessly with varied Burmese conjunctions and natural pronoun flow ("သူက" / omitted subject), NEVER repeating the same hook word like "ရုတ်တရက်" back-to-back, while keeping each beat to ONE complete sentence ending with "။" strictly within max_syllables.',
    ].join(' ');
  }
  return [
    'You are an acclaimed, captivating English movie-recap narrator.',
    'Analyze the entire sequence of beats together and weave them into ONE continuous, flowing story with varied transitions and natural pronoun continuity, while strictly obeying max_syllables and one complete sentence per beat.',
  ].join(' ');
}

function buildRecapPromptRules(targetLang: TargetLang): string[] {
  if (targetLang === 'my-MM') {
    return [
      'COHESIVE STORYTELLING (ANALYZE THE WHOLE SEQUENCE TOGETHER): Read ALL beats (Context BEFORE, the full batch, Story Overview, and Context AFTER) together before writing. Compose ONE continuous, flowing Burmese story arc — NOT disconnected or repetitive beat-by-beat fragments.',
      'VARIED TRANSITIONAL CONJUNCTIONS (NO REPEATED HOOKS): Connect consecutive beats naturally using varied Burmese transitional conjunctions such as "အဲ့ဒီနောက်", "ဒါကိုမြင်တော့", "ဒီလိုနဲ့", "ဒါပေမဲ့", "မကြာခင်မှာပဲ", "အဲ့ဒီအချိန်မှာပဲ", "တစ်ဖက်မှာတော့", "ဒါကြောင့်". NEVER repeat the same transition word in back-to-back or nearby beats. Strictly AVOID overusing "ရုတ်တရက်" (use it at most once in the entire script, or omit it completely). Keep Cue #1 at 00:00 as a strong opening hook, and let many beats flow directly without starting every line with a heavy transition prefix.',
      'NATURAL PRONOUN FLOW & SUBJECT CONTINUITY: When the same character continues acting in consecutive beats, use natural Burmese pronouns ("သူက", "သူမက", "သူတို့က") or naturally drop the repeated subject — NEVER clumsily repeat the character\'s full name or visual description in every beat.',
      'EMOTION, TENSION & NATURAL SPOKEN VOICE: Convey feelings, suspense, and plot stakes instead of blunt literal statements. BANNED verbose/stiff endings: "ခံခဲ့ရပါတယ်ခင်ဗျာ", "စေခဲ့ပါတယ်", "ပါတယ်ခင်ဗျာ", "ပါတယ်ရှင်", and bookish "သည်/၏".',
      'STRICT SYLLABLE BUDGET: Each input item includes "slot_ms" and "max_syllables". Choose crisp, vivid Burmese wording so every sentence STRICTLY stays <= "max_syllables" spoken syllables.',
      'ONE SENTENCE PER BEAT: Divide the continuous story cleanly so EVERY beat outputs EXACTLY ONE complete, meaningful Burmese sentence ending with "။" (never two sentences, never cut off mid-thought).',
      'KEEP ALL CUES (INCLUDING 00:00 OPENING): Return a narration line for EVERY single input id—NEVER skip Cue #1 or return empty text.',
    ];
  }

  return [
    'COHESIVE FLOW: Analyze the entire sequence together and write ONE continuous, flowing English (en-US) movie-recap story rather than isolated cue translations.',
    'VARIED TRANSITIONS & PRONOUNS: Use varied storytelling conjunctions (never repeating the same transition word back-to-back) and natural pronouns when the same character acts across consecutive beats.',
    'STRICT SYLLABLE BUDGET: Each input item includes "slot_ms" and "max_syllables". Keep every sentence strictly at or below "max_syllables" spoken syllables.',
    'ONE SENTENCE RULE: Output EXACTLY ONE vivid, complete sentence ending with . or ? or ! per cue.',
    'KEEP ALL CUES (INCLUDING 00:00 OPENING): Return a narration line for EVERY single input id—NEVER skip Cue #1.',
  ];
}

function getRecapSurroundContext(
  allCues: MergedDubCue[],
  cueId: number,
  radius = 2,
): {
  before: Array<{ id: number; text: string }>;
  after: Array<{ id: number; text: string }>;
} {
  const idx = allCues.findIndex((c) => c.id === cueId);
  if (idx === -1) return { before: [], after: [] };
  return {
    before: allCues
      .slice(Math.max(0, idx - radius), idx)
      .map((c) => ({ id: c.id, text: c.text })),
    after: allCues
      .slice(idx + 1, Math.min(allCues.length, idx + 1 + radius))
      .map((c) => ({ id: c.id, text: c.text })),
  };
}

async function retrySingleRecapCueToBudget(params: {
  projectId: string;
  cue: MergedDubCue;
  allCues: MergedDubCue[];
  previousAnswer: string;
  failureReason: string;
  targetLang: TargetLang;
  glossary: Record<string, string>;
  modelId: string;
  prevNarration?: string;
  avoidOpening?: string;
}): Promise<{ translation: string; review_reason?: string; model_used: string }> {
  const {
    projectId,
    cue,
    allCues,
    previousAnswer,
    failureReason,
    targetLang,
    glossary,
    modelId,
    prevNarration,
    avoidOpening,
  } = params;
  const cfg = getConfig();
  const slotMs = Math.max(200, cue.end_ms - cue.start_ms);
  const maxSyllables = computeRecapMaxSyllables(slotMs);
  const { before, after } = getRecapSurroundContext(allCues, cue.id, 2);
  const glossaryStr = Object.keys(glossary).length > 0 ? JSON.stringify(glossary) : '{}';
  const rules = buildRecapPromptRules(targetLang);

  const hash = hashString(
    `recap-retry-v3|${targetLang}|${modelId}|${cue.id}|slot:${slotMs}|max:${maxSyllables}|${cue.text}|${previousAnswer}|prev:${prevNarration ?? ''}|avoid:${avoidOpening ?? ''}`,
  );
  const cacheKey = `recap_retry_${targetLang}_${hash}`;
  const cached = await readProjectCache(projectId, cacheKey, SingleRecapSchema);

  let nextText = cached ? normalizeRecapText(cached.translation, targetLang) : '';
  let usedModel = modelId;

  if (!nextText) {
    const prompt = [
      `Rewrite this movie-recap cue so it flows naturally from the preceding beat, stays cohesive, is ONE complete sentence, and is STRICTLY <= ${maxSyllables} syllables (${failureReason}).`,
      ...rules,
      `Glossary: ${glossaryStr}`,
      prevNarration
        ? `Immediately preceding beat narration (connect smoothly from this using a DIFFERENT transition or natural pronoun flow "သူက" / omitted subject): ${JSON.stringify(prevNarration)}`
        : '',
      avoidOpening
        ? `FORBIDDEN OPENING WORDS (do NOT start with these or with "ရုတ်တရက်"): ${JSON.stringify(avoidOpening)}`
        : '',
      before.length > 0 ? `Context BEFORE:\n${JSON.stringify(before)}` : '',
      after.length > 0 ? `Context AFTER:\n${JSON.stringify(after)}` : '',
      `Cue:\n${JSON.stringify({
        id: cue.id,
        slot_ms: slotMs,
        max_syllables: maxSyllables,
        speaker: cue.speaker,
        src_lang: cue.src_lang,
        text: cue.text,
      })}`,
      previousAnswer ? `Previous draft (${countSyllables(previousAnswer, targetLang)} syllables — fix length/flow):\n${JSON.stringify(previousAnswer)}` : '',
      'Return ONLY JSON: {"translation": "..."}',
    ]
      .filter(Boolean)
      .join('\n\n');

    const { result: parsed, model } = await withExponentialBackoffRetry(
      () =>
        executeResilientGeminiCall<z.infer<typeof SingleRecapSchema>>({
          projectId,
          kind: 'recap_translate_retry',
          label: `Recap tighten #${cue.id} (<= ${maxSyllables} syl, ${targetLang})`,
          hash,
          queueName: 'geminiText',
          primaryModel: modelId,
          fallbackModels: cfg.TEXT_FALLBACK_MODELS,
          maxNetworkWaitAttempts: 1,
          maxQuotaWaitAttempts: 0,
          onWaiting: (info) => {
            emitProjectEvent(projectId, {
              type: 'stage',
              stage: 'dub',
              message: info.message,
            });
          },
          call: async ({ ai, modelId: activeModelId }) => {
            const response = await ai.models.generateContent({
              model: activeModelId,
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              config: {
                systemInstruction: buildRecapSystemInstruction(targetLang),
                temperature: 0.3,
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    translation: { type: Type.STRING },
                  },
                  required: ['translation'],
                },
              },
            });
            return SingleRecapSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
          },
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        factor: 2,
        label: `Recap tighten #${cue.id} (${targetLang})`,
      },
    );
    nextText = normalizeRecapText(parsed.translation, targetLang);
    usedModel = model;
    if (nextText) {
      await writeProjectCache(projectId, cacheKey, { translation: nextText });
    }
  }

  const prevCheck = validateRecapTranslation(previousAnswer, slotMs, targetLang);
  const nextCheck = validateRecapTranslation(nextText, slotMs, targetLang);

  const prevRepeated = Boolean(
    avoidOpening &&
      detectLeadingRecapTransition(previousAnswer) &&
      (detectLeadingRecapTransition(previousAnswer) === avoidOpening ||
        detectLeadingRecapTransition(previousAnswer) === 'ရုတ်တရက်'),
  );
  const nextRepeated = Boolean(
    avoidOpening &&
      detectLeadingRecapTransition(nextText) &&
      (detectLeadingRecapTransition(nextText) === avoidOpening ||
        detectLeadingRecapTransition(nextText) === 'ရုတ်တရက်'),
  );

  // Pick whichever candidate is valid & avoids repeated transitions, or has fewer syllables
  const preferNext =
    (nextCheck.valid && !nextRepeated) ||
    (!prevCheck.valid && nextCheck.valid) ||
    (prevRepeated && !nextRepeated && Boolean(nextText)) ||
    !prevCheck.valid ||
    (Boolean(nextText) && nextCheck.syllables < prevCheck.syllables);

  const chosen = preferNext ? nextText : previousAnswer;
  const chosenCheck = chosen === nextText ? nextCheck : prevCheck;

  return {
    translation: chosen || cue.text,
    review_reason: chosenCheck.valid ? undefined : chosenCheck.reason,
    model_used: usedModel,
  };
}

export async function translateRecapCuesBatched(params: {
  projectId: string;
  cues: MergedDubCue[];
  allCues: MergedDubCue[];
  targetLang: TargetLang;
  glossary: Record<string, string>;
  speechStyle: SpeechStyle;
  modelId: string;
  force: boolean;
  boundedWait?: boolean;
  onBatchProgress?: (
    doneCount: number,
    totalCount: number,
    partialMap: Map<number, TranslatedCueItem>,
  ) => Promise<void> | void;
}): Promise<{ translations: Map<number, TranslatedCueItem>; modelsUsed: string[] }> {
  const {
    projectId,
    cues,
    allCues,
    targetLang,
    glossary,
    modelId,
    force,
    boundedWait = false,
    onBatchProgress,
  } = params;

  const result = new Map<number, TranslatedCueItem>();
  const modelsUsed = new Set<string>();
  if (cues.length === 0) {
    return { translations: result, modelsUsed: [] };
  }

  const project = await getProject(projectId);
  if (project?.useManualAiBridge) {
    const recapById = new Map(
      project.recap
        .filter((b) => b.lang === targetLang && b.narration_text.trim().length > 0)
        .map((b) => [b.id, b]),
    );
    const dubById = new Map(
      project.dub
        .filter((d) => d.lang === targetLang && d.tgt_text.trim().length > 0)
        .map((d) => [d.id, d]),
    );
    for (const cue of cues) {
      const recapItem = recapById.get(cue.id);
      const dubItem = dubById.get(cue.id);
      const text = recapItem?.narration_text?.trim() || dubItem?.tgt_text?.trim() || cue.text;
      result.set(cue.id, {
        translation: text,
        review_reason: recapItem?.review_reason ?? dubItem?.review_reason,
        model_used: recapItem?.model_used || dubItem?.model_used || 'manual-ai-bridge',
      });
    }
    return { translations: result, modelsUsed: ['manual-ai-bridge'] };
  }

  const cfg = getConfig();
  const batchSize = 15;
  const glossaryStr = Object.keys(glossary).length > 0 ? JSON.stringify(glossary) : '{}';
  const totalBatches = Math.ceil(cues.length / batchSize);
  const rules = buildRecapPromptRules(targetLang);
  const fullStoryOutline =
    allCues.length > batchSize
      ? allCues.map((c) => `#${c.id}: ${c.text.trim()}`).join(' | ').slice(0, 2600)
      : '';
  const previousWrittenBeats: Array<{ id: number; narration: string }> = [];
  const recentTransitions: string[] = [];

  for (let start = 0; start < cues.length; start += batchSize) {
    const batchIndex = Math.floor(start / batchSize) + 1;
    const batch = cues.slice(start, start + batchSize);
    const firstCtx = getRecapSurroundContext(allCues, batch[0].id, 2);
    const lastCtx = getRecapSurroundContext(allCues, batch[batch.length - 1].id, 2);
    const prevBeat = previousWrittenBeats[previousWrittenBeats.length - 1];
    const prevTransition = prevBeat ? detectLeadingRecapTransition(prevBeat.narration) : null;

    const batchPayload = batch.map((c) => {
      const slotMs = Math.max(200, c.end_ms - c.start_ms);
      return {
        id: c.id,
        slot_ms: slotMs,
        max_syllables: computeRecapMaxSyllables(slotMs),
        speaker: c.speaker,
        src_lang: c.src_lang,
        text: c.text,
      };
    });

    const hash = hashString(
      `recap-trans-v3|${targetLang}|${modelId}|g:${glossaryStr}|prevNarr:${JSON.stringify(previousWrittenBeats.slice(-4))}|before:${JSON.stringify(firstCtx.before)}|after:${JSON.stringify(lastCtx.after)}|${JSON.stringify(batchPayload)}`,
    );
    const cacheKey = `recap_trans_${targetLang}_${hash}`;

    let validated = !force
      ? await readProjectCache(projectId, cacheKey, BatchRecapSchema)
      : null;
    let batchModelUsed = modelId;

    if (!validated) {
      const prompt = [
        'Analyze this entire beat sequence together and write ONE continuous, flowing movie-recap story divided cleanly into one complete sentence per beat.',
        'STRICT RULES:',
        ...rules.map((r, i) => `${i + 1}. ${r}`),
        `${rules.length + 1}. Keep consistent names/terms from Glossary: ${glossaryStr}`,
        `${rules.length + 2}. Return ONLY JSON: {"items": [{"id": number, "translation": string}]} containing EVERY input id.`,
        fullStoryOutline
          ? `Full story arc overview (read first for holistic plot flow, output ONLY the current batch ids):\n${fullStoryOutline}`
          : '',
        previousWrittenBeats.length > 0
          ? `Already written Burmese recap beats immediately BEFORE this batch (continue seamlessly with natural pronouns / varied connectors, do NOT repeat):\n${JSON.stringify(previousWrittenBeats.slice(-4))}${prevTransition ? `\nDo NOT open beat #${batch[0].id} with "${prevTransition}" or "ရုတ်တရက်".` : ''}`
          : '',
        firstCtx.before.length > 0 && previousWrittenBeats.length === 0
          ? `Context BEFORE this batch (continuity only, do NOT output):\n${JSON.stringify(firstCtx.before)}`
          : '',
        lastCtx.after.length > 0
          ? `Context AFTER this batch (continuity only, do NOT output):\n${JSON.stringify(lastCtx.after)}`
          : '',
        `Recap cues with slot_ms and max_syllables budget (${batch.length} beats):\n${JSON.stringify(batchPayload)}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const { result: batchRes, model } = await withExponentialBackoffRetry(
        () =>
          executeResilientGeminiCall<z.infer<typeof BatchRecapSchema>>({
            projectId,
            kind: 'recap_translate_batch',
            label: `Recap script ${targetLang} batch ${batchIndex}/${totalBatches}`,
            hash,
            queueName: 'geminiText',
            primaryModel: modelId,
            fallbackModels: cfg.TEXT_FALLBACK_MODELS,
            maxNetworkWaitAttempts: boundedWait ? 1 : 2,
            maxQuotaWaitAttempts: boundedWait ? 0 : 1,
            force,
            onWaiting: (info) => {
              emitProjectEvent(projectId, {
                type: 'stage',
                stage: 'dub',
                message: info.message,
              });
            },
            onResult: async (val) => {
              await writeProjectCache(projectId, cacheKey, val);
            },
            call: async ({ ai, modelId: activeModelId }) => {
              const response = await ai.models.generateContent({
                model: activeModelId,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                  systemInstruction: buildRecapSystemInstruction(targetLang),
                  temperature: 0.35,
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      items: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            id: { type: Type.INTEGER },
                            translation: { type: Type.STRING },
                          },
                          required: ['id', 'translation'],
                        },
                      },
                    },
                    required: ['items'],
                  },
                },
              });
              return BatchRecapSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
            },
          }),
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          factor: 2,
          label: `Recap script ${targetLang} batch ${batchIndex}/${totalBatches}`,
        },
      );
      validated = batchRes;
      batchModelUsed = model;
    }

    modelsUsed.add(batchModelUsed);
    const byId = new Map<number, string>();
    for (const item of validated.items) {
      byId.set(item.id, normalizeRecapText(item.translation, targetLang));
    }

    for (const cue of batch) {
      const slotMs = Math.max(200, cue.end_ms - cue.start_ms);
      const candidate = (byId.get(cue.id) ?? '').trim();
      const check = validateRecapTranslation(candidate, slotMs, targetLang);
      const lastWritten = previousWrittenBeats[previousWrittenBeats.length - 1]?.narration ?? '';
      const lastTrans = lastWritten ? detectLeadingRecapTransition(lastWritten) : null;
      const curTrans = targetLang === 'my-MM' ? detectLeadingRecapTransition(candidate) : null;
      const repeatedHook =
        Boolean(curTrans) &&
        (curTrans === lastTrans ||
          (curTrans === 'ရုတ်တရက်' && recentTransitions.slice(-3).includes('ရုတ်တရက်')));

      let finalItem: TranslatedCueItem;
      if (check.valid && !repeatedHook) {
        finalItem = {
          translation: candidate,
          model_used: batchModelUsed,
        };
      } else {
        const failureReason = !check.valid
          ? check.reason || 'Exceeds recap budget or tone rule'
          : `Repeats opening transition "${curTrans}" from preceding beat — use a fresh Burmese conjunction or natural pronoun continuation`;
        try {
          const retried = await retrySingleRecapCueToBudget({
            projectId,
            cue,
            allCues,
            previousAnswer: candidate,
            failureReason,
            targetLang,
            glossary,
            modelId,
            prevNarration: lastWritten || undefined,
            avoidOpening: curTrans || lastTrans || undefined,
          });
          modelsUsed.add(retried.model_used);
          finalItem = retried;
        } catch (retryErr) {
          console.warn(`[Recap Translate] Auto-retry failed for cue #${cue.id}:`, retryErr);
          finalItem = {
            translation: candidate || cue.text,
            review_reason: check.valid ? undefined : check.reason,
            model_used: batchModelUsed,
          };
        }
      }

      result.set(cue.id, finalItem);
      previousWrittenBeats.push({ id: cue.id, narration: finalItem.translation });
      const chosenTrans = detectLeadingRecapTransition(finalItem.translation);
      if (chosenTrans) {
        recentTransitions.push(chosenTrans);
      }
    }

    if (onBatchProgress) {
      await onBatchProgress(Math.min(cues.length, start + batch.length), cues.length, result);
    }
  }

  return {
    translations: result,
    modelsUsed: Array.from(modelsUsed),
  };
}

export async function retranslateRecapCueShorter(params: {
  projectId: string;
  srcText: string;
  currentTranslation: string;
  slotMs: number;
  targetLang: TargetLang;
  glossary: Record<string, string>;
  modelId: string;
  prevNarration?: string;
  avoidOpening?: string;
  rewriteReason?: string;
}): Promise<{ translation: string; model_used: string; valid: boolean }> {
  const {
    projectId,
    srcText,
    currentTranslation,
    slotMs,
    targetLang,
    glossary,
    modelId,
    prevNarration,
    avoidOpening,
    rewriteReason,
  } = params;
  const project = await getProject(projectId);
  if (project?.useManualAiBridge) {
    const chkManual = validateRecapTranslation(currentTranslation, slotMs, targetLang);
    return {
      translation: currentTranslation,
      model_used: 'manual-ai-bridge',
      valid: chkManual.valid,
    };
  }
  const maxSyllables = computeRecapMaxSyllables(slotMs);

  const hash = hashString(
    `recap-shorten-v3|${targetLang}|${modelId}|slot:${slotMs}|max:${maxSyllables}|${srcText}|${currentTranslation}|prev:${prevNarration ?? ''}|avoid:${avoidOpening ?? ''}|reason:${rewriteReason ?? ''}`,
  );
  const cacheKey = `recap_shorten_${targetLang}_${hash}`;
  const cached = await readProjectCache(projectId, cacheKey, SingleRecapSchema);
  if (cached) {
    const norm = normalizeRecapText(cached.translation, targetLang);
    const chk = validateRecapTranslation(norm, slotMs, targetLang);
    return {
      translation: norm,
      model_used: modelId,
      valid: chk.valid,
    };
  }

  const cfg = getConfig();
  const prompt = [
    rewriteReason
      ? `Rewrite this recap beat (${rewriteReason}) so it flows naturally and stays STRICTLY <= ${maxSyllables} syllables for a ${(slotMs / 1000).toFixed(1)}s beat.`
      : `The recap narration line exceeded the ${maxSyllables}-syllable limit for a ${(slotMs / 1000).toFixed(1)}s beat.`,
    ...buildRecapPromptRules(targetLang),
    prevNarration
      ? `Immediately preceding beat narration (connect seamlessly from this using a DIFFERENT transition or natural pronoun flow "သူက" / omitted subject): ${JSON.stringify(prevNarration)}`
      : '',
    avoidOpening
      ? `FORBIDDEN OPENING WORDS (do NOT start with these or with "ရုတ်တရက်"): ${JSON.stringify(avoidOpening)}`
      : '',
    `Write ONE cohesive, punchy, complete sentence STRICTLY <= ${maxSyllables} syllables (preserving the core story action).`,
    `Original source: ${JSON.stringify(srcText)}`,
    `Current draft (${countSyllables(currentTranslation, targetLang)} syllables): ${JSON.stringify(currentTranslation)}`,
    Object.keys(glossary).length > 0 ? `Glossary: ${JSON.stringify(glossary)}` : '',
    'Return JSON only: {"translation": "..."}',
  ]
    .filter(Boolean)
    .join('\n\n');

  const { result: parsed, model } = await withExponentialBackoffRetry(
    () =>
      executeResilientGeminiCall<z.infer<typeof SingleRecapSchema>>({
        projectId,
        kind: 'recap_retranslate_short',
        label: `Recap tighten (${maxSyllables} syl, ${targetLang})`,
        hash,
        queueName: 'geminiText',
        primaryModel: modelId,
        fallbackModels: cfg.TEXT_FALLBACK_MODELS,
        maxNetworkWaitAttempts: 1,
        maxQuotaWaitAttempts: 0,
        onWaiting: (info) => {
          emitProjectEvent(projectId, {
            type: 'stage',
            stage: 'dub',
            message: info.message,
          });
        },
        call: async ({ ai, modelId: activeModelId }) => {
          const response = await ai.models.generateContent({
            model: activeModelId,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: buildRecapSystemInstruction(targetLang),
              temperature: 0.3,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  translation: { type: Type.STRING },
                },
                required: ['translation'],
              },
            },
          });
          return SingleRecapSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
        },
      }),
    {
      maxAttempts: 3,
      baseDelayMs: 1000,
      factor: 2,
      label: `Recap tighten (${targetLang})`,
    },
  );

  const bestText = normalizeRecapText(parsed.translation, targetLang);
  const check = validateRecapTranslation(bestText, slotMs, targetLang);
  if (bestText) {
    await writeProjectCache(projectId, cacheKey, { translation: bestText });
  }

  return {
    translation: bestText || currentTranslation,
    model_used: model,
    valid: check.valid || Boolean(bestText),
  };
}
