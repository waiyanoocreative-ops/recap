import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ScriptEmotionSchema,
  type Project,
  type RecapBeat,
  type ScriptEmotion,
  type TargetLang,
} from '../../shared/projectTypes.ts';
import { hashString, readProjectCache, writeProjectCache } from '../analyze/cache.ts';
import { getConfig, getGroqApiKey } from '../config.ts';
import { countSyllables } from '../dub/syllables.ts';
import { requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProjectPaths } from '../storage/projectStore.ts';
import { computeRecapMaxSyllables } from './recapTranslator.ts';

/**
 * Silent / no-voiceover Pro Recap: FFmpeg scene keyframes -> Groq Vision scene reader
 * -> Groq storyteller that authors a continuous cinematic recap script.
 *
 * Used for videos with no usable speech (music videos, BGM/singing, raw action reels)
 * where Whisper returns empty or negligible transcription.
 */

export const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
export const GROQ_RECAP_TEXT_MODEL = 'openai/gpt-oss-120b';
export const GROQ_RECAP_TEXT_FALLBACK_MODEL = 'llama-3.3-70b-versatile';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Frame harvesting runs in 10-minute windows so long videos batch cleanly. */
const WINDOW_SEC = 600;
/** Hard payload/rate guard: never send more than this many frames per window. */
const MAX_FRAMES_PER_WINDOW = 30;
/** Preferred keyframe spacing inside a window (widened automatically for long videos). */
const MIN_FRAME_INTERVAL_SEC = 5;
const SCENE_THRESHOLD = 0.28;
const FRAMES_PER_VISION_CALL = 6;
const BEATS_PER_STORY_CALL = 8;
const TARGET_BEAT_SEC = 20;

const SHOWINFO_TIME_RE =
  /Parsed_showinfo[^\]]*\]\s*n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:([-\d.eE+]+)/;

const VisionFrameNoteSchema = z.object({
  time: z.string().optional().default(''),
  setting: z.string().optional().default(''),
  characters: z.string().optional().default(''),
  action: z.string().optional().default(''),
  plot: z.string().optional().default(''),
  description: z.string().optional().default(''),
});

const VisionBatchSchema = z.object({
  frames: z.array(VisionFrameNoteSchema).optional(),
  scenes: z.array(VisionFrameNoteSchema).optional(),
});

const StoryBatchSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      narration: z.string(),
      emotion: z.string().optional().default('neutral'),
    }),
  ),
});

export interface SilentBeatWindow {
  id: number;
  start_ms: number;
  end_ms: number;
  slot_ms: number;
  max_syllables: number;
}

interface Keyframe {
  path: string;
  timestampSec: number;
}

interface SceneNote {
  timestampSec: number;
  beatId: number;
  note: string;
}

export interface SilentVideoRecapResult {
  beats: RecapBeat[];
  modelsUsed: string[];
  frameCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMsShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

/** Tolerant parse: grabs the first balanced {...} block when the model wraps JSON in prose. */
function extractFirstJsonObject(raw: string): string {
  const cleaned = stripJsonFences(raw);
  const start = cleaned.indexOf('{');
  if (start < 0) return cleaned;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

function normalizeEmotionTag(raw: unknown): ScriptEmotion {
  const val = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const parsed = ScriptEmotionSchema.safeParse(val);
  return parsed.success ? parsed.data : 'neutral';
}

/**
 * Auto-fallback detector: true when transcription produced empty or negligible speech,
 * so keyframe + Groq Vision narration is a better source than the speech map.
 */
export function shouldUseSilentVideoRecap(project: Project): { should: boolean; reason: string } {
  const durationMs = Math.max(1, project.video.duration_ms || 0);
  const speech = project.speech ?? [];
  const usable = speech.filter((s) => s.text.trim().length > 0 && s.end_ms > s.start_ms);
  if (usable.length === 0) {
    return { should: true, reason: 'Whisper transcription returned no usable speech.' };
  }
  const speechMs = usable.reduce((acc, s) => acc + (s.end_ms - s.start_ms), 0);
  const coverage = speechMs / durationMs;
  if (usable.length < 3 || coverage < 0.1) {
    return {
      should: true,
      reason: `Speech too sparse for translation (${usable.length} segments, ${(coverage * 100).toFixed(1)}% coverage) — switching to visual keyframe script.`,
    };
  }
  return { should: false, reason: '' };
}

/**
 * Splits [0, duration] into chronological non-overlapping narration beats
 * (default ~20 s each) that keyframe notes are later mapped onto.
 */
export function buildSilentBeatWindows(project: Project): SilentBeatWindow[] {
  const durationMs = Math.max(1000, project.video.duration_ms || 0);
  const targetBeatMs = TARGET_BEAT_SEC * 1000;
  const windows: SilentBeatWindow[] = [];
  let cursor = 0;
  let id = 1;

  while (cursor < durationMs) {
    const endMs = Math.min(durationMs, cursor + targetBeatMs);
    const isLast = endMs >= durationMs;
    // Merge a tiny trailing window into the previous beat instead of a 1-2s orphan.
    if (!isLast && durationMs - endMs < 3000) {
      const slotMs = Math.max(200, durationMs - cursor);
      windows.push({
        id,
        start_ms: cursor,
        end_ms: durationMs,
        slot_ms: slotMs,
        max_syllables: computeRecapMaxSyllables(slotMs),
      });
      break;
    }
    const slotMs = Math.max(200, endMs - cursor);
    windows.push({
      id,
      start_ms: cursor,
      end_ms: endMs,
      slot_ms: slotMs,
      max_syllables: computeRecapMaxSyllables(slotMs),
    });
    id += 1;
    cursor = endMs;
  }

  return windows;
}

function splitIntoTimeWindows(durationSec: number): Array<{ startSec: number; endSec: number }> {
  const out: Array<{ startSec: number; endSec: number }> = [];
  let cursor = 0;
  while (cursor < durationSec) {
    const endSec = Math.min(durationSec, cursor + WINDOW_SEC);
    out.push({ startSec: cursor, endSec });
    cursor = endSec;
  }
  return out;
}

/**
 * Extracts scene-change keyframes (hybrid: scene detector + min-interval sampling,
 * 1 frame per 4-6 s, capped per 10-minute window) downscaled to 640px JPEGs,
 * preserving exact timestamps from FFmpeg showinfo metadata.
 */
async function extractSilentKeyframes(params: {
  videoPath: string;
  framesDir: string;
  durationSec: number;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<Keyframe[]> {
  const { videoPath, framesDir, durationSec, onProgress } = params;
  const { ffmpeg } = requireFfmpeg();
  // Start clean so stale JPEGs from an earlier run can never be picked up.
  await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(framesDir, { recursive: true });

  const timeWindows = splitIntoTimeWindows(durationSec);
  const keyframes: Keyframe[] = [];

  for (let wIdx = 0; wIdx < timeWindows.length; wIdx += 1) {
    const { startSec, endSec } = timeWindows[wIdx];
    const winDurSec = endSec - startSec;
    if (onProgress) {
      await onProgress(
        Math.round(6 + (wIdx / timeWindows.length) * 14),
        `Extracting scene keyframes (window ${wIdx + 1}/${timeWindows.length})...`,
      );
    }

    // Hard cap per window: widen the min interval so long videos stay under the cap.
    const maxByInterval = Math.max(4, Math.ceil(winDurSec / MIN_FRAME_INTERVAL_SEC));
    const cap = Math.min(MAX_FRAMES_PER_WINDOW, maxByInterval);
    const intervalSec = winDurSec / cap;

    const outPrefix = path.join(framesDir, `w${wIdx}_frame`);
    const r = await spawnCommand(
      ffmpeg,
      [
        '-y',
        '-ss',
        startSec.toFixed(3),
        '-t',
        winDurSec.toFixed(3),
        '-i',
        videoPath,
        '-vf',
        [
          // Hybrid: first frame OR scene-cut (>=1 s apart) OR fallback interval elapsed.
          `select='eq(n\\,0)+(gt(scene\\,${SCENE_THRESHOLD})*gte(t-prev_selected_t\\,1.00)+gte(t-prev_selected_t\\,${intervalSec.toFixed(2)}))'`,
          'showinfo',
          'scale=640:-2',
        ].join(','),
        '-fps_mode',
        'vfr',
        '-frames:v',
        String(cap),
        '-q:v',
        '5',
        `${outPrefix}_%04d.jpg`,
      ],
      { timeoutMs: 5 * 60_000 },
    );

    if (r.code !== 0) {
      console.warn(
        `[SilentRecap] keyframe extraction failed for window ${wIdx + 1}: ${r.stderr.slice(-300)}`,
      );
      continue;
    }

    // Pair output JPEGs with timestamps parsed from showinfo stderr lines.
    const times: number[] = [];
    for (const line of r.stderr.split(/\r?\n/)) {
      const m = SHOWINFO_TIME_RE.exec(line);
      if (m) {
        times.push(startSec + Number(m[3]));
      }
    }
    times.sort((a, b) => a - b);

    const files = (await fs.readdir(framesDir))
      .filter((f) => f.startsWith(path.basename(outPrefix)) && f.endsWith('.jpg'))
      .sort();

    for (let i = 0; i < files.length; i += 1) {
      const ts = i < times.length ? times[i] : startSec + i * intervalSec;
      keyframes.push({ path: path.join(framesDir, files[i]), timestampSec: ts });
    }
  }

  keyframes.sort((a, b) => a.timestampSec - b.timestampSec);
  return keyframes;
}

async function callGroqJson(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** OpenAI-style multimodal parts (text + image_url) appended after the user text. */
  imageParts?: Array<{ type: 'image_url'; image_url: { url: string } }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Vision models may not support response_format=json_object — fall back to fence stripping. */
  useJsonMode?: boolean;
}): Promise<{ content: string; model: string }> {
  const {
    apiKey,
    model,
    system,
    user,
    imageParts = [],
    temperature = 0.4,
    maxTokens = 4096,
    timeoutMs = 120_000,
    useJsonMode = true,
  } = params;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [{ type: 'text', text: user }, ...imageParts],
          },
        ],
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`Groq HTTP ${res.status} on ${model}: ${rawText.slice(0, 300)}`);
    }
    const payload = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) {
      throw new Error(`Groq model ${model} returned empty content`);
    }
    return { content, model };
  } finally {
    clearTimeout(timer);
  }
}

/** Stage 1: describe each timestamped keyframe objectively via Groq Vision. */
async function readScenesWithGroqVision(params: {
  projectId: string;
  keyframes: Keyframe[];
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<{ notes: SceneNote[]; modelsUsed: Set<string> }> {
  const { projectId, keyframes, force, onProgress } = params;
  const groqKey = getGroqApiKey();
  if (!groqKey) {
    throw new Error(
      'GROQ_API_KEY is not configured. Add it in Settings or .env.local to use Visual AI Script.',
    );
  }

  const notes: SceneNote[] = [];
  const modelsUsed = new Set<string>();
  const totalBatches = Math.max(1, Math.ceil(keyframes.length / FRAMES_PER_VISION_CALL));

  for (let start = 0; start < keyframes.length; start += FRAMES_PER_VISION_CALL) {
    const batchIdx = Math.floor(start / FRAMES_PER_VISION_CALL) + 1;
    const batch = keyframes.slice(start, start + FRAMES_PER_VISION_CALL);

    if (onProgress) {
      const pct = 22 + Math.round(((batchIdx - 1) / totalBatches) * 38);
      await onProgress(
        pct,
        `Reading scenes with Groq Vision (batch ${batchIdx}/${totalBatches})...`,
      );
    }

    const cacheHash = hashString(
      JSON.stringify({
        v: 'silent-vision-v1',
        model: GROQ_VISION_MODEL,
        frames: batch.map((f) => `${f.timestampSec.toFixed(3)}:${path.basename(f.path)}`),
      }),
    );
    const cacheKey = `silent_vision_b${String(batchIdx).padStart(3, '0')}_${cacheHash}`;

    if (!force) {
      const cached = await readProjectCache(projectId, cacheKey, VisionBatchSchema);
      if (cached) {
        applyVisionNotes(cached, batch, notes);
        continue;
      }
    }

    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    for (const f of batch) {
      const buf = await fs.readFile(f.path).catch(() => null);
      if (!buf) continue;
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` },
      });
    }
    if (imageParts.length === 0) {
      throw new Error('No readable keyframes were produced for Groq Vision.');
    }

    const userPrompt = [
      `These are ${batch.length} keyframes from a video with NO narration, in chronological order.`,
      'For EACH frame, output one entry describing what is concretely visible:',
      '- time: the [MM:SS] timestamp given below the image, verbatim.',
      '- setting: location / time of day / environment.',
      '- characters: who appears (appearance, clothing, expressions, interactions).',
      '- action: concrete visual actions and movements.',
      '- plot: what story beat this suggests (objective, no speculation beyond the frame).',
      'Be objective and specific. Return ONLY JSON:',
      '{"frames": [{"time": "[MM:SS]", "setting": "...", "characters": "...", "action": "...", "plot": "..."}]}',
      `Frame count must equal ${batch.length}, in the same order as given.`,
    ].join('\n');

    const batchMeta = batch
      .map((f, i) => `Frame ${i + 1}: [${formatMsShort(f.timestampSec * 1000)}]`)
      .join('\n');

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { content, model } = await callGroqJson({
          apiKey: groqKey,
          model: GROQ_VISION_MODEL,
          system:
            'You are a precise visual scene analyst. Describe only what is objectively visible in frames. Always respond with valid JSON only.',
          user: `${userPrompt}\n\nFrame timestamps:\n${batchMeta}`,
          imageParts,
          temperature: 0.2,
          maxTokens: 2048,
          useJsonMode: false,
        });
        const parsed = VisionBatchSchema.safeParse(
          extractFirstJsonObject(stripJsonFences(content)),
        );
        if (!parsed.success) {
          throw new Error(
            `Groq Vision returned malformed JSON: ${parsed.error.message.slice(0, 200)}`,
          );
        }
        modelsUsed.add(model);
        await writeProjectCache(projectId, cacheKey, parsed.data);
        applyVisionNotes(parsed.data, batch, notes);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) throw err;
        if (attempt < 2) await sleep(1200);
      }
    }

    if (lastErr) {
      throw lastErr;
    }
  }

  notes.sort((a, b) => a.timestampSec - b.timestampSec || a.beatId - b.beatId);
  return { notes, modelsUsed };
}

function applyVisionNotes(
  data: z.infer<typeof VisionBatchSchema>,
  batch: Keyframe[],
  out: SceneNote[],
) {
  const entries = data.frames ?? data.scenes ?? [];
  // Vision may return fewer entries than frames — pad so every frame keeps its note.
  const count = Math.max(entries.length, batch.length);
  for (let i = 0; i < count; i += 1) {
    const frame = batch[i];
    if (!frame) break;
    const ts = frame.timestampSec;
    const entry = entries[i];
    const parts = entry
      ? [
          entry.setting && `Setting: ${entry.setting}`,
          entry.characters && `Characters: ${entry.characters}`,
          entry.action && `Action: ${entry.action}`,
          entry.plot && `Plot: ${entry.plot}`,
          entry.description && `Description: ${entry.description}`,
        ].filter(Boolean)
      : [];
    out.push({
      timestampSec: ts,
      beatId: 0,
      note:
        parts.length > 0
          ? parts.join(' | ')
          : `Visual scene at [${formatMsShort(ts * 1000)}]`,
    });
  }
}

/** Stage 2: author the continuous recap script from chronological scene notes via Groq LLM. */
async function writeRecapWithGroqStoryteller(params: {
  projectId: string;
  project: Project;
  windows: SilentBeatWindow[];
  notes: SceneNote[];
  targetLang: TargetLang;
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<{
  narrations: Map<number, string>;
  emotions: Map<number, ScriptEmotion>;
  modelsUsed: Set<string>;
}> {
  const { projectId, project, windows, notes, targetLang, force, onProgress } = params;
  const groqKey = getGroqApiKey();
  if (!groqKey) {
    throw new Error(
      'GROQ_API_KEY is not configured. Add it in Settings or .env.local to use Visual AI Script.',
    );
  }
  const cfg = getConfig();
  const primaryModel = cfg.GROQ_TEXT_MODEL || GROQ_RECAP_TEXT_MODEL;
  const fallbackModels =
    cfg.GROQ_TEXT_FALLBACK_MODELS.length > 0
      ? cfg.GROQ_TEXT_FALLBACK_MODELS
      : [GROQ_RECAP_TEXT_FALLBACK_MODEL];
  const modelChain = Array.from(new Set([primaryModel, ...fallbackModels].filter(Boolean)));

  const notesByBeat = new Map<number, string[]>();
  for (const note of notes) {
    if (note.beatId <= 0) continue;
    const list = notesByBeat.get(note.beatId) ?? [];
    list.push(`[${formatMsShort(note.timestampSec * 1000)}] ${note.note}`);
    notesByBeat.set(note.beatId, list);
  }

  const langLabel = targetLang === 'my-MM' ? 'Burmese / Myanmar (my-MM)' : 'English (en-US)';
  const systemPrompt = [
    'You are an elite, captivating movie-recap narrator writing for a video that has NO dialogue or voiceover.',
    'Using ONLY the timestamped visual scene notes, craft ONE continuous, flowing, emotionally gripping cinematic story — never bullet points, never meta-commentary ("this video shows", "in this scene we see").',
    targetLang === 'my-MM'
      ? 'Write in natural, engaging Burmese movie-recap storytelling style; every line is ONE complete punchy sentence ending with "။".'
      : 'Write in vivid, natural English movie-recap storytelling style; every line is ONE complete punchy sentence ending with . ? or !.',
    'Open with a strong hook, keep smooth varied transitions between beats, dramatic pacing, and natural pronoun continuity.',
    'Return ONLY valid JSON.',
  ].join(' ');

  const narrations = new Map<number, string>();
  const emotions = new Map<number, ScriptEmotion>();
  const modelsUsed = new Set<string>();
  const totalBatches = Math.max(1, Math.ceil(windows.length / BEATS_PER_STORY_CALL));
  const previousStory: Array<{ id: number; narration: string }> = [];

  for (let start = 0; start < windows.length; start += BEATS_PER_STORY_CALL) {
    const batchIdx = Math.floor(start / BEATS_PER_STORY_CALL) + 1;
    const batch = windows.slice(start, start + BEATS_PER_STORY_CALL);
    if (onProgress) {
      const pct = 62 + Math.round(((batchIdx - 1) / totalBatches) * 30);
      await onProgress(pct, `Writing Pro Recap script (batch ${batchIdx}/${totalBatches})...`);
    }

    const batchPayload = batch.map((w) => ({
      id: w.id,
      time: `${formatMsShort(w.start_ms)}-${formatMsShort(w.end_ms)}`,
      startSec: Math.round(w.start_ms / 1000),
      endSec: Math.round(w.end_ms / 1000),
      max_syllables: w.max_syllables,
      scene_notes: notesByBeat.get(w.id) ?? [
        '[No distinct visual event — bridge the story smoothly]',
      ],
    }));

    const cacheHash = hashString(
      JSON.stringify({
        v: 'silent-story-v1',
        modelChain,
        lang: targetLang,
        title: project.title,
        batch: batchPayload,
        prev: previousStory.slice(-3),
      }),
    );
    const cacheKey = `silent_story_b${String(batchIdx).padStart(3, '0')}_${cacheHash}`;

    if (!force) {
      const cached = await readProjectCache(projectId, cacheKey, StoryBatchSchema);
      if (cached) {
        applyStoryItems(cached, batch, targetLang, narrations, emotions);
        for (const w of batch) {
          const text = narrations.get(w.id);
          if (text) previousStory.push({ id: w.id, narration: text });
        }
        continue;
      }
    }

    const userPrompt = [
      `Movie / Project: ${JSON.stringify(project.title)}`,
      `Total Video Duration: ${formatMsShort(project.video.duration_ms || 0)} (${windows.length} total beats)`,
      `TARGET LANGUAGE: ${langLabel}`,
      `Batch ${batchIdx}/${totalBatches}: narrate EVERY beat id below.`,
      '',
      'RULES:',
      '1. ONE continuous gripping story across all beats — each beat outputs EXACTLY ONE complete sentence.',
      '2. Each beat has an exact timestamp window (startSec-endSec). Do NOT skip, merge, or renumber IDs.',
      targetLang === 'my-MM'
        ? '3. Every line: ONE Burmese sentence ending with "။", strictly within the beat\'s max_syllables budget.'
        : "3. Every line: ONE English sentence ending with . ? or !, at or below the beat's max_syllables budget.",
      '4. No meta-commentary, no scene-number references, no headings.',
      previousStory.length > 0
        ? `Story so far immediately BEFORE this batch (continue seamlessly, do NOT repeat):\n${JSON.stringify(previousStory.slice(-3))}`
        : 'This is the OPENING of the video — start with a gripping hook at 00:00.',
      '',
      `Beats with visual scene notes:\n${JSON.stringify(batchPayload, null, 2)}`,
      '',
      'Return ONLY JSON: {"items": [{"id": number, "narration": "text", "emotion": "neutral" | "happy" | "sad" | "excited" | "serious" | "angry" | "fear"}]}',
    ].join('\n');

    let done = false;
    let lastErr: unknown = null;

    for (const model of modelChain) {
      const maxTries = model === modelChain[0] ? 2 : 1;
      for (let attempt = 1; attempt <= maxTries && !done; attempt += 1) {
        try {
          const { content, model: usedModel } = await callGroqJson({
            apiKey: groqKey,
            model,
            system: systemPrompt,
            user: userPrompt,
            temperature: 0.65,
            maxTokens: 4096,
          });
          const parsed = StoryBatchSchema.safeParse(
            JSON.parse(stripJsonFences(content)),
          );
          if (!parsed.success || parsed.data.items.length === 0) {
            throw new Error(
              `Groq storyteller returned malformed JSON: ${
                parsed.success ? '0 items' : parsed.error.message.slice(0, 200)
              }`,
            );
          }
          modelsUsed.add(usedModel);
          await writeProjectCache(projectId, cacheKey, parsed.data);
          applyStoryItems(parsed.data, batch, targetLang, narrations, emotions);
          for (const w of batch) {
            const text = narrations.get(w.id);
            if (text) previousStory.push({ id: w.id, narration: text });
          }
          done = true;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) throw err;
          // Rate-limited: jump straight to the next fallback model.
          if (msg.includes('HTTP 429')) break;
          if (attempt < maxTries) await sleep(1000 * attempt);
        }
      }
      if (done) break;
    }

    if (!done) {
      throw lastErr instanceof Error ? lastErr : new Error('Groq storyteller failed for all models.');
    }
  }

  return { narrations, emotions, modelsUsed };
}

function applyStoryItems(
  data: z.infer<typeof StoryBatchSchema>,
  batch: SilentBeatWindow[],
  targetLang: TargetLang,
  narrations: Map<number, string>,
  emotions: Map<number, ScriptEmotion>,
) {
  const byId = new Map(batch.map((w) => [w.id, w]));
  for (const item of data.items) {
    const win = byId.get(item.id);
    if (!win) continue;
    let text = (item.narration || '').replace(/\s+/g, ' ').trim();
    if (targetLang === 'my-MM') {
      text = text.replace(/\.+$/g, '');
      if (!/[။]$/.test(text)) text = `${text.replace(/[!?！？,၊…]+$/g, '').trim()}။`;
    } else if (!/[.!?]["'”’)\]]*$/.test(text)) {
      text = `${text}.`;
    }
    if (text) narrations.set(item.id, text);
    emotions.set(item.id, normalizeEmotionTag(item.emotion));
  }
}

/**
 * Full silent-video recap pipeline: FFmpeg keyframes -> Groq Vision scene reading ->
 * Groq storyteller script -> RecapBeat[] ready for Burmese translation + Edge-TTS.
 */
export async function generateSilentVideoRecap(params: {
  project: Project;
  targetLang: TargetLang;
  narratorVoice: string;
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}): Promise<SilentVideoRecapResult> {
  const { project, targetLang, narratorVoice, force, onProgress } = params;
  const cfg = getConfig();
  const paths = getProjectPaths(project.id);

  if (!getGroqApiKey()) {
    throw new Error(
      'GROQ_API_KEY is not configured. Add it in Settings or .env.local to use Visual AI Script (No Voiceover).',
    );
  }

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
    throw new Error(
      'Video file (proxy_480p.mp4 or source video) is missing on disk. Run S0 Ingest first.',
    );
  }

  const durationMs = Math.max(1000, project.video.duration_ms || 0);
  const windows = buildSilentBeatWindows(project);
  if (windows.length === 0) {
    throw new Error('Could not build timeline beats from video duration.');
  }

  const framesDir = path.join(paths.workDir, 'recap_frames');
  const modelsUsed = new Set<string>();

  try {
    const keyframes = await extractSilentKeyframes({
      videoPath,
      framesDir,
      durationSec: durationMs / 1000,
      onProgress,
    });
    if (keyframes.length === 0) {
      throw new Error('No scene keyframes could be extracted from this video.');
    }
    if (onProgress) {
      await onProgress(
        20,
        `Extracted ${keyframes.length} scene keyframes. Reading scenes with Groq Vision...`,
      );
    }

    const visionRes = await readScenesWithGroqVision({
      projectId: project.id,
      keyframes,
      force,
      onProgress,
    });
    for (const m of visionRes.modelsUsed) modelsUsed.add(m);

    for (const note of visionRes.notes) {
      const win =
        windows.find((w) => note.timestampSec * 1000 < w.end_ms) ?? windows[windows.length - 1];
      note.beatId = win.id;
    }

    const storyRes = await writeRecapWithGroqStoryteller({
      projectId: project.id,
      project,
      windows,
      notes: visionRes.notes,
      targetLang,
      force,
      onProgress,
    });
    for (const m of storyRes.modelsUsed) modelsUsed.add(m);

    const beats: RecapBeat[] = windows.map((w) => {
      const narration = storyRes.narrations.get(w.id) ?? '';
      return {
        id: w.id,
        lang: targetLang,
        start_ms: w.start_ms,
        end_ms: w.end_ms,
        src_text: '',
        scene_note: `Visual AI keyframes ${formatMsShort(w.start_ms)}-${formatMsShort(w.end_ms)}`,
        narration_text: narration,
        slot_ms: w.slot_ms,
        max_syllables: w.max_syllables,
        syllables: countSyllables(narration, targetLang),
        tts_ms: 0,
        tts_file: '',
        rate: 1.2,
        video_rate: 1.0,
        status: narration ? 'ok' : 'needs_review',
        review_reason: narration ? undefined : 'Visual AI script line missing for this beat.',
        emotion: storyRes.emotions.get(w.id) ?? 'neutral',
        voice_name: narratorVoice,
        tts_engine: cfg.TTS_ENGINE,
        model_used: Array.from(modelsUsed).join(', ') || GROQ_RECAP_TEXT_MODEL,
      };
    });

    if (onProgress) {
      await onProgress(
        95,
        `Pro Recap script ready (${beats.length} beats from ${keyframes.length} keyframes).`,
      );
    }

    return { beats, modelsUsed: Array.from(modelsUsed), frameCount: keyframes.length };
  } finally {
    // Always clean up work/recap_frames/ after completion or failure.
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}