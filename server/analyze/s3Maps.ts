import path from 'node:path';
import { z } from 'zod';
import type { Project } from '../../shared/projectTypes.ts';
import { getConfig } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import { hashFileWithSalt, hashString, readProjectCache, writeProjectCache } from './cache.ts';

const SilenceCacheSchema = z.object({
  silence_ms: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
});

const SceneCutsCacheSchema = z.object({
  scene_cuts_ms: z.array(z.number().int().nonnegative()),
});

export async function runS3Maps(projectId: string, force = false): Promise<Project> {
  const { ffmpeg } = requireFfmpeg();
  const cfg = getConfig();
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (!project.upload.completed || !project.video.filename) {
    throw new Error('Upload must complete before running S3 Maps.');
  }

  const paths = getProjectPaths(projectId);
  const audio16kPath = path.join(paths.workDir, 'audio_16k.wav');
  const proxyPath = path.join(paths.workDir, 'proxy_480p.mp4');
  const sourcePath = path.join(paths.sourceDir, project.video.filename);
  const sceneInputPath = (await fileExists(proxyPath)) ? proxyPath : sourcePath;

  const setMapsProgress = async (
    pct: number,
    message: string,
    status: 'running' | 'done' | 'error' = 'running',
    error?: string,
  ) => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        maps: {
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
      stage: 'maps',
      progress_pct: pct,
      message,
      project: updated,
    });
    return updated;
  };

  const hasSceneInput = await fileExists(sceneInputPath);
  const s3StageHash =
    hasSceneInput
      ? await hashFileWithSalt(
          sceneInputPath,
          `s3-stage|threshold:${cfg.SCENE_THRESHOLD}|noise:${cfg.SILENCE_NOISE_DB}|min:${cfg.SILENCE_MIN_SEC}|vstart:${project.video.v_start_ms}|hasAudio:${project.video.has_audio}`,
        )
      : hashString(
          `s3-stage-no-video|dur:${project.video.duration_ms}|noise:${cfg.SILENCE_NOISE_DB}|min:${cfg.SILENCE_MIN_SEC}`,
        );

  if (
    !force &&
    project.stages.maps.status === 'done' &&
    project.scene_cuts_ms.length > 0 &&
    (!project.video.has_audio || project.silence_ms.length >= 0) &&
    (!project.stage_hashes?.s3 || project.stage_hashes.s3 === s3StageHash)
  ) {
    return project;
  }

  try {
    // 1. silencedetect (noise -35 dB, d 0.4)
    let silenceIntervals: Array<[number, number]> = [];
    if (!project.video.has_audio || !(await fileExists(audio16kPath))) {
      silenceIntervals = [[0, Math.max(0, project.video.duration_ms)]];
    } else {
      const silenceHash = await hashFileWithSalt(
        audio16kPath,
        `s3-silence|noise:${cfg.SILENCE_NOISE_DB}|min:${cfg.SILENCE_MIN_SEC}`,
      );
      const cachedSilence = !force
        ? await readProjectCache(projectId, `s3_silence_${silenceHash}`, SilenceCacheSchema)
        : null;

      if (cachedSilence) {
        await setMapsProgress(40, `S3: Loaded cached silence map (${cachedSilence.silence_ms.length} intervals).`);
        silenceIntervals = cachedSilence.silence_ms;
      } else {
        await setMapsProgress(
          15,
          `S3: Running silencedetect (noise=${cfg.SILENCE_NOISE_DB}dB, d=${cfg.SILENCE_MIN_SEC}s)...`,
        );
        const silenceRes = await spawnCommand(ffmpeg, [
          '-i',
          audio16kPath,
          '-af',
          `silencedetect=noise=${cfg.SILENCE_NOISE_DB}dB:d=${cfg.SILENCE_MIN_SEC}`,
          '-f',
          'null',
          '-',
        ]);
        if (silenceRes.code !== 0) {
          throw new Error(`S3 silencedetect failed: ${silenceRes.stderr.slice(-4000)}`);
        }

        const intervals: Array<[number, number]> = [];
        let openStartMs: number | null = null;
        for (const line of silenceRes.stderr.split(/\r?\n/)) {
          const startMatch = /silence_start:\s*([\d.]+)/.exec(line);
          if (startMatch) {
            openStartMs = Math.max(0, Math.round(Number(startMatch[1]) * 1000));
            continue;
          }
          const endMatch = /silence_end:\s*([\d.]+)/.exec(line);
          if (endMatch) {
            const endMs = Math.max(0, Math.round(Number(endMatch[1]) * 1000));
            const startMs = openStartMs ?? Math.max(0, endMs - Math.round(cfg.SILENCE_MIN_SEC * 1000));
            if (endMs > startMs) {
              intervals.push([startMs, endMs]);
            }
            openStartMs = null;
          }
        }
        if (openStartMs !== null && project.video.duration_ms > openStartMs) {
          intervals.push([openStartMs, project.video.duration_ms]);
        }
        silenceIntervals = intervals;
        await writeProjectCache(projectId, `s3_silence_${silenceHash}`, { silence_ms: silenceIntervals });
      }
    }

    // Write silence_ms to project.json immediately before scene cut scan
    await updateProject(projectId, (cur) => ({
      ...cur,
      silence_ms: silenceIntervals,
    }));

    // 2. Scene cuts (select='gt(scene,0.35)')
    const sceneHash = await hashFileWithSalt(
      sceneInputPath,
      `s3-scenes|threshold:${cfg.SCENE_THRESHOLD}|vstart:${project.video.v_start_ms}`,
    );
    const cachedScenes = !force
      ? await readProjectCache(projectId, `s3_scenes_${sceneHash}`, SceneCutsCacheSchema)
      : null;

    let sceneCutsMs: number[];
    if (cachedScenes) {
      await setMapsProgress(90, `S3: Loaded cached scene cuts (${cachedScenes.scene_cuts_ms.length} cuts).`);
      sceneCutsMs = cachedScenes.scene_cuts_ms;
    } else {
      await setMapsProgress(55, `S3: Detecting scene cuts (gt(scene,${cfg.SCENE_THRESHOLD}))...`);
      const durationMs = Math.max(1, project.video.duration_ms);
      let lastEmitAt = 0;

      const sceneRes = await spawnCommand(
        ffmpeg,
        [
          '-i',
          sceneInputPath,
          '-vf',
          `select='gt(scene,${cfg.SCENE_THRESHOLD})',showinfo`,
          '-fps_mode',
          'vfr',
          '-f',
          'null',
          '-',
        ],
        {
          onStderrLine: (line) => {
            const timeMatch = /pts_time:\s*([\d.]+)/.exec(line);
            if (timeMatch && Date.now() - lastEmitAt > 1500) {
              lastEmitAt = Date.now();
              const rawMs = Math.round(Number(timeMatch[1]) * 1000) - project.video.v_start_ms;
              const pct = Math.min(95, 55 + Math.round((Math.max(0, rawMs) / durationMs) * 40));
              void setMapsProgress(pct, `S3: Scanning scene cuts (${pct}%)...`);
            }
          },
        },
      );
      if (sceneRes.code !== 0) {
        throw new Error(`S3 scene detection failed: ${sceneRes.stderr.slice(-4000)}`);
      }

      const cutSet = new Set<number>([0]);
      for (const line of sceneRes.stderr.split(/\r?\n/)) {
        const ptsMatch = /pts_time:\s*([\d.]+)/.exec(line);
        if (ptsMatch) {
          const adjustedMs = Math.max(
            0,
            Math.round(Number(ptsMatch[1]) * 1000) - (sceneInputPath === sourcePath ? project.video.v_start_ms : 0),
          );
          if (adjustedMs <= project.video.duration_ms + 500) {
            cutSet.add(adjustedMs);
          }
        }
      }
      sceneCutsMs = Array.from(cutSet).sort((a, b) => a - b);
      await writeProjectCache(projectId, `s3_scenes_${sceneHash}`, { scene_cuts_ms: sceneCutsMs });
    }

    const finalProject = await updateProject(projectId, (cur) => ({
      ...cur,
      silence_ms: silenceIntervals,
      scene_cuts_ms: sceneCutsMs,
      stage_hashes: {
        ...cur.stage_hashes,
        s3: s3StageHash,
      },
      stages: {
        ...cur.stages,
        maps: {
          status: 'done',
          progress_pct: 100,
          message: `S3 complete: ${silenceIntervals.length} silence intervals, ${sceneCutsMs.length} scene cuts.`,
          updated_at: new Date().toISOString(),
        },
      },
    }));

    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'maps',
      progress_pct: 100,
      message: finalProject.stages.maps.message,
      project: finalProject,
    });
    return finalProject;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setMapsProgress(0, msg, 'error', msg);
    throw err;
  }
}
