import type { GoogleGenAI } from '@google/genai';
import {
  getGeminiClient,
  getGeminiTtsClient,
  getQueues,
  requestCounts,
} from '../config.ts';
import {
  createOrReuseJob,
  findDoneJobByHash,
  getResilientQueueStatus,
  getRetryNowNonce,
  markJobDone,
  markJobFailed,
  markJobRunning,
  markJobWaiting,
  waitInterruptiblyUntil,
  waitWhilePaused,
} from './jobQueue.ts';
import {
  areAllKeysInvalid,
  classifyGeminiError,
  getEarliestWakeTimeMs,
  getLoadedKeys,
  getNextMidnightPacificDate,
  markKeyCooldown,
  markKeyExhaustedDaily,
  markKeyInvalid,
  pickKeyForModel,
  recordKeyModelRequest,
  redactSecrets,
} from './keyPool.ts';

export const DEFAULT_GEMINI_TIMEOUT_MS = 120_000;
export const NETWORK_BACKOFF_SCHEDULE_MS = [5_000, 15_000, 30_000, 60_000] as const;

export type ConnectivityCheckerFn = () => Promise<boolean>;

async function defaultCheckGeminiConnectivity(): Promise<boolean> {
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta',
      {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      },
    );
    // Any HTTP status code proves DNS + TLS + server reachability without consuming API quota
    return res.status > 0;
  } catch {
    return false;
  }
}

let activeConnectivityChecker: ConnectivityCheckerFn = defaultCheckGeminiConnectivity;

export function setConnectivityChecker(fn?: ConnectivityCheckerFn): void {
  activeConnectivityChecker = fn ?? defaultCheckGeminiConnectivity;
}

export async function checkGeminiConnectivity(): Promise<boolean> {
  return activeConnectivityChecker();
}

function formatResetTimeLabel(targetMs: number): string {
  const diffSec = Math.max(1, Math.round((targetMs - Date.now()) / 1000));
  if (diffSec < 300) {
    return `${diffSec} စက္ကန့်`;
  }
  try {
    const ptStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(targetMs));
    return `${ptStr} PT`;
  } catch {
    return new Date(targetMs).toISOString();
  }
}

const blacklistedModels = new Set<string>();

export function blacklistModelForSession(modelId: string): void {
  const clean = modelId.replace(/^models\//, '').trim();
  if (clean) {
    blacklistedModels.add(clean);
  }
}

export function isModelBlacklistedForSession(modelId: string): boolean {
  const clean = modelId.replace(/^models\//, '').trim();
  return blacklistedModels.has(clean);
}

export function getBlacklistedModelsForSession(): string[] {
  return Array.from(blacklistedModels);
}

function dedupeModels(primaryModel: string, fallbackModels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [primaryModel, ...fallbackModels]) {
    const clean = m.replace(/^models\//, '').trim();
    if (!clean || seen.has(clean) || isModelBlacklistedForSession(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export interface ResilientGeminiCallParams<T> {
  projectId: string;
  kind: string;
  label: string;
  hash: string;
  queueName: 'geminiText' | 'geminiTranscribe' | 'geminiTts';
  primaryModel: string;
  fallbackModels: string[];
  clientMode?: 'standard' | 'tts';
  interactive?: boolean;
  recordJob?: boolean;
  force?: boolean;
  attemptTimeoutMs?: number;
  maxNetworkWaitAttempts?: number;
  maxQuotaWaitAttempts?: number;
  onWaiting?: (info: {
    reason: 'network' | 'quota' | 'paused';
    message: string;
    nextRetryAt?: string;
    resetAt?: string;
  }) => void;
  /**
   * Called after Gemini returns a valid result, BEFORE marking the job `done` in DATA_DIR/jobs.json.
   * Should persist outputs/cache/project state atomically to disk.
   */
  onResult?: (result: T, meta: { model: string; keyId: string }) => Promise<void> | void;
  call: (ctx: {
    ai: GoogleGenAI;
    modelId: string;
    keyId: string;
    apiKeyMasked: string;
    signal?: AbortSignal;
  }) => Promise<T>;
}

export interface ResilientGeminiCallResult<T> {
  result: T;
  model: string;
  keyId: string;
}

export async function executeResilientGeminiCall<T>(
  params: ResilientGeminiCallParams<T>,
): Promise<ResilientGeminiCallResult<T>> {
  const {
    projectId,
    kind,
    label,
    hash,
    queueName,
    primaryModel,
    fallbackModels,
    clientMode = 'standard',
    interactive = false,
    recordJob = true,
    force = false,
    attemptTimeoutMs = DEFAULT_GEMINI_TIMEOUT_MS,
    maxNetworkWaitAttempts,
    maxQuotaWaitAttempts,
    onWaiting,
    onResult,
    call,
  } = params;

  const modelsToTry = dedupeModels(primaryModel, fallbackModels);
  if (modelsToTry.length === 0) {
    throw new Error('No Gemini model configured for request.');
  }

  const loaded = getLoadedKeys();
  if (loaded.length === 0) {
    throw new Error(
      'No Gemini API keys configured (set GEMINI_API_KEYS, GEMINI_API_KEY_1..5, or GEMINI_API_KEY).',
    );
  }

  const queues = getQueues();
  const job = recordJob
    ? await createOrReuseJob({ projectId, kind, label, hash, force })
    : null;
  const jobId = job?.id;

  let networkAttempt = 0;
  let quotaWaitCount = 0;

  while (true) {
    if (recordJob) {
      await waitWhilePaused(jobId);
    }

    if (areAllKeysInvalid()) {
      const msg =
        'Gemini API key များအားလုံး မမှန်ကန်ပါ (401/403)။ Settings → Keys panel တွင် စစ်ဆေးပါ။';
      if (jobId) {
        await markJobFailed(jobId, msg);
      }
      throw new Error(msg);
    }

    let sawNetworkError = false;
    let sawTimeoutError = false;
    let lastNetworkErrorMsg = '';
    const modelErrors: string[] = [];
    let allModelErrorsOnly = true;

    const activeModelsToTry = modelsToTry.filter((m) => !isModelBlacklistedForSession(m));
    if (activeModelsToTry.length === 0) {
      const msg = `All configured models have been blacklisted (404 NOT_FOUND): ${modelsToTry.join(', ')}`;
      if (jobId) {
        await markJobFailed(jobId, msg);
      }
      throw new Error(msg);
    }

    for (let mIdx = 0; mIdx < activeModelsToTry.length; mIdx += 1) {
      const modelId = activeModelsToTry[mIdx];
      if (isModelBlacklistedForSession(modelId)) {
        continue;
      }

      const triedKeyIdsThisModel = new Set<string>();

      while (true) {
        if (recordJob) {
          await waitWhilePaused(jobId);
        }

        const key = pickKeyForModel(modelId);
        if (!key || triedKeyIdsThisModel.has(key.id)) {
          // No unblocked key available for this model right now -> fall back to next model
          allModelErrorsOnly = false;
          if (mIdx + 1 < activeModelsToTry.length) {
            console.warn(
              `[KeyPool] All keys in cooldown/exhausted for ${modelId}; falling back to next priority model ${activeModelsToTry[mIdx + 1]}.`,
            );
          }
          break;
        }
        triedKeyIdsThisModel.add(key.id);

        if (jobId) {
          await markJobRunning(jobId, modelId, key.id);
        }

        const ai =
          clientMode === 'tts'
            ? getGeminiTtsClient(key.rawKey)
            : getGeminiClient(key.rawKey);

        try {
          const result = await queues[queueName].add(async () => {
            requestCounts[queueName] += 1;
            recordKeyModelRequest(key.id, modelId);
            const effTimeoutMs = Math.max(DEFAULT_GEMINI_TIMEOUT_MS, attemptTimeoutMs);
            const abortController = new AbortController();
            let timer: ReturnType<typeof setTimeout> | null = null;
            try {
              return await Promise.race([
                call({
                  ai,
                  modelId,
                  keyId: key.id,
                  apiKeyMasked: key.masked,
                  signal: abortController.signal,
                }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    const timeoutErr = new Error(
                      `Gemini request timeout after ${Math.round(effTimeoutMs / 1000)}s (key=${key.masked}, model=${modelId})`,
                    );
                    abortController.abort(timeoutErr);
                    reject(timeoutErr);
                  }, effTimeoutMs);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          });

          // Reset network attempt counter after any successful response
          networkAttempt = 0;
          console.log(
            `[KeyPool] Request succeeded: key=${key.masked} (${key.id}) model=${modelId} label="${label}"`,
          );

          // Persist outputs to disk BEFORE marking job `done`
          if (onResult) {
            await onResult(result as T, { model: modelId, keyId: key.id });
          }

          if (jobId) {
            await markJobDone(jobId, modelId, key.id);
          }

          return {
            result: result as T,
            model: modelId,
            keyId: key.id,
          };
        } catch (err) {
          const classified = classifyGeminiError(err);

          if (classified.category === 'invalid_key') {
            allModelErrorsOnly = false;
            markKeyInvalid(key.id, classified.sanitizedMessage);
            console.warn(
              `[KeyPool] Rotating key: ${key.masked} (${key.id}) returned ${classified.httpStatus ?? 403}; marked invalid.`,
            );
            continue;
          }

          if (classified.category === 'rate_limit_minute') {
            allModelErrorsOnly = false;
            const delaySec = Math.max(60, classified.retryDelaySec ?? 60);
            markKeyCooldown(key.id, modelId, delaySec * 1000);
            console.warn(
              `[KeyPool] Rotating key: ${classified.httpStatus ?? 429} on ${key.masked} (${key.id}) model=${modelId}; cooldown=${delaySec}s -> trying next API key.`,
            );
            continue;
          }

          if (classified.category === 'rate_limit_daily') {
            allModelErrorsOnly = false;
            markKeyExhaustedDaily(key.id, modelId);
            console.warn(
              `[KeyPool] Rotating key: 429 PerDay exhausted for ${key.masked} (${key.id}) on ${modelId} until next PT midnight -> trying next API key.`,
            );
            continue;
          }

          if (classified.category === 'model_error') {
            blacklistModelForSession(modelId);
            modelErrors.push(`[${modelId}] ${classified.sanitizedMessage}`);
            console.warn(
              `[KeyPool] 404 NOT_FOUND on key=${key.masked} (${key.id}) model=${modelId}; permanently blacklisted for session -> switching immediately to ${activeModelsToTry[mIdx + 1] ?? 'next available'} without retrying.`,
            );
            break; // immediately switch to next valid model without retrying this dead model
          }

          const isAttemptTimeout =
            /Gemini request timeout after \d+s/i.test(classified.sanitizedMessage) ||
            (classified.category === 'network' &&
              /timed out|timeout|ETIMEDOUT/i.test(classified.sanitizedMessage));

          if (isAttemptTimeout) {
            allModelErrorsOnly = false;
            sawTimeoutError = true;
            lastNetworkErrorMsg = classified.sanitizedMessage;
            markKeyCooldown(key.id, modelId, 20_000);
            console.warn(
              `[KeyPool] Rotating key: request timed out on ${key.masked} (${key.id}) model=${modelId}; cooldown=20s -> trying next API key/model.`,
            );
            continue;
          }

          if (classified.category === 'network') {
            allModelErrorsOnly = false;
            sawNetworkError = true;
            lastNetworkErrorMsg = classified.sanitizedMessage;
            break; // handle network waiting loop cleanly
          }

          // Fatal application error (e.g., invalid schema/request bug)
          if (jobId) {
            await markJobFailed(jobId, classified.sanitizedMessage);
          }
          throw new Error(classified.sanitizedMessage);
        }
      }

      if (sawNetworkError) {
        break;
      }
    }

    if (areAllKeysInvalid()) {
      const msg =
        'Gemini API key များအားလုံး မမှန်ကန်ပါ (401/403)။ Settings → Keys panel တွင် စစ်ဆေးပါ။';
      if (jobId) {
        await markJobFailed(jobId, msg);
      }
      throw new Error(msg);
    }

    if (sawNetworkError || sawTimeoutError) {
      if (interactive) {
        throw new Error(
          `လိုင်းကျနေပါတယ်၊ ပြန်ကြိုးစားနေပါတယ် (${redactSecrets(lastNetworkErrorMsg)})`,
        );
      }
      if (
        typeof maxNetworkWaitAttempts === 'number' &&
        networkAttempt >= maxNetworkWaitAttempts
      ) {
        const netMsg = `API network/timeout error after ${networkAttempt + 1} wait cycles: ${redactSecrets(lastNetworkErrorMsg)}`;
        if (jobId) {
          await markJobFailed(jobId, netMsg);
        }
        throw new Error(netMsg);
      }

      // Network wait + connectivity check loop: 5s -> 15s -> 30s -> 60s
      while (true) {
        if (
          typeof maxNetworkWaitAttempts === 'number' &&
          networkAttempt >= maxNetworkWaitAttempts
        ) {
          const netMsg = `API network/timeout error after ${networkAttempt + 1} retries: ${redactSecrets(lastNetworkErrorMsg)}`;
          if (jobId) {
            await markJobFailed(jobId, netMsg);
          }
          throw new Error(netMsg);
        }

        const delayMs =
          NETWORK_BACKOFF_SCHEDULE_MS[
            Math.min(networkAttempt, NETWORK_BACKOFF_SCHEDULE_MS.length - 1)
          ];
        const nextRetryIso = new Date(Date.now() + delayMs).toISOString();
        const msg = 'လိုင်းကျနေပါတယ်၊ ပြန်ကြိုးစားနေပါတယ်';
        if (jobId) {
          await markJobWaiting({
            jobId,
            waitingReason: 'network',
            waitingMessage: msg,
            nextRetryAt: nextRetryIso,
            error: lastNetworkErrorMsg,
          });
        }
        onWaiting?.({
          reason: 'network',
          message: msg,
          nextRetryAt: nextRetryIso,
        });

        const nonce = getRetryNowNonce();
        const wakeReason = await waitInterruptiblyUntil(Date.now() + delayMs, nonce, jobId);

        if (wakeReason === 'retry_now') {
          networkAttempt = 0;
        } else {
          networkAttempt += 1;
        }

        const online = await checkGeminiConnectivity();
        if (online || wakeReason === 'retry_now') {
          break;
        }
      }
      continue;
    }

    if (allModelErrorsOnly && modelErrors.length > 0) {
      const combinedModelError = `Model call failed (${modelsToTry.join(', ')}):\n${modelErrors.join('\n')}`;
      console.error(`[KeyPool] All configured models failed: ${combinedModelError}`);
      if (jobId) {
        await markJobFailed(jobId, combinedModelError);
      }
      throw new Error(combinedModelError);
    }

    // All valid keys across primary + fallback models are currently in cooldown or exhausted until reset
    const wakeAtMs = getEarliestWakeTimeMs(modelsToTry);
    const wakeIso = new Date(wakeAtMs).toISOString();
    const resetIso = getNextMidnightPacificDate().toISOString();
    const timeLabel = formatResetTimeLabel(wakeAtMs);
    const quotaWaitMsg = `key အားလုံး quota ပြည့်နေပါတယ်၊ ${timeLabel} မှာ ပြန်စပါမယ်`;

    if (interactive) {
      throw new Error(`${quotaWaitMsg} (waiting for quota)`);
    }

    if (typeof maxQuotaWaitAttempts === 'number' && quotaWaitCount >= maxQuotaWaitAttempts) {
      const qMsg = `API quota / rate limit exceeded across all configured keys (${timeLabel} reset)`;
      if (jobId) {
        await markJobFailed(jobId, qMsg);
      }
      throw new Error(qMsg);
    }
    quotaWaitCount += 1;

    if (jobId) {
      await markJobWaiting({
        jobId,
        waitingReason: 'quota',
        waitingMessage: quotaWaitMsg,
        nextRetryAt: wakeIso,
        resetAt: resetIso,
      });
    }
    onWaiting?.({
      reason: 'quota',
      message: quotaWaitMsg,
      nextRetryAt: wakeIso,
      resetAt: resetIso,
    });

    const nonce = getRetryNowNonce();
    await waitInterruptiblyUntil(wakeAtMs, nonce, jobId);
  }
}

export async function runTrackedStepJob<T>(params: {
  projectId: string;
  kind: string;
  label: string;
  hash: string;
  force?: boolean;
  canSkipIfDone?: () => Promise<boolean> | boolean;
  skipResult: () => Promise<T> | T;
  run: () => Promise<T>;
}): Promise<T> {
  const { projectId, kind, label, hash, force = false, canSkipIfDone, skipResult, run } = params;

  if (!force) {
    const doneJob = findDoneJobByHash(projectId, kind, hash);
    if (doneJob) {
      const okToSkip = canSkipIfDone ? await canSkipIfDone() : true;
      if (okToSkip) {
        return await skipResult();
      }
    }
  }

  const job = await createOrReuseJob({ projectId, kind, label, hash, force });
  await waitWhilePaused(job.id);
  await markJobRunning(job.id);
  try {
    const out = await run();
    await markJobDone(job.id);
    return out;
  } catch (err) {
    const sanitized = redactSecrets(err instanceof Error ? err.message : String(err));
    await markJobFailed(job.id, sanitized);
    throw err;
  }
}

export function getResilientSnapshot() {
  return getResilientQueueStatus();
}
