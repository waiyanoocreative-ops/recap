import type { VideoChunk } from './projectTypes.ts';

export const LONG_VIDEO_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
export const CHUNK_MIN_MS = 3 * 60 * 1000; // 3 minutes
export const CHUNK_TARGET_MIN_MS = 5 * 60 * 1000; // 5 minutes
export const CHUNK_TARGET_MAX_MS = 8 * 60 * 1000; // 8 minutes
export const CHUNK_IDEAL_MS = Math.round(6.5 * 60 * 1000); // 6.5 minutes
export const CHUNK_MAX_MS = 10 * 60 * 1000; // 10 minutes

export function isLongVideoDuration(durationMs: number): boolean {
  return durationMs > LONG_VIDEO_THRESHOLD_MS;
}

export function formatChunkClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatChunkProgressLabel(
  chunkIndexZeroBased: number,
  totalChunks: number,
  startMs: number,
  endMs: number,
): string {
  return `အပိုင်း (Chunk) ${chunkIndexZeroBased + 1} / ${Math.max(1, totalChunks)} လုပ်ဆောင်နေသည် (${formatChunkClock(startMs)} - ${formatChunkClock(endMs)})`;
}

function isInsideSpeech(
  pointMs: number,
  speechSegments?: Array<{ start_ms: number; end_ms: number }>,
): boolean {
  if (!speechSegments || speechSegments.length === 0) return false;
  for (const seg of speechSegments) {
    if (pointMs > seg.start_ms + 80 && pointMs < seg.end_ms - 80) {
      return true;
    }
  }
  return false;
}

/**
 * Splits videos > 10 minutes into smart chunks strictly within 3–10 minutes
 * (targeting 5–8 minutes) at the nearest silence gap >= 600 ms or scene cut,
 * never cutting inside speech.
 */
export function planSmartVideoChunks(params: {
  durationMs: number;
  silenceMs?: Array<[number, number]>;
  sceneCutsMs?: number[];
  speechSegments?: Array<{ start_ms: number; end_ms: number }>;
}): VideoChunk[] {
  const { durationMs, silenceMs = [], sceneCutsMs = [], speechSegments } = params;
  if (durationMs <= LONG_VIDEO_THRESHOLD_MS) {
    return [];
  }

  const silence600Midpoints: Array<{ ms: number; dur: number }> = [];
  const silenceAnyMidpoints: Array<{ ms: number; dur: number }> = [];
  for (const [sStart, sEnd] of silenceMs) {
    const dur = Math.max(0, sEnd - sStart);
    const mid = Math.round((sStart + sEnd) / 2);
    if (dur >= 600) {
      silence600Midpoints.push({ ms: mid, dur });
    }
    if (dur >= 250) {
      silenceAnyMidpoints.push({ ms: mid, dur });
    }
  }

  const chunks: VideoChunk[] = [];
  let cursorMs = 0;
  let index = 0;

  while (cursorMs < durationMs) {
    const remaining = durationMs - cursorMs;
    if (remaining <= CHUNK_MAX_MS) {
      chunks.push({
        index,
        start_ms: cursorMs,
        end_ms: durationMs,
        status: 'pending',
        analyze_done: false,
        dub_done_langs: [],
        speech_count: 0,
        rendered_mp4_files: {},
        rendered_wav_files: {},
        rendered_srt_files: {},
      });
      break;
    }

    const minAllowedCut = cursorMs + CHUNK_MIN_MS;
    // Keep final remainder >= 3 minutes whenever possible
    const maxAllowedCut = Math.max(
      minAllowedCut,
      Math.min(cursorMs + CHUNK_MAX_MS, durationMs - CHUNK_MIN_MS),
    );
    const idealMs = Math.max(
      minAllowedCut,
      Math.min(maxAllowedCut, cursorMs + CHUNK_IDEAL_MS),
    );
    const targetLow = Math.max(minAllowedCut, cursorMs + CHUNK_TARGET_MIN_MS);
    const targetHigh = Math.min(maxAllowedCut, cursorMs + CHUNK_TARGET_MAX_MS);

    let chosenCutMs: number | null = null;
    let bestScore = -Infinity;

    const evaluateCandidate = (
      ms: number,
      baseTierScore: number,
    ) => {
      if (ms < minAllowedCut || ms > maxAllowedCut) return;
      if (isInsideSpeech(ms, speechSegments)) return;
      const inTargetWindow = ms >= targetLow && ms <= targetHigh ? 20_000 : 0;
      const distPenalty = Math.abs(ms - idealMs) / 1000; // 1 pt per second away from 6.5m
      const score = baseTierScore + inTargetWindow - distPenalty;
      if (score > bestScore) {
        bestScore = score;
        chosenCutMs = ms;
      }
    };

    // Tier 1: silence >= 600 ms (highest priority if near a scene cut too)
    for (const sil of silence600Midpoints) {
      if (sil.ms < minAllowedCut || sil.ms > maxAllowedCut) continue;
      const nearScene = sceneCutsMs.some((c) => Math.abs(c - sil.ms) <= 2000);
      const tier = nearScene ? 120_000 : 100_000;
      evaluateCandidate(sil.ms, tier + Math.min(sil.dur, 3000));
    }

    // Tier 2: scene cuts outside speech
    for (const cut of sceneCutsMs) {
      if (cut < minAllowedCut || cut > maxAllowedCut) continue;
      evaluateCandidate(cut, 70_000);
    }

    // Tier 3: shorter silence gaps >= 250 ms outside speech
    if (chosenCutMs === null) {
      for (const sil of silenceAnyMidpoints) {
        if (sil.ms < minAllowedCut || sil.ms > maxAllowedCut) continue;
        evaluateCandidate(sil.ms, 40_000 + Math.min(sil.dur, 1000));
      }
    }

    // Fallback: closest non-speech second around idealMs, or idealMs
    if (chosenCutMs === null) {
      let fallback = idealMs;
      if (speechSegments && speechSegments.length > 0 && isInsideSpeech(fallback, speechSegments)) {
        for (let delta = 500; delta <= 60_000; delta += 500) {
          if (idealMs + delta <= maxAllowedCut && !isInsideSpeech(idealMs + delta, speechSegments)) {
            fallback = idealMs + delta;
            break;
          }
          if (idealMs - delta >= minAllowedCut && !isInsideSpeech(idealMs - delta, speechSegments)) {
            fallback = idealMs - delta;
            break;
          }
        }
      }
      chosenCutMs = fallback;
    }

    const endMs = Math.max(cursorMs + 1000, Math.min(durationMs, Math.round(chosenCutMs)));
    chunks.push({
      index,
      start_ms: cursorMs,
      end_ms: endMs,
      status: 'pending',
      analyze_done: false,
      dub_done_langs: [],
      speech_count: 0,
      rendered_mp4_files: {},
      rendered_wav_files: {},
      rendered_srt_files: {},
    });
    cursorMs = endMs;
    index += 1;
  }

  return chunks;
}
