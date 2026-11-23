import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultVoiceForGender } from '../../shared/dubUtils.ts';
import type {
  BackgroundAudioMode,
  DubSegment,
  DubValidationReport,
  ExportVisualConfig,
  Project,
  RecapBeat,
  RecapScriptStatus,
  RecapSourceMode,
  TargetLang,
  TtsEngineType,
} from '../../shared/projectTypes.ts';
import { geminiRuntime, getConfig, getGroqApiKey } from '../config.ts';
import {
  assembleDubCanvas48k,
  buildDuckedBed48k,
  computePiecewiseTimeline,
  concatenateChunkOutputs,
  mapSourceMsToOutputRelMs,
  mixAndMuxDubbedOutput,
  resolveBackgroundAudioMode,
  type TimelinePartition,
} from '../dub/audioDsp.ts';
import {
  exportProjectWithVisualConfig,
  resolveSingleTargetLang,
  resolveSubtitleModeForLang,
} from '../dub/srtBuilder.ts';
import { countSyllables } from '../dub/syllables.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { runTrackedStepJob } from '../gemini/resilientClient.ts';
import { fileExists } from '../media/ingest.ts';
import { hashString } from '../analyze/cache.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import { describeFriendlyApiError } from '../utils/retry.ts';

function isValidVoiceForEngine(voice: string, engine: TtsEngineType): boolean {
  const trimmed = voice.trim();
  if (!trimmed) return false;
  return engine === 'edge' ? trimmed.includes('-') : !trimmed.includes('-');
}
import {
  detectRecapSourceMode,
  generateExistingVoRecapBeats,
  generateRawMovieRecapBeats,
} from './recapScriptGenerator.ts';
import { generateSilentVideoRecap, shouldUseSilentVideoRecap } from './silentVideoRecap.ts';
import {
  RECAP_BASE_TTS_RATE,
  RECAP_MIN_TTS_VOLUME_PCT,
  RECAP_MIN_VIDEO_RATE,
  buildRecapSlowIntervals,
  runRecapFitLoopForSegment,
} from './recapSync.ts';
import {
  computeRecapMaxSyllables,
  validateRecapTranslation,
} from './recapTranslator.ts';

function getClipAbsolutePath(projectId: string, relPath: string): string {
  return path.join(getProjectPaths(projectId).root, relPath);
}

export function resolveDefaultNarratorVoice(params: {
  project: Project;
  lang: TargetLang;
  engine: TtsEngineType;
  requestedVoice?: string;
}): string {
  const { project, lang, engine, requestedVoice } = params;
  if (requestedVoice && isValidVoiceForEngine(requestedVoice, engine)) {
    if (lang === 'my-MM' || engine === 'gemini' || !requestedVoice.startsWith('my-MM-')) {
      return requestedVoice;
    }
  }
  if (
    project.recap_narrator_voice &&
    isValidVoiceForEngine(project.recap_narrator_voice, engine)
  ) {
    if (
      lang === 'my-MM' ||
      engine === 'gemini' ||
      !project.recap_narrator_voice.startsWith('my-MM-')
    ) {
      return project.recap_narrator_voice;
    }
  }
  if (engine === 'edge') {
    return lang === 'my-MM' ? 'my-MM-ThihaNeural' : 'en-US-AndrewMultilingualNeural';
  }
  return defaultVoiceForGender(engine, lang, 'male');
}

function recapBeatToDubSegment(beat: RecapBeat, fallbackVoice: string, engine: TtsEngineType): DubSegment {
  return {
    id: beat.id,
    lang: beat.lang,
    start_ms: beat.start_ms,
    end_ms: beat.end_ms,
    speaker: 'NARRATOR',
    src_lang: 'und',
    src_text: beat.src_text || beat.scene_note || '',
    tgt_text: beat.narration_text.trim(),
    slot_ms: Math.max(200, beat.end_ms - beat.start_ms),
    tts_ms: beat.tts_ms || 0,
    tts_file: beat.tts_file || '',
    rate: beat.rate >= 1.17 ? beat.rate : RECAP_BASE_TTS_RATE,
    video_rate: beat.video_rate || 1,
    effective_start_ms: beat.effective_start_ms,
    effective_end_ms: beat.effective_end_ms,
    status: beat.status ?? 'ok',
    review_reason: beat.review_reason,
    voice_name: beat.voice_name || fallbackVoice,
    model_used: beat.model_used,
    tts_model_used: beat.tts_model_used,
    tts_engine: beat.tts_engine ?? engine,
    syllables: beat.syllables,
    error: beat.error,
  };
}

function normalizeRecapBeatsForTimeline(
  beats: RecapBeat[],
  videoDurationMs: number,
  fallbackVoice: string,
  engine: TtsEngineType,
): RecapBeat[] {
  const byLang = new Map<TargetLang, RecapBeat[]>();
  for (const b of beats) {
    const arr = byLang.get(b.lang) ?? [];
    arr.push(b);
    byLang.set(b.lang, arr);
  }

  const out: RecapBeat[] = [];
  const maxDur = videoDurationMs > 0 ? videoDurationMs : Number.MAX_SAFE_INTEGER;

  for (const [lang, rawList] of byLang.entries()) {
    const sorted = [...rawList].sort((a, b) => a.start_ms - b.start_ms || a.id - b.id);
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      const startMs = Math.max(0, Math.min(maxDur - 200, Math.round(cur.start_ms)));
      let endMs = Math.max(startMs + 200, Math.min(maxDur, Math.round(cur.end_ms)));
      if (next) {
        const nextStart = Math.max(startMs + 200, Math.round(next.start_ms));
        if (endMs > nextStart) {
          endMs = nextStart;
        }
      }
      const slotMs = Math.max(200, endMs - startMs);
      const text = cur.narration_text.trim();
      const check = validateRecapTranslation(text, slotMs, lang);
      const voice = cur.voice_name && isValidVoiceForEngine(cur.voice_name, engine)
        ? cur.voice_name
        : fallbackVoice;

      out.push({
        ...cur,
        id: i + 1,
        lang,
        start_ms: startMs,
        end_ms: endMs,
        slot_ms: slotMs,
        max_syllables: computeRecapMaxSyllables(slotMs),
        syllables: countSyllables(text, lang),
        voice_name: voice,
        tts_engine: cur.tts_engine ?? engine,
        status: cur.status === 'overflow' ? 'overflow' : check.valid ? (cur.status || 'ok') : 'needs_review',
        review_reason: check.valid ? undefined : check.reason,
      });
    }
  }

  return out;
}

export async function generateRecapScriptForProject(params: {
  projectId: string;
  sourceMode?: RecapSourceMode;
  narratorVoice?: string;
  force?: boolean;
  silentVisualMode?: boolean;
}): Promise<Project> {
  const { projectId, force = false } = params;
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (!project.upload.completed || project.stages.ingest.status !== 'done') {
    throw new Error('Stage 1 & 2 analysis must finish before generating a Recap script.');
  }
  if (!geminiRuntime.configured || !geminiRuntime.keyValid) {
    throw new Error(
      geminiRuntime.keyError ||
        'GEMINI_API_KEY is missing or invalid. Set GEMINI_API_KEY in .env.local or your environment.',
    );
  }

  const cfg = getConfig();
  const engine = cfg.TTS_ENGINE;
  const detected = detectRecapSourceMode(project);
  const chosenMode: RecapSourceMode = params.sourceMode ?? detected.mode;
  const primaryLang = resolveSingleTargetLang(project.target_langs);
  const primaryVoice = resolveDefaultNarratorVoice({
    project,
    lang: primaryLang,
    engine,
    requestedVoice: params.narratorVoice,
  });

  // Visual AI (silent video) trigger: manual force or automatic sparse-speech fallback.
  const silentCheck = shouldUseSilentVideoRecap(project);
  // Only switch to the visual pipeline when Groq Vision is actually available;
  // otherwise keep the existing Gemini-based flow so generation never hard-fails.
  const useSilentVisual =
    (params.silentVisualMode === true || silentCheck.should) &&
    Boolean(getGroqApiKey());

  const emitProgress = async (pct: number, message: string, error?: string) => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        dub: {
          ...cur.stages.dub,
          status: error ? 'error' : 'running',
          progress_pct: pct,
          message,
          error,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: error ? 'error' : 'stage',
      stage: 'dub',
      progress_pct: pct,
      message,
      project: updated,
    });
  };

  return runTrackedStepJob({
    projectId,
    kind: 'recap_script',
    label: `Generate Recap Script (${chosenMode})`,
    hash: hashString(`recap-script|${projectId}|${chosenMode}|${primaryVoice}|${Date.now()}`),
    force: true,
    skipResult: () => project,
    run: async () => {
    try {
      await emitProgress(
        5,
        useSilentVisual
          ? 'Visual AI: Extracting scene keyframes for a no-voiceover Pro Recap script...'
          : chosenMode === 'raw_movie'
            ? 'Option A: Preparing video frames & writing original Burmese recap script...'
            : 'Option B: Preparing existing voiceover beats for punchy Burmese recap...',
      );

      if (useSilentVisual) {
        const reason = params.silentVisualMode
          ? 'Manual Visual AI (No Voiceover) trigger.'
          : silentCheck.reason;
        console.log(`[Recap Script] Using Visual AI silent-video pipeline — ${reason}`);
      }

      const allBeats: RecapBeat[] = [];
      const modelsUsed = new Set<string>();
      const targetLangs: TargetLang[] = [primaryLang];

      for (const lang of targetLangs) {
        const langVoice = resolveDefaultNarratorVoice({
          project,
          lang,
          engine,
          requestedVoice: primaryVoice,
        });

        const res = useSilentVisual
          ? await generateSilentVideoRecap({
              project,
              targetLang: lang,
              narratorVoice: langVoice,
              force,
              onProgress: async (pct, msg) => {
                await emitProgress(pct, `[${lang}] ${msg}`);
              },
            })
          : chosenMode === 'raw_movie'
            ? await generateRawMovieRecapBeats({
                project,
                targetLang: lang,
                narratorVoice: langVoice,
                force,
                onProgress: async (pct, msg) => {
                  await emitProgress(pct, `[${lang}] ${msg}`);
                },
              })
            : await generateExistingVoRecapBeats({
                project,
                targetLang: lang,
                narratorVoice: langVoice,
                force,
                onProgress: async (pct, msg) => {
                  await emitProgress(pct, `[${lang}] ${msg}`);
                },
              });

        allBeats.push(...res.beats);
        for (const m of res.modelsUsed) modelsUsed.add(m);
      }

      const normalized = normalizeRecapBeatsForTimeline(
        allBeats,
        project.video.duration_ms || 0,
        primaryVoice,
        engine,
      );

      const hasExistingRender = project.dub_reports.length > 0;
      const doneMsg = useSilentVisual
        ? `Visual AI Pro Recap script ready (${normalized.length} beats). Review & click Approve & Render Recap Video.`
        : `Recap script ready (${normalized.length} beats, mode: ${chosenMode}). Review & click Approve & Render Recap Video.`;
      const saved = await updateProject(projectId, (cur) => ({
        ...cur,
        recap_source_mode: chosenMode,
        recap_narrator_voice: primaryVoice,
        recap_script_status: 'generated' as RecapScriptStatus,
        recap: normalized,
        stages: {
          ...cur.stages,
          dub: {
            ...cur.stages.dub,
            status: hasExistingRender ? 'done' : 'pending',
            progress_pct: hasExistingRender ? 100 : 0,
            message: doneMsg,
            error: undefined,
            model_used: Array.from(modelsUsed).join(', ') || cfg.TEXT_MODEL,
            updated_at: new Date().toISOString(),
          },
        },
      }));

      emitProjectEvent(projectId, {
        type: 'project',
        stage: 'dub',
        progress_pct: hasExistingRender ? 100 : 0,
        message: doneMsg,
        project: saved,
      });

      return saved;
    } catch (err) {
      const msg = describeFriendlyApiError(err);
      await emitProgress(0, msg, msg);
      throw err;
    }
    },
  });
}

export async function saveRecapEdits(params: {
  projectId: string;
  beats?: RecapBeat[];
  sourceMode?: RecapSourceMode;
  narratorVoice?: string;
  recapMuteOriginal?: boolean;
  backgroundAudioMode?: BackgroundAudioMode;
}): Promise<Project> {
  const { projectId, beats, sourceMode, narratorVoice, recapMuteOriginal, backgroundAudioMode } = params;
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);

  const cfg = getConfig();
  const engine = cfg.TTS_ENGINE;
  const primaryLang = project.target_langs[0] ?? 'my-MM';
  const nextVoice = resolveDefaultNarratorVoice({
    project,
    lang: primaryLang,
    engine,
    requestedVoice: narratorVoice,
  });

  // Mirror the legacy recap mute toggle and the new backgroundAudioMode so both stay coherent
  // (mute_original -> recap_mute_original true, keep_bgm_demucs -> false).
  const effectiveBgMode: BackgroundAudioMode | undefined =
    backgroundAudioMode ??
    (recapMuteOriginal !== undefined
      ? recapMuteOriginal
        ? 'mute_original'
        : 'keep_bgm_demucs'
      : undefined);

  const updated = await updateProject(projectId, (cur) => {
    const prevByKey = new Map<string, RecapBeat>();
    for (const b of cur.recap) {
      prevByKey.set(`${b.lang}:${b.id}`, b);
    }

    const incoming = beats ?? cur.recap;
    const syncedBeats = incoming.map((b) => {
      const prev = prevByKey.get(`${b.lang}:${b.id}`);
      const targetVoice =
        narratorVoice && b.lang === primaryLang ? nextVoice : b.voice_name || nextVoice;
      const textChanged = !prev || prev.narration_text.trim() !== b.narration_text.trim();
      const voiceChanged = !prev || prev.voice_name !== targetVoice || (prev.tts_engine && prev.tts_engine !== engine);

      return {
        ...b,
        voice_name: targetVoice,
        tts_engine: engine,
        ...(textChanged || voiceChanged
          ? {
              tts_ms: 0,
              tts_file: '',
              effective_start_ms: undefined,
              effective_end_ms: undefined,
            }
          : {}),
      };
    });

    const normalized = normalizeRecapBeatsForTimeline(
      syncedBeats,
      cur.video.duration_ms || 0,
      nextVoice,
      engine,
    );

    return {
      ...cur,
      ...(sourceMode ? { recap_source_mode: sourceMode } : {}),
      recap_narrator_voice: nextVoice,
      ...(effectiveBgMode
        ? {
            background_audio_mode: effectiveBgMode,
            recap_mute_original: effectiveBgMode === 'mute_original',
          }
        : {}),
      recap: normalized,
      ...(cur.recap_script_status === 'idle' && normalized.length > 0
        ? { recap_script_status: 'generated' as RecapScriptStatus }
        : {}),
    };
  });

  emitProjectEvent(projectId, {
    type: 'project',
    project: updated,
    message: 'Recap script edits saved.',
  });
  return updated;
}

/**
 * Renders an approved Recap timeline for one language, splitting FFmpeg piecewise filter_complex
 * cleanly into safe groups if partitions > 36 so long multi-beat videos never hit FFmpeg filter limits.
 */
async function renderRecapLanguageTrack(params: {
  project: Project;
  lang: TargetLang;
  fittedSegments: DubSegment[];
  sourceVideoPath: string;
  audio48kPath: string;
  ttsVolumePct: number;
  recapMuteOriginal: boolean;
  backgroundAudioMode: BackgroundAudioMode;
}): Promise<{ report: DubValidationReport; placedSegments: DubSegment[] }> {
  const {
    project,
    lang,
    fittedSegments,
    sourceVideoPath,
    audio48kPath,
    ttsVolumePct,
    recapMuteOriginal,
    backgroundAudioMode,
  } = params;

  const paths = getProjectPaths(project.id);
  const videoDurationMs = Math.max(500, project.video.duration_ms || 0);
  const orderedSegs = [...fittedSegments].sort((a, b) => a.start_ms - b.start_ms);
  const slowIntervals = buildRecapSlowIntervals(orderedSegs);
  const fullPartitions = computePiecewiseTimeline(
    0,
    videoDurationMs,
    slowIntervals,
    RECAP_MIN_VIDEO_RATE,
  );
  const totalOutDurMs =
    fullPartitions.length > 0
      ? fullPartitions[fullPartitions.length - 1].outEndMs
      : videoDurationMs;

  const speechWindows = [
    ...project.speech.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms })),
    ...orderedSegs.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms })),
  ];

  // Compute chronological output timestamps on the full timeline
  const placedSegments: DubSegment[] = [];
  const placedClips: Array<{ wavPath: string; startMs: number; durationMs: number; seg: DubSegment }> = [];
  let prevOutEndMs = 0;

  for (const seg of orderedSegs) {
    const mappedStart = mapSourceMsToOutputRelMs(seg.start_ms, fullPartitions);
    const effStart = Math.max(mappedStart, prevOutEndMs);
    const effEnd = effStart + Math.max(0, seg.tts_ms);

    const nextSeg: DubSegment = {
      ...seg,
      effective_start_ms: effStart,
      effective_end_ms: effEnd,
    };
    placedSegments.push(nextSeg);

    if (nextSeg.tts_file) {
      const abs = getClipAbsolutePath(project.id, nextSeg.tts_file);
      if (await fileExists(abs)) {
        placedClips.push({
          wavPath: abs,
          startMs: effStart,
          durationMs: nextSeg.tts_ms,
          seg: nextSeg,
        });
        prevOutEndMs = effStart + Math.max(0, nextSeg.tts_ms);
      } else {
        prevOutEndMs = effEnd;
      }
    } else {
      prevOutEndMs = effEnd;
    }
  }

  // Fast single-pass path when FFmpeg piecewise partition count <= 36
  if (fullPartitions.length <= 36) {
    const bedPath = path.join(paths.dubDir, `bed_recap_${lang}.wav`);
    await buildDuckedBed48k({
      hasAudio: project.video.has_audio,
      audio48kPath,
      rangeStartMs: 0,
      rangeEndMs: videoDurationMs,
      speechWindows,
      partitions: fullPartitions,
      outBedPath: bedPath,
      recapMode: true,
      recapMuteOriginal,
      backgroundAudioMode,
    });

    const canvasPath = path.join(paths.dubDir, `canvas_recap_${lang}.wav`);
    const { hasNonSilentDub } = await assembleDubCanvas48k({
      clips: placedClips.map((c) => ({ wavPath: c.wavPath, startMs: c.startMs, durationMs: c.durationMs })),
      rangeStartMs: 0,
      rangeEndMs: videoDurationMs,
      totalDurMs: totalOutDurMs,
      outCanvasPath: canvasPath,
    });

    const report = await mixAndMuxDubbedOutput({
      projectId: project.id,
      lang,
      sourceVideoPath,
      canvasPath,
      hasNonSilentDub,
      bedPath,
      rangeStartMs: 0,
      rangeEndMs: videoDurationMs,
      isFullVideo: true,
      partitions: fullPartitions,
      dubSegments: placedSegments,
      ttsVolumePct,
    });

    return { report, placedSegments };
  }

  // Scalable partitioned path for long videos (>36 piecewise intervals) -> render groups & stitch cleanly
  const partRoot = path.join(paths.workDir, 'recap', 'render_parts', lang);
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
      .filter((c) => c.startMs >= gOutBase - 1 && c.startMs < gOutEnd)
      .map((c) => ({
        wavPath: c.wavPath,
        startMs: Math.max(0, c.startMs - gOutBase),
        durationMs: c.durationMs,
      }));

    const groupSegs = placedSegments
      .filter((s) => (s.effective_start_ms ?? 0) >= gOutBase - 1 && (s.effective_start_ms ?? 0) < gOutEnd)
      .map((s) => ({
        ...s,
        effective_start_ms: Math.max(0, (s.effective_start_ms ?? 0) - gOutBase),
        effective_end_ms: Math.max(0, (s.effective_end_ms ?? 0) - gOutBase),
      }));

    const groupBedPath = path.join(partRoot, `bed_${gIdx}.wav`);
    await buildDuckedBed48k({
      hasAudio: project.video.has_audio,
      audio48kPath,
      rangeStartMs: gSrcStart,
      rangeEndMs: gSrcEnd,
      speechWindows: speechWindows.filter((w) => w.end_ms + 250 > gSrcStart && w.start_ms - 250 < gSrcEnd),
      partitions: shiftedPartitions,
      outBedPath: groupBedPath,
      recapMode: true,
      recapMuteOriginal,
      backgroundAudioMode,
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
      projectId: project.id,
      lang,
      sourceVideoPath,
      canvasPath: groupCanvasPath,
      hasNonSilentDub,
      bedPath: groupBedPath,
      rangeStartMs: gSrcStart,
      rangeEndMs: gSrcEnd,
      isFullVideo: false,
      partitions: shiftedPartitions,
      dubSegments: groupSegs,
      ttsVolumePct,
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
  }

  const report = await concatenateChunkOutputs({
    projectId: project.id,
    lang,
    chunkArtifacts,
    dubSegments: placedSegments,
    totalSourceDurationMs: videoDurationMs,
  });

  return { report, placedSegments };
}

export async function approveAndRenderRecapVideo(params: {
  projectId: string;
  beats?: RecapBeat[];
  sourceMode?: RecapSourceMode;
  narratorVoice?: string;
  recapMuteOriginal?: boolean;
  backgroundAudioMode?: BackgroundAudioMode;
  force?: boolean;
  visualConfig?: ExportVisualConfig;
}): Promise<Project> {
  const { projectId, force = false } = params;

  // Save latest edits & lock approved state first
  if (
    params.beats ||
    params.sourceMode ||
    params.narratorVoice ||
    params.recapMuteOriginal !== undefined ||
    params.backgroundAudioMode !== undefined
  ) {
    await saveRecapEdits({
      projectId,
      beats: params.beats,
      sourceMode: params.sourceMode,
      narratorVoice: params.narratorVoice,
      recapMuteOriginal: params.recapMuteOriginal,
      backgroundAudioMode: params.backgroundAudioMode,
    });
  }

  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (project.recap.length === 0) {
    throw new Error('Generate or add at least one Recap script beat before rendering.');
  }

  const cfg = getConfig();
  const paths = getProjectPaths(projectId);
  const sourceVideoPath = path.join(paths.sourceDir, project.video.filename);
  const audio48kPath = path.join(paths.workDir, 'audio_48k.wav');
  const recapMuteOriginal = params.recapMuteOriginal ?? project.recap_mute_original ?? true;
  const backgroundAudioMode = resolveBackgroundAudioMode({
    requested: params.backgroundAudioMode,
    project,
    isRecapMode: true,
  });
  const effectiveTtsVolPct = Math.max(
    RECAP_MIN_TTS_VOLUME_PCT,
    cfg.TTS_VOLUME_PCT ?? RECAP_MIN_TTS_VOLUME_PCT,
  );

  const setDubProgress = async (
    pct: number,
    message: string,
    status: 'running' | 'done' | 'error' = 'running',
    error?: string,
    etaSec?: number,
  ) => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        dub: {
          ...cur.stages.dub,
          status,
          progress_pct: pct,
          message,
          error,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: error ? 'error' : 'stage',
      stage: 'dub',
      progress_pct: pct,
      eta_sec: etaSec,
      message,
      project: updated,
    });
  };

  return runTrackedStepJob({
    projectId,
    kind: 'recap_render',
    label: 'Approve & Render Recap Video',
    hash: hashString(`recap-render|${projectId}|${Date.now()}`),
    force: true,
    skipResult: () => project,
    run: async () => {
    try {
      await updateProject(projectId, (cur) => ({
        ...cur,
        recap_script_status: 'approved',
      }));

      await setDubProgress(5, 'Synthesizing crisp Burmese narrator TTS (1.20x baseline, 150% vol)...');

      const primaryLang = resolveSingleTargetLang(project.target_langs);
      const renderLangs: TargetLang[] = [primaryLang];
      const totalBeatsAll = Math.max(
        1,
        project.recap.filter((b) => renderLangs.includes(b.lang)).length,
      );
      let doneBeats = 0;
      const startTime = Date.now();
      const updatedBeats: RecapBeat[] = [];
      const dubSegmentsForTimeline: DubSegment[] = [];
      const reportsByLang = new Map<TargetLang, DubValidationReport>();
      for (const r of project.dub_reports ?? []) {
        reportsByLang.set(r.lang, r);
      }

      for (const lang of renderLangs) {
        const langBeats = project.recap
          .filter((b) => b.lang === lang)
          .sort((a, b) => a.start_ms - b.start_ms);

        if (langBeats.length === 0) continue;

        const langVoice = resolveDefaultNarratorVoice({
          project,
          lang,
          engine: cfg.TTS_ENGINE,
          requestedVoice: params.narratorVoice,
        });

        const RECAP_TTS_CONCURRENCY = 4;
        const fittedForLang: DubSegment[] = new Array(langBeats.length);
        const fittedBeatById = new Map<number, DubSegment>();
        let nextBeatIndex = 0;

        const recapWorkerCount = Math.min(RECAP_TTS_CONCURRENCY, Math.max(1, langBeats.length));
        await Promise.all(
          Array.from({ length: recapWorkerCount }, async () => {
            while (nextBeatIndex < langBeats.length) {
              const i = nextBeatIndex;
              nextBeatIndex += 1;
              const beat = langBeats[i];
              const segInput = recapBeatToDubSegment(
                { ...beat, voice_name: beat.voice_name || langVoice },
                langVoice,
                cfg.TTS_ENGINE,
              );

              const fitRes = await runRecapFitLoopForSegment({
                projectId,
                seg: segInput,
                speakerGender:
                  langVoice.toLowerCase().includes('nilar') ||
                  langVoice.toLowerCase().includes('jenny') ||
                  langVoice.toLowerCase().includes('aria')
                    ? 'female'
                    : 'male',
                glossary: project.dub_glossary?.[lang] ?? {},
                force,
              });

              fittedForLang[i] = fitRes.segment;
              fittedBeatById.set(beat.id, fitRes.segment);

              doneBeats += 1;
              const doneSnapshot = doneBeats;
              const elapsedSec = (Date.now() - startTime) / 1000;
              const ratePerBeat = elapsedSec / Math.max(1, doneSnapshot);
              const etaSec = Math.max(
                2,
                Math.round(ratePerBeat * (totalBeatsAll - doneSnapshot) + 6),
              );
              const pct = 10 + Math.round((doneSnapshot / Math.max(1, totalBeatsAll)) * 60);

              await setDubProgress(
                pct,
                `TTS & beat sync [${lang}] (${doneSnapshot}/${totalBeatsAll}): ${fitRes.segment.tts_ms}ms vs ${fitRes.segment.slot_ms}ms (video ${fitRes.segment.video_rate?.toFixed(2) ?? '1.00'}x)`,
                'running',
                undefined,
                etaSec,
              );
            }
          }),
        );

        await setDubProgress(
          75,
          backgroundAudioMode === 'mute_original'
            ? 'Muting original audio (AI voice only, Demucs skipped) & rendering beat-synced video...'
            : `Muting original vocals (demucs 20% BGM/SFX bed) & rendering beat-synced [${lang}] video...`,
        );

        const rendered = await renderRecapLanguageTrack({
          project,
          lang,
          fittedSegments: fittedForLang,
          sourceVideoPath,
          audio48kPath,
          ttsVolumePct: effectiveTtsVolPct,
          recapMuteOriginal,
          backgroundAudioMode,
        });

        const renderedOutMp4 = path.join(paths.outDir, `dub_${lang}.mp4`);
        const cleanBaseMp4 = path.join(paths.dubDir, `base_${lang}.mp4`);
        if (await fileExists(renderedOutMp4)) {
          await fs.copyFile(renderedOutMp4, cleanBaseMp4);
        }

        reportsByLang.set(lang, rendered.report);
        dubSegmentsForTimeline.push(...rendered.placedSegments);

        const placedMap = new Map(rendered.placedSegments.map((s) => [s.id, s]));
        for (const beat of langBeats) {
          const placed = placedMap.get(beat.id) ?? fittedBeatById.get(beat.id);
          if (!placed) {
            updatedBeats.push(beat);
            continue;
          }
          updatedBeats.push({
            ...beat,
            slot_ms: placed.slot_ms,
            tts_ms: placed.tts_ms,
            tts_file: placed.tts_file,
            rate: placed.rate,
            video_rate: placed.video_rate ?? 1.0,
            effective_start_ms: placed.effective_start_ms,
            effective_end_ms: placed.effective_end_ms,
            status: placed.status,
            review_reason: placed.review_reason,
            syllables: placed.syllables ?? beat.syllables,
            voice_name: placed.voice_name ?? beat.voice_name,
            tts_engine: placed.tts_engine ?? beat.tts_engine,
            tts_model_used: placed.tts_model_used ?? beat.tts_model_used,
            model_used: placed.model_used ?? beat.model_used,
            error: placed.error,
          });
        }
      }

      const orderedReports = renderLangs
        .map((l) => reportsByLang.get(l))
        .filter((r): r is DubValidationReport => Boolean(r));

      const primaryReport = orderedReports[0];
      const finalMsg = primaryReport
        ? `Recap render complete (${updatedBeats.length} beats · |A - V| ${primaryReport.av_diff_ms}ms ${primaryReport.passed_40ms ? 'PASS' : 'CHECK'}). Ready in Preview & Export.`
        : 'Recap render complete.';

      const saved = await updateProject(projectId, (cur) => ({
        ...cur,
        recap: updatedBeats,
        recap_script_status: 'rendered',
        recap_mute_original: recapMuteOriginal,
        dub: dubSegmentsForTimeline,
        dub_reports: orderedReports,
        dub_combined_mp4: undefined,
        stages: {
          ...cur.stages,
          dub: {
            ...cur.stages.dub,
            status: 'done',
            progress_pct: 100,
            message: finalMsg,
            error: undefined,
            updated_at: new Date().toISOString(),
          },
        },
      }));

      emitProjectEvent(projectId, {
        type: 'project',
        stage: 'dub',
        progress_pct: 100,
        message: finalMsg,
        project: saved,
      });

      if (params.visualConfig) {
        const normalizedVisualConfig: ExportVisualConfig = {
          ...params.visualConfig,
          subtitle: {
            ...params.visualConfig.subtitle,
            mode: resolveSubtitleModeForLang(primaryLang, params.visualConfig.subtitle.mode),
          },
        };
        return await exportProjectWithVisualConfig({
          projectId,
          lang: primaryLang,
          visualConfig: normalizedVisualConfig,
        });
      }

      return saved;
    } catch (err) {
      const msg = describeFriendlyApiError(err);
      await setDubProgress(0, msg, 'error', msg);
      throw err;
    }
    },
  });
}
