import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ApiKeySummary,
  KeyModelUsage,
  KeyPoolState,
} from '../../shared/projectTypes.ts';

export interface LoadedApiKey {
  id: string;
  index: number; // 1-based (1..5)
  source: string;
  rawKey: string;
  masked: string;
  fingerprint: string;
}

interface StoredModelMetrics {
  requests_today: number;
  last_429?: string;
  cooldown_until?: string;
  exhausted_until?: string;
}

interface StoredKeyRecord {
  invalid: boolean;
  invalid_reason?: string;
  models: Record<string, StoredModelMetrics>;
}

interface KeyUsageFile {
  version: number;
  ptDate: string;
  keys: Record<string, StoredKeyRecord>;
}

export type GeminiErrorCategory =
  | 'invalid_key'
  | 'rate_limit_minute'
  | 'rate_limit_daily'
  | 'model_error'
  | 'network'
  | 'fatal';

export interface ClassifiedGeminiError {
  category: GeminiErrorCategory;
  httpStatus?: number;
  retryDelaySec?: number;
  sanitizedMessage: string;
}

const MAX_POOL_KEYS = 5;

let currentDataDir = path.resolve(
  process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
);
let loadedKeys: LoadedApiKey[] = [];
let roundRobinCursor = 0;
let usageState: KeyUsageFile = {
  version: 1,
  ptDate: getPacificDateStr(),
  keys: {},
};
let usageWriteLock: Promise<void> = Promise.resolve();
let onStateChangeCallback: (() => void) | null = null;

export function setKeyPoolChangeListener(cb: (() => void) | null): void {
  onStateChangeCallback = cb;
}

function notifyPoolChange(): void {
  if (onStateChangeCallback) {
    try {
      onStateChangeCallback();
    } catch {
      // non-fatal
    }
  }
}

export function maskApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

function hashFingerprint(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const k of loadedKeys) {
    if (k.rawKey) {
      out = out.split(k.rawKey).join(k.masked);
      const encoded = encodeURIComponent(k.rawKey);
      if (encoded && encoded !== k.rawKey) {
        out = out.split(encoded).join(k.masked);
      }
    }
  }
  // Catch any other Google API key pattern just in case
  out = out.replace(/AIza[0-9A-Za-z_-]{15,}/g, '••••[REDACTED]');
  return out;
}

function getPacificParts(date: Date): {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

export function getPacificDateStr(date = new Date()): string {
  const p = getPacificParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function getNextMidnightPacificDate(now = new Date()): Date {
  const cur = getPacificParts(now);
  const elapsedSec = cur.hour * 3600 + cur.minute * 60 + cur.second;
  let candidateMs =
    Math.floor(now.getTime() / 1000) * 1000 + Math.max(1, 86400 - elapsedSec) * 1000;

  // Converge accurately across DST transitions
  for (let i = 0; i < 3; i++) {
    const p = getPacificParts(new Date(candidateMs));
    if (p.hour === 0 && p.minute === 0 && p.second === 0) {
      break;
    }
    const diffHours = p.hour >= 12 ? 24 - p.hour : -p.hour;
    candidateMs += diffHours * 3600_000 - p.minute * 60_000 - p.second * 1000;
  }

  if (candidateMs <= now.getTime()) {
    candidateMs += 86400 * 1000;
  }
  return new Date(candidateMs);
}

export function resolveKeysFromEnv(env: NodeJS.ProcessEnv = process.env): LoadedApiKey[] {
  const rawList: Array<{ raw: string; source: string }> = [];

  const commaKeys = env.GEMINI_API_KEYS?.trim();
  if (commaKeys) {
    const parts = commaKeys
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    parts.forEach((raw, idx) => {
      rawList.push({ raw, source: `GEMINI_API_KEYS[${idx + 1}]` });
    });
  } else {
    for (let i = 1; i <= MAX_POOL_KEYS; i++) {
      const val = env[`GEMINI_API_KEY_${i}`]?.trim();
      if (val) {
        rawList.push({ raw: val, source: `GEMINI_API_KEY_${i}` });
      }
    }
    if (rawList.length === 0) {
      const single = env.GEMINI_API_KEY?.trim();
      if (single) {
        rawList.push({ raw: single, source: 'GEMINI_API_KEY' });
      }
    }
  }

  const seen = new Set<string>();
  const resolved: LoadedApiKey[] = [];
  for (const item of rawList) {
    if (seen.has(item.raw)) continue;
    seen.add(item.raw);
    const index = resolved.length + 1;
    resolved.push({
      id: `key_${index}`,
      index,
      source: item.source,
      rawKey: item.raw,
      masked: maskApiKey(item.raw),
      fingerprint: hashFingerprint(item.raw),
    });
    if (resolved.length >= MAX_POOL_KEYS) break;
  }
  return resolved;
}

function getUsageFilePath(): string {
  return path.join(currentDataDir, 'key_usage.json');
}

async function persistUsageState(): Promise<void> {
  const target = getUsageFilePath();
  const payload = JSON.stringify(usageState, null, 2) + '\n';
  const prev = usageWriteLock;
  let release!: () => void;
  usageWriteLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, payload, 'utf-8');
    await fs.rename(tmp, target);
  } catch (err) {
    console.warn('[KeyPool] Failed saving key_usage.json:', err instanceof Error ? err.message : err);
  } finally {
    release();
  }
}

function ensureKeyRecord(fingerprint: string): StoredKeyRecord {
  if (!usageState.keys[fingerprint]) {
    usageState.keys[fingerprint] = {
      invalid: false,
      models: {},
    };
  }
  return usageState.keys[fingerprint];
}

function ensureModelRecord(fingerprint: string, modelId: string): StoredModelMetrics {
  const keyRec = ensureKeyRecord(fingerprint);
  if (!keyRec.models[modelId]) {
    keyRec.models[modelId] = {
      requests_today: 0,
    };
  }
  return keyRec.models[modelId];
}

function normalizeExpirations(nowMs = Date.now()): boolean {
  let changed = false;
  const todayPt = getPacificDateStr(new Date(nowMs));
  if (usageState.ptDate !== todayPt) {
    usageState.ptDate = todayPt;
    for (const rec of Object.values(usageState.keys)) {
      for (const m of Object.values(rec.models)) {
        m.requests_today = 0;
        delete m.last_429;
        delete m.cooldown_until;
        delete m.exhausted_until;
      }
    }
    changed = true;
  }

  for (const rec of Object.values(usageState.keys)) {
    for (const m of Object.values(rec.models)) {
      if (m.cooldown_until) {
        const ts = Date.parse(m.cooldown_until);
        if (!Number.isFinite(ts) || ts <= nowMs) {
          delete m.cooldown_until;
          changed = true;
        }
      }
      if (m.exhausted_until) {
        const ts = Date.parse(m.exhausted_until);
        if (!Number.isFinite(ts) || ts <= nowMs) {
          delete m.exhausted_until;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export async function initKeyPoolAtStartup(dataDir?: string): Promise<LoadedApiKey[]> {
  if (dataDir) {
    currentDataDir = path.resolve(dataDir);
  } else {
    currentDataDir = path.resolve(
      process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
    );
  }

  loadedKeys = resolveKeysFromEnv(process.env);
  roundRobinCursor = 0;
  const todayPt = getPacificDateStr();
  usageState = {
    version: 1,
    ptDate: todayPt,
    keys: {},
  };

  try {
    const raw = await fs.readFile(getUsageFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as KeyUsageFile;
    if (parsed && typeof parsed === 'object' && parsed.keys) {
      usageState = {
        version: 1,
        ptDate: parsed.ptDate || todayPt,
        keys: parsed.keys,
      };
    }
  } catch {
    // First boot or no existing file
  }

  for (const k of loadedKeys) {
    const rec = ensureKeyRecord(k.fingerprint);
    // Clear prior invalid flags on fresh server start so replaced/re-enabled keys are tested cleanly
    rec.invalid = false;
    delete rec.invalid_reason;
  }

  normalizeExpirations();
  await persistUsageState();
  return [...loadedKeys];
}

export function getLoadedKeys(): LoadedApiKey[] {
  return [...loadedKeys];
}

export function getLoadedKeyById(keyId: string): LoadedApiKey | undefined {
  return loadedKeys.find((k) => k.id === keyId);
}

export function pickKeyForModel(modelId: string, nowMs = Date.now()): LoadedApiKey | null {
  const changed = normalizeExpirations(nowMs);
  if (changed) {
    void persistUsageState();
  }

  const total = loadedKeys.length;
  if (total === 0) return null;

  const start = roundRobinCursor % total;
  for (let offset = 0; offset < total; offset += 1) {
    const idx = (start + offset) % total;
    const key = loadedKeys[idx];
    const rec = ensureKeyRecord(key.fingerprint);
    if (rec.invalid) continue;
    const m = rec.models[modelId];
    if (m) {
      const coolUntil = m.cooldown_until ? Date.parse(m.cooldown_until) : 0;
      const exUntil = m.exhausted_until ? Date.parse(m.exhausted_until) : 0;
      if (coolUntil > nowMs || exUntil > nowMs) {
        continue;
      }
    }
    roundRobinCursor = (idx + 1) % total;
    return key;
  }
  return null;
}

export function pickFirstValidKey(): LoadedApiKey | null {
  for (const key of loadedKeys) {
    const rec = ensureKeyRecord(key.fingerprint);
    if (!rec.invalid) return key;
  }
  return null;
}

export function areAllKeysInvalid(): boolean {
  if (loadedKeys.length === 0) return false;
  return loadedKeys.every((k) => Boolean(ensureKeyRecord(k.fingerprint).invalid));
}

export function recordKeyModelRequest(keyId: string, modelId: string): void {
  const key = getLoadedKeyById(keyId);
  if (!key) return;
  normalizeExpirations();
  const m = ensureModelRecord(key.fingerprint, modelId);
  m.requests_today += 1;
  void persistUsageState();
  notifyPoolChange();
}

export function markKeyCooldown(keyId: string, modelId: string, durationMs: number): string {
  const key = getLoadedKeyById(keyId);
  const untilIso = new Date(Date.now() + Math.max(5_000, durationMs)).toISOString();
  if (!key) return untilIso;
  normalizeExpirations();
  const m = ensureModelRecord(key.fingerprint, modelId);
  const nowIso = new Date().toISOString();
  m.last_429 = nowIso;
  m.cooldown_until = untilIso;
  void persistUsageState();
  notifyPoolChange();
  return untilIso;
}

export function markKeyExhaustedDaily(keyId: string, modelId: string): string {
  const key = getLoadedKeyById(keyId);
  const resetIso = getNextMidnightPacificDate().toISOString();
  if (!key) return resetIso;
  normalizeExpirations();
  const m = ensureModelRecord(key.fingerprint, modelId);
  m.last_429 = new Date().toISOString();
  m.exhausted_until = resetIso;
  delete m.cooldown_until;
  void persistUsageState();
  notifyPoolChange();
  return resetIso;
}

export function markKeyInvalid(keyId: string, reason: string): void {
  const key = getLoadedKeyById(keyId);
  if (!key) return;
  const rec = ensureKeyRecord(key.fingerprint);
  rec.invalid = true;
  rec.invalid_reason = redactSecrets(reason);
  void persistUsageState();
  notifyPoolChange();
}

export function clearExpiredOrCooldownForRetryNow(): void {
  const now = Date.now();
  let changed = normalizeExpirations(now);
  for (const key of loadedKeys) {
    const rec = ensureKeyRecord(key.fingerprint);
    for (const m of Object.values(rec.models)) {
      if (m.cooldown_until) {
        delete m.cooldown_until;
        changed = true;
      }
    }
  }
  if (changed) {
    void persistUsageState();
    notifyPoolChange();
  }
}

export function getEarliestWakeTimeMs(modelsToTry: string[], nowMs = Date.now()): number {
  normalizeExpirations(nowMs);
  const fallbackResetMs = getNextMidnightPacificDate(new Date(nowMs)).getTime();
  let earliest = Infinity;

  for (const key of loadedKeys) {
    const rec = ensureKeyRecord(key.fingerprint);
    if (rec.invalid) continue;
    for (const modelId of modelsToTry) {
      const m = rec.models[modelId];
      if (!m) {
        return nowMs;
      }
      const cool = m.cooldown_until ? Date.parse(m.cooldown_until) : 0;
      const ex = m.exhausted_until ? Date.parse(m.exhausted_until) : 0;
      const blockedUntil = Math.max(cool, ex);
      if (blockedUntil <= nowMs) {
        return nowMs;
      }
      if (blockedUntil < earliest) {
        earliest = blockedUntil;
      }
    }
  }

  return Number.isFinite(earliest) ? earliest : fallbackResetMs;
}

export function getPublicKeySummaries(nowMs = Date.now()): {
  keys: ApiKeySummary[];
  ptDate: string;
  nextResetAtPt: string;
  allKeysInvalid: boolean;
} {
  const changed = normalizeExpirations(nowMs);
  if (changed) {
    void persistUsageState();
  }

  const nextResetAtPt = getNextMidnightPacificDate(new Date(nowMs)).toISOString();
  const keys: ApiKeySummary[] = loadedKeys.map((k) => {
    const rec = ensureKeyRecord(k.fingerprint);
    const modelsOut: Record<string, KeyModelUsage> = {};
    let totalReq = 0;
    let hasOkModel = false;
    let hasCooldownModel = false;
    let hasExhaustedModel = false;

    for (const [modelId, m] of Object.entries(rec.models)) {
      totalReq += m.requests_today || 0;
      const cool = m.cooldown_until ? Date.parse(m.cooldown_until) : 0;
      const ex = m.exhausted_until ? Date.parse(m.exhausted_until) : 0;
      const mState: 'ok' | 'cooldown' | 'exhausted' =
        ex > nowMs ? 'exhausted' : cool > nowMs ? 'cooldown' : 'ok';

      if (mState === 'ok') hasOkModel = true;
      else if (mState === 'cooldown') hasCooldownModel = true;
      else hasExhaustedModel = true;

      modelsOut[modelId] = {
        model: modelId,
        requests_today: m.requests_today || 0,
        last_429: m.last_429,
        cooldown_until: m.cooldown_until,
        exhausted_until: m.exhausted_until,
        state: mState,
      };
    }

    let summaryState: KeyPoolState = 'ok';
    if (rec.invalid) {
      summaryState = 'invalid';
    } else if (Object.keys(modelsOut).length > 0 && !hasOkModel) {
      summaryState = hasCooldownModel ? 'cooldown' : hasExhaustedModel ? 'exhausted' : 'ok';
    }

    return {
      id: k.id,
      index: k.index,
      source: k.source,
      masked: k.masked,
      state: summaryState,
      invalid: rec.invalid,
      invalid_reason: rec.invalid_reason,
      models: modelsOut,
      total_requests_today: totalReq,
    };
  });

  return {
    keys,
    ptDate: usageState.ptDate,
    nextResetAtPt,
    allKeysInvalid: areAllKeysInvalid(),
  };
}

export function classifyGeminiError(err: unknown): ClassifiedGeminiError {
  const rawObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  const rawMsg = err instanceof Error ? err.message : String(err);
  const sanitizedMessage = redactSecrets(rawMsg);

  const codeProp = rawObj?.code ? String(rawObj.code) : '';
  const statusProp =
    typeof rawObj?.status === 'number'
      ? rawObj.status
      : typeof rawObj?.statusCode === 'number'
        ? rawObj.statusCode
        : undefined;

  let detectedStatus = statusProp;
  if (!detectedStatus) {
    const codeMatch = /\b(400|401|403|404|429|500|502|503|504)\b/.exec(sanitizedMessage);
    if (codeMatch) {
      detectedStatus = Number(codeMatch[1]);
    }
  }

  // 1. Invalid key / auth failures (401 / 403 / API_KEY_INVALID)
  if (
    detectedStatus === 401 ||
    detectedStatus === 403 ||
    /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|UNAUTHENTICATED/i.test(
      sanitizedMessage,
    )
  ) {
    return {
      category: 'invalid_key',
      httpStatus: detectedStatus ?? 403,
      sanitizedMessage,
    };
  }

  // 2. Rate limits / quota exhaustion / 503 high-demand (429 RESOURCE_EXHAUSTED or 503 UNAVAILABLE)
  const is503 =
    detectedStatus === 503 ||
    /SERVICE UNAVAILABLE|\bUNAVAILABLE\b|high demand|overloaded/i.test(sanitizedMessage);

  if (
    detectedStatus === 429 ||
    is503 ||
    /RESOURCE_EXHAUSTED|quota exceeded|rate.?limit|too many requests/i.test(sanitizedMessage)
  ) {
    const isDaily =
      !is503 &&
      /PerDay|RequestsPerDay|GenerateRequestsPerDay|DayPerProject|\bdaily\b/i.test(
        sanitizedMessage,
      );
    if (isDaily) {
      return {
        category: 'rate_limit_daily',
        httpStatus: 429,
        sanitizedMessage,
      };
    }

    let retryDelaySec = 60;
    const delayJsonMatch = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(sanitizedMessage);
    const delayTextMatch = /retry(?:\s+in|\s+after)?\s+(\d+(?:\.\d+)?)\s*s/i.exec(sanitizedMessage);
    const matchedNum = delayJsonMatch?.[1] ?? delayTextMatch?.[1];
    if (matchedNum) {
      const parsed = Math.ceil(Number.parseFloat(matchedNum));
      if (Number.isFinite(parsed) && parsed > 0) {
        retryDelaySec = Math.min(600, Math.max(60, parsed));
      }
    }

    return {
      category: 'rate_limit_minute',
      httpStatus: detectedStatus ?? (is503 ? 503 : 429),
      retryDelaySec,
      sanitizedMessage,
    };
  }

  // 3. Model not found / unsupported (404)
  if (
    detectedStatus === 404 ||
    /NOT_FOUND|is not found for API version|not supported for generateContent|does not support the requested/i.test(
      sanitizedMessage,
    )
  ) {
    return {
      category: 'model_error',
      httpStatus: detectedStatus ?? 404,
      sanitizedMessage,
    };
  }

  // 4. Network / transient errors (never fail the project)
  const netCodePattern = /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_.*)$/i;
  if (
    netCodePattern.test(codeProp) ||
    detectedStatus === 500 ||
    detectedStatus === 502 ||
    detectedStatus === 504 ||
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|DNS|socket hang up|network|timed out|timeout|INTERNAL|BAD GATEWAY/i.test(
      sanitizedMessage,
    )
  ) {
    return {
      category: 'network',
      httpStatus: detectedStatus,
      sanitizedMessage,
    };
  }

  return {
    category: 'fatal',
    httpStatus: detectedStatus,
    sanitizedMessage,
  };
}
