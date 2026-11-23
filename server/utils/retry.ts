import { redactSecrets } from '../gemini/keyPool.ts';

export interface ExponentialBackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  factor?: number;
  label: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: unknown;
    friendlyReason: string;
  }) => Promise<void> | void;
}

export function isNonRetryableAuthOrConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /401|403|invalid api key|API_KEY_INVALID|မမှန်ကန်ပါ|No Gemini API keys configured|No Gemini model configured|not found\.\s*$/i.test(
      msg,
    ) && !/timeout|timed out|429|quota|network/i.test(msg)
  );
}

export function describeFriendlyApiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = redactSecrets(raw).replace(/\s+/g, ' ').trim();
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(msg)) {
    return 'API timeout';
  }
  if (/429|quota|RESOURCE_EXHAUSTED|rate limit|cooling down/i.test(msg)) {
    return 'API quota or rate limit exceeded';
  }
  if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|fetch failed|network|socket|WebSocket|လိုင်းကျ/i.test(msg)) {
    return 'network connection error';
  }
  if (/401|403|API_KEY_INVALID|invalid.*key|မမှန်ကန်ပါ/i.test(msg)) {
    return 'invalid Gemini API key';
  }
  if (/Edge TTS|edge-tts/i.test(msg)) {
    return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
  }
  if (!msg) return 'unexpected API error';
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}

export function formatChunkFailureMessage(chunkIndexZeroBased: number, err: unknown): string {
  const reason = describeFriendlyApiError(err);
  return `Chunk ${chunkIndexZeroBased + 1} failed due to ${reason}. Click Resume to try again.`;
}

export async function withExponentialBackoffRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: ExponentialBackoffOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(100, options.baseDelayMs ?? 1000);
  const factor = Math.max(1, options.factor ?? 2);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry =
        attempt < maxAttempts &&
        (options.shouldRetry ? options.shouldRetry(err, attempt) : !isNonRetryableAuthOrConfigError(err));
      if (!canRetry) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const delayMs = Math.round(baseDelayMs * Math.pow(factor, attempt - 1));
      const friendlyReason = describeFriendlyApiError(err);
      console.warn(
        `[Retry] ${options.label} failed on attempt ${attempt}/${maxAttempts} (${friendlyReason}); retrying in ${delayMs}ms...`,
      );
      if (options.onRetry) {
        try {
          await options.onRetry({
            attempt,
            maxAttempts,
            delayMs,
            error: err,
            friendlyReason,
          });
        } catch {
          // Non-fatal retry hook failure
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
