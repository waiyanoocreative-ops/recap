import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  formatChunkClock,
  formatChunkProgressLabel,
  isLongVideoDuration,
  planSmartVideoChunks,
} from '../../shared/chunkPlanner.ts';
import {
  getVoiceGender,
  resolveStrictVoiceForSpeaker,
} from '../../shared/dubUtils.ts';
import {
  DubSegmentSchema,
  SpeakerInfoSchema,
  SpeechSegmentSchema,
  TargetLangSchema,
  TtsEngineTypeSchema,
  VideoChunkSchema,
  type ChunkProgress,
  type DubSegment,
  type DubValidationReport,
  type Project,
  type SpeakerInfo,
  type SpeechSegment,
  type TargetLang,
  type VideoChunk,
} from '../../shared/projectTypes.ts';
import { hashString } from '../analyze/cache.ts';
import { runS1OnChunkSlice } from '../analyze/s1SpeechMap.ts';
import { runS2SpeakersForChunk } from '../analyze/s2Speakers.ts';
import { runS3Maps } from '../analyze/s3Maps.ts';
import { geminiRuntime, getConfig } from '../config.ts';
import {
  assembleDubCanvas48k,
  buildDuckedBed48k,
  computePiecewiseTimeline,
  concatenateChunkOutputs,
  extractChunk48kSlice,
  mapSourceMsToOutputRelMs,
  mixAndMuxDubbedOutput,
  resolveBackgroundAudioMode,
} from '../dub/audioDsp.ts';
import {
  buildDubSlowIntervals,
  getClipAbsolutePath,
  MIN_DUB_VIDEO_RATE,
  runFitLoopForSegment,
} from '../dub/dubPipeline.ts';
import { resolveSingleTargetLang, rewriteSplitSrtFile } from '../dub/srtBuilder.ts';
import { buildDubSourceCues, countSyllables, type MergedDubCue } from '../dub/syllables.ts';
import {
  extractGlossaryForLang,
  resolveSpeakerVoicesForEngine,
  translateDubCuesBatched,
  type TranslatedCueItem,
} from '../dub/translate.ts';
import {
  RECAP_BASE_TTS_RATE,
  RECAP_MIN_TTS_VOLUME_PCT,
  RECAP_MIN_VIDEO_RATE,
  buildRecapSlowIntervals,
  runRecapFitLoopForSegment,
} from '../recap/recapSync.ts';
import { prepareRecapCues, translateRecapCuesBatched } from '../recap/recapTranslator.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { fileExists, runS0Ingest } from '../media/ingest.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import { formatChunkFailureMessage, withExponentialBackoffRetry } from '../utils/retry.ts';

const ChunkPlanFileSchema = z.object({
  duration_ms: z.number().nonnegative(),
  chunks: z.array(VideoChunkSchema),
  created_at: z.string(),
});

export type AnalyzeStageMode = 'all' | 's1_only' | 's2_only';

const ChunkAnalyzeCacheSchema = z.object({
  hash: z.string(),
  chunk_index: z.number().int().nonnegative(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  segments: z.array(SpeechSegmentSchema),
  chunk_speakers: z.record(z.string(), SpeakerInfoSchema),
  models_used: z.array(z.string()).default([]),
  s2_done: z.boolean().default(true),
});

const ChunkConsistencySchema = z.object({
  glossary_by_lang: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  speaker_voices: z
    .record(
      z.string(),
      z.object({
        engine: TtsEngineTypeSchema,
        name: z.string(),
      }),
    )
    .default({}),
  updated_at: z.string().optional(),
});

const ChunkRenderLangCacheSchema = z.object({
  hash: z.string(),
  lang: TargetLangSchema,
  chunk_index: z.number().int().nonnegative(),
  cue_count: z.number().int().nonnegative(),
  dub_segments: z.array(DubSegmentSchema),
  mp4_file: z.string(),
  wav_file: z.string(),
  srt_file: z.string(),
});

function getChunkDir(projectId: string, chunkIndex: number): string {
  const paths = getProjectPaths(projectId);
  return path.join(paths.chunksDir, `chunk_${String(chunkIndex).padStart(3, '0')}`);
}

async function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

async function emitChunkState(
  projectId: string,
  chunkProgress: ChunkProgress,
  dubProgressPct?: number,
  projectOverride?: Project,
): Promise<Project> {
  const updated =
    projectOverride ??
    (await updateProject(projectId, (cur) => ({
      ...cur,
      chunk_progress: chunkProgress,
      ...(typeof dubProgressPct === 'number'
        ? {
            stages: {
              ...cur.stages,
              dub: {
                ...cur.stages.dub,
                status: 'running',
                progress_pct: dubProgressPct,
                message: chunkProgress.message,
                updated_at: new Date().toISOString(),
              },
            },
          }
        : {}),
    })));

  emitProjectEvent(projectId, {
    type: 'chunk',
    stage: chunkProgress.phase === 'analyze' ? 'speech' : 'dub',
    progress_pct: dubProgressPct,
    message: chunkProgress.message,
    chunk_progress: chunkProgress,
    chunks: updated.chunks,
    project: updated,
  });

  return updated;
}

interface SmartChunksDiskCache {
  planExists: boolean;
  chunks: VideoChunk[];
  allChunksHaveFiles: boolean;
  allChunksAnalyzed: boolean;
  analyzedByIndex: Map<number, z.infer<typeof ChunkAnalyzeCacheSchema>>;
}

async function inspectSmartChunksDiskCache(projectId: string): Promise<SmartChunksDiskCache> {
  const paths = getProjectPaths(projectId);
  const planPath = path.join(paths.chunksDir, 'plan.json');
  const plan = await readJsonFile(planPath, ChunkPlanFileSchema);
  if (!plan || plan.chunks.length === 0) {
    return {
      planExists: false,
      chunks: [],
      allChunksHaveFiles: false,
      allChunksAnalyzed: false,
      analyzedByIndex: new Map(),
    };
  }

  let allChunksHaveFiles = true;
  let allChunksAnalyzed = true;
  const analyzedByIndex = new Map<number, z.infer<typeof ChunkAnalyzeCacheSchema>>();

  for (const chunk of plan.chunks) {
    const chunkDir = getChunkDir(projectId, chunk.index);
    const analyzePath = path.join(chunkDir, 'analyze.json');
    const cachedAnalyze = await readJsonFile(analyzePath, ChunkAnalyzeCacheSchema);
    const hasAudio16 = await fileExists(path.join(chunkDir, 'audio_16k.wav'));
    const hasAudio48 = await fileExists(path.join(chunkDir, 'audio_48k.wav'));

    if (!cachedAnalyze && !hasAudio16 && !hasAudio48) {
      allChunksHaveFiles = false;
    }
    if (!cachedAnalyze || cachedAnalyze.s2_done === false) {
      allChunksAnalyzed = false;
    }
    if (cachedAnalyze) {
      analyzedByIndex.set(chunk.index, cachedAnalyze);
    }
  }

  return {
    planExists: true,
    chunks: plan.chunks,
    allChunksHaveFiles,
    allChunksAnalyzed,
    analyzedByIndex,
  };
}

function hydrateChunksFromDiskCache(
  chunks: VideoChunk[],
  analyzedByIndex: Map<number, z.infer<typeof ChunkAnalyzeCacheSchema>>,
): VideoChunk[] {
  return chunks.map((c) => {
    const cached = analyzedByIndex.get(c.index);
    if (!cached) return c;
    return {
      ...c,
      analyze_done: cached.s2_done !== false ? true : c.analyze_done,
      speech_count: cached.segments.length,
    };
  });
}

/**
 * Ensures Stage 0 ingest & S3 silence/scene maps exist, then plans 3–10 minute smart chunks
 * without cutting mid-speech and persists cache/chunks/plan.json.
 */
export async function ensureProjectSmartChunks(
  projectId: string,
  forceRebuild = false,
): Promise<Project> {
  let project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (!project.upload.completed || !project.video.filename) {
    throw new Error('Upload must complete before smart chunk planning.');
  }

  const paths = getProjectPaths(projectId);
  const planPath = path.join(paths.chunksDir, 'plan.json');

  // Strict disk cache check BEFORE touching FFmpeg or Gemini
  if (!forceRebuild) {
    const diskCache = await inspectSmartChunksDiskCache(projectId);
    if (diskCache.planExists && diskCache.chunks.length > 0 && diskCache.allChunksHaveFiles) {
      console.log('[SmartChunks] All chunks already cached on disk. Skipping re-run.');
      if (project.chunks.length === 0) {
        const hydrated = hydrateChunksFromDiskCache(diskCache.chunks, diskCache.analyzedByIndex);
        return updateProject(projectId, (cur) => ({
          ...cur,
          chunks: hydrated,
        }));
      }
      return project;
    }
    if (diskCache.planExists && diskCache.chunks.length > 0 && project.chunks.length > 0) {
      return project;
    }
    if (diskCache.planExists && diskCache.chunks.length > 0 && project.chunks.length === 0) {
      const hydrated = hydrateChunksFromDiskCache(diskCache.chunks, diskCache.analyzedByIndex);
      return updateProject(projectId, (cur) => ({
        ...cur,
        chunks: hydrated,
      }));
    }
  }

  if (project.stages.ingest.status !== 'done') {
    project = await runS0Ingest(projectId, false);
  }
  if (project.stages.maps.status !== 'done') {
    project = await runS3Maps(projectId, false);
  }

  if (!isLongVideoDuration(project.video.duration_ms)) {
    return project;
  }

  if (!forceRebuild && project.chunks.length > 0) {
    if (!(await fileExists(planPath))) {
      await writeJsonAtomic(planPath, {
        duration_ms: project.video.duration_ms,
        chunks: project.chunks,
        created_at: new Date().toISOString(),
      });
    }
    return project;
  }

  const planned = planSmartVideoChunks({
    durationMs: project.video.duration_ms,
    silenceMs: project.silence_ms,
    sceneCutsMs: project.scene_cuts_ms,
    speechSegments: project.speech.length > 0 ? project.speech : undefined,
  });

  await writeJsonAtomic(planPath, {
    duration_ms: project.video.duration_ms,
    chunks: planned,
    created_at: new Date().toISOString(),
  });

  return updateProject(projectId, (cur) => ({
    ...cur,
    chunks: planned,
  }));
}

function mergeSpeakerRecords(
  canonical: Record<string, SpeakerInfo>,
  incoming: Record<string, SpeakerInfo>,
): Record<string, SpeakerInfo> {
  const merged: Record<string, SpeakerInfo> = { ...canonical };
  for (const [spkId, info] of Object.entries(incoming)) {
    const prev = merged[spkId];
    if (!prev) {
      merged[spkId] = info;
    } else {
      const combinedMergedFrom = Array.from(
        new Set([...(prev.merged_from ?? []), ...(info.merged_from ?? [])]),
      );
      const resolvedGender = prev.gender_overridden
        ? prev.gender
        : info.gender_overridden && (info.gender === 'male' || info.gender === 'female')
          ? info.gender
          : prev.gender === 'male' || prev.gender === 'female'
            ? prev.gender
            : info.gender !== 'unknown'
              ? info.gender
              : prev.gender;
      const isVoiceValidForGender = (v?: SpeakerInfo['voice']) => {
        if (!v?.name) return false;
        if (resolvedGender !== 'male' && resolvedGender !== 'female') return true;
        const vg = getVoiceGender(v.name, v.engine);
        return vg === null || vg === resolvedGender;
      };
      const resolvedVoice = prev.voice_overridden
        ? prev.voice
        : info.voice_overridden
          ? info.voice
          : isVoiceValidForGender(prev.voice)
            ? prev.voice
            : isVoiceValidForGender(info.voice)
              ? info.voice
              : undefined;
      merged[spkId] = {
        ...prev,
        ...info,
        gender: resolvedGender,
        gender_overridden: prev.gender_overridden || info.gender_overridden,
        voice: resolvedVoice,
        sample_file: prev.sample_file ?? info.sample_file,
        merged_from: combinedMergedFrom.length > 0 ? combinedMergedFrom : undefined,
      };
    }
  }
  return merged;
}

function upsertChunkSpeechIntoList(
  existingAllSpeech: SpeechSegment[],
  chunkStartMs: number,
  chunkEndMs: number,
  chunkSegments: SpeechSegment[],
): SpeechSegment[] {
  const outside = existingAllSpeech.filter(
    (s) => s.start_ms < chunkStartMs || s.start_ms >= chunkEndMs,
  );
  return [...outside, ...chunkSegments].sort((a, b) => a.start_ms - b.start_ms);
}

function upsertChunkDubIntoList(
  existingAllDub: DubSegment[],
  lang: TargetLang,
  chunkStartMs: number,
  chunkEndMs: number,
  chunkDubs: DubSegment[],
): DubSegment[] {
  const outside = existingAllDub.filter(
    (d) => !(d.lang === lang && d.start_ms >= chunkStartMs && d.start_ms < chunkEndMs),
  );
  return [...outside, ...chunkDubs].sort((a, b) => {
    if (a.lang !== b.lang) return a.lang.localeCompare(b.lang);
    return a.start_ms - b.start_ms;
  });
}

async function analyzeSingleChunk(params: {
  projectId: string;
  chunk: VideoChunk;
  idOffset: number;
  canonicalSpeakers: Record<string, SpeakerInfo>;
  silenceMs: Array<[number, number]>;
  hasAudio: boolean;
  force: boolean;
  stageMode?: AnalyzeStageMode;
}): Promise<{
  chunkSegments: SpeechSegment[];
  canonicalSpeakers: Record<string, SpeakerInfo>;
  modelsUsed: string[];
}> {
  const {
    projectId,
    chunk,
    idOffset,
    silenceMs,
    hasAudio,
    force,
    stageMode = 'all',
  } = params;
  const cfg = getConfig();
  const paths = getProjectPaths(projectId);
  const chunkDir = getChunkDir(projectId, chunk.index);
  const analyzePath = path.join(chunkDir, 'analyze.json');
  const audio16kPath = path.join(paths.workDir, 'audio_16k.wav');

  let canonicalSpeakers = { ...params.canonicalSpeakers };
  const s2Needed = stageMode !== 's1_only';

  if (!hasAudio) {
    await writeJsonAtomic(analyzePath, {
      hash: 'no-audio',
      chunk_index: chunk.index,
      start_ms: chunk.start_ms,
      end_ms: chunk.end_ms,
      segments: [],
      chunk_speakers: {},
      models_used: [],
      s2_done: s2Needed,
    });
    await updateProject(projectId, (cur) => ({
      ...cur,
      chunks: cur.chunks.map((c) =>
        c.index === chunk.index
          ? {
              ...c,
              analyze_done: s2Needed,
              speech_count: 0,
              updated_at: new Date().toISOString(),
            }
          : c,
      ),
    }));
    return { chunkSegments: [], canonicalSpeakers, modelsUsed: [] };
  }

  // Respect user-edited or completed S1/S2 segments already stored in project.json
  if (!force && stageMode !== 's1_only') {
    const currentProj = await getProject(projectId);
    const projectS1S2Complete = Boolean(
      currentProj &&
        currentProj.stages.speech.status === 'done' &&
        currentProj.stages.speakers.status === 'done',
    );
    if (currentProj && (chunk.analyze_done || projectS1S2Complete)) {
      const fromProject = currentProj.speech
        .filter((s) => s.start_ms >= chunk.start_ms && s.start_ms < chunk.end_ms)
        .sort((a, b) => a.start_ms - b.start_ms);
      if (
        fromProject.length > 0 ||
        chunk.speech_count === 0 ||
        currentProj.no_dialogue ||
        projectS1S2Complete
      ) {
        canonicalSpeakers = mergeSpeakerRecords(canonicalSpeakers, currentProj.speakers);
        return {
          chunkSegments: fromProject,
          canonicalSpeakers,
          modelsUsed: [],
        };
      }
    }
  }

  const analyzeHash = hashString(
    JSON.stringify({
      s1WindowMode: 'anchored-45s-v3',
      chunkIndex: chunk.index,
      startMs: chunk.start_ms,
      endMs: chunk.end_ms,
      transcribeModel: cfg.TRANSCRIBE_MODEL,
      textModel: cfg.TEXT_MODEL,
    }),
  );

  const cached = await readJsonFile(analyzePath, ChunkAnalyzeCacheSchema);

  if (!force && cached) {
    if (stageMode === 's1_only' && (cached.hash === analyzeHash || cached.segments.length > 0)) {
      const renumbered = cached.segments.map((s, idx) => ({
        ...s,
        id: idOffset + idx + 1,
      }));
      await updateProject(projectId, (cur) => ({
        ...cur,
        speech: upsertChunkSpeechIntoList(cur.speech, chunk.start_ms, chunk.end_ms, renumbered),
        chunks: cur.chunks.map((c) =>
          c.index === chunk.index
            ? {
                ...c,
                analyze_done: cached.s2_done !== false ? c.analyze_done : false,
                speech_count: renumbered.length,
                updated_at: new Date().toISOString(),
              }
            : c,
        ),
      }));
      return {
        chunkSegments: renumbered,
        canonicalSpeakers,
        modelsUsed: cached.models_used,
      };
    }

    // Reuse completed chunk analysis on disk even if model config changed since Stage 2 ran
    if (cached.s2_done !== false) {
      canonicalSpeakers = s2Needed
        ? mergeSpeakerRecords(canonicalSpeakers, cached.chunk_speakers)
        : canonicalSpeakers;
      const renumbered = cached.segments.map((s, idx) => ({
        ...s,
        id: idOffset + idx + 1,
      }));
      await updateProject(projectId, (cur) => ({
        ...cur,
        speech: upsertChunkSpeechIntoList(cur.speech, chunk.start_ms, chunk.end_ms, renumbered),
        ...(s2Needed ? { speakers: mergeSpeakerRecords(cur.speakers, canonicalSpeakers) } : {}),
        chunks: cur.chunks.map((c) =>
          c.index === chunk.index
            ? {
                ...c,
                analyze_done: true,
                speech_count: renumbered.length,
                updated_at: new Date().toISOString(),
              }
            : c,
        ),
      }));
      return {
        chunkSegments: renumbered,
        canonicalSpeakers,
        modelsUsed: cached.models_used,
      };
    }
  }

  if (!(await fileExists(audio16kPath))) {
    throw new Error('16 kHz mono WAV (work/audio_16k.wav) missing. Run S0 Ingest first.');
  }

  const chunk16kPath = path.join(chunkDir, 'audio_16k.wav');

  // Stage S1 only: run S1 transcription on the chunk slice, persist S1 results without calling Gemini S2
  if (stageMode === 's1_only') {
    const s1Res = await runS1OnChunkSlice({
      projectId,
      audio16kPath,
      chunkIndex: chunk.index,
      startMs: chunk.start_ms,
      endMs: chunk.end_ms,
      wavOutPath: chunk16kPath,
      silenceMs,
      modelId: cfg.TRANSCRIBE_MODEL,
      force,
    });

    const renumberedSegments = s1Res.segments.map((s, idx) => ({
      ...s,
      id: idOffset + idx + 1,
    }));
    const modelsUsed = [s1Res.modelUsed].filter(Boolean);

    await writeJsonAtomic(analyzePath, {
      hash: analyzeHash,
      chunk_index: chunk.index,
      start_ms: chunk.start_ms,
      end_ms: chunk.end_ms,
      segments: renumberedSegments,
      chunk_speakers: {},
      models_used: modelsUsed,
      s2_done: false,
    });

    await updateProject(projectId, (cur) => ({
      ...cur,
      speech: upsertChunkSpeechIntoList(
        cur.speech,
        chunk.start_ms,
        chunk.end_ms,
        renumberedSegments,
      ),
      chunks: cur.chunks.map((c) =>
        c.index === chunk.index
          ? {
              ...c,
              analyze_done: false,
              speech_count: renumberedSegments.length,
              updated_at: new Date().toISOString(),
            }
          : c,
      ),
    }));

    return {
      chunkSegments: renumberedSegments,
      canonicalSpeakers,
      modelsUsed,
    };
  }

  // Obtain S1 segments: reuse existing saved/cached S1 segments whenever force is false
  let s1Segments: SpeechSegment[] | null = null;
  let s1ModelUsed = '';

  if (!force) {
    const currentProj = await getProject(projectId);
    const savedSlice = (currentProj?.speech ?? [])
      .filter((s) => s.start_ms >= chunk.start_ms && s.start_ms < chunk.end_ms)
      .sort((a, b) => a.start_ms - b.start_ms);

    if (stageMode === 's2_only') {
      if (savedSlice.length > 0) {
        s1Segments = savedSlice;
      } else if (cached && cached.segments.length > 0) {
        s1Segments = cached.segments;
      } else if (cached || currentProj?.stages.speech.status === 'done') {
        s1Segments = [];
      } else {
        throw new Error(
          `S1 speech segments not found for chunk #${chunk.index + 1}. Run S1 (Groq) before running S2 (Gemini).`,
        );
      }
    } else if (cached && (cached.segments.length > 0 || cached.hash === analyzeHash)) {
      s1Segments = cached.segments;
    } else if (
      currentProj?.stages.speech.status === 'done' &&
      (savedSlice.length > 0 || currentProj.no_dialogue)
    ) {
      s1Segments = savedSlice;
    }

    if (s1Segments !== null) {
      console.log(
        `[Pipeline] S1 already completed (${s1Segments.length} segments found). Skipping S1 and proceeding directly to S2.`,
      );
      if (cached?.models_used?.length) {
        const firstTranscribeModel = cached.models_used.find((m) =>
          /whisper|groq|kaggle|transcribe/i.test(m),
        );
        if (firstTranscribeModel) s1ModelUsed = firstTranscribeModel;
      }
    }
  }

  if (s1Segments === null) {
    const s1Res = await runS1OnChunkSlice({
      projectId,
      audio16kPath,
      chunkIndex: chunk.index,
      startMs: chunk.start_ms,
      endMs: chunk.end_ms,
      wavOutPath: chunk16kPath,
      silenceMs,
      modelId: cfg.TRANSCRIBE_MODEL,
      force,
    });
    s1Segments = s1Res.segments;
    s1ModelUsed = s1Res.modelUsed;
  }

  const s2Res = await runS2SpeakersForChunk({
    projectId,
    chunkIndex: chunk.index,
    chunkSegments: s1Segments,
    existingSpeakers: canonicalSpeakers,
    audio16kPath,
    modelId: cfg.TEXT_MODEL,
    force,
  });

  canonicalSpeakers = mergeSpeakerRecords(canonicalSpeakers, s2Res.speakers);
  const renumberedSegments = s2Res.segments.map((s, idx) => ({
    ...s,
    id: idOffset + idx + 1,
  }));
  const modelsUsed = Array.from(new Set([s1ModelUsed, ...s2Res.modelsUsed].filter(Boolean)));

  await writeJsonAtomic(analyzePath, {
    hash: analyzeHash,
    chunk_index: chunk.index,
    start_ms: chunk.start_ms,
    end_ms: chunk.end_ms,
    segments: renumberedSegments,
    chunk_speakers: canonicalSpeakers,
    models_used: modelsUsed,
    s2_done: true,
  });

  await updateProject(projectId, (cur) => ({
    ...cur,
    speech: upsertChunkSpeechIntoList(
      cur.speech,
      chunk.start_ms,
      chunk.end_ms,
      renumberedSegments,
    ),
    speakers: mergeSpeakerRecords(cur.speakers, canonicalSpeakers),
    chunks: cur.chunks.map((c) =>
      c.index === chunk.index
        ? {
            ...c,
            analyze_done: true,
            speech_count: renumberedSegments.length,
            updated_at: new Date().toISOString(),
          }
        : c,
    ),
  }));

  return {
    chunkSegments: renumberedSegments,
    canonicalSpeakers,
    modelsUsed,
  };
}

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const cur = index++;
      if (cur >= items.length) break;
      results[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Chunked Stage 2 pipeline (S1–S2 per 3–10m smart chunk, cross-chunk speaker anchoring,
 * immediate cache persistence in cache/chunks/chunk_XXX/analyze.json).
 */
export async function runChunkedAnalyzePipeline(
  projectId: string,
  forceRebuild = false,
  stageMode: AnalyzeStageMode = 'all',
): Promise<Project> {
  const cfg = getConfig();
  const preCheckProj = await getProject(projectId);
  const existingSegments = preCheckProj?.speech ?? [];

  if (!forceRebuild) {
    const diskCache = await inspectSmartChunksDiskCache(projectId);
    const allDiskS1Ready =
      diskCache.planExists &&
      diskCache.chunks.length > 0 &&
      diskCache.chunks.every((c) => diskCache.analyzedByIndex.has(c.index));
    const allDiskS2Ready = diskCache.planExists && diskCache.chunks.length > 0 && diskCache.allChunksAnalyzed;
    const projS1Done =
      Boolean(preCheckProj) &&
      preCheckProj!.stages.speech.status === 'done' &&
      (existingSegments.length > 0 || preCheckProj!.no_dialogue);
    const projS2Done =
      Boolean(preCheckProj) &&
      preCheckProj!.stages.speakers.status === 'done' &&
      (preCheckProj!.chunks.length === 0 || preCheckProj!.chunks.every((c) => c.analyze_done));

    const skipForS1 = stageMode === 's1_only' && (allDiskS1Ready || projS1Done);
    const skipForFullOrS2 = stageMode !== 's1_only' && (allDiskS2Ready || (projS1Done && projS2Done));

    if (skipForS1 || skipForFullOrS2) {
      console.log('[SmartChunks] All chunks already cached on disk. Skipping re-run.');
      if (preCheckProj && diskCache.planExists && diskCache.chunks.length > 0) {
        const needsHydration =
          preCheckProj.chunks.length === 0 ||
          (skipForFullOrS2 && !preCheckProj.chunks.every((c) => c.analyze_done)) ||
          preCheckProj.speech.length === 0;
        if (needsHydration) {
          const cachedSegments: SpeechSegment[] = [];
          let mergedSpeakers: Record<string, SpeakerInfo> = { ...preCheckProj.speakers };
          for (const c of diskCache.chunks) {
            const entry = diskCache.analyzedByIndex.get(c.index);
            if (!entry) continue;
            cachedSegments.push(...entry.segments);
            if (skipForFullOrS2) {
              mergedSpeakers = mergeSpeakerRecords(mergedSpeakers, entry.chunk_speakers);
            }
          }
          const resolvedSpeech =
            preCheckProj.speech.length > 0
              ? preCheckProj.speech
              : cachedSegments
                  .sort((a, b) => a.start_ms - b.start_ms)
                  .map((s, idx) => ({ ...s, id: idx + 1 }));
          const totalChunks = diskCache.chunks.length;
          const doneProgress: ChunkProgress = {
            active: false,
            current_index: Math.max(0, totalChunks - 1),
            total_chunks: totalChunks,
            start_ms: diskCache.chunks[totalChunks - 1]?.start_ms ?? 0,
            end_ms: diskCache.chunks[totalChunks - 1]?.end_ms ?? 0,
            phase: 'done',
            message:
              stageMode === 's1_only'
                ? `Chunked S1 complete (${totalChunks} chunks, ${resolvedSpeech.length} segments).`
                : `Chunked S2 complete (${totalChunks} chunks, ${Object.keys(mergedSpeakers).length} consistent speakers).`,
          };
          const hydratedProj = await updateProject(projectId, (cur) => ({
            ...cur,
            speech: resolvedSpeech,
            ...(skipForFullOrS2 ? { speakers: mergedSpeakers } : {}),
            chunks: hydrateChunksFromDiskCache(
              cur.chunks.length > 0 ? cur.chunks : diskCache.chunks,
              diskCache.analyzedByIndex,
            ),
            chunk_progress: doneProgress,
            stages: {
              ...cur.stages,
              speech: {
                ...cur.stages.speech,
                status: 'done',
                progress_pct: 100,
                updated_at: new Date().toISOString(),
              },
              ...(skipForFullOrS2
                ? {
                    speakers: {
                      ...cur.stages.speakers,
                      status: 'done',
                      progress_pct: 100,
                      updated_at: new Date().toISOString(),
                    },
                  }
                : {}),
            },
          }));
          await emitChunkState(projectId, doneProgress, undefined, hydratedProj);
          return hydratedProj;
        }
      }
      return preCheckProj!;
    }
  }

  const s1AlreadyDone =
    !forceRebuild &&
    Boolean(preCheckProj) &&
    preCheckProj!.stages.speech.status === 'done' &&
    (existingSegments.length > 0 || preCheckProj!.no_dialogue);

  let effectiveStageMode: AnalyzeStageMode = stageMode;
  if (s1AlreadyDone && stageMode !== 's2_only') {
    console.log(
      `[Pipeline] S1 already completed (${existingSegments.length} segments found). Skipping S1 and proceeding directly to S2.`,
    );
    if (stageMode === 's1_only') {
      return preCheckProj!;
    }
    effectiveStageMode = 's2_only';
  }

  const force = forceRebuild;
  const plannedProj = await ensureProjectSmartChunks(
    projectId,
    effectiveStageMode === 's2_only' ? false : force,
  );
  const chunks = plannedProj.chunks;

  if (chunks.length === 0) {
    return plannedProj;
  }

  const runS1 = effectiveStageMode !== 's2_only';
  const runS2 = effectiveStageMode !== 's1_only';

  let runningProj = await updateProject(projectId, (cur) => ({
    ...cur,
    ...(force && effectiveStageMode === 'all' ? { speech: [], speakers: {} } : {}),
    ...(force && effectiveStageMode === 's1_only' ? { speech: [] } : {}),
    ...(force && effectiveStageMode === 's2_only' ? { speakers: {} } : {}),
    stages: {
      ...cur.stages,
      ...(runS1
        ? {
            speech: {
              status: 'running',
              progress_pct: 5,
              message:
                effectiveStageMode === 's1_only'
                  ? `Starting smart-chunked S1 only (${chunks.length} chunks)...`
                  : `Starting smart-chunked S1/S2 (${chunks.length} chunks)...`,
              model_used: cfg.TRANSCRIBE_MODEL,
              updated_at: new Date().toISOString(),
            },
          }
        : {}),
      ...(runS2
        ? {
            speakers: {
              status: 'running',
              progress_pct: 5,
              message:
                effectiveStageMode === 's2_only'
                  ? `Starting chunked S2 speaker diarization (${chunks.length} chunks)...`
                  : `Waiting for chunked speaker diarization (${chunks.length} chunks)...`,
              model_used: cfg.TEXT_MODEL,
              updated_at: new Date().toISOString(),
            },
          }
        : {
            speakers: {
              status: 'pending',
              progress_pct: 0,
              message: 'Waiting for S2 (Gemini - VPN On)...',
              updated_at: new Date().toISOString(),
            },
          }),
    },
  }));

  let canonicalSpeakers: Record<string, SpeakerInfo> =
    force && runS2 ? {} : { ...runningProj.speakers };
  const allSpeech: SpeechSegment[] = [];
  const transcribeModels = new Set<string>(runS1 ? [cfg.TRANSCRIBE_MODEL] : []);
  const textModels = new Set<string>(runS2 ? [cfg.TEXT_MODEL] : []);
  let idOffset = 0;
  let activeChunkIndex = 0;

  try {
    const chunkConcurrency = runS2 ? 1 : 2;
    await runWithConcurrencyLimit(chunks, chunkConcurrency, async (chunk, i) => {
      activeChunkIndex = i;
      const currentProj = await getProject(projectId);
      const msg = formatChunkProgressLabel(i, chunks.length, chunk.start_ms, chunk.end_ms);
      const pct = Math.min(95, Math.max(8, Math.round(8 + (i / chunks.length) * 86)));

      await updateProject(projectId, (cur) => ({
        ...cur,
        chunks: cur.chunks.map((c) =>
          c.index === chunk.index ? { ...c, status: 'running', error: undefined } : c,
        ),
        stages: {
          ...cur.stages,
          ...(runS1
            ? {
                speech: {
                  ...cur.stages.speech,
                  status: 'running',
                  progress_pct: pct,
                  message: msg,
                  error: undefined,
                },
              }
            : {}),
          ...(runS2
            ? {
                speakers: {
                  ...cur.stages.speakers,
                  status: 'running',
                  progress_pct: pct,
                  message: msg,
                  error: undefined,
                },
              }
            : {}),
        },
      }));

      await emitChunkState(projectId, {
        active: true,
        current_index: i,
        total_chunks: chunks.length,
        start_ms: chunk.start_ms,
        end_ms: chunk.end_ms,
        phase: 'analyze',
        message: msg,
      });

      const res = await withExponentialBackoffRetry(
        () =>
          analyzeSingleChunk({
            projectId,
            chunk,
            idOffset,
            canonicalSpeakers,
            silenceMs: currentProj?.silence_ms ?? runningProj.silence_ms,
            hasAudio: currentProj?.video.has_audio ?? runningProj.video.has_audio,
            force,
            stageMode: effectiveStageMode,
          }),
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          factor: 2,
          label: `Analyze Chunk ${i + 1}/${chunks.length}`,
          onRetry: async ({ attempt, maxAttempts, friendlyReason }) => {
            await emitChunkState(projectId, {
              active: true,
              current_index: i,
              total_chunks: chunks.length,
              start_ms: chunk.start_ms,
              end_ms: chunk.end_ms,
              phase: 'analyze',
              message: `${msg} · Retry ${attempt + 1}/${maxAttempts} (${friendlyReason})...`,
            });
          },
        },
      );

      if (runS2) {
        canonicalSpeakers = mergeSpeakerRecords(canonicalSpeakers, res.canonicalSpeakers);
      }
      allSpeech.push(...res.chunkSegments);
      idOffset += res.chunkSegments.length;
      for (const m of res.modelsUsed) {
        if (/whisper|groq|kaggle|transcribe/i.test(m)) transcribeModels.add(m);
        else textModels.add(m);
      }

      await updateProject(projectId, (cur) => ({
        ...cur,
        chunks: cur.chunks.map((c) =>
          c.index === chunk.index
            ? {
                ...c,
                status: c.dub_done_langs.length >= cur.target_langs.length ? 'done' : 'pending',
                analyze_done: runS2 ? true : c.analyze_done,
                speech_count: res.chunkSegments.length,
                error: undefined,
              }
            : c,
        ),
      }));
    });

    const sortedAll = (allSpeech.length > 0 || force || runningProj.speech.length === 0
      ? allSpeech
      : runningProj.speech
    )
      .sort((a, b) => a.start_ms - b.start_ms)
      .map((s, idx) => ({ ...s, id: idx + 1 }));
    const totalSpeechMs = sortedAll.reduce(
      (sum, s) => sum + Math.max(0, s.end_ms - s.start_ms),
      0,
    );
    const speechPct = (totalSpeechMs / Math.max(1, runningProj.video.duration_ms)) * 100;
    const noDialogue = !runningProj.video.has_audio || sortedAll.length === 0 || speechPct < 5;

    const finalProgress: ChunkProgress = {
      active: false,
      current_index: Math.max(0, chunks.length - 1),
      total_chunks: chunks.length,
      start_ms: chunks[chunks.length - 1]?.start_ms ?? 0,
      end_ms: chunks[chunks.length - 1]?.end_ms ?? 0,
      phase: 'done',
      message:
        effectiveStageMode === 's1_only'
          ? `Chunked S1 complete (${chunks.length} chunks, ${sortedAll.length} segments). Turn ON VPN to run S2.`
          : effectiveStageMode === 's2_only'
            ? `Chunked S2 complete (${chunks.length} chunks, ${Object.keys(canonicalSpeakers).length} consistent speakers).`
            : `Chunked S1–S2 complete (${chunks.length} chunks, ${sortedAll.length} segments).`,
    };

    const doneProj = await updateProject(projectId, (cur) => ({
      ...cur,
      no_dialogue: noDialogue,
      speech: sortedAll,
      ...(runS2 ? { speakers: canonicalSpeakers } : {}),
      chunk_progress: finalProgress,
      stages: {
        ...cur.stages,
        ...(runS1
          ? {
              speech: {
                status: 'done',
                progress_pct: 100,
                message: noDialogue
                  ? `S1 complete (${chunks.length} chunks): marked No dialogue (${speechPct.toFixed(1)}%).`
                  : `S1 complete (${chunks.length} chunks): ${sortedAll.length} segments (${speechPct.toFixed(1)}% speech).`,
                model_used: Array.from(transcribeModels).join(', '),
                updated_at: new Date().toISOString(),
              },
            }
          : {}),
        ...(runS2
          ? {
              speakers: {
                status: 'done',
                progress_pct: 100,
                message: `S2 complete (${chunks.length} chunks): ${Object.keys(canonicalSpeakers).length} consistent speakers.`,
                model_used: Array.from(textModels).join(', '),
                updated_at: new Date().toISOString(),
              },
            }
          : {
              speakers: {
                status: 'pending',
                progress_pct: 0,
                message: 'S1 complete — turn ON VPN and run S2 (Gemini).',
                updated_at: new Date().toISOString(),
              },
            }),
      },
    }));

    await emitChunkState(projectId, finalProgress, undefined, doneProj);
    return doneProj;
  } catch (err) {
    const friendlyMsg = formatChunkFailureMessage(activeChunkIndex, err);
    console.error(`[LongVideo] Analyze failed at chunk ${activeChunkIndex + 1}:`, err);
    const failedChunk = chunks[activeChunkIndex];
    const errProj = await updateProject(projectId, (cur) => ({
      ...cur,
      chunks: cur.chunks.map((c) =>
        c.index === activeChunkIndex || c.status === 'running'
          ? { ...c, status: 'error', error: friendlyMsg, updated_at: new Date().toISOString() }
          : c,
      ),
      chunk_progress: {
        active: false,
        current_index: activeChunkIndex,
        total_chunks: chunks.length,
        start_ms: failedChunk?.start_ms ?? 0,
        end_ms: failedChunk?.end_ms ?? 0,
        phase: 'error',
        message: friendlyMsg,
      },
      stages: {
        ...cur.stages,
        ...(runS1
          ? {
              speech: {
                ...cur.stages.speech,
                status: cur.stages.speech.status === 'done' ? 'done' : 'error',
                error: friendlyMsg,
                message: friendlyMsg,
                updated_at: new Date().toISOString(),
              },
            }
          : {}),
        ...(runS2
          ? {
              speakers: {
                ...cur.stages.speakers,
                status: cur.stages.speakers.status === 'done' ? 'done' : 'error',
                error: friendlyMsg,
                message: friendlyMsg,
                updated_at: new Date().toISOString(),
              },
            }
          : {}),
      },
    }));
    emitProjectEvent(projectId, {
      type: 'error',
      stage: runS1 ? 'speech' : 'speakers',
      message: friendlyMsg,
      chunk_progress: errProj.chunk_progress,
      chunks: errProj.chunks,
      project: errProj,
    });
    return errProj;
  }
}

/**
 * Full end-to-end sequential smart-chunked pipeline (3–10m chunks):
 * Each chunk runs: S1–S3 -> Translate -> TTS/Fit -> Render Chunk Output (with per-chunk caching/resume).
 * Consistency (speaker voice map + glossary) from Chunk 1 is locked & reused across Chunks 2..N.
 * Finally concatenates all chunk MP4s, WAVs, and SRTs via FFmpeg concat demuxer.
 */
export async function runChunkedDubRenderPipeline(
  projectId: string,
  opts: { force?: boolean; translateFirst?: boolean } = {},
): Promise<Project> {
  const force = Boolean(opts.force);
  const cfg = getConfig();
  const paths = getProjectPaths(projectId);

  let project = await ensureProjectSmartChunks(projectId, false);
  const chunks = project.chunks;
  if (chunks.length === 0) {
    throw new Error('Smart chunking applies only to videos longer than 10 minutes.');
  }

  if (project.video.has_audio && (!geminiRuntime.configured || !geminiRuntime.keyValid)) {
    throw new Error(
      geminiRuntime.keyError ||
        'GEMINI_API_KEY is missing or invalid. Set GEMINI_API_KEY in .env.local or your environment.',
    );
  }

  const activeEngine = cfg.TTS_ENGINE;
  const consistencyPath = path.join(getChunkDir(projectId, 0), 'consistency.json');
  const savedConsistency = !force
    ? await readJsonFile(consistencyPath, ChunkConsistencySchema)
    : null;

  const primaryAudioLang: TargetLang = resolveSingleTargetLang(project.target_langs);
  const activeTargetLangs: TargetLang[] = [primaryAudioLang];

  const lockedGlossaryByLang: Record<string, Record<string, string>> = {
    ...(savedConsistency?.glossary_by_lang ?? {}),
    ...(project.dub_glossary ?? {}),
  };
  const lockedSpeakerVoices: Record<string, { engine: 'edge' | 'gemini'; name: string }> = {
    ...(savedConsistency?.speaker_voices ?? {}),
  };
  for (const [spkId, info] of Object.entries(project.speakers)) {
    const existingLocked = lockedSpeakerVoices[spkId];
    if (info.voice?.engine === activeEngine && info.voice.name) {
      lockedSpeakerVoices[spkId] = {
        engine: activeEngine,
        name: resolveStrictVoiceForSpeaker({
          engine: activeEngine,
          targetLang: primaryAudioLang,
          speakerGender: info.gender,
          voiceOverridden: info.voice_overridden,
          speakerVoice: info.voice,
          candidateVoice: info.voice.name,
          voicePools: cfg.VOICE_POOLS,
        }),
      };
    } else if (existingLocked) {
      if (existingLocked.engine !== activeEngine) {
        delete lockedSpeakerVoices[spkId];
      } else {
        lockedSpeakerVoices[spkId] = {
          engine: activeEngine,
          name: resolveStrictVoiceForSpeaker({
            engine: activeEngine,
            targetLang: primaryAudioLang,
            speakerGender: info.gender,
            voiceOverridden: info.voice_overridden,
            speakerVoice: info.voice,
            candidateVoice: existingLocked.name,
            voicePools: cfg.VOICE_POOLS,
          }),
        };
      }
    }
  }

  await updateProject(projectId, (cur) => ({
    ...cur,
    dub_selection: { ...cur.dub_selection, mode: 'all' },
    stages: {
      ...cur.stages,
      dub: {
        status: 'running',
        progress_pct: 2,
        message: `Preparing ${chunks.length} smart chunks (3–10m)...`,
        model_used: `TEXT: ${cfg.TEXT_MODEL} · TTS: ${activeEngine === 'edge' ? 'edge-tts' : cfg.TTS_MODEL}`,
        updated_at: new Date().toISOString(),
      },
    },
  }));

  const chunkArtifactsByLang: Record<
    string,
    Array<{ mp4Path: string; wavPath: string; srtPath: string }>
  > = {};
  for (const l of activeTargetLangs) {
    chunkArtifactsByLang[l] = [];
  }

  let canonicalSpeakers: Record<string, SpeakerInfo> = { ...project.speakers };
  const allDubSegments: DubSegment[] = [];
  const calibratedSps: Record<string, number> = { ...(project.calibrated_sps ?? {}) };
  const spsSamples: Record<string, number[]> = {};
  const textModelsSet = new Set<string>([cfg.TEXT_MODEL]);
  const ttsModelsSet = new Set<string>();

  let speechIdOffset = 0;
  let cueIdOffset = 0;
  let activeChunkIndex = 0;

  try {
    for (let i = 0; i < chunks.length; i++) {
      activeChunkIndex = i;
      const latestProj = await getProject(projectId);
      if (!latestProj) throw new Error(`Project "${projectId}" not found.`);
      project = latestProj;
      const chunk = latestProj.chunks[i] ?? chunks[i];
      const chunkDir = getChunkDir(projectId, chunk.index);
      const timeLabel = formatChunkProgressLabel(i, chunks.length, chunk.start_ms, chunk.end_ms);
      const baseChunkPct = Math.min(88, Math.max(4, Math.round(4 + (i / chunks.length) * 84)));

      const processSingleChunk = async () => {
        let localSpeakers: Record<string, SpeakerInfo> = { ...canonicalSpeakers };
        let localSpeechIdOffset = speechIdOffset;
        let localCueIdOffset = cueIdOffset;
        const localArtifacts: Record<
          string,
          { mp4Path: string; wavPath: string; srtPath: string }
        > = {};
        const localDubSegments: DubSegment[] = [];
        const localTextModels = new Set<string>();
        const localTtsModels = new Set<string>();

        // 1) S1–S2 per chunk (reuses existing project S1/S2 state or cached analyze.json without re-running)
        const analyzeRes = await analyzeSingleChunk({
          projectId,
          chunk,
          idOffset: localSpeechIdOffset,
          canonicalSpeakers: localSpeakers,
          silenceMs: latestProj.silence_ms,
          hasAudio: latestProj.video.has_audio,
          force: false,
        });
        localSpeakers = analyzeRes.canonicalSpeakers;
        localSpeechIdOffset += analyzeRes.chunkSegments.length;
        for (const m of analyzeRes.modelsUsed) {
          if (!m.includes('transcribe')) localTextModels.add(m);
        }

        // Sync locked speaker voices into localSpeakers only when engine + lang + gender match (or user overrode)
        for (const [spk, v] of Object.entries(lockedSpeakerVoices)) {
          const spkInfo = localSpeakers[spk];
          if (!spkInfo || v.engine !== activeEngine) continue;
          const strictLocked = resolveStrictVoiceForSpeaker({
            engine: activeEngine,
            targetLang: primaryAudioLang,
            speakerGender: spkInfo.gender,
            voiceOverridden: spkInfo.voice_overridden,
            speakerVoice: spkInfo.voice,
            candidateVoice: v.name,
            voicePools: cfg.VOICE_POOLS,
          });
          if (strictLocked === v.name) {
            localSpeakers[spk] = {
              ...spkInfo,
              voice: v,
            };
          } else {
            delete lockedSpeakerVoices[spk];
          }
        }

        const isRecap = latestProj.mode === 'recap';
        const rawCues = buildDubSourceCues(analyzeRes.chunkSegments);
        const shapedCues = isRecap
          ? prepareRecapCues(rawCues, latestProj.video.duration_ms || 0, {
              anchorOpeningToZero: chunk.index === 0,
            })
          : rawCues;
        const chunkCues: MergedDubCue[] = shapedCues.map((c, idx) => ({
          ...c,
          id: localCueIdOffset + idx + 1,
        }));
        localCueIdOffset += chunkCues.length;

        // Ensure Chunk 1 (or first chunk with speech) locks glossary & gender-matched speaker voices across chunks 2..N
        for (const lang of activeTargetLangs) {
          const voiceMap = resolveSpeakerVoicesForEngine({
            engine: activeEngine,
            speakers: localSpeakers,
            cues: chunkCues,
            targetLang: lang,
            voicePools: cfg.VOICE_POOLS,
          });
          for (const [spk, vName] of Object.entries(voiceMap)) {
            const spkInfo = localSpeakers[spk];
            const spkGender = spkInfo?.gender ?? 'unknown';
            const locked = lockedSpeakerVoices[spk];
            const strictVoice = resolveStrictVoiceForSpeaker({
              engine: activeEngine,
              targetLang: lang,
              speakerGender: spkGender,
              voiceOverridden: spkInfo?.voice_overridden,
              speakerVoice: spkInfo?.voice,
              candidateVoice: locked?.engine === activeEngine ? locked.name : vName,
              voicePools: cfg.VOICE_POOLS,
            });

            if (lang === primaryAudioLang) {
              if (!locked || locked.engine !== activeEngine || locked.name !== strictVoice) {
                lockedSpeakerVoices[spk] = { engine: activeEngine, name: strictVoice };
              }
              if (spkInfo) {
                localSpeakers[spk] = {
                  ...spkInfo,
                  voice: lockedSpeakerVoices[spk],
                };
              }
            }
          }
        }

        if (chunkCues.length > 0) {
          for (const lang of activeTargetLangs) {
            if (!lockedGlossaryByLang[lang] || Object.keys(lockedGlossaryByLang[lang]).length === 0) {
              const gRes = await extractGlossaryForLang({
                projectId,
                cues: chunkCues,
                targetLang: lang,
                modelId: cfg.TEXT_MODEL,
                force: false,
                boundedWait: true,
              });
              lockedGlossaryByLang[lang] = gRes.glossary;
              if (gRes.modelUsed) localTextModels.add(gRes.modelUsed);
            }
          }
        }

        await writeJsonAtomic(consistencyPath, {
          glossary_by_lang: lockedGlossaryByLang,
          speaker_voices: lockedSpeakerVoices,
          updated_at: new Date().toISOString(),
        });

        await updateProject(projectId, (cur) => ({
          ...cur,
          speakers: localSpeakers,
          dub_glossary: lockedGlossaryByLang,
        }));

        // Check per-chunk render cache across all target languages
        const voiceHashSlice = Object.keys(lockedSpeakerVoices)
          .sort()
          .map((spk) => `${spk}:${lockedSpeakerVoices[spk].engine}:${lockedSpeakerVoices[spk].name}`);
        const speakerGenderSlice = Object.keys(localSpeakers)
          .sort()
          .map((spk) => `${spk}:${localSpeakers[spk].gender}`);

        const chunkRenderHash = hashString(
          JSON.stringify({
            syncVersion: isRecap ? 'recap-v3-single-lang-aac128' : 'dub-v6-single-lang-aac128',
            chunkIndex: chunk.index,
            startMs: chunk.start_ms,
            endMs: chunk.end_ms,
            langs: activeTargetLangs,
            mode: project.mode,
            recapMuteOriginal: project.recap_mute_original ?? true,
            backgroundAudioMode: resolveBackgroundAudioMode({
              project,
              isRecapMode: project.mode === 'recap',
            }),
            engine: activeEngine,
            ttsModel: cfg.TTS_MODEL,
            textModel: cfg.TEXT_MODEL,
            style: cfg.SPEECH_STYLE,
            ttsVolumePct: cfg.TTS_VOLUME_PCT,
            voices: voiceHashSlice,
            genders: speakerGenderSlice,
            cues: chunkCues.map((c) => [c.id, c.start_ms, c.end_ms, c.speaker, c.text]),
          }),
        );

        let allLangsCached = !force && !opts.translateFirst;
        const cachedChunkLangData: Record<string, z.infer<typeof ChunkRenderLangCacheSchema>> = {};

        if (allLangsCached) {
          for (const lang of activeTargetLangs) {
            const renderCachePath = path.join(chunkDir, `render_${lang}.json`);
            const cached = await readJsonFile(renderCachePath, ChunkRenderLangCacheSchema);
            const filesOk =
              cached &&
              cached.hash === chunkRenderHash &&
              (await fileExists(cached.srt_file)) &&
              (await fileExists(cached.mp4_file)) &&
              (await fileExists(cached.wav_file));
            if (!filesOk) {
              allLangsCached = false;
              break;
            }
            cachedChunkLangData[lang] = cached;
          }
        }

        if (allLangsCached) {
          for (const lang of activeTargetLangs) {
            const cData = cachedChunkLangData[lang];
            localArtifacts[lang] = {
              mp4Path: cData.mp4_file,
              wavPath: cData.wav_file,
              srtPath: cData.srt_file,
            };
            localDubSegments.push(...cData.dub_segments);
          }
          await updateProject(projectId, (cur) => ({
            ...cur,
            chunks: cur.chunks.map((c) =>
              c.index === chunk.index
                ? {
                    ...c,
                    status: 'done',
                    analyze_done: true,
                    dub_done_langs: [...activeTargetLangs],
                    error: undefined,
                    updated_at: new Date().toISOString(),
                  }
                : c,
            ),
          }));
          return {
            localSpeakers,
            localSpeechIdOffset,
            localCueIdOffset,
            localArtifacts,
            localDubSegments,
            localTextModels,
            localTtsModels,
          };
        }

        // Only mark chunk as running once we know it actually needs TTS/render (never for cached chunks)
        await updateProject(projectId, (cur) => ({
          ...cur,
          chunks: cur.chunks.map((c) =>
            c.index === chunk.index ? { ...c, status: 'running', error: undefined } : c,
          ),
          stages: {
            ...cur.stages,
            dub: {
              ...cur.stages.dub,
              status: 'running',
              error: undefined,
              message: timeLabel,
              updated_at: new Date().toISOString(),
            },
          },
        }));

        // Extract chunk 48 kHz slice if needed (for Demucs vocal separation / 20% Recap bed / ducked Dubbing bed).
        // Skipped entirely in 'mute_original' mode (silent bed, no Demucs/Kaggle).
        const chunkBackgroundAudioMode = resolveBackgroundAudioMode({
          project: latestProj,
          isRecapMode: isRecap,
        });
        const keepOriginalBed =
          chunkBackgroundAudioMode === 'keep_bgm_demucs' && project.video.has_audio;
        const sourceAudio48kPath = path.join(paths.workDir, 'audio_48k.wav');
        const chunkAudio48kPath = path.join(chunkDir, 'audio_48k.wav');
        if (keepOriginalBed && (await fileExists(sourceAudio48kPath))) {
          if (force || !(await fileExists(chunkAudio48kPath))) {
            await extractChunk48kSlice({
              sourceAudio48kPath,
              outChunk48kPath: chunkAudio48kPath,
              startMs: chunk.start_ms,
              endMs: chunk.end_ms,
            });
          }
        }

        const sourceVideoPath = path.join(paths.sourceDir, project.video.filename);

        for (const lang of activeTargetLangs) {
            const baseGlossary = lockedGlossaryByLang[lang] ?? {};
            let mergedGlossary = { ...baseGlossary };
            if (chunkCues.length > 0 && chunk.index > 0) {
              const chunkTerms = await extractGlossaryForLang({
                projectId,
                cues: chunkCues,
                targetLang: lang,
                modelId: cfg.TEXT_MODEL,
                force: Boolean(opts.translateFirst),
                boundedWait: true,
              });
              if (chunkTerms.modelUsed) localTextModels.add(chunkTerms.modelUsed);
              // Chunk 1 names/terms always override local extractions for cross-chunk consistency
              mergedGlossary = { ...chunkTerms.glossary, ...baseGlossary };
            }

            // 2) Translate chunk cues
            await emitChunkState(
              projectId,
              {
                active: true,
                current_index: i,
                total_chunks: chunks.length,
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                phase: 'translate',
                message: `${timeLabel} · [${lang}] Translating ${chunkCues.length} lines...`,
              },
              baseChunkPct,
            );

            let translatedMap = new Map<number, TranslatedCueItem>();
            if (chunkCues.length > 0) {
              const translateFn = isRecap ? translateRecapCuesBatched : translateDubCuesBatched;
              const tRes = await translateFn({
                projectId,
                cues: chunkCues,
                allCues: chunkCues,
                targetLang: lang,
                glossary: mergedGlossary,
                speechStyle: cfg.SPEECH_STYLE,
                modelId: cfg.TEXT_MODEL,
                force: Boolean(opts.translateFirst),
                boundedWait: true,
              });
              translatedMap = tRes.translations;
              for (const m of tRes.modelsUsed) localTextModels.add(m);
            }

            // 3) TTS & Hybrid Fit Loop per cue in chunk
            await emitChunkState(
              projectId,
              {
                active: true,
                current_index: i,
                total_chunks: chunks.length,
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                phase: 'tts',
                message: `${timeLabel} · [${lang}] TTS & sync (${chunkCues.length} lines)...`,
              },
              Math.min(89, baseChunkPct + 2),
            );

            const fittedLangSegs: DubSegment[] = [];
            for (let cIdx = 0; cIdx < chunkCues.length; cIdx++) {
              const cue = chunkCues[cIdx];
              const tr = translatedMap.get(cue.id);
              const tgtText = (tr?.translation || cue.text).trim();
              const spkInfo = localSpeakers[cue.speaker];
              const spkGender = spkInfo?.gender ?? 'unknown';
              const voiceName = resolveStrictVoiceForSpeaker({
                engine: activeEngine,
                targetLang: lang,
                speakerGender: spkGender,
                voiceOverridden: spkInfo?.voice_overridden,
                speakerVoice: spkInfo?.voice,
                candidateVoice:
                  lang === primaryAudioLang && lockedSpeakerVoices[cue.speaker]?.engine === activeEngine
                    ? lockedSpeakerVoices[cue.speaker].name
                    : spkInfo?.voice?.name,
                voicePools: cfg.VOICE_POOLS,
              });

              const draftSeg: DubSegment = {
                id: cue.id,
                lang,
                start_ms: cue.start_ms,
                end_ms: cue.end_ms,
                speaker: cue.speaker,
                src_lang: cue.src_lang,
                src_text: cue.text,
                tgt_text: tgtText,
                slot_ms: Math.max(200, cue.end_ms - cue.start_ms),
                tts_ms: 0,
                tts_file: '',
                rate: isRecap ? RECAP_BASE_TTS_RATE : 1,
                video_rate: 1,
                status: tr?.review_reason ? 'needs_review' : 'ok',
                review_reason: tr?.review_reason,
                merged_ids: cue.merged_ids,
                voice_name: voiceName,
                model_used: tr?.model_used || cfg.TEXT_MODEL,
                tts_engine: activeEngine,
                syllables: countSyllables(tgtText, lang),
              };

              const fit = isRecap
                ? await runRecapFitLoopForSegment({
                    projectId,
                    seg: draftSeg,
                    speakerGender: spkGender,
                    glossary: mergedGlossary,
                    force: Boolean(opts.translateFirst),
                  })
                : await runFitLoopForSegment({
                    projectId,
                    seg: draftSeg,
                    speakerGender: spkGender,
                    voiceOverridden: spkInfo?.voice_overridden,
                    speakerVoice: spkInfo?.voice,
                    allCues: chunkCues,
                    rangeEndMs: chunk.end_ms,
                    glossary: mergedGlossary,
                    force: Boolean(opts.translateFirst),
                  });
              fittedLangSegs.push(fit.segment);
              if (fit.segment.model_used) localTextModels.add(fit.segment.model_used);
              if (fit.segment.tts_model_used) localTtsModels.add(fit.segment.tts_model_used);

              if (fit.empiricalSpsSample !== undefined) {
                const list = spsSamples[lang] ?? [];
                if (list.length < 5) {
                  list.push(fit.empiricalSpsSample);
                  spsSamples[lang] = list;
                  calibratedSps[lang] = Number(
                    (list.reduce((a, b) => a + b, 0) / list.length).toFixed(2),
                  );
                }
              }
            }

            // 4) Render chunk MP4, WAV, and SRT
            await emitChunkState(
              projectId,
              {
                active: true,
                current_index: i,
                total_chunks: chunks.length,
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                phase: 'render',
                message: `${timeLabel} · [${lang}] Rendering chunk video & audio...`,
              },
              Math.min(90, baseChunkPct + 4),
            );

            const orderedFittedSegs = [...fittedLangSegs].sort((a, b) => a.start_ms - b.start_ms);
            const slowIntervals = isRecap
              ? buildRecapSlowIntervals(orderedFittedSegs)
              : buildDubSlowIntervals(orderedFittedSegs, MIN_DUB_VIDEO_RATE, chunk.end_ms);

            const partitions = computePiecewiseTimeline(
              chunk.start_ms,
              chunk.end_ms,
              slowIntervals,
              isRecap ? RECAP_MIN_VIDEO_RATE : MIN_DUB_VIDEO_RATE,
            );
            const totalOutDurMs =
              partitions.length > 0
                ? partitions[partitions.length - 1].outEndMs
                : Math.max(200, chunk.end_ms - chunk.start_ms);

            const rawChunkSpeech = latestProj.speech
              .filter((s) => s.end_ms + 250 > chunk.start_ms && s.start_ms - 250 < chunk.end_ms)
              .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms }));

            const chunkBedPath = path.join(chunkDir, `bed_${lang}.wav`);
            await buildDuckedBed48k({
              hasAudio: keepOriginalBed && (await fileExists(chunkAudio48kPath)),
              audio48kPath: chunkAudio48kPath,
              sourceOffsetMs: chunk.start_ms,
              rangeStartMs: chunk.start_ms,
              rangeEndMs: chunk.end_ms,
              speechWindows: [
                ...rawChunkSpeech,
                ...analyzeRes.chunkSegments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms })),
                ...orderedFittedSegs.map((s) => ({
                  start_ms: s.start_ms,
                  end_ms: s.borrowed_end_ms ?? s.end_ms,
                })),
              ],
              partitions,
              outBedPath: chunkBedPath,
              recapMode: isRecap,
              recapMuteOriginal: latestProj.recap_mute_original ?? true,
              backgroundAudioMode: chunkBackgroundAudioMode,
            });

            const placedClips: Array<{ wavPath: string; startMs: number; durationMs: number }> = [];
            const placedSegs: DubSegment[] = [];
            const minGapMs = isRecap ? 0 : 50;
            let prevOutEndMs = isRecap ? chunk.start_ms : chunk.start_ms - 100;

            for (const seg of orderedFittedSegs) {
              const mappedStart = chunk.start_ms + mapSourceMsToOutputRelMs(seg.start_ms, partitions);
              const mappedEnd =
                chunk.start_ms +
                mapSourceMsToOutputRelMs(seg.borrowed_end_ms ?? seg.end_ms, partitions);
              const effStart = Math.max(mappedStart, prevOutEndMs + minGapMs);
              const effEnd = isRecap
                ? effStart + Math.max(0, seg.tts_ms)
                : Math.max(mappedEnd, effStart + seg.tts_ms);

              const nextSeg: DubSegment = {
                ...seg,
                effective_start_ms: effStart,
                effective_end_ms: effEnd,
              };
              placedSegs.push(nextSeg);

              if (nextSeg.tts_file) {
                const abs = getClipAbsolutePath(projectId, nextSeg.tts_file);
                if (await fileExists(abs)) {
                  placedClips.push({ wavPath: abs, startMs: effStart, durationMs: nextSeg.tts_ms });
                  prevOutEndMs = effStart + Math.max(0, nextSeg.tts_ms);
                }
              } else {
                prevOutEndMs = effEnd;
              }
            }

            const chunkCanvasPath = path.join(chunkDir, `canvas_${lang}.wav`);
            const { hasNonSilentDub } = await assembleDubCanvas48k({
              clips: placedClips,
              rangeStartMs: chunk.start_ms,
              rangeEndMs: chunk.end_ms,
              totalDurMs: totalOutDurMs,
              outCanvasPath: chunkCanvasPath,
            });

            const chunkMp4Path = path.join(chunkDir, `dub_${lang}.mp4`);
            const chunkWavPath = path.join(chunkDir, `dub_${lang}.wav`);
            const chunkSrtPath = path.join(chunkDir, `dub_${lang}.srt`);
            const chunkReportPath = path.join(chunkDir, `report_${lang}.json`);
            const chunkDubNormPath = path.join(chunkDir, `dub_norm_${lang}.wav`);
            const chunkSlicePath = path.join(chunkDir, `video_slice_${lang}.mp4`);

            await mixAndMuxDubbedOutput({
              projectId,
              lang,
              sourceVideoPath,
              canvasPath: chunkCanvasPath,
              hasNonSilentDub,
              bedPath: chunkBedPath,
              rangeStartMs: chunk.start_ms,
              rangeEndMs: chunk.end_ms,
              isFullVideo: false,
              partitions,
              dubSegments: placedSegs,
              ttsVolumePct: isRecap
                ? Math.max(RECAP_MIN_TTS_VOLUME_PCT, cfg.TTS_VOLUME_PCT ?? RECAP_MIN_TTS_VOLUME_PCT)
                : cfg.TTS_VOLUME_PCT,
              outPaths: {
                mp4Path: chunkMp4Path,
                wavPath: chunkWavPath,
                srtPath: chunkSrtPath,
                reportPath: chunkReportPath,
                dubNormPath: chunkDubNormPath,
                sliceVideoPath: chunkSlicePath,
              },
            });
            await rewriteSplitSrtFile(chunkSrtPath, lang);

            await writeJsonAtomic(path.join(chunkDir, `render_${lang}.json`), {
              hash: chunkRenderHash,
              lang,
              chunk_index: chunk.index,
              cue_count: chunkCues.length,
              dub_segments: placedSegs,
              mp4_file: chunkMp4Path,
              wav_file: chunkWavPath,
              srt_file: chunkSrtPath,
            });

            localArtifacts[lang] = {
              mp4Path: chunkMp4Path,
              wavPath: chunkWavPath,
              srtPath: chunkSrtPath,
            };
            localDubSegments.push(...placedSegs);

            await updateProject(projectId, (cur) => ({
              ...cur,
              calibrated_sps: calibratedSps,
              dub: upsertChunkDubIntoList(cur.dub, lang, chunk.start_ms, chunk.end_ms, placedSegs),
            }));
          }

        // Mark chunk completed immediately on disk so resume picks up cleanly at i + 1
        await updateProject(projectId, (cur) => ({
          ...cur,
          chunks: cur.chunks.map((c) =>
            c.index === chunk.index
              ? {
                  ...c,
                  status: 'done',
                  analyze_done: true,
                  dub_done_langs: [...activeTargetLangs],
                  error: undefined,
                  rendered_mp4_files: Object.fromEntries(
                    activeTargetLangs.map((l) => [
                      l,
                      `cache/chunks/chunk_${String(chunk.index).padStart(3, '0')}/dub_${l}.mp4`,
                    ]),
                  ),
                  rendered_wav_files: Object.fromEntries(
                    activeTargetLangs.map((l) => [
                      l,
                      `cache/chunks/chunk_${String(chunk.index).padStart(3, '0')}/dub_${l}.wav`,
                    ]),
                  ),
                  rendered_srt_files: Object.fromEntries(
                    activeTargetLangs.map((l) => [
                      l,
                      `cache/chunks/chunk_${String(chunk.index).padStart(3, '0')}/dub_${l}.srt`,
                    ]),
                  ),
                  updated_at: new Date().toISOString(),
                }
              : c,
          ),
        }));

        return {
          localSpeakers,
          localSpeechIdOffset,
          localCueIdOffset,
          localArtifacts,
          localDubSegments,
          localTextModels,
          localTtsModels,
        };
      };

      const chunkOutcome = await withExponentialBackoffRetry(processSingleChunk, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        factor: 2,
        label: `Render Chunk ${i + 1}/${chunks.length}`,
        onRetry: async ({ attempt, maxAttempts, friendlyReason }) => {
          await emitChunkState(
            projectId,
            {
              active: true,
              current_index: i,
              total_chunks: chunks.length,
              start_ms: chunk.start_ms,
              end_ms: chunk.end_ms,
              phase: 'translate',
              message: `${timeLabel} · Retry ${attempt + 1}/${maxAttempts} (${friendlyReason})...`,
            },
            baseChunkPct,
          );
        },
      });

      canonicalSpeakers = chunkOutcome.localSpeakers;
      speechIdOffset = chunkOutcome.localSpeechIdOffset;
      cueIdOffset = chunkOutcome.localCueIdOffset;
      for (const m of chunkOutcome.localTextModels) textModelsSet.add(m);
      for (const m of chunkOutcome.localTtsModels) ttsModelsSet.add(m);
      for (const [l, artifact] of Object.entries(chunkOutcome.localArtifacts)) {
        chunkArtifactsByLang[l]?.push(artifact);
      }
      allDubSegments.push(...chunkOutcome.localDubSegments);
    }

    // 5) Final Merge via FFmpeg concat demuxer across all chunk outputs
    const mergeMsg = `အပိုင်း ${chunks.length} ခုလုံးကို ဗီဒီယိုတစ်ခုတည်းအဖြစ် ပေါင်းစည်းနေသည် (FFmpeg Concat Merge)...`;
    await emitChunkState(
      projectId,
      {
        active: true,
        current_index: chunks.length - 1,
        total_chunks: chunks.length,
        start_ms: 0,
        end_ms: project.video.duration_ms,
        phase: 'merging',
        message: mergeMsg,
      },
      93,
    );

    const reports: DubValidationReport[] = [];
    for (const lang of activeTargetLangs) {
      const langSegs = allDubSegments
        .filter((d) => d.lang === lang)
        .sort((a, b) => a.start_ms - b.start_ms);
      const report = await concatenateChunkOutputs({
        projectId,
        lang,
        chunkArtifacts: chunkArtifactsByLang[lang] ?? [],
        dubSegments: langSegs,
        totalSourceDurationMs: project.video.duration_ms,
      });
      await rewriteSplitSrtFile(path.join(paths.outDir, `dub_${lang}.srt`), lang);
      reports.push(report);

      // Keep clean base MP4 in sync with merged full-length output so Step 5 editor/raw preview never serves an earlier test clip
      const mergedOutMp4 = path.join(paths.outDir, `dub_${lang}.mp4`);
      const cleanBaseMp4 = path.join(paths.dubDir, `base_${lang}.mp4`);
      if (await fileExists(mergedOutMp4)) {
        await fs.mkdir(paths.dubDir, { recursive: true });
        const tmpBaseMp4 = `${cleanBaseMp4}.tmp.${process.pid}.${Date.now()}`;
        await fs.copyFile(mergedOutMp4, tmpBaseMp4);
        await fs.rename(tmpBaseMp4, cleanBaseMp4);
      }
    }

    const finalModelSummary = `TEXT: ${Array.from(textModelsSet).join(', ')} · TTS: ${Array.from(ttsModelsSet).join(', ') || (activeEngine === 'edge' ? 'edge-tts' : cfg.TTS_MODEL)}`;
    const avSummary = reports
      .map((r) => `${r.lang}: |A-V|=${r.av_diff_ms}ms (${r.passed_40ms ? 'PASS' : 'CHECK'})`)
      .join(' | ');
    const doneMessage = `Chunked render complete (${chunks.length} chunks, ${formatChunkClock(project.video.duration_ms)}) · ${avSummary}`;

    const doneProgress: ChunkProgress = {
      active: false,
      current_index: Math.max(0, chunks.length - 1),
      total_chunks: chunks.length,
      start_ms: 0,
      end_ms: project.video.duration_ms,
      phase: 'done',
      message: doneMessage,
    };

    const sortedAllDub = allDubSegments.sort((a, b) => {
      if (a.lang !== b.lang) return a.lang.localeCompare(b.lang);
      return a.start_ms - b.start_ms;
    });

    const finalProj = await updateProject(projectId, (cur) => ({
      ...cur,
      no_dialogue: cur.speech.length === 0,
      speakers: canonicalSpeakers,
      dub_glossary: lockedGlossaryByLang,
      calibrated_sps: calibratedSps,
      dub: sortedAllDub,
      dub_reports: reports,
      dub_combined_mp4: undefined,
      chunk_progress: doneProgress,
      stages: {
        ...cur.stages,
        speech: {
          ...cur.stages.speech,
          status: 'done',
          progress_pct: 100,
          updated_at: new Date().toISOString(),
        },
        speakers: {
          ...cur.stages.speakers,
          status: 'done',
          progress_pct: 100,
          updated_at: new Date().toISOString(),
        },
        dub: {
          status: 'done',
          progress_pct: 100,
          message: doneMessage,
          model_used: finalModelSummary,
          updated_at: new Date().toISOString(),
        },
      },
    }));

    emitProjectEvent(projectId, {
      type: 'chunk',
      stage: 'dub',
      progress_pct: 100,
      eta_sec: 0,
      message: doneMessage,
      chunk_progress: doneProgress,
      chunks: finalProj.chunks,
      project: finalProj,
    });
    emitProjectEvent(projectId, {
      type: 'project',
      stage: 'dub',
      progress_pct: 100,
      eta_sec: 0,
      message: doneMessage,
      project: finalProj,
    });

    return finalProj;
  } catch (err) {
    const friendlyMsg = formatChunkFailureMessage(activeChunkIndex, err);
    console.error(`[LongVideo] Render failed at chunk ${activeChunkIndex + 1}:`, err);
    const failedChunk = chunks[activeChunkIndex];
    const errProj = await updateProject(projectId, (cur) => ({
      ...cur,
      chunks: cur.chunks.map((c) =>
        c.index === activeChunkIndex || c.status === 'running'
          ? { ...c, status: 'error', error: friendlyMsg, updated_at: new Date().toISOString() }
          : c,
      ),
      chunk_progress: {
        active: false,
        current_index: activeChunkIndex,
        total_chunks: chunks.length,
        start_ms: failedChunk?.start_ms ?? 0,
        end_ms: failedChunk?.end_ms ?? 0,
        phase: 'error',
        message: friendlyMsg,
      },
      stages: {
        ...cur.stages,
        dub: {
          ...cur.stages.dub,
          status: 'error',
          error: friendlyMsg,
          message: friendlyMsg,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: 'error',
      stage: 'dub',
      message: friendlyMsg,
      chunk_progress: errProj.chunk_progress,
      chunks: errProj.chunks,
      project: errProj,
    });
    return errProj;
  }
}
