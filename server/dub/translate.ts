import { Type } from '@google/genai';
import { z } from 'zod';
import {
  defaultVoiceForGender,
  getVoiceGender,
  validateTranslationCompleteness,
} from '../../shared/dubUtils.ts';
import {
  MANUAL_AI_BATCH_REMINDER,
  type SpeakerInfo,
  type SpeechStyle,
  type TargetLang,
  type TtsEngineType,
  type VoicePoolsConfig,
} from '../../shared/projectTypes.ts';
import { hashString, readProjectCache, writeProjectCache } from '../analyze/cache.ts';
import { getConfig } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { executeResilientGeminiCall } from '../gemini/resilientClient.ts';
import { getProject } from '../storage/projectStore.ts';
import { GEMINI_PREBUILT_VOICES } from '../tts/ttsEngine.ts';
import { withExponentialBackoffRetry } from '../utils/retry.ts';
import type { MergedDubCue } from './syllables.ts';

const GlossarySchema = z.object({
  terms: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
      }),
    )
    .default([]),
});

const BatchTranslationSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      translation: z.string(),
    }),
  ),
});

const SingleTranslationSchema = z.object({
  translation: z.string().min(1),
});

export interface TranslatedCueItem {
  translation: string;
  review_reason?: string;
  model_used: string;
}

const DEFAULT_EDGE_VOICES: Record<TargetLang, { female: string[]; male: string[] }> = {
  'my-MM': {
    female: ['my-MM-NilarNeural'],
    male: ['my-MM-ThihaNeural'],
  },
  'en-US': {
    female: ['en-US-JennyNeural', 'en-US-AriaNeural'],
    male: ['en-US-GuyNeural', 'en-US-AndrewMultilingualNeural'],
  },
};

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

function buildCompleteTranslationRules(targetLang: TargetLang, speechStyle: SpeechStyle): string[] {
  const dialogueOnlyRule =
    'DIALOGUE-ONLY RULE: Translate ONLY actual meaningful spoken character dialogue. Completely IGNORE and OMIT non-dialogue vocalizations, grunts, exclamations, pain/effort cries, battle cries, laughter, sighs (such as "Ah ah ah", "呀嘿呀", "哈哈哈", "Ugh"), as well as non-speech annotations, background music/lyrics, sound effects (footsteps, wind, crowd murmur, clangs), or stage tags like [Music], [Sigh], [Applause], (sfx). Never output bracketed sound descriptions or translated vocalizations.';

  if (targetLang === 'my-MM') {
    const endingRule =
      speechStyle === 'casual'
        ? 'Speech style ("စကားပြောပုံစံ"): Casual spoken dialogue — use natural casual spoken endings such as တယ်, နော်, လား, တာပေါ့ as fits each sentence. Avoid formal/stiff သည်/၏ bookish endings.'
        : 'Speech style ("စကားပြောပုံစံ"): Polite spoken dialogue — use polite spoken endings such as ပါတယ်, ပါ, ပါနော်, ပါလား as fits each sentence. Avoid formal/stiff သည်/၏ bookish endings.';

    return [
      dialogueOnlyRule,
      'Translate everything into natural spoken Burmese (my-MM) completely and accurately. Do NOT abbreviate, summarize, shorten, or drop any information, name, number, negation, or clause.',
      endingRule,
      'Every sentence MUST be a complete, natural grammatical Burmese spoken sentence ending with a proper sentence-final particle (e.g. ပါတယ်, တယ်, ပါ, နော်, လား, ပါနော်, ပါလား) followed immediately by ။. NEVER output a bare verb stem, mid-clause truncation, or cut-off phrase.',
      'SELF-CHECK BEFORE OUTPUT: Re-read each Burmese line mentally. If any sentence is truncated mid-thought, omits a subject/object/negation, or lacks ။ at the end, rewrite it in full before returning JSON.',
    ];
  }

  const enStyle =
    speechStyle === 'casual'
      ? 'Speech style: Casual everyday conversational American English.'
      : 'Speech style: Polite natural conversational American English.';
  return [
    dialogueOnlyRule,
    'Translate everything into natural spoken English (en-US) completely and accurately. Do NOT abbreviate, summarize, shorten, or drop any information, name, number, negation, or clause.',
    enStyle,
    'Every line must be a grammatically complete spoken sentence ending with a terminal punctuation mark (. or ? or !), never a cut-off fragment.',
    'SELF-CHECK BEFORE OUTPUT: Verify every sentence is complete and ends with ., ?, or ! before returning JSON.',
  ];
}

export function buildManualAiDubPrompt(params: {
  sourceCues: Array<{ id: number; speaker: string; text: string }>;
  targetLang: TargetLang;
  speechStyle: SpeechStyle;
  partIndex: number;
  totalParts: number;
  totalCues: number;
  projectTitle?: string;
}): string {
  const { sourceCues, targetLang, speechStyle, partIndex, totalParts, totalCues, projectTitle } = params;
  const langLabel =
    targetLang === 'my-MM'
      ? 'Burmese (my / my-MM, natural spoken Myanmar language ending each sentence with ။)'
      : 'English (en / en-US, natural conversational American English ending each sentence with . or ? or !)';
  const styleDesc =
    targetLang === 'my-MM'
      ? speechStyle === 'casual'
        ? 'Casual spoken Burmese dialogue (တယ်/နော်/လား/တာပေါ့ — avoid bookish သည်/၏).'
        : 'Polite spoken Burmese dialogue (ပါတယ်/ပါ/ပါနော်/ပါလား — avoid bookish သည်/၏).'
      : speechStyle === 'casual'
        ? 'Casual natural conversational English.'
        : 'Polite natural conversational English.';

  const startId = sourceCues[0]?.id ?? 1;
  const endId = sourceCues[sourceCues.length - 1]?.id ?? startId;

  return [
    `TASK: Translate these video dubbing dialogue lines into ${langLabel}.`,
    projectTitle ? `Project: ${projectTitle}` : '',
    `Batch: Part ${partIndex} / ${totalParts} (IDs ${startId}–${endId} of ${totalCues} total cues).`,
    `IMPORTANT: ${MANUAL_AI_BATCH_REMINDER}`,
    'STRICT INSTRUCTIONS:',
    `1. Target language: ${langLabel}`,
    `2. Tone & style: ${styleDesc}`,
    '3. Natural, complete, concise spoken style (သဘာဝကျပြီး ပြည့်စုံကျစ်လျစ်သော စကားပြောဟန်): translate into natural spoken dialogue (e.g., ပါတယ်, ဗျာ, နော်, လား, ပေါ့ as appropriate to tone), concise enough to match each segment’s time duration.',
    '4. CRITICAL: Keep translations concise WITHOUT making sentences incomplete, choppy, or overly blunt (ဝါကျမပြည့်စုံတာ၊ တုံးတိဖြစ်နေတာ လုံးဝမဖြစ်စေဘဲ အဓိပ္ပာယ်ပြည့်စုံပြီး နားထောင်ကောင်းသော စကားပြောဝါကျ အပြည့်အစုံ ဖြစ်ရမည်).',
    '5. STRICT 1-to-1 SEGMENT & TIMESTAMP LOCK: DO NOT merge segments, DO NOT split segments, DO NOT add or remove items, and DO NOT modify "startSec" or "endSec" numbers by even 0.01s. Output the EXACT same number of JSON objects in the exact same order.',
    '6. Keep character names, terms, and pronouns consistent across every part in this conversation.',
    '7. Preserve meaning completely without truncating mid-thought.',
    '8. Output ONLY valid JSON — no extra explanation or commentary — matching this exact array schema:',
    '[{"id": 1, "text": "..."}]',
    '9. Include EVERY input "id" from this batch exactly once with translated text in "text".',
    '',
    'SOURCE CUES JSON:',
    JSON.stringify(sourceCues, null, 2),
  ]
    .filter(Boolean)
    .join('\n');
}

function getSurroundContext(
  allCues: MergedDubCue[],
  cueId: number,
  radius = 3,
): { before: Array<{ id: number; speaker: string; text: string }>; after: Array<{ id: number; speaker: string; text: string }> } {
  const idx = allCues.findIndex((c) => c.id === cueId);
  if (idx === -1) {
    return { before: [], after: [] };
  }
  const before = allCues.slice(Math.max(0, idx - radius), idx).map((c) => ({
    id: c.id,
    speaker: c.speaker,
    text: c.text,
  }));
  const after = allCues.slice(idx + 1, Math.min(allCues.length, idx + 1 + radius)).map((c) => ({
    id: c.id,
    speaker: c.speaker,
    text: c.text,
  }));
  return { before, after };
}

export async function extractGlossaryForLang(params: {
  projectId: string;
  cues: MergedDubCue[];
  targetLang: TargetLang;
  modelId: string;
  force: boolean;
  boundedWait?: boolean;
}): Promise<{ glossary: Record<string, string>; modelUsed: string }> {
  const { projectId, cues, targetLang, modelId, force, boundedWait = false } = params;
  if (cues.length === 0) return { glossary: {}, modelUsed: modelId };

  const project = await getProject(projectId);
  if (project?.useManualAiBridge) {
    return {
      glossary: project.dub_glossary?.[targetLang] ?? {},
      modelUsed: 'manual-ai-bridge',
    };
  }

  const sampleText = cues
    .slice(0, 80)
    .map((c) => `${c.speaker}: ${c.text}`)
    .join('\n');
  const hash = hashString(`glossary-v1|${targetLang}|${modelId}|${sampleText}`);
  const cacheKey = `dub_glossary_${targetLang}_${hash}`;

  if (!force) {
    const cached = await readProjectCache(projectId, cacheKey, GlossarySchema);
    if (cached) {
      return {
        glossary: Object.fromEntries(cached.terms.map((item) => [item.source, item.target])),
        modelUsed: modelId,
      };
    }
  }

  const cfg = getConfig();
  const targetDesc =
    targetLang === 'my-MM' ? 'Burmese (my-MM, natural spoken Myanmar)' : 'English (en-US)';

  const prompt = [
    `Analyze the dialogue below and extract recurring proper nouns, character names, titles, locations, and domain terms into a consistent translation glossary for ${targetDesc}.`,
    'Keep the list concise (max 25 key terms). If no special terms exist, return {"terms": []}.',
    'Dialogue:',
    sampleText,
  ].join('\n\n');

  const { result: parsed, model: usedModel } = await withExponentialBackoffRetry(
    () =>
      executeResilientGeminiCall<z.infer<typeof GlossarySchema>>({
        projectId,
        kind: 'dub_glossary',
        label: `Glossary (${targetLang})`,
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
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              terms: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    source: { type: Type.STRING },
                    target: { type: Type.STRING },
                  },
                  required: ['source', 'target'],
                },
              },
            },
            required: ['terms'],
          },
        },
      });
      return GlossarySchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{"terms":[]}')));
    },
  }),
    {
      maxAttempts: 3,
      baseDelayMs: 1000,
      factor: 2,
      label: `Glossary (${targetLang})`,
    },
  );

  return {
    glossary: Object.fromEntries(parsed.terms.map((item) => [item.source, item.target])),
    modelUsed: usedModel,
  };
}

export async function extractDualGlossariesConcurrently(params: {
  projectId: string;
  cues: MergedDubCue[];
  modelId: string;
  force: boolean;
  boundedWait?: boolean;
}): Promise<{
  my: { glossary: Record<string, string>; modelUsed: string };
  en: { glossary: Record<string, string>; modelUsed: string };
}> {
  const [my, en] = await Promise.all([
    extractGlossaryForLang({ ...params, targetLang: 'my-MM' }),
    extractGlossaryForLang({ ...params, targetLang: 'en-US' }),
  ]);
  return { my, en };
}

async function retrySingleIncompleteCue(params: {
  projectId: string;
  cue: MergedDubCue;
  allCues: MergedDubCue[];
  previousAnswer: string;
  failureReason: string;
  targetLang: TargetLang;
  speechStyle: SpeechStyle;
  glossary: Record<string, string>;
  modelId: string;
}): Promise<{ translation: string; review_reason?: string; model_used: string }> {
  const {
    projectId,
    cue,
    allCues,
    previousAnswer,
    failureReason,
    targetLang,
    speechStyle,
    glossary,
    modelId,
  } = params;
  const cfg = getConfig();
  const { before, after } = getSurroundContext(allCues, cue.id, 3);
  const glossaryStr = Object.keys(glossary).length > 0 ? JSON.stringify(glossary) : '{}';
  const rules = buildCompleteTranslationRules(targetLang, speechStyle);

  const hash = hashString(
    `retrans-complete-v1|${targetLang}|${speechStyle}|${modelId}|${cue.id}|${cue.text}|${previousAnswer}`,
  );
  const cacheKey = `dub_retry_complete_${targetLang}_${hash}`;
  const cached = await readProjectCache(projectId, cacheKey, SingleTranslationSchema);

  let nextText = cached?.translation.trim() ?? '';
  let usedModel = modelId;

  if (!nextText) {
    const prompt = [
      `your previous answer was incomplete, translate fully. (${failureReason})`,
      ...rules,
      `Glossary: ${glossaryStr}`,
      before.length > 0 ? `3 context units BEFORE:\n${JSON.stringify(before)}` : '',
      after.length > 0 ? `3 context units AFTER:\n${JSON.stringify(after)}` : '',
      `Line to translate completely:\n${JSON.stringify({ id: cue.id, speaker: cue.speaker, src_lang: cue.src_lang, text: cue.text })}`,
      `Previous incomplete answer:\n${JSON.stringify(previousAnswer)}`,
      'Return ONLY JSON: {"translation": "..."}',
    ]
      .filter(Boolean)
      .join('\n\n');

    const { result: parsed, model } = await executeResilientGeminiCall<
      z.infer<typeof SingleTranslationSchema>
    >({
      projectId,
      kind: 'dub_translate_retry',
      label: `Complete retranslate #${cue.id} (${targetLang})`,
      hash,
      queueName: 'geminiText',
      primaryModel: modelId,
      fallbackModels: cfg.TEXT_FALLBACK_MODELS,
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
            temperature: 0.2,
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
        return SingleTranslationSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
      },
    });
    nextText = parsed.translation.trim();
    usedModel = model;
  }

  const check = validateTranslationCompleteness(cue.text, nextText, targetLang);
  return {
    translation: nextText || previousAnswer,
    review_reason: check.valid ? undefined : check.reason,
    model_used: usedModel,
  };
}

export async function translateDubCuesBatched(params: {
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
    speechStyle,
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
    const importedById = new Map(
      project.dub
        .filter((d) => d.lang === targetLang && d.tgt_text.trim().length > 0)
        .map((d) => [d.id, d]),
    );
    for (const cue of cues) {
      const existing = importedById.get(cue.id);
      result.set(cue.id, {
        translation: existing?.tgt_text?.trim() || cue.text,
        review_reason: existing ? existing.review_reason : 'Pending Manual AI Bridge import',
        model_used: existing?.model_used || 'manual-ai-bridge',
      });
    }
    return { translations: result, modelsUsed: ['manual-ai-bridge'] };
  }

  const cfg = getConfig();
  const batchSize = 15;
  const glossaryStr = Object.keys(glossary).length > 0 ? JSON.stringify(glossary) : '{}';
  const totalBatches = Math.ceil(cues.length / batchSize);
  const rules = buildCompleteTranslationRules(targetLang, speechStyle);

  for (let start = 0; start < cues.length; start += batchSize) {
    const batchIndex = Math.floor(start / batchSize) + 1;
    const batch = cues.slice(start, start + batchSize);
    const firstCtx = getSurroundContext(allCues, batch[0].id, 3);
    const lastCtx = getSurroundContext(allCues, batch[batch.length - 1].id, 3);

    const batchPayload = batch.map((c) => ({
      id: c.id,
      speaker: c.speaker,
      src_lang: c.src_lang,
      text: c.text,
    }));

    const hash = hashString(
      `trans-v2-complete|${targetLang}|style:${speechStyle}|${modelId}|g:${glossaryStr}|before:${JSON.stringify(firstCtx.before)}|after:${JSON.stringify(lastCtx.after)}|${JSON.stringify(batchPayload)}`,
    );
    const cacheKey = `dub_trans_${targetLang}_${hash}`;

    let validated = !force
      ? await readProjectCache(projectId, cacheKey, BatchTranslationSchema)
      : null;
    let batchModelUsed = modelId;

    if (!validated) {
      const prompt = [
        'Translate every line below completely for time-synced video dubbing.',
        'STRICT RULES:',
        ...rules.map((r, i) => `${i + 1}. ${r}`),
        `${rules.length + 1}. Keep consistent terms from Glossary: ${glossaryStr}`,
        `${rules.length + 2}. Return ONLY JSON: {"items": [{"id": number, "translation": string}]} matching every input id cleanly.`,
        firstCtx.before.length > 0
          ? `3 context units BEFORE this batch (for continuity, do NOT include in output):\n${JSON.stringify(firstCtx.before)}`
          : '',
        lastCtx.after.length > 0
          ? `3 context units AFTER this batch (for continuity, do NOT include in output):\n${JSON.stringify(lastCtx.after)}`
          : '',
        `Lines to translate:\n${JSON.stringify(batchPayload)}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const { result: batchRes, model } = await withExponentialBackoffRetry(
        () =>
          executeResilientGeminiCall<z.infer<typeof BatchTranslationSchema>>({
            projectId,
            kind: 'dub_translate_batch',
            label: `Translate ${targetLang} batch ${batchIndex}/${totalBatches}`,
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
                  temperature: 0.2,
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
              return BatchTranslationSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
            },
          }),
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          factor: 2,
          label: `Translate ${targetLang} batch ${batchIndex}/${totalBatches}`,
        },
      );
      validated = batchRes;
      batchModelUsed = model;
    }

    modelsUsed.add(batchModelUsed);
    const byId = new Map<number, string>();
    for (const item of validated.items) {
      byId.set(item.id, item.translation.trim());
    }

    // Validate completeness per line and auto-retry once if incomplete
    for (const cue of batch) {
      const candidate = (byId.get(cue.id) ?? '').trim();
      const check = validateTranslationCompleteness(cue.text, candidate, targetLang);
      if (check.valid) {
        result.set(cue.id, {
          translation: candidate,
          model_used: batchModelUsed,
        });
      } else {
        try {
          const retried = await retrySingleIncompleteCue({
            projectId,
            cue,
            allCues,
            previousAnswer: candidate || cue.text,
            failureReason: check.reason || 'Incomplete translation',
            targetLang,
            speechStyle,
            glossary,
            modelId,
          });
          modelsUsed.add(retried.model_used);
          result.set(cue.id, retried);
        } catch (retryErr) {
          console.warn(`[Dub Translate] Auto-retry failed for cue #${cue.id}:`, retryErr);
          result.set(cue.id, {
            translation: candidate || cue.text,
            review_reason: check.reason,
            model_used: batchModelUsed,
          });
        }
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

export async function translateDualLanguageCuesBatched(params: {
  projectId: string;
  cues: MergedDubCue[];
  allCues: MergedDubCue[];
  myGlossary: Record<string, string>;
  enGlossary: Record<string, string>;
  speechStyle: SpeechStyle;
  modelId: string;
  force: boolean;
  boundedWait?: boolean;
  onMyBatchProgress?: (
    doneCount: number,
    totalCount: number,
    partialMap: Map<number, TranslatedCueItem>,
  ) => Promise<void> | void;
}): Promise<{
  my: { translations: Map<number, TranslatedCueItem>; modelsUsed: string[] };
  en: { translations: Map<number, TranslatedCueItem>; modelsUsed: string[] };
}> {
  const [my, en] = await Promise.all([
    translateDubCuesBatched({
      projectId: params.projectId,
      cues: params.cues,
      allCues: params.allCues,
      targetLang: 'my-MM',
      glossary: params.myGlossary,
      speechStyle: params.speechStyle,
      modelId: params.modelId,
      force: params.force,
      boundedWait: params.boundedWait,
      onBatchProgress: params.onMyBatchProgress,
    }),
    translateDubCuesBatched({
      projectId: params.projectId,
      cues: params.cues,
      allCues: params.allCues,
      targetLang: 'en-US',
      glossary: params.enGlossary,
      speechStyle: params.speechStyle,
      modelId: params.modelId,
      force: params.force,
      boundedWait: params.boundedWait,
    }),
  ]);
  return { my, en };
}

export async function retranslateLineComplete(params: {
  projectId: string;
  cue: MergedDubCue;
  allCues: MergedDubCue[];
  currentTranslation: string;
  targetLang: TargetLang;
  speechStyle: SpeechStyle;
  glossary: Record<string, string>;
  modelId: string;
}): Promise<{ translation: string; review_reason?: string; model_used: string }> {
  const {
    projectId,
    cue,
    allCues,
    currentTranslation,
    targetLang,
    speechStyle,
    glossary,
    modelId,
  } = params;
  const project = await getProject(projectId);
  if (project?.useManualAiBridge) {
    return {
      translation: currentTranslation || cue.text,
      model_used: 'manual-ai-bridge',
    };
  }
  const cfg = getConfig();
  const { before, after } = getSurroundContext(allCues, cue.id, 3);
  const rules = buildCompleteTranslationRules(targetLang, speechStyle);
  const glossaryStr = Object.keys(glossary).length > 0 ? JSON.stringify(glossary) : '{}';
  const hash = hashString(
    `manual-complete-v1|${targetLang}|${speechStyle}|${modelId}|${cue.id}|${cue.text}|${currentTranslation}`,
  );

  const prompt = [
    'Re-translate this line completely and naturally. Do NOT abbreviate, summarize, shorten, or cut off any sentence.',
    ...rules,
    `Glossary: ${glossaryStr}`,
    before.length > 0 ? `3 context units BEFORE:\n${JSON.stringify(before)}` : '',
    after.length > 0 ? `3 context units AFTER:\n${JSON.stringify(after)}` : '',
    `Source line:\n${JSON.stringify({ id: cue.id, speaker: cue.speaker, src_lang: cue.src_lang, text: cue.text })}`,
    currentTranslation.trim() ? `Previous translation to improve upon:\n${JSON.stringify(currentTranslation)}` : '',
    'Return ONLY JSON: {"translation": "..."}',
  ]
    .filter(Boolean)
    .join('\n\n');

  const { result: parsed, model } = await executeResilientGeminiCall<
    z.infer<typeof SingleTranslationSchema>
  >({
    projectId,
    kind: 'dub_retranslate_complete',
    label: `Retranslate complete #${cue.id} (${targetLang})`,
    hash,
    queueName: 'geminiText',
    primaryModel: modelId,
    fallbackModels: cfg.TEXT_FALLBACK_MODELS,
    force: true,
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
          temperature: 0.2,
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
      return SingleTranslationSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
    },
  });

  const text = parsed.translation.trim();
  const check = validateTranslationCompleteness(cue.text, text, targetLang);
  if (check.valid) {
    return { translation: text, model_used: model };
  }
  return retrySingleIncompleteCue({
    projectId,
    cue,
    allCues,
    previousAnswer: text,
    failureReason: check.reason || 'Incomplete translation',
    targetLang,
    speechStyle,
    glossary,
    modelId,
  });
}

function normalizeTerminalPunctuation(text: string, targetLang: TargetLang): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (targetLang === 'my-MM') {
    // Convert accidental trailing ASCII period to Burmese potma ။ while keeping complete phrasing
    if (/[.]$/.test(trimmed)) {
      return trimmed.replace(/\.+$/, '။');
    }
  }
  return trimmed;
}

export async function retranslateLineShorter(params: {
  projectId: string;
  srcText: string;
  currentTranslation: string;
  targetLang: TargetLang;
  speechStyle: SpeechStyle;
  glossary: Record<string, string>;
  modelId: string;
}): Promise<{ translation: string; model_used: string; valid: boolean }> {
  const { projectId, srcText, currentTranslation, targetLang, speechStyle, glossary, modelId } =
    params;

  const project = await getProject(projectId);
  if (project?.useManualAiBridge) {
    const checkManual = validateTranslationCompleteness(srcText, currentTranslation, targetLang);
    return {
      translation: currentTranslation,
      model_used: 'manual-ai-bridge',
      valid: checkManual.valid,
    };
  }

  const hash = hashString(
    `retrans-fit5-v3|${targetLang}|${speechStyle}|${modelId}|${srcText}|${currentTranslation}`,
  );
  const cacheKey = `dub_retrans_fit5_${targetLang}_${hash}`;
  const cached = await readProjectCache(projectId, cacheKey, SingleTranslationSchema);
  if (cached) {
    const cleanCached = normalizeTerminalPunctuation(cached.translation, targetLang);
    const checkCached = validateTranslationCompleteness(srcText, cleanCached, targetLang);
    return {
      translation: cleanCached,
      model_used: modelId,
      valid: checkCached.valid,
    };
  }

  const cfg = getConfig();
  const langName = targetLang === 'my-MM' ? 'natural spoken Burmese (my-MM)' : 'natural spoken English (en-US)';
  const endRule =
    targetLang === 'my-MM'
      ? speechStyle === 'casual'
        ? 'Keep natural spoken particles and a COMPLETE spoken sentence ending (တယ်/နော်/လား/တာပေါ့) ending cleanly with ။.'
        : 'Keep natural spoken particles and a COMPLETE polite spoken sentence ending (ပါတယ်/ပါ/ပါနော်/ပါလား) ending cleanly with ။.'
      : 'Keep all key information and end with a complete grammatical sentence ending in . / ? / !.';

  const prompt = [
    `The dubbing timing slot is tight even after 300ms gap borrow, 1.15x TTS tempo, and 0.85x video slow-down.`,
    `Write a concise yet COMPLETE ${langName} spoken sentence while preserving ALL key facts, names, numbers, negations, and complete meaning.`,
    endRule,
    'NEVER truncate mid-sentence, NEVER leave trailing conjunctions (ပြီး/နဲ့/တော့/ရင်/လို့), and NEVER use bare verb stems.',
    `Original text: ${JSON.stringify(srcText)}`,
    `Current full translation: ${JSON.stringify(currentTranslation)}`,
    Object.keys(glossary).length > 0 ? `Glossary: ${JSON.stringify(glossary)}` : '',
    'Return JSON only: {"translation": "..."}',
  ]
    .filter(Boolean)
    .join('\n');

  const callShortModel = async (promptText: string, jobSuffix: string) =>
    executeResilientGeminiCall<z.infer<typeof SingleTranslationSchema>>({
      projectId,
      kind: 'dub_retranslate',
      label: `Tighter complete retranslation${jobSuffix} (${targetLang})`,
      hash: hashString(`${hash}|${jobSuffix}`),
      queueName: 'geminiText',
      primaryModel: modelId,
      fallbackModels: cfg.TEXT_FALLBACK_MODELS,
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
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          config: {
            temperature: 0.2,
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
        return SingleTranslationSchema.parse(
          JSON.parse(stripJsonFences(response?.text ?? '{}')),
        );
      },
    });

  const first = await callShortModel(prompt, '');
  let bestText = normalizeTerminalPunctuation(first.result.translation, targetLang);
  let bestModel = first.model;
  let check = validateTranslationCompleteness(srcText, bestText, targetLang);

  if (!check.valid) {
    const fixPrompt = [
      `Your shortened translation was incomplete or missing terminal punctuation (${check.reason}).`,
      `Rewrite it as a COMPLETE, natural spoken sentence in ${langName} ending cleanly with ${targetLang === 'my-MM' ? '။' : '.'}.`,
      endRule,
      `Original text: ${JSON.stringify(srcText)}`,
      `Incomplete draft: ${JSON.stringify(bestText)}`,
      'Return JSON only: {"translation": "..."}',
    ].join('\n');

    const second = await callShortModel(fixPrompt, '-fix');
    const cand2 = normalizeTerminalPunctuation(second.result.translation, targetLang);
    const check2 = validateTranslationCompleteness(srcText, cand2, targetLang);
    if (check2.valid) {
      bestText = cand2;
      bestModel = second.model;
      check = check2;
    }
  }

  if (check.valid) {
    await writeProjectCache(projectId, cacheKey, { translation: bestText });
  }

  return {
    translation: bestText,
    model_used: bestModel,
    valid: check.valid,
  };
}

/**
 * Step C: Assigns an Edge or Gemini voice to each speaker strictly matching S2 gender & active TTS engine pools,
 * allocating the most talkative speakers first.
 * Strictly maps male -> male voice, female -> female voice, and ONLY preserves a cross-gender assignment
 * when explicitly marked `voice_overridden: true` from manual UI selection.
 */
export function resolveSpeakerVoicesForEngine(params: {
  engine: TtsEngineType;
  speakers: Record<string, SpeakerInfo>;
  cues: MergedDubCue[];
  targetLang: TargetLang;
  voicePools: VoicePoolsConfig;
}): Record<string, string> {
  const { engine, speakers, cues, targetLang, voicePools } = params;
  const geminiNames = new Set(GEMINI_PREBUILT_VOICES.map((v) => v.name));
  const configuredPool = voicePools[engine]?.[targetLang];

  const fallbackFemale =
    engine === 'edge' ? DEFAULT_EDGE_VOICES[targetLang].female : ['Kore', 'Zephyr', 'Aoede', 'Leda'];
  const fallbackMale =
    engine === 'edge' ? DEFAULT_EDGE_VOICES[targetLang].male : ['Charon', 'Puck', 'Orus', 'Fenrir'];

  const filteredPoolFemale = (configuredPool?.female ?? []).filter((name) => {
    if (engine === 'gemini' && !geminiNames.has(name)) return false;
    const vg = getVoiceGender(name, engine);
    return vg === null || vg === 'female';
  });
  const filteredPoolMale = (configuredPool?.male ?? []).filter((name) => {
    if (engine === 'gemini' && !geminiNames.has(name)) return false;
    const vg = getVoiceGender(name, engine);
    return vg === null || vg === 'male';
  });

  const defaultFemale = filteredPoolFemale.length > 0 ? filteredPoolFemale : fallbackFemale;
  const defaultMale = filteredPoolMale.length > 0 ? filteredPoolMale : fallbackMale;

  const talkMs: Record<string, number> = {};
  for (const c of cues) {
    talkMs[c.speaker] = (talkMs[c.speaker] ?? 0) + Math.max(0, c.end_ms - c.start_ms);
  }

  const speakerIds = Array.from(new Set([...Object.keys(speakers), ...cues.map((c) => c.speaker)]));
  speakerIds.sort((a, b) => (talkMs[b] ?? 0) - (talkMs[a] ?? 0));

  let fIdx = 0;
  let mIdx = 0;
  const assignment: Record<string, string> = {};

  for (const spk of speakerIds) {
    const info = speakers[spk];
    const gender = info?.gender ?? 'unknown';

    if (info?.voice?.engine === engine && info.voice.name) {
      const isKnownForEngine = engine !== 'gemini' || geminiNames.has(info.voice.name);
      if (isKnownForEngine) {
        if (info.voice_overridden) {
          assignment[spk] = info.voice.name;
          continue;
        }
        const voiceGender = getVoiceGender(info.voice.name, engine);
        const matchesGender =
          gender === 'unknown' || voiceGender === null || voiceGender === gender;
        if (matchesGender) {
          assignment[spk] = info.voice.name;
          continue;
        }
      }
    }

    if (gender === 'female') {
      assignment[spk] =
        defaultFemale[fIdx % defaultFemale.length] || defaultVoiceForGender(engine, targetLang, 'female');
      fIdx += 1;
    } else if (gender === 'male') {
      assignment[spk] =
        defaultMale[mIdx % defaultMale.length] || defaultVoiceForGender(engine, targetLang, 'male');
      mIdx += 1;
    } else {
      const combined = [...defaultFemale, ...defaultMale];
      assignment[spk] = combined[(fIdx + mIdx) % combined.length] || defaultVoiceForGender(engine, targetLang, 'female');
      fIdx += 1;
    }
  }

  return assignment;
}

export function resolveGeminiSpeakerVoices(params: {
  speakers: Record<string, SpeakerInfo>;
  cues: MergedDubCue[];
  targetLang: TargetLang;
  voicePools: VoicePoolsConfig;
}): Record<string, string> {
  return resolveSpeakerVoicesForEngine({ ...params, engine: 'gemini' });
}

