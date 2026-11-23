import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { z } from 'zod';
import {
  MANUAL_AI_BATCH_REMINDER,
  ScriptEmotionSchema,
  type ManualAiSourceCue,
  type Project,
  type RecapBeat,
  type RecapSourceMode,
  type ScriptEmotion,
  type TargetLang,
} from '../../shared/projectTypes.ts';
import { hashString, readProjectCache, writeProjectCache } from '../analyze/cache.ts';
import { getConfig } from '../config.ts';
import { buildDubSourceCues, countSyllables } from '../dub/syllables.ts';
import { extractGlossaryForLang } from '../dub/translate.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { executeResilientGeminiCall } from '../gemini/resilientClient.ts';
import { requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProjectPaths } from '../storage/projectStore.ts';
import { withExponentialBackoffRetry } from '../utils/retry.ts';
import { buildSilentBeatWindows, shouldUseSilentVideoRecap } from './silentVideoRecap.ts';
import {
  computeRecapMaxSyllables,
  detectLeadingRecapTransition,
  normalizeRecapText,
  prepareRecapCues,
  retranslateRecapCueShorter,
  translateRecapCuesBatched,
  validateRecapTranslation,
} from './recapTranslator.ts';

function normalizeEmotionTag(raw: unknown): ScriptEmotion {
  const val = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const parsed = ScriptEmotionSchema.safeParse(val);
  return parsed.success ? parsed.data : 'neutral';
}

const VisualRecapBatchSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      scene_note: z.string().optional().default(''),
      narration: z.string(),
      emotion: z.string().optional().default('neutral'),
    }),
  ),
});

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

function formatMsShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export interface RecapAutoDetectResult {
  mode: RecapSourceMode;
  reason: string;
}

/**
 * Auto-detects whether the source video is a Raw Movie scene (needs Gemini visual storytelling)
 * or already contains an existing recap voiceover track (transcribed in S1 speech map).
 */
export function detectRecapSourceMode(project: Project): RecapAutoDetectResult {
  if (project.recap_source_mode) {
    return {
      mode: project.recap_source_mode,
      reason:
        project.recap_source_mode === 'existing_vo'
          ? 'Using selected mode: translate existing voiceover into Burmese recap.'
          : 'Using selected mode: watch video frames & write fresh movie-recap script.',
    };
  }

  const durationMs = Math.max(1, project.video.duration_ms || 1);
  if (project.no_dialogue || !project.video.has_audio || project.speech.length === 0) {
    return {
      mode: 'raw_movie',
      reason: 'No spoken dialogue/voiceover found — Gemini will watch the video frames and write a fresh recap script.',
    };
  }

  const talkMsBySpeaker: Record<string, number> = {};
  let totalSpeechMs = 0;
  for (const s of project.speech) {
    const dur = Math.max(0, s.end_ms - s.start_ms);
    totalSpeechMs += dur;
    talkMsBySpeaker[s.speaker] = (talkMsBySpeaker[s.speaker] ?? 0) + dur;
  }

  const speakerIds = Object.keys(talkMsBySpeaker);
  const topSpeakerMs = Math.max(0, ...Object.values(talkMsBySpeaker));
  const topShare = totalSpeechMs > 0 ? topSpeakerMs / totalSpeechMs : 0;
  const coverage = totalSpeechMs / durationMs;

  if (speakerIds.length === 1 && coverage >= 0.22 && project.speech.length >= 2) {
    return {
      mode: 'existing_vo',
      reason: `Single dominant voiceover detected (${Math.round(coverage * 100)}% coverage) — translating narration beats.`,
    };
  }

  if (speakerIds.length <= 2 && topShare >= 0.78 && coverage >= 0.35 && project.speech.length >= 4) {
    return {
      mode: 'existing_vo',
      reason: `Dominant narrator voice detected (${Math.round(topShare * 100)}% of speech) — translating narration beats.`,
    };
  }

  return {
    mode: 'raw_movie',
    reason: `Multi-character movie scene or sparse dialogue (${speakerIds.length} speaker(s), ${Math.round(coverage * 100)}% speech) — Gemini will watch video frames and narrate the story.`,
  };
}

interface RawBeatWindow {
  id: number;
  start_ms: number;
  end_ms: number;
  slot_ms: number;
  max_syllables: number;
  dialogue_context: string;
}

export interface ManualAiRecapBeatMeta {
  id: number;
  start_ms: number;
  end_ms: number;
  slot_ms: number;
  max_syllables: number;
  src_text: string;
  scene_note: string;
}

/**
 * Bridge window source for raw-movie recap. When transcription was empty/negligible
 * (silent video, music, BGM), the visual pipeline owns a ~20s beat grid — reuse it so
 * Manual AI Bridge cue IDs line up 1-to-1. Otherwise keep the dialogue-aligned windows.
 */
function buildManualAiVisualWindows(project: Project): RawBeatWindow[] {
  if (!shouldUseSilentVideoRecap(project).should) {
    return buildRawMovieBeatWindows(project);
  }
  const silentWindows: RawBeatWindow[] = buildSilentBeatWindows(project).map((w) => ({
    id: w.id,
    start_ms: w.start_ms,
    end_ms: w.end_ms,
    slot_ms: w.slot_ms,
    max_syllables: w.max_syllables,
    dialogue_context: '',
  }));
  return silentWindows;
}

export function buildManualAiRecapSourceCues(params: {
  project: Project;
  sourceMode?: RecapSourceMode;
}): {
  sourceMode: RecapSourceMode;
  cues: ManualAiSourceCue[];
  beatMeta: ManualAiRecapBeatMeta[];
} {
  const { project } = params;
  const resolvedMode: RecapSourceMode = params.sourceMode ?? detectRecapSourceMode(project).mode;
  if (resolvedMode === 'existing_vo') {
    const rawCues = buildDubSourceCues(project.speech);
    const prepared = prepareRecapCues(rawCues, project.video.duration_ms || 0, {
      anchorOpeningToZero: true,
    });
    const cues: ManualAiSourceCue[] = [];
    const beatMeta: ManualAiRecapBeatMeta[] = [];
    for (const cue of prepared) {
      const slotMs = Math.max(200, cue.end_ms - cue.start_ms);
      const maxSyl = computeRecapMaxSyllables(slotMs);
      const speaker = cue.speaker || 'NARRATOR';
      cues.push({
        id: cue.id,
        speaker,
        text: cue.text,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        slot_ms: slotMs,
        max_syllables: maxSyl,
      });
      beatMeta.push({
        id: cue.id,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        slot_ms: slotMs,
        max_syllables: maxSyl,
        src_text: cue.text,
        scene_note: `${speaker} voiceover`,
      });
    }
    return { sourceMode: resolvedMode, cues, beatMeta };
  }

  const windows = buildManualAiVisualWindows(project);
  const cues: ManualAiSourceCue[] = [];
  const beatMeta: ManualAiRecapBeatMeta[] = [];
  for (const w of windows) {
    const text =
      w.dialogue_context ||
      `[Scene ${formatMsShort(w.start_ms)}–${formatMsShort(w.end_ms)} · ${(w.slot_ms / 1000).toFixed(1)}s]`;
    cues.push({
      id: w.id,
      speaker: 'SCENE',
      text,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      slot_ms: w.slot_ms,
      max_syllables: w.max_syllables,
    });
    beatMeta.push({
      id: w.id,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      slot_ms: w.slot_ms,
      max_syllables: w.max_syllables,
      src_text: w.dialogue_context,
      scene_note: w.dialogue_context || `Scene ${formatMsShort(w.start_ms)}–${formatMsShort(w.end_ms)}`,
    });
  }
  return { sourceMode: resolvedMode, cues, beatMeta };
}

export function buildManualAiRecapPrompt(params: {
  projectTitle: string;
  sourceMode: RecapSourceMode;
  targetLang: TargetLang;
  partIndex: number;
  totalParts: number;
  cues: Array<{ id: number; speaker: string; text: string }>;
  totalCues: number;
  videoDurationMs?: number;
}): string {
  const {
    projectTitle,
    sourceMode,
    targetLang,
    partIndex,
    totalParts,
    cues,
    totalCues,
    videoDurationMs = 0,
  } = params;
  const firstId = cues[0]?.id ?? 1;
  const lastId = cues[cues.length - 1]?.id ?? cues.length;
  const langLabel = targetLang === 'my-MM' ? 'Burmese / Myanmar (my-MM)' : 'English (en-US)';
  const modeLabel =
    sourceMode === 'existing_vo'
      ? 'Recap-to-Recap (Translate / adapt existing voiceover beats into cohesive movie-recap narration)'
      : 'Movie Recap (Write cohesive story-telling narration lines for the scene timeline)';

  const styleRules =
    targetLang === 'my-MM'
      ? [
          `- Write all "text" lines in natural, engaging ${langLabel} movie-recap storytelling style ending each line cleanly with "။".`,
          '- Connect consecutive beats smoothly with varied Burmese transitions and natural pronoun continuity — avoid stiff literal word-for-word translation or repetitive hooks.',
          '- Keep each narration concise and punchy so it fits its video window smoothly during TTS playback.',
        ]
      : [
          `- Write all "text" lines in vivid, natural ${langLabel} movie-recap storytelling style.`,
          '- Connect consecutive beats smoothly into a continuous story rather than dry bullet points.',
          '- Keep each narration concise so it fits cleanly inside its video window.',
        ];

  return [
    `TASK: ${modeLabel}`,
    `PROJECT: ${JSON.stringify(projectTitle)}${videoDurationMs > 0 ? ` (${formatMsShort(videoDurationMs)})` : ''}`,
    `TARGET LANGUAGE: ${langLabel}`,
    `BATCH: Part ${partIndex} / ${totalParts} (IDs ${firstId}–${lastId} out of ${totalCues} total cues)`,
    `IMPORTANT: ${MANUAL_AI_BATCH_REMINDER}`,
    '',
    'RULES:',
    ...styleRules,
    '- Natural, complete, concise spoken style (သဘာဝကျပြီး ပြည့်စုံကျစ်လျစ်သော စကားပြောဟန်): write natural spoken narration (e.g., ပါတယ်, ဗျာ, နော်, လား, ပေါ့ as appropriate to tone), concise enough to fit each segment’s time window.',
    '- CRITICAL: Keep narration concise WITHOUT making sentences incomplete, choppy, or overly blunt (ဝါကျမပြည့်စုံတာ၊ တုံးတိဖြစ်နေတာ လုံးဝမဖြစ်စေဘဲ အဓိပ္ပာယ်ပြည့်စုံပြီး နားထောင်ကောင်းသော စကားပြောဝါကျ အပြည့်အစုံ ဖြစ်ရမည်).',
    '- STRICT 1-to-1 SEGMENT & TIMESTAMP LOCK: DO NOT merge segments, DO NOT split segments, DO NOT add or remove items, and DO NOT modify "startSec" or "endSec" numbers by even 0.01s. Output the EXACT same number of JSON objects in the exact same order.',
    '- Preserve every input "id" 1-to-1. Do NOT skip, merge, or renumber IDs.',
    '- Return ONLY a valid JSON array in this exact format (no extra commentary outside the JSON):',
    '[{"id": 1, "text": "..."}]',
    '',
    'SOURCE CUES JSON:',
    JSON.stringify(
      cues.map((c) => ({ id: c.id, speaker: c.speaker, text: c.text })),
      null,
      2,
    ),
  ].join('\n');
}

/**
 * Splits [0, videoDurationMs] into chronological non-overlapping story beats aligned with
 * S3 scene cuts and S1 dialogue timing (00:00 through the end of the video).
 */
export function buildRawMovieBeatWindows(project: Project): RawBeatWindow[] {
  const durationMs = Math.max(500, project.video.duration_ms || 0);
  const cuts = Array.from(
    new Set(
      (project.scene_cuts_ms ?? [])
        .map((c) => Math.round(c))
        .filter((c) => c > 1500 && c < durationMs - 1500),
    ),
  ).sort((a, b) => a - b);

  const windows: Array<{ start_ms: number; end_ms: number }> = [];
  let cursor = 0;

  while (cursor < durationMs) {
    const remaining = durationMs - cursor;
    if (remaining <= 7500) {
      if (remaining < 2400 && windows.length > 0) {
        windows[windows.length - 1].end_ms = durationMs;
      } else {
        windows.push({ start_ms: cursor, end_ms: durationMs });
      }
      break;
    }

    const minEnd = cursor + 3400;
    const targetEnd = cursor + 5500;
    const maxEnd = cursor + 8200;

    // Prefer a natural scene cut inside [minEnd, maxEnd] closest to targetEnd
    let bestCut: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of cuts) {
      if (c >= minEnd && c <= maxEnd && durationMs - c >= 2200) {
        const dist = Math.abs(c - targetEnd);
        if (dist < bestDist) {
          bestDist = dist;
          bestCut = c;
        }
      }
    }

    const nextEnd = bestCut ?? Math.min(durationMs, targetEnd);
    windows.push({ start_ms: cursor, end_ms: nextEnd });
    cursor = nextEnd;
  }

  return windows.map((w, idx) => {
    const slotMs = Math.max(200, w.end_ms - w.start_ms);
    const overlappingLines = project.speech
      .filter((s) => s.end_ms > w.start_ms - 300 && s.start_ms < w.end_ms + 300)
      .map((s) => `[${s.speaker}] ${s.text.trim()}`)
      .filter(Boolean);

    return {
      id: idx + 1,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      slot_ms: slotMs,
      max_syllables: computeRecapMaxSyllables(slotMs),
      dialogue_context: overlappingLines.join(' | ').slice(0, 320),
    };
  });
}

async function extractVisualPartsForBatch(params: {
  videoPath: string;
  tempDir: string;
  batchIndex: number;
  beats: RawBeatWindow[];
}): Promise<Array<{ inlineData: { mimeType: string; data: string } } | { text: string }>> {
  const { videoPath, tempDir, batchIndex, beats } = params;
  const { ffmpeg } = requireFfmpeg();
  await fs.mkdir(tempDir, { recursive: true });

  const batchStartMs = beats[0].start_ms;
  const batchEndMs = beats[beats.length - 1].end_ms;
  const durSec = Math.max(1, (batchEndMs - batchStartMs) / 1000);
  const clipPath = path.join(tempDir, `vis_batch_${batchIndex}.mp4`);

  // Fast muted 480px 2fps MP4 slice so Gemini watches the actual motion cleanly
  const rClip = await spawnCommand(ffmpeg, [
    '-y',
    '-ss',
    (batchStartMs / 1000).toFixed(3),
    '-t',
    durSec.toFixed(3),
    '-i',
    videoPath,
    '-vf',
    'scale=480:-2,fps=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-an',
    clipPath,
  ]);

  if (rClip.code === 0 && (await fileExists(clipPath))) {
    const stat = await fs.stat(clipPath);
    if (stat.size > 0 && stat.size <= 7 * 1024 * 1024) {
      const buf = await fs.readFile(clipPath);
      await fs.unlink(clipPath).catch(() => {});
      return [
        {
          text: `VIDEO CLIP (${formatMsShort(batchStartMs)} to ${formatMsShort(batchEndMs)}, timestamps offset from batch start ${batchStartMs}ms):`,
        },
        {
          inlineData: {
            mimeType: 'video/mp4',
            data: buf.toString('base64'),
          },
        },
      ];
    }
    await fs.unlink(clipPath).catch(() => {});
  }

  // Fallback: extract 1 JPEG keyframe at the midpoint of each beat in the batch
  const frameParts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
  for (const beat of beats) {
    const midSec = ((beat.start_ms + beat.end_ms) / 2 / 1000).toFixed(3);
    const jpgPath = path.join(tempDir, `frame_${beat.id}.jpg`);
    const rJpg = await spawnCommand(ffmpeg, [
      '-y',
      '-ss',
      midSec,
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=480:-2',
      '-q:v',
      '7',
      jpgPath,
    ]);
    if (rJpg.code === 0 && (await fileExists(jpgPath))) {
      const buf = await fs.readFile(jpgPath);
      await fs.unlink(jpgPath).catch(() => {});
      frameParts.push({
        text: `Beat #${beat.id} keyframe at ${formatMsShort(beat.start_ms)}–${formatMsShort(beat.end_ms)}:`,
      });
      frameParts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: buf.toString('base64'),
        },
      });
    }
  }

  return frameParts;
}

function buildVisualRecapSystemInstruction(targetLang: TargetLang): string {
  const emotionDirective =
    'For every beat, analyze the visual action, facial expressions, dialogue stakes, and scene tension to assign a logical "emotion" tag strictly from: neutral, happy, sad, excited, serious, angry, fear.';
  if (targetLang === 'my-MM') {
    return [
      'You are an elite Burmese movie-recap channel narrator (like top viral Burmese film recap storytellers).',
      'Always analyze the entire sequence of beats together and compose ONE continuous, flowing, emotionally gripping Burmese story — NEVER disconnected beat-by-beat bullet points.',
      'Link consecutive beats seamlessly with varied Burmese transitional conjunctions and natural pronoun flow ("သူက" / omitted subject), NEVER repeating the same hook word like "ရုတ်တရက်" back-to-back, while keeping each beat to ONE complete sentence ending with "။" strictly within max_syllables.',
      emotionDirective,
    ].join(' ');
  }
  return [
    'You are an elite, captivating movie-recap narrator.',
    'Analyze the entire sequence of beats together and write ONE continuous, flowing, emotionally charged story with varied transitions and natural pronoun continuity, while strictly obeying max_syllables and one complete sentence per beat.',
    emotionDirective,
  ].join(' ');
}

function buildVisualRecapPromptRules(targetLang: TargetLang): string[] {
  if (targetLang === 'my-MM') {
    return [
      'COHESIVE CONTINUOUS STORY (ANALYZE ALL BEATS TOGETHER): Watch the entire video clip and read ALL beats in the sequence BEFORE writing Beat #1. Craft ONE seamless, flowing Burmese story arc first, then split it across the beat IDs so every beat continues naturally from the previous sentence — NEVER isolated bullet-point descriptions.',
      'VARIED TRANSITIONAL CONJUNCTIONS (NO REPEATED HOOKS): Link consecutive beats naturally using varied Burmese transitional conjunctions such as "အဲ့ဒီနောက်", "ဒါကိုမြင်တော့", "ဒီလိုနဲ့", "ဒါပေမဲ့", "မကြာခင်မှာပဲ", "အဲ့ဒီအချိန်မှာပဲ", "တစ်ဖက်မှာတော့", "ဒါကြောင့်". NEVER repeat the same transition word in back-to-back or nearby sentences. Strictly AVOID overusing "ရုတ်တရက်" (use it at most once in the entire video, or omit it completely). Beat #1 starts at 00:00 with a gripping opening hook, and many beats flow best by continuing directly without forcing a heavy transition prefix.',
      'NATURAL PRONOUN FLOW & SUBJECT CONTINUITY: When the same character continues acting in consecutive beats, use natural Burmese pronouns ("သူက", "သူမက", "သူတို့က") or naturally drop/omit the repeated subject as native Burmese storytellers do. NEVER clumsily repeat the character\'s name or full visual description (e.g., "အင်္ကျီအနီနဲ့ကောင်မလေးက") on every beat.',
      'EMOTION & SUBTEXT (NEVER DRY OR LITERAL): Never write blunt action logs like "သူ ဈေးထဲ ဝင်သွားတယ်။ ပန်းကန်ကို ယူလိုက်တယ်။". Capture character emotions, tension, urgency, and plot stakes while using dialogue context only as plot clues. BANNED verbose dubbing endings: "ခံခဲ့ရပါတယ်ခင်ဗျာ", "စေခဲ့ပါတယ်", "ပါတယ်ခင်ဗျာ", "ပါတယ်ရှင်", and stiff bookish "သည်/၏".',
      'SCENE EMOTION TAG: Analyze the scene mood and vocal delivery required for each beat and assign the most fitting "emotion" from ["neutral", "happy", "sad", "excited", "serious", "angry", "fear"] (use "serious" for tense/dramatic moments, "excited" for fast action/twists, "fear" for suspense/horror, "sad" for heartbreak/loss, "angry" for confrontation, "happy" for warmth/relief, "neutral" for calm exposition).',
      'ONE SENTENCE PER BEAT: Divide the continuous story so EVERY beat outputs EXACTLY ONE complete, vivid, punchy Burmese sentence ending with "။". Never output two sentences or cut off mid-thought.',
      'STRICT TIMING & SYLLABLE BUDGET: Expressive does NOT mean bloated — choose sharp, natural Burmese words so every line strictly respects the beat\'s "max_syllables" budget for its "slot_ms".',
    ];
  }

  return [
    'COHESIVE FLOW: Analyze the entire sequence of beats together while watching the video, and weave visual actions and emotions into ONE continuous, flowing story instead of isolated statements.',
    'VARIED TRANSITIONS & PRONOUNS: Beat #1 starts right at 00:00 with a strong hook. Link consecutive beats with varied storytelling conjunctions (never repeating the same transition word back-to-back) and natural pronoun continuity.',
    'SCENE EMOTION TAG: Analyze each scene\'s emotional tone and assign one fitting "emotion" value from ["neutral", "happy", "sad", "excited", "serious", "angry", "fear"] to every beat.',
    'ONE SENTENCE PER BEAT: Output EXACTLY ONE punchy complete English sentence ending with . or ? or ! for every beat id.',
    'STRICT SYLLABLE BUDGET: Keep each line strictly at or below the beat\'s "max_syllables" so audio-video sync stays locked.',
  ];
}

export async function generateRawMovieRecapBeats(params: {
  project: Project;
  targetLang: TargetLang;
  narratorVoice: string;
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<{ beats: RecapBeat[]; modelsUsed: string[] }> {
  const { project, targetLang, narratorVoice, force, onProgress } = params;
  if (project.useManualAiBridge) {
    const imported = project.recap.filter((b) => b.lang === targetLang);
    if (imported.length > 0) {
      return { beats: imported, modelsUsed: ['manual-ai-bridge'] };
    }
    throw new Error('Manual AI Chat Bridge is enabled — paste and import JSON via the 3-step Bridge panel instead of Gemini API.');
  }
  const cfg = getConfig();
  const paths = getProjectPaths(project.id);
  const proxyPath = project.video.proxy_480p_file
    ? path.join(paths.root, project.video.proxy_480p_file)
    : path.join(paths.workDir, 'proxy_480p.mp4');
  const sourcePath = project.video.filename
    ? path.join(paths.sourceDir, project.video.filename)
    : '';

  const videoPath = (await fileExists(proxyPath))
    ? proxyPath
    : sourcePath && (await fileExists(sourcePath))
      ? sourcePath
      : '';

  if (!videoPath) {
    throw new Error('Video file (proxy_480p.mp4 or source video) is missing on disk. Run S0 Ingest first.');
  }

  const beatWindows = buildRawMovieBeatWindows(project);
  if (beatWindows.length === 0) {
    throw new Error('Could not build timeline beats from video duration.');
  }

  const tempDir = path.join(paths.workDir, 'recap', 'visual_tmp');
  const batchSize = 10;
  const totalBatches = Math.ceil(beatWindows.length / batchSize);
  const modelsUsed = new Set<string>();
  const finalBeats: RecapBeat[] = [];
  const previousStoryBeats: Array<{ id: number; time: string; narration: string }> = [];
  const recentTransitions: string[] = [];

  for (let start = 0; start < beatWindows.length; start += batchSize) {
    const batchIdx = Math.floor(start / batchSize) + 1;
    const batch = beatWindows.slice(start, start + batchSize);
    const upcomingBeats = beatWindows.slice(start + batchSize, start + batchSize + 6).map((b) => ({
      id: b.id,
      time: `${formatMsShort(b.start_ms)}–${formatMsShort(b.end_ms)}`,
      ...(b.dialogue_context ? { dialogue_context: b.dialogue_context } : {}),
    }));
    const prevBeat = previousStoryBeats[previousStoryBeats.length - 1];
    const prevTransition = prevBeat ? detectLeadingRecapTransition(prevBeat.narration) : null;

    if (onProgress) {
      const pct = 10 + Math.round(((batchIdx - 1) / totalBatches) * 75);
      await onProgress(
        pct,
        `Watching video & writing Burmese recap script (batch ${batchIdx}/${totalBatches})...`,
      );
    }

    const visualParts = await extractVisualPartsForBatch({
      videoPath,
      tempDir,
      batchIndex: batchIdx,
      beats: batch,
    });

    const batchPayload = batch.map((b) => ({
      id: b.id,
      time: `${formatMsShort(b.start_ms)}–${formatMsShort(b.end_ms)}`,
      offset_in_clip_ms: `${b.start_ms - batch[0].start_ms}–${b.end_ms - batch[0].start_ms}`,
      slot_ms: b.slot_ms,
      max_syllables: b.max_syllables,
      ...(b.dialogue_context ? { dialogue_context: b.dialogue_context } : {}),
    }));

    const hash = hashString(
      `recap-raw-v4|${targetLang}|${cfg.TEXT_MODEL}|${project.title}|${JSON.stringify(batchPayload)}|prev:${JSON.stringify(previousStoryBeats.slice(-4))}|up:${JSON.stringify(upcomingBeats)}`,
    );
    const cacheKey = `recap_raw_${targetLang}_${hash}`;

    let validated = !force
      ? await readProjectCache(project.id, cacheKey, VisualRecapBatchSchema)
      : null;
    let batchModelUsed = cfg.TEXT_MODEL;

    if (!validated) {
      const rules = buildVisualRecapPromptRules(targetLang);
      const prompt = [
        `Movie Title / Project: ${JSON.stringify(project.title)}`,
        `Total Video Duration: ${formatMsShort(project.video.duration_ms || 0)} (${beatWindows.length} total beats)`,
        'Analyze ALL beats in this sequence together and write ONE continuous, flowing story split cleanly into one complete sentence per beat.',
        'STRICT NARRATION RULES:',
        ...rules.map((r, i) => `${i + 1}. ${r}`),
        `${rules.length + 1}. Return ONLY JSON: {"items": [{"id": number, "scene_note": string, "narration": string, "emotion": "neutral" | "happy" | "sad" | "excited" | "serious" | "angry" | "fear"}]} covering EVERY beat id in the list.`,
        previousStoryBeats.length > 0
          ? `Story so far immediately BEFORE this batch (continue seamlessly using natural pronouns / varied conjunctions, do NOT repeat):\n${JSON.stringify(previousStoryBeats.slice(-4))}${prevTransition ? `\nDo NOT open beat #${batch[0].id} with "${prevTransition}" or "ရုတ်တရက်".` : ''}`
          : 'This is the OPENING of the video starting at 00:00.',
        upcomingBeats.length > 0
          ? `Upcoming beats AFTER this batch (for overall plot flow only, do NOT output these ids yet):\n${JSON.stringify(upcomingBeats)}`
          : '',
        `Beats to narrate (${batch.length} beats):\n${JSON.stringify(batchPayload)}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const { result: parsed, model } = await withExponentialBackoffRetry(
        () =>
          executeResilientGeminiCall<z.infer<typeof VisualRecapBatchSchema>>({
            projectId: project.id,
            kind: 'recap_visual_script',
            label: `Recap script visual batch ${batchIdx}/${totalBatches} (${targetLang})`,
            hash,
            queueName: 'geminiText',
            primaryModel: cfg.TEXT_MODEL,
            fallbackModels: cfg.TEXT_FALLBACK_MODELS,
            maxNetworkWaitAttempts: 1,
            maxQuotaWaitAttempts: 0,
            force,
            onWaiting: (info) => {
              emitProjectEvent(project.id, {
                type: 'stage',
                stage: 'dub',
                message: info.message,
              });
            },
            onResult: async (val) => {
              await writeProjectCache(project.id, cacheKey, val);
            },
            call: async ({ ai, modelId: activeModelId }) => {
              const response = await ai.models.generateContent({
                model: activeModelId,
                contents: [{ role: 'user', parts: [...visualParts, { text: prompt }] }],
                config: {
                  systemInstruction: buildVisualRecapSystemInstruction(targetLang),
                  temperature: 0.45,
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
                            scene_note: { type: Type.STRING },
                            narration: { type: Type.STRING },
                            emotion: {
                              type: Type.STRING,
                              enum: ['neutral', 'happy', 'sad', 'excited', 'serious', 'angry', 'fear'],
                            },
                          },
                          required: ['id', 'scene_note', 'narration', 'emotion'],
                        },
                      },
                    },
                    required: ['items'],
                  },
                },
              });
              return VisualRecapBatchSchema.parse(JSON.parse(stripJsonFences(response?.text ?? '{}')));
            },
          }),
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          factor: 2,
          label: `Recap script visual batch ${batchIdx}/${totalBatches} (${targetLang})`,
        },
      );
      validated = parsed;
      batchModelUsed = model;
    }

    modelsUsed.add(batchModelUsed);
    const byId = new Map(validated.items.map((it) => [it.id, it]));

    for (const beat of batch) {
      const rawItem = byId.get(beat.id);
      let narration = normalizeRecapText(rawItem?.narration ?? '', targetLang);
      const sceneNote = (rawItem?.scene_note ?? '').trim() || beat.dialogue_context || `Scene ${formatMsShort(beat.start_ms)}`;
      let check = validateRecapTranslation(narration, beat.slot_ms, targetLang);
      let usedModel = batchModelUsed;

      const prevNarration = previousStoryBeats[previousStoryBeats.length - 1]?.narration ?? '';
      const prevTrans = prevNarration ? detectLeadingRecapTransition(prevNarration) : null;
      const curTrans = targetLang === 'my-MM' ? detectLeadingRecapTransition(narration) : null;
      const repeatedHook =
        Boolean(curTrans) &&
        (curTrans === prevTrans ||
          (curTrans === 'ရုတ်တရက်' && recentTransitions.slice(-3).includes('ရုတ်တရက်')));

      if ((!check.valid || repeatedHook) && narration) {
        try {
          const tightened = await retranslateRecapCueShorter({
            projectId: project.id,
            srcText: sceneNote,
            currentTranslation: narration,
            slotMs: beat.slot_ms,
            targetLang,
            glossary: {},
            modelId: cfg.TEXT_MODEL,
            prevNarration: prevNarration || undefined,
            avoidOpening: curTrans || prevTrans || undefined,
            rewriteReason:
              !check.valid
                ? check.reason
                : `Repeats opening transition "${curTrans}" — use a different Burmese conjunction or natural pronoun flow`,
          });
          if (tightened.translation) {
            const normShort = normalizeRecapText(tightened.translation, targetLang);
            const check2 = validateRecapTranslation(normShort, beat.slot_ms, targetLang);
            const nextTrans = detectLeadingRecapTransition(normShort);
            const stillRepeats =
              Boolean(nextTrans) &&
              (nextTrans === prevTrans || nextTrans === 'ရုတ်တရက်');
            if (
              (check2.valid && !stillRepeats) ||
              (check.valid && repeatedHook && !stillRepeats && check2.valid) ||
              (!check.valid && (check2.valid || check2.syllables < check.syllables))
            ) {
              narration = normShort;
              check = check2;
              usedModel = tightened.model_used || usedModel;
              modelsUsed.add(usedModel);
            }
          }
        } catch (err) {
          console.warn(`[Recap Visual] Auto-tighten/cohesion rewrite failed for beat #${beat.id}:`, err);
        }
      }

      if (!narration) {
        narration = targetLang === 'my-MM' ? 'ဇာတ်လမ်းဆက်လက်ဖြစ်ပွားနေတယ်။' : 'The story continues cleanly.';
        check = validateRecapTranslation(narration, beat.slot_ms, targetLang);
      }

      previousStoryBeats.push({
        id: beat.id,
        time: `${formatMsShort(beat.start_ms)}–${formatMsShort(beat.end_ms)}`,
        narration,
      });
      const finalTrans = detectLeadingRecapTransition(narration);
      if (finalTrans) {
        recentTransitions.push(finalTrans);
      }

      finalBeats.push({
        id: beat.id,
        lang: targetLang,
        start_ms: beat.start_ms,
        end_ms: beat.end_ms,
        src_text: beat.dialogue_context,
        scene_note: sceneNote,
        narration_text: narration,
        slot_ms: beat.slot_ms,
        max_syllables: beat.max_syllables,
        syllables: countSyllables(narration, targetLang),
        tts_ms: 0,
        tts_file: '',
        rate: 1.2,
        video_rate: 1.0,
        status: check.valid ? 'ok' : 'needs_review',
        review_reason: check.valid ? undefined : check.reason,
        emotion: normalizeEmotionTag(rawItem?.emotion),
        voice_name: narratorVoice,
        tts_engine: cfg.TTS_ENGINE,
        model_used: usedModel,
      });
    }
  }

  return {
    beats: finalBeats,
    modelsUsed: Array.from(modelsUsed),
  };
}

export async function generateExistingVoRecapBeats(params: {
  project: Project;
  targetLang: TargetLang;
  narratorVoice: string;
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<{ beats: RecapBeat[]; modelsUsed: string[] }> {
  const { project, targetLang, narratorVoice, force, onProgress } = params;
  if (project.useManualAiBridge) {
    const imported = project.recap.filter((b) => b.lang === targetLang);
    if (imported.length > 0) {
      return { beats: imported, modelsUsed: ['manual-ai-bridge'] };
    }
    throw new Error('Manual AI Chat Bridge is enabled — paste and import JSON via the 3-step Bridge panel instead of Gemini API.');
  }
  const cfg = getConfig();
  const rawCues = buildDubSourceCues(project.speech);
  const cues = prepareRecapCues(rawCues, project.video.duration_ms || 0, {
    anchorOpeningToZero: true,
  });

  if (cues.length === 0) {
    throw new Error(
      'No voiceover lines found in S1 Speech Map. Switch to Option A (Watch Video & Write Fresh Script) instead.',
    );
  }

  if (onProgress) {
    await onProgress(15, `Extracting terms & translating ${cues.length} voiceover beats...`);
  }

  const modelsUsed = new Set<string>();
  const glossaryRes = await extractGlossaryForLang({
    projectId: project.id,
    cues,
    targetLang,
    modelId: cfg.TEXT_MODEL,
    force,
  });
  if (glossaryRes.modelUsed) modelsUsed.add(glossaryRes.modelUsed);

  const transRes = await translateRecapCuesBatched({
    projectId: project.id,
    cues,
    allCues: cues,
    targetLang,
    glossary: glossaryRes.glossary,
    speechStyle: cfg.SPEECH_STYLE,
    modelId: cfg.TEXT_MODEL,
    force,
    onBatchProgress: async (done, total) => {
      if (onProgress) {
        const pct = 20 + Math.round((done / Math.max(1, total)) * 70);
        await onProgress(pct, `Translating recap voiceover (${done}/${total} beats)...`);
      }
    },
  });
  for (const m of transRes.modelsUsed) modelsUsed.add(m);

  const beats: RecapBeat[] = cues.map((cue) => {
    const slotMs = Math.max(200, cue.end_ms - cue.start_ms);
    const maxSyl = computeRecapMaxSyllables(slotMs);
    const translated = transRes.translations.get(cue.id);
    const narration = (translated?.translation || cue.text).trim();
    const check = validateRecapTranslation(narration, slotMs, targetLang);

    return {
      id: cue.id,
      lang: targetLang,
      start_ms: cue.start_ms,
      end_ms: cue.end_ms,
      src_text: cue.text,
      scene_note: `${cue.speaker} voiceover`,
      narration_text: narration,
      slot_ms: slotMs,
      max_syllables: maxSyl,
      syllables: countSyllables(narration, targetLang),
      tts_ms: 0,
      tts_file: '',
      rate: 1.2,
      video_rate: 1.0,
      status: check.valid ? 'ok' : 'needs_review',
      review_reason: translated?.review_reason ?? (check.valid ? undefined : check.reason),
      voice_name: narratorVoice,
      tts_engine: cfg.TTS_ENGINE,
      model_used: translated?.model_used || cfg.TEXT_MODEL,
    };
  });

  return {
    beats,
    modelsUsed: Array.from(modelsUsed),
  };
}

/**
 * Dual-Language (my-MM Audio + en-US Subtitles) Option A generator:
 * Watches video frames ONCE to author cohesive Burmese narration beats, then
 * concurrently translates those Burmese beats into matching en-US subtitle beats
 * sharing exact timestamps (without duplicate video frame slicing).
 */
export async function generateDualRawMovieRecapBeats(params: {
  project: Project;
  myNarratorVoice: string;
  enNarratorVoice: string;
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<{ myBeats: RecapBeat[]; enBeats: RecapBeat[]; modelsUsed: string[] }> {
  const { project, myNarratorVoice, enNarratorVoice, force, onProgress } = params;
  const cfg = getConfig();
  const modelsUsed = new Set<string>();

  const myRes = await generateRawMovieRecapBeats({
    project,
    targetLang: 'my-MM',
    narratorVoice: myNarratorVoice,
    force,
    onProgress: async (pct, msg) => {
      if (onProgress) {
        await onProgress(Math.min(72, pct), `[my-MM] ${msg}`);
      }
    },
  });
  for (const m of myRes.modelsUsed) modelsUsed.add(m);

  if (onProgress) {
    await onProgress(76, `[en-US] Translating ${myRes.beats.length} recap beats for synchronized English SRT...`);
  }

  const pseudoCues = myRes.beats.map((b) => ({
    id: b.id,
    start_ms: b.start_ms,
    end_ms: b.end_ms,
    speaker: 'NARRATOR',
    src_lang: 'my',
    text: b.narration_text,
    merged_ids: [b.id],
  }));

  const enRes = await translateRecapCuesBatched({
    projectId: project.id,
    cues: pseudoCues,
    allCues: pseudoCues,
    targetLang: 'en-US',
    glossary: project.dub_glossary?.['en-US'] ?? {},
    speechStyle: cfg.SPEECH_STYLE,
    modelId: cfg.TEXT_MODEL,
    force,
  });
  for (const m of enRes.modelsUsed) modelsUsed.add(m);

  const enBeats: RecapBeat[] = myRes.beats.map((myBeat) => {
    const enItem = enRes.translations.get(myBeat.id);
    const enText = (enItem?.translation || myBeat.scene_note || myBeat.narration_text).trim();
    const chk = validateRecapTranslation(enText, myBeat.slot_ms, 'en-US');
    return {
      ...myBeat,
      lang: 'en-US',
      narration_text: enText,
      syllables: countSyllables(enText, 'en-US'),
      tts_ms: 0,
      tts_file: '',
      status: chk.valid ? 'ok' : 'needs_review',
      review_reason: enItem?.review_reason ?? (chk.valid ? undefined : chk.reason),
      voice_name: enNarratorVoice,
      model_used: enItem?.model_used || cfg.TEXT_MODEL,
    };
  });

  return {
    myBeats: myRes.beats,
    enBeats,
    modelsUsed: Array.from(modelsUsed),
  };
}
