import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  BackgroundAudioMode,
  DubSegment,
  DubValidationReport,
  TargetLang,
  TtsEngineType,
} from '../../shared/projectTypes.ts';
import { splitSubtitleCue } from '../../shared/subtitleSplit.ts';
import { hashString, readProjectCache, writeProjectCache } from '../analyze/cache.ts';
import { buildDemucsEndpoint, getConfig, resolveDemucsRemoteUrl } from '../config.ts';
import {
  COMMON_PYTHON_BIN_DIRS,
  getBinaryStatus,
  requireFfmpeg,
  resolveDemucsBinaryPath,
  spawnCommand,
} from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProjectPaths } from '../storage/projectStore.ts';
import { getTtsEngine } from '../tts/ttsEngine.ts';

const CachedTtsMetaSchema = z.object({
  duration_ms: z.number().nonnegative(),
  bytes: z.number().nonnegative(),
  model: z.string(),
  voice: z.string(),
  engine: z.enum(['edge', 'gemini']).optional(),
});

interface FfprobeStreamsResult {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    duration?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
  }>;
}

/**
 * Resolves the effective background audio mode for a render:
 * 1. Explicit per-request `backgroundAudioMode` (API payload) wins.
 * 2. Otherwise the persisted `project.background_audio_mode` (set from Step 3 / render payload).
 * 3. Otherwise legacy fallback for old projects: a recap project whose user explicitly kept the
 *    original audio (`recap_mute_original === false`) keeps its BGM bed.
 * 4. Default (missing everywhere): 'mute_original' — AI voice only, Demucs/Kaggle skipped.
 */
export function resolveBackgroundAudioMode(params: {
  requested?: BackgroundAudioMode | null;
  project?: { background_audio_mode?: BackgroundAudioMode; recap_mute_original?: boolean } | null;
  isRecapMode?: boolean;
}): BackgroundAudioMode {
  if (params.requested === 'mute_original' || params.requested === 'keep_bgm_demucs') {
    return params.requested;
  }
  if (
    params.project?.background_audio_mode === 'mute_original' ||
    params.project?.background_audio_mode === 'keep_bgm_demucs'
  ) {
    return params.project.background_audio_mode;
  }
  if (params.isRecapMode && params.project?.recap_mute_original === false) {
    return 'keep_bgm_demucs';
  }
  return 'mute_original';
}

export interface TimelinePartition {
  srcStartMs: number;
  srcEndMs: number;
  outStartMs: number;
  outEndMs: number;
  rate: number;
}

export function computePiecewiseTimeline(
  rangeStartMs: number,
  rangeEndMs: number,
  slowIntervals: Array<{ startMs: number; endMs: number; videoRate: number }>,
  minVideoRate = 0.65,
): TimelinePartition[] {
  const safeStart = Math.max(0, Math.round(rangeStartMs));
  const safeEnd = Math.max(safeStart + 100, Math.round(rangeEndMs));

  const sortedSlow = slowIntervals
    .filter((iv) => iv.videoRate > 0 && iv.videoRate < 0.999 && iv.endMs > iv.startMs)
    .map((iv) => ({
      startMs: Math.max(safeStart, Math.min(safeEnd, Math.round(iv.startMs))),
      endMs: Math.max(safeStart, Math.min(safeEnd, Math.round(iv.endMs))),
      videoRate: Math.max(minVideoRate, Math.min(0.999, iv.videoRate)),
    }))
    .filter((iv) => iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const partitions: TimelinePartition[] = [];
  let srcCursor = safeStart;
  let outCursor = 0;

  for (const iv of sortedSlow) {
    const rawS = Math.max(srcCursor, iv.startMs);
    const e = Math.max(rawS, iv.endMs);
    if (e - rawS < 45) {
      continue;
    }
    let s = rawS;
    // Avoid <45ms normal micro-partitions between intervals that yield 0 frames in FFmpeg trim
    if (s > srcCursor && s - srcCursor < 45) {
      s = srcCursor;
    }
    if (s > srcCursor) {
      const dur = s - srcCursor;
      partitions.push({
        srcStartMs: srcCursor,
        srcEndMs: s,
        outStartMs: outCursor,
        outEndMs: outCursor + dur,
        rate: 1.0,
      });
      outCursor += dur;
    }
    if (e > s) {
      const dur = Math.round((e - s) / iv.videoRate);
      partitions.push({
        srcStartMs: s,
        srcEndMs: e,
        outStartMs: outCursor,
        outEndMs: outCursor + dur,
        rate: iv.videoRate,
      });
      outCursor += dur;
      srcCursor = e;
    }
  }

  if (srcCursor < safeEnd) {
    const tailDur = safeEnd - srcCursor;
    if (tailDur < 45 && partitions.length > 0) {
      const last = partitions[partitions.length - 1];
      last.srcEndMs = safeEnd;
      last.outEndMs = last.outStartMs + Math.round((last.srcEndMs - last.srcStartMs) / last.rate);
    } else {
      partitions.push({
        srcStartMs: srcCursor,
        srcEndMs: safeEnd,
        outStartMs: outCursor,
        outEndMs: outCursor + tailDur,
        rate: 1.0,
      });
    }
  }

  if (partitions.length === 0) {
    partitions.push({
      srcStartMs: safeStart,
      srcEndMs: safeEnd,
      outStartMs: 0,
      outEndMs: safeEnd - safeStart,
      rate: 1.0,
    });
  }

  return partitions;
}

export function mapSourceMsToOutputRelMs(srcMs: number, partitions: TimelinePartition[]): number {
  if (partitions.length === 0) return Math.max(0, srcMs);
  for (const p of partitions) {
    if (srcMs <= p.srcStartMs) return p.outStartMs;
    if (srcMs <= p.srcEndMs) {
      const span = Math.max(1, p.srcEndMs - p.srcStartMs);
      const frac = (srcMs - p.srcStartMs) / span;
      return Math.round(p.outStartMs + frac * (p.outEndMs - p.outStartMs));
    }
  }
  return partitions[partitions.length - 1].outEndMs;
}

export async function probeMediaDurationsMs(filePath: string): Promise<{
  videoMs: number;
  audioMs: number;
  formatMs: number;
}> {
  const { ffprobe } = requireFfmpeg();
  const res = await spawnCommand(ffprobe, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  if (res.code !== 0) {
    throw new Error(`ffprobe failed on ${path.basename(filePath)}: ${res.stderr.slice(-4000)}`);
  }
  const parsed = JSON.parse(res.stdout) as FfprobeStreamsResult;
  const vStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const aStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const formatMs = Math.round((Number(parsed.format?.duration || 0) || 0) * 1000);
  const videoMs = Math.round((Number(vStream?.duration || parsed.format?.duration || 0) || 0) * 1000);
  const audioMs = Math.round((Number(aStream?.duration || parsed.format?.duration || 0) || 0) * 1000);
  return { videoMs, audioMs, formatMs };
}

export async function probeVideoFps(filePath: string): Promise<string> {
  try {
    const { ffprobe } = requireFfmpeg();
    const res = await spawnCommand(ffprobe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      '-select_streams',
      'v:0',
      filePath,
    ]);
    if (res.code !== 0) return '30';
    const parsed = JSON.parse(res.stdout) as FfprobeStreamsResult;
    const raw = parsed.streams?.[0]?.r_frame_rate || parsed.streams?.[0]?.avg_frame_rate || '30';
    if (/^\d+\/\d+$/.test(raw)) {
      const [num, den] = raw.split('/').map(Number);
      if (den > 0 && num / den >= 5 && num / den <= 120) {
        return raw;
      }
    }
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum >= 5 && asNum <= 120) {
      return String(asNum);
    }
  } catch {
    // fallback to 30 fps
  }
  return '30';
}

function parseFpsFraction(fpsStr: string): number {
  if (/^\d+\/\d+$/.test(fpsStr)) {
    const [num, den] = fpsStr.split('/').map(Number);
    if (den > 0 && num > 0) return num / den;
  }
  const n = Number(fpsStr);
  return Number.isFinite(n) && n >= 5 && n <= 120 ? n : 30;
}

async function writeAudioAsWav(audioBuf: Buffer, mimeType: string, wavPath: string): Promise<void> {
  const isWav =
    mimeType.includes('wav') ||
    (audioBuf.length >= 12 &&
      audioBuf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      audioBuf.subarray(8, 12).toString('ascii') === 'WAVE');

  if (isWav) {
    const tmpWav = `${wavPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpWav, audioBuf);
    await fs.rename(tmpWav, wavPath);
    return;
  }

  const { ffmpeg } = requireFfmpeg();
  const ext = mimeType.includes('mpeg') || mimeType.includes('mp3') ? '.mp3' : '.audio';
  const tmpRaw = `${wavPath}.raw${ext}.${process.pid}.${Date.now()}`;
  const tmpWav = `${wavPath}.tmp.${process.pid}.${Date.now()}.wav`;
  try {
    await fs.writeFile(tmpRaw, audioBuf);
    const res = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      tmpRaw,
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      tmpWav,
    ]);
    if (res.code !== 0) {
      throw new Error(`FFmpeg TTS decode to WAV failed: ${res.stderr.slice(-4000)}`);
    }
    await fs.rename(tmpWav, wavPath);
  } finally {
    await fs.unlink(tmpRaw).catch(() => {});
  }
}

/**
 * Encodes a video stream cleanly with `libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart`
 * so filtered renders preserve source quality while staying compact in file size.
 */
export async function spawnFfmpegVideoEncodeWithHwFallback(params: {
  ffmpeg: string;
  prefixArgs: string[];
  suffixArgs: string[];
  outputPath: string;
  cpuCrf?: string;
  cpuExtraArgs?: string[];
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const { ffmpeg, prefixArgs, suffixArgs, outputPath, cpuCrf = '20', cpuExtraArgs = [] } = params;
  const hasFaststart = suffixArgs.includes('-movflags');

  return spawnCommand(ffmpeg, [
    ...prefixArgs,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    cpuCrf,
    '-pix_fmt',
    'yuv420p',
    ...(hasFaststart ? [] : ['-movflags', '+faststart']),
    ...cpuExtraArgs,
    ...suffixArgs,
    outputPath,
  ]);
}

export async function synthesizeCachedTts(params: {
  projectId: string;
  engine: TtsEngineType;
  text: string;
  voice: string;
  style: string;
  modelId?: string;
  rate?: string;
  pitch?: string;
  force?: boolean;
  jobLabel?: string;
}): Promise<{
  wavPath: string;
  durationMs: number;
  fromCache: boolean;
  requestMs: number;
  modelUsed: string;
  engine: TtsEngineType;
}> {
  const { projectId, engine, text, voice, style, modelId, rate, pitch, force, jobLabel } = params;
  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.cacheDir, { recursive: true });

  const effectiveModelKey = engine === 'edge' ? 'edge-tts' : (modelId || '');
  const ratePitchSuffix = rate || pitch ? `|${rate || ''}|${pitch || ''}` : '';
  const cacheHash = hashString(`${engine}|${text}|${voice}|${style}|${effectiveModelKey}${ratePitchSuffix}`);
  const wavPath = path.join(paths.cacheDir, `tts_${cacheHash}.wav`);
  const metaKey = `tts_meta_${cacheHash}`;

  const existingWavStat = !force ? await fs.stat(wavPath).catch(() => null) : null;
  if (existingWavStat && existingWavStat.isFile() && existingWavStat.size > 0) {
    const meta = await readProjectCache(projectId, metaKey, CachedTtsMetaSchema);
    if (meta && meta.duration_ms > 0) {
      return {
        wavPath,
        durationMs: meta.duration_ms,
        fromCache: true,
        requestMs: 0,
        modelUsed: meta.model || effectiveModelKey || engine,
        engine,
      };
    }
    const { audioMs } = await probeMediaDurationsMs(wavPath);
    if (audioMs > 0) {
      await writeProjectCache(projectId, metaKey, {
        duration_ms: audioMs,
        bytes: existingWavStat.size,
        model: effectiveModelKey || engine,
        voice,
        engine,
      });
      return {
        wavPath,
        durationMs: audioMs,
        fromCache: true,
        requestMs: 0,
        modelUsed: effectiveModelKey || engine,
        engine,
      };
    }
  }

  let savedDurationMs = 0;
  let savedModel = effectiveModelKey || engine;
  const tts = getTtsEngine(engine);
  const res = await tts.synthesize({
    text,
    voice,
    model: engine === 'gemini' ? modelId : undefined,
    rate,
    pitch,
    projectId,
    jobHash: cacheHash,
    jobLabel: jobLabel || `TTS clip (${voice})`,
    interactive: false,
    force: Boolean(force),
    onAudioReady: async (ttsRes) => {
      await writeAudioAsWav(ttsRes.audio, ttsRes.mimeType, wavPath);
      const probed = await probeMediaDurationsMs(wavPath);
      savedDurationMs = probed.audioMs || Math.round(ttsRes.durationSec * 1000);
      savedModel = ttsRes.model || effectiveModelKey || engine;

      await writeProjectCache(projectId, metaKey, {
        duration_ms: savedDurationMs,
        bytes: ttsRes.audio.length,
        model: savedModel,
        voice,
        engine,
      });
    },
  });

  if (savedDurationMs === 0) {
    await writeAudioAsWav(res.audio, res.mimeType, wavPath);
    const probed = await probeMediaDurationsMs(wavPath);
    savedDurationMs = probed.audioMs || Math.round(res.durationSec * 1000);
    savedModel = res.model || effectiveModelKey || engine;
    await writeProjectCache(projectId, metaKey, {
      duration_ms: savedDurationMs,
      bytes: res.audio.length,
      model: savedModel,
      voice,
      engine,
    });
  }

  return {
    wavPath,
    durationMs: savedDurationMs,
    fromCache: false,
    requestMs: res.ms,
    modelUsed: savedModel,
    engine,
  };
}

export async function synthesizeCachedGeminiTts(params: {
  projectId: string;
  text: string;
  voice: string;
  style: string;
  modelId: string;
  force?: boolean;
  jobLabel?: string;
}) {
  return synthesizeCachedTts({ ...params, engine: 'gemini' });
}

/**
 * Applies optional FFmpeg atempo and 10 ms fade-in/out while converting to 48 kHz stereo PCM WAV.
 */
export async function prepareClip48kWithTempoAndFades(params: {
  inWavPath: string;
  outWavPath: string;
  rate: number;
}): Promise<number> {
  const { ffmpeg } = requireFfmpeg();
  const { inWavPath, outWavPath, rate } = params;
  await fs.mkdir(path.dirname(outWavPath), { recursive: true });

  const clampedRate = Math.max(0.5, Math.min(2.0, rate));
  const useTempo = Math.abs(clampedRate - 1.0) > 0.005;

  const tmpTempoPath = `${outWavPath}.tempo.wav`;
  if (useTempo) {
    const r = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      inWavPath,
      '-af',
      `atempo=${clampedRate.toFixed(4)}`,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      tmpTempoPath,
    ]);
    if (r.code !== 0) {
      throw new Error(`FFmpeg atempo=${clampedRate.toFixed(3)} failed: ${r.stderr.slice(-4000)}`);
    }
  }

  const fadeSource = useTempo ? tmpTempoPath : inWavPath;
  const { audioMs: rawDurMs } = await probeMediaDurationsMs(fadeSource);
  const rawDurSec = Math.max(0.05, rawDurMs / 1000);
  const fadeOutStartSec = Math.max(0.015, rawDurSec - 0.01).toFixed(4);

  const filterExpr =
    rawDurMs >= 40
      ? `afade=t=in:st=0:d=0.01,afade=t=out:st=${fadeOutStartSec}:d=0.01`
      : 'anull';

  const rFade = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    fadeSource,
    '-af',
    filterExpr,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outWavPath,
  ]);
  if (useTempo) {
    await fs.unlink(tmpTempoPath).catch(() => {});
  }
  if (rFade.code !== 0) {
    throw new Error(`FFmpeg 10ms fade processing failed: ${rFade.stderr.slice(-4000)}`);
  }

  const finalProbe = await probeMediaDurationsMs(outWavPath);
  return finalProbe.audioMs;
}

function createStereo48kWavHeader(pcmDataBytes: number): Buffer {
  const sampleRate = 48000;
  const channels = 2;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

function findWavDataOffset(buf: Buffer): { dataOffset: number; dataBytes: number } {
  if (buf.length < 44 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    return { dataOffset: 0, dataBytes: buf.length };
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const start = offset + 8;
      return {
        dataOffset: start,
        dataBytes: Math.min(chunkSize, buf.length - start),
      };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return { dataOffset: 44, dataBytes: Math.max(0, buf.length - 44) };
}

async function findFileRecursive(rootDir: string, filename: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const nested = await findFileRecursive(fullPath, filename);
        if (nested) return nested;
      }
    }
  } catch {
    // ignore missing directory
  }
  return null;
}

async function computeAudioSha256Short(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 12)));
    stream.on('error', reject);
  });
}

const REMOTE_DEMUCS_HEALTH_TIMEOUT_MS = 20_000;

/**
 * GET <base>/health before separating. Never throws: a failing probe is logged with the exact
 * status/error and the POST still runs, since some tunnel images only expose /separate.
 */
async function probeRemoteDemucsHealth(healthEndpoint: string): Promise<void> {
  try {
    const res = await fetch(healthEndpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(REMOTE_DEMUCS_HEALTH_TIMEOUT_MS),
    });
    const body = (await res.text().catch(() => '')).trim().slice(0, 200);
    if (res.ok) {
      console.log(`[AudioDsp] Remote demucs health OK (HTTP ${res.status} ${healthEndpoint})${body ? `: ${body}` : ''}`);
    } else {
      console.warn(
        `[AudioDsp] Remote demucs health check returned HTTP ${res.status} ${res.statusText} (${healthEndpoint})${body ? ` | body: ${body}` : ''}. Attempting /separate anyway.`,
      );
    }
  } catch (err) {
    console.warn(
      `[AudioDsp] Remote demucs health check FAILED (${healthEndpoint}): ${describeRemoteFetchError(err)}. Attempting /separate anyway.`,
    );
  }
}

/** Fixed 4-minute chunk length for remote Kaggle separation (~3.7 MB at 128 kbps MP3). */
const REMOTE_DEMUCS_CHUNK_SEC = 240;
/** 128 kbps CBR MP3 — ~16 KB per second of audio. */
const REMOTE_DEMUCS_MP3_BITRATE = '128k';
/** Per-chunk request timeout: a 4-minute MP3 chunk separates in ~15-20 s on a Kaggle GPU. */
const REMOTE_DEMUCS_CHUNK_TIMEOUT_MS = 480_000;
/** Automatic retries per chunk on network reset / timeout before falling back to local CPU. */
const REMOTE_DEMUCS_CHUNK_MAX_RETRIES = 2;

/**
 * Segment the 48 kHz WAV into fixed 4-minute 128 kbps MP3 chunks with a single FFmpeg pass
 * (`-f segment`). Uniform chunks keep every `POST /separate` upload ~3.7 MB, so each request
 * completes in ~15-20 s and never approaches the Cloudflare Quick Tunnel timeout/reset limit.
 */
async function segmentRemoteDemucsAudio(
  ffmpeg: string,
  inWavPath: string,
  outDir: string,
): Promise<Array<{ path: string; index: number; durSec: number }>> {
  const pattern = path.join(outDir, 'chunk_%03d.mp3');
  const res = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    inWavPath,
    '-vn',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'libmp3lame',
    '-b:a',
    REMOTE_DEMUCS_MP3_BITRATE,
    '-f',
    'segment',
    '-segment_time',
    String(REMOTE_DEMUCS_CHUNK_SEC),
    '-reset_timestamps',
    '1',
    pattern,
  ]);
  if (res.code !== 0) {
    throw new Error(`FFmpeg segment of remote demucs audio failed: ${res.stderr.slice(-500)}`);
  }

  const entries = (await fs.readdir(outDir))
    .filter((name) => /^chunk_\d{3}\.mp3$/.test(name))
    .sort();
  if (entries.length === 0) {
    throw new Error('FFmpeg segment produced no MP3 chunks for remote demucs.');
  }

  const chunks: Array<{ path: string; index: number; durSec: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const chunkPath = path.join(outDir, entries[i]);
    const stat = await fs.stat(chunkPath);
    if (stat.size <= 44) {
      throw new Error(`Segmented chunk ${entries[i]} is empty (${stat.size} bytes).`);
    }
    // Probe each chunk so stem normalization can pin exact lengths and joins never drift.
    let durSec = REMOTE_DEMUCS_CHUNK_SEC;
    try {
      const probed = await probeMediaDurationsMs(chunkPath);
      const sec = (probed.audioMs || probed.formatMs) / 1000;
      if (sec > 0) durSec = sec;
    } catch {
      // keep the nominal 240 s; the final chunk shrinks via apad/atrim anyway
    }
    chunks.push({ path: chunkPath, index: i, durSec });
  }

  const firstStat = await fs.stat(chunks[0].path);
  console.log(
    `[AudioDsp] Segmented into ${chunks.length} × ${REMOTE_DEMUCS_CHUNK_SEC / 60}-minute 128k MP3 chunk(s) (~${(firstStat.size / (1024 * 1024)).toFixed(1)} MB each) for remote demucs.`,
  );
  return chunks;
}

/** POST one MP3 chunk to <base>/separate and return the raw response body. */
async function postRemoteDemucsSeparate(params: {
  endpoint: string;
  filePath: string;
  filename: string;
  timeoutMs: number;
  label: string;
}): Promise<{ buf: Buffer; ext: '.mp3' | '.wav'; status: number }> {
  const { endpoint, filePath, filename, timeoutMs, label } = params;
  const payload = await fs.readFile(filePath);
  console.log(
    `[AudioDsp] ${label} POST ${endpoint} -> ${(payload.length / (1024 * 1024)).toFixed(2)} MB, timeout=${Math.round(timeoutMs / 1000)}s.`,
  );
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(payload)], { type: 'audio/mpeg' }), filename);
  const response = await fetch(endpoint, {
    method: 'POST',
    body: formData,
    headers: {
      Connection: 'close',
      'Accept-Encoding': 'identity',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(
      `POST ${endpoint} returned HTTP ${response.status} ${response.statusText}${errBody ? ` | body: ${errBody.slice(0, 300)}` : ''}`,
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length <= 44) {
    throw new Error(
      `POST ${endpoint} returned HTTP ${response.status} but the audio body was empty/invalid (${buf.length} bytes).`,
    );
  }
  return { buf, ext: detectRemoteAudioExt(response, buf), status: response.status };
}

/** Retry a chunk upload on network reset/timeout (ECONNRESET, EPIPE, aborted, 5xx). */
async function postRemoteDemucsSeparateWithRetry(params: {
  endpoint: string;
  filePath: string;
  filename: string;
  label: string;
}): Promise<{ buf: Buffer; ext: '.mp3' | '.wav'; status: number }> {
  const { endpoint, filePath, filename, label } = params;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= REMOTE_DEMUCS_CHUNK_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = 1000 * attempt;
      console.warn(
        `[AudioDsp] ${label} retry ${attempt}/${REMOTE_DEMUCS_CHUNK_MAX_RETRIES} in ${backoffMs} ms after: ${describeRemoteFetchError(lastErr)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    try {
      return await postRemoteDemucsSeparate({
        endpoint,
        filePath,
        filename,
        timeoutMs: REMOTE_DEMUCS_CHUNK_TIMEOUT_MS,
        label: attempt > 0 ? `${label} (attempt ${attempt + 1})` : label,
      });
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const cause = (err as Error & { cause?: { code?: string } })?.cause;
      const code = cause?.code || '';
      const isNetwork =
        err instanceof Error &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|network|fetch failed/i.test(message) ||
          /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT/i.test(code));
      const isServerError = /\bHTTP 5\d\d\b/.test(message);
      if (!isNetwork && !isServerError) {
        throw err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Normalize one returned stem to 48 kHz stereo PCM WAV (optionally pinned to an exact length). */
async function normalizeRemoteStemToWav(
  ffmpeg: string,
  rawPath: string,
  outWavPath: string,
  exactDurSec?: number,
): Promise<void> {
  const args = ['-y', '-i', rawPath];
  if (exactDurSec && exactDurSec > 0) {
    // Pad/trim so chunk joins keep the original timeline without drift.
    args.push('-af', `apad,atrim=start=0:end=${exactDurSec.toFixed(3)}`);
  }
  args.push('-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outWavPath);
  const res = await spawnCommand(ffmpeg, args);
  if (res.code !== 0) {
    throw new Error(`FFmpeg normalization of remote stem failed: ${res.stderr.slice(-500)}`);
  }
}


/** Render the underlying cause of fetch/abort failures so tunnel outages are diagnosable. */
function describeRemoteFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg =
      cause instanceof Error
        ? ` (cause: ${cause.message})`
        : typeof cause === 'string'
          ? ` (cause: ${cause})`
          : '';
    const name = err.name === 'TimeoutError' ? 'TIMEOUT' : err.name === 'AbortError' ? 'ABORTED' : '';
    return `${name ? `${name}: ` : ''}${err.message}${causeMsg}`;
  }
  return String(err);
}

function detectRemoteAudioExt(response: Response, buf: Buffer): '.mp3' | '.wav' {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const contentDisp = (response.headers.get('content-disposition') || '').toLowerCase();

  // Check magic bytes first so mislabeled headers never fool FFmpeg
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return '.wav';
  }
  if (
    (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') ||
    (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return '.mp3';
  }

  if (
    contentType.includes('mpeg') ||
    contentType.includes('mp3') ||
    contentDisp.includes('.mp3')
  ) {
    return '.mp3';
  }
  return '.wav';
}

async function ensureDemucsNoVocals48k(
  audio48kPath: string,
  ffmpeg: string,
  demucsBin: string | null,
): Promise<string | null> {
  const audioHash = await computeAudioSha256Short(audio48kPath);
  const cacheDir = path.dirname(audio48kPath);
  const demucsNoVocalsPath = path.join(cacheDir, `no_vocals_${audioHash}.wav`);
  const demucsNoVocalsMp3Path = path.join(cacheDir, `no_vocals_${audioHash}.mp3`);

  // 1. Hash Cache Check (supports both no_vocals_<hash>.wav and no_vocals_<hash>.mp3)
  for (const cachedCandidate of [demucsNoVocalsPath, demucsNoVocalsMp3Path]) {
    try {
      const cachedStat = await fs.stat(cachedCandidate);
      if (cachedStat.isFile() && cachedStat.size > 44) {
        console.log(
          `[AudioDsp] demucs succeeded (${demucsBin || 'cached'}, cached): reusing ${path.basename(cachedCandidate)}.`,
        );
        return cachedCandidate;
      }
    } catch {
      // cache miss
    }
  }

  // 2. Kaggle GPU Remote Offload
  // Long audio is segmented into fixed 4-minute 128 kbps MP3 chunks (~3.7 MB each) so every
  // POST /separate finishes in ~15-20 s — far below the Cloudflare Quick Tunnel timeout that
  // caused ECONNRESET on single large uploads. Returned instrumental chunks (MP3 or WAV) are
  // concatenated in order and re-normalized to 48 kHz stereo PCM WAV so downstream PCM assembly
  // (extractBedPcmSlice) sees the exact same file shape as before.
  const demucsRemoteUrl = resolveDemucsRemoteUrl();
  if (demucsRemoteUrl) {
    const endpoint = buildDemucsEndpoint(demucsRemoteUrl, '/separate');
    const healthEndpoint = buildDemucsEndpoint(demucsRemoteUrl, '/health');
    const tmpRemoteDir = `${demucsNoVocalsPath}.remote_tmp_${Date.now()}`;
    const tmpRemoteWav = path.join(tmpRemoteDir, 'no_vocals_joined.wav');
    try {
      console.log(`[AudioDsp] Separating vocals via Kaggle GPU (${endpoint})...`);
      await probeRemoteDemucsHealth(healthEndpoint);
      await fs.mkdir(tmpRemoteDir, { recursive: true });

      // Single FFmpeg pass: segment into fixed 4-minute 128 kbps MP3 chunks.
      const chunks = await segmentRemoteDemucsAudio(ffmpeg, audio48kPath, tmpRemoteDir);

      // Sequential separation (parallel posts could overwhelm the single Kaggle GPU).
      const stemPaths: string[] = [];
      for (const chunk of chunks) {
        const label = `[chunk ${chunk.index + 1}/${chunks.length}]`;
        try {
          const { buf, ext } = await postRemoteDemucsSeparateWithRetry({
            endpoint,
            filePath: chunk.path,
            filename: path.basename(chunk.path),
            label,
          });
          const rawStem = path.join(tmpRemoteDir, `stem_${String(chunk.index).padStart(3, '0')}${ext}`);
          await fs.writeFile(rawStem, buf);
          const stemWav = path.join(tmpRemoteDir, `stem_${String(chunk.index).padStart(3, '0')}.wav`);
          await normalizeRemoteStemToWav(ffmpeg, rawStem, stemWav, chunk.durSec);
          await fs.unlink(rawStem).catch(() => {});
          stemPaths.push(stemWav);
        } catch (chunkErr) {
          const msg = describeRemoteFetchError(chunkErr);
          console.warn(
            `[AudioDsp] Kaggle GPU demucs FAILED ${label} -> ${endpoint} (after ${REMOTE_DEMUCS_CHUNK_MAX_RETRIES} retries)\n  ${msg}`,
          );
          throw chunkErr instanceof Error ? chunkErr : new Error(msg);
        }
      }

      // Concatenate the per-chunk stems in exact order into 48 kHz stereo PCM WAV.
      const concatListPath = path.join(tmpRemoteDir, 'concat_list.txt');
      await fs.writeFile(
        concatListPath,
        stemPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n',
        'utf-8',
      );
      const concatRes = await spawnCommand(ffmpeg, [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-ar',
        '48000',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        tmpRemoteWav,
      ]);
      if (concatRes.code !== 0) {
        throw new Error(
          `FFmpeg concat of ${stemPaths.length} remote stems failed: ${concatRes.stderr.slice(-500)}`,
        );
      }

      const outStat = await fs.stat(tmpRemoteWav);
      if (outStat.size <= 44) {
        throw new Error('Remote demucs output is empty after concat/normalization.');
      }
      await fs.rename(tmpRemoteWav, demucsNoVocalsPath);
      console.log(
        `[AudioDsp] Kaggle GPU demucs succeeded (${chunks.length} chunk upload(s), ${(outStat.size / (1024 * 1024)).toFixed(2)} MB): saved ${path.basename(demucsNoVocalsPath)}.`,
      );
      return demucsNoVocalsPath;
    } catch (err) {
      // Surface the exact status/message so a dead tunnel is obvious in the server logs.
      console.warn(
        `[AudioDsp] Kaggle GPU demucs FAILED -> ${endpoint}\n  ${describeRemoteFetchError(err)}`,
      );
    } finally {
      await fs.rm(tmpRemoteDir, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    console.log(
      '[AudioDsp] No remote demucs URL configured (config.json demucsRemoteUrl / DEMUCS_REMOTE_URL / KAGGLE_DEMUCS_URL); skipping Kaggle GPU offload.',
    );
  }

  // 3. Automatic Local CPU Fallback
  console.log('[AudioDsp] Falling back to local demucs...');
  if (!demucsBin) {
    console.warn(
      '[AudioDsp] demucs binary not found on PATH or common Python bin paths; falling back to vocal cancellation + -55 dB (0.002) speech-slot mute.',
    );
    return null;
  }

  const ffmpegDir = path.isAbsolute(ffmpeg) ? path.dirname(ffmpeg) : '';
  const extraPathDirs = [
    ...COMMON_PYTHON_BIN_DIRS,
    ...(ffmpegDir ? [ffmpegDir] : []),
    process.env.PATH || '',
  ].filter(Boolean);
  const demucsEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: extraPathDirs.join(path.delimiter),
  };

  const tmpOutDir = `${demucsNoVocalsPath}.demucs_tmp_${Date.now()}`;
  try {
    await fs.mkdir(tmpOutDir, { recursive: true });
    console.log(
      `[AudioDsp] Running demucs (${demucsBin}) -j 4 --two-stems=vocals on ${path.basename(audio48kPath)} (hash=${audioHash})...`,
    );
    const res = await spawnCommand(
      demucsBin,
      ['-j', '4', '--two-stems=vocals', '-o', tmpOutDir, audio48kPath],
      { timeoutMs: 15 * 60_000, env: demucsEnv },
    );
    if (res.code !== 0) {
      console.warn(
        `[AudioDsp] demucs exited with code ${res.code} (${demucsBin}); falling back to -55 dB mute. ${res.stderr.slice(-600)}`,
      );
      return null;
    }

    const foundNoVocals = await findFileRecursive(tmpOutDir, 'no_vocals.wav');
    if (!foundNoVocals) {
      console.warn(
        `[AudioDsp] demucs finished (${demucsBin}) but no_vocals.wav was not produced; falling back to -55 dB mute.`,
      );
      return null;
    }

    const tmpWav = `${demucsNoVocalsPath}.tmp.wav`;
    const normRes = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      foundNoVocals,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      tmpWav,
    ]);
    if (normRes.code !== 0) {
      console.warn(
        `[AudioDsp] FFmpeg normalization of demucs no_vocals.wav failed; falling back to -55 dB mute: ${normRes.stderr.slice(-500)}`,
      );
      await fs.unlink(tmpWav).catch(() => {});
      return null;
    }
    await fs.rename(tmpWav, demucsNoVocalsPath);
    console.log(`[AudioDsp] demucs succeeded (${demucsBin}): extracted ${path.basename(demucsNoVocalsPath)}.`);
    return demucsNoVocalsPath;
  } catch (err) {
    console.warn(
      `[AudioDsp] demucs execution failed (${demucsBin}); falling back to vocal cancellation + -55 dB mute:`,
      err,
    );
    return null;
  } finally {
    await fs.rm(tmpOutDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractBedPcmSlice(params: {
  ffmpeg: string;
  sourceAudioPath: string;
  outPcmPath: string;
  rangeStartMs: number;
  sourceOffsetMs?: number;
  totalDurMs: number;
  hasSlowdown: boolean;
  partitions?: TimelinePartition[];
}): Promise<void> {
  const {
    ffmpeg,
    sourceAudioPath,
    outPcmPath,
    rangeStartMs,
    sourceOffsetMs = 0,
    totalDurMs,
    hasSlowdown,
    partitions,
  } = params;
  if (hasSlowdown && partitions && partitions.length > 0) {
    const splitHeader =
      partitions.length > 1
        ? `[0:a]asetpts=PTS-STARTPTS,asplit=${partitions.length}${partitions.map((_, idx) => `[ain${idx}]`).join('')};`
        : '[0:a]asetpts=PTS-STARTPTS[ain0];';
    const filterParts = partitions.map((p, idx) => {
      const sSec = Math.max(0, (p.srcStartMs - sourceOffsetMs) / 1000).toFixed(4);
      const eSec = Math.max(0, (p.srcEndMs - sourceOffsetMs) / 1000).toFixed(4);
      const outDurSec = Math.max(0.001, (p.outEndMs - p.outStartMs) / 1000).toFixed(4);
      const tempoChain = p.rate < 0.999 ? `,atempo=${p.rate.toFixed(5)}` : '';
      return `[ain${idx}]atrim=start=${sSec}:end=${eSec},asetpts=PTS-STARTPTS${tempoChain},apad,atrim=0:${outDurSec},asetpts=PTS-STARTPTS[a${idx}]`;
    });
    const concatIn = partitions.map((_, idx) => `[a${idx}]`).join('');
    const filterComplex = `${splitHeader}${filterParts.join(';')};${concatIn}concat=n=${partitions.length}:v=0:a=1,apad,atrim=0:${(totalDurMs / 1000).toFixed(4)}[outa]`;
    const useScriptFile = filterComplex.length > 16000;
    const filterScriptPath = `${outPcmPath}.bed_filter_${process.pid}_${Date.now()}.txt`;
    if (useScriptFile) {
      await fs.writeFile(filterScriptPath, filterComplex, 'utf-8');
    }
    try {
      const sliceRes = await spawnCommand(ffmpeg, [
        '-y',
        '-i',
        sourceAudioPath,
        ...(useScriptFile
          ? ['-filter_complex_script', filterScriptPath]
          : ['-filter_complex', filterComplex]),
        '-map',
        '[outa]',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-f',
        's16le',
        outPcmPath,
      ]);
      if (sliceRes.code !== 0) {
        throw new Error(`FFmpeg piecewise bed extraction failed: ${sliceRes.stderr.slice(-4000)}`);
      }
    } finally {
      if (useScriptFile) {
        await fs.unlink(filterScriptPath).catch(() => {});
      }
    }
  } else {
    const localStartSec = Math.max(0, (rangeStartMs - sourceOffsetMs) / 1000).toFixed(4);
    const sliceRes = await spawnCommand(ffmpeg, [
      '-y',
      '-ss',
      localStartSec,
      '-t',
      (totalDurMs / 1000).toFixed(4),
      '-i',
      sourceAudioPath,
      '-af',
      'apad',
      '-t',
      (totalDurMs / 1000).toFixed(4),
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      's16le',
      outPcmPath,
    ]);
    if (sliceRes.code !== 0) {
      throw new Error(`FFmpeg bed slice extraction failed: ${sliceRes.stderr.slice(-4000)}`);
    }
  }
}

/**
 * Step E: Original audio handling for Dubbing Mode:
 * - If demucs is installed on PATH, extract cached no-vocals stem (--two-stems=vocals)
 *   using ONLY no_vocals.wav (BGM + SFX) so 100% of original dialogue is removed.
 * - Fallback if demucs is unavailable: keep BGM clean outside speech slots (1.0), and apply
 *   aggressive center-channel vocal cancellation (pan=stereo|c0=c0-c1|c1=c1-c0) + vocal-band
 *   notch suppression + heavy -40 dB ducking across [start_ms - 200, end_ms + 200].
 * Supports piecewise time-stretching whenever any speech unit required video slowdown (down to 0.65x).
 */
export async function buildDuckedBed48k(params: {
  hasAudio: boolean;
  audio48kPath: string;
  sourceOffsetMs?: number;
  rangeStartMs: number;
  rangeEndMs: number;
  speechWindows: Array<{ start_ms: number; end_ms: number }>;
  partitions?: TimelinePartition[];
  outBedPath: string;
  recapMode?: boolean;
  recapMuteOriginal?: boolean;
  backgroundAudioMode?: BackgroundAudioMode;
}): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  const {
    hasAudio,
    audio48kPath,
    sourceOffsetMs = 0,
    rangeStartMs,
    rangeEndMs,
    speechWindows,
    partitions,
    outBedPath,
    recapMode = false,
    recapMuteOriginal = true,
    backgroundAudioMode = 'mute_original',
  } = params;
  await fs.mkdir(path.dirname(outBedPath), { recursive: true });

  const hasSlowdown = Boolean(partitions && partitions.some((p) => p.rate < 0.999));
  const totalDurMs =
    partitions && partitions.length > 0
      ? Math.max(100, partitions[partitions.length - 1].outEndMs)
      : Math.max(100, rangeEndMs - rangeStartMs);
  const totalFrames = Math.max(1, Math.round((totalDurMs / 1000) * 48000));
  const totalPcmBytes = totalFrames * 4;

  const writeSilentBed = async () => {
    const handle = await fs.open(outBedPath, 'w');
    try {
      await handle.write(createStereo48kWavHeader(totalPcmBytes));
      const zeroChunk = Buffer.alloc(Math.min(48000 * 4 * 5, totalPcmBytes));
      let remaining = totalPcmBytes;
      while (remaining > 0) {
        const toWrite = Math.min(remaining, zeroChunk.length);
        await handle.write(zeroChunk, 0, toWrite);
        remaining -= toWrite;
      }
    } finally {
      await handle.close();
    }
  };

  if (!hasAudio || !(await fileExists(audio48kPath))) {
    await writeSilentBed();
    return;
  }

  // 'mute_original' fast path: skip Demucs / Kaggle GPU vocal separation entirely and write a
  // silent bed so the final mix contains ONLY the generated AI TTS voice (timeline preserved).
  if (backgroundAudioMode === 'mute_original') {
    console.log(
      '[AudioDsp] backgroundAudioMode=mute_original: writing silent background bed (Demucs/Kaggle skipped, AI voice only).',
    );
    await writeSilentBed();
    return;
  }

  // Build sorted, merged speech intervals relative to output start [start - 250, end + 250]
  const rawIntervals = speechWindows
    .map((s) => {
      const rawStart = Math.max(rangeStartMs, s.start_ms - 250);
      const rawEnd = Math.min(rangeEndMs, s.end_ms + 250);
      const startMs =
        hasSlowdown && partitions
          ? mapSourceMsToOutputRelMs(rawStart, partitions)
          : Math.max(0, rawStart - rangeStartMs);
      const endMs =
        hasSlowdown && partitions
          ? mapSourceMsToOutputRelMs(rawEnd, partitions)
          : Math.min(totalDurMs, rawEnd - rangeStartMs);
      return {
        startMs: Math.max(0, startMs),
        endMs: Math.min(totalDurMs, endMs),
      };
    })
    .filter((iv) => iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const mergedIntervals: Array<{ startMs: number; endMs: number }> = [];
  for (const iv of rawIntervals) {
    const prev = mergedIntervals[mergedIntervals.length - 1];
    if (prev && iv.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, iv.endMs);
    } else {
      mergedIntervals.push({ ...iv });
    }
  }

  const fadeMs = 60;
  const speechAlphaAtMs = (ms: number, hintIdx: { idx: number }): number => {
    while (
      hintIdx.idx < mergedIntervals.length &&
      mergedIntervals[hintIdx.idx].endMs < ms
    ) {
      hintIdx.idx += 1;
    }
    const iv = mergedIntervals[hintIdx.idx];
    if (!iv || ms < iv.startMs || ms > iv.endMs) {
      return 0;
    }
    const dur = iv.endMs - iv.startMs;
    const effFade = Math.min(fadeMs, dur / 2);
    if (effFade <= 0) return 1;

    if (ms < iv.startMs + effFade) {
      return (ms - iv.startMs) / effFade;
    }
    if (ms > iv.endMs - effFade) {
      return (iv.endMs - ms) / effFade;
    }
    return 1;
  };

  // Try cached / remote Kaggle GPU / local demucs two-stem vocal separation first
  const demucsBin = getBinaryStatus().demucsPath || (await resolveDemucsBinaryPath());
  const noVocalsPath = await ensureDemucsNoVocals48k(audio48kPath, ffmpeg, demucsBin);
  if (noVocalsPath) {
    const noVocalsPcmPath = `${outBedPath}.demucs.pcm`;
    try {
      await extractBedPcmSlice({
        ffmpeg,
        sourceAudioPath: noVocalsPath,
        outPcmPath: noVocalsPcmPath,
        rangeStartMs,
        sourceOffsetMs,
        totalDurMs,
        hasSlowdown,
        partitions,
      });

      const inHandle = await fs.open(noVocalsPcmPath, 'r');
      const outHandle = await fs.open(outBedPath, 'w');
      try {
        const stat = await inHandle.stat();
        await outHandle.write(createStereo48kWavHeader(totalPcmBytes));
        const chunkFrames = 48000 * 10;
        const chunkBuf = Buffer.allocUnsafe(chunkFrames * 4);
        const intervalCursor = { idx: 0 };
        let framesWritten = 0;

        while (framesWritten < totalFrames) {
          const framesThisChunk = Math.min(chunkFrames, totalFrames - framesWritten);
          const bytesNeeded = framesThisChunk * 4;
          const offsetBytes = framesWritten * 4;
          chunkBuf.fill(0, 0, bytesNeeded);
          if (offsetBytes < stat.size) {
            const readable = Math.min(bytesNeeded, stat.size - offsetBytes);
            await inHandle.read(chunkBuf, 0, readable, offsetBytes);
          }

          if (recapMode) {
            // Recap Mode: Keep demucs no_vocals.wav at 20% volume (0.20 gain) across the bed
            const recapGain = 0.2;
            for (let f = 0; f < framesThisChunk; f++) {
              const bytePos = f * 4;
              const l = Math.round(chunkBuf.readInt16LE(bytePos) * recapGain);
              const r = Math.round(chunkBuf.readInt16LE(bytePos + 2) * recapGain);
              chunkBuf.writeInt16LE(Math.max(-32768, Math.min(32767, l)), bytePos);
              chunkBuf.writeInt16LE(Math.max(-32768, Math.min(32767, r)), bytePos + 2);
            }
          } else {
            // Dubbing Mode: Use ONLY no_vocals.wav at 85% volume during speech slots (100% outside speech)
            for (let f = 0; f < framesThisChunk; f++) {
              const ms = ((framesWritten + f) / 48000) * 1000;
              const alpha = speechAlphaAtMs(ms, intervalCursor);
              if (alpha > 0.001) {
                const bytePos = f * 4;
                const bedGain = 1.0 - alpha * (1.0 - 0.85);
                const l = Math.round(chunkBuf.readInt16LE(bytePos) * bedGain);
                const r = Math.round(chunkBuf.readInt16LE(bytePos + 2) * bedGain);
                chunkBuf.writeInt16LE(Math.max(-32768, Math.min(32767, l)), bytePos);
                chunkBuf.writeInt16LE(Math.max(-32768, Math.min(32767, r)), bytePos + 2);
              }
            }
          }

          await outHandle.write(chunkBuf, 0, bytesNeeded);
          framesWritten += framesThisChunk;
        }
        const demucsSourceLabel = demucsBin || 'remote';
        console.log(
          recapMode
            ? `[AudioDsp] Recap Mode background bed ready from demucs no_vocals.wav (${demucsSourceLabel}): 20% volume (0.20 gain), 0% original narration.`
            : `[AudioDsp] Background bed ready from demucs no_vocals.wav (${demucsSourceLabel}): 85% volume across ${mergedIntervals.length} speech interval(s), 0% original vocals.`,
        );
        return;
      } finally {
        await inHandle.close();
        await outHandle.close();
      }
    } catch (err) {
      console.warn('[AudioDsp] Failed slicing demucs no_vocals stem; falling back to -55 dB mute:', err);
    } finally {
      await fs.unlink(noVocalsPcmPath).catch(() => {});
    }
  }

  // Recap Mode safety: if demucs is unavailable and original vocals must be muted, output silence so Chinese narration never leaks
  if (recapMode && recapMuteOriginal) {
    console.warn('[AudioDsp] Recap Mode: demucs no_vocals unavailable; muting original audio bed completely so source narration does not leak.');
    await writeSilentBed();
    return;
  }

  // Fallback: center-channel vocal cancellation + vocal-band suppression + -55 dB (0.002) mute across [start - 250, end + 250]
  const rawSlicePath = `${outBedPath}.raw.pcm`;
  const notchedSlicePath = `${outBedPath}.notched.pcm`;

  await extractBedPcmSlice({
    ffmpeg,
    sourceAudioPath: audio48kPath,
    outPcmPath: rawSlicePath,
    rangeStartMs,
    sourceOffsetMs,
    totalDurMs,
    hasSlowdown,
    partitions,
  });

  // Apply aggressive center-channel vocal cancellation + vocal-band suppression inside speech slots
  const notchRes = await spawnCommand(ffmpeg, [
    '-y',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    rawSlicePath,
    '-af',
    'pan=stereo|c0=c0-c1|c1=c1-c0,highpass=f=80,bandreject=f=600:t=h:w=500,bandreject=f=1400:t=h:w=900,bandreject=f=2600:t=h:w=1200',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    's16le',
    notchedSlicePath,
  ]);
  const hasNotchedTrack = notchRes.code === 0 && (await fileExists(notchedSlicePath));
  if (!hasNotchedTrack) {
    console.warn(`[AudioDsp] Vocal cancellation/notch filter warning: ${notchRes.stderr.slice(-500)}`);
  }

  // Fallback -55 dB (~0.0018, <= 0.002) mute inside [start - 250ms, end + 250ms] so original speech never bleeds through
  const duckGain = Math.min(0.002, Math.pow(10, -55 / 20));
  console.log(
    `[AudioDsp] Background bed using fallback mode (-55 dB / volume=${duckGain.toFixed(4)} across ${mergedIntervals.length} speech interval(s), +-250 ms).`,
  );

  const inHandle = await fs.open(rawSlicePath, 'r');
  const notchedHandle = hasNotchedTrack ? await fs.open(notchedSlicePath, 'r') : null;
  const outHandle = await fs.open(outBedPath, 'w');
  try {
    const stat = await inHandle.stat();
    const notchedStat = notchedHandle ? await notchedHandle.stat() : null;
    await outHandle.write(createStereo48kWavHeader(totalPcmBytes));

    const chunkFrames = 48000 * 10; // 10s streaming buffer
    const chunkBuf = Buffer.allocUnsafe(chunkFrames * 4);
    const notchedBuf = notchedHandle ? Buffer.allocUnsafe(chunkFrames * 4) : null;
    const intervalCursor = { idx: 0 };
    let framesWritten = 0;

    while (framesWritten < totalFrames) {
      const framesThisChunk = Math.min(chunkFrames, totalFrames - framesWritten);
      const bytesNeeded = framesThisChunk * 4;
      const offsetBytes = framesWritten * 4;

      chunkBuf.fill(0, 0, bytesNeeded);
      if (offsetBytes < stat.size) {
        const readable = Math.min(bytesNeeded, stat.size - offsetBytes);
        await inHandle.read(chunkBuf, 0, readable, offsetBytes);
      }

      if (notchedHandle && notchedBuf && notchedStat) {
        notchedBuf.fill(0, 0, bytesNeeded);
        if (offsetBytes < notchedStat.size) {
          const readableN = Math.min(bytesNeeded, notchedStat.size - offsetBytes);
          await notchedHandle.read(notchedBuf, 0, readableN, offsetBytes);
        }
      }

      for (let f = 0; f < framesThisChunk; f++) {
        const ms = ((framesWritten + f) / 48000) * 1000;
        const alpha = speechAlphaAtMs(ms, intervalCursor);
        if (alpha > 0.001) {
          const bytePos = f * 4;
          const rawL = chunkBuf.readInt16LE(bytePos);
          const rawR = chunkBuf.readInt16LE(bytePos + 2);
          const notchL = notchedBuf ? notchedBuf.readInt16LE(bytePos) : rawL;
          const notchR = notchedBuf ? notchedBuf.readInt16LE(bytePos + 2) : rawR;
          const wRaw = 1 - alpha;
          const wNotch = alpha * duckGain;
          const l = Math.round(rawL * wRaw + notchL * wNotch);
          const r = Math.round(rawR * wRaw + notchR * wNotch);
          chunkBuf.writeInt16LE(Math.max(-32768, Math.min(32767, l)), bytePos);
          chunkBuf.writeInt16LE(Math.max(-32768, Math.min(32767, r)), bytePos + 2);
        }
      }

      await outHandle.write(chunkBuf, 0, bytesNeeded);
      framesWritten += framesThisChunk;
    }
  } finally {
    await inHandle.close();
    if (notchedHandle) await notchedHandle.close();
    await outHandle.close();
    await fs.unlink(rawSlicePath).catch(() => {});
    await fs.unlink(notchedSlicePath).catch(() => {});
  }
}

/**
 * Step F (Canvas Placement): Places each 48 kHz dub clip at its exact output start_ms
 * onto a streaming Float32 stereo canvas sized to totalDurMs (or rangeEndMs - rangeStartMs).
 */
export async function assembleDubCanvas48k(params: {
  clips: Array<{ wavPath: string; startMs: number; durationMs: number }>;
  rangeStartMs: number;
  rangeEndMs: number;
  totalDurMs?: number;
  outCanvasPath: string;
}): Promise<{ hasNonSilentDub: boolean }> {
  const { clips, rangeStartMs, rangeEndMs, outCanvasPath } = params;
  await fs.mkdir(path.dirname(outCanvasPath), { recursive: true });

  const totalDurMs = Math.max(100, params.totalDurMs ?? rangeEndMs - rangeStartMs);
  const totalFrames = Math.max(1, Math.round((totalDurMs / 1000) * 48000));
  const totalPcmBytes = totalFrames * 4;

  const placedClips = await Promise.all(
    clips.map(async (c) => {
      const rawBuf = await fs.readFile(c.wavPath);
      const { dataOffset, dataBytes } = findWavDataOffset(rawBuf);
      const startFrame = Math.max(0, Math.round(((c.startMs - rangeStartMs) / 1000) * 48000));
      const frameCount = Math.floor(dataBytes / 4);
      return {
        rawBuf,
        dataOffset,
        startFrame,
        endFrame: startFrame + frameCount,
        frameCount,
      };
    }),
  );

  let hasNonSilentDub = false;
  const outHandle = await fs.open(outCanvasPath, 'w');
  try {
    await outHandle.write(createStereo48kWavHeader(totalPcmBytes));

    const chunkFrames = 48000 * 10; // 10s Float32 chunk
    const floatMix = new Float32Array(chunkFrames * 2);
    const pcmOut = Buffer.allocUnsafe(chunkFrames * 4);
    let cursorFrame = 0;

    while (cursorFrame < totalFrames) {
      const framesThisChunk = Math.min(chunkFrames, totalFrames - cursorFrame);
      const chunkEndFrame = cursorFrame + framesThisChunk;
      floatMix.fill(0, 0, framesThisChunk * 2);

      for (const clip of placedClips) {
        if (clip.endFrame <= cursorFrame || clip.startFrame >= chunkEndFrame) {
          continue;
        }
        const overlapStart = Math.max(cursorFrame, clip.startFrame);
        const overlapEnd = Math.min(chunkEndFrame, clip.endFrame);
        for (let globalFrame = overlapStart; globalFrame < overlapEnd; globalFrame++) {
          const clipFrame = globalFrame - clip.startFrame;
          const srcByte = clip.dataOffset + clipFrame * 4;
          if (srcByte + 4 > clip.rawBuf.length) break;

          const lFloat = clip.rawBuf.readInt16LE(srcByte) / 32768;
          const rFloat = clip.rawBuf.readInt16LE(srcByte + 2) / 32768;

          const mixIdx = (globalFrame - cursorFrame) * 2;
          floatMix[mixIdx] += lFloat;
          floatMix[mixIdx + 1] += rFloat;
          hasNonSilentDub = true;
        }
      }

      for (let f = 0; f < framesThisChunk; f++) {
        const idx = f * 2;
        let l = floatMix[idx];
        let r = floatMix[idx + 1];
        if (Math.abs(l) > 0.98) l = Math.tanh(l);
        if (Math.abs(r) > 0.98) r = Math.tanh(r);
        pcmOut.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), f * 4);
        pcmOut.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), f * 4 + 2);
      }

      await outHandle.write(pcmOut, 0, framesThisChunk * 4);
      cursorFrame += framesThisChunk;
    }
  } finally {
    await outHandle.close();
  }

  return { hasNonSilentDub };
}

export function formatSrtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const remMs = safe % 1000;
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},${String(remMs).padStart(3, '0')}`
  );
}

export async function writeSynchronizedSrtFile(params: {
  outSrtPath: string;
  dubSegments: DubSegment[];
  rangeStartMs: number;
  lang?: TargetLang;
}): Promise<string> {
  const { outSrtPath, dubSegments, rangeStartMs, lang } = params;
  await fs.mkdir(path.dirname(outSrtPath), { recursive: true });
  const splitCues: Array<{ startMs: number; endMs: number; text: string }> = [];
  for (const s of dubSegments) {
    const text = s.tgt_text.trim();
    if (!text) continue;
    const startRel = Math.max(0, (s.effective_start_ms ?? s.start_ms) - rangeStartMs);
    const endRel = Math.max(
      startRel + 200,
      Math.max(s.effective_end_ms ?? s.end_ms, (s.effective_start_ms ?? s.start_ms) + s.tts_ms) -
        rangeStartMs,
    );
    splitCues.push(
      ...splitSubtitleCue(
        { startMs: startRel, endMs: endRel, text },
        { lang: lang ?? s.lang },
      ),
    );
  }
  const srtLines = splitCues.map(
    (cue, idx) =>
      `${idx + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`,
  );
  await fs.writeFile(outSrtPath, srtLines.join('\n'), 'utf-8');
  return outSrtPath;
}

/**
 * Step F & H: loudnorm dub track, mix with ducked bed, optionally slow affected video units down to 0.65x,
 * trim/pad to exact video duration, mux AAC 128k 44.1kHz stereo, write split SRT, and validate |A - V| <= 40 ms.
 */
export async function mixAndMuxDubbedOutput(params: {
  projectId: string;
  lang: TargetLang;
  sourceVideoPath: string;
  canvasPath: string;
  hasNonSilentDub: boolean;
  bedPath: string;
  rangeStartMs: number;
  rangeEndMs: number;
  isFullVideo: boolean;
  partitions?: TimelinePartition[];
  dubSegments: DubSegment[];
  ttsVolumePct?: number;
  outPaths?: {
    mp4Path: string;
    wavPath: string;
    srtPath: string;
    reportPath: string;
    dubNormPath?: string;
    sliceVideoPath?: string;
  };
}): Promise<DubValidationReport> {
  const { ffmpeg } = requireFfmpeg();
  const {
    projectId,
    lang,
    sourceVideoPath,
    canvasPath,
    hasNonSilentDub,
    bedPath,
    rangeStartMs,
    rangeEndMs,
    isFullVideo,
    partitions,
    dubSegments,
    ttsVolumePct,
    outPaths,
  } = params;

  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.dubDir, { recursive: true });
  await fs.mkdir(paths.outDir, { recursive: true });

  const langTag = lang === 'my-MM' ? 'mya' : 'eng';
  const dubNormPath = outPaths?.dubNormPath ?? path.join(paths.dubDir, `dub_norm_${lang}.wav`);
  const outWavPath = outPaths?.wavPath ?? path.join(paths.dubDir, `dub_${lang}.wav`);
  const outMp4Path = outPaths?.mp4Path ?? path.join(paths.outDir, `dub_${lang}.mp4`);
  const outSrtPath = outPaths?.srtPath ?? path.join(paths.outDir, `dub_${lang}.srt`);
  const outReportPath = outPaths?.reportPath ?? path.join(paths.outDir, `report_${lang}.json`);
  await fs.mkdir(path.dirname(dubNormPath), { recursive: true });
  await fs.mkdir(path.dirname(outWavPath), { recursive: true });
  await fs.mkdir(path.dirname(outMp4Path), { recursive: true });
  if (!outPaths?.wavPath) {
    await fs.unlink(path.join(paths.outDir, `dub_${lang}.wav`)).catch(() => {});
  }

  // 1. Loudnorm ONLY the dub track (fallback to raw canvas if silent)
  if (hasNonSilentDub) {
    const rNorm = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      canvasPath,
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      dubNormPath,
    ]);
    if (rNorm.code !== 0) {
      throw new Error(`FFmpeg loudnorm failed: ${rNorm.stderr.slice(-4000)}`);
    }
  } else {
    await fs.copyFile(canvasPath, dubNormPath);
  }

  // 2. Prepare target video source (piecewise slow-down if video_rate < 1, else untouched copy / slice)
  const proxyFallbackPath = path.join(paths.workDir, 'proxy_480p.mp4');
  const resolvedVideoSource = (await fileExists(sourceVideoPath))
    ? sourceVideoPath
    : (await fileExists(proxyFallbackPath))
      ? proxyFallbackPath
      : sourceVideoPath;
  if (!(await fileExists(resolvedVideoSource))) {
    throw new Error(`No video file found on disk (${path.basename(sourceVideoPath)} or proxy_480p.mp4).`);
  }

  let videoForMux = resolvedVideoSource;
  const sliceVideoPath =
    outPaths?.sliceVideoPath ?? path.join(paths.dubDir, `video_slice_${lang}.mp4`);
  await fs.mkdir(path.dirname(sliceVideoPath), { recursive: true });
  const hasSlowdown = Boolean(partitions && partitions.some((p) => p.rate < 0.999));

  if (hasSlowdown && partitions && partitions.length > 0) {
    const seekBaseMs = rangeStartMs > 0 ? rangeStartMs : 0;
    const fpsStr = await probeVideoFps(resolvedVideoSource);
    const fpsVal = parseFpsFraction(fpsStr);
    const splitHeader =
      partitions.length > 1
        ? `[0:v]fps=${fpsStr},setpts=PTS-STARTPTS,split=${partitions.length}${partitions.map((_, idx) => `[vin${idx}]`).join('')};`
        : `[0:v]fps=${fpsStr},setpts=PTS-STARTPTS[vin0];`;
    let cumFrames = 0;
    const filterParts = partitions.map((p, idx) => {
      const sSec = Math.max(0, (p.srcStartMs - seekBaseMs) / 1000).toFixed(4);
      const eSec = Math.max(0, (p.srcEndMs - seekBaseMs) / 1000).toFixed(4);
      const cumEndFrames = Math.max(cumFrames + 1, Math.round((p.outEndMs / 1000) * fpsVal));
      const partFrames = Math.max(1, cumEndFrames - cumFrames);
      cumFrames = cumEndFrames;
      const setptsExpr =
        p.rate < 0.999
          ? `setpts=(PTS-STARTPTS)/${p.rate.toFixed(6)}`
          : 'setpts=PTS-STARTPTS';
      return `[vin${idx}]trim=start=${sSec}:end=${eSec},${setptsExpr},fps=${fpsStr},tpad=stop_mode=clone:stop_duration=1.0,trim=end_frame=${partFrames},setpts=PTS-STARTPTS[v${idx}]`;
    });
    const concatIn = partitions.map((_, idx) => `[v${idx}]`).join('');
    const filterComplex = `${splitHeader}${filterParts.join(';')};${concatIn}concat=n=${partitions.length}:v=1:a=0[vout]`;

    const seekInputArgs =
      seekBaseMs > 0
        ? [
            '-ss',
            (seekBaseMs / 1000).toFixed(4),
            '-t',
            (Math.max(500, rangeEndMs - seekBaseMs + 500) / 1000).toFixed(4),
          ]
        : !isFullVideo
          ? ['-t', (Math.max(500, rangeEndMs + 500) / 1000).toFixed(4)]
          : [];

    const useFilterScript = filterComplex.length > 16000;
    const filterScriptPath = `${sliceVideoPath}.vfilter_${process.pid}_${Date.now()}.txt`;
    if (useFilterScript) {
      await fs.writeFile(filterScriptPath, filterComplex, 'utf-8');
    }
    try {
      const rSlow = await spawnFfmpegVideoEncodeWithHwFallback({
        ffmpeg,
        prefixArgs: [
          '-y',
          ...seekInputArgs,
          '-i',
          resolvedVideoSource,
          ...(useFilterScript
            ? ['-filter_complex_script', filterScriptPath]
            : ['-filter_complex', filterComplex]),
          '-map',
          '[vout]',
        ],
        suffixArgs: ['-an', '-video_track_timescale', '90000'],
        outputPath: sliceVideoPath,
        cpuCrf: '20',
      });
      if (rSlow.code !== 0) {
        throw new Error(`FFmpeg piecewise video slow-down failed: ${rSlow.stderr.slice(-4000)}`);
      }
    } finally {
      if (useFilterScript) {
        await fs.unlink(filterScriptPath).catch(() => {});
      }
    }
    videoForMux = sliceVideoPath;
  } else if (!isFullVideo) {
    const startSec = (rangeStartMs / 1000).toFixed(4);
    const durSec = Math.max(0.5, (rangeEndMs - rangeStartMs) / 1000).toFixed(4);
    const fpsStr = await probeVideoFps(resolvedVideoSource);
    const fpsVal = parseFpsFraction(fpsStr);
    const targetDurMs =
      partitions && partitions.length > 0
        ? partitions[partitions.length - 1].outEndMs
        : Math.max(500, rangeEndMs - rangeStartMs);
    const targetFrames = Math.max(1, Math.round((targetDurMs / 1000) * fpsVal));
    const rSlice = await spawnFfmpegVideoEncodeWithHwFallback({
      ffmpeg,
      prefixArgs: ['-y', '-ss', startSec, '-t', durSec, '-i', resolvedVideoSource],
      suffixArgs: [
        '-vf',
        `setpts=PTS-STARTPTS,fps=${fpsStr},tpad=stop_mode=clone:stop_duration=1.0,trim=end_frame=${targetFrames},setpts=PTS-STARTPTS`,
        '-an',
        '-video_track_timescale',
        '90000',
      ],
      outputPath: sliceVideoPath,
      cpuCrf: '20',
    });
    if (rSlice.code !== 0) {
      throw new Error(`Failed slicing test clip video: ${rSlice.stderr.slice(-4000)}`);
    }
    videoForMux = sliceVideoPath;
  }

  const targetVideoProbe = await probeMediaDurationsMs(videoForMux);
  const exactVideoDurMs = Math.max(200, targetVideoProbe.videoMs || targetVideoProbe.formatMs);
  const exactVideoDurSec = (exactVideoDurMs / 1000).toFixed(4);

  // 3. Boost dubbed TTS voice gain (default 150% = 1.5x / +3.5 dB) with soft limiter (0.95), mix with bed, trim/pad
  const configuredVolPct = ttsVolumePct ?? getConfig().TTS_VOLUME_PCT ?? 150;
  const clampedVolPct = Math.max(100, Math.min(200, Math.round(configuredVolPct)));
  const dubGain = (clampedVolPct / 100).toFixed(3);
  const rMix = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    dubNormPath,
    '-i',
    bedPath,
    '-filter_complex',
    `[0:a]volume=${dubGain},alimiter=limit=0.95[dub];[dub][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,apad,atrim=0:${exactVideoDurSec}[outa]`,
    '-map',
    '[outa]',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outWavPath,
  ]);
  if (rMix.code !== 0) {
    throw new Error(`FFmpeg mix + trim/pad failed: ${rMix.stderr.slice(-4000)}`);
  }

  // 4. Mux video (-c:v copy) + AAC 128k 44.1kHz stereo (pad tail + exact -t to avoid AAC priming shortfall)
  let rMux = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    videoForMux,
    '-i',
    outWavPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-af',
    'apad',
    '-t',
    exactVideoDurSec,
    `-metadata:s:a:0`,
    `language=${langTag}`,
    '-movflags',
    '+faststart',
    outMp4Path,
  ]);

  if (rMux.code !== 0) {
    rMux = await spawnFfmpegVideoEncodeWithHwFallback({
      ffmpeg,
      prefixArgs: ['-y', '-i', videoForMux, '-i', outWavPath, '-map', '0:v:0', '-map', '1:a:0'],
      suffixArgs: [
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-af',
        'apad',
        '-t',
        exactVideoDurSec,
        '-metadata:s:a:0',
        `language=${langTag}`,
        '-movflags',
        '+faststart',
      ],
      outputPath: outMp4Path,
      cpuCrf: '20',
    });
    if (rMux.code !== 0) {
      throw new Error(`FFmpeg MP4 mux failed: ${rMux.stderr.slice(-4000)}`);
    }
  }

  // 5. Generate split 1-2 line SRT shifted to output timeline
  await writeSynchronizedSrtFile({
    outSrtPath,
    dubSegments,
    rangeStartMs,
    lang,
  });

  // 6. Step H Validation: check |audio - video| <= 40ms + flagged overflow/needs_review
  const finalProbe = await probeMediaDurationsMs(outMp4Path);
  const vMs = finalProbe.videoMs || finalProbe.formatMs;
  const aMs = finalProbe.audioMs || finalProbe.formatMs;
  const avDiffMs = Math.abs(vMs - aMs);

  const relWavFile = path.relative(paths.root, outWavPath).replace(/\\/g, '/');

  const report: DubValidationReport = {
    lang,
    video_duration_ms: vMs,
    audio_duration_ms: aMs,
    av_diff_ms: avDiffMs,
    passed_40ms: avDiffMs <= 40,
    range_start_ms: rangeStartMs,
    range_end_ms: rangeEndMs,
    is_full_video: isFullVideo,
    total_segments: dubSegments.length,
    ok_count: dubSegments.filter((s) => s.status === 'ok').length,
    compressed_count: dubSegments.filter((s) => s.status === 'compressed').length,
    retranslated_count: dubSegments.filter((s) => s.status === 'retranslated').length,
    overflow_count: dubSegments.filter((s) => s.status === 'overflow').length,
    needs_review_count: dubSegments.filter((s) => s.status === 'needs_review').length,
    flagged_segments: dubSegments
      .filter((s) => s.status === 'overflow' || s.status === 'needs_review')
      .map((s) => ({
        id: s.id,
        status: s.status,
        slot_ms: s.slot_ms,
        tts_ms: s.tts_ms,
        speaker: s.speaker,
        tgt_text: s.tgt_text,
      })),
    mp4_file: `out/dub_${lang}.mp4`,
    wav_file: relWavFile.startsWith('..') ? `work/dub/dub_${lang}.wav` : relWavFile,
    srt_file: `out/dub_${lang}.srt`,
    generated_at: new Date().toISOString(),
  };

  const tmpReport = `${outReportPath}.tmp`;
  await fs.writeFile(tmpReport, JSON.stringify(report, null, 2), 'utf-8');
  await fs.rename(tmpReport, outReportPath);

  return report;
}

export async function muxDualLanguageMp4(params: {
  projectId: string;
  myMp4Path: string;
  enWavPath: string;
}): Promise<string> {
  const { ffmpeg } = requireFfmpeg();
  const paths = getProjectPaths(params.projectId);
  const outDualPath = path.join(paths.outDir, 'dub_dual.mp4');
  const myProbe = await probeMediaDurationsMs(params.myMp4Path);
  const exactDurSec = (Math.max(200, myProbe.videoMs || myProbe.formatMs) / 1000).toFixed(4);

  const res = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    params.myMp4Path,
    '-i',
    params.enWavPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a:0',
    'copy',
    '-c:a:1',
    'aac',
    '-b:a:1',
    '128k',
    '-ac:a:1',
    '2',
    '-ar:a:1',
    '44100',
    '-filter:a:1',
    'apad',
    '-t',
    exactDurSec,
    '-metadata:s:a:0',
    'language=mya',
    '-metadata:s:a:1',
    'language=eng',
    '-movflags',
    '+faststart',
    outDualPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`Dual-track MP4 mux failed: ${res.stderr.slice(-4000)}`);
  }
  return 'out/dub_dual.mp4';
}

export async function extractChunk48kSlice(params: {
  sourceAudio48kPath: string;
  outChunk48kPath: string;
  startMs: number;
  endMs: number;
}): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  const { sourceAudio48kPath, outChunk48kPath, startMs, endMs } = params;
  await fs.mkdir(path.dirname(outChunk48kPath), { recursive: true });
  const durMs = Math.max(200, endMs - startMs);
  const res = await spawnCommand(ffmpeg, [
    '-y',
    '-ss',
    (startMs / 1000).toFixed(4),
    '-t',
    (durMs / 1000).toFixed(4),
    '-i',
    sourceAudio48kPath,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outChunk48kPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`Failed slicing 48kHz audio chunk: ${res.stderr.slice(-4000)}`);
  }
}

function parseSrtTimestampToMs(ts: string): number {
  const m = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(ts.trim());
  if (!m) return 0;
  return (
    Number(m[1]) * 3600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4])
  );
}

/**
 * Concatenates all completed chunk MP4s, WAVs, and SRT subtitles (with exact accumulated
 * duration offsets) into final full-length outputs using the FFmpeg concat demuxer.
 */
export async function concatenateChunkOutputs(params: {
  projectId: string;
  lang: TargetLang;
  chunkArtifacts: Array<{ mp4Path: string; wavPath: string; srtPath: string }>;
  dubSegments: DubSegment[];
  totalSourceDurationMs: number;
}): Promise<DubValidationReport> {
  const { ffmpeg } = requireFfmpeg();
  const { projectId, lang, chunkArtifacts, dubSegments, totalSourceDurationMs } = params;
  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.outDir, { recursive: true });
  await fs.mkdir(paths.dubDir, { recursive: true });

  const outMp4Path = path.join(paths.outDir, `dub_${lang}.mp4`);
  const outWavPath = path.join(paths.dubDir, `dub_${lang}.wav`);
  const outSrtPath = path.join(paths.outDir, `dub_${lang}.srt`);
  const outReportPath = path.join(paths.outDir, `report_${lang}.json`);
  await fs.unlink(path.join(paths.outDir, `dub_${lang}.wav`)).catch(() => {});

  const concatMp4ListPath = path.join(paths.dubDir, `concat_mp4_${lang}.txt`);
  const concatWavListPath = path.join(paths.dubDir, `concat_wav_${lang}.txt`);

  const escapeConcatPath = (p: string) => p.replace(/'/g, "'\\''");
  await fs.writeFile(
    concatMp4ListPath,
    chunkArtifacts.map((c) => `file '${escapeConcatPath(c.mp4Path)}'`).join('\n') + '\n',
    'utf-8',
  );
  await fs.writeFile(
    concatWavListPath,
    chunkArtifacts.map((c) => `file '${escapeConcatPath(c.wavPath)}'`).join('\n') + '\n',
    'utf-8',
  );

  // 1. Concatenate WAVs via concat demuxer
  const wavConcatRes = await spawnCommand(ffmpeg, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatWavListPath,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outWavPath,
  ]);
  if (wavConcatRes.code !== 0) {
    throw new Error(`FFmpeg chunk WAV concat failed: ${wavConcatRes.stderr.slice(-4000)}`);
  }

  // 2. Concatenate video-only streams via concat demuxer, then mux once with concatenated WAV
  // (avoids accumulating per-chunk AAC encoder priming padding across chunk seams)
  const langTag = lang === 'my-MM' ? 'mya' : 'eng';
  const concatVideoOnlyPath = path.join(paths.dubDir, `concat_video_${lang}_${process.pid}.mp4`);
  try {
    let vidConcatRes = await spawnCommand(ffmpeg, [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatMp4ListPath,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-an',
      concatVideoOnlyPath,
    ]);
    if (vidConcatRes.code !== 0) {
      vidConcatRes = await spawnFfmpegVideoEncodeWithHwFallback({
        ffmpeg,
        prefixArgs: ['-y', '-f', 'concat', '-safe', '0', '-i', concatMp4ListPath, '-map', '0:v:0'],
        suffixArgs: ['-an', '-video_track_timescale', '90000'],
        outputPath: concatVideoOnlyPath,
        cpuCrf: '20',
      });
      if (vidConcatRes.code !== 0) {
        throw new Error(`FFmpeg chunk video concat failed: ${vidConcatRes.stderr.slice(-4000)}`);
      }
    }

    const concatVidProbe = await probeMediaDurationsMs(concatVideoOnlyPath);
    const exactTotalDurSec = (
      Math.max(200, concatVidProbe.videoMs || concatVidProbe.formatMs) / 1000
    ).toFixed(4);

    let rMux = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      concatVideoOnlyPath,
      '-i',
      outWavPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-af',
      'apad',
      '-t',
      exactTotalDurSec,
      '-metadata:s:a:0',
      `language=${langTag}`,
      '-movflags',
      '+faststart',
      outMp4Path,
    ]);
    if (rMux.code !== 0) {
      rMux = await spawnFfmpegVideoEncodeWithHwFallback({
        ffmpeg,
        prefixArgs: ['-y', '-i', concatVideoOnlyPath, '-i', outWavPath, '-map', '0:v:0', '-map', '1:a:0'],
        suffixArgs: [
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-af',
          'apad',
          '-t',
          exactTotalDurSec,
          '-metadata:s:a:0',
          `language=${langTag}`,
          '-movflags',
          '+faststart',
        ],
        outputPath: outMp4Path,
        cpuCrf: '20',
      });
      if (rMux.code !== 0) {
        throw new Error(`FFmpeg chunk final MP4 mux failed: ${rMux.stderr.slice(-4000)}`);
      }
    }
  } finally {
    await fs.unlink(concatVideoOnlyPath).catch(() => {});
  }

  // 3. Merge chunk SRTs using each rendered chunk MP4's exact probed duration offset
  const mergedSrtBlocks: string[] = [];
  let accumulatedOffsetMs = 0;
  let cueSeq = 1;

  for (const chunk of chunkArtifacts) {
    if (await fileExists(chunk.srtPath)) {
      const rawSrt = await fs.readFile(chunk.srtPath, 'utf-8');
      const blocks = rawSrt.split(/\r?\n\r?\n+/).filter((b) => b.trim().length > 0);
      for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const tsLineIdx = lines.findIndex((l) => l.includes('-->'));
        if (tsLineIdx === -1) continue;
        const [startStr, endStr] = lines[tsLineIdx].split('-->').map((s) => s.trim());
        const startMs = accumulatedOffsetMs + parseSrtTimestampToMs(startStr);
        const endMs = Math.max(startMs + 200, accumulatedOffsetMs + parseSrtTimestampToMs(endStr));
        const body = lines.slice(tsLineIdx + 1).join('\n').trim();
        if (!body) continue;
        mergedSrtBlocks.push(
          `${cueSeq++}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${body}\n`,
        );
      }
    }
    const probe = await probeMediaDurationsMs(chunk.mp4Path);
    accumulatedOffsetMs += Math.max(0, probe.videoMs || probe.formatMs);
  }
  await fs.writeFile(outSrtPath, mergedSrtBlocks.join('\n'), 'utf-8');

  // 4. Final Step H validation report on concatenated MP4
  const finalProbe = await probeMediaDurationsMs(outMp4Path);
  const vMs = finalProbe.videoMs || finalProbe.formatMs;
  const aMs = finalProbe.audioMs || finalProbe.formatMs;
  const avDiffMs = Math.abs(vMs - aMs);

  const report: DubValidationReport = {
    lang,
    video_duration_ms: vMs,
    audio_duration_ms: aMs,
    av_diff_ms: avDiffMs,
    passed_40ms: avDiffMs <= 40,
    range_start_ms: 0,
    range_end_ms: totalSourceDurationMs || vMs,
    is_full_video: true,
    total_segments: dubSegments.length,
    ok_count: dubSegments.filter((s) => s.status === 'ok').length,
    compressed_count: dubSegments.filter((s) => s.status === 'compressed').length,
    retranslated_count: dubSegments.filter((s) => s.status === 'retranslated').length,
    overflow_count: dubSegments.filter((s) => s.status === 'overflow').length,
    needs_review_count: dubSegments.filter((s) => s.status === 'needs_review').length,
    flagged_segments: dubSegments
      .filter((s) => s.status === 'overflow' || s.status === 'needs_review')
      .map((s) => ({
        id: s.id,
        status: s.status,
        slot_ms: s.slot_ms,
        tts_ms: s.tts_ms,
        speaker: s.speaker,
        tgt_text: s.tgt_text,
      })),
    mp4_file: `out/dub_${lang}.mp4`,
    wav_file: `work/dub/dub_${lang}.wav`,
    srt_file: `out/dub_${lang}.srt`,
    generated_at: new Date().toISOString(),
  };

  const tmpReport = `${outReportPath}.tmp`;
  await fs.writeFile(tmpReport, JSON.stringify(report, null, 2), 'utf-8');
  await fs.rename(tmpReport, outReportPath);

  return report;
}

export async function concatenateSynchronizedSrtFiles(params: {
  outSrtPath: string;
  chunkArtifacts: Array<{ mp4Path: string; srtPath: string }>;
}): Promise<string> {
  const { outSrtPath, chunkArtifacts } = params;
  await fs.mkdir(path.dirname(outSrtPath), { recursive: true });
  const mergedSrtBlocks: string[] = [];
  let accumulatedOffsetMs = 0;
  let cueSeq = 1;

  for (const chunk of chunkArtifacts) {
    if (await fileExists(chunk.srtPath)) {
      const rawSrt = await fs.readFile(chunk.srtPath, 'utf-8');
      const blocks = rawSrt.split(/\r?\n\r?\n+/).filter((b) => b.trim().length > 0);
      for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const tsLineIdx = lines.findIndex((l) => l.includes('-->'));
        if (tsLineIdx === -1) continue;
        const [startStr, endStr] = lines[tsLineIdx].split('-->').map((s) => s.trim());
        const startMs = accumulatedOffsetMs + parseSrtTimestampToMs(startStr);
        const endMs = Math.max(startMs + 200, accumulatedOffsetMs + parseSrtTimestampToMs(endStr));
        const body = lines.slice(tsLineIdx + 1).join('\n').trim();
        if (!body) continue;
        mergedSrtBlocks.push(
          `${cueSeq++}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${body}\n`,
        );
      }
    }
    const probe = await probeMediaDurationsMs(chunk.mp4Path);
    accumulatedOffsetMs += Math.max(0, probe.videoMs || probe.formatMs);
  }
  await fs.writeFile(outSrtPath, mergedSrtBlocks.join('\n'), 'utf-8');
  return outSrtPath;
}


