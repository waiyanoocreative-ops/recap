import './server/loadEnv.ts';
import { installServerLogCapture, getServerLogErrors, getServerLogs } from './server/logBuffer.ts';
installServerLogCapture();

import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  BackgroundAudioModeSchema,
  DubSelectionSchema,
  ExportVisualConfigSchema,
  GenderSchema,
  MANUAL_AI_BATCH_REMINDER,
  MANUAL_AI_BATCH_SIZE,
  MANUAL_AI_SINGLE_BATCH_MAX,
  ProjectModeSchema,
  RecapBeatSchema,
  RecapSourceModeSchema,
  TargetLangSchema,
  TtsEngineTypeSchema,
  parseManualAiJsonReply,
  splitManualAiCuesIntoBatches,
  type CapabilitiesResponse,
  type DubSegment,
  type DubSelection,
  type DubValidationReport,
  type Gender,
  type ManualAiBatch,
  type ManualAiBridgeMode,
  type ManualAiPromptsResponse,
  type Project,
  type RecapBeat,
  type RecapSourceMode,
  type TargetLang,
  type TtsEngineType,
  type VoicesCatalogResponse,
} from './shared/projectTypes.ts';
import {
  PatchConfigSchema,
  buildDemucsEndpoint,
  geminiRuntime,
  getConfig,
  loadStartupConfig,
  normalizeDemucsRemoteUrl,
  requestCounts,
  resolveDemucsRemoteUrl,
  saveConfig,
  updateConfig,
} from './server/config.ts';
import {
  emitProjectEvent,
  subscribeProjectEvents,
  subscribeProjectWebSocket,
} from './server/events/sseBus.ts';
import { checkMediaBinariesAtStartup, getBinaryStatus } from './server/media/binaries.ts';
import { fileExists, handleUploadChunk, runS0Ingest } from './server/media/ingest.ts';
import { hashString } from './server/analyze/cache.ts';
import { runS3Maps } from './server/analyze/s3Maps.ts';
import { runS1SpeechMap } from './server/analyze/s1SpeechMap.ts';
import { runS2Speakers } from './server/analyze/s2Speakers.ts';
import { isLongVideoDuration } from './shared/chunkPlanner.ts';
import {
  getVoiceGender,
  resolveStrictVoiceForSpeaker,
  validateTranslationCompleteness,
} from './shared/dubUtils.ts';
import {
  type AnalyzeStageMode,
  runChunkedAnalyzePipeline,
  runChunkedDubRenderPipeline,
} from './server/chunks/longVideoPipeline.ts';
import {
  assembleDubCanvas48k,
  buildDuckedBed48k,
  computePiecewiseTimeline,
  concatenateChunkOutputs,
  mapSourceMsToOutputRelMs,
  mixAndMuxDubbedOutput,
  resolveBackgroundAudioMode,
  type TimelinePartition,
} from './server/dub/audioDsp.ts';
import {
  MIN_DUB_VIDEO_RATE,
  buildDubSlowIntervals,
  getClipAbsolutePath,
  prepareDubTranslate,
  regenerateDubLineAndRemix,
  retranslateDubLineCompleteAndSave,
  runDubRenderPipeline,
  runFitLoopForSegment,
  saveExportLogoPng,
} from './server/dub/dubPipeline.ts';
import {
  exportProjectWithVisualConfig,
  resolveSingleTargetLang,
  resolveSubtitleModeForLang,
  splitSrtDocument,
} from './server/dub/srtBuilder.ts';
import {
  buildManualAiRecapPrompt,
  buildManualAiRecapSourceCues,
  detectRecapSourceMode,
} from './server/recap/recapScriptGenerator.ts';
import {
  approveAndRenderRecapVideo,
  generateRecapScriptForProject,
  resolveDefaultNarratorVoice,
  saveRecapEdits,
} from './server/recap/recapStudioPipeline.ts';
import {
  computeRecapMaxSyllables,
  validateRecapTranslation,
} from './server/recap/recapTranslator.ts';
import { buildDubSourceCues, countSyllables, selectDubCues } from './server/dub/syllables.ts';
import {
  buildManualAiDubPrompt,
  resolveSpeakerVoicesForEngine,
} from './server/dub/translate.ts';
import { redactSecrets } from './server/gemini/keyPool.ts';
import {
  GEMINI_PREBUILT_VOICES,
  edgeTtsRuntime,
  getTtsEngine,
  initEdgeTtsAtStartup,
  listEdgeVoicesFiltered,
  synthesizeEdgeTtsBatch,
} from './server/tts/ttsEngine.ts';
import {
  DATA_DIR,
  checkDiskSpace,
  cleanupProjectWorkCache,
  createProject,
  deleteProject,
  ensureDataRoot,
  getProject,
  getProjectPaths,
  listProjects,
  readProjectSnapshot,
  resetInterruptedStagesOnStartup,
  updateProject,
} from './server/storage/projectStore.ts';
import { createProjectBackupZip, restoreProjectFromZipBuffer } from './server/storage/backupZip.ts';

const activeJobs = new Set<string>();

process.on('unhandledRejection', (reason) => {
  console.error('[Server unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server uncaughtException]', err);
});

/**
 * Zero-API-Key Dubbing Render Pipeline when `useManualAiBridge` is enabled.
 * Runs Edge-TTS synthesis (with strict gender voice mapping), 1.0x–1.2x audio fit loop
 * + video slowdown down to 0.65x, piecewise timeline partitioning for long movies (up to 240 mins),
 * ducked background bed, loudnorm dub canvas, and compact AAC 128k MP4 muxing without requiring a Gemini key.
 */
async function runManualBridgeDubRenderPipeline(
  projectId: string,
  opts: { selection?: DubSelection; force?: boolean } = {},
): Promise<Project> {
  const force = Boolean(opts.force);
  const cfg = getConfig();
  const initialProj = await getProject(projectId);
  if (!initialProj) throw new Error(`Project "${projectId}" not found.`);
  if (!initialProj.upload.completed || initialProj.stages.speech.status !== 'done') {
    throw new Error('Stage 2 must complete before running Stage 3 Dubbing.');
  }

  const singleLang = resolveSingleTargetLang(initialProj.target_langs);
  const selection = opts.selection ?? initialProj.dub_selection;
  const allCues = buildDubSourceCues(initialProj.speech);
  const sel = selectDubCues(
    allCues,
    selection,
    initialProj.video.duration_ms || 0,
    initialProj.mode,
  );
  const paths = getProjectPaths(projectId);
  const sourceVideoPath = path.join(paths.sourceDir, initialProj.video.filename);
  const audio48kPath = path.join(paths.workDir, 'audio_48k.wav');
  const backgroundAudioMode = resolveBackgroundAudioMode({
    project: initialProj,
    isRecapMode: initialProj.mode === 'recap',
  });

  const emitProgress = async (
    pct: number,
    message: string,
    status: 'running' | 'done' | 'error' = 'running',
    error?: string,
    etaSec?: number,
  ): Promise<Project> => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      ...(opts.selection ? { dub_selection: opts.selection } : {}),
      stages: {
        ...cur.stages,
        dub: {
          ...cur.stages.dub,
          status,
          progress_pct: pct,
          message,
          error,
          model_used: 'manual-ai-bridge',
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: error ? 'error' : status === 'done' ? 'project' : 'stage',
      stage: 'dub',
      progress_pct: pct,
      eta_sec: etaSec,
      message,
      project: updated,
    });
    return updated;
  };

  try {
    const importedSegs = initialProj.dub
      .filter((d) => d.lang === singleLang)
      .sort((a, b) => a.start_ms - b.start_ms);

    if (!initialProj.no_dialogue && sel.selected.length > 0 && importedSegs.length === 0) {
      throw new Error(
        'No translated lines imported yet for Manual AI Chat Bridge. Complete Steps 1–3 to import JSON before rendering.',
      );
    }

    await emitProgress(5, `Preparing ${importedSegs.length} imported cue(s) for Edge-TTS synthesis...`);

    const engine: TtsEngineType = cfg.TTS_ENGINE;
    const voiceMap = resolveSpeakerVoicesForEngine({
      engine,
      speakers: initialProj.speakers,
      cues: allCues,
      targetLang: singleLang,
      voicePools: cfg.VOICE_POOLS,
    });

    const selectedIdSet = new Set(sel.selected.map((c) => c.id));
    const targetSegs =
      selection.mode === 'all'
        ? importedSegs
        : importedSegs.filter((s) => selectedIdSet.has(s.id)).length > 0
          ? importedSegs.filter((s) => selectedIdSet.has(s.id))
          : importedSegs;

    const preparedSegs: DubSegment[] = targetSegs.map((seg) => {
      const spkInfo = initialProj.speakers[seg.speaker];
      const strictVoice = resolveStrictVoiceForSpeaker({
        engine,
        targetLang: singleLang,
        speakerGender: spkInfo?.gender ?? 'unknown',
        voiceOverridden: spkInfo?.voice_overridden,
        speakerVoice: spkInfo?.voice,
        candidateVoice: seg.voice_name || voiceMap[seg.speaker],
        voicePools: cfg.VOICE_POOLS,
      });
      return {
        ...seg,
        voice_name: strictVoice,
        tts_engine: engine,
        model_used: seg.model_used || 'manual-ai-bridge',
      };
    });

    if (engine === 'edge' && preparedSegs.length > 0) {
      await emitProgress(12, `Pre-synthesizing ${preparedSegs.length} Edge-TTS voices in batch...`);
      await synthesizeEdgeTtsBatch(
        preparedSegs.map((s) => {
          const voice =
            s.voice_name ||
            resolveStrictVoiceForSpeaker({
              engine: 'edge',
              targetLang: singleLang,
              speakerGender: initialProj.speakers[s.speaker]?.gender ?? 'unknown',
              voicePools: cfg.VOICE_POOLS,
            });
          const contentHash = hashString(`${s.tgt_text}|${voice}|+0%|+0Hz`);
          return {
            id: `${s.lang}:${s.id}`,
            text: s.tgt_text,
            voice,
            outPath: path.join(paths.cacheDir, `tts_edge_${contentHash}.mp3`),
          };
        }),
      );
    }

    const glossary = initialProj.dub_glossary?.[singleLang] ?? {};
    const fittedSegs: DubSegment[] = new Array(preparedSegs.length);
    const spsSamples: number[] = [];
    let completedCount = 0;
    let nextIdx = 0;
    const startTs = Date.now();
    const concurrency = Math.min(4, Math.max(1, preparedSegs.length));

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIdx < preparedSegs.length) {
          const i = nextIdx;
          nextIdx += 1;
          const seg = preparedSegs[i];
          const spkInfo = initialProj.speakers[seg.speaker];
          const fitRes = await runFitLoopForSegment({
            projectId,
            seg,
            speakerGender: spkInfo?.gender ?? 'unknown',
            voiceOverridden: spkInfo?.voice_overridden,
            speakerVoice: spkInfo?.voice,
            allCues,
            rangeEndMs: sel.rangeEndMs,
            glossary,
            force,
          });
          fittedSegs[i] = fitRes.segment;
          if (fitRes.empiricalSpsSample) {
            spsSamples.push(fitRes.empiricalSpsSample);
          }
          completedCount += 1;
          if (completedCount % 5 === 0 || completedCount === preparedSegs.length) {
            const elapsedSec = Math.max(1, (Date.now() - startTs) / 1000);
            const ratePerSec = completedCount / elapsedSec;
            const eta = Math.round((preparedSegs.length - completedCount) / Math.max(0.05, ratePerSec));
            const pct = 15 + Math.round((completedCount / Math.max(1, preparedSegs.length)) * 55);
            await emitProgress(
              pct,
              `Synced TTS ${completedCount}/${preparedSegs.length} cues (1.0x–1.2x audio, max 0.65x video)...`,
              'running',
              undefined,
              eta,
            );
          }
        }
      }),
    );

    await emitProgress(74, 'Mixing ducked background bed & rendering compact AAC MP4...');

    const slowIntervals = buildDubSlowIntervals(fittedSegs, MIN_DUB_VIDEO_RATE, sel.rangeEndMs);
    const fullPartitions = computePiecewiseTimeline(
      sel.rangeStartMs,
      sel.rangeEndMs,
      slowIntervals,
      MIN_DUB_VIDEO_RATE,
    );
    const totalOutDurMs =
      fullPartitions.length > 0
        ? fullPartitions[fullPartitions.length - 1].outEndMs
        : Math.max(100, sel.rangeEndMs - sel.rangeStartMs);

    const speechWindows = [
      ...initialProj.speech
        .filter((s) => s.end_ms + 250 > sel.rangeStartMs && s.start_ms - 250 < sel.rangeEndMs)
        .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms })),
      ...fittedSegs.map((s) => ({
        start_ms: s.start_ms,
        end_ms: s.borrowed_end_ms ?? s.end_ms,
      })),
    ];

    const placedClips: Array<{ wavPath: string; startMs: number; durationMs: number }> = [];
    const placedSegments: DubSegment[] = [];
    let prevOutEndMs = sel.rangeStartMs - 100;

    for (const seg of fittedSegs) {
      const mappedStart = sel.rangeStartMs + mapSourceMsToOutputRelMs(seg.start_ms, fullPartitions);
      const mappedEnd =
        sel.rangeStartMs + mapSourceMsToOutputRelMs(seg.borrowed_end_ms ?? seg.end_ms, fullPartitions);
      const effStart = Math.max(mappedStart, prevOutEndMs + 50);
      const effEnd = Math.max(mappedEnd, effStart + seg.tts_ms);
      const nextSeg: DubSegment = {
        ...seg,
        effective_start_ms: effStart,
        effective_end_ms: effEnd,
      };
      placedSegments.push(nextSeg);
      if (nextSeg.tts_file) {
        const abs = getClipAbsolutePath(projectId, nextSeg.tts_file);
        if (await fileExists(abs)) {
          placedClips.push({ wavPath: abs, startMs: effStart, durationMs: nextSeg.tts_ms });
          prevOutEndMs = effStart + Math.max(0, nextSeg.tts_ms);
          continue;
        }
      }
      prevOutEndMs = effEnd;
    }

    let report: DubValidationReport;
    if (fullPartitions.length <= 36) {
      const bedPath = path.join(paths.dubDir, `bed_ducked_${singleLang}.wav`);
      await buildDuckedBed48k({
        hasAudio: initialProj.video.has_audio,
        audio48kPath,
        rangeStartMs: sel.rangeStartMs,
        rangeEndMs: sel.rangeEndMs,
        speechWindows,
        partitions: fullPartitions,
        outBedPath: bedPath,
        recapMode: false,
      });
      const canvasPath = path.join(paths.dubDir, `canvas_${singleLang}.wav`);
      const { hasNonSilentDub } = await assembleDubCanvas48k({
        clips: placedClips,
        rangeStartMs: sel.rangeStartMs,
        rangeEndMs: sel.rangeEndMs,
        totalDurMs: totalOutDurMs,
        outCanvasPath: canvasPath,
      });
      report = await mixAndMuxDubbedOutput({
        projectId,
        lang: singleLang,
        sourceVideoPath,
        canvasPath,
        hasNonSilentDub,
        bedPath,
        rangeStartMs: sel.rangeStartMs,
        rangeEndMs: sel.rangeEndMs,
        isFullVideo: sel.isFullVideo,
        partitions: fullPartitions,
        dubSegments: placedSegments,
        ttsVolumePct: cfg.TTS_VOLUME_PCT,
      });
    } else {
      // Scalable partitioned path for long videos (>36 slow intervals) -> render groups & concat
      const partRoot = path.join(paths.workDir, 'dub', 'render_parts', singleLang);
      await fs.rm(partRoot, { recursive: true, force: true });
      await fs.mkdir(partRoot, { recursive: true });
      const MAX_PARTS_PER_GROUP = 28;
      const partitionGroups: TimelinePartition[][] = [];
      for (let i = 0; i < fullPartitions.length; i += MAX_PARTS_PER_GROUP) {
        partitionGroups.push(fullPartitions.slice(i, i + MAX_PARTS_PER_GROUP));
      }
      const chunkArtifacts: Array<{ mp4Path: string; wavPath: string; srtPath: string }> = [];
      for (let gIdx = 0; gIdx < partitionGroups.length; gIdx += 1) {
        const group = partitionGroups[gIdx];
        const gSrcStart = group[0].srcStartMs;
        const gSrcEnd = group[group.length - 1].srcEndMs;
        const gOutBase = group[0].outStartMs;
        const gOutEnd = group[group.length - 1].outEndMs;
        const gOutDur = Math.max(100, gOutEnd - gOutBase);

        const shiftedPartitions: TimelinePartition[] = group.map((p) => ({
          ...p,
          outStartMs: p.outStartMs - gOutBase,
          outEndMs: p.outEndMs - gOutBase,
        }));

        const groupClips = placedClips
          .filter((c) => c.startMs - sel.rangeStartMs >= gOutBase - 1 && c.startMs - sel.rangeStartMs < gOutEnd)
          .map((c) => ({
            wavPath: c.wavPath,
            startMs: Math.max(0, c.startMs - sel.rangeStartMs - gOutBase),
            durationMs: c.durationMs,
          }));

        const groupSegs = placedSegments
          .filter(
            (s) =>
              (s.effective_start_ms ?? 0) - sel.rangeStartMs >= gOutBase - 1 &&
              (s.effective_start_ms ?? 0) - sel.rangeStartMs < gOutEnd,
          )
          .map((s) => ({
            ...s,
            effective_start_ms: Math.max(0, (s.effective_start_ms ?? 0) - sel.rangeStartMs - gOutBase),
            effective_end_ms: Math.max(0, (s.effective_end_ms ?? 0) - sel.rangeStartMs - gOutBase),
          }));

        const groupBedPath = path.join(partRoot, `bed_${gIdx}.wav`);
        await buildDuckedBed48k({
          hasAudio: initialProj.video.has_audio,
          audio48kPath,
          rangeStartMs: gSrcStart,
          rangeEndMs: gSrcEnd,
          speechWindows: speechWindows.filter((w) => w.end_ms + 250 > gSrcStart && w.start_ms - 250 < gSrcEnd),
          partitions: shiftedPartitions,
          outBedPath: groupBedPath,
          recapMode: false,
        });

        const groupCanvasPath = path.join(partRoot, `canvas_${gIdx}.wav`);
        const { hasNonSilentDub } = await assembleDubCanvas48k({
          clips: groupClips,
          rangeStartMs: 0,
          rangeEndMs: gOutDur,
          totalDurMs: gOutDur,
          outCanvasPath: groupCanvasPath,
        });

        const mp4Path = path.join(partRoot, `part_${gIdx}.mp4`);
        const wavPath = path.join(partRoot, `part_${gIdx}.wav`);
        const srtPath = path.join(partRoot, `part_${gIdx}.srt`);
        const reportPath = path.join(partRoot, `report_${gIdx}.json`);

        await mixAndMuxDubbedOutput({
          projectId,
          lang: singleLang,
          sourceVideoPath,
          canvasPath: groupCanvasPath,
          hasNonSilentDub,
          bedPath: groupBedPath,
          rangeStartMs: gSrcStart,
          rangeEndMs: gSrcEnd,
          isFullVideo: false,
          partitions: shiftedPartitions,
          dubSegments: groupSegs,
          ttsVolumePct: cfg.TTS_VOLUME_PCT,
          outPaths: {
            mp4Path,
            wavPath,
            srtPath,
            reportPath,
            dubNormPath: path.join(partRoot, `norm_${gIdx}.wav`),
            sliceVideoPath: path.join(partRoot, `slice_${gIdx}.mp4`),
          },
        });
        chunkArtifacts.push({ mp4Path, wavPath, srtPath });

        const partPct = 75 + Math.round(((gIdx + 1) / Math.max(1, partitionGroups.length)) * 20);
        await emitProgress(partPct, `Rendered timeline slice ${gIdx + 1}/${partitionGroups.length}...`);
      }

      report = await concatenateChunkOutputs({
        projectId,
        lang: singleLang,
        chunkArtifacts,
        dubSegments: placedSegments,
        totalSourceDurationMs: Math.max(100, sel.rangeEndMs - sel.rangeStartMs),
      });
    }

    const renderedOutMp4 = path.join(paths.outDir, `dub_${singleLang}.mp4`);
    const cleanBaseMp4 = path.join(paths.dubDir, `base_${singleLang}.mp4`);
    if (await fileExists(renderedOutMp4)) {
      await fs.copyFile(renderedOutMp4, cleanBaseMp4);
    }

    const avgSps =
      spsSamples.length > 0
        ? Number((spsSamples.reduce((a, b) => a + b, 0) / spsSamples.length).toFixed(2))
        : initialProj.calibrated_sps?.[singleLang];

    const placedMap = new Map<string, DubSegment>(
      placedSegments.map((s) => [`${s.lang}:${s.id}`, s]),
    );

    const finalProj = await updateProject(projectId, (cur) => {
      const nextDub = cur.dub
        .filter((d) => d.lang === singleLang)
        .map((d) => placedMap.get(`${d.lang}:${d.id}`) ?? d);
      const otherLangReports = (cur.dub_reports ?? []).filter((r) => r.lang !== singleLang);
      return {
        ...cur,
        dub: nextDub,
        dub_reports: [report, ...otherLangReports],
        dub_combined_mp4: undefined,
        ...(avgSps ? { calibrated_sps: { ...cur.calibrated_sps, [singleLang]: avgSps } } : {}),
        stages: {
          ...cur.stages,
          dub: {
            status: 'done',
            progress_pct: 100,
            message: `Dubbing render complete via Manual AI Bridge (${placedSegments.length} lines · ${report.av_diff_ms}ms A/V diff).`,
            model_used: 'manual-ai-bridge',
            updated_at: new Date().toISOString(),
          },
        },
      };
    });

    emitProjectEvent(projectId, {
      type: 'project',
      stage: 'dub',
      progress_pct: 100,
      message: finalProj.stages.dub.message,
      project: finalProj,
    });
    return finalProj;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitProgress(0, msg, 'error', msg);
    throw err;
  }
}

function parseAnalyzeStageMode(raw: unknown): AnalyzeStageMode {
  const val = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (val === 's1' || val === 's1_only') return 's1_only';
  if (val === 's2' || val === 's2_only') return 's2_only';
  return 'all';
}

async function assertGeminiReadyForStage2(
  projectId: string,
  stage: 'speech' | 'speakers',
): Promise<void> {
  if (geminiRuntime.configured && geminiRuntime.keyValid) return;
  const keyErr =
    geminiRuntime.keyError ||
    'GEMINI_API_KEY is missing or invalid. Set GEMINI_API_KEY in .env.local or your environment.';
  const erroredProj = await updateProject(projectId, (cur) => ({
    ...cur,
    stages: {
      ...cur.stages,
      [stage]: {
        status: 'error',
        progress_pct: 0,
        error: keyErr,
        message: keyErr,
        updated_at: new Date().toISOString(),
      },
    },
  }));
  emitProjectEvent(projectId, {
    type: 'error',
    stage,
    message: keyErr,
    project: erroredProj,
  });
  throw new Error(keyErr);
}

async function runStage2AnalyzePipeline(
  projectId: string,
  forceReset = false,
  stageMode: AnalyzeStageMode = 'all',
): Promise<void> {
  if (activeJobs.has(projectId)) {
    throw new Error('Analysis is already running for this project.');
  }
  activeJobs.add(projectId);
  try {
    const project = await getProject(projectId);
    if (!project) throw new Error(`Project "${projectId}" not found.`);
    if (!project.upload.completed || !project.video.filename) {
      throw new Error('Upload must finish before running analysis.');
    }

    const s1AlreadyCompleted =
      !forceReset &&
      project.stages.speech.status === 'done' &&
      (project.speech.length > 0 || project.no_dialogue);

    let effectiveStageMode: AnalyzeStageMode = stageMode;
    if (s1AlreadyCompleted && stageMode !== 's2_only') {
      console.log(
        `[Pipeline] S1 already completed (${project.speech.length} segments found). Skipping S1 and proceeding directly to S2.`,
      );
      if (stageMode === 's1_only') {
        emitProjectEvent(projectId, {
          type: 'project',
          stage: 'speech',
          progress_pct: 100,
          message: project.no_dialogue
            ? 'S1 already completed: marked as No dialogue. Run S2 (Groq Speakers & Gender) next.'
            : `S1 already completed (${project.speech.length} segments saved). Run S2 (Groq Speakers & Gender) next.`,
          project,
        });
        return;
      }
      effectiveStageMode = 's2_only';
    }

    const runS1 = effectiveStageMode !== 's2_only';
    const runS2 = effectiveStageMode !== 's1_only';

    if (forceReset) {
      const resetProj = await updateProject(projectId, (cur) => ({
        ...cur,
        ...(effectiveStageMode === 'all' ? { speech: [], speakers: {}, no_dialogue: false } : {}),
        ...(effectiveStageMode === 's1_only' ? { speech: [], no_dialogue: false } : {}),
        ...(effectiveStageMode === 's2_only' ? { speakers: {} } : {}),
        stages: {
          ...cur.stages,
          ...(runS1
            ? {
                maps: { status: 'pending', progress_pct: 0, message: 'Queued for S3 Maps...' },
                speech: {
                  status: 'pending',
                  progress_pct: 0,
                  message: 'Queued for S1 Speech Map...',
                },
              }
            : {}),
          ...(runS2
            ? {
                speakers: {
                  status: 'pending',
                  progress_pct: 0,
                  message: 'Queued for S2 Speakers (Groq + Pitch)...',
                },
              }
            : {
                speakers: {
                  status: 'pending',
                  progress_pct: 0,
                  message: 'Waiting for S2 (Groq Speakers & Gender)...',
                },
              }),
        },
      }));
      emitProjectEvent(projectId, {
        type: 'project',
        stage: runS1 ? 'ingest' : 'speakers',
        progress_pct: 0,
        message:
          effectiveStageMode === 's1_only'
            ? 'Restarting S0 -> S3 -> S1 (Groq) pipeline...'
            : effectiveStageMode === 's2_only'
              ? 'Restarting S2 Speakers (Groq + Pitch) pipeline...'
              : 'Restarting Stage 1–2 analysis pipeline (S0 -> S3 -> S1 -> S2)...',
        project: resetProj,
      });
    }

    const afterS0 = await runS0Ingest(
      projectId,
      forceReset && effectiveStageMode !== 's2_only',
    );
    await runS3Maps(projectId, forceReset && effectiveStageMode !== 's2_only');

    if (effectiveStageMode === 's2_only') {
      const hasSavedS1 =
        afterS0.speech.length > 0 ||
        afterS0.no_dialogue ||
        afterS0.stages.speech.status === 'done';
      if (!hasSavedS1) {
        const s1MissingMsg = 'Run S1 (Groq) first before running S2 (Groq Speakers & Gender).';
        const errProj = await updateProject(projectId, (cur) => ({
          ...cur,
          stages: {
            ...cur.stages,
            speakers: {
              status: 'error',
              progress_pct: 0,
              error: s1MissingMsg,
              message: s1MissingMsg,
              updated_at: new Date().toISOString(),
            },
          },
        }));
        emitProjectEvent(projectId, {
          type: 'error',
          stage: 'speakers',
          message: s1MissingMsg,
          project: errProj,
        });
        throw new Error(s1MissingMsg);
      }
    }

    const groqConfigured = Boolean((getConfig().groqApiKey || process.env.GROQ_API_KEY || '').trim());
    if (afterS0.video.has_audio && runS1 && !groqConfigured) {
      await assertGeminiReadyForStage2(projectId, 'speech');
    }

    let finalProj: Project;
    if (isLongVideoDuration(afterS0.video.duration_ms)) {
      finalProj = await runChunkedAnalyzePipeline(projectId, forceReset, effectiveStageMode);
    } else if (effectiveStageMode === 's1_only') {
      await runS1SpeechMap(projectId, forceReset);
      finalProj = await updateProject(projectId, (cur) => ({
        ...cur,
        stages: {
          ...cur.stages,
          speakers: {
            ...cur.stages.speakers,
            status: 'pending',
            progress_pct: 0,
            error: undefined,
            message: 'S1 complete — run S2 (Groq Speakers & Gender).',
            updated_at: new Date().toISOString(),
          },
        },
      }));
    } else if (effectiveStageMode === 's2_only') {
      finalProj = await runS2Speakers(projectId, forceReset);
    } else {
      await runS1SpeechMap(projectId, forceReset);
      finalProj = await runS2Speakers(projectId, forceReset);
    }

    if (
      (runS1 && finalProj.stages.speech.status === 'error') ||
      (runS2 && finalProj.stages.speakers.status === 'error')
    ) {
      return;
    }

    emitProjectEvent(projectId, {
      type: 'project',
      stage: runS2 ? 'speakers' : 'speech',
      progress_pct: 100,
      message:
        effectiveStageMode === 's1_only'
          ? finalProj.no_dialogue
            ? 'S1 complete (Groq): marked as No dialogue. Run S2 (Groq Speakers & Gender) next.'
            : `S1 complete (Groq): ${finalProj.speech.length} segments transcribed. Run S2 (Groq Speakers & Gender) next.`
          : effectiveStageMode === 's2_only'
            ? `S2 complete (Groq + Pitch): ${Object.keys(finalProj.speakers).length} speakers classified.`
            : finalProj.no_dialogue
              ? 'Stage 2 complete (S0–S3): marked as No dialogue.'
              : `Stage 2 complete (S0–S3): ${finalProj.speech.length} segments, ${Object.keys(finalProj.speakers).length} speakers, ${finalProj.silence_ms.length} silences, ${finalProj.scene_cuts_ms.length} scene cuts.`,
      project: finalProj,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitProjectEvent(projectId, {
      type: 'error',
      message: msg,
    });
    throw err;
  } finally {
    activeJobs.delete(projectId);
  }
}

async function startServer() {
  const app = express();

  // 0. Health Check & Server Error Logs FIRST (before all middleware, static files, and SPA catch-all)
  app.get('/api/health', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({ ok: true });
  });

  app.get('/api/logs', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({
      errors: getServerLogErrors(20),
      lines: getServerLogs(50),
    });
  });

  app.use('/api/projects/:id/export', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '2mb' }));

  let startupError: string | null = null;
  const startupPromise = (async () => {
    try {
      const config = await loadStartupConfig();
      const binaries = await checkMediaBinariesAtStartup();
      await ensureDataRoot();
      await resetInterruptedStagesOnStartup();
      void initEdgeTtsAtStartup().catch((err) => {
        console.warn('[Edge TTS] Background startup self-test failed:', err instanceof Error ? err.message : err);
      });

      if (!binaries.ok) {
        console.error(`[STARTUP ERROR] ${binaries.error}`);
      } else {
        console.log(
          `[Media Binaries] ffmpeg (${binaries.source}): ${binaries.ffmpegPath} | ffprobe: ${binaries.ffprobePath} | demucs: ${binaries.demucsAvailable ? `found (${binaries.demucsPath})` : 'not found on PATH or standard Python bin paths (will use -55 dB fallback)'}`,
        );
      }
      console.log(
        `[Config] TEXT_MODEL=${config.TEXT_MODEL} | TRANSCRIBE_MODEL=${config.TRANSCRIBE_MODEL} | TTS_MODEL=${config.TTS_MODEL} | GAP_MS=${config.GAP_MS} | RECAP_RATIO=${config.RECAP_RATIO}`,
      );
      for (const note of geminiRuntime.resolutionNotes) {
        console.log(`[Gemini Models] ${note}`);
      }
    } catch (err) {
      startupError = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[STARTUP EXCEPTION]', startupError);
      throw err;
    }
  })();
  // Prevent unhandled rejection warning if no API call awaits before a startup failure
  startupPromise.catch(() => {});

  const ensureInitialized = async (_req: Request, _res: Response, next: NextFunction) => {
    try {
      await startupPromise;
      next();
    } catch (err) {
      next(err);
    }
  };
  app.use(['/api', '/voices', '/upload', '/projects', '/events'], ensureInitialized);

  const rawChunkParser = express.raw({
    type: 'application/octet-stream',
    limit: '16mb',
  });

  // 1. Capabilities, Model List, Request Counters & Disk Check
  app.get('/api/capabilities', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const cfg = getConfig();
      const bin = getBinaryStatus();
      const disk = await checkDiskSpace(0);
      const payload: CapabilitiesResponse = {
        stageScope: 'stage3',
        ffmpeg: {
          ok: bin.ok,
          ffmpegPath: bin.ffmpegPath,
          ffprobePath: bin.ffprobePath,
          ffmpegVersion: bin.ffmpegVersion,
          ffprobeVersion: bin.ffprobeVersion,
          source: bin.source,
          error: bin.error,
        },
        demucs: {
          available: bin.demucsAvailable,
        },
        gemini: {
          configured: geminiRuntime.configured,
          keyValid: geminiRuntime.keyValid,
          keyError: geminiRuntime.keyError,
          startupChecked: geminiRuntime.startupChecked,
          availableModelCount: geminiRuntime.availableModels.length,
          availableModels: geminiRuntime.availableModels,
          resolutionNotes: geminiRuntime.resolutionNotes,
        },
        requestCounts: { ...requestCounts },
        config: cfg,
        disk: {
          dataDir: DATA_DIR,
          freeBytes: disk.freeBytes,
          totalBytes: disk.totalBytes,
        },
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/disk-check', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fileSize = Number(req.query.bytes ?? 0);
      if (!Number.isFinite(fileSize) || fileSize < 0) {
        res.status(400).json({ error: 'Invalid bytes query parameter.' });
        return;
      }
      const requiredBytes = fileSize * 3;
      const check = await checkDiskSpace(requiredBytes);
      res.json(check);
    } catch (err) {
      next(err);
    }
  });

  // 1b. Settings & Voices Endpoints (Config Persistence, Edge + Gemini Voice Lists, TTS Preview)
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({ config: getConfig() });
  });

  const saveConfigHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patch = PatchConfigSchema.parse(req.body);
      const updated = await saveConfig(patch);
      res.json({ config: updated });
    } catch (err) {
      next(err);
    }
  };
  app.patch('/api/config', saveConfigHandler);
  app.post('/api/config', saveConfigHandler);

  // 1c. Remote Kaggle Demucs Connection Test (GET <base>/health, no server restart needed)
  const demucsTestHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requested =
        typeof req.body?.url === 'string' && req.body.url.trim().length > 0
          ? normalizeDemucsRemoteUrl(req.body.url)
          : resolveDemucsRemoteUrl();
      if (!requested) {
        res.status(400).json({
          ok: false,
          baseUrl: '',
          healthUrl: '',
          status: null,
          error:
            'No remote demucs URL configured. Enter a Cloudflare Tunnel base URL such as https://xxxx.trycloudflare.com.',
        });
        return;
      }

      const healthUrl = buildDemucsEndpoint(requested, '/health');
      const startedAt = Date.now();
      try {
        const healthRes = await fetch(healthUrl, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await healthRes.text().catch(() => '')).slice(0, 400);
        const latencyMs = Date.now() - startedAt;
        if (healthRes.ok) {
          console.log(
            `[Demucs Test] GET ${healthUrl} -> HTTP ${healthRes.status} (${latencyMs} ms)`,
          );
        } else {
          console.warn(
            `[Demucs Test] GET ${healthUrl} -> HTTP ${healthRes.status} ${healthRes.statusText} (${latencyMs} ms) | body: ${body.slice(0, 200)}`,
          );
        }
        res.status(healthRes.ok ? 200 : 502).json({
          ok: healthRes.ok,
          baseUrl: requested,
          healthUrl,
          status: healthRes.status,
          latencyMs,
          body,
          error: healthRes.ok
            ? null
            : `GET /health returned HTTP ${healthRes.status} ${healthRes.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
        });
      } catch (err) {
        const cause = (err as Error & { cause?: unknown }).cause;
        const causeMsg = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        const message = timedOut
          ? `GET ${healthUrl} timed out after 20s.`
          : `GET ${healthUrl} failed: ${err instanceof Error ? err.message : String(err)}${causeMsg ? ` (cause: ${causeMsg})` : ''}`;
        console.warn(`[Demucs Test] ${message}`);
        res.status(502).json({
          ok: false,
          baseUrl: requested,
          healthUrl,
          status: null,
          latencyMs: Date.now() - startedAt,
          body: '',
          error: message,
        });
      }
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/demucs/test', demucsTestHandler);
  app.get('/api/demucs/test', demucsTestHandler);

  const voicesHandler = async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const langFilter = typeof req.query.lang === 'string' ? req.query.lang.trim() : '';

    let edgeVoices: VoicesCatalogResponse['edge']['voices'] = [];
    let edgeError: string | null = null;
    try {
      edgeVoices = await listEdgeVoicesFiltered(forceRefresh);
      if (langFilter) {
        if (langFilter === 'en' || langFilter === 'en-*') {
          edgeVoices = edgeVoices.filter((v) => v.locale.startsWith('en-'));
        } else {
          edgeVoices = edgeVoices.filter((v) => v.locale === langFilter || v.locale.startsWith(langFilter));
        }
      }
    } catch (err) {
      edgeError = err instanceof Error ? err.message : String(err);
    }

    const payload: VoicesCatalogResponse & { ok: boolean; error: string | null } = {
      ok: edgeError === null,
      error: edgeError,
      edge: {
        voices: edgeVoices,
        error: edgeError,
      },
      gemini: {
        voices: GEMINI_PREBUILT_VOICES,
      },
    };
    res.json(payload);
  };
  app.get('/api/voices', voicesHandler);
  app.get('/voices', voicesHandler);

  const PreviewVoiceBody = z.object({
    engine: TtsEngineTypeSchema,
    voice: z.string().min(1),
    lang: TargetLangSchema.default('en-US'),
    model: z.string().min(1).optional(),
  });

  app.post('/api/voices/preview', async (req: Request, res: Response) => {
    try {
      const body = PreviewVoiceBody.parse(req.body);
      const sampleText =
        body.lang === 'my-MM'
          ? 'မင်္ဂလာပါ၊ ဒီအသံကို စမ်းသပ်နေပါတယ်။'
          : 'Hello, this is a voice test.';

      const tts = getTtsEngine(body.engine);
      const result = await tts.synthesize({
        text: sampleText,
        voice: body.voice,
        model: body.engine === 'gemini' ? (body.model || getConfig().TTS_MODEL) : undefined,
        interactive: true,
      });

      res.json({
        ok: true,
        engine: body.engine,
        voice: body.voice,
        lang: body.lang,
        text: sampleText,
        bytes: result.audio.length,
        duration_s: result.durationSec,
        ms: result.ms,
        mimeType: result.mimeType,
        audioBase64: result.audio.toString('base64'),
      });
    } catch (err) {
      const exactMessage = err instanceof Error ? err.message : String(err);
      res.status(502).json({ ok: false, error: exactMessage });
    }
  });

  app.get('/api/tts/selftest', async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    const voice = 'en-US-AriaNeural';
    const text = 'Hello';
    console.log(`[TTS Self-Test] starting engine=edge voice=${voice} text=${JSON.stringify(text)}`);
    try {
      const tts = getTtsEngine('edge');
      const result = await tts.synthesize({ text, voice });
      const payload = {
        ok: true,
        backend: edgeTtsRuntime.backend,
        bytes: result.audio.length,
        ms: result.ms,
        error: null,
      };
      console.log(`[TTS Self-Test] result=${JSON.stringify(payload)}`);
      res.json(payload);
    } catch (err) {
      const exactMessage = err instanceof Error ? err.message : String(err);
      const payload = {
        ok: false,
        backend: edgeTtsRuntime.backend,
        bytes: 0,
        ms: Date.now() - startedAt,
        error: exactMessage,
      };
      console.error(`[TTS Self-Test] result=${JSON.stringify(payload)}`);
      res.json(payload);
    }
  });

  // 2. Projects CRUD
  app.get('/api/projects', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const projects = await listProjects();
      res.json({ projects });
    } catch (err) {
      next(err);
    }
  });

  const CreateProjectBody = z.object({
    title: z.string().min(1).max(120),
    mode: ProjectModeSchema.default('dubbing'),
    target_langs: z.array(TargetLangSchema).min(1).default(['my-MM']),
    useManualAiBridge: z.boolean().optional(),
  });

  app.post('/api/projects', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = CreateProjectBody.parse(req.body);
      let project = await createProject({
        title: body.title,
        mode: body.mode,
        target_langs: [resolveSingleTargetLang(body.target_langs)],
      });
      if (body.useManualAiBridge) {
        project = await updateProject(project.id, (cur) => ({
          ...cur,
          useManualAiBridge: true,
        }));
      }
      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await getProject(String(req.params.id));
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      res.json({ project, analyzing: activeJobs.has(project.id) });
    } catch (err) {
      next(err);
    }
  });

  const PatchProjectBody = z.object({
    title: z.string().min(1).max(120).optional(),
    mode: ProjectModeSchema.optional(),
    target_langs: z.array(TargetLangSchema).min(1).optional(),
    recap_mute_original: z.boolean().optional(),
    backgroundAudioMode: BackgroundAudioModeSchema.optional(),
    useManualAiBridge: z.boolean().optional(),
  });

  app.patch('/api/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const body = PatchProjectBody.parse(req.body);
      const updated = await updateProject(projectId, (cur) => ({
        ...cur,
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.target_langs ? { target_langs: [resolveSingleTargetLang(body.target_langs)] } : {}),
        ...(body.recap_mute_original !== undefined
          ? { recap_mute_original: body.recap_mute_original }
          : {}),
        ...(body.backgroundAudioMode !== undefined
          ? {
              background_audio_mode: body.backgroundAudioMode,
              recap_mute_original: body.backgroundAudioMode === 'mute_original',
            }
          : {}),
        ...(body.useManualAiBridge !== undefined
          ? { useManualAiBridge: body.useManualAiBridge }
          : {}),
      }));

      if (body.mode === 'recap' && updated.upload.completed && !updated.video.proxy_480p_file) {
        const withProxy = await runS0Ingest(projectId, false);
        emitProjectEvent(projectId, { type: 'project', project: withProxy });
        res.json({ project: withProxy });
        return;
      }
      emitProjectEvent(projectId, { type: 'project', project: updated });
      res.json({ project: updated });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'Cannot delete project while analysis job is running.' });
        return;
      }
      await deleteProject(projectId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/projects/:id/cleanup-cache', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'Cannot clean work cache while a background job is running.' });
        return;
      }
      const result = await cleanupProjectWorkCache(projectId);
      const freedMb = Math.round((result.freedBytes / (1024 * 1024)) * 10) / 10;
      emitProjectEvent(projectId, {
        type: 'log',
        message: `Cleaned temporary work cache: freed ${freedMb} MB (${result.removedFiles} files).`,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // 2b. Persistence: Snapshot (for IndexedDB), Backup ZIP Export, and ZIP Restore
  app.get('/api/projects/:id/snapshot', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const snapshot = await readProjectSnapshot(projectId);
      if (!snapshot) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id/backup.zip', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const q = req.query.includeSource;
      let includeSource: boolean | undefined;
      if (q === '1' || q === 'true') includeSource = true;
      else if (q === '0' || q === 'false') includeSource = false;

      const { zipBuffer, filename } = await createProjectBackupZip({
        projectId,
        includeSource,
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(zipBuffer);
    } catch (err) {
      next(err);
    }
  });

  const rawRestoreParser = express.raw({
    type: ['application/zip', 'application/octet-stream'],
    limit: '1024mb',
  });

  app.post('/api/projects/restore', rawRestoreParser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const zipBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (zipBuffer.length === 0) {
        res.status(400).json({ error: 'Empty ZIP backup payload.' });
        return;
      }
      const overwriteExisting = req.query.overwrite === '1' || req.query.overwrite === 'true';
      const result = await restoreProjectFromZipBuffer({
        zipBuffer,
        overwriteExisting,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // 3. Resumable 8 MB Chunked Upload (S0)
  const uploadChunkHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bin = getBinaryStatus();
      if (!bin.ok) {
        res.status(503).json({ error: bin.error || 'ffmpeg/ffprobe unavailable on server.' });
        return;
      }

      const projectId = String(req.header('x-project-id') || '');
      const filename = String(req.header('x-filename') || 'source.mp4');
      const chunkIndex = Number(req.header('x-chunk-index'));
      const totalChunks = Number(req.header('x-total-chunks'));
      const totalSize = Number(req.header('x-total-size'));
      const chunkSize = Number(req.header('x-chunk-size') || getConfig().CHUNK_SIZE_BYTES);

      if (
        !projectId ||
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        !Number.isInteger(totalChunks) ||
        totalChunks <= 0 ||
        !Number.isFinite(totalSize) ||
        totalSize <= 0
      ) {
        res.status(400).json({ error: 'Invalid chunk upload headers.' });
        return;
      }

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buffer.length === 0) {
        res.status(400).json({ error: 'Empty chunk payload.' });
        return;
      }

      const result = await handleUploadChunk({
        projectId,
        filename,
        chunkIndex,
        totalChunks,
        totalSize,
        chunkSize,
        buffer,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/upload/chunk', rawChunkParser, uploadChunkHandler);
  app.post('/upload/chunk', rawChunkParser, uploadChunkHandler);

  // 4. Stage 1-2 Analyze Endpoint (S0 -> S3 -> S1 -> S2)
  const analyzeHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bin = getBinaryStatus();
      if (!bin.ok) {
        res.status(503).json({ error: bin.error || 'ffmpeg/ffprobe unavailable on server.' });
        return;
      }

      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.upload.completed) {
        res.status(400).json({ error: 'Video upload is not complete yet.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'Analysis is already running for this project.' });
        return;
      }

      const forceReset = Boolean(req.body?.forceReset ?? req.body?.force);
      const stageMode = parseAnalyzeStageMode(req.body?.stage ?? req.body?.mode);
      void runStage2AnalyzePipeline(projectId, forceReset, stageMode).catch((err) => {
        console.error(`[Stage 2 Analyze Error] ${projectId} (${stageMode}):`, err);
      });

      res
        .status(202)
        .json({ started: true, projectId, stageScope: 'stage2', stage: stageMode, forceReset });
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/projects/:id/analyze', analyzeHandler);
  app.post('/projects/:id/analyze', analyzeHandler);

  // 4b. Stage 2 Transcript Segment & Speaker Editing
  const PatchSegmentBody = z.object({
    start_ms: z.number().int().nonnegative().optional(),
    end_ms: z.number().int().nonnegative().optional(),
    speaker: z.string().min(1).max(32).optional(),
    src_lang: z.string().min(1).max(16).optional(),
    text: z.string().optional(),
  });

  const patchSegmentHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const sid = Number(req.params.sid);
      if (!Number.isInteger(sid) || sid <= 0) {
        res.status(400).json({ error: 'Invalid segment id.' });
        return;
      }
      const body = PatchSegmentBody.parse(req.body);
      let updatedSegment: Project['speech'][number] | null = null;

      const updated = await updateProject(projectId, (cur) => {
        const idx = cur.speech.findIndex((s) => s.id === sid);
        if (idx === -1) {
          throw new Error(`Segment ${sid} not found.`);
        }
        const prevSeg = cur.speech[idx];
        const nextSpeaker = body.speaker !== undefined ? body.speaker.trim() || prevSeg.speaker : prevSeg.speaker;
        const nextStart = body.start_ms !== undefined ? body.start_ms : prevSeg.start_ms;
        const nextEnd = Math.max(nextStart + 50, body.end_ms !== undefined ? body.end_ms : prevSeg.end_ms);
        const nextSeg = {
          ...prevSeg,
          start_ms: nextStart,
          end_ms: nextEnd,
          speaker: nextSpeaker,
          src_lang: body.src_lang !== undefined ? body.src_lang.trim() || prevSeg.src_lang : prevSeg.src_lang,
          text: body.text !== undefined ? body.text : prevSeg.text,
        };
        updatedSegment = nextSeg;

        const nextSpeech = [...cur.speech];
        nextSpeech[idx] = nextSeg;

        const nextSpeakers = { ...cur.speakers };
        if (!nextSpeakers[nextSpeaker]) {
          nextSpeakers[nextSpeaker] = {
            gender: 'unknown',
            gender_overridden: true,
          };
        }

        return {
          ...cur,
          speech: nextSpeech,
          speakers: nextSpeakers,
        };
      });

      res.json({ project: updated, segment: updatedSegment });
    } catch (err) {
      next(err);
    }
  };
  app.patch('/api/projects/:id/segments/:sid', patchSegmentHandler);
  app.patch('/projects/:id/segments/:sid', patchSegmentHandler);

  const PatchSpeakerBody = z.object({
    gender: GenderSchema,
  });

  const patchSpeakerHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const speakerId = String(req.params.speakerId).trim();
      if (!speakerId) {
        res.status(400).json({ error: 'Speaker id is required.' });
        return;
      }
      const body = PatchSpeakerBody.parse(req.body);
      const cfg = getConfig();
      const updated = await updateProject(projectId, (cur) => {
        const existingSpeaker = cur.speakers[speakerId];
        if (!existingSpeaker) {
          throw new Error(`Speaker "${speakerId}" not found.`);
        }
        const activeEngine = cfg.TTS_ENGINE;
        const primaryLang = cur.target_langs[0] ?? 'my-MM';
        const curVoiceGender = existingSpeaker.voice?.name
          ? getVoiceGender(existingSpeaker.voice.name, activeEngine)
          : null;
        const needsVoiceRemap =
          existingSpeaker.voice?.engine !== activeEngine ||
          !existingSpeaker.voice_overridden ||
          ((body.gender === 'male' || body.gender === 'female') && curVoiceGender !== body.gender);

        let nextVoice = existingSpeaker.voice;
        let nextVoiceOverridden = existingSpeaker.voice_overridden;

        if (needsVoiceRemap) {
          const tempSpeakers = {
            ...cur.speakers,
            [speakerId]: {
              ...existingSpeaker,
              gender: body.gender,
              gender_overridden: true,
              voice: undefined,
              voice_overridden: false,
            },
          };
          const cues = buildDubSourceCues(cur.speech);
          const resolved = resolveSpeakerVoicesForEngine({
            engine: activeEngine,
            speakers: tempSpeakers,
            cues,
            targetLang: primaryLang,
            voicePools: cfg.VOICE_POOLS,
          });
          if (resolved[speakerId]) {
            nextVoice = { engine: activeEngine, name: resolved[speakerId] };
            nextVoiceOverridden = false;
          }
        }

        const voiceChanged =
          Boolean(nextVoice?.name) &&
          (nextVoice?.name !== existingSpeaker.voice?.name ||
            nextVoice?.engine !== existingSpeaker.voice?.engine);

        return {
          ...cur,
          speakers: {
            ...cur.speakers,
            [speakerId]: {
              ...existingSpeaker,
              gender: body.gender,
              gender_overridden: true,
              ...(nextVoice ? { voice: nextVoice } : {}),
              voice_overridden: nextVoiceOverridden,
            },
          },
          dub:
            voiceChanged && nextVoice
              ? cur.dub.map((d) =>
                  d.speaker === speakerId
                    ? {
                        ...d,
                        voice_name: nextVoice!.name,
                        tts_engine: nextVoice!.engine,
                        tts_ms: 0,
                        tts_file: '',
                      }
                    : d,
                )
              : cur.dub,
        };
      });

      res.json({ project: updated, speaker: updated.speakers[speakerId] });
    } catch (err) {
      next(err);
    }
  };
  app.patch('/api/projects/:id/speakers/:speakerId', patchSpeakerHandler);
  app.patch('/projects/:id/speakers/:speakerId', patchSpeakerHandler);

  // 4c. Stage 3 Dubbing MVP Routes (Edge TTS or Gemini TTS)
  const PatchSpeakerVoiceBody = z.object({
    voiceName: z.string().min(1),
    engine: TtsEngineTypeSchema.optional(),
  });

  const patchSpeakerVoiceHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const speakerId = String(req.params.speakerId).trim();
      if (!speakerId) {
        res.status(400).json({ error: 'Speaker id is required.' });
        return;
      }
      const body = PatchSpeakerVoiceBody.parse(req.body);
      const engine = body.engine ?? getConfig().TTS_ENGINE;

      if (engine === 'gemini') {
        const geminiNames = new Set(GEMINI_PREBUILT_VOICES.map((v) => v.name));
        if (!geminiNames.has(body.voiceName)) {
          res.status(400).json({ error: `Unknown Gemini voice "${body.voiceName}".` });
          return;
        }
      }

      const updated = await updateProject(projectId, (cur) => {
        const existingSpeaker = cur.speakers[speakerId];
        if (!existingSpeaker) {
          throw new Error(`Speaker "${speakerId}" not found.`);
        }
        return {
          ...cur,
          speakers: {
            ...cur.speakers,
            [speakerId]: {
              ...existingSpeaker,
              voice: {
                engine,
                name: body.voiceName,
              },
              voice_overridden: true,
            },
          },
          dub: cur.dub.map((d) =>
            d.speaker === speakerId
              ? {
                  ...d,
                  voice_name: body.voiceName,
                  tts_engine: engine,
                  ...(d.voice_name !== body.voiceName || d.tts_engine !== engine
                    ? { tts_ms: 0, tts_file: '' }
                    : {}),
                }
              : d,
          ),
        };
      });

      res.json({ project: updated, speaker: updated.speakers[speakerId] });
    } catch (err) {
      next(err);
    }
  };
  app.patch('/api/projects/:id/speakers/:speakerId/voice', patchSpeakerVoiceHandler);
  app.patch('/projects/:id/speakers/:speakerId/voice', patchSpeakerVoiceHandler);

  const patchDubSelectionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const selection = DubSelectionSchema.parse(req.body);
      const updated = await updateProject(projectId, (cur) => ({
        ...cur,
        dub_selection: selection,
      }));
      res.json({ project: updated });
    } catch (err) {
      next(err);
    }
  };
  app.patch('/api/projects/:id/dub/selection', patchDubSelectionHandler);
  app.patch('/projects/:id/dub/selection', patchDubSelectionHandler);

  const DubActionBody = z.object({
    selection: DubSelectionSchema.optional(),
    force: z.boolean().optional(),
    translateFirst: z.boolean().optional(),
  });

  const dubTranslateHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const existing = await getProject(projectId);
      if (!existing) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const body = DubActionBody.parse(req.body ?? {});
      if (existing.useManualAiBridge) {
        const updated = await updateProject(projectId, (cur) => ({
          ...cur,
          ...(body.selection ? { dub_selection: body.selection } : {}),
        }));
        emitProjectEvent(projectId, { type: 'project', project: updated });
        res.json({ project: updated, manualBridgeBypassed: true });
        return;
      }
      activeJobs.add(projectId);
      try {
        const project = await prepareDubTranslate(projectId, {
          selection: body.selection,
          force: body.force,
        });
        res.json({ project });
      } finally {
        activeJobs.delete(projectId);
      }
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/projects/:id/dub/translate', dubTranslateHandler);
  app.post('/projects/:id/dub/translate', dubTranslateHandler);

  const dubRenderHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bin = getBinaryStatus();
      if (!bin.ok) {
        res.status(503).json({ error: bin.error || 'ffmpeg/ffprobe unavailable on server.' });
        return;
      }
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.upload.completed || project.stages.speech.status !== 'done') {
        res.status(400).json({ error: 'Stage 2 must complete before starting Stage 3 Dubbing.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }

      const body = DubActionBody.parse(req.body ?? {});
      activeJobs.add(projectId);
      const runner = project.useManualAiBridge
        ? runManualBridgeDubRenderPipeline(projectId, body)
        : runDubRenderPipeline(projectId, body);
      void runner
        .catch((err) => {
          console.error(`[Stage 3 Dub Render Error] ${projectId}:`, err);
        })
        .finally(() => {
          activeJobs.delete(projectId);
        });

      res.status(202).json({ started: true, projectId, stageScope: 'stage3' });
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/projects/:id/dub/render', dubRenderHandler);
  app.post('/projects/:id/dub/render', dubRenderHandler);

  const chunksRunHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bin = getBinaryStatus();
      if (!bin.ok) {
        res.status(503).json({ error: bin.error || 'ffmpeg/ffprobe unavailable on server.' });
        return;
      }
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.upload.completed || !project.video.filename) {
        res.status(400).json({ error: 'Video upload must finish before starting chunked processing.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const body = DubActionBody.parse(req.body ?? {});
      activeJobs.add(projectId);
      const runner = project.useManualAiBridge
        ? runManualBridgeDubRenderPipeline(projectId, {
            selection: { mode: 'all', count: 999999, start_idx: 1, end_idx: 999999 },
            force: body.force,
          })
        : runChunkedDubRenderPipeline(projectId, {
            force: body.force,
            translateFirst: body.translateFirst,
          });
      void runner
        .catch((err) => {
          console.error(`[Chunked Long-Video Error] ${projectId}:`, err);
        })
        .finally(() => {
          activeJobs.delete(projectId);
        });

      res.status(202).json({ started: true, projectId, stageScope: 'chunks' });
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/projects/:id/chunks/run', chunksRunHandler);
  app.post('/projects/:id/chunks/run', chunksRunHandler);

  // 4c-ii. No-API-Key Manual AI Chat Bridge (Smart Batch Prompts + Direct JSON Import)
  app.get('/api/projects/:id/manual-ai-prompts', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await getProject(String(req.params.id));
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const rawMode = typeof req.query.mode === 'string' ? req.query.mode.trim() : '';
      const mode: ManualAiBridgeMode =
        rawMode === 'recap' ? 'recap' : rawMode === 'dubbing' ? 'dubbing' : project.mode;

      const rawSourceMode = typeof req.query.sourceMode === 'string' ? req.query.sourceMode.trim() : '';
      const parsedSourceMode = RecapSourceModeSchema.safeParse(rawSourceMode);
      const requestedSourceMode = parsedSourceMode.success ? parsedSourceMode.data : undefined;

      const rawLang = typeof req.query.lang === 'string' ? req.query.lang.trim() : '';
      const parsedLang = TargetLangSchema.safeParse(rawLang);
      const targetLang: TargetLang = resolveSingleTargetLang(
        parsedLang.success ? [parsedLang.data] : project.target_langs,
      );
      const scopeAll = req.query.scope === 'all' || req.query.scope === '1' || req.query.scope === 'true';

      let resolvedSourceMode: RecapSourceMode | undefined;
      let totalAvailableCues = 0;
      let batches: ManualAiBatch[] = [];

      if (mode === 'recap') {
        const recapSrc = buildManualAiRecapSourceCues({
          project,
          sourceMode: requestedSourceMode,
        });
        resolvedSourceMode = recapSrc.sourceMode;
        totalAvailableCues = recapSrc.cues.length;
        const grouped = splitManualAiCuesIntoBatches(recapSrc.cues);
        const totalParts = grouped.length;
        batches = grouped.map((slice, idx) => {
          const compactCues = slice.map((c) => ({
            id: c.id,
            speaker: c.speaker,
            text: c.text,
          }));
          return {
            partIndex: idx + 1,
            totalParts,
            startId: slice[0]?.id ?? 1,
            endId: slice[slice.length - 1]?.id ?? slice.length,
            cueCount: slice.length,
            sourceCues: compactCues,
            expectedIds: slice.map((c) => c.id),
            promptText: buildManualAiRecapPrompt({
              projectTitle: project.title,
              sourceMode: recapSrc.sourceMode,
              targetLang,
              partIndex: idx + 1,
              totalParts,
              cues: compactCues,
              totalCues: recapSrc.cues.length,
              videoDurationMs: project.video.duration_ms || 0,
            }),
          };
        });
      } else {
        const allCues = buildDubSourceCues(project.speech);
        totalAvailableCues = allCues.length;
        const activeCues = scopeAll
          ? allCues
          : selectDubCues(
              allCues,
              project.dub_selection,
              project.video.duration_ms || 0,
              'dubbing',
            ).selected;
        const grouped = splitManualAiCuesIntoBatches(activeCues);
        const totalParts = grouped.length;
        const cfg = getConfig();
        batches = grouped.map((slice, idx) => {
          const compactCues = slice.map((c) => ({
            id: c.id,
            speaker: c.speaker,
            text: c.text,
          }));
          return {
            partIndex: idx + 1,
            totalParts,
            startId: slice[0]?.id ?? 1,
            endId: slice[slice.length - 1]?.id ?? slice.length,
            cueCount: slice.length,
            sourceCues: compactCues,
            expectedIds: slice.map((c) => c.id),
            promptText: buildManualAiDubPrompt({
              projectTitle: project.title,
              targetLang,
              speechStyle: cfg.SPEECH_STYLE,
              partIndex: idx + 1,
              totalParts,
              sourceCues: compactCues,
              totalCues: activeCues.length,
            }),
          };
        });
      }

      const payload: ManualAiPromptsResponse = {
        projectId: project.id,
        mode,
        ...(resolvedSourceMode ? { sourceMode: resolvedSourceMode } : {}),
        targetLang,
        totalCues: batches.reduce((sum, b) => sum + b.cueCount, 0),
        totalAvailableCues,
        threshold: MANUAL_AI_SINGLE_BATCH_MAX,
        batchSize: MANUAL_AI_BATCH_SIZE,
        reminder: MANUAL_AI_BATCH_REMINDER,
        batches,
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  const ManualAiImportItemSchema = z.object({
    id: z.number().int().positive(),
    text: z.string().optional(),
    translation: z.string().optional(),
    narration: z.string().optional(),
  });

  const ManualAiImportBody = z.object({
    mode: ProjectModeSchema.optional(),
    sourceMode: RecapSourceModeSchema.optional(),
    lang: TargetLangSchema.optional(),
    narratorVoice: z.string().min(1).optional(),
    rawJson: z.string().optional(),
    items: z.array(ManualAiImportItemSchema).optional(),
    expectedIds: z.array(z.number().int().positive()).optional(),
  });

  app.post('/api/projects/:id/manual-ai-import', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const existing = await getProject(projectId);
      if (!existing) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const body = ManualAiImportBody.parse(req.body ?? {});
      const effectiveMode: ManualAiBridgeMode = body.mode ?? existing.mode;
      const targetLang = resolveSingleTargetLang(body.lang ? [body.lang] : existing.target_langs);
      const expectedIds = body.expectedIds ?? [];

      let normalizedItems: Array<{ id: number; text: string }> = [];
      if (typeof body.rawJson === 'string' && body.rawJson.trim().length > 0) {
        const parsedReply = parseManualAiJsonReply(body.rawJson, expectedIds);
        if (!parsedReply.ok) {
          res.status(400).json({ error: parsedReply.error || 'Invalid pasted AI JSON reply.' });
          return;
        }
        normalizedItems = parsedReply.items;
      } else if (Array.isArray(body.items) && body.items.length > 0) {
        const byId = new Map<number, string>();
        for (const item of body.items) {
          const text = (item.text ?? item.translation ?? item.narration ?? '').trim();
          if (text) byId.set(item.id, text);
        }
        if (expectedIds.length > 0) {
          const missing = expectedIds.filter((id) => !byId.has(id));
          if (missing.length > 0) {
            res.status(400).json({
              error: `Missing ${missing.length} expected cue ID(s): ${missing.slice(0, 8).join(', ')}`,
            });
            return;
          }
          normalizedItems = expectedIds.map((id) => ({ id, text: byId.get(id)! }));
        } else {
          normalizedItems = Array.from(byId.entries()).map(([id, text]) => ({ id, text }));
        }
      } else {
        res.status(400).json({ error: 'Provide either "rawJson" or non-empty "items" array to import.' });
        return;
      }

      if (normalizedItems.length === 0) {
        res.status(400).json({ error: 'No valid {"id", "text"} entries found to import.' });
        return;
      }

      // Strict count lock: never silently shift timestamps when the pasted JSON length differs.
      if (expectedIds.length > 0 && normalizedItems.length !== expectedIds.length) {
        res.status(400).json({
          error: `Segment count mismatch: pasted JSON has ${normalizedItems.length} item(s) but this batch expects ${expectedIds.length}. Output the exact same number of JSON objects in the exact same order.`,
          pastedCount: normalizedItems.length,
          expectedCount: expectedIds.length,
        });
        return;
      }

      // Force index-based pairing so external AI ordering can never shift text onto another segment.
      const sourceExpectedIds = expectedIds.length > 0 ? expectedIds : [];
      const alignedItems: Array<{ id: number; text: string }> =
        sourceExpectedIds.length > 0
          ? sourceExpectedIds.map((id, idx) => ({ id, text: normalizedItems[idx]?.text ?? '' }))
          : normalizedItems;

      const cfg = getConfig();
      const engine = cfg.TTS_ENGINE;
      let totalExpectedCount = 0;
      let missingIds: number[] = [];

      const updated = await updateProject(projectId, (cur) => {
        if (effectiveMode === 'recap') {
          const recapSrc = buildManualAiRecapSourceCues({
            project: cur,
            sourceMode: body.sourceMode ?? cur.recap_source_mode,
          });
          const metaById = new Map(recapSrc.beatMeta.map((m) => [m.id, m]));
          const narratorVoice = resolveDefaultNarratorVoice({
            project: cur,
            lang: targetLang,
            engine,
            requestedVoice: body.narratorVoice,
          });

          const existingByKey = new Map<string, RecapBeat>();
          for (const b of cur.recap) {
            existingByKey.set(`${b.lang}:${b.id}`, b);
          }

          let matchedInSource = 0;
          for (const item of alignedItems) {
            const meta = metaById.get(item.id);
            if (!meta) continue;
            matchedInSource += 1;
            const prev = existingByKey.get(`${targetLang}:${item.id}`);
            const textChanged = !prev || prev.narration_text.trim() !== item.text;
            const check = validateRecapTranslation(item.text, meta.slot_ms, targetLang);
            const nextBeat: RecapBeat = {
              id: meta.id,
              lang: targetLang,
              start_ms: meta.start_ms,
              end_ms: meta.end_ms,
              src_text: meta.src_text,
              scene_note: meta.scene_note,
              narration_text: item.text,
              slot_ms: meta.slot_ms,
              max_syllables: meta.max_syllables,
              syllables: countSyllables(item.text, targetLang),
              tts_ms: textChanged ? 0 : (prev?.tts_ms ?? 0),
              tts_file: textChanged ? '' : (prev?.tts_file ?? ''),
              rate: prev?.rate ?? 1.18,
              video_rate: prev?.video_rate ?? 1.0,
              effective_start_ms: textChanged ? undefined : prev?.effective_start_ms,
              effective_end_ms: textChanged ? undefined : prev?.effective_end_ms,
              status: check.valid ? 'ok' : 'needs_review',
              review_reason: check.valid ? undefined : check.reason,
              emotion: prev?.emotion ?? 'neutral',
              voice_name: prev?.voice_name || narratorVoice,
              tts_engine: engine,
              model_used: 'manual-ai-bridge',
            };
            existingByKey.set(`${targetLang}:${item.id}`, nextBeat);
          }

          if (matchedInSource === 0) {
            throw new Error(
              `None of the pasted cue IDs matched the ${recapSrc.beatMeta.length} recap beat(s) for this project.`,
            );
          }

          totalExpectedCount = recapSrc.beatMeta.length;
          missingIds = recapSrc.beatMeta
            .filter((m) => !existingByKey.has(`${targetLang}:${m.id}`))
            .map((m) => m.id);

          const mergedRecap = Array.from(existingByKey.values()).sort(
            (a, b) => a.lang.localeCompare(b.lang) || a.start_ms - b.start_ms || a.id - b.id,
          );

          return {
            ...cur,
            useManualAiBridge: true,
            recap_source_mode: recapSrc.sourceMode,
            recap_narrator_voice: narratorVoice,
            recap_script_status: 'generated',
            recap: mergedRecap,
            stages: {
              ...cur.stages,
              dub: {
                ...cur.stages.dub,
                model_used: 'manual-ai-bridge',
                message:
                  missingIds.length === 0
                    ? `Imported ${mergedRecap.filter((b) => b.lang === targetLang).length}/${totalExpectedCount} recap beats via Manual AI Bridge. Ready to render Edge-TTS!`
                    : `Imported ${alignedItems.length} recap beats (${missingIds.length} remaining).`,
                updated_at: new Date().toISOString(),
              },
            },
          };
        }

        // Dubbing Mode incremental batch merge + strict speaker gender voice preservation
        const allCues = buildDubSourceCues(cur.speech);
        const cueById = new Map(allCues.map((c) => [c.id, c]));
        const voiceMap = resolveSpeakerVoicesForEngine({
          engine,
          speakers: cur.speakers,
          cues: allCues,
          targetLang,
          voicePools: cfg.VOICE_POOLS,
        });

        const updatedSpeakers = { ...cur.speakers };
        for (const [spk, vName] of Object.entries(voiceMap)) {
          const info = updatedSpeakers[spk];
          if (!info) continue;
          const strictVoice = resolveStrictVoiceForSpeaker({
            engine,
            targetLang,
            speakerGender: info.gender,
            voiceOverridden: info.voice_overridden,
            speakerVoice: info.voice,
            candidateVoice: vName,
            voicePools: cfg.VOICE_POOLS,
          });
          if (!info.voice || info.voice.engine !== engine || info.voice.name !== strictVoice) {
            updatedSpeakers[spk] = {
              ...info,
              voice: { engine, name: strictVoice },
            };
          }
        }

        const existingByKey = new Map<string, DubSegment>();
        for (const d of cur.dub) {
          existingByKey.set(`${d.lang}:${d.id}`, d);
        }

        let matchedInSource = 0;
        for (const item of alignedItems) {
          const cue = cueById.get(item.id);
          if (!cue) continue;
          matchedInSource += 1;
          const prev = existingByKey.get(`${targetLang}:${item.id}`);
          const textChanged = !prev || prev.tgt_text.trim() !== item.text;
          const spkInfo = updatedSpeakers[cue.speaker];
          const strictVoice = resolveStrictVoiceForSpeaker({
            engine,
            targetLang,
            speakerGender: (spkInfo?.gender ?? 'unknown') as Gender,
            voiceOverridden: spkInfo?.voice_overridden,
            speakerVoice: spkInfo?.voice,
            candidateVoice: prev?.tts_engine === engine ? prev.voice_name : voiceMap[cue.speaker],
            voicePools: cfg.VOICE_POOLS,
          });
          const compCheck = validateTranslationCompleteness(cue.text, item.text, targetLang);
          const nextSeg: DubSegment = {
            id: cue.id,
            lang: targetLang,
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            speaker: cue.speaker,
            src_lang: cue.src_lang,
            src_text: cue.text,
            tgt_text: item.text,
            slot_ms: Math.max(200, cue.end_ms - cue.start_ms),
            tts_ms: textChanged ? 0 : (prev?.tts_ms ?? 0),
            tts_file: textChanged ? '' : (prev?.tts_file ?? ''),
            rate: prev?.rate ?? 1,
            video_rate: prev?.video_rate ?? 1,
            borrowed_end_ms: textChanged ? undefined : prev?.borrowed_end_ms,
            effective_start_ms: textChanged ? undefined : prev?.effective_start_ms,
            effective_end_ms: textChanged ? undefined : prev?.effective_end_ms,
            status: compCheck.valid ? 'ok' : 'needs_review',
            review_reason: compCheck.valid ? undefined : compCheck.reason,
            merged_ids: cue.merged_ids,
            voice_name: strictVoice,
            model_used: 'manual-ai-bridge',
            tts_model_used: textChanged ? undefined : prev?.tts_model_used,
            tts_engine: engine,
            syllables: countSyllables(item.text, targetLang),
          };
          existingByKey.set(`${targetLang}:${item.id}`, nextSeg);
        }

        if (matchedInSource === 0) {
          throw new Error(
            `None of the pasted cue IDs matched the ${allCues.length} speech cue(s) in this project.`,
          );
        }

        const selectedScope = selectDubCues(
          allCues,
          cur.dub_selection,
          cur.video.duration_ms || 0,
          'dubbing',
        ).selected;
        totalExpectedCount = selectedScope.length;
        missingIds = selectedScope
          .filter((c) => !existingByKey.has(`${targetLang}:${c.id}`))
          .map((c) => c.id);

        const mergedDub = Array.from(existingByKey.values()).sort(
          (a, b) => a.lang.localeCompare(b.lang) || a.id - b.id,
        );

        return {
          ...cur,
          useManualAiBridge: true,
          speakers: updatedSpeakers,
          dub: mergedDub,
          stages: {
            ...cur.stages,
            dub: {
              ...cur.stages.dub,
              model_used: 'manual-ai-bridge',
              message:
                missingIds.length === 0
                  ? `Imported all ${selectedScope.length} translated cues via Manual AI Bridge. Ready to render Edge-TTS!`
                  : `Imported ${alignedItems.length} cue(s) (${missingIds.length} remaining in selection).`,
              updated_at: new Date().toISOString(),
            },
          },
        };
      });

      emitProjectEvent(projectId, {
        type: 'project',
        stage: 'dub',
        message: updated.stages.dub.message,
        project: updated,
      });

      res.json({
        project: updated,
        mode: effectiveMode,
        targetLang,
        importedCount: alignedItems.length,
        totalExpectedCount,
        missingIds,
      });
    } catch (err) {
      next(err);
    }
  });

  const PatchDubSegmentBody = z.object({
    lang: TargetLangSchema,
    tgt_text: z.string().min(1).optional(),
    voice_name: z.string().min(1).optional(),
  });

  const patchDubSegmentHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const sid = Number(req.params.sid);
      if (!Number.isInteger(sid) || sid <= 0) {
        res.status(400).json({ error: 'Invalid dub segment id.' });
        return;
      }
      const body = PatchDubSegmentBody.parse(req.body);
      let updatedSeg: Project['dub'][number] | null = null;
      const updated = await updateProject(projectId, (cur) => {
        const idx = cur.dub.findIndex((d) => d.lang === body.lang && d.id === sid);
        if (idx === -1) {
          throw new Error(`Dub segment #${sid} (${body.lang}) not found.`);
        }
        const prev = cur.dub[idx];
        const nextSeg = {
          ...prev,
          ...(body.tgt_text !== undefined ? { tgt_text: body.tgt_text.trim() } : {}),
          ...(body.voice_name !== undefined ? { voice_name: body.voice_name.trim() } : {}),
        };
        updatedSeg = nextSeg;
        const nextDub = [...cur.dub];
        nextDub[idx] = nextSeg;
        return { ...cur, dub: nextDub };
      });
      res.json({ project: updated, segment: updatedSeg });
    } catch (err) {
      next(err);
    }
  };
  app.patch('/api/projects/:id/dub/segments/:sid', patchDubSegmentHandler);
  app.patch('/projects/:id/dub/segments/:sid', patchDubSegmentHandler);

  const regenDubSegmentHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const sid = Number(req.params.sid);
      if (!Number.isInteger(sid) || sid <= 0) {
        res.status(400).json({ error: 'Invalid dub segment id.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const body = PatchDubSegmentBody.parse(req.body);
      activeJobs.add(projectId);
      try {
        const result = await regenerateDubLineAndRemix({
          projectId,
          lang: body.lang,
          segId: sid,
          tgt_text: body.tgt_text,
          voice_name: body.voice_name,
        });
        res.json(result);
      } finally {
        activeJobs.delete(projectId);
      }
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/projects/:id/dub/segments/:sid/regenerate', regenDubSegmentHandler);
  app.post('/projects/:id/dub/segments/:sid/regenerate', regenDubSegmentHandler);

  const RetranslateCompleteBody = z.object({
    lang: TargetLangSchema,
  });

  const retranslateCompleteSegmentHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const projectId = String(req.params.id);
      const sid = Number(req.params.sid);
      if (!Number.isInteger(sid) || sid <= 0) {
        res.status(400).json({ error: 'Invalid dub segment id.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const body = RetranslateCompleteBody.parse(req.body ?? {});
      activeJobs.add(projectId);
      try {
        const result = await retranslateDubLineCompleteAndSave({
          projectId,
          lang: body.lang,
          segId: sid,
        });
        res.json(result);
      } finally {
        activeJobs.delete(projectId);
      }
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/projects/:id/dub/segments/:sid/retranslate-complete', retranslateCompleteSegmentHandler);
  app.post('/projects/:id/dub/segments/:sid/retranslate-complete', retranslateCompleteSegmentHandler);

  // 4d. Recap Script Studio Routes (strictly Recap Mode)
  app.get('/api/projects/:id/recap/detect', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await getProject(String(req.params.id));
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      res.json(detectRecapSourceMode(project));
    } catch (err) {
      next(err);
    }
  });

  const RecapGenerateBody = z.object({
    sourceMode: RecapSourceModeSchema.optional(),
    narratorVoice: z.string().min(1).optional(),
    force: z.boolean().optional(),
    visualAi: z.boolean().optional(),
  });

  app.post('/api/projects/:id/recap/generate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.upload.completed || project.stages.ingest.status !== 'done') {
        res.status(400).json({ error: 'Stage 1 & 2 analysis must finish before generating Recap script.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const body = RecapGenerateBody.parse(req.body ?? {});
      if (project.useManualAiBridge) {
        const updated = await updateProject(projectId, (cur) => ({
          ...cur,
          ...(body.sourceMode ? { recap_source_mode: body.sourceMode } : {}),
          ...(body.narratorVoice ? { recap_narrator_voice: body.narratorVoice } : {}),
        }));
        emitProjectEvent(projectId, { type: 'project', project: updated });
        res.json({ started: false, project: updated, manualBridgeBypassed: true });
        return;
      }
      activeJobs.add(projectId);
      void generateRecapScriptForProject({
        projectId,
        sourceMode: body.sourceMode,
        narratorVoice: body.narratorVoice,
        force: body.force,
        silentVisualMode: body.visualAi,
      })
        .catch((err) => {
          console.error(`[Recap Script Generate Error] ${projectId}:`, err);
        })
        .finally(() => {
          activeJobs.delete(projectId);
        });

      res.status(202).json({ started: true, projectId, stageScope: 'recap_generate' });
    } catch (err) {
      next(err);
    }
  });

  const RecapPatchBody = z.object({
    beats: z.array(RecapBeatSchema).optional(),
    sourceMode: RecapSourceModeSchema.optional(),
    narratorVoice: z.string().min(1).optional(),
    recapMuteOriginal: z.boolean().optional(),
  });

  app.patch('/api/projects/:id/recap', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const body = RecapPatchBody.parse(req.body ?? {});
      const updated = await saveRecapEdits({
        projectId,
        beats: body.beats,
        sourceMode: body.sourceMode,
        narratorVoice: body.narratorVoice,
        recapMuteOriginal: body.recapMuteOriginal,
      });
      res.json({ project: updated });
    } catch (err) {
      next(err);
    }
  });

  const RecapApproveRenderBody = z.object({
    beats: z.array(RecapBeatSchema).optional(),
    sourceMode: RecapSourceModeSchema.optional(),
    narratorVoice: z.string().min(1).optional(),
    recapMuteOriginal: z.boolean().optional(),
    force: z.boolean().optional(),
    visualConfig: ExportVisualConfigSchema.optional(),
  });

  app.post('/api/projects/:id/recap/approve-render', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bin = getBinaryStatus();
      if (!bin.ok) {
        res.status(503).json({ error: bin.error || 'ffmpeg/ffprobe unavailable on server.' });
        return;
      }
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const body = RecapApproveRenderBody.parse(req.body ?? {});
      activeJobs.add(projectId);
      void approveAndRenderRecapVideo({
        projectId,
        beats: body.beats,
        sourceMode: body.sourceMode,
        narratorVoice: body.narratorVoice,
        recapMuteOriginal: body.recapMuteOriginal,
        force: body.force,
        visualConfig: body.visualConfig,
      })
        .catch((err) => {
          console.error(`[Recap Approve & Render Error] ${projectId}:`, err);
        })
        .finally(() => {
          activeJobs.delete(projectId);
        });

      res.status(202).json({ started: true, projectId, stageScope: 'recap_render' });
    } catch (err) {
      next(err);
    }
  });

  // 4e. Final Visual Export & Logo Upload Routes (Step 5)
  const ExportLogoBody = z.object({
    dataUrl: z.string().min(1),
  });

  app.post('/api/projects/:id/export/logo', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const body = ExportLogoBody.parse(req.body ?? {});
      const filePath = await saveExportLogoPng({
        projectId,
        dataUrl: body.dataUrl,
      });
      res.json({ filePath });
    } catch (err) {
      next(err);
    }
  });

  const VisualExportBody = z.object({
    lang: TargetLangSchema.optional(),
    visualConfig: ExportVisualConfigSchema,
  });

  app.post('/api/projects/:id/export', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bin = getBinaryStatus();
      if (!bin.ok) {
        res.status(503).json({ error: bin.error || 'ffmpeg/ffprobe unavailable on server.' });
        return;
      }
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (activeJobs.has(projectId)) {
        res.status(409).json({ error: 'A job is already running for this project.' });
        return;
      }
      const body = VisualExportBody.parse(req.body ?? {});
      const resolvedLang = resolveSingleTargetLang(
        body.lang ? [body.lang] : project.target_langs,
      );
      const normalizedVisualConfig = {
        ...body.visualConfig,
        subtitle: {
          ...body.visualConfig.subtitle,
          mode: resolveSubtitleModeForLang(resolvedLang, body.visualConfig.subtitle.mode),
        },
      };
      activeJobs.add(projectId);
      void exportProjectWithVisualConfig({
        projectId,
        lang: resolvedLang,
        visualConfig: normalizedVisualConfig,
      })
        .catch((err) => {
          console.error(`[Visual Export Error] ${projectId}:`, err);
        })
        .finally(() => {
          activeJobs.delete(projectId);
        });

      res.status(202).json({ started: true, projectId, stageScope: 'export' });
    } catch (err) {
      next(err);
    }
  });

  const sseHandler = async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    subscribeProjectEvents(projectId, res);
    const current = await getProject(projectId);
    if (current) {
      emitProjectEvent(projectId, {
        type: 'project',
        project: current,
        message: activeJobs.has(projectId) ? 'Connected to running job.' : 'Connected.',
      });
    }
  };
  app.get('/api/events/:id', sseHandler);
  app.get('/events/:id', sseHandler);

  // 5. Media Streaming (Source Video, 480p Proxy, 16k/48k Extracted WAVs)
  app.get('/api/projects/:id/media/source', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await getProject(String(req.params.id));
      if (!project) {
        res.status(404).json({ error: 'Source video not found.' });
        return;
      }
      const paths = getProjectPaths(project.id);
      if (project.video.filename) {
        const filePath = path.join(paths.sourceDir, project.video.filename);
        if (await fileExists(filePath)) {
          res.sendFile(filePath);
          return;
        }
      }
      const proxyPath = path.join(paths.workDir, 'proxy_480p.mp4');
      if (await fileExists(proxyPath)) {
        res.sendFile(proxyPath);
        return;
      }
      res.status(404).json({ error: 'Source file missing on disk.' });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id/media/proxy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await getProject(String(req.params.id));
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const paths = getProjectPaths(project.id);
      const proxyPath = path.join(paths.workDir, 'proxy_480p.mp4');
      if (await fileExists(proxyPath)) {
        res.sendFile(proxyPath);
        return;
      }
      const sourcePath = path.join(paths.sourceDir, project.video.filename);
      if (await fileExists(sourcePath)) {
        res.sendFile(sourcePath);
        return;
      }
      res.status(404).json({ error: 'Video media not available.' });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id/media/audio16k', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paths = getProjectPaths(String(req.params.id));
      const filePath = path.join(paths.workDir, 'audio_16k.wav');
      if (!(await fileExists(filePath))) {
        res.status(404).json({ error: '16 kHz audio WAV not found.' });
        return;
      }
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id/media/audio48k', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paths = getProjectPaths(String(req.params.id));
      const filePath = path.join(paths.workDir, 'audio_48k.wav');
      if (!(await fileExists(filePath))) {
        res.status(404).json({ error: '48 kHz audio WAV not found.' });
        return;
      }
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id/media/sample/:speaker', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawSpeaker = String(req.params.speaker || '');
      const safeSpeaker = rawSpeaker.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!safeSpeaker) {
        res.status(400).json({ error: 'Invalid speaker id.' });
        return;
      }
      const paths = getProjectPaths(String(req.params.id));
      const filePath = path.join(paths.samplesDir, `${safeSpeaker}.wav`);
      if (!(await fileExists(filePath))) {
        res.status(404).json({ error: `Speaker sample not found for ${safeSpeaker}.` });
        return;
      }
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  });

  // 5b. Stage 3 Dubbing Media Streaming & Download (MP4, WAV, SRT, Dual MP4, Per-Clip WAV)
  app.get('/api/projects/:id/media/dub/:lang/:kind', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const langParam = String(req.params.lang);
      const kind = String(req.params.kind);
      const download = req.query.download === '1' || req.query.download === 'true';
      const paths = getProjectPaths(projectId);
      const project = await getProject(projectId);

      let targetPath = '';
      let downloadName = '';
      if (langParam === 'dual') {
        res.status(404).json({ error: 'Dual-language export is disabled; single-language export only.' });
        return;
      } else if ((langParam === 'my-MM' || langParam === 'en-US') && (kind === 'mp4' || kind === 'wav' || kind === 'srt')) {
        if (kind === 'srt' && project) {
          const activeLang = resolveSingleTargetLang(project.target_langs);
          if (langParam !== activeLang) {
            res.status(404).json({ error: `Single-language subtitles only: active language is ${activeLang}.` });
            return;
          }
        }
        const directOutPath = path.join(paths.outDir, `dub_${langParam}.${kind}`);
        const langReport = project?.dub_reports.find((r) => r.lang === langParam);
        const reportRel =
          kind === 'mp4' ? langReport?.mp4_file : kind === 'wav' ? langReport?.wav_file : langReport?.srt_file;
        const resolvedReportOut = reportRel ? path.resolve(paths.root, reportRel) : directOutPath;
        const reportCandidate = resolvedReportOut.startsWith(paths.root) ? resolvedReportOut : directOutPath;
        const baseCandidate = path.join(paths.dubDir, `base_${langParam}.mp4`);
        const workWavCandidate = path.join(paths.dubDir, `dub_${langParam}.wav`);

        // Always prefer out/dub_<lang>.<kind> whenever it exists on disk so stale work/dub/base_<lang>.mp4 test clips are never served
        if (await fileExists(directOutPath)) {
          targetPath = directOutPath;
        } else if (await fileExists(reportCandidate)) {
          targetPath = reportCandidate;
        } else if (kind === 'wav' && (await fileExists(workWavCandidate))) {
          targetPath = workWavCandidate;
        } else if (kind === 'mp4' && (await fileExists(baseCandidate))) {
          targetPath = baseCandidate;
        } else {
          targetPath = directOutPath;
        }
        downloadName = `${projectId}_dub_${langParam}.${kind}`;
      } else {
        res.status(400).json({ error: 'Invalid dub media parameters.' });
        return;
      }

      if (!(await fileExists(targetPath))) {
        res.status(404).json({ error: `Dub output file not found: ${path.basename(targetPath)}` });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      if (kind === 'srt' && (langParam === 'my-MM' || langParam === 'en-US')) {
        const rawSrt = await fs.readFile(targetPath, 'utf-8');
        const splitSrt = splitSrtDocument(rawSrt, { lang: langParam });
        if (download) {
          res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        }
        res.type('text/plain; charset=utf-8').send(splitSrt);
        return;
      }
      if (download) {
        res.download(targetPath, downloadName, {
          cacheControl: false,
          etag: false,
          lastModified: false,
        });
        return;
      }
      res.sendFile(targetPath, {
        cacheControl: false,
        etag: false,
        lastModified: false,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/projects/:id/media/dubclip/:filename', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = String(req.params.id);
      const rawName = path.basename(String(req.params.filename || ''));
      if (!/^(my-MM|en-US)_seg_\d+\.wav$/.test(rawName)) {
        res.status(400).json({ error: 'Invalid dub clip filename.' });
        return;
      }
      const paths = getProjectPaths(projectId);
      const clipPath = path.join(paths.dubDir, 'clips', rawName);
      if (!(await fileExists(clipPath))) {
        res.status(404).json({ error: 'Dub clip WAV not found.' });
        return;
      }
      res.sendFile(clipPath);
    } catch (err) {
      next(err);
    }
  });

  // Unmatched /api/* routes must return JSON 404 before Vite/SPA catch-all
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // JSON error handler for API routes
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(rawMessage);
    console.error(`[API Error] ${req.method} ${req.originalUrl}: ${message}`, err);
    const status = message.includes('not found') ? 404 : message.includes('Insufficient free disk') ? 507 : 400;
    res.status(status).json({ error: message });
  });

  const distDir = path.resolve(process.cwd(), 'dist');
  let distExists = false;
  try {
    await fs.access(path.join(distDir, 'index.html'));
    distExists = true;
  } catch {
    distExists = false;
  }
  const isProd = process.env.NODE_ENV === 'production' || (distExists && process.env.NODE_ENV !== 'development');
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', async (_req: Request, res: Response) => {
      const indexHtml = await fs.readFile(path.join(distDir, 'index.html'), 'utf-8');
      res.type('html').send(indexHtml);
    });
  }

  const port = Number(process.env.PORT || 3000);
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.log(`Recap & Dubbing Studio server listening on http://0.0.0.0:${port}`);
    if (startupError) {
      console.error(`[Server] Started with startup error: ${startupError}`);
    }
    void (async () => {
      try {
        const selfUrl = `http://127.0.0.1:${port}/api/health`;
        const selfRes = await fetch(selfUrl, { cache: 'no-store' });
        const selfText = await selfRes.text();
        console.log(`[Startup Self-Check] GET /api/health -> HTTP ${selfRes.status} ${selfText}`);
      } catch (err) {
        console.error('[Startup Self-Check] GET /api/health failed:', err);
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const parsed = new URL(req.url || '/', 'http://localhost');
      const match = /^\/ws\/events\/([^/]+)$/.exec(parsed.pathname);
      if (!match) return;
      const projectId = decodeURIComponent(match[1]);
      wss.handleUpgrade(req, socket, head, (ws) => {
        subscribeProjectWebSocket(projectId, ws);
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'heartbeat',
              timestamp: new Date().toISOString(),
            }),
          );
        }
      });
    } catch {
      socket.destroy();
    }
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup failure:', err);
});
