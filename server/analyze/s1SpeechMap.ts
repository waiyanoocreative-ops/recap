import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { type GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import type { Project, SpeechSegment } from '../../shared/projectTypes.ts';
import { getConfig } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { classifyGeminiError, getLoadedKeys } from '../gemini/keyPool.ts';
import { executeResilientGeminiCall } from '../gemini/resilientClient.ts';
import { detectPythonWhisper, requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import { withExponentialBackoffRetry } from '../utils/retry.ts';
import { hashFileWithSalt, readProjectCache, writeProjectCache } from './cache.ts';

const WordTimestampSchema = z.object({
  word: z.string(),
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
});

const RawUtteranceSchema = z.object({
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
  speaker: z.string().min(1).default('S1'),
  language: z.string().min(1).default('und'),
  text: z.string(),
  words: z.array(WordTimestampSchema).optional(),
});

const WindowTranscriptResponseSchema = z.object({
  utterances: z.array(RawUtteranceSchema),
});

export type WordTimestamp = z.infer<typeof WordTimestampSchema>;
export type RawUtterance = z.infer<typeof RawUtteranceSchema>;

interface AudioWindow {
  index: number;
  startMs: number;
  endMs: number;
  wavPath: string;
}

interface OffsetUtterance {
  window_index: number;
  start_ms: number;
  end_ms: number;
  speaker: string;
  src_lang: string;
  text: string;
  words?: WordTimestamp[];
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

const MIN_S1_WINDOW_MS = 30_000;
const MAX_S1_WINDOW_MS = 45_000;

export function planAnchoredWindows(
  rangeStartMs: number,
  rangeEndMs: number,
  silenceIntervals: Array<[number, number]>,
  maxWindowMs = MAX_S1_WINDOW_MS,
): Array<{ index: number; startMs: number; endMs: number }> {
  const safeStart = Math.max(0, Math.round(rangeStartMs));
  const safeEnd = Math.max(safeStart, Math.round(rangeEndMs));
  const totalSpan = safeEnd - safeStart;
  if (totalSpan <= 0) return [{ index: 0, startMs: safeStart, endMs: safeStart }];

  // Never send > 45s (strictly < 60s) of audio to Gemini in a single transcription call
  const effectiveMaxMs = Math.max(10_000, Math.min(MAX_S1_WINDOW_MS, maxWindowMs || MAX_S1_WINDOW_MS));
  const targetMinMs = Math.min(MIN_S1_WINDOW_MS, Math.round(effectiveMaxMs * 0.67));

  if (totalSpan <= effectiveMaxMs) {
    return [{ index: 0, startMs: safeStart, endMs: safeEnd }];
  }

  const windows: Array<{ index: number; startMs: number; endMs: number }> = [];
  let cursorMs = safeStart;
  let index = 0;

  while (cursorMs < safeEnd) {
    const remaining = safeEnd - cursorMs;
    if (remaining <= effectiveMaxMs) {
      windows.push({ index, startMs: cursorMs, endMs: safeEnd });
      break;
    }

    const hardLimit = cursorMs + effectiveMaxMs;
    const minCut = cursorMs + targetMinMs;
    const fallbackMinCut = cursorMs + Math.round(effectiveMaxMs * 0.45);

    // Prefer silence interval midpoint inside [30s, 45s]
    let bestCutMs: number | null = null;
    let bestScore = -1;

    for (const [sStart, sEnd] of silenceIntervals) {
      const mid = Math.round((sStart + sEnd) / 2);
      if (mid >= minCut && mid <= hardLimit) {
        const silenceDur = sEnd - sStart;
        const score = mid + Math.min(silenceDur, 3000) * 5;
        if (score > bestScore) {
          bestScore = score;
          bestCutMs = mid;
        }
      }
    }

    // Fallback to any silence in [20s, 45s] before hard cut at 45s
    if (bestCutMs === null) {
      for (const [sStart, sEnd] of silenceIntervals) {
        const mid = Math.round((sStart + sEnd) / 2);
        if (mid >= fallbackMinCut && mid <= hardLimit) {
          const silenceDur = sEnd - sStart;
          const score = mid + Math.min(silenceDur, 3000) * 5;
          if (score > bestScore) {
            bestScore = score;
            bestCutMs = mid;
          }
        }
      }
    }

    const endMs = bestCutMs && bestCutMs > cursorMs ? Math.min(hardLimit, bestCutMs) : hardLimit;
    windows.push({ index, startMs: cursorMs, endMs });
    cursorMs = endMs;
    index += 1;
  }

  return windows;
}

export function planAudioWindows(
  durationMs: number,
  silenceIntervals: Array<[number, number]>,
  maxWindowMs = MAX_S1_WINDOW_MS,
): Array<{ index: number; startMs: number; endMs: number }> {
  return planAnchoredWindows(0, durationMs, silenceIntervals, maxWindowMs);
}

async function prepareInlineAudioForModel(wavPath: string): Promise<{
  mimeType: string;
  base64: string;
}> {
  const { ffmpeg } = requireFfmpeg();
  const stat = await fs.stat(wavPath);
  // Keep inlineData safely under 12 MB by encoding 16 kHz mono MP3 when raw WAV is larger
  if (stat.size <= 10 * 1024 * 1024) {
    const buf = await fs.readFile(wavPath);
    return { mimeType: 'audio/wav', base64: buf.toString('base64') };
  }

  const mp3Path = wavPath.replace(/\.wav$/i, '.mp3');
  if (!(await fileExists(mp3Path))) {
    const res = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      wavPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      mp3Path,
    ]);
    if (res.code !== 0) {
      throw new Error(`Failed converting large audio window to MP3: ${res.stderr.slice(-4000)}`);
    }
  }
  const buf = await fs.readFile(mp3Path);
  return { mimeType: 'audio/mp3', base64: buf.toString('base64') };
}

async function callTranscribeModelOnWindow(params: {
  modelId: string;
  window: AudioWindow;
  projectId: string;
  force: boolean;
  boundedWait?: boolean;
}): Promise<{ utterances: OffsetUtterance[]; modelUsed: string }> {
  const { modelId, window, projectId, force, boundedWait = false } = params;
  const cfg = getConfig();
  const winDurMs = Math.max(0, window.endMs - window.startMs);
  const cacheSalt = `s1-transcribe-v3|model:${modelId}|start:${window.startMs}|dur:${winDurMs}`;
  const hash = await hashFileWithSalt(window.wavPath, cacheSalt);
  const cacheKey = `s1_win_${String(window.index).padStart(3, '0')}_${hash}`;

  if (!force) {
    const cached = await readProjectCache(projectId, cacheKey, WindowTranscriptResponseSchema);
    if (cached) {
      return {
        utterances: mapWindowUtterancesWithOffset(cached.utterances, window),
        modelUsed: modelId,
      };
    }
  }

  const { mimeType, base64 } = await prepareInlineAudioForModel(window.wavPath);

  const runAttempt = async (
    ai: GoogleGenAI,
    activeModelId: string,
    includeWords: boolean,
    useAudioTimestamp: boolean,
  ) => {
    const prompt = [
      `Transcribe ONLY meaningful spoken character dialogue in this ${Math.round(winDurMs / 1000)} second audio clip.`,
      'STRICT DIALOGUE-ONLY FILTER: IGNORE and COMPLETELY OMIT non-dialogue vocalizations, grunts, exclamations, pain/effort noises, screaming, battle cries, laughter, gasps, sighs, humming, or meaningless filler sounds (such as "Ah ah ah", "呀嘿呀", "啊啊", "嗯", "Ha ha ha", "Ugh", "Hmm"). Only transcribe actual meaningful spoken sentences/dialogue.',
      'ALSO IGNORE and COMPLETELY OMIT background music, singing/song lyrics, sound effects (footsteps, wind, rain, doors, explosions, clangs, UI sounds), crowd murmur, and ambient noise. NEVER output non-speech tags or descriptions such as [Music], [Sigh], [Applause], (laughing), *footsteps*, or background chatter.',
      'Identify distinct speaking characters cleanly as S1, S2, S3, etc. (diarization), auto-detect the ISO 639-1 language code per utterance (e.g. "zh", "en", "my", "ja", "ko"), and provide exact timestamps relative to the start of THIS clip.',
      'SEGMENTATION RULE: Enforce STRICT short sentence-level utterances (target 2 to 6 seconds, maximum 5–8 seconds per segment). Split at every natural pause >= 400 ms and at every sentence-ending punctuation mark (。！？.!?…။). NEVER merge multiple sentences into one long block.',
      `CRITICAL: All start_ms and end_ms values MUST be integer milliseconds from 0 up to ${winDurMs}.`,
      includeWords
        ? 'Include word-level timestamps in "words": [{"word": "...", "start_ms": 0, "end_ms": 200}] whenever spoken character dialogue is present.'
        : 'Keep each dialogue utterance accurate and clean in JSON.',
      'If there is NO meaningful spoken character dialogue (only grunts, exclamations, music, singing, silence, ambient noise, or sound effects), return {"utterances": []}.',
      'Return valid JSON matching {"utterances": [{"start_ms": number, "end_ms": number, "speaker": "S1", "language": "zh", "text": "..."}]} only.',
    ].join('\n');

    const baseProperties = {
      start_ms: { type: Type.INTEGER },
      end_ms: { type: Type.INTEGER },
      speaker: { type: Type.STRING },
      language: { type: Type.STRING },
      text: { type: Type.STRING },
    };

    const propertiesWithWords = includeWords
      ? {
          ...baseProperties,
          words: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                word: { type: Type.STRING },
                start_ms: { type: Type.INTEGER },
                end_ms: { type: Type.INTEGER },
              },
              required: ['word', 'start_ms', 'end_ms'],
            },
          },
        }
      : baseProperties;

    const response = await ai.models.generateContent({
      model: activeModelId,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
            { text: prompt },
          ],
        },
      ],
      config: {
        ...(useAudioTimestamp ? { audioTimestamp: true } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            utterances: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: propertiesWithWords,
                required: ['start_ms', 'end_ms', 'speaker', 'language', 'text'],
              },
            },
          },
          required: ['utterances'],
        },
      },
    });

    const rawText = response?.text ?? '';
    if (!rawText.trim()) {
      throw new Error(
        `TRANSCRIBE_MODEL (${activeModelId}) returned empty response for window ${window.index}.`,
      );
    }
    const parsedJson = JSON.parse(stripJsonFences(rawText));
    return WindowTranscriptResponseSchema.parse(parsedJson);
  };

const FAST_TRANSCRIBE_FALLBACK_ORDER = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-pro-preview',
] as const;

function buildFastTranscribeFallbackOrder(
  primaryModel: string,
  configuredFallbacks: string[],
): string[] {
  const rankOf = (id: string): number => {
    const idx = FAST_TRANSCRIBE_FALLBACK_ORDER.findIndex(
      (m) => m.toLowerCase() === id.toLowerCase(),
    );
    return idx === -1 ? FAST_TRANSCRIBE_FALLBACK_ORDER.length : idx;
  };
  return configuredFallbacks
    .filter((m) => m.toLowerCase() !== primaryModel.toLowerCase())
    .sort((a, b) => rankOf(a) - rankOf(b));
}

  const fastFallbacks = buildFastTranscribeFallbackOrder(modelId, cfg.TEXT_FALLBACK_MODELS);

  try {
    const { result: validated, model: usedModel } = await withExponentialBackoffRetry(
      () =>
        executeResilientGeminiCall<z.infer<typeof WindowTranscriptResponseSchema>>({
          projectId,
          kind: 's1_window',
          label: `S1 window #${window.index + 1}`,
          hash,
          queueName: 'geminiTranscribe',
          primaryModel: modelId,
          fallbackModels: fastFallbacks,
          attemptTimeoutMs: 25_000,
          maxNetworkWaitAttempts: boundedWait ? 1 : 2,
          maxQuotaWaitAttempts: boundedWait ? 0 : 1,
          force,
          onWaiting: (info) => {
            emitProjectEvent(projectId, {
              type: 'stage',
              stage: 'speech',
              message: info.message,
            });
          },
          onResult: async (parsed) => {
            // Save window transcription output to disk BEFORE marking job done
            await writeProjectCache(projectId, cacheKey, parsed);
          },
          call: async ({ ai, modelId: activeModelId }) => {
            const isDedicatedTranscribe = activeModelId.toLowerCase().includes('transcribe');
            try {
              return await runAttempt(ai, activeModelId, true, isDedicatedTranscribe);
            } catch (firstErr) {
              const classified = classifyGeminiError(firstErr);
              // Propagate key/quota/network/model errors up to key pool + fallback layer
              if (classified.category !== 'fatal') {
                throw firstErr;
              }
              console.warn(
                `[S1] Window ${window.index} first pass failed (${classified.sanitizedMessage}); retrying text-only utterance pass.`,
              );
              return await runAttempt(ai, activeModelId, false, false);
            }
          },
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        factor: 2,
        label: `S1 transcribe window #${window.index + 1}`,
      },
    );

    return {
      utterances: mapWindowUtterancesWithOffset(validated.utterances, window),
      modelUsed: usedModel,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`S1 window #${window.index + 1} transcription failed: ${msg}`);
  }
}

function stripNonSpeechTags(text: string): string {
  return text
    .replace(/\[[^\]]*(?:music|sfx|sound|applause|sigh|breath|laugh|cough|groan|noise|wind|footstep|crowd|cheering|singing|inaudible|silence)[^\]]*\]/gi, '')
    .replace(/\([^)]*(?:music|sfx|sound|applause|sigh|breath|laugh|cough|groan|noise|wind|footstep|crowd|cheering|singing|inaudible|silence)[^)]*\)/gi, '')
    .replace(/\*[^*]*(?:music|sfx|sound|applause|sigh|breath|laugh|cough|groan|noise|wind|footstep|crowd|cheering|singing)[^*]*\*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NON_DIALOGUE_VOCALIZATION_RE =
  /^(?:ah+|oh+|eh+|uh+|um+|hm+|hmm+|ha+|haha+|hehe+|hoho+|ugh+|oof+|ow+|aw+|argh+|grr+|shh+|呀嘿呀|呀啊+|啊+|呀+|嘿+|哈+|哼+|唉+|嗯+|哦+|哎+|喂+)(?:[\s,、，!！?？.。~～…-]+(?:ah+|oh+|eh+|uh+|um+|hm+|hmm+|ha+|haha+|hehe+|hoho+|ugh+|oof+|ow+|aw+|argh+|grr+|shh+|呀嘿呀|啊+|呀+|嘿+|哈+|哼+|唉+|嗯+|哦+|哎+))*[\s,、，!！?？.。~～…-]*$/iu;

function isNonDialogueVocalization(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;
  if (NON_DIALOGUE_VOCALIZATION_RE.test(cleaned)) return true;
  // Purely repeated single vocal token e.g. "ya ya ya"
  const tokens = cleaned
    .toLowerCase()
    .replace(/[!！?？.,，。~～…]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (
    tokens.length >= 2 &&
    tokens.every((tok) => tok === tokens[0] && /^(?:ah|oh|uh|ha|he|eh|ya|la|na|da|hm)$/.test(tok))
  ) {
    return true;
  }
  return false;
}

function mapWindowUtterancesWithOffset(
  utterances: RawUtterance[],
  window: AudioWindow,
): OffsetUtterance[] {
  const winDurMs = Math.max(0, window.endMs - window.startMs);
  const out: OffsetUtterance[] = [];

  for (const u of utterances) {
    const cleanText = stripNonSpeechTags(u.text);
    if (!cleanText || isNonDialogueVocalization(cleanText)) continue;

    const relStart = Math.max(0, Math.min(winDurMs, Math.round(u.start_ms)));
    const relEnd = Math.max(relStart + 50, Math.min(winDurMs, Math.round(u.end_ms)));

    const words = u.words?.map((w) => {
      const ws = Math.max(relStart, Math.min(relEnd, Math.round(w.start_ms)));
      const we = Math.max(ws, Math.min(relEnd, Math.round(w.end_ms)));
      return {
        word: w.word,
        start_ms: window.startMs + ws,
        end_ms: window.startMs + we,
      };
    });

    out.push({
      window_index: window.index,
      start_ms: window.startMs + relStart,
      end_ms: window.startMs + relEnd,
      speaker: u.speaker.trim() || 'S1',
      src_lang: u.language.trim() || 'und',
      text: cleanText,
      words,
    });
  }

  return out.sort((a, b) => a.start_ms - b.start_ms);
}

const WhisperSegmentItemSchema = z.object({
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
  start_ms: z.number().nonnegative().optional(),
  end_ms: z.number().nonnegative().optional(),
  timestamp: z
    .tuple([z.number().nullable(), z.number().nullable()])
    .optional(),
  text: z.string().default(''),
  speaker: z.string().optional(),
  language: z.string().optional(),
});

function normalizeWhisperLanguage(raw: unknown): string {
  if (typeof raw !== 'string') return 'my';
  const lower = raw.trim().toLowerCase();
  if (!lower) return 'my';
  const map: Record<string, string> = {
    burmese: 'my',
    myanmar: 'my',
    english: 'en',
    chinese: 'zh',
    mandarin: 'zh',
    japanese: 'ja',
    korean: 'ko',
    thai: 'th',
    vietnamese: 'vi',
    hindi: 'hi',
    spanish: 'es',
    french: 'fr',
    german: 'de',
    indonesian: 'id',
    malay: 'ms',
  };
  if (map[lower]) return map[lower];
  if (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(lower)) return lower.slice(0, 2);
  return 'my';
}

function parseWhisperPayloadToRawUtterances(
  payload: unknown,
  clipDurMs: number,
): RawUtterance[] {
  let rawItems: unknown[] = [];
  let defaultLanguage = 'my';
  if (Array.isArray(payload)) {
    rawItems = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    defaultLanguage = normalizeWhisperLanguage(obj.language);
    if (Array.isArray(obj.segments)) {
      rawItems = obj.segments;
    } else if (Array.isArray(obj.utterances)) {
      rawItems = obj.utterances;
    } else if (Array.isArray(obj.chunks)) {
      rawItems = obj.chunks;
    } else if (typeof obj.text === 'string' && obj.text.trim()) {
      return [
        {
          start_ms: 0,
          end_ms: Math.max(200, clipDurMs),
          speaker: 'S1',
          language: defaultLanguage,
          text: obj.text.trim(),
        },
      ];
    }
  }

  const out: RawUtterance[] = [];
  let prevEndMs = 0;

  for (const item of rawItems) {
    const parsed = WhisperSegmentItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const seg = parsed.data;
    const text = seg.text.trim();
    if (!text) continue;

    let startMs: number;
    let endMs: number;

    if (typeof seg.start_ms === 'number' && typeof seg.end_ms === 'number') {
      startMs = Math.max(0, Math.round(seg.start_ms));
      endMs = Math.max(startMs + 50, Math.round(seg.end_ms));
    } else if (typeof seg.start === 'number') {
      startMs = Math.max(0, Math.round(seg.start * 1000));
      endMs =
        typeof seg.end === 'number'
          ? Math.max(startMs + 50, Math.round(seg.end * 1000))
          : Math.max(startMs + 200, clipDurMs || startMs + 2000);
    } else if (seg.timestamp) {
      const [tsStart, tsEnd] = seg.timestamp;
      startMs =
        typeof tsStart === 'number' ? Math.max(0, Math.round(tsStart * 1000)) : prevEndMs;
      endMs =
        typeof tsEnd === 'number'
          ? Math.max(startMs + 50, Math.round(tsEnd * 1000))
          : Math.max(startMs + 200, clipDurMs || startMs + 2000);
    } else {
      continue;
    }

    if (clipDurMs > 0) {
      startMs = Math.min(clipDurMs, startMs);
      endMs = Math.min(clipDurMs, Math.max(startMs + 50, endMs));
    }
    prevEndMs = endMs;

    out.push({
      start_ms: startMs,
      end_ms: endMs,
      speaker: seg.speaker?.trim() || 'S1',
      language: seg.language?.trim() || defaultLanguage,
      text,
    });
  }

  return out;
}

let groqRequestQueue: Promise<void> = Promise.resolve();

function enqueueGroqRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = groqRequestQueue.then(async () => {
    try {
      return await task();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
  groqRequestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function buildMultipartFormBuffer(params: {
  boundary: string;
  fileFieldName: string;
  filename: string;
  mimeType: string;
  fileBuffer: Buffer;
  fields: Record<string, string>;
}): Buffer {
  const { boundary, fileFieldName, filename, mimeType, fileBuffer, fields } = params;
  const parts: Buffer[] = [];

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      'utf-8',
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n', 'utf-8'));

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
          `${value}\r\n`,
        'utf-8',
      ),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  return Buffer.concat(parts);
}

function postMultipartHttp1(params: {
  hostname: string;
  path: string;
  headers: Record<string, string | number>;
  body: Buffer;
  timeoutMs: number;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: params.hostname,
        port: 443,
        path: params.path,
        method: 'POST',
        headers: {
          ...params.headers,
          'Content-Length': params.body.length,
        },
        timeout: params.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', (err) => {
          reject(err);
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`HTTPS request timed out after ${params.timeoutMs} ms`));
    });
    req.on('error', (err) => {
      reject(err);
    });

    req.write(params.body);
    req.end();
  });
}

async function tryFreeS1Transcribe(params: {
  projectId: string;
  audioPath: string;
  startMs: number;
  endMs: number;
  windowIndex: number;
  force: boolean;
  onStatus?: (message: string) => Promise<void> | void;
}): Promise<{ utterances: OffsetUtterance[]; modelUsed: string } | null> {
  const cfg = getConfig();
  const { projectId, audioPath, startMs, endMs, windowIndex, force, onStatus } = params;
  const clipDurMs = Math.max(100, endMs - startMs);
  const virtualWindow: AudioWindow = {
    index: windowIndex,
    startMs,
    endMs,
    wavPath: audioPath,
  };

  // 1. When Groq API Key is configured, run S1 exclusively via Groq Whisper (NO fallback to Gemini)
  const rawGroqKey = cfg.groqApiKey || process.env.GROQ_API_KEY || '';
  let cleanGroqKey = rawGroqKey.replace(/[\r\n]/g, '').trim();
  if (
    (cleanGroqKey.startsWith('"') && cleanGroqKey.endsWith('"')) ||
    (cleanGroqKey.startsWith("'") && cleanGroqKey.endsWith("'"))
  ) {
    cleanGroqKey = cleanGroqKey.slice(1, -1).trim();
  }

  if (cleanGroqKey) {
    const groqModel = 'whisper-large-v3-turbo';
    const groqCacheSalt = `s1-groq-whisper-v2|model:${groqModel}|start:${startMs}|dur:${clipDurMs}`;
    const groqHash = await hashFileWithSalt(audioPath, groqCacheSalt);
    const groqCacheKey = `s1_groq_${String(windowIndex).padStart(3, '0')}_${groqHash}`;

    if (!force) {
      const cached = await readProjectCache(projectId, groqCacheKey, WindowTranscriptResponseSchema);
      if (cached) {
        return {
          utterances: mapWindowUtterancesWithOffset(cached.utterances, virtualWindow),
          modelUsed: `${groqModel} (groq-cached)`,
        };
      }
    }

    try {
      return await enqueueGroqRequest(async () => {
        await onStatus?.(
          `S1: Transcribing window #${windowIndex + 1} via Groq Whisper (${groqModel})...`,
        );
        console.log(
          `[S1] Transcribing via Groq Whisper API (window #${windowIndex + 1}, model=${groqModel})...`,
        );

        const { ffmpeg } = requireFfmpeg();
        const tempMp3Path = path.join(
          os.tmpdir(),
          `groq_s1_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp3`,
        );

        try {
          const encRes = await spawnCommand(
            ffmpeg,
            ['-y', '-i', audioPath, '-ac', '1', '-ar', '16000', '-b:a', '64k', tempMp3Path],
            { timeoutMs: 120_000 },
          );
          if (encRes.code !== 0) {
            throw new Error(
              `[S1 Groq] FFmpeg MP3 compression failed (exit ${encRes.code}): ${encRes.stderr.slice(-500)}`,
            );
          }

          const mp3Buffer = await fs.readFile(tempMp3Path);
          const boundary = `----GroqFormBoundary${crypto.randomBytes(12).toString('hex')}`;
          const multipartBody = buildMultipartFormBuffer({
            boundary,
            fileFieldName: 'file',
            filename: 'chunk.mp3',
            mimeType: 'audio/mpeg',
            fileBuffer: mp3Buffer,
            fields: {
              model: groqModel,
              response_format: 'verbose_json',
            },
          });

          const response = await postMultipartHttp1({
            hostname: 'api.groq.com',
            path: '/openai/v1/audio/transcriptions',
            headers: {
              Authorization: `Bearer ${cleanGroqKey}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body: multipartBody,
            timeoutMs: 60_000,
          });

          if (response.statusCode === 403) {
            throw new Error(
              '[S1 Groq] HTTP 403 Access Denied — Please turn OFF your VPN before running S1.',
            );
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            let errDetail = response.body.trim();
            try {
              const parsedErr = JSON.parse(response.body) as {
                error?: { message?: string };
                message?: string;
              };
              errDetail = parsedErr?.error?.message || parsedErr?.message || errDetail;
            } catch {
              // keep raw body text
            }
            throw new Error(
              `[S1 Groq] Failed with HTTP ${response.statusCode}: ${errDetail || 'Unknown error'}`,
            );
          }

          const jsonPayload: unknown = JSON.parse(response.body);
          const rawUtterances = parseWhisperPayloadToRawUtterances(jsonPayload, clipDurMs);
          await writeProjectCache(projectId, groqCacheKey, { utterances: rawUtterances });
          console.log(
            `[S1] Groq Whisper succeeded (window #${windowIndex + 1}, segments=${rawUtterances.length})`,
          );
          return {
            utterances: mapWindowUtterancesWithOffset(rawUtterances, virtualWindow),
            modelUsed: `${groqModel} (groq)`,
          };
        } finally {
          await fs.unlink(tempMp3Path).catch(() => {});
        }
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('[S1 Groq]')) {
        console.error(`${err.message} (window #${windowIndex + 1})`);
        throw err;
      }
      const errObj = err as Error & { cause?: unknown };
      const cause = errObj?.cause;
      let causeDetail = errObj?.message || String(err);
      if (cause && typeof cause === 'object') {
        const c = cause as {
          code?: string;
          message?: string;
          syscall?: string;
          address?: string;
        };
        const parts = [c.code, c.syscall, c.address, c.message].filter(Boolean);
        if (parts.length > 0) {
          causeDetail = parts.join(' ');
        }
      } else if (cause !== undefined) {
        causeDetail = String(cause);
      }
      const fatalMsg = `[S1 Groq] Failed with HTTP 0: ${causeDetail}`;
      console.error(`${fatalMsg} (window #${windowIndex + 1})`);
      throw new Error(fatalMsg);
    }
  }

  // 2. Try Kaggle GPU Tunnel (when Groq key is not configured)
  const kaggleUrl = (
    cfg.demucsRemoteUrl ||
    process.env.DEMUCS_REMOTE_URL ||
    process.env.KAGGLE_TUNNEL_URL ||
    ''
  ).trim();

  if (kaggleUrl) {
    const whisperModel = cfg.BURMESE_WHISPER_MODEL || 'stevenlimcorn/whisper-small-my';
    const cacheSalt = `s1-kaggle-whisper-v1|model:${whisperModel}|start:${startMs}|dur:${clipDurMs}`;
    const hash = await hashFileWithSalt(audioPath, cacheSalt);
    const cacheKey = `s1_kaggle_${String(windowIndex).padStart(3, '0')}_${hash}`;

    if (!force) {
      const cached = await readProjectCache(projectId, cacheKey, WindowTranscriptResponseSchema);
      if (cached) {
        return {
          utterances: mapWindowUtterancesWithOffset(cached.utterances, virtualWindow),
          modelUsed: `${whisperModel} (kaggle-cached)`,
        };
      }
    }

    const endpoint = `${kaggleUrl.replace(/\/$/, '')}/transcribe`;
    const timeoutMs = Math.max(300_000, cfg.KAGGLE_TIMEOUT_MS || 300_000);
    try {
      await onStatus?.(`S1: Offloading transcription to Kaggle GPU (${endpoint})...`);
      console.log(`[S1] Transcribing via Kaggle GPU (${endpoint}, model=${whisperModel})...`);

      const audioBuf = await fs.readFile(audioPath);
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([new Uint8Array(audioBuf)], { type: 'audio/wav' }),
        path.basename(audioPath),
      );
      formData.append('model', whisperModel);
      formData.append('language', 'my');
      formData.append('chunk_length_s', '30');

      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
        headers: {
          Connection: 'close',
          'Accept-Encoding': 'identity',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const jsonPayload: unknown = await response.json();
        const rawUtterances = parseWhisperPayloadToRawUtterances(jsonPayload, clipDurMs);
        await writeProjectCache(projectId, cacheKey, { utterances: rawUtterances });
        console.log(`[S1] Kaggle GPU transcription succeeded: ${rawUtterances.length} segment(s).`);
        return {
          utterances: mapWindowUtterancesWithOffset(rawUtterances, virtualWindow),
          modelUsed: `${whisperModel} (kaggle)`,
        };
      } else {
        const errBody = await response.text().catch(() => '');
        console.warn(`[S1] Kaggle GPU transcribe HTTP ${response.status}: ${errBody.slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[S1] Kaggle GPU transcribe failed (${msg}); trying local CPU / Gemini.`);
    }
  }

  // 3. Local CPU Whisper Fallback Third (if BURMESE_WHISPER_ENABLED is true)
  if (cfg.BURMESE_WHISPER_ENABLED) {
    const whisperModel = cfg.BURMESE_WHISPER_MODEL || 'stevenlimcorn/whisper-small-my';
    const ct2Path = (cfg.BURMESE_WHISPER_CT2_PATH || '').trim();
    const cacheSalt = `s1-burmese-whisper-v1|model:${whisperModel}|ct2:${ct2Path}|start:${startMs}|dur:${clipDurMs}`;
    const hash = await hashFileWithSalt(audioPath, cacheSalt);
    const cacheKey = `s1_whisper_${String(windowIndex).padStart(3, '0')}_${hash}`;

    if (!force) {
      const cached = await readProjectCache(projectId, cacheKey, WindowTranscriptResponseSchema);
      if (cached) {
        return {
          utterances: mapWindowUtterancesWithOffset(cached.utterances, virtualWindow),
          modelUsed: `${whisperModel} (local-cached)`,
        };
      }
    }

    const pyStatus = await detectPythonWhisper();
    const canUseTransformers = pyStatus.hasTransformers && pyStatus.hasTorch;
    const canUseFasterWhisper = pyStatus.hasFasterWhisper && Boolean(ct2Path);

    if (pyStatus.available && pyStatus.pythonPath && (canUseTransformers || canUseFasterWhisper)) {
      const scriptPath = path.resolve(process.cwd(), 'server', 'analyze', 'burmese_whisper.py');
      if (await fileExists(scriptPath)) {
        try {
          await onStatus?.(`S1: Running local Burmese Whisper (${whisperModel}, CPU 4 threads)...`);
          const args = [
            scriptPath,
            '--audio',
            audioPath,
            '--model',
            whisperModel,
            '--threads',
            '4',
            '--chunk-length',
            '30',
            '--language',
            'my',
          ];
          if (ct2Path) args.push('--ct2-model', ct2Path);

          const res = await spawnCommand(pyStatus.pythonPath, args, {
            timeoutMs: 20 * 60_000,
            env: {
              ...process.env,
              PYTHONUNBUFFERED: '1',
              OMP_NUM_THREADS: '4',
              MKL_NUM_THREADS: '4',
            },
          });

          if (res.code === 0) {
            const stdoutLines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
            const jsonLine = stdoutLines[stdoutLines.length - 1] || res.stdout.trim();
            const parsedJson: unknown = JSON.parse(jsonLine);
            const rawUtterances = parseWhisperPayloadToRawUtterances(parsedJson, clipDurMs);
            await writeProjectCache(projectId, cacheKey, { utterances: rawUtterances });
            return {
              utterances: mapWindowUtterancesWithOffset(rawUtterances, virtualWindow),
              modelUsed: `${whisperModel} (local-cpu)`,
            };
          }
        } catch (err) {
          console.warn(`[S1] Local CPU Whisper failed:`, err);
        }
      }
    }
  }

  // 4. Fallback to Gemini logic
  return null;
}


const SENTENCE_END_PUNCT_RE = /[。！？.!?…။]["'”’)\]]*$/;

function splitUtteranceOnPunctuation(u: OffsetUtterance): OffsetUtterance[] {
  const dur = u.end_ms - u.start_ms;
  const text = u.text.trim();
  if (!text || dur < 1600) return [u];

  // Match individual sentences keeping terminal punctuation attached
  const matches = text.match(/[^。！？.!?…။]+[。！？.!?…။]+["'”’)\]]*|[^。！？.!?…။]+$/g);
  if (!matches || matches.length <= 1) return [u];

  const parts = matches.map((m) => m.trim()).filter(Boolean);
  if (parts.length <= 1) return [u];

  // Only split multi-sentence blocks when duration > 5000 ms OR total text is long (>= 2 distinct sentences with decent length)
  const totalChars = parts.reduce((acc, p) => acc + p.length, 0);
  if (totalChars <= 0) return [u];

  const out: OffsetUtterance[] = [];
  let cursorMs = u.start_ms;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const partDur = isLast
      ? Math.max(200, u.end_ms - cursorMs)
      : Math.max(400, Math.round((part.length / totalChars) * dur));
    const endMs = isLast ? u.end_ms : Math.min(u.end_ms - 200, cursorMs + partDur);
    if (endMs > cursorMs) {
      out.push({
        window_index: u.window_index,
        start_ms: cursorMs,
        end_ms: endMs,
        speaker: u.speaker,
        src_lang: u.src_lang,
        text: part,
      });
      cursorMs = endMs;
    }
  }
  return out.length > 0 ? out : [u];
}

function splitUtteranceOnWordPauses(u: OffsetUtterance, pauseMs = 400): OffsetUtterance[] {
  if (!u.words || u.words.length < 2) {
    return splitUtteranceOnPunctuation(u);
  }

  const groups: WordTimestamp[][] = [[u.words[0]]];
  for (let i = 1; i < u.words.length; i++) {
    const prev = u.words[i - 1];
    const cur = u.words[i];
    const currentGroup = groups[groups.length - 1];
    const curGroupDur = prev.end_ms - currentGroup[0].start_ms;
    const gapSplit = cur.start_ms - prev.end_ms >= pauseMs;
    const punctSplit = SENTENCE_END_PUNCT_RE.test(prev.word.trim()) && curGroupDur >= 1000;
    const lengthSplit = prev.end_ms - currentGroup[0].start_ms >= 6500 && curGroupDur >= 1500;

    if (gapSplit || punctSplit || lengthSplit) {
      groups.push([cur]);
    } else {
      currentGroup.push(cur);
    }
  }

  if (groups.length <= 1) {
    return splitUtteranceOnPunctuation(u);
  }

  const wordPieces = groups
    .map((grp) => {
      const txt = grp.map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim();
      if (!txt) return null;
      return {
        window_index: u.window_index,
        start_ms: grp[0].start_ms,
        end_ms: Math.max(grp[0].start_ms + 50, grp[grp.length - 1].end_ms),
        speaker: u.speaker,
        src_lang: u.src_lang,
        text: txt,
        words: grp,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return wordPieces.flatMap((piece) => splitUtteranceOnPunctuation(piece));
}

function splitLongSegment(
  seg: OffsetUtterance,
  silenceIntervals: Array<[number, number]>,
  maxSegMs = 8000,
): OffsetUtterance[] {
  const dur = seg.end_ms - seg.start_ms;
  if (dur <= maxSegMs) return [seg];

  const pieces: OffsetUtterance[] = [];
  const queue: OffsetUtterance[] = [seg];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curDur = cur.end_ms - cur.start_ms;
    if (curDur <= maxSegMs) {
      pieces.push(cur);
      continue;
    }

    // 1) Try longest word-level inner pause
    let splitPointMs: number | null = null;
    let splitWordIdx: number | null = null;

    if (cur.words && cur.words.length >= 2) {
      let bestGap = -1;
      for (let i = 0; i < cur.words.length - 1; i++) {
        const left = cur.words[i];
        const right = cur.words[i + 1];
        const gap = right.start_ms - left.end_ms;
        const leftDur = left.end_ms - cur.start_ms;
        const rightDur = cur.end_ms - right.start_ms;
        if (leftDur >= 600 && rightDur >= 600 && gap > bestGap) {
          bestGap = gap;
          splitWordIdx = i;
          splitPointMs = Math.round((left.end_ms + right.start_ms) / 2);
        }
      }
    }

    // 2) Else try longest silence_ms inside [cur.start_ms + 800, cur.end_ms - 800]
    if (splitPointMs === null) {
      let bestSilDur = -1;
      for (const [sStart, sEnd] of silenceIntervals) {
        const mid = Math.round((sStart + sEnd) / 2);
        if (mid > cur.start_ms + 800 && mid < cur.end_ms - 800) {
          const sDur = sEnd - sStart;
          if (sDur > bestSilDur) {
            bestSilDur = sDur;
            splitPointMs = mid;
          }
        }
      }
    }

    // 3) Split by words or text proportionally
    if (splitWordIdx !== null && cur.words) {
      const leftWords = cur.words.slice(0, splitWordIdx + 1);
      const rightWords = cur.words.slice(splitWordIdx + 1);
      const leftText = leftWords.map((w) => w.word).join(' ').trim();
      const rightText = rightWords.map((w) => w.word).join(' ').trim();
      if (leftText && rightText) {
        queue.unshift(
          {
            ...cur,
            end_ms: leftWords[leftWords.length - 1].end_ms,
            text: leftText,
            words: leftWords,
          },
          {
            ...cur,
            start_ms: rightWords[0].start_ms,
            text: rightText,
            words: rightWords,
          },
        );
        continue;
      }
    }

    const cutMs = splitPointMs ?? Math.round((cur.start_ms + cur.end_ms) / 2);
    const ratio = Math.max(0.2, Math.min(0.8, (cutMs - cur.start_ms) / Math.max(1, curDur)));
    const text = cur.text.trim();
    const targetCharIdx = Math.max(1, Math.min(text.length - 1, Math.round(text.length * ratio)));

    // Prefer splitting cleanly on whitespace or sentence punctuation
    let splitCharIdx = targetCharIdx;
    const windowRadius = Math.max(8, Math.floor(text.length * 0.25));
    const searchStart = Math.max(1, targetCharIdx - windowRadius);
    const searchEnd = Math.min(text.length - 1, targetCharIdx + windowRadius);
    let bestCharDist = Infinity;

    for (let idx = searchStart; idx <= searchEnd; idx++) {
      if (/\s|[။၊,.!?，。！？]/.test(text[idx])) {
        const d = Math.abs(idx - targetCharIdx);
        if (d < bestCharDist) {
          bestCharDist = d;
          splitCharIdx = Math.min(text.length - 1, idx + 1);
        }
      }
    }

    splitCharIdx = Math.max(1, Math.min(text.length - 1, splitCharIdx));
    const leftText = text.slice(0, splitCharIdx).trim();
    const rightText = text.slice(splitCharIdx).trim();

    if (text.length < 2 || !leftText || !rightText || cutMs <= cur.start_ms || cutMs >= cur.end_ms) {
      pieces.push(cur);
      continue;
    }

    queue.unshift(
      {
        window_index: cur.window_index,
        start_ms: cur.start_ms,
        end_ms: cutMs,
        speaker: cur.speaker,
        src_lang: cur.src_lang,
        text: leftText,
      },
      {
        window_index: cur.window_index,
        start_ms: cutMs,
        end_ms: cur.end_ms,
        speaker: cur.speaker,
        src_lang: cur.src_lang,
        text: rightText,
      },
    );
  }

  return pieces;
}

export function buildSpeechSegments(
  utterances: OffsetUtterance[],
  silenceIntervals: Array<[number, number]>,
): SpeechSegment[] {
  // 1. Split on pauses > 400 ms where word timestamps exist
  const afterPauseSplit: OffsetUtterance[] = [];
  for (const u of utterances) {
    afterPauseSplit.push(...splitUtteranceOnWordPauses(u, 400));
  }
  afterPauseSplit.sort((a, b) => a.start_ms - b.start_ms);

  // 2. Merge segments < 800 ms into a neighbour of the same speaker (same window)
  const working = [...afterPauseSplit];
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (let i = 0; i < working.length; i++) {
      const cur = working[i];
      const dur = cur.end_ms - cur.start_ms;
      if (dur >= 800) continue;

      const prev = i > 0 ? working[i - 1] : null;
      const next = i < working.length - 1 ? working[i + 1] : null;

      const canPrev =
        prev !== null &&
        prev.speaker === cur.speaker &&
        prev.window_index === cur.window_index &&
        cur.start_ms - prev.end_ms < 400 &&
        !SENTENCE_END_PUNCT_RE.test(prev.text.trim()) &&
        Math.max(prev.end_ms, cur.end_ms) - prev.start_ms <= 8000;
      const canNext =
        next !== null &&
        next.speaker === cur.speaker &&
        next.window_index === cur.window_index &&
        next.start_ms - cur.end_ms < 400 &&
        !SENTENCE_END_PUNCT_RE.test(cur.text.trim()) &&
        Math.max(cur.end_ms, next.end_ms) - cur.start_ms <= 8000;

      if (!canPrev && !canNext) continue;

      const mergeWithPrev =
        canPrev && (!canNext || cur.start_ms - prev!.end_ms <= next!.start_ms - cur.end_ms);

      if (mergeWithPrev && prev) {
        working[i - 1] = {
          ...prev,
          end_ms: Math.max(prev.end_ms, cur.end_ms),
          text: `${prev.text} ${cur.text}`.trim(),
          words: prev.words && cur.words ? [...prev.words, ...cur.words] : undefined,
        };
        working.splice(i, 1);
      } else if (next) {
        working[i + 1] = {
          ...next,
          start_ms: Math.min(cur.start_ms, next.start_ms),
          text: `${cur.text} ${next.text}`.trim(),
          words: cur.words && next.words ? [...cur.words, ...next.words] : undefined,
        };
        working.splice(i, 1);
      }
      mergedAny = true;
      break;
    }
  }

  // 3. Split segments > 8 s at longest inner pause
  const finalRaw: OffsetUtterance[] = [];
  for (const seg of working) {
    finalRaw.push(...splitLongSegment(seg, silenceIntervals, 8000));
  }

  return finalRaw
    .filter((s) => s.text.trim().length > 0 && s.end_ms > s.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((s, idx) => ({
      id: idx + 1,
      start_ms: Math.round(s.start_ms),
      end_ms: Math.round(s.end_ms),
      speaker: s.speaker,
      src_lang: s.src_lang,
      text: s.text.trim(),
      window_index: s.window_index,
    }));
}

export async function runS1OnChunkSlice(params: {
  projectId: string;
  audio16kPath: string;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  wavOutPath: string;
  silenceMs: Array<[number, number]>;
  modelId: string;
  force: boolean;
}): Promise<{ segments: SpeechSegment[]; modelUsed: string }> {
  const { ffmpeg } = requireFfmpeg();
  const {
    projectId,
    audio16kPath,
    chunkIndex,
    startMs,
    endMs,
    wavOutPath,
    silenceMs,
    modelId,
    force,
  } = params;

  if (!force) {
    const existingProj = await getProject(projectId);
    if (
      existingProj &&
      existingProj.stages.speech.status === 'done' &&
      (existingProj.speech.length > 0 || existingProj.no_dialogue)
    ) {
      const existingSegments = existingProj.speech
        .filter((s) => s.start_ms >= startMs && s.start_ms < endMs)
        .sort((a, b) => a.start_ms - b.start_ms);
      console.log(
        `[Pipeline] S1 already completed (${existingSegments.length} segments found). Skipping S1 and proceeding directly to S2.`,
      );
      return {
        segments: existingSegments,
        modelUsed: existingProj.stages.speech.model_used || 'cached-s1',
      };
    }
  }

  const winDir = path.dirname(wavOutPath);
  await fs.mkdir(winDir, { recursive: true });

  if (force || !(await fileExists(wavOutPath))) {
    const startSec = (startMs / 1000).toFixed(3);
    const durSec = Math.max(0.2, (endMs - startMs) / 1000).toFixed(3);
    const cutSliceRes = await spawnCommand(ffmpeg, [
      '-y',
      '-ss',
      startSec,
      '-t',
      durSec,
      '-i',
      audio16kPath,
      '-c:a',
      'pcm_s16le',
      wavOutPath,
    ]);
    if (cutSliceRes.code !== 0) {
      throw new Error(
        `Failed cutting chunk ${chunkIndex} 16k WAV for transcription: ${cutSliceRes.stderr.slice(-4000)}`,
      );
    }
  }

  const freeRes = await tryFreeS1Transcribe({
    projectId,
    audioPath: wavOutPath,
    startMs,
    endMs,
    windowIndex: chunkIndex,
    force,
  });
  if (freeRes) {
    const segments = buildSpeechSegments(freeRes.utterances, silenceMs);
    return {
      segments,
      modelUsed: freeRes.modelUsed,
    };
  }

  // Split 3-10 minute chunk into 30-45s silence-aligned anchored windows so timestamps never drift
  const subPlans = planAnchoredWindows(startMs, endMs, silenceMs, MAX_S1_WINDOW_MS);
  const subWindows: AudioWindow[] = [];

  for (const sub of subPlans) {
    const subWavPath = path.join(
      winDir,
      `s1_c${String(chunkIndex).padStart(3, '0')}_w${String(sub.index).padStart(3, '0')}.wav`,
    );
    if (force || !(await fileExists(subWavPath))) {
      const startSec = (sub.startMs / 1000).toFixed(3);
      const durSec = Math.max(0.2, (sub.endMs - sub.startMs) / 1000).toFixed(3);
      const cutRes = await spawnCommand(ffmpeg, [
        '-y',
        '-ss',
        startSec,
        '-t',
        durSec,
        '-i',
        audio16kPath,
        '-c:a',
        'pcm_s16le',
        subWavPath,
      ]);
      if (cutRes.code !== 0) {
        throw new Error(
          `Failed cutting chunk ${chunkIndex} sub-window ${sub.index} 16k WAV: ${cutRes.stderr.slice(-4000)}`,
        );
      }
    }
    subWindows.push({
      index: chunkIndex * 1000 + sub.index,
      startMs: sub.startMs,
      endMs: sub.endMs,
      wavPath: subWavPath,
    });
  }

  const utterancesByIdx = new Map<number, OffsetUtterance[]>();
  const modelsUsed = new Set<string>();
  const concurrency = Math.min(3, Math.max(1, getLoadedKeys().length), Math.max(1, subWindows.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const myIdx = cursor;
        cursor += 1;
        if (myIdx >= subWindows.length) return;
        const win = subWindows[myIdx];
        const { utterances, modelUsed } = await callTranscribeModelOnWindow({
          modelId,
          window: win,
          projectId,
          force,
          boundedWait: true,
        });
        if (modelUsed) modelsUsed.add(modelUsed);
        utterancesByIdx.set(myIdx, utterances);
      }
    }),
  );

  const allUtterances: OffsetUtterance[] = [];
  for (let i = 0; i < subWindows.length; i += 1) {
    const list = utterancesByIdx.get(i);
    if (list) allUtterances.push(...list);
  }

  const segments = buildSpeechSegments(allUtterances, silenceMs);
  return {
    segments,
    modelUsed: Array.from(modelsUsed).join(', ') || modelId,
  };
}

export async function runS1SpeechMap(projectId: string, forceReset = false): Promise<Project> {
  const { ffmpeg } = requireFfmpeg();
  const cfg = getConfig();
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (!project.upload.completed) throw new Error('Upload must complete before running S1 Speech Map.');

  if (
    !forceReset &&
    project.stages.speech.status === 'done' &&
    (project.speech.length > 0 || project.no_dialogue)
  ) {
    console.log(
      `[Pipeline] S1 already completed (${project.speech.length} segments found). Skipping S1 and proceeding directly to S2.`,
    );
    return project;
  }

  const force = forceReset;

  const setSpeechProgress = async (
    pct: number,
    message: string,
    status: 'running' | 'done' | 'error' = 'running',
    error?: string,
    modelUsed?: string,
  ) => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        speech: {
          status,
          progress_pct: pct,
          message,
          error,
          model_used: modelUsed ?? cur.stages.speech.model_used,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: status === 'error' ? 'error' : 'stage',
      stage: 'speech',
      progress_pct: pct,
      message,
      project: updated,
    });
    return updated;
  };

  if (!project.video.has_audio) {
    const noAudioProj = await updateProject(projectId, (cur) => ({
      ...cur,
      no_dialogue: true,
      speech: [],
      stages: {
        ...cur.stages,
        speech: {
          status: 'done',
          progress_pct: 100,
          message: 'S1 complete: no audio track (marked no dialogue).',
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'speech',
      progress_pct: 100,
      message: noAudioProj.stages.speech.message,
      project: noAudioProj,
    });
    return noAudioProj;
  }

  const paths = getProjectPaths(projectId);
  const audio16kPath = path.join(paths.workDir, 'audio_16k.wav');
  const has16k = await fileExists(audio16kPath);
  const effectiveMaxWindowMs = Math.max(
    MIN_S1_WINDOW_MS,
    Math.min(MAX_S1_WINDOW_MS, (cfg.MAX_SPEECH_WINDOW_SEC || 45) * 1000),
  );
  const whisperSalt = cfg.BURMESE_WHISPER_ENABLED
    ? `|whisper:${cfg.BURMESE_WHISPER_MODEL}|ct2:${cfg.BURMESE_WHISPER_CT2_PATH}`
    : '';
  const s1StageHash = has16k
    ? await hashFileWithSalt(
        audio16kPath,
        `s1-stage-v3|model:${cfg.TRANSCRIBE_MODEL}|maxWinMs:${effectiveMaxWindowMs}${whisperSalt}`,
      )
    : undefined;

  if (!has16k) {
    throw new Error('16 kHz mono WAV (work/audio_16k.wav) missing. Run S0 Ingest first.');
  }

  try {
    await setSpeechProgress(
      10,
      `S1: Attempting free S1 transcription (Kaggle GPU / Groq Whisper)...`,
      'running',
      undefined,
      'free-whisper',
    );

    const freeRes = await tryFreeS1Transcribe({
      projectId,
      audioPath: audio16kPath,
      startMs: 0,
      endMs: project.video.duration_ms,
      windowIndex: 0,
      force,
      onStatus: async (msg) => {
        await setSpeechProgress(30, msg, 'running', undefined, 'free-whisper');
      },
    });

    if (freeRes) {
      await setSpeechProgress(
        90,
        'S1: Building segments (merge <800ms, split >8s)...',
        'running',
        undefined,
        freeRes.modelUsed,
      );
      const segments = buildSpeechSegments(freeRes.utterances, project.silence_ms);
      const totalSpeechMs = segments.reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0);
      const durationMs = Math.max(1, project.video.duration_ms);
      const speechPct = (totalSpeechMs / durationMs) * 100;
      const noDialogue = segments.length === 0 || speechPct < 5;

      const finalProject = await updateProject(projectId, (cur) => ({
        ...cur,
        no_dialogue: noDialogue,
        speech: segments,
        stage_hashes: {
          ...cur.stage_hashes,
          ...(s1StageHash ? { s1: s1StageHash } : {}),
        },
        stages: {
          ...cur.stages,
          speech: {
            status: 'done',
            progress_pct: 100,
            message: noDialogue
              ? `S1 complete: ${segments.length} segment(s) (${speechPct.toFixed(1)}% speech < 5% -> No dialogue).`
              : `S1 complete: ${segments.length} segment(s), ${speechPct.toFixed(1)}% speech coverage.`,
            model_used: freeRes.modelUsed,
            updated_at: new Date().toISOString(),
          },
        },
      }));

      emitProjectEvent(projectId, {
        type: 'stage',
        stage: 'speech',
        progress_pct: 100,
        message: finalProject.stages.speech.message,
        project: finalProject,
      });
      return finalProject;
    }

    await fs.mkdir(paths.windowsDir, { recursive: true });
    const windowPlan = planAnchoredWindows(
      0,
      project.video.duration_ms,
      project.silence_ms,
      effectiveMaxWindowMs,
    );
    await setSpeechProgress(
      10,
      `S1: Prepared ${windowPlan.length} anchored 30–45s window(s) for ${cfg.TRANSCRIBE_MODEL}...`,
    );

    const windows: AudioWindow[] = [];
    for (const w of windowPlan) {
      const winWavPath = path.join(paths.windowsDir, `win_${String(w.index).padStart(3, '0')}.wav`);
      if (windowPlan.length === 1 && w.startMs === 0) {
        await fs.copyFile(audio16kPath, winWavPath);
      } else {
        const startSec = (w.startMs / 1000).toFixed(3);
        const durSec = Math.max(0.1, (w.endMs - w.startMs) / 1000).toFixed(3);
        const cutRes = await spawnCommand(ffmpeg, [
          '-y',
          '-ss',
          startSec,
          '-t',
          durSec,
          '-i',
          audio16kPath,
          '-c:a',
          'pcm_s16le',
          winWavPath,
        ]);
        if (cutRes.code !== 0) {
          throw new Error(`Failed cutting window ${w.index}: ${cutRes.stderr.slice(-4000)}`);
        }
      }
      windows.push({ ...w, wavPath: winWavPath });
    }

    const keyCount = Math.max(1, getLoadedKeys().length);
    const s1Concurrency = Math.min(3, keyCount, Math.max(1, windows.length));
    const utterancesByWindow = new Map<number, OffsetUtterance[]>();
    const modelsUsed = new Set<string>();
    let nextWindowCursor = 0;
    let completedWindows = 0;

    await setSpeechProgress(
      15,
      `S1: Transcribing ${windows.length} window(s) in parallel (concurrency=${s1Concurrency}, keys=${keyCount}) with ${cfg.TRANSCRIBE_MODEL}...`,
      'running',
      undefined,
      cfg.TRANSCRIBE_MODEL,
    );

    const worker = async () => {
      while (true) {
        const myIdx = nextWindowCursor;
        nextWindowCursor += 1;
        if (myIdx >= windows.length) return;

        const win = windows[myIdx];
        const { utterances: utts, modelUsed } = await callTranscribeModelOnWindow({
          modelId: cfg.TRANSCRIBE_MODEL,
          window: win,
          projectId,
          force,
        });
        if (modelUsed) modelsUsed.add(modelUsed);
        utterancesByWindow.set(myIdx, utts);

        completedWindows += 1;
        const doneCount = completedWindows;
        const pct = Math.min(88, 15 + Math.round((doneCount / windows.length) * 73));
        const collectedSoFar: OffsetUtterance[] = [];
        for (let idx = 0; idx < windows.length; idx += 1) {
          const list = utterancesByWindow.get(idx);
          if (list) collectedSoFar.push(...list);
        }
        const partialSegments = buildSpeechSegments(collectedSoFar, project.silence_ms);

        await updateProject(projectId, (cur) => ({
          ...cur,
          speech: partialSegments,
        }));
        await setSpeechProgress(
          pct,
          `S1: Transcribed ${doneCount}/${windows.length} window(s) (concurrency=${s1Concurrency})...`,
          'running',
          undefined,
          Array.from(modelsUsed).join(', ') || cfg.TRANSCRIBE_MODEL,
        );
      }
    };

    await Promise.all(Array.from({ length: s1Concurrency }, () => worker()));

    const allUtterances: OffsetUtterance[] = [];
    for (let idx = 0; idx < windows.length; idx += 1) {
      const list = utterancesByWindow.get(idx);
      if (list) allUtterances.push(...list);
    }

    const usedModelSummary = Array.from(modelsUsed).join(', ') || cfg.TRANSCRIBE_MODEL;
    await setSpeechProgress(
      90,
      'S1: Building segments (merge <800ms, split >8s)...',
      'running',
      undefined,
      usedModelSummary,
    );
    const segments = buildSpeechSegments(allUtterances, project.silence_ms);

    const totalSpeechMs = segments.reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0);
    const durationMs = Math.max(1, project.video.duration_ms);
    const speechPct = (totalSpeechMs / durationMs) * 100;
    const noDialogue = segments.length === 0 || speechPct < 5;

    const finalProject = await updateProject(projectId, (cur) => ({
      ...cur,
      no_dialogue: noDialogue,
      speech: segments,
      stage_hashes: {
        ...cur.stage_hashes,
        ...(s1StageHash ? { s1: s1StageHash } : {}),
      },
      stages: {
        ...cur.stages,
        speech: {
          status: 'done',
          progress_pct: 100,
          message: noDialogue
            ? `S1 complete: ${segments.length} segment(s) (${speechPct.toFixed(1)}% speech < 5% -> No dialogue).`
            : `S1 complete: ${segments.length} segment(s), ${speechPct.toFixed(1)}% speech coverage.`,
          model_used: usedModelSummary,
          updated_at: new Date().toISOString(),
        },
      },
    }));

    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'speech',
      progress_pct: 100,
      message: finalProject.stages.speech.message,
      project: finalProject,
    });
    return finalProject;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setSpeechProgress(0, msg, 'error', msg);
    throw err;
  }
}
