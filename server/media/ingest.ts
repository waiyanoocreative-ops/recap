import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../../shared/projectTypes.ts';
import { hashFileWithSalt } from '../analyze/cache.ts';
import { getConfig } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { checkDiskSpace, ensureProjectDirs, getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import { requireFfmpeg, spawnCommand } from './binaries.ts';

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  start_time?: string;
  duration?: string;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    start_time?: string;
    size?: string;
  };
  streams?: FfprobeStream[];
}

function parseFrameRate(rate?: string): number {
  if (!rate || !rate.includes('/')) return Number(rate) || 0;
  const [numStr, denStr] = rate.split('/');
  const num = Number(numStr);
  const den = Number(denStr);
  if (!den || Number.isNaN(num) || Number.isNaN(den)) return 0;
  return Number((num / den).toFixed(3));
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'source_video.mp4';
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function handleUploadChunk(params: {
  projectId: string;
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  totalSize: number;
  chunkSize: number;
  buffer: Buffer;
}): Promise<{
  project: Project;
  completed: boolean;
  receivedChunks: number[];
}> {
  const { projectId, chunkIndex, totalChunks, totalSize, chunkSize, buffer } = params;
  const safeName = sanitizeFilename(params.filename);
  const existing = await getProject(projectId);
  if (!existing) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const paths = await ensureProjectDirs(projectId);
  const targetPath = path.join(paths.sourceDir, safeName);
  const tempPath = path.join(paths.sourceDir, `${safeName}.uploading`);

  if (chunkIndex === 0 || existing.upload.received_chunks.length === 0) {
    const requiredBytes = totalSize * 3;
    const disk = await checkDiskSpace(requiredBytes);
    if (!disk.sufficient) {
      const freeGb = (disk.freeBytes / 1024 ** 3).toFixed(2);
      const reqGb = (requiredBytes / 1024 ** 3).toFixed(2);
      throw new Error(
        `Insufficient free disk space. Need about 3x file size (${reqGb} GB free), but only ${freeGb} GB is available.`,
      );
    }
  }

  // Write chunk at exact byte offset so chunks are resumable by index
  const handle = await fs.open(tempPath, (await fileExists(tempPath)) ? 'r+' : 'w+');
  try {
    const offset = chunkIndex * chunkSize;
    await handle.write(buffer, 0, buffer.length, offset);
  } finally {
    await handle.close();
  }

  const updated = await updateProject(projectId, (proj) => {
    const set = new Set(proj.upload.received_chunks);
    set.add(chunkIndex);
    const sorted = Array.from(set).sort((a, b) => a - b);
    const completed = sorted.length === totalChunks;
    return {
      ...proj,
      video: {
        ...proj.video,
        filename: safeName,
        size_bytes: totalSize,
      },
      upload: {
        total_chunks: totalChunks,
        received_chunks: sorted,
        chunk_size_bytes: chunkSize,
        expected_size_bytes: totalSize,
        completed,
      },
    };
  });

  emitProjectEvent(projectId, {
    type: 'upload',
    progress_pct: Math.round((updated.upload.received_chunks.length / totalChunks) * 100),
    message: `Uploaded chunk ${updated.upload.received_chunks.length}/${totalChunks}`,
    project: updated,
  });

  if (updated.upload.completed) {
    await fs.rename(tempPath, targetPath);
    const afterIngest = await runS0Ingest(projectId);
    return {
      project: afterIngest,
      completed: true,
      receivedChunks: afterIngest.upload.received_chunks,
    };
  }

  return {
    project: updated,
    completed: false,
    receivedChunks: updated.upload.received_chunks,
  };
}

export async function runS0Ingest(projectId: string, force = false): Promise<Project> {
  const { ffmpeg, ffprobe } = requireFfmpeg();
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (!project.video.filename) throw new Error('No uploaded video file found in project.');

  const paths = getProjectPaths(projectId);
  const sourcePath = path.join(paths.sourceDir, project.video.filename);
  const audio16kPath = path.join(paths.workDir, 'audio_16k.wav');
  const audio48kPath = path.join(paths.workDir, 'audio_48k.wav');
  const proxy480Path = path.join(paths.workDir, 'proxy_480p.mp4');

  const hasSource = await fileExists(sourcePath);
  const audioReady = !project.video.has_audio || ((await fileExists(audio16kPath)) && (await fileExists(audio48kPath)));
  const proxyReady = project.mode !== 'recap' || (await fileExists(proxy480Path));

  // If restored from a proxy-only backup (without >200 MB original video), keep completed S0 intact
  if (!hasSource && project.stages.ingest.status === 'done' && audioReady && (await fileExists(proxy480Path))) {
    return project;
  }

  if (!hasSource) {
    throw new Error(`Source video missing at ${sourcePath}`);
  }

  const s0Hash = await hashFileWithSalt(sourcePath, `s0|mode:${project.mode}`);
  if (
    !force &&
    project.stages.ingest.status === 'done' &&
    audioReady &&
    proxyReady &&
    project.video.duration_ms > 0 &&
    (!project.stage_hashes?.s0 || project.stage_hashes.s0 === s0Hash)
  ) {
    return project;
  }

  const setIngestProgress = async (pct: number, message: string, status: 'running' | 'done' | 'error' = 'running', error?: string) => {
    const p = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        ingest: {
          status,
          progress_pct: pct,
          message,
          error,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: status === 'error' ? 'error' : 'stage',
      stage: 'ingest',
      progress_pct: pct,
      message,
      project: p,
    });
    return p;
  };

  try {
    await setIngestProgress(10, 'Running ffprobe stream inspection...');
    const probeRes = await spawnCommand(ffprobe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourcePath,
    ]);
    if (probeRes.code !== 0) {
      throw new Error(`ffprobe failed: ${probeRes.stderr || 'Unknown error'}`);
    }

    const probe = JSON.parse(probeRes.stdout) as FfprobeOutput;
    const videoStream = probe.streams?.find((s) => s.codec_type === 'video');
    const audioStream = probe.streams?.find((s) => s.codec_type === 'audio');
    if (!videoStream) {
      throw new Error('Uploaded file does not contain a valid video stream.');
    }

    const avgFps = parseFrameRate(videoStream.avg_frame_rate);
    const rFps = parseFrameRate(videoStream.r_frame_rate);
    const fps = avgFps || rFps || 30;
    const isVfr = Boolean(avgFps && rFps && Math.abs(rFps - avgFps) / Math.max(avgFps, 1) > 0.02);

    const rawDurationSec = Number(probe.format?.duration || videoStream.duration || 0);
    const durationMs = Math.max(0, Math.round(rawDurationSec * 1000));
    const vStartMs = Math.round(Number(videoStream.start_time ?? probe.format?.start_time ?? 0) * 1000);
    const aStartMs = audioStream
      ? Math.round(Number(audioStream.start_time ?? probe.format?.start_time ?? 0) * 1000)
      : vStartMs;
    const streamOffsetMs = aStartMs - vStartMs;
    const hasAudio = Boolean(audioStream);

    await updateProject(projectId, (cur) => ({
      ...cur,
      no_dialogue: !hasAudio ? true : cur.no_dialogue,
      video: {
        ...cur.video,
        fps,
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        is_vfr: isVfr,
        duration_ms: durationMs,
        v_start_ms: vStartMs,
        a_start_ms: aStartMs,
        stream_offset_ms: streamOffsetMs,
        has_audio: hasAudio,
      },
    }));

    if (hasAudio) {
      // Compensate A/V start_time offset so WAV sample 0 matches video v_start_ms
      const offsetFilterParts: string[] = [];
      const inputSeekArgs: string[] = [];
      if (streamOffsetMs > 0) {
        offsetFilterParts.push(`adelay=${streamOffsetMs}:all=1`);
      } else if (streamOffsetMs < 0) {
        inputSeekArgs.push('-ss', (Math.abs(streamOffsetMs) / 1000).toFixed(3));
      }

      await setIngestProgress(35, 'Extracting 16 kHz mono WAV for AI speech analysis...');
      const args16k = [
        '-y',
        ...inputSeekArgs,
        '-i',
        sourcePath,
        '-vn',
        ...(offsetFilterParts.length ? ['-af', offsetFilterParts.join(',')] : []),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        audio16kPath,
      ];
      const res16k = await spawnCommand(ffmpeg, args16k);
      if (res16k.code !== 0) {
        throw new Error(`16 kHz audio extraction failed: ${res16k.stderr.slice(-4000)}`);
      }

      await setIngestProgress(60, 'Extracting 48 kHz stereo WAV for broadcast mixing...');
      const args48k = [
        '-y',
        ...inputSeekArgs,
        '-i',
        sourcePath,
        '-vn',
        ...(offsetFilterParts.length ? ['-af', offsetFilterParts.join(',')] : []),
        '-ac',
        '2',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s16le',
        audio48kPath,
      ];
      const res48k = await spawnCommand(ffmpeg, args48k);
      if (res48k.code !== 0) {
        throw new Error(`48 kHz audio extraction failed: ${res48k.stderr.slice(-4000)}`);
      }
    }

    let proxyFileRel: string | undefined;
    if (project.mode === 'recap') {
      await setIngestProgress(
        80,
        isVfr
          ? 'Generating 480p constant-frame-rate (CFR) proxy for Recap Mode...'
          : 'Generating 480p low-bitrate proxy for Recap Mode...',
      );
      const targetFps = Math.min(30, Math.max(24, Math.round(fps) || 24));
      const proxyArgs = [
        '-y',
        '-i',
        sourcePath,
        '-vf',
        `scale=-2:480${isVfr ? `,fps=${targetFps}` : ''}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        ...(isVfr ? ['-fps_mode', 'cfr'] : []),
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
        proxy480Path,
      ];
      const resProxy = await spawnCommand(ffmpeg, proxyArgs);
      if (resProxy.code !== 0) {
        throw new Error(`480p proxy creation failed: ${resProxy.stderr.slice(-4000)}`);
      }
      proxyFileRel = 'work/proxy_480p.mp4';
    }

    const finalProject = await updateProject(projectId, (cur) => ({
      ...cur,
      video: {
        ...cur.video,
        proxy_480p_file: proxyFileRel ?? cur.video.proxy_480p_file,
      },
      stage_hashes: {
        ...cur.stage_hashes,
        s0: s0Hash,
      },
      stages: {
        ...cur.stages,
        ingest: {
          status: 'done',
          progress_pct: 100,
          message:
            project.mode === 'recap'
              ? 'Ingest complete: ffprobe + 16k/48k WAV + 480p CFR proxy ready.'
              : 'Ingest complete: ffprobe + 16k/48k WAV ready (video kept untouched for -c:v copy).',
          updated_at: new Date().toISOString(),
        },
      },
    }));

    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'ingest',
      progress_pct: 100,
      message: finalProject.stages.ingest.message,
      project: finalProject,
    });
    return finalProject;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setIngestProgress(0, msg, 'error', msg);
    throw err;
  }
}

export function getExpectedChunkSize(): number {
  return getConfig().CHUNK_SIZE_BYTES;
}
