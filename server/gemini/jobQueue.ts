import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ResilientJob,
  ResilientJobStatus,
  ResilientQueueStatus,
} from '../../shared/projectTypes.ts';
import {
  clearExpiredOrCooldownForRetryNow,
  getPublicKeySummaries,
  redactSecrets,
  setKeyPoolChangeListener,
} from './keyPool.ts';

interface JobsFile {
  version: number;
  jobs: ResilientJob[];
}

const MAX_STORED_JOBS = 1500;

let currentDataDir = path.resolve(
  process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
);
let jobsList: ResilientJob[] = [];
let jobsWriteLock: Promise<void> = Promise.resolve();
let queuePaused = false;
let retryNowNonce = 0;

let textFallbackModelsRef: string[] = [];
let ttsFallbackModelsRef: string[] = [];

const wakeWaiters = new Set<() => void>();
const statusListeners = new Set<(status: ResilientQueueStatus) => void>();

export function setFallbackModelsSnapshot(textFallbacks: string[], ttsFallbacks: string[]): void {
  textFallbackModelsRef = [...textFallbacks];
  ttsFallbackModelsRef = [...ttsFallbacks];
}

export function subscribeResilientStatus(cb: (status: ResilientQueueStatus) => void): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

function broadcastStatus(): void {
  if (statusListeners.size === 0) return;
  const snapshot = getResilientQueueStatus();
  for (const cb of statusListeners) {
    try {
      cb(snapshot);
    } catch {
      // non-fatal listener error
    }
  }
}

setKeyPoolChangeListener(() => {
  broadcastStatus();
});

function getJobsFilePath(): string {
  return path.join(currentDataDir, 'jobs.json');
}

async function persistJobsToDisk(): Promise<void> {
  const target = getJobsFilePath();
  // Trim oldest completed jobs if exceeding cap while preserving active/pending/waiting/failed jobs
  if (jobsList.length > MAX_STORED_JOBS) {
    const active = jobsList.filter((j) => j.status !== 'done');
    const done = jobsList.filter((j) => j.status === 'done');
    const keepDone = Math.max(0, MAX_STORED_JOBS - active.length);
    jobsList = [...active, ...done.slice(-keepDone)].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
  }

  const payload = JSON.stringify({ version: 1, jobs: jobsList } satisfies JobsFile, null, 2) + '\n';
  const prev = jobsWriteLock;
  let release!: () => void;
  jobsWriteLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fs.writeFile(tmp, payload, 'utf-8');
    await fs.rename(tmp, target);
  } catch (err) {
    console.error('[JobsQueue] Failed writing jobs.json:', err instanceof Error ? err.message : err);
    throw err;
  } finally {
    release();
  }
}

export async function initJobsQueueAtStartup(dataDir?: string): Promise<ResilientJob[]> {
  if (dataDir) {
    currentDataDir = path.resolve(dataDir);
  } else {
    currentDataDir = path.resolve(
      process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
    );
  }

  jobsList = [];
  queuePaused = false;

  try {
    const raw = await fs.readFile(getJobsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as JobsFile;
    if (parsed && Array.isArray(parsed.jobs)) {
      const nowIso = new Date().toISOString();
      jobsList = parsed.jobs.map((j) => {
        if (j.status === 'running' || j.status === 'waiting') {
          return {
            ...j,
            status: 'pending' as ResilientJobStatus,
            waiting_reason: undefined,
            waiting_message: undefined,
            next_retry_at: undefined,
            updated_at: nowIso,
          };
        }
        return j;
      });
    }
  } catch {
    // First boot or missing jobs.json
  }

  await persistJobsToDisk();
  broadcastStatus();
  return [...jobsList];
}

export function findDoneJobByHash(
  projectId: string,
  kind: string,
  hash: string,
): ResilientJob | undefined {
  return jobsList.find(
    (j) =>
      j.project_id === projectId &&
      j.kind === kind &&
      j.hash === hash &&
      j.status === 'done',
  );
}

export async function createOrReuseJob(params: {
  projectId: string;
  kind: string;
  label: string;
  hash: string;
  force?: boolean;
}): Promise<ResilientJob> {
  const { projectId, kind, label, hash, force } = params;
  const nowIso = new Date().toISOString();

  const existing = jobsList.find(
    (j) => j.project_id === projectId && j.kind === kind && j.hash === hash,
  );

  if (existing) {
    if (existing.status === 'done' && !force) {
      return existing;
    }
    existing.label = label;
    existing.status = 'pending';
    existing.error = undefined;
    existing.waiting_reason = undefined;
    existing.waiting_message = undefined;
    existing.next_retry_at = undefined;
    existing.updated_at = nowIso;
    await persistJobsToDisk();
    broadcastStatus();
    return existing;
  }

  const job: ResilientJob = {
    id: `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    project_id: projectId,
    kind,
    label,
    hash,
    status: 'pending',
    attempts: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
  jobsList.push(job);
  await persistJobsToDisk();
  broadcastStatus();
  return job;
}

export async function markJobRunning(
  jobId: string,
  model?: string,
  keyId?: string,
): Promise<ResilientJob | undefined> {
  const job = jobsList.find((j) => j.id === jobId);
  if (!job) return undefined;
  job.status = 'running';
  job.attempts += 1;
  if (model) job.model = model;
  if (keyId) job.key_id = keyId;
  job.waiting_reason = undefined;
  job.waiting_message = undefined;
  job.next_retry_at = undefined;
  job.error = undefined;
  job.updated_at = new Date().toISOString();
  await persistJobsToDisk();
  broadcastStatus();
  return job;
}

export async function markJobWaiting(params: {
  jobId: string;
  waitingReason: 'network' | 'quota' | 'paused';
  waitingMessage: string;
  nextRetryAt?: string;
  resetAt?: string;
  error?: string;
}): Promise<ResilientJob | undefined> {
  const job = jobsList.find((j) => j.id === params.jobId);
  if (!job) return undefined;
  job.status = 'waiting';
  job.waiting_reason = params.waitingReason;
  job.waiting_message = redactSecrets(params.waitingMessage);
  job.next_retry_at = params.nextRetryAt;
  job.reset_at = params.resetAt;
  if (params.error) {
    job.error = redactSecrets(params.error);
  }
  job.updated_at = new Date().toISOString();
  await persistJobsToDisk();
  broadcastStatus();
  return job;
}

export async function markJobDone(
  jobId: string,
  model?: string,
  keyId?: string,
): Promise<ResilientJob | undefined> {
  const job = jobsList.find((j) => j.id === jobId);
  if (!job) return undefined;
  job.status = 'done';
  if (model) job.model = model;
  if (keyId) job.key_id = keyId;
  job.waiting_reason = undefined;
  job.waiting_message = undefined;
  job.next_retry_at = undefined;
  job.error = undefined;
  job.updated_at = new Date().toISOString();
  await persistJobsToDisk();
  broadcastStatus();
  return job;
}

export async function markJobFailed(
  jobId: string,
  error: string,
): Promise<ResilientJob | undefined> {
  const job = jobsList.find((j) => j.id === jobId);
  if (!job) return undefined;
  job.status = 'failed';
  job.waiting_reason = undefined;
  job.waiting_message = undefined;
  job.next_retry_at = undefined;
  job.error = redactSecrets(error);
  job.updated_at = new Date().toISOString();
  await persistJobsToDisk();
  broadcastStatus();
  return job;
}

export async function removeProjectJobs(projectId: string): Promise<void> {
  const prevLen = jobsList.length;
  jobsList = jobsList.filter((j) => j.project_id !== projectId);
  if (jobsList.length !== prevLen) {
    await persistJobsToDisk();
    broadcastStatus();
  }
}

export function isQueuePaused(): boolean {
  return queuePaused;
}

export function getRetryNowNonce(): number {
  return retryNowNonce;
}

function wakeAllWaiters(): void {
  for (const resolve of Array.from(wakeWaiters)) {
    resolve();
  }
}

export function pauseQueue(): ResilientQueueStatus {
  queuePaused = true;
  broadcastStatus();
  return getResilientQueueStatus();
}

export function resumeQueue(): ResilientQueueStatus {
  queuePaused = false;
  wakeAllWaiters();
  broadcastStatus();
  return getResilientQueueStatus();
}

export function triggerRetryNow(): ResilientQueueStatus {
  queuePaused = false;
  retryNowNonce += 1;
  clearExpiredOrCooldownForRetryNow();
  wakeAllWaiters();
  broadcastStatus();
  return getResilientQueueStatus();
}

export async function waitWhilePaused(jobId?: string): Promise<void> {
  while (queuePaused) {
    if (jobId) {
      await markJobWaiting({
        jobId,
        waitingReason: 'paused',
        waitingMessage: 'အလုပ်ကို ခေတ္တရပ်ထားပါသည် (Paused)',
      });
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        wakeWaiters.delete(done);
        resolve();
      };
      wakeWaiters.add(done);
    });
  }
}

/**
 * Waits until `targetMs` OR until Resume/RetryNow wakes the sleeper.
 * If paused during sleep, pauses cleanly until resumed.
 */
export async function waitInterruptiblyUntil(
  targetMs: number,
  nonceAtStart: number,
  jobId?: string,
): Promise<'expired' | 'retry_now'> {
  while (true) {
    if (retryNowNonce !== nonceAtStart) {
      return 'retry_now';
    }
    if (queuePaused) {
      await waitWhilePaused(jobId);
      if (retryNowNonce !== nonceAtStart) {
        return 'retry_now';
      }
    }
    const remainingMs = targetMs - Date.now();
    if (remainingMs <= 0) {
      return 'expired';
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeWaiters.delete(wake);
        resolve();
      }, Math.min(remainingMs, 1000));

      const wake = () => {
        clearTimeout(timer);
        wakeWaiters.delete(wake);
        resolve();
      };
      wakeWaiters.add(wake);
    });
  }
}

export function getResilientQueueStatus(): ResilientQueueStatus {
  const keyInfo = getPublicKeySummaries();
  const total = jobsList.length;
  const done = jobsList.filter((j) => j.status === 'done').length;
  const runningJobs = jobsList.filter((j) => j.status === 'running');
  const waitingJobs = jobsList.filter((j) => j.status === 'waiting');
  const pending = jobsList.filter((j) => j.status === 'pending').length;
  const failed = jobsList.filter((j) => j.status === 'failed').length;

  const currentJob =
    waitingJobs[waitingJobs.length - 1] ??
    runningJobs[runningJobs.length - 1] ??
    jobsList.find((j) => j.status === 'pending') ??
    null;

  const waitingReason = queuePaused
    ? 'paused'
    : currentJob?.status === 'waiting'
      ? (currentJob.waiting_reason ?? null)
      : null;

  const waitingMessage = queuePaused
    ? 'အလုပ်ကို ခေတ္တရပ်ထားပါသည် (Paused)'
    : currentJob?.status === 'waiting'
      ? (currentJob.waiting_message ?? null)
      : null;

  const nextRetryAt =
    currentJob?.status === 'waiting' && currentJob.next_retry_at
      ? currentJob.next_retry_at
      : null;

  let etaSec: number | null = null;
  if (nextRetryAt) {
    const diff = Date.parse(nextRetryAt) - Date.now();
    etaSec = Number.isFinite(diff) ? Math.max(0, Math.round(diff / 1000)) : null;
  } else {
    const activeRemaining = pending + runningJobs.length + waitingJobs.length;
    if (activeRemaining > 0) {
      etaSec = activeRemaining * 5;
    }
  }

  return {
    paused: queuePaused,
    keys: keyInfo.keys,
    hasAnyKey: keyInfo.keys.length > 0,
    allKeysInvalid: keyInfo.allKeysInvalid,
    nextResetAtPt: keyInfo.nextResetAtPt,
    ptDate: keyInfo.ptDate,
    textFallbackModels: [...textFallbackModelsRef],
    ttsFallbackModels: [...ttsFallbackModelsRef],
    jobsSummary: {
      total,
      done,
      running: runningJobs.length,
      waiting: waitingJobs.length,
      pending,
      failed,
      currentJob,
      waitingReason,
      waitingMessage,
      nextRetryAt,
      etaSec,
    },
    // Return latest 80 jobs newest-first for crisp UI monitoring
    jobs: [...jobsList].slice(-80).reverse(),
    updatedAt: new Date().toISOString(),
  };
}
