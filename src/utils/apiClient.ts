export type ServerHealthPhase = 'ok' | 'starting' | 'failed';

export interface ServerHealthStatus {
  phase: ServerHealthPhase;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  serverLogLines: string[];
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 2000;

let currentStatus: ServerHealthStatus = {
  phase: 'ok',
  attempt: 0,
  maxAttempts: MAX_RETRIES,
  error: null,
  serverLogLines: [],
};

const listeners = new Set<(status: ServerHealthStatus) => void>();
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let inFlightHealthPoll: Promise<boolean> | null = null;

function setServerHealthStatus(next: ServerHealthStatus) {
  currentStatus = next;
  if (next.phase === 'failed') {
    if (!recoveryTimer && typeof window !== 'undefined') {
      recoveryTimer = setInterval(() => {
        void checkHealthOnce().then((res) => {
          if (res.ok) {
            setServerHealthStatus({
              phase: 'ok',
              attempt: 0,
              maxAttempts: MAX_RETRIES,
              error: null,
              serverLogLines: [],
            });
          }
        });
      }, RETRY_INTERVAL_MS);
    }
  } else if (next.phase === 'ok' && recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  for (const fn of listeners) {
    fn(currentStatus);
  }
}

export function getServerHealthStatus(): ServerHealthStatus {
  return currentStatus;
}

export function subscribeServerHealth(listener: (status: ServerHealthStatus) => void): () => void {
  listeners.add(listener);
  listener(currentStatus);
  return () => {
    listeners.delete(listener);
  };
}

export class ServerStartupError extends Error {
  readonly code = 'SERVER_STARTUP_FAILED';
  constructor(message = 'Server startup error: /api/health did not return ok.') {
    super(message);
    this.name = 'ServerStartupError';
  }
}

function looksLikeHtmlOrNonJson(contentType: string, bodyText: string): boolean {
  const trimmed = bodyText.trim();
  if (!trimmed) return true;
  if (/^\s*<!doctype/i.test(trimmed) || /^\s*<html/i.test(trimmed) || /<head>|<body|starting server/i.test(trimmed)) {
    return true;
  }
  if (contentType.includes('text/html')) {
    return true;
  }
  return false;
}

export function sanitizeUiErrorText(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');
  if (!msg) return '';
  if (/^\s*<!doctype|^\s*<html|<head>|<body|starting server/i.test(msg)) {
    return 'Server is restarting or unavailable (non-JSON response received).';
  }
  return msg;
}

function tryParseJson<T>(contentType: string, bodyText: string): { ok: true; data: T } | { ok: false } {
  if (looksLikeHtmlOrNonJson(contentType, bodyText)) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(bodyText) as T;
    if (contentType && !contentType.includes('json')) {
      // Allow valid JSON object/array even without header only if it parsed as non-primitive JSON
      if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false };
      }
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false };
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchServerErrorLogs(signal?: AbortSignal | null): Promise<string[]> {
  try {
    const res = await fetch('/api/logs', {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return [];
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    const parsed = tryParseJson<{ errors?: string[]; lines?: string[] }>(ct, text);
    if (!parsed.ok) return [];
    const rawErrors = Array.isArray(parsed.data.errors) ? parsed.data.errors : [];
    const fallbackLines =
      rawErrors.length > 0
        ? rawErrors
        : Array.isArray(parsed.data.lines)
          ? parsed.data.lines.filter((l) => /\[ERROR\]|error|failed|exception/i.test(l))
          : [];
    return fallbackLines.map((l) => sanitizeUiErrorText(l)).filter(Boolean);
  } catch {
    return [];
  }
}

async function checkHealthOnce(signal?: AbortSignal | null): Promise<{
  ok: boolean;
  reason: string | null;
}> {
  try {
    const res = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    const text = await res.text();
    let parsedData: { ok?: boolean; error?: string } | null = null;
    try {
      parsedData = JSON.parse(text) as { ok?: boolean; error?: string };
    } catch {
      parsedData = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: parsedData?.error
          ? sanitizeUiErrorText(parsedData.error)
          : `GET /api/health -> HTTP ${res.status} ${res.statusText}`.trim(),
      };
    }

    if (parsedData && parsedData.ok === true) {
      return { ok: true, reason: null };
    }

    return {
      ok: false,
      reason: parsedData
        ? sanitizeUiErrorText(parsedData.error || JSON.stringify(parsedData))
        : 'GET /api/health returned non-JSON/HTML response.',
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      ok: false,
      reason: sanitizeUiErrorText(err) || 'Network error reaching /api/health.',
    };
  }
}

export async function checkHealthOnceExternal(): Promise<boolean> {
  const res = await checkHealthOnce();
  if (res.ok && currentStatus.phase !== 'ok') {
    setServerHealthStatus({
      phase: 'ok',
      attempt: 0,
      maxAttempts: MAX_RETRIES,
      error: null,
      serverLogLines: [],
    });
  }
  return res.ok;
}

export async function pollServerHealth(): Promise<boolean> {
  if (inFlightHealthPoll) {
    return inFlightHealthPoll;
  }

  inFlightHealthPoll = (async () => {
    const initial = await checkHealthOnce();
    if (initial.ok) {
      if (currentStatus.phase !== 'ok') {
        setServerHealthStatus({
          phase: 'ok',
          attempt: 0,
          maxAttempts: MAX_RETRIES,
          error: null,
          serverLogLines: [],
        });
      }
      return true;
    }

    let lastReason: string | null = initial.reason;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      setServerHealthStatus({
        phase: 'starting',
        attempt,
        maxAttempts: MAX_RETRIES,
        error: null,
        serverLogLines: [],
      });
      await sleepAbortable(RETRY_INTERVAL_MS);
      const health = await checkHealthOnce();
      if (health.ok) {
        setServerHealthStatus({
          phase: 'ok',
          attempt: 0,
          maxAttempts: MAX_RETRIES,
          error: null,
          serverLogLines: [],
        });
        return true;
      }
      lastReason = health.reason;
    }

    const logLines = await fetchServerErrorLogs();
    const combinedLogs =
      logLines.length > 0 ? logLines : lastReason ? [lastReason] : [];
    setServerHealthStatus({
      phase: 'failed',
      attempt: MAX_RETRIES,
      maxAttempts: MAX_RETRIES,
      error: lastReason || 'SERVER_STARTUP_FAILED',
      serverLogLines: combinedLogs,
    });
    return false;
  })().finally(() => {
    inFlightHealthPoll = null;
  });

  return inFlightHealthPoll;
}

export async function apiFetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; statusText: string; data: T }> {
  const signal = init?.signal;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const attemptOnce = async (): Promise<{
    isJson: boolean;
    status: number;
    ok: boolean;
    statusText: string;
    data?: T;
  }> => {
    const res = await fetch(url, init);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const rawText = await res.text();
    const parsed = tryParseJson<T>(ct, rawText);
    if (!parsed.ok) {
      return {
        isJson: false,
        status: res.status,
        ok: res.ok,
        statusText: res.statusText,
      };
    }
    return {
      isJson: true,
      status: res.status,
      ok: res.ok,
      statusText: res.statusText,
      data: parsed.data,
    };
  };

  try {
    const first = await attemptOnce();
    if (first.isJson) {
      if (currentStatus.phase !== 'ok') {
        setServerHealthStatus({
          phase: 'ok',
          attempt: 0,
          maxAttempts: MAX_RETRIES,
          error: null,
          serverLogLines: [],
        });
      }
      return {
        status: first.status,
        ok: first.ok,
        statusText: first.statusText,
        data: first.data as T,
      };
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    // Network / restarting server: fall through into health-poll retry loop
  }

  // Non-JSON / HTML ("Starting Server...") or connection error -> poll /api/health and retry up to 5 times, 2s apart
  let lastReason: string | null = null;
  let healthOkOnLastAttempt = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    setServerHealthStatus({
      phase: 'starting',
      attempt,
      maxAttempts: MAX_RETRIES,
      error: null,
      serverLogLines: [],
    });

    await sleepAbortable(RETRY_INTERVAL_MS, signal);

    const health = await checkHealthOnce(signal);
    healthOkOnLastAttempt = health.ok;
    if (!health.ok) {
      lastReason = health.reason;
      continue;
    }

    try {
      const retried = await attemptOnce();
      if (retried.isJson) {
        setServerHealthStatus({
          phase: 'ok',
          attempt: 0,
          maxAttempts: MAX_RETRIES,
          error: null,
          serverLogLines: [],
        });
        return {
          status: retried.status,
          ok: retried.ok,
          statusText: retried.statusText,
          data: retried.data as T,
        };
      }
      lastReason = `HTTP ${retried.status}: ${retried.statusText || 'Non-JSON response'}`;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      lastReason = sanitizeUiErrorText(err);
    }
  }

  if (healthOkOnLastAttempt) {
    setServerHealthStatus({
      phase: 'ok',
      attempt: 0,
      maxAttempts: MAX_RETRIES,
      error: null,
      serverLogLines: [],
    });
    throw new Error(lastReason || `Request to ${url} failed.`);
  }

  const logLines = await fetchServerErrorLogs(signal);
  const combinedLogs =
    logLines.length > 0 ? logLines : lastReason ? [lastReason] : [];
  setServerHealthStatus({
    phase: 'failed',
    attempt: MAX_RETRIES,
    maxAttempts: MAX_RETRIES,
    error: lastReason || 'SERVER_STARTUP_FAILED',
    serverLogLines: combinedLogs,
  });
  throw new ServerStartupError();
}
