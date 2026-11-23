import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import PQueue from 'p-queue';
import { z } from 'zod';
import {
  SpeechStyleSchema,
  TtsEngineTypeSchema,
  VoicePoolsConfigSchema,
  type SpeechStyle,
  type TtsEngineType,
  type VoicePoolsConfig,
} from '../shared/projectTypes.ts';
import {
  ACTIVE_PRIORITY_MODELS,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  isAllowedTextOrTranscribeModel,
  isAllowedTtsModel,
  normalizeGeminiModelId,
} from '../shared/modelFilters.ts';
import { setFallbackModelsSnapshot } from './gemini/jobQueue.ts';
import {
  classifyGeminiError,
  getLoadedKeys,
  initKeyPoolAtStartup,
  markKeyInvalid,
  pickFirstValidKey,
  redactSecrets,
} from './gemini/keyPool.ts';

const RateLimitItemSchema = z.object({
  concurrency: z.number().int().positive(),
  intervalCap: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const DEFAULT_VOICE_POOLS: VoicePoolsConfig = {
  edge: {
    'my-MM': {
      female: ['my-MM-NilarNeural'],
      male: ['my-MM-ThihaNeural'],
    },
    'en-US': {
      female: ['en-US-JennyNeural', 'en-US-AriaNeural'],
      male: ['en-US-GuyNeural', 'en-US-AndrewMultilingualNeural'],
    },
  },
  gemini: {
    'my-MM': {
      female: ['Kore', 'Zephyr'],
      male: ['Charon', 'Puck'],
    },
    'en-US': {
      female: ['Aoede', 'Leda'],
      male: ['Orus', 'Fenrir'],
    },
  },
};

const ConfigSchema = z.object({
  TEXT_MODEL: z.string().min(1).default(DEFAULT_TEXT_MODEL),
  TRANSCRIBE_MODEL: z.string().min(1).default(DEFAULT_TRANSCRIBE_MODEL),
  TTS_MODEL: z.string().default(''),
  TEXT_FALLBACK_MODELS: z.array(z.string().min(1)).default([]),
  TTS_FALLBACK_MODELS: z.array(z.string().min(1)).default([]),
  TTS_ENGINE: TtsEngineTypeSchema.default('edge'),
  SPEECH_STYLE: SpeechStyleSchema.default('polite'),
  TTS_VOLUME_PCT: z.number().int().min(100).max(200).default(150),
  demucsRemoteUrl: z.string().default(''),
  groqApiKey: z.string().default(''),
  GROQ_TEXT_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
  GROQ_TEXT_FALLBACK_MODELS: z
    .array(z.string().min(1))
    .default(['openai/gpt-oss-20b']),
  KAGGLE_TIMEOUT_MS: z.number().int().positive().default(300_000),
  BURMESE_WHISPER_ENABLED: z.boolean().default(false),
  BURMESE_WHISPER_MODEL: z.string().min(1).default('stevenlimcorn/whisper-small-my'),
  BURMESE_WHISPER_CT2_PATH: z.string().default(''),
  VOICE_POOLS: VoicePoolsConfigSchema.default(DEFAULT_VOICE_POOLS),
  GAP_MS: z.number().int().nonnegative(),
  RECAP_RATIO: z.number().positive().max(1),
  CHUNK_SIZE_BYTES: z.number().int().positive(),
  MAX_SPEECH_WINDOW_SEC: z.number().int().positive().max(1750),
  SILENCE_NOISE_DB: z.number(),
  SILENCE_MIN_SEC: z.number().positive(),
  SCENE_THRESHOLD: z.number().positive().max(1),
  GEMINI_TTS_MIN_SPACING_MS: z.number().int().nonnegative().default(3500),
  SYLLABLES_PER_SEC: z
    .object({
      'my-MM': z.number().positive().default(4.5),
      'en-US': z.number().positive().default(3.5),
    })
    .default({ 'my-MM': 4.5, 'en-US': 3.5 }),
  RATE_LIMITS: z.object({
    geminiText: RateLimitItemSchema,
    geminiTranscribe: RateLimitItemSchema,
    geminiTts: RateLimitItemSchema,
    edgeTts: RateLimitItemSchema,
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const PatchConfigSchema = z.object({
  TEXT_MODEL: z.string().min(1).optional(),
  TRANSCRIBE_MODEL: z.string().min(1).optional(),
  TTS_MODEL: z.string().optional(),
  TEXT_FALLBACK_MODELS: z.array(z.string().min(1)).optional(),
  TTS_FALLBACK_MODELS: z.array(z.string().min(1)).optional(),
  TTS_ENGINE: TtsEngineTypeSchema.optional(),
  SPEECH_STYLE: SpeechStyleSchema.optional(),
  TTS_VOLUME_PCT: z.number().int().min(100).max(200).optional(),
  demucsRemoteUrl: z.string().optional(),
  groqApiKey: z.string().optional(),
  GROQ_TEXT_MODEL: z.string().min(1).optional(),
  GROQ_TEXT_FALLBACK_MODELS: z.array(z.string().min(1)).optional(),
  KAGGLE_TIMEOUT_MS: z.number().int().positive().optional(),
  BURMESE_WHISPER_ENABLED: z.boolean().optional(),
  BURMESE_WHISPER_MODEL: z.string().min(1).optional(),
  BURMESE_WHISPER_CT2_PATH: z.string().optional(),
  VOICE_POOLS: VoicePoolsConfigSchema.optional(),
});
export type PatchConfigInput = z.infer<typeof PatchConfigSchema>;

export interface GeminiRuntimeState {
  configured: boolean;
  keyValid: boolean;
  keyError: string | null;
  startupChecked: boolean;
  availableModels: string[];
  resolutionNotes: string[];
}

export const requestCounts = {
  geminiText: 0,
  geminiTranscribe: 0,
  geminiTts: 0,
  edgeTts: 0,
};

let cachedConfig: AppConfig | null = null;
const cachedStandardClients = new Map<string, GoogleGenAI>();
const cachedTtsClients = new Map<string, GoogleGenAI>();
let configWriteLock: Promise<void> = Promise.resolve();

export const geminiRuntime: GeminiRuntimeState = {
  configured: false,
  keyValid: false,
  keyError: null,
  startupChecked: false,
  availableModels: [],
  resolutionNotes: [],
};

export interface QueueRegistry {
  geminiText: PQueue;
  geminiTranscribe: PQueue;
  geminiTts: PQueue;
  edgeTts: PQueue;
}

let cachedQueues: QueueRegistry | null = null;

function normalizeModelId(raw: string): string {
  return normalizeGeminiModelId(raw);
}

function parseModelListEnv(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const list = raw
    .split(',')
    .map((s) => normalizeModelId(s))
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseRawModelListEnv(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function getConfigPath(): string {
  return path.resolve(process.cwd(), 'config.json');
}

async function writeConfigAtomic(cfg: AppConfig): Promise<void> {
  const targetPath = getConfigPath();
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, targetPath);
}

function isBurmeseWhisperModelId(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return (
    lower === 'stevenlimcorn/whisper-small-my' ||
    lower === 'stevenlimcorn/whisper-medium-my' ||
    lower.startsWith('stevenlimcorn/whisper-') ||
    lower.startsWith('whisper-')
  );
}

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return undefined;
}

/**
 * Remote Kaggle demucs tunnel URLs are often pasted with a trailing slash or with the
 * endpoint path glued on (e.g. "https://xxxx.trycloudflare.com/separate"). The base URL is
 * all the app needs: it always calls GET <base>/health and POST <base>/separate itself.
 */
const REMOTE_ENDPOINT_SUFFIXES = ['/separate', '/health', '/transcribe', '/tts'];

export function normalizeDemucsRemoteUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let url = raw.replace(/[\r\n\t]/g, '').trim();
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1).trim();
  }
  if (!url) return '';

  // Bare host ("xxxx.trycloudflare.com") — assume https. Anything without a dot or port is not a host.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const bare = url.replace(/^\/+/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(bare) && !/^localhost(:\d+)?(\/|$)/i.test(bare)) {
      console.warn(`[Config] Demucs remote URL is not a recognizable host; ignoring: "${raw.trim()}"`);
      return '';
    }
    url = `${/^localhost(:\d+)?(\/|$)/i.test(bare) ? 'http' : 'https'}://${bare}`;
  }
  url = url.replace(/\/+$/, '');
  // Drop query/hash noise pasted from a browser ("…/separate?x=1") before suffix stripping.
  url = url.replace(/[?#].*$/, '').replace(/\/+$/, '');

  // Strip an accidentally appended endpoint path, repeatedly (handles "…/separate/").
  let stripped = true;
  while (stripped) {
    stripped = false;
    const lower = url.toLowerCase();
    for (const suffix of REMOTE_ENDPOINT_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        url = url.slice(0, -suffix.length).replace(/\/+$/, '');
        stripped = true;
        break;
      }
    }
  }

  if (!url || /\s/.test(url)) {
    if (url) console.warn(`[Config] Demucs remote URL contains whitespace; ignoring it.`);
    return '';
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn(`[Config] Demucs remote URL is not a valid URL; ignoring: "${raw.trim()}"`);
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(
      `[Config] Demucs remote URL must use http(s); ignoring "${parsed.protocol}//…".`,
    );
    return '';
  }
  if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
    console.warn(`[Config] Demucs remote URL has no valid host; ignoring: "${raw.trim()}"`);
    return '';
  }
  // Rebuild from parsed parts so normalize output is stable ("host" + path, no trailing slash).
  const pathPart = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathPart}`;
}

function firstNonEmptyNormalizedUrl(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeDemucsRemoteUrl(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function sanitizeApiKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let clean = raw.replace(/[\r\n]/g, '').trim();
  if (
    (clean.startsWith('"') && clean.endsWith('"')) ||
    (clean.startsWith("'") && clean.endsWith("'"))
  ) {
    clean = clean.slice(1, -1).trim();
  }
  return clean;
}

export async function loadStartupConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  const rawJson = await fs.readFile(configPath, 'utf-8');
  const parsedRaw = JSON.parse(rawJson) as Record<string, unknown>;

  const rawTextModel = normalizeModelId(
    String(process.env.TEXT_MODEL?.trim() || parsedRaw.TEXT_MODEL || ''),
  );
  const resolvedTextModel =
    !rawTextModel || !isAllowedTextOrTranscribeModel(rawTextModel)
      ? DEFAULT_TEXT_MODEL
      : rawTextModel;

  const rawTranscribeInput = String(
    process.env.TRANSCRIBE_MODEL?.trim() || parsedRaw.TRANSCRIBE_MODEL || '',
  ).trim();
  const transcribeInputIsWhisper = isBurmeseWhisperModelId(rawTranscribeInput);
  const rawTranscribeModel = transcribeInputIsWhisper ? '' : normalizeModelId(rawTranscribeInput);
  const resolvedTranscribeModel =
    !rawTranscribeModel || !isAllowedTextOrTranscribeModel(rawTranscribeModel)
      ? DEFAULT_TRANSCRIBE_MODEL
      : rawTranscribeModel;

  const rawTtsModel = normalizeModelId(
    String(process.env.TTS_MODEL?.trim() || parsedRaw.TTS_MODEL || ''),
  );
  const resolvedTtsModel =
    rawTtsModel && isAllowedTtsModel(rawTtsModel) ? rawTtsModel : '';

  const configuredFallbacks = (
    parseModelListEnv(process.env.TEXT_FALLBACK_MODELS) ||
    (Array.isArray(parsedRaw.TEXT_FALLBACK_MODELS)
      ? parsedRaw.TEXT_FALLBACK_MODELS.map((m) => normalizeModelId(String(m)))
      : [])
  ).filter((m) => isAllowedTextOrTranscribeModel(m) && m !== resolvedTextModel);

  const defaultTextFallbacks = ACTIVE_PRIORITY_MODELS.filter((m) => m !== resolvedTextModel);
  const resolvedTextFallbacks = Array.from(
    new Set(configuredFallbacks.length > 0 ? [...configuredFallbacks, ...defaultTextFallbacks] : defaultTextFallbacks),
  );

  const merged = {
    ...parsedRaw,
    TEXT_MODEL: resolvedTextModel,
    TRANSCRIBE_MODEL: resolvedTranscribeModel,
    TTS_MODEL: resolvedTtsModel,
    TEXT_FALLBACK_MODELS: resolvedTextFallbacks,
    TTS_FALLBACK_MODELS: (
      parseModelListEnv(process.env.TTS_FALLBACK_MODELS) ||
      (Array.isArray(parsedRaw.TTS_FALLBACK_MODELS)
        ? parsedRaw.TTS_FALLBACK_MODELS.map((m) => normalizeModelId(String(m)))
        : [])
    ).filter((m) => isAllowedTtsModel(String(m)) && m !== resolvedTtsModel),
    TTS_ENGINE:
      (process.env.TTS_ENGINE?.trim() as TtsEngineType | undefined) ||
      parsedRaw.TTS_ENGINE ||
      'edge',
    SPEECH_STYLE:
      (process.env.SPEECH_STYLE?.trim() as SpeechStyle | undefined) ||
      parsedRaw.SPEECH_STYLE ||
      'polite',
    TTS_VOLUME_PCT: process.env.TTS_VOLUME_PCT
      ? Number(process.env.TTS_VOLUME_PCT)
      : typeof parsedRaw.TTS_VOLUME_PCT === 'number'
        ? parsedRaw.TTS_VOLUME_PCT
        : 150,
    demucsRemoteUrl: firstNonEmptyNormalizedUrl([
      // Saved config wins so UI edits take effect without a restart; env is the fallback.
      parsedRaw.demucsRemoteUrl,
      parsedRaw.DEMUCS_REMOTE_URL,
      parsedRaw.DEMUCS_URL,
      parsedRaw.KAGGLE_DEMUCS_URL,
      parsedRaw.kaggleTunnelUrl,
      process.env.DEMUCS_REMOTE_URL,
      process.env.DEMUCS_URL,
      process.env.KAGGLE_DEMUCS_URL,
      process.env.KAGGLE_TUNNEL_URL,
    ]),
    groqApiKey:
      sanitizeApiKey(parsedRaw.groqApiKey) ||
      sanitizeApiKey(parsedRaw.GROQ_API_KEY) ||
      sanitizeApiKey(process.env.GROQ_API_KEY),
    GROQ_TEXT_MODEL:
      process.env.GROQ_TEXT_MODEL?.trim() ||
      (typeof parsedRaw.GROQ_TEXT_MODEL === 'string' && parsedRaw.GROQ_TEXT_MODEL.trim().length > 0
        ? parsedRaw.GROQ_TEXT_MODEL.trim()
        : 'openai/gpt-oss-120b'),
    GROQ_TEXT_FALLBACK_MODELS:
      parseRawModelListEnv(process.env.GROQ_TEXT_FALLBACK_MODELS) ||
      (Array.isArray(parsedRaw.GROQ_TEXT_FALLBACK_MODELS)
        ? parsedRaw.GROQ_TEXT_FALLBACK_MODELS.map((m) => String(m).trim()).filter(Boolean)
        : ['openai/gpt-oss-20b']),
    KAGGLE_TIMEOUT_MS: process.env.KAGGLE_TIMEOUT_MS
      ? Number(process.env.KAGGLE_TIMEOUT_MS)
      : typeof parsedRaw.KAGGLE_TIMEOUT_MS === 'number'
        ? parsedRaw.KAGGLE_TIMEOUT_MS
        : 300_000,
    BURMESE_WHISPER_ENABLED:
      parseBoolEnv(process.env.BURMESE_WHISPER_ENABLED) ??
      (process.env.TRANSCRIBE_ENGINE?.trim().toLowerCase() === 'burmese_whisper'
        ? true
        : typeof parsedRaw.BURMESE_WHISPER_ENABLED === 'boolean'
          ? parsedRaw.BURMESE_WHISPER_ENABLED
          : String(parsedRaw.TRANSCRIBE_ENGINE || '').trim().toLowerCase() === 'burmese_whisper' ||
            transcribeInputIsWhisper),
    BURMESE_WHISPER_MODEL:
      process.env.BURMESE_WHISPER_MODEL?.trim() ||
      process.env.WHISPER_MODEL?.trim() ||
      (transcribeInputIsWhisper ? rawTranscribeInput : '') ||
      (typeof parsedRaw.BURMESE_WHISPER_MODEL === 'string' &&
      parsedRaw.BURMESE_WHISPER_MODEL.trim().length > 0
        ? parsedRaw.BURMESE_WHISPER_MODEL.trim()
        : typeof parsedRaw.WHISPER_MODEL === 'string' && parsedRaw.WHISPER_MODEL.trim().length > 0
          ? parsedRaw.WHISPER_MODEL.trim()
          : 'stevenlimcorn/whisper-small-my'),
    BURMESE_WHISPER_CT2_PATH:
      process.env.BURMESE_WHISPER_CT2_PATH?.trim() ||
      (typeof parsedRaw.BURMESE_WHISPER_CT2_PATH === 'string'
        ? parsedRaw.BURMESE_WHISPER_CT2_PATH.trim()
        : ''),
    VOICE_POOLS: parsedRaw.VOICE_POOLS || DEFAULT_VOICE_POOLS,
    GAP_MS: process.env.GAP_MS ? Number(process.env.GAP_MS) : parsedRaw.GAP_MS,
    RECAP_RATIO: process.env.RECAP_RATIO ? Number(process.env.RECAP_RATIO) : parsedRaw.RECAP_RATIO,
    GEMINI_TTS_MIN_SPACING_MS: parsedRaw.GEMINI_TTS_MIN_SPACING_MS ?? 3500,
    SYLLABLES_PER_SEC: parsedRaw.SYLLABLES_PER_SEC ?? { 'my-MM': 4.5, 'en-US': 3.5 },
  };

  const validated = ConfigSchema.parse(merged);
  cachedConfig = validated;
  if (validated.groqApiKey) {
    process.env.GROQ_API_KEY = validated.groqApiKey;
  }

  await initKeyPoolAtStartup();
  const keyConcurrency = Math.min(3, Math.max(1, getLoadedKeys().length));
  const transcribeConcurrency = Math.max(
    validated.RATE_LIMITS.geminiTranscribe.concurrency,
    keyConcurrency,
  );
  const transcribeIntervalCap = Math.max(
    validated.RATE_LIMITS.geminiTranscribe.intervalCap,
    validated.RATE_LIMITS.geminiTranscribe.intervalCap * keyConcurrency,
  );

  cachedQueues = {
    geminiText: new PQueue({
      concurrency: validated.RATE_LIMITS.geminiText.concurrency,
      intervalCap: validated.RATE_LIMITS.geminiText.intervalCap,
      interval: validated.RATE_LIMITS.geminiText.interval,
    }),
    geminiTranscribe: new PQueue({
      concurrency: transcribeConcurrency,
      intervalCap: transcribeIntervalCap,
      interval: validated.RATE_LIMITS.geminiTranscribe.interval,
    }),
    geminiTts: new PQueue({
      concurrency: validated.RATE_LIMITS.geminiTts.concurrency,
      intervalCap: validated.RATE_LIMITS.geminiTts.intervalCap,
      interval: validated.RATE_LIMITS.geminiTts.interval,
    }),
    edgeTts: new PQueue({
      concurrency: validated.RATE_LIMITS.edgeTts.concurrency,
      intervalCap: validated.RATE_LIMITS.edgeTts.intervalCap,
      interval: validated.RATE_LIMITS.edgeTts.interval,
    }),
  };

  setFallbackModelsSnapshot(validated.TEXT_FALLBACK_MODELS, validated.TTS_FALLBACK_MODELS);
  await inspectGeminiModelsAtStartup(validated);
  return validated;
}

export async function updateConfig(patch: PatchConfigInput): Promise<AppConfig> {
  const prev = configWriteLock;
  let release!: () => void;
  configWriteLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;

  try {
    const current = getConfig();
    const nextCandidate: AppConfig = ConfigSchema.parse({
      ...current,
      ...(patch.TEXT_MODEL !== undefined ? { TEXT_MODEL: normalizeModelId(patch.TEXT_MODEL) } : {}),
      ...(patch.TRANSCRIBE_MODEL !== undefined
        ? { TRANSCRIBE_MODEL: normalizeModelId(patch.TRANSCRIBE_MODEL) }
        : {}),
      ...(patch.TTS_MODEL !== undefined ? { TTS_MODEL: normalizeModelId(patch.TTS_MODEL) } : {}),
      ...(patch.TEXT_FALLBACK_MODELS !== undefined
        ? { TEXT_FALLBACK_MODELS: patch.TEXT_FALLBACK_MODELS.map(normalizeModelId).filter(Boolean) }
        : {}),
      ...(patch.TTS_FALLBACK_MODELS !== undefined
        ? { TTS_FALLBACK_MODELS: patch.TTS_FALLBACK_MODELS.map(normalizeModelId).filter(Boolean) }
        : {}),
      ...(patch.TTS_ENGINE !== undefined ? { TTS_ENGINE: patch.TTS_ENGINE } : {}),
      ...(patch.SPEECH_STYLE !== undefined ? { SPEECH_STYLE: patch.SPEECH_STYLE } : {}),
      ...(patch.TTS_VOLUME_PCT !== undefined ? { TTS_VOLUME_PCT: patch.TTS_VOLUME_PCT } : {}),
      ...(patch.demucsRemoteUrl !== undefined
        ? { demucsRemoteUrl: normalizeDemucsRemoteUrl(patch.demucsRemoteUrl) }
        : {}),
      ...(patch.groqApiKey !== undefined
        ? { groqApiKey: sanitizeApiKey(patch.groqApiKey) }
        : {}),
      ...(patch.GROQ_TEXT_MODEL !== undefined
        ? { GROQ_TEXT_MODEL: patch.GROQ_TEXT_MODEL.trim() }
        : {}),
      ...(patch.GROQ_TEXT_FALLBACK_MODELS !== undefined
        ? {
            GROQ_TEXT_FALLBACK_MODELS: patch.GROQ_TEXT_FALLBACK_MODELS.map((m) => m.trim()).filter(
              Boolean,
            ),
          }
        : {}),
      ...(patch.KAGGLE_TIMEOUT_MS !== undefined
        ? { KAGGLE_TIMEOUT_MS: patch.KAGGLE_TIMEOUT_MS }
        : {}),
      ...(patch.BURMESE_WHISPER_ENABLED !== undefined
        ? { BURMESE_WHISPER_ENABLED: patch.BURMESE_WHISPER_ENABLED }
        : {}),
      ...(patch.BURMESE_WHISPER_MODEL !== undefined
        ? { BURMESE_WHISPER_MODEL: patch.BURMESE_WHISPER_MODEL.trim() }
        : {}),
      ...(patch.BURMESE_WHISPER_CT2_PATH !== undefined
        ? { BURMESE_WHISPER_CT2_PATH: patch.BURMESE_WHISPER_CT2_PATH.trim() }
        : {}),
      ...(patch.VOICE_POOLS !== undefined ? { VOICE_POOLS: patch.VOICE_POOLS } : {}),
    });

    await writeConfigAtomic(nextCandidate);
    cachedConfig = nextCandidate;
    if (patch.groqApiKey !== undefined) {
      if (nextCandidate.groqApiKey) {
        process.env.GROQ_API_KEY = nextCandidate.groqApiKey;
      } else {
        delete process.env.GROQ_API_KEY;
      }
    }
    setFallbackModelsSnapshot(nextCandidate.TEXT_FALLBACK_MODELS, nextCandidate.TTS_FALLBACK_MODELS);
    return nextCandidate;
  } finally {
    release();
  }
}

export const saveConfig = updateConfig;

async function inspectGeminiModelsAtStartup(cfg: AppConfig): Promise<void> {
  const poolKeys = getLoadedKeys();
  geminiRuntime.resolutionNotes = [];

  if (poolKeys.length === 0) {
    geminiRuntime.configured = false;
    geminiRuntime.keyValid = false;
    geminiRuntime.keyError =
      'No Gemini API keys configured (check GEMINI_API_KEYS, GEMINI_API_KEY_1..5, or GEMINI_API_KEY).';
    geminiRuntime.startupChecked = true;
    geminiRuntime.resolutionNotes.push(geminiRuntime.keyError);
    return;
  }

  geminiRuntime.configured = true;
  geminiRuntime.resolutionNotes.push(
    `KeyPool loaded ${poolKeys.length} key(s): ${poolKeys.map((k) => k.masked).join(', ')}.`,
  );

  let verifiedCatalogNames: string[] | null = null;
  let lastStartupErr: string | null = null;

  for (const key of poolKeys) {
    const ai = getGeminiClient(key.rawKey);
    try {
      const pager = await Promise.race([
        ai.models.list(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gemini models.list() timed out after 8s.')), 8000),
        ),
      ]);
      const rawNames: string[] = [];
      for await (const model of pager) {
        if (model.name) {
          const clean = normalizeModelId(model.name);
          if (clean) rawNames.push(clean);
        }
      }
      const rawLowerSet = new Set(rawNames.map((m) => normalizeModelId(m).toLowerCase()));
      const verifiedPriority = ACTIVE_PRIORITY_MODELS.filter((m) =>
        rawLowerSet.has(m.toLowerCase()),
      );
      const verifiedTts = Array.from(
        new Set(rawNames.filter((m) => isAllowedTtsModel(m, rawNames))),
      );

      verifiedCatalogNames = Array.from(new Set([...verifiedPriority, ...verifiedTts]));
      geminiRuntime.availableModels = verifiedCatalogNames;
      geminiRuntime.keyValid = true;
      geminiRuntime.keyError = null;
      geminiRuntime.startupChecked = true;
      break;
    } catch (err) {
      const classified = classifyGeminiError(err);
      lastStartupErr = classified.sanitizedMessage;
      if (classified.category === 'invalid_key') {
        markKeyInvalid(key.id, classified.sanitizedMessage);
        geminiRuntime.resolutionNotes.push(
          `Key ${key.masked} (${key.source}) rejected (${classified.httpStatus}): marked invalid.`,
        );
        continue;
      }
      // Network or transient error at startup — keep keys usable for runtime retry
      geminiRuntime.keyValid = true;
      geminiRuntime.keyError = null;
      geminiRuntime.startupChecked = true;
      geminiRuntime.resolutionNotes.push(
        `Startup model catalog check skipped (${classified.sanitizedMessage}); runtime retries enabled.`,
      );
      return;
    }
  }

  if (!verifiedCatalogNames) {
    geminiRuntime.startupChecked = true;
    geminiRuntime.keyValid = false;
    geminiRuntime.keyError = redactSecrets(
      lastStartupErr || 'All configured Gemini API keys failed validation.',
    );
    geminiRuntime.resolutionNotes.push(geminiRuntime.keyError);
    return;
  }

  const catalogLowerSet = new Set(verifiedCatalogNames.map((m) => m.toLowerCase()));
  const verifiedPriorityModels = ACTIVE_PRIORITY_MODELS.filter((m) =>
    catalogLowerSet.has(m.toLowerCase()),
  );
  const verifiedTtsModels = verifiedCatalogNames.filter((m) =>
    isAllowedTtsModel(m, verifiedCatalogNames!),
  );

  // Filter active primary & fallback lists strictly against models.list() verified catalog
  if (verifiedPriorityModels.length > 0) {
    if (!verifiedPriorityModels.includes(normalizeModelId(cfg.TEXT_MODEL) as (typeof ACTIVE_PRIORITY_MODELS)[number])) {
      const prev = cfg.TEXT_MODEL;
      cfg.TEXT_MODEL = verifiedPriorityModels[0];
      geminiRuntime.resolutionNotes.push(
        `TEXT_MODEL: "${prev}" not found in models.list() catalog; switched to verified active model "${cfg.TEXT_MODEL}".`,
      );
    }
    if (
      !verifiedPriorityModels.includes(
        normalizeModelId(cfg.TRANSCRIBE_MODEL) as (typeof ACTIVE_PRIORITY_MODELS)[number],
      )
    ) {
      const prev = cfg.TRANSCRIBE_MODEL;
      cfg.TRANSCRIBE_MODEL = verifiedPriorityModels[0];
      geminiRuntime.resolutionNotes.push(
        `TRANSCRIBE_MODEL: "${prev}" not found in models.list() catalog; switched to verified active model "${cfg.TRANSCRIBE_MODEL}".`,
      );
    }

    const existingVerifiedFallbacks = cfg.TEXT_FALLBACK_MODELS.filter(
      (m) =>
        verifiedPriorityModels.includes(m as (typeof ACTIVE_PRIORITY_MODELS)[number]) &&
        m !== cfg.TEXT_MODEL,
    );
    const remainingPriority = verifiedPriorityModels.filter(
      (m) => m !== cfg.TEXT_MODEL && !existingVerifiedFallbacks.includes(m),
    );
    cfg.TEXT_FALLBACK_MODELS = [...existingVerifiedFallbacks, ...remainingPriority];
    geminiRuntime.resolutionNotes.push(
      `TEXT_FALLBACK_MODELS verified active (${cfg.TEXT_FALLBACK_MODELS.length}): ${cfg.TEXT_FALLBACK_MODELS.join(', ') || 'none'}.`,
    );
  } else {
    cfg.TEXT_FALLBACK_MODELS = [];
    geminiRuntime.resolutionNotes.push(
      `Warning: 0 of [${ACTIVE_PRIORITY_MODELS.join(', ')}] matched active models.list() catalog; cleared unverified fallback list.`,
    );
  }

  cfg.TTS_FALLBACK_MODELS = cfg.TTS_FALLBACK_MODELS.filter(
    (m) => verifiedTtsModels.includes(normalizeModelId(m)) && normalizeModelId(m) !== cfg.TTS_MODEL,
  );
  if (cfg.TTS_MODEL && !verifiedTtsModels.includes(normalizeModelId(cfg.TTS_MODEL))) {
    const prevTts = cfg.TTS_MODEL;
    cfg.TTS_MODEL = verifiedTtsModels[0] ?? '';
    geminiRuntime.resolutionNotes.push(
      `TTS_MODEL: "${prevTts}" not found in active catalog; switched to "${cfg.TTS_MODEL || 'none'}".`,
    );
  } else if (!cfg.TTS_MODEL && verifiedTtsModels.length > 0) {
    cfg.TTS_MODEL = verifiedTtsModels[0];
  }

  cachedConfig = cfg;
  setFallbackModelsSnapshot(cfg.TEXT_FALLBACK_MODELS, cfg.TTS_FALLBACK_MODELS);

  const verifyKey = (key: 'TEXT_MODEL' | 'TRANSCRIBE_MODEL' | 'TTS_MODEL', configuredId: string) => {
    const cleanId = normalizeModelId(configuredId);
    if (!cleanId) {
      geminiRuntime.resolutionNotes.push(`${key}: (none configured/active in catalog).`);
      return;
    }
    const exactMatch = verifiedCatalogNames!.find((m) => m === cleanId);
    if (exactMatch) {
      geminiRuntime.resolutionNotes.push(`${key}: verified "${exactMatch}" in Gemini model catalog.`);
      return;
    }
    geminiRuntime.resolutionNotes.push(
      `${key}: "${cleanId}" not listed in filtered models.list() (${verifiedCatalogNames!.length} active models).`,
    );
  };

  verifyKey('TEXT_MODEL', cfg.TEXT_MODEL);
  verifyKey('TRANSCRIBE_MODEL', cfg.TRANSCRIBE_MODEL);
  verifyKey('TTS_MODEL', cfg.TTS_MODEL);
}

export async function withRetryBackoff<T>(
  apiKeyName: keyof typeof requestCounts,
  fn: () => Promise<T>,
  maxRetries = 4,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      requestCounts[apiKeyName] += 1;
      return await fn();
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const isRetryable = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|ECONNRESET/i.test(
        msg,
      );
      if (!isRetryable || attempt >= maxRetries) {
        throw err instanceof Error ? new Error(msg) : new Error(msg);
      }
      const delayMs = Math.min(30000, 1000 * 2 ** attempt + Math.floor(Math.random() * 400));
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error('Config not loaded yet. Call loadStartupConfig() at server startup.');
  }
  return cachedConfig;
}

/**
 * Effective remote demucs base URL (normalized, no trailing slash / endpoint suffix).
 * Reads the live runtime config first so UI edits apply without a server restart.
 */
export function resolveDemucsRemoteUrl(): string {
  return firstNonEmptyNormalizedUrl([
    cachedConfig?.demucsRemoteUrl,
    process.env.DEMUCS_REMOTE_URL,
    process.env.DEMUCS_URL,
    process.env.KAGGLE_DEMUCS_URL,
    process.env.KAGGLE_TUNNEL_URL,
  ]);
}

export function buildDemucsEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeDemucsRemoteUrl(baseUrl);
  if (!base) return '';
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

export function getQueues(): QueueRegistry {
  if (!cachedQueues) {
    throw new Error('Queues not initialized yet. Call loadStartupConfig() at server startup.');
  }
  return cachedQueues;
}

export function getGroqApiKey(): string {
  const fromCfg = cachedConfig?.groqApiKey ?? '';
  const fromEnv = process.env.GROQ_API_KEY ?? '';
  return sanitizeApiKey(fromCfg) || sanitizeApiKey(fromEnv);
}

function resolveDefaultRawKey(): string {
  const valid = pickFirstValidKey();
  if (valid?.rawKey) return valid.rawKey;
  const fallback =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY_1?.trim() ||
    process.env.GEMINI_API_KEYS?.split(',')[0]?.trim();
  if (!fallback) {
    throw new Error('No Gemini API key is configured on the server.');
  }
  return fallback;
}

export function getGeminiClient(apiKeyOverride?: string): GoogleGenAI {
  const apiKey = apiKeyOverride?.trim() || resolveDefaultRawKey();
  let client = cachedStandardClients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        apiVersion: 'v1beta',
      },
    });
    cachedStandardClients.set(apiKey, client);
  }
  return client;
}

export function getGeminiTtsClient(apiKeyOverride?: string): GoogleGenAI {
  const apiKey = apiKeyOverride?.trim() || resolveDefaultRawKey();
  let client = cachedTtsClients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        apiVersion: 'v1beta',
      },
    });
    cachedTtsClients.set(apiKey, client);
  }
  return client;
}

