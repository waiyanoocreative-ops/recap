import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveStrictVoiceForSpeaker,
  validateTranslationCompleteness,
} from '../../shared/dubUtils.ts';
import type {
  DubSegment,
  DubSelection,
  DubValidationReport,
  ExportVisualConfig,
  Gender,
  Project,
  TargetLang,
  TtsEngineType,
} from '../../shared/projectTypes.ts';
import { hashString } from '../analyze/cache.ts';
import { geminiRuntime, getConfig } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { redactSecrets } from '../gemini/keyPool.ts';
import { runTrackedStepJob } from '../gemini/resilientClient.ts';
import { requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import {
  assembleDubCanvas48k,
  buildDuckedBed48k,
  computePiecewiseTimeline,
  mapSourceMsToOutputRelMs,
  mixAndMuxDubbedOutput,
  probeMediaDurationsMs,
  probeVideoFps,
  resolveBackgroundAudioMode,
  spawnFfmpegVideoEncodeWithHwFallback,
  synthesizeCachedTts,
  writeSynchronizedSrtFile,
} from './audioDsp.ts';
import { buildDubSourceCues, countSyllables, selectDubCues, type MergedDubCue } from './syllables.ts';
import {
  RECAP_BASE_TTS_RATE,
  RECAP_MIN_TTS_VOLUME_PCT,
  RECAP_MIN_VIDEO_RATE,
  buildRecapSlowIntervals,
  runRecapFitLoopForSegment,
} from '../recap/recapSync.ts';
import {
  prepareRecapCues,
  translateRecapCuesBatched,
} from '../recap/recapTranslator.ts';
import { synthesizeEdgeTtsBatch } from '../tts/ttsEngine.ts';
import {
  extractGlossaryForLang,
  resolveSpeakerVoicesForEngine,
  retranslateLineComplete,
  translateDubCuesBatched,
  type TranslatedCueItem,
} from './translate.ts';

function resolveDubSingleTargetLang(
  targetLangs: readonly TargetLang[] | undefined | null,
): TargetLang {
  if (!targetLangs || targetLangs.length === 0) return 'my-MM';
  if (targetLangs.includes('my-MM')) return 'my-MM';
  return targetLangs[0] === 'en-US' ? 'en-US' : 'my-MM';
}

export function getClipRelativePath(lang: TargetLang, cueId: number): string {
  return path.posix.join('work', 'dub', 'clips', `${lang}_seg_${cueId}.wav`);
}

export function getClipAbsolutePath(projectId: string, relPath: string): string {
  const paths = getProjectPaths(projectId);
  return path.join(paths.root, relPath);
}

/**
 * Step A + B + C:
 * Group sentence units (Fix 1a), run complete non-shortening translation (Fix 1b-c)
 * with 3 context units before/after and SPEECH_STYLE, and map voices for active TTS engine (Fix 2).
 */
export async function prepareDubTranslate(
  projectId: string,
  opts: { selection?: DubSelection; force?: boolean } = {},
): Promise<Project> {
  const force = Boolean(opts.force);
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }
  if (!project.upload.completed || project.stages.speech.status !== 'done') {
    throw new Error('Stage 2 (S1 Speech Map & S2 Speakers) must finish before translating.');
  }

  const selection = opts.selection ?? project.dub_selection;
  const isRecap = project.mode === 'recap';
  const rawCues = buildDubSourceCues(project.speech);
  const allCues = isRecap
    ? prepareRecapCues(rawCues, project.video.duration_ms || 0)
    : rawCues;
  const { selected } = selectDubCues(
    allCues,
    selection,
    project.video.duration_ms || 0,
    project.mode,
  );

  if (project.no_dialogue || selected.length === 0) {
    return updateProject(projectId, (cur) => ({
      ...cur,
      dub_selection: selection,
      dub: [],
    }));
  }

  if (!geminiRuntime.configured || !geminiRuntime.keyValid) {
    throw new Error(
      geminiRuntime.keyError ||
        'GEMINI_API_KEY is missing or invalid. Set GEMINI_API_KEY in .env.local or your environment.',
    );
  }

  const cfg = getConfig();
  const activeEngine: TtsEngineType = cfg.TTS_ENGINE;
  const nextGlossary: Record<string, Record<string, string>> = { ...(project.dub_glossary ?? {}) };
  const existingByKey = new Map<string, DubSegment>();
  for (const item of project.dub) {
    existingByKey.set(`${item.lang}:${item.id}`, item);
  }

  const nextDubItems: DubSegment[] = [];
  let updatedSpeakers = { ...project.speakers };
  const textModelsUsed = new Set<string>();
  const singleTargetLang = resolveDubSingleTargetLang(project.target_langs);
  const activeTargetLangs: TargetLang[] = [singleTargetLang];

  const syncSpeakerVoicesForMap = (voiceMap: Record<string, string>, targetLang: TargetLang) => {
    for (const [spk, vName] of Object.entries(voiceMap)) {
      const existingInfo = updatedSpeakers[spk];
      if (!existingInfo) continue;
      const strictVoice = resolveStrictVoiceForSpeaker({
        engine: activeEngine,
        targetLang,
        speakerGender: existingInfo.gender,
        voiceOverridden: existingInfo.voice_overridden,
        speakerVoice: existingInfo.voice,
        candidateVoice: vName,
        voicePools: cfg.VOICE_POOLS,
      });
      const engineMismatch = !existingInfo.voice || existingInfo.voice.engine !== activeEngine;
      const voiceMismatch = existingInfo.voice?.name !== strictVoice;

      if (engineMismatch || voiceMismatch) {
        updatedSpeakers = {
          ...updatedSpeakers,
          [spk]: {
            ...existingInfo,
            voice: { engine: activeEngine, name: strictVoice },
          },
        };
      }
    }
  };

  const getCuesNeedingTranslation = (lang: TargetLang): MergedDubCue[] => {
    const out: MergedDubCue[] = [];
    for (const cue of selected) {
      const prev = existingByKey.get(`${lang}:${cue.id}`);
      const hasValidExisting =
        !force &&
        prev &&
        prev.src_text === cue.text &&
        prev.start_ms === cue.start_ms &&
        prev.end_ms === cue.end_ms &&
        prev.tgt_text.trim().length > 0;
      if (!hasValidExisting) out.push(cue);
    }
    return out;
  };

  const buildLangItemsFor = (
    lang: TargetLang,
    voiceMap: Record<string, string>,
    partialMap: Map<number, TranslatedCueItem>,
    subtitleOnly = false,
  ): DubSegment[] =>
    selected.map((cue) => {
      const prev = existingByKey.get(`${lang}:${cue.id}`);
      const keepPrev =
        !force &&
        prev &&
        prev.src_text === cue.text &&
        prev.start_ms === cue.start_ms &&
        prev.end_ms === cue.end_ms &&
        prev.tgt_text.trim().length > 0;

      const translatedObj = partialMap.get(cue.id);
      const tgtText = keepPrev ? prev.tgt_text : (translatedObj?.translation || cue.text).trim();
      const reviewReason = keepPrev ? prev.review_reason : translatedObj?.review_reason;
      const modelUsed = keepPrev ? prev.model_used : translatedObj?.model_used;

      if (subtitleOnly) {
        return {
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
          rate: 1,
          video_rate: 1,
          borrowed_end_ms: prev?.borrowed_end_ms,
          effective_start_ms: prev?.effective_start_ms,
          effective_end_ms: prev?.effective_end_ms,
          status: reviewReason ? 'needs_review' : 'ok',
          review_reason: reviewReason,
          merged_ids: cue.merged_ids,
          voice_name: undefined,
          model_used: modelUsed || cfg.TEXT_MODEL,
          tts_model_used: undefined,
          tts_engine: activeEngine,
          syllables: countSyllables(tgtText, lang),
        };
      }

      const spkInfo = updatedSpeakers[cue.speaker];
      const spkGender: Gender = spkInfo?.gender ?? 'unknown';
      const speakerVoice = resolveStrictVoiceForSpeaker({
        engine: activeEngine,
        targetLang: lang,
        speakerGender: spkGender,
        voiceOverridden: spkInfo?.voice_overridden,
        speakerVoice: spkInfo?.voice,
        candidateVoice: voiceMap[cue.speaker],
        voicePools: cfg.VOICE_POOLS,
      });

      const engineChanged = Boolean(prev?.tts_engine && prev.tts_engine !== activeEngine);
      const effectiveVoice = resolveStrictVoiceForSpeaker({
        engine: activeEngine,
        targetLang: lang,
        speakerGender: spkGender,
        voiceOverridden: spkInfo?.voice_overridden,
        speakerVoice: spkInfo?.voice,
        candidateVoice: !engineChanged ? prev?.voice_name || speakerVoice : speakerVoice,
        voicePools: cfg.VOICE_POOLS,
      });

      const voiceChanged = Boolean(prev && prev.voice_name && prev.voice_name !== effectiveVoice);
      const recapRateInvalid = Boolean(isRecap && prev && prev.rate < 1.17);
      const dubRateInvalid = Boolean(!isRecap && prev && (prev.rate > 1.251 || prev.rate < 0.999));
      const reuseFitted =
        keepPrev &&
        !voiceChanged &&
        !engineChanged &&
        !recapRateInvalid &&
        !dubRateInvalid &&
        prev.tts_ms > 0;

      return {
        id: cue.id,
        lang,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        speaker: cue.speaker,
        src_lang: cue.src_lang,
        src_text: cue.text,
        tgt_text: tgtText,
        slot_ms: Math.max(200, cue.end_ms - cue.start_ms),
        tts_ms: reuseFitted ? prev.tts_ms : 0,
        tts_file: reuseFitted ? prev.tts_file : '',
        rate: reuseFitted ? prev.rate : isRecap ? RECAP_BASE_TTS_RATE : 1,
        video_rate: reuseFitted ? prev.video_rate : 1,
        borrowed_end_ms: reuseFitted ? prev.borrowed_end_ms : undefined,
        effective_start_ms: reuseFitted ? prev.effective_start_ms : undefined,
        effective_end_ms: reuseFitted ? prev.effective_end_ms : undefined,
        status: reuseFitted ? prev.status : reviewReason ? 'needs_review' : 'ok',
        review_reason: reviewReason,
        merged_ids: cue.merged_ids,
        voice_name: effectiveVoice,
        model_used: modelUsed || cfg.TEXT_MODEL,
        tts_model_used: reuseFitted ? prev.tts_model_used : undefined,
        tts_engine: activeEngine,
        syllables: countSyllables(tgtText, lang),
      };
    });

  for (const lang of activeTargetLangs) {
    const glossaryRes = await extractGlossaryForLang({
      projectId,
      cues: allCues,
      targetLang: lang,
      modelId: cfg.TEXT_MODEL,
      force,
    });
    const glossary = glossaryRes.glossary;
    if (glossaryRes.modelUsed) textModelsUsed.add(glossaryRes.modelUsed);
    nextGlossary[lang] = glossary;

    const voiceMap = resolveSpeakerVoicesForEngine({
      engine: activeEngine,
      speakers: updatedSpeakers,
      cues: allCues,
      targetLang: lang,
      voicePools: cfg.VOICE_POOLS,
    });
    syncSpeakerVoicesForMap(voiceMap, lang);

    const cuesNeedingTranslation = getCuesNeedingTranslation(lang);

    // Immediately save glossary + speaker voices before batch translation
    await updateProject(projectId, (cur) => ({
      ...cur,
      dub_selection: selection,
      dub_glossary: nextGlossary,
      speakers: updatedSpeakers,
    }));

    const translateFn = isRecap ? translateRecapCuesBatched : translateDubCuesBatched;
    const { translations: translatedMap, modelsUsed } = await translateFn({
      projectId,
      cues: cuesNeedingTranslation,
      allCues,
      targetLang: lang,
      glossary,
      speechStyle: cfg.SPEECH_STYLE,
      modelId: cfg.TEXT_MODEL,
      force,
      onBatchProgress: async (doneCount, totalCount, partialMap) => {
        const currentLangItems = buildLangItemsFor(lang, voiceMap, partialMap, false);
        const partialAll = [
          ...nextDubItems.filter((item) => item.lang !== lang),
          ...currentLangItems,
        ];
        const savedBatch = await updateProject(projectId, (cur) => ({
          ...cur,
          dub_selection: selection,
          dub_glossary: nextGlossary,
          speakers: updatedSpeakers,
          dub: partialAll,
        }));
        emitProjectEvent(projectId, {
          type: 'project',
          stage: 'dub',
          message: `[${lang}] Translated batch ${doneCount}/${totalCount}`,
          project: savedBatch,
        });
      },
    });

    for (const m of modelsUsed) textModelsUsed.add(m);
    nextDubItems.push(...buildLangItemsFor(lang, voiceMap, translatedMap, false));
  }

  const textModelSummary = Array.from(textModelsUsed).join(', ') || cfg.TEXT_MODEL;
  return updateProject(projectId, (cur) => ({
    ...cur,
    dub_selection: selection,
    dub_glossary: nextGlossary,
    speakers: updatedSpeakers,
    dub: nextDubItems,
    stages: {
      ...cur.stages,
      dub: {
        ...cur.stages.dub,
        model_used: textModelSummary,
      },
    },
  }));
}

interface FitSegmentResult {
  segment: DubSegment;
  madeLiveTtsCall: boolean;
  empiricalSpsSample?: number;
}

interface ParsedWavMeta {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
}

function parseWavPcmMeta(buf: Buffer): ParsedWavMeta | null {
  if (
    buf.length < 44 ||
    buf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buf.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return null;
  }
  let audioFormat = 1;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16 && bodyStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(bodyStart);
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataBytes = Math.min(chunkSize, Math.max(0, buf.length - bodyStart));
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || numChannels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    return null;
  }
  return { audioFormat, numChannels, sampleRate, bitsPerSample, dataOffset, dataBytes };
}

async function readWavDurationMsFast(wavPath: string): Promise<number> {
  try {
    const buf = await fs.readFile(wavPath);
    const meta = parseWavPcmMeta(buf);
    if (meta && meta.audioFormat === 1) {
      const bytesPerSec = meta.sampleRate * meta.numChannels * (meta.bitsPerSample / 8);
      if (bytesPerSec > 0) {
        return Math.round((meta.dataBytes / bytesPerSec) * 1000);
      }
    }
  } catch {
    // fall back to ffprobe
  }
  const probed = await probeMediaDurationsMs(wavPath);
  return probed.audioMs;
}

/**
 * Single-call FFmpeg tempo + 10ms fade-in/out converter producing 48kHz stereo PCM WAV
 * (zero redundant intermediate temp files or ffprobe calls).
 */
async function prepareClipFast48k(params: {
  inAudioPath: string;
  outWavPath: string;
  rate: number;
  inDurationMs?: number;
}): Promise<number> {
  const { ffmpeg } = requireFfmpeg();
  const { inAudioPath, outWavPath, rate } = params;
  await fs.mkdir(path.dirname(outWavPath), { recursive: true });

  const clampedRate = Math.max(MIN_DUB_TTS_ATEMPO_RATE, Math.min(MAX_TTS_ATEMPO_RATE, rate));
  const useTempo = Math.abs(clampedRate - 1.0) > 0.005;
  const inDurMs =
    params.inDurationMs && params.inDurationMs > 0
      ? params.inDurationMs
      : await readWavDurationMsFast(inAudioPath);
  const estOutDurSec = Math.max(0.05, inDurMs / 1000 / (useTempo ? clampedRate : 1.0));

  const filters: string[] = [];
  if (useTempo) {
    filters.push(`atempo=${clampedRate.toFixed(4)}`);
  }
  if (estOutDurSec >= 0.04) {
    const fadeOutStartSec = Math.max(0.015, estOutDurSec - 0.01).toFixed(4);
    filters.push(`afade=t=in:st=0:d=0.01`, `afade=t=out:st=${fadeOutStartSec}:d=0.01`);
  }
  if (filters.length === 0) {
    filters.push('anull');
  }

  const tmpOutPath = `${outWavPath}.tmp.${process.pid}.${Date.now()}.wav`;
  try {
    const res = await spawnCommand(ffmpeg, [
      '-y',
      '-i',
      inAudioPath,
      '-af',
      filters.join(','),
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      tmpOutPath,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `FFmpeg clip prep (atempo=${clampedRate.toFixed(3)}) failed: ${res.stderr.slice(-4000)}`,
      );
    }
    await fs.rename(tmpOutPath, outWavPath);
    return await readWavDurationMsFast(outWavPath);
  } catch (err) {
    await fs.unlink(tmpOutPath).catch(() => {});
    throw err;
  }
}

const DUB_TRACK_SAMPLE_RATE = 24000;

function createMono24kWavHeader(pcmDataBytes: number): Buffer {
  const sampleRate = DUB_TRACK_SAMPLE_RATE;
  const channels = 1;
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

/**
 * Decodes an audio file to mono 24000Hz 16-bit signed PCM (s16le) samples.
 * Fast-paths PCM WAVs (24kHz mono direct or 48kHz stereo 2:1 downsample) in Node.js,
 * and decodes MP3/other formats via FFmpeg pipe:1 without writing temp files.
 */
async function decodeClipTo24kMonoPcmS16le(filePath: string): Promise<Int16Array> {
  if (filePath.toLowerCase().endsWith('.wav')) {
    try {
      const rawBuf = await fs.readFile(filePath);
      const meta = parseWavPcmMeta(rawBuf);
      if (meta && meta.audioFormat === 1 && meta.bitsPerSample === 16) {
        if (meta.sampleRate === 24000 && meta.numChannels === 1) {
          const sampleCount = Math.floor(meta.dataBytes / 2);
          const out = new Int16Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            out[i] = rawBuf.readInt16LE(meta.dataOffset + i * 2);
          }
          return out;
        }
        if (meta.sampleRate === 48000 && meta.numChannels === 2) {
          const outCount = Math.floor(meta.dataBytes / 8); // 2 stereo 16-bit frames (8 bytes) per 24kHz mono sample
          const out = new Int16Array(outCount);
          for (let i = 0; i < outCount; i++) {
            const base = meta.dataOffset + i * 8;
            const l0 = rawBuf.readInt16LE(base);
            const r0 = rawBuf.readInt16LE(base + 2);
            const l1 = rawBuf.readInt16LE(base + 4);
            const r1 = rawBuf.readInt16LE(base + 6);
            out[i] = Math.round((l0 + r0 + l1 + r1) / 4);
          }
          return out;
        }
      }
    } catch {
      // fall through to FFmpeg decode
    }
  }

  const { ffmpeg } = requireFfmpeg();
  const pcmBuf = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-v', 'error', '-i', filePath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(stderrChunks).toString('utf-8').slice(-2000);
        reject(new Error(`FFmpeg 24kHz s16le decode failed for ${path.basename(filePath)}: ${errText}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });
  });

  const sampleCount = Math.floor(pcmBuf.length / 2);
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcmBuf.readInt16LE(i * 2);
  }
  return out;
}

/**
 * Instant Node.js PCM buffer assembly:
 * Decodes each fitted TTS clip to mono 24000Hz s16le PCM and mixes directly into a
 * zero-filled Int16Array at Math.floor((relStartMs / 1000) * 24000), clamped to [-32768, 32767],
 * saving a single dub_track.wav without passing 100+ inputs to FFmpeg amix.
 */
async function assembleDubTrack24kMonoWav(params: {
  clips: Array<{ wavPath: string; startMs: number; durationMs: number }>;
  rangeStartMs: number;
  totalDurMs: number;
  outDubTrackPath: string;
}): Promise<{ hasNonSilentDub: boolean }> {
  const { clips, rangeStartMs, totalDurMs, outDubTrackPath } = params;
  await fs.mkdir(path.dirname(outDubTrackPath), { recursive: true });

  const safeDurMs = Math.max(100, totalDurMs);
  const totalSamples = Math.max(1, Math.ceil((safeDurMs / 1000) * DUB_TRACK_SAMPLE_RATE));
  const mixBuffer = new Int16Array(totalSamples);

  const decodedClips: Array<{ startMs: number; samples: Int16Array }> = new Array(clips.length);
  const decodeConcurrency = Math.min(8, Math.max(1, clips.length));
  let decodeIdx = 0;

  await Promise.all(
    Array.from({ length: decodeConcurrency }, async () => {
      while (decodeIdx < clips.length) {
        const idx = decodeIdx;
        decodeIdx += 1;
        const clip = clips[idx];
        const samples = await decodeClipTo24kMonoPcmS16le(clip.wavPath);
        decodedClips[idx] = { startMs: clip.startMs, samples };
      }
    }),
  );

  let hasNonSilentDub = false;
  for (const clip of decodedClips) {
    if (!clip || clip.samples.length === 0) continue;
    const relStartMs = Math.max(0, clip.startMs - rangeStartMs);
    const offsetSample = Math.floor((relStartMs / 1000) * DUB_TRACK_SAMPLE_RATE);
    if (offsetSample >= mixBuffer.length) continue;

    const playableLen = Math.min(clip.samples.length, mixBuffer.length - offsetSample);
    for (let i = 0; i < playableLen; i++) {
      const summed = mixBuffer[offsetSample + i] + clip.samples[i];
      mixBuffer[offsetSample + i] =
        summed > 32767 ? 32767 : summed < -32768 ? -32768 : summed;
    }
    hasNonSilentDub = true;
  }

  const pcmBytes = mixBuffer.length * 2;
  const header = createMono24kWavHeader(pcmBytes);
  const pcmNodeBuf = Buffer.from(mixBuffer.buffer, mixBuffer.byteOffset, pcmBytes);

  const tmpWav = `${outDubTrackPath}.tmp.${process.pid}.${Date.now()}.wav`;
  const handle = await fs.open(tmpWav, 'w');
  try {
    await handle.write(header);
    await handle.write(pcmNodeBuf);
  } finally {
    await handle.close();
  }
  await fs.rename(tmpWav, outDubTrackPath);

  return { hasNonSilentDub };
}

/**
 * Single-pass Dubbing sync fit order (audio speed strictly 1.0x..1.25x; video slowdown down to 0.65x):
 * 1. Fit cleanly at 1.0x if duration <= slot_ms (never slow voice below 1.0x)
 * 2. Borrow available trailing silence gap at 1.0x without overlapping next speaker
 * 3. Speed up audio naturally within (1.0x, 1.25x] (+ trailing silence gap)
 * 4. If TTS at 1.25x max audio speed still exceeds the slot window, slow down ONLY the affected
 *    video interval via setpts (down to 0.65x) to preserve complete Burmese dialogue with |A-V| <= 40ms.
 */
export const MIN_DUB_TTS_ATEMPO_RATE = 1.0;
export const NATURAL_TTS_ATEMPO_RATE = 1.25;
export const MAX_TTS_ATEMPO_RATE = 1.25;
export const MIN_DUB_VIDEO_RATE = 0.65;
export const MAX_TRAILING_GAP_BORROW_MS = 350;
export async function runFitLoopForSegment(params: {
  projectId: string;
  seg: DubSegment;
  speakerGender?: Gender;
  voiceOverridden?: boolean;
  speakerVoice?: { engine: TtsEngineType; name: string };
  allCues: MergedDubCue[];
  rangeEndMs: number;
  glossary: Record<string, string>;
  force: boolean;
}): Promise<FitSegmentResult> {
  const { projectId, seg, speakerGender = 'unknown', allCues, rangeEndMs, force } = params;
  const cfg = getConfig();
  const engine: TtsEngineType = seg.tts_engine ?? cfg.TTS_ENGINE;
  const voice = resolveStrictVoiceForSpeaker({
    engine,
    targetLang: seg.lang,
    speakerGender,
    voiceOverridden: params.voiceOverridden,
    speakerVoice: params.speakerVoice,
    candidateVoice: seg.voice_name,
    voicePools: cfg.VOICE_POOLS,
  });
  const relClipPath = getClipRelativePath(seg.lang, seg.id);
  const absClipPath = getClipAbsolutePath(projectId, relClipPath);

  const compCheck = validateTranslationCompleteness(seg.src_text, seg.tgt_text, seg.lang);
  const activeReviewReason = seg.review_reason || (compCheck.valid ? undefined : compCheck.reason);

  let madeLiveTtsCall = false;
  let empiricalSpsSample: number | undefined;

  let sourceAudioPath = '';
  let sourceDurationMs = 0;
  let sourceModelUsed = engine === 'edge' ? 'edge-tts' : (cfg.TTS_MODEL || engine);
  let sourceEngine: TtsEngineType = engine;

  // Fast path: if pre-batch Edge TTS MP3 already exists on disk (and WAV cache isn't required), probe/use directly
  if (engine === 'edge' && !force) {
    const cacheDir = getProjectPaths(projectId).cacheDir;
    const edgeMp3Hash = hashString(`${seg.tgt_text}|${voice}|+0%|+0Hz`);
    const edgeMp3Path = path.join(cacheDir, `tts_edge_${edgeMp3Hash}.mp3`);
    try {
      const mp3Stat = await fs.stat(edgeMp3Path);
      if (mp3Stat.isFile() && mp3Stat.size > 0) {
        const probed = await probeMediaDurationsMs(edgeMp3Path);
        if (probed.audioMs > 0) {
          sourceAudioPath = edgeMp3Path;
          sourceDurationMs = probed.audioMs;
          sourceModelUsed = 'edge-tts';
          sourceEngine = 'edge';
        }
      }
    } catch {
      // fall through to synthesizeCachedTts
    }
  }

  if (!sourceAudioPath || sourceDurationMs <= 0) {
    const firstTts = await synthesizeCachedTts({
      projectId,
      engine,
      text: seg.tgt_text,
      voice,
      style: cfg.SPEECH_STYLE,
      modelId: cfg.TTS_MODEL,
      force,
      jobLabel: `TTS [${seg.lang}] #${seg.id} (${voice})`,
    });
    if (!firstTts.fromCache) madeLiveTtsCall = true;
    sourceAudioPath = firstTts.wavPath;
    sourceDurationMs = firstTts.durationMs;
    sourceModelUsed = firstTts.modelUsed;
    sourceEngine = firstTts.engine;
  }

  const firstSyl = countSyllables(seg.tgt_text, seg.lang);
  if (sourceDurationMs > 250 && firstSyl > 0) {
    empiricalSpsSample = Math.max(1.5, Math.min(9.0, firstSyl / (sourceDurationMs / 1000)));
  }

  const bestText = seg.tgt_text;
  const textModelUsed = seg.model_used || cfg.TEXT_MODEL;

  // Trailing silence gap calculation (strictly non-overlapping: leave >= 50ms before next speaker)
  const sortedCues = [...allCues].sort((a, b) => a.start_ms - b.start_ms);
  const curCueIdx = sortedCues.findIndex((c) => c.id === seg.id);
  const nextCue =
    curCueIdx >= 0
      ? sortedCues[curCueIdx + 1]
      : sortedCues.find((c) => c.start_ms >= seg.end_ms - 20);
  const clampedRangeEndMs = Math.max(seg.end_ms, rangeEndMs);
  const availableGapMs = nextCue
    ? Math.max(0, Math.min(nextCue.start_ms - 50, clampedRangeEndMs) - seg.end_ms)
    : Math.max(0, clampedRangeEndMs - seg.end_ms);

  const baseBorrowMs = Math.min(MAX_TRAILING_GAP_BORROW_MS, availableGapMs);
  const baseExpandedSlotMs = seg.slot_ms + baseBorrowMs;
  const maxExpandedSlotMs = seg.slot_ms + availableGapMs;
  const maxExpandedEndMs = Math.min(clampedRangeEndMs, seg.end_ms + availableGapMs);
  const rawSafeEndMs = Math.min(
    clampedRangeEndMs,
    nextCue ? Math.min(maxExpandedEndMs, nextCue.start_ms - 50) : maxExpandedEndMs,
  );
  const slowSpanMs = Math.max(0, rawSafeEndMs - seg.start_ms);

  const syl = countSyllables(bestText, seg.lang);
  const baseCommon = {
    ...seg,
    voice_name: voice,
    tgt_text: bestText,
    tts_file: relClipPath,
    syllables: syl,
    model_used: textModelUsed,
    tts_model_used: sourceModelUsed,
    tts_engine: sourceEngine,
    review_reason: activeReviewReason,
    error: undefined,
  };

  // Fits original slot cleanly at natural 1.0x rate (never slow audio below 1.0x)
  if (sourceDurationMs <= seg.slot_ms) {
    const finalDurMs = await prepareClipFast48k({
      inAudioPath: sourceAudioPath,
      outWavPath: absClipPath,
      rate: MIN_DUB_TTS_ATEMPO_RATE,
      inDurationMs: sourceDurationMs,
    });
    if (finalDurMs <= seg.slot_ms + 5) {
      return {
        segment: {
          ...baseCommon,
          tts_ms: finalDurMs,
          rate: MIN_DUB_TTS_ATEMPO_RATE,
          video_rate: 1.0,
          borrowed_end_ms: undefined,
          status: activeReviewReason ? 'needs_review' : 'ok',
        },
        madeLiveTtsCall,
        empiricalSpsSample,
      };
    }
  }

  // Fit Step 1: Borrow trailing silence gap at natural 1.0x rate
  if (sourceDurationMs <= maxExpandedSlotMs) {
    const finalDurMs = await prepareClipFast48k({
      inAudioPath: sourceAudioPath,
      outWavPath: absClipPath,
      rate: MIN_DUB_TTS_ATEMPO_RATE,
      inDurationMs: sourceDurationMs,
    });
    if (finalDurMs <= maxExpandedSlotMs + 5) {
      const usedBorrow = Math.min(availableGapMs, Math.max(0, finalDurMs - seg.slot_ms));
      return {
        segment: {
          ...baseCommon,
          tts_ms: finalDurMs,
          rate: MIN_DUB_TTS_ATEMPO_RATE,
          video_rate: 1.0,
          borrowed_end_ms: usedBorrow > 0 ? seg.end_ms + usedBorrow : undefined,
          status: activeReviewReason ? 'needs_review' : usedBorrow > 0 ? 'compressed' : 'ok',
        },
        madeLiveTtsCall,
        empiricalSpsSample,
      };
    }
  }

  // Fit Step 2a: Natural speedup (1.0x - 1.25x), borrowing trailing silence up to 350ms or full silence gap
  const ratioBase = sourceDurationMs / Math.max(1, baseExpandedSlotMs);
  if (ratioBase <= NATURAL_TTS_ATEMPO_RATE) {
    const targetRate = Math.min(
      NATURAL_TTS_ATEMPO_RATE,
      Math.max(1.01, Number((ratioBase * 1.01).toFixed(3))),
    );
    const finalDurMs = await prepareClipFast48k({
      inAudioPath: sourceAudioPath,
      outWavPath: absClipPath,
      rate: targetRate,
      inDurationMs: sourceDurationMs,
    });
    if (finalDurMs <= baseExpandedSlotMs + 5) {
      return {
        segment: {
          ...baseCommon,
          tts_ms: finalDurMs,
          rate: targetRate,
          video_rate: 1.0,
          borrowed_end_ms: baseBorrowMs > 0 ? seg.end_ms + baseBorrowMs : undefined,
          status: activeReviewReason ? 'needs_review' : 'compressed',
        },
        madeLiveTtsCall,
        empiricalSpsSample,
      };
    }
  }

  const minSlotAtNaturalRate = Math.ceil(sourceDurationMs / NATURAL_TTS_ATEMPO_RATE);
  if (minSlotAtNaturalRate <= maxExpandedSlotMs) {
    const usedBorrow = Math.min(availableGapMs, Math.max(baseBorrowMs, minSlotAtNaturalRate - seg.slot_ms));
    const chosenSlotMs = seg.slot_ms + usedBorrow;
    const ratioNatural = sourceDurationMs / Math.max(1, chosenSlotMs);
    const targetRate = Math.min(
      NATURAL_TTS_ATEMPO_RATE,
      Math.max(1.01, Number((ratioNatural * 1.01).toFixed(3))),
    );
    const finalDurMs = await prepareClipFast48k({
      inAudioPath: sourceAudioPath,
      outWavPath: absClipPath,
      rate: targetRate,
      inDurationMs: sourceDurationMs,
    });
    if (finalDurMs <= maxExpandedSlotMs + 5) {
      const actualBorrow = Math.min(availableGapMs, Math.max(usedBorrow, finalDurMs - seg.slot_ms));
      return {
        segment: {
          ...baseCommon,
          tts_ms: finalDurMs,
          rate: targetRate,
          video_rate: 1.0,
          borrowed_end_ms: actualBorrow > 0 ? seg.end_ms + actualBorrow : undefined,
          status: activeReviewReason ? 'needs_review' : 'compressed',
        },
        madeLiveTtsCall,
        empiricalSpsSample,
      };
    }
  }

  // Fit Step 2b: Cap audio speed strictly <= 1.25x + full available trailing silence gap
  const ratioExpandedMax = sourceDurationMs / Math.max(1, maxExpandedSlotMs);
  if (ratioExpandedMax <= MAX_TTS_ATEMPO_RATE) {
    const targetRate = Math.min(
      MAX_TTS_ATEMPO_RATE,
      Math.max(1.01, Number((ratioExpandedMax * 1.01).toFixed(3))),
    );
    const finalDurMs = await prepareClipFast48k({
      inAudioPath: sourceAudioPath,
      outWavPath: absClipPath,
      rate: targetRate,
      inDurationMs: sourceDurationMs,
    });
    if (finalDurMs <= maxExpandedSlotMs + 5) {
      return {
        segment: {
          ...baseCommon,
          tts_ms: finalDurMs,
          rate: targetRate,
          video_rate: 1.0,
          borrowed_end_ms: availableGapMs > 0 ? seg.end_ms + availableGapMs : undefined,
          status: activeReviewReason ? 'needs_review' : 'compressed',
        },
        madeLiveTtsCall,
        empiricalSpsSample,
      };
    }
  }

  // Fit Step 3: Audio capped at 1.25x -> slow affected video interval down to 0.65x so speech finishes without overlap
  const finalDurMs = await prepareClipFast48k({
    inAudioPath: sourceAudioPath,
    outWavPath: absClipPath,
    rate: MAX_TTS_ATEMPO_RATE,
    inDurationMs: sourceDurationMs,
  });

  if (finalDurMs <= slowSpanMs) {
    return {
      segment: {
        ...baseCommon,
        tts_ms: finalDurMs,
        rate: MAX_TTS_ATEMPO_RATE,
        video_rate: 1.0,
        borrowed_end_ms: availableGapMs > 0 ? seg.end_ms + availableGapMs : undefined,
        status: activeReviewReason ? 'needs_review' : 'compressed',
      },
      madeLiveTtsCall,
      empiricalSpsSample,
    };
  }

  if (slowSpanMs >= 100) {
    const rawVideoRate = slowSpanMs / (finalDurMs + 10);
    if (rawVideoRate >= MIN_DUB_VIDEO_RATE) {
      const videoRate = Number(Math.max(MIN_DUB_VIDEO_RATE, Math.min(0.999, rawVideoRate)).toFixed(6));
      return {
        segment: {
          ...baseCommon,
          tts_ms: finalDurMs,
          rate: MAX_TTS_ATEMPO_RATE,
          video_rate: videoRate,
          borrowed_end_ms: availableGapMs > 0 ? seg.end_ms + availableGapMs : undefined,
          status: activeReviewReason ? 'needs_review' : 'compressed',
        },
        madeLiveTtsCall,
        empiricalSpsSample,
      };
    }

    const maxSlowedSpanMs = Math.floor(slowSpanMs / MIN_DUB_VIDEO_RATE);
    const overflowReason =
      activeReviewReason ||
      `TTS ${finalDurMs}ms exceeds ${MIN_DUB_VIDEO_RATE}x slowed slot ${maxSlowedSpanMs}ms at ${MAX_TTS_ATEMPO_RATE}x`;
    return {
      segment: {
        ...baseCommon,
        tts_ms: finalDurMs,
        rate: MAX_TTS_ATEMPO_RATE,
        video_rate: MIN_DUB_VIDEO_RATE,
        borrowed_end_ms: availableGapMs > 0 ? seg.end_ms + availableGapMs : undefined,
        status: 'overflow',
        review_reason: overflowReason,
      },
      madeLiveTtsCall,
      empiricalSpsSample,
    };
  }

  const overflowReason =
    activeReviewReason ||
    `TTS ${finalDurMs}ms exceeds slot ${maxExpandedSlotMs}ms at ${MAX_TTS_ATEMPO_RATE}x`;
  return {
    segment: {
      ...baseCommon,
      tts_ms: finalDurMs,
      rate: MAX_TTS_ATEMPO_RATE,
      video_rate: 1.0,
      borrowed_end_ms: availableGapMs > 0 ? seg.end_ms + availableGapMs : undefined,
      status: 'overflow',
      review_reason: overflowReason,
    },
    madeLiveTtsCall,
    empiricalSpsSample,
  };
}

export function buildDubSlowIntervals(
  orderedSegs: DubSegment[],
  minVideoRate = MIN_DUB_VIDEO_RATE,
  rangeEndMs?: number,
): Array<{ startMs: number; endMs: number; videoRate: number }> {
  return orderedSegs
    .map((s, idx) => {
      if ((s.video_rate ?? 1) >= 0.999) return null;
      const nextSeg = orderedSegs[idx + 1];
      const rawEnd = s.borrowed_end_ms ?? s.end_ms;
      const boundedByNext = nextSeg ? Math.min(rawEnd, nextSeg.start_ms - 50) : rawEnd;
      const safeEnd =
        rangeEndMs !== undefined ? Math.min(boundedByNext, rangeEndMs) : boundedByNext;
      if (safeEnd <= s.start_ms || safeEnd - s.start_ms < 45) return null;
      return {
        startMs: s.start_ms,
        endMs: safeEnd,
        videoRate: Math.max(minVideoRate, Math.min(0.999, s.video_rate!)),
      };
    })
    .filter((iv): iv is { startMs: number; endMs: number; videoRate: number } => iv !== null);
}

async function fastMixAndMuxDubTrack(params: {
  projectId: string;
  lang: TargetLang;
  sourceVideoPath: string;
  dubTrackPath: string;
  bedPath: string;
  rangeStartMs: number;
  rangeEndMs: number;
  isFullVideo: boolean;
  dubSegments: DubSegment[];
  ttsVolumePct?: number;
}): Promise<DubValidationReport> {
  const { ffmpeg } = requireFfmpeg();
  const {
    projectId,
    lang,
    sourceVideoPath,
    dubTrackPath,
    bedPath,
    rangeStartMs,
    rangeEndMs,
    isFullVideo,
    dubSegments,
    ttsVolumePct,
  } = params;

  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.dubDir, { recursive: true });
  await fs.mkdir(paths.outDir, { recursive: true });

  const langTag = lang === 'my-MM' ? 'mya' : 'eng';
  const outWavPath = path.join(paths.dubDir, `dub_${lang}.wav`);
  const outMp4Path = path.join(paths.outDir, `dub_${lang}.mp4`);
  const outSrtPath = path.join(paths.outDir, `dub_${lang}.srt`);
  const outReportPath = path.join(paths.outDir, `report_${lang}.json`);
  await fs.unlink(path.join(paths.outDir, `dub_${lang}.wav`)).catch(() => {});

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
  const sliceVideoPath = path.join(paths.dubDir, `video_slice_${lang}.mp4`);
  if (!isFullVideo) {
    const startSec = (rangeStartMs / 1000).toFixed(4);
    const durSec = Math.max(0.5, (rangeEndMs - rangeStartMs) / 1000).toFixed(4);
    const fpsStr = await probeVideoFps(resolvedVideoSource);
    const rSlice = await spawnFfmpegVideoEncodeWithHwFallback({
      ffmpeg,
      prefixArgs: ['-y', '-ss', startSec, '-t', durSec, '-i', resolvedVideoSource],
      suffixArgs: ['-vf', `fps=${fpsStr}`, '-an', '-video_track_timescale', '90000'],
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

  // Fast 2-input FFmpeg mix: assembled dub_track.wav + ducked background bed -> out/dub_${lang}.wav
  const configuredVolPct = ttsVolumePct ?? getConfig().TTS_VOLUME_PCT ?? 150;
  const clampedVolPct = Math.max(100, Math.min(200, Math.round(configuredVolPct)));
  const dubGain = (clampedVolPct / 100).toFixed(3);
  const rMix = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    dubTrackPath,
    '-i',
    bedPath,
    '-filter_complex',
    `[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,volume=${dubGain},alimiter=limit=0.95[dub];[dub][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,apad,atrim=0:${exactVideoDurSec}[outa]`,
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
    throw new Error(`FFmpeg 2-input dub/bed mix failed: ${rMix.stderr.slice(-4000)}`);
  }

  // Fast video stream-copy mux (-c:v copy) onto untouched video with AAC 128k 44.1kHz stereo
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
    '-metadata:s:a:0',
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

  await writeSynchronizedSrtFile({
    outSrtPath,
    dubSegments,
    rangeStartMs,
    lang,
  });

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
    wav_file: `work/dub/dub_${lang}.wav`,
    srt_file: `out/dub_${lang}.srt`,
    generated_at: new Date().toISOString(),
  };

  const tmpReport = `${outReportPath}.tmp`;
  await fs.writeFile(tmpReport, JSON.stringify(report, null, 2), 'utf-8');
  await fs.rename(tmpReport, outReportPath);

  return report;
}

async function rebuildAudioAndMuxForProject(params: {
  project: Project;
  langs?: TargetLang[];
}): Promise<{
  reports: DubValidationReport[];
  combinedMp4?: string;
  updatedDub: DubSegment[];
}> {
  const { project } = params;
  const targetLangs = params.langs ?? project.target_langs;
  const paths = getProjectPaths(project.id);
  const isRecap = project.mode === 'recap';
  const rawCues = buildDubSourceCues(project.speech);
  const allCues = isRecap
    ? prepareRecapCues(rawCues, project.video.duration_ms || 0)
    : rawCues;
  const sel = selectDubCues(
    allCues,
    project.dub_selection,
    project.video.duration_ms || 0,
    project.mode,
  );
  const sourceVideoPath = path.join(paths.sourceDir, project.video.filename);
  const audio48kPath = path.join(paths.workDir, 'audio_48k.wav');

  const reportsByLang = new Map<TargetLang, DubValidationReport>();
  for (const prev of project.dub_reports ?? []) {
    reportsByLang.set(prev.lang, prev);
  }

  const updatedByKey = new Map<string, DubSegment>();
  for (const seg of project.dub) {
    updatedByKey.set(`${seg.lang}:${seg.id}`, seg);
  }

  // 'mute_original' writes a silent bed (AI voice only, Demucs/Kaggle skipped); 'keep_bgm_demucs'
  // keeps the existing Demucs no_vocals bed (20% volume in Recap Mode, ducked 85% in Dubbing Mode).
  const backgroundAudioMode = resolveBackgroundAudioMode({
    project,
    isRecapMode: project.mode === 'recap',
  });
  const keepOriginalBed = project.video.has_audio;
  const effectiveTtsVolPct = isRecap
    ? Math.max(RECAP_MIN_TTS_VOLUME_PCT, getConfig().TTS_VOLUME_PCT ?? RECAP_MIN_TTS_VOLUME_PCT)
    : getConfig().TTS_VOLUME_PCT;

  const singleLang = resolveDubSingleTargetLang(params.langs ?? project.target_langs);
  const audioRenderLangs: TargetLang[] = [singleLang];

  if (targetLangs.length === 0 || project.no_dialogue || project.dub.length === 0) {
    const emptyBedPath = path.join(paths.dubDir, 'bed_ducked.wav');
    const passSpeechWindows = project.no_dialogue
      ? []
      : project.speech
          .filter((s) => s.end_ms + 250 > sel.rangeStartMs && s.start_ms - 250 < sel.rangeEndMs)
          .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms }));
    await buildDuckedBed48k({
      hasAudio: keepOriginalBed,
      audio48kPath,
      rangeStartMs: sel.rangeStartMs,
      rangeEndMs: sel.rangeEndMs,
      speechWindows: passSpeechWindows,
      outBedPath: emptyBedPath,
      recapMode: isRecap,
      recapMuteOriginal: project.recap_mute_original ?? true,
      backgroundAudioMode,
    });
    const dubTrackPath = path.join(paths.dubDir, 'dub_track.wav');
    await assembleDubTrack24kMonoWav({
      clips: [],
      rangeStartMs: sel.rangeStartMs,
      totalDurMs: Math.max(100, sel.rangeEndMs - sel.rangeStartMs),
      outDubTrackPath: dubTrackPath,
    });
    for (const lang of audioRenderLangs) {
      const report = await fastMixAndMuxDubTrack({
        projectId: project.id,
        lang,
        sourceVideoPath,
        dubTrackPath,
        bedPath: emptyBedPath,
        rangeStartMs: sel.rangeStartMs,
        rangeEndMs: sel.rangeEndMs,
        isFullVideo: sel.isFullVideo,
        dubSegments: [],
        ttsVolumePct: effectiveTtsVolPct,
      });
      reportsByLang.set(lang, report);
    }
  } else {
    for (const lang of audioRenderLangs) {
      const langSegments = project.dub
        .filter((d) => d.lang === lang)
        .sort((a, b) => a.start_ms - b.start_ms);

      const slowIntervals = isRecap
        ? buildRecapSlowIntervals(langSegments)
        : buildDubSlowIntervals(langSegments, MIN_DUB_VIDEO_RATE, sel.rangeEndMs);
      const hasSlowdown = slowIntervals.length > 0;

      const partitions = computePiecewiseTimeline(
        sel.rangeStartMs,
        sel.rangeEndMs,
        slowIntervals,
        isRecap ? RECAP_MIN_VIDEO_RATE : MIN_DUB_VIDEO_RATE,
      );
      const totalOutDurMs =
        partitions.length > 0
          ? partitions[partitions.length - 1].outEndMs
          : Math.max(100, sel.rangeEndMs - sel.rangeStartMs);

      const bedPath = path.join(paths.dubDir, `bed_ducked_${lang}.wav`);
      const rawSpeechInRange = project.speech
        .filter((s) => s.end_ms + 250 > sel.rangeStartMs && s.start_ms - 250 < sel.rangeEndMs)
        .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms }));
      const speechWindows = [
        ...rawSpeechInRange,
        ...(langSegments.length > 0
          ? langSegments.map((s) => ({
              start_ms: s.start_ms,
              end_ms: s.borrowed_end_ms ?? s.end_ms,
            }))
          : sel.selected.map((c) => ({ start_ms: c.start_ms, end_ms: c.end_ms }))),
      ];

      await buildDuckedBed48k({
        hasAudio: keepOriginalBed,
        audio48kPath,
        rangeStartMs: sel.rangeStartMs,
        rangeEndMs: sel.rangeEndMs,
        speechWindows,
        partitions,
        outBedPath: bedPath,
        recapMode: isRecap,
        recapMuteOriginal: project.recap_mute_original ?? true,
        backgroundAudioMode,
      });

      const clips: Array<{ wavPath: string; startMs: number; durationMs: number }> = [];
      const updatedLangSegs: DubSegment[] = [];
      const minGapMs = isRecap ? 0 : 50;
      let prevOutEndMs = isRecap ? sel.rangeStartMs : sel.rangeStartMs - 100;

      for (const seg of langSegments) {
        const mappedStart = sel.rangeStartMs + mapSourceMsToOutputRelMs(seg.start_ms, partitions);
        const mappedEnd =
          sel.rangeStartMs +
          mapSourceMsToOutputRelMs(seg.borrowed_end_ms ?? seg.end_ms, partitions);

        // Zero-overlap enforcement: Recap uses exact beat edges (0ms forced gap); Dubbing keeps 50ms breathing gap
        const effStart = Math.max(mappedStart, prevOutEndMs + minGapMs);
        const effEnd = isRecap
          ? effStart + Math.max(0, seg.tts_ms)
          : Math.max(mappedEnd, effStart + seg.tts_ms);

        const nextSeg: DubSegment = {
          ...seg,
          effective_start_ms: effStart,
          effective_end_ms: effEnd,
        };
        updatedLangSegs.push(nextSeg);
        updatedByKey.set(`${seg.lang}:${seg.id}`, nextSeg);

        if (nextSeg.tts_file) {
          const abs = getClipAbsolutePath(project.id, nextSeg.tts_file);
          if (await fileExists(abs)) {
            clips.push({ wavPath: abs, startMs: effStart, durationMs: nextSeg.tts_ms });
            prevOutEndMs = effStart + Math.max(0, nextSeg.tts_ms);
          }
        } else {
          prevOutEndMs = effEnd;
        }
      }

      let report: DubValidationReport;
      if (hasSlowdown) {
        const canvasPath = path.join(paths.dubDir, `canvas_${lang}.wav`);
        const { hasNonSilentDub } = await assembleDubCanvas48k({
          clips,
          rangeStartMs: sel.rangeStartMs,
          rangeEndMs: sel.rangeEndMs,
          totalDurMs: totalOutDurMs,
          outCanvasPath: canvasPath,
        });
        report = await mixAndMuxDubbedOutput({
          projectId: project.id,
          lang,
          sourceVideoPath,
          canvasPath,
          hasNonSilentDub,
          bedPath,
          rangeStartMs: sel.rangeStartMs,
          rangeEndMs: sel.rangeEndMs,
          isFullVideo: sel.isFullVideo,
          partitions,
          dubSegments: updatedLangSegs,
          ttsVolumePct: effectiveTtsVolPct,
        });
      } else {
        const dubTrackPath = path.join(paths.dubDir, 'dub_track.wav');
        await assembleDubTrack24kMonoWav({
          clips,
          rangeStartMs: sel.rangeStartMs,
          totalDurMs: totalOutDurMs,
          outDubTrackPath: dubTrackPath,
        });
        report = await fastMixAndMuxDubTrack({
          projectId: project.id,
          lang,
          sourceVideoPath,
          dubTrackPath,
          bedPath,
          rangeStartMs: sel.rangeStartMs,
          rangeEndMs: sel.rangeEndMs,
          isFullVideo: sel.isFullVideo,
          dubSegments: updatedLangSegs,
          ttsVolumePct: effectiveTtsVolPct,
        });
      }

      const renderedOutMp4 = path.join(paths.outDir, `dub_${lang}.mp4`);
      const cleanBaseMp4 = path.join(paths.dubDir, `base_${lang}.mp4`);
      if (await fileExists(renderedOutMp4)) {
        await fs.copyFile(renderedOutMp4, cleanBaseMp4);
      }

      reportsByLang.set(lang, report);
    }
  }

  const orderedReports = audioRenderLangs
    .map((l) => reportsByLang.get(l))
    .filter((r): r is DubValidationReport => Boolean(r));

  return {
    reports: orderedReports,
    combinedMp4: undefined,
    updatedDub: project.dub
      .filter((d) => d.lang === singleLang)
      .map((d) => updatedByKey.get(`${d.lang}:${d.id}`) ?? d),
  };
}

/**
 * Full Stage 3 Dubbing Render Pipeline (Steps A - H).
 * Uses configured TTS_ENGINE ('edge' or 'gemini') + configured models from Settings.
 */
export async function runDubRenderPipeline(
  projectId: string,
  opts: { selection?: DubSelection; force?: boolean; translateFirst?: boolean } = {},
): Promise<Project> {
  const force = Boolean(opts.force);
  const cfg = getConfig();

  const initialProj = await getProject(projectId);
  if (!initialProj) throw new Error(`Project "${projectId}" not found.`);
  if (!initialProj.upload.completed || initialProj.stages.speech.status !== 'done') {
    throw new Error('Stage 2 must complete before running Stage 3 Dubbing.');
  }

  const effectiveSel = opts.selection ?? initialProj.dub_selection;
  if (initialProj.video.duration_ms > 10 * 60 * 1000 && effectiveSel.mode === 'all') {
    const { runChunkedDubRenderPipeline } = await import('../chunks/longVideoPipeline.ts');
    return runChunkedDubRenderPipeline(projectId, {
      force,
      translateFirst: opts.translateFirst,
    });
  }

  const primaryLang = resolveDubSingleTargetLang(initialProj.target_langs);
  const checkDubHash = (proj: Project) =>
    hashString(
      JSON.stringify({
        syncVersion: proj.mode === 'recap' ? 'recap-v3-single-lang-aac128' : 'dub-v6-single-lang-aac128',
        langs: [resolveDubSingleTargetLang(proj.target_langs)],
        sel: effectiveSel,
        mode: proj.mode,
        recapMuteOriginal: proj.recap_mute_original ?? true,
        backgroundAudioMode: resolveBackgroundAudioMode({
          project: proj,
          isRecapMode: proj.mode === 'recap',
        }),
        engine: cfg.TTS_ENGINE,
        ttsModel: cfg.TTS_MODEL,
        textModel: cfg.TEXT_MODEL,
        style: cfg.SPEECH_STYLE,
        ttsVolumePct: cfg.TTS_VOLUME_PCT,
        lines: proj.dub
          .filter((d) => d.lang === resolveDubSingleTargetLang(proj.target_langs))
          .map((d) => [d.lang, d.id, d.tgt_text, d.voice_name, d.tts_ms, d.rate, d.video_rate]),
      }),
    );

  if (!force && !opts.translateFirst && initialProj.stages.dub.status === 'done') {
    const paths = getProjectPaths(projectId);
    const outputsExist = await fileExists(path.join(paths.outDir, `dub_${primaryLang}.mp4`));
    const currentHash = checkDubHash(initialProj);
    if (outputsExist && (!initialProj.stage_hashes?.dub || initialProj.stage_hashes.dub === currentHash)) {
      emitProjectEvent(projectId, {
        type: 'project',
        stage: 'dub',
        progress_pct: 100,
        message: initialProj.stages.dub.message || 'Stage 3 already complete (cached on disk).',
        project: initialProj,
      });
      return initialProj;
    }
  }

  const runningProj = await updateProject(projectId, (cur) => ({
    ...cur,
    ...(opts.selection ? { dub_selection: opts.selection } : {}),
    stages: {
      ...cur.stages,
      dub: {
        status: 'running',
        progress_pct: 3,
        message: 'Preparing dubbing translation & voice mapping (Steps A–C)...',
        model_used: cfg.TEXT_MODEL,
        updated_at: new Date().toISOString(),
      },
    },
  }));

  emitProjectEvent(projectId, {
    type: 'stage',
    stage: 'dub',
    progress_pct: 3,
    message: 'Preparing dubbing translation & voice mapping (Steps A–C)...',
    project: runningProj,
  });

  try {
    const translatedProj = await prepareDubTranslate(projectId, {
      selection: opts.selection ?? runningProj.dub_selection,
      force: Boolean(opts.translateFirst),
    });

    if (translatedProj.no_dialogue || translatedProj.dub.length === 0) {
      const { reports, combinedMp4 } = await rebuildAudioAndMuxForProject({
        project: translatedProj,
      });
      const doneEmpty = await updateProject(projectId, (cur) => ({
        ...cur,
        dub_reports: reports,
        dub_combined_mp4: combinedMp4,
        stages: {
          ...cur.stages,
          dub: {
            status: 'done',
            progress_pct: 100,
            message: 'Completed pass-through render (no dialogue).',
            model_used: cur.stages.dub.model_used || cfg.TEXT_MODEL,
            updated_at: new Date().toISOString(),
          },
        },
      }));
      emitProjectEvent(projectId, {
        type: 'project',
        stage: 'dub',
        progress_pct: 100,
        message: 'Stage 3 Dubbing complete (no dialogue).',
        project: doneEmpty,
      });
      return doneEmpty;
    }

    const isRecap = translatedProj.mode === 'recap';
    const rawCues = buildDubSourceCues(translatedProj.speech);
    const allCues = isRecap
      ? prepareRecapCues(rawCues, translatedProj.video.duration_ms || 0)
      : rawCues;
    const sel = selectDubCues(
      allCues,
      translatedProj.dub_selection,
      translatedProj.video.duration_ms || 0,
      translatedProj.mode,
    );

    const workItems = [...translatedProj.dub];
    const totalItems = Math.max(1, workItems.length);
    const spsSamples: Record<string, number[]> = {};
    const calibratedSps: Record<string, number> = { ...(translatedProj.calibrated_sps ?? {}) };
    const textModelsSet = new Set<string>(
      translatedProj.stages.dub.model_used
        ? translatedProj.stages.dub.model_used.split(',').map((s) => s.trim()).filter(Boolean)
        : [cfg.TEXT_MODEL],
    );
    const ttsModelsSet = new Set<string>();

    const TTS_WORKER_CONCURRENCY = 8;
    let completedCount = 0;
    let nextIndex = 0;
    let avgLiveStepMs =
      cfg.TTS_ENGINE === 'edge'
        ? 2500
        : Math.max(4500, (cfg.GEMINI_TTS_MIN_SPACING_MS ?? 3500) + 2500);
    let liveCallSamples = 0;

    const processOneCue = async (i: number): Promise<void> => {
      const seg = workItems[i];
      const segEngine = seg.tts_engine ?? cfg.TTS_ENGINE;
      const spkInfo = translatedProj.speakers[seg.speaker];
      const speakerGender = spkInfo?.gender ?? 'unknown';
      const expectedVoice = isRecap
        ? seg.voice_name
        : resolveStrictVoiceForSpeaker({
            engine: cfg.TTS_ENGINE,
            targetLang: seg.lang,
            speakerGender,
            voiceOverridden: spkInfo?.voice_overridden,
            speakerVoice: spkInfo?.voice,
            candidateVoice: seg.voice_name,
            voicePools: cfg.VOICE_POOLS,
          });
      const existingAbs = seg.tts_file ? getClipAbsolutePath(projectId, seg.tts_file) : '';
      const canResumeExisting =
        !force &&
        seg.tts_ms > 0 &&
        segEngine === cfg.TTS_ENGINE &&
        (isRecap || (seg.voice_name === expectedVoice && seg.rate >= 0.999 && seg.rate <= 1.251)) &&
        (!isRecap || seg.rate >= 1.17) &&
        Boolean(existingAbs) &&
        (await fileExists(existingAbs));

      if (canResumeExisting) {
        if (seg.tts_model_used) ttsModelsSet.add(seg.tts_model_used);
        completedCount += 1;
        return;
      }

      const effectiveParallel = cfg.TTS_ENGINE === 'edge' ? TTS_WORKER_CONCURRENCY : 1;
      const remainingBefore = Math.max(1, workItems.length - completedCount);
      const etaSec = Math.max(
        1,
        Math.round((remainingBefore * avgLiveStepMs) / (1000 * effectiveParallel)),
      );
      const pctStart = Math.min(82, Math.max(8, Math.round(8 + (completedCount / totalItems) * 74)));
      const engineLabel = cfg.TTS_ENGINE === 'edge' ? 'Edge TTS' : 'Gemini TTS';

      const stepMsg = `[${seg.lang}] Line #${seg.id} (${i + 1}/${totalItems}) · ${engineLabel} (${expectedVoice || seg.voice_name || 'default'})`;
      emitProjectEvent(projectId, {
        type: 'stage',
        stage: 'dub',
        progress_pct: pctStart,
        eta_sec: etaSec,
        message: stepMsg,
      });

      const t0 = Date.now();
      const glossary = translatedProj.dub_glossary?.[seg.lang] ?? {};
      const fit = isRecap
        ? await runRecapFitLoopForSegment({
            projectId,
            seg: { ...seg, tts_engine: cfg.TTS_ENGINE },
            speakerGender,
            glossary,
            force,
          })
        : await runFitLoopForSegment({
            projectId,
            seg: { ...seg, voice_name: expectedVoice, tts_engine: cfg.TTS_ENGINE },
            speakerGender,
            voiceOverridden: spkInfo?.voice_overridden,
            speakerVoice: spkInfo?.voice,
            allCues,
            rangeEndMs: sel.rangeEndMs,
            glossary,
            force,
          });
      workItems[i] = fit.segment;
      if (fit.segment.model_used) textModelsSet.add(fit.segment.model_used);
      if (fit.segment.tts_model_used) ttsModelsSet.add(fit.segment.tts_model_used);

      if (fit.empiricalSpsSample !== undefined) {
        const list = spsSamples[seg.lang] ?? [];
        if (list.length < 5 && (fit.madeLiveTtsCall || list.length === 0)) {
          list.push(fit.empiricalSpsSample);
          spsSamples[seg.lang] = list;
          const avg = list.reduce((a, b) => a + b, 0) / list.length;
          calibratedSps[seg.lang] = Number(avg.toFixed(2));
        }
      }

      if (fit.madeLiveTtsCall) {
        const elapsed = Math.max(1000, Date.now() - t0);
        liveCallSamples += 1;
        avgLiveStepMs =
          liveCallSamples === 1 ? elapsed : Math.round(avgLiveStepMs * 0.65 + elapsed * 0.35);
      }

      completedCount += 1;
      const doneSnapshot = completedCount;
      const pctAfter = Math.min(84, Math.max(10, Math.round(8 + (doneSnapshot / totalItems) * 74)));
      const etaAfter = Math.max(
        0,
        Math.round(
          ((totalItems - doneSnapshot) * (fit.madeLiveTtsCall ? avgLiveStepMs : 1200)) /
            (1000 * effectiveParallel),
        ),
      );

      const interimProj = await updateProject(projectId, (cur) => {
        const modelSummary = `TEXT: ${Array.from(textModelsSet).join(', ')} · TTS: ${Array.from(ttsModelsSet).join(', ') || (cfg.TTS_ENGINE === 'edge' ? 'edge-tts' : cfg.TTS_MODEL)}`;
        return {
          ...cur,
          calibrated_sps: { ...calibratedSps },
          dub: [...workItems],
          stages: {
            ...cur.stages,
            dub: {
              status: 'running',
              progress_pct: Math.max(cur.stages.dub.progress_pct, pctAfter),
              message: `[${seg.lang}] #${seg.id} (${doneSnapshot}/${totalItems}) -> ${fit.segment.status} (${fit.segment.tts_ms}ms / slot ${fit.segment.slot_ms}ms)`,
              model_used: modelSummary,
              updated_at: new Date().toISOString(),
            },
          },
        };
      });

      emitProjectEvent(projectId, {
        type: 'stage',
        stage: 'dub',
        progress_pct: interimProj.stages.dub.progress_pct,
        eta_sec: etaAfter,
        message: interimProj.stages.dub.message,
        project: interimProj,
      });
    };

    // Pre-batch Edge TTS synthesis in ONE single Python process with asyncio.Semaphore(4)
    const f5MyanmarSelected =
      (process.env.TTS_ENGINE || '').trim().toLowerCase() === 'f5-myanmar' ||
      (process.env.MYANMAR_TTS_ENGINE || '').trim().toLowerCase() === 'f5-myanmar' ||
      ['1', 'true'].includes((process.env.F5_MYANMAR_TTS || '').trim().toLowerCase());

    if (cfg.TTS_ENGINE === 'edge' && !f5MyanmarSelected && workItems.length > 0) {
      const cacheDir = getProjectPaths(projectId).cacheDir;
      const batchItems: Array<{ id: string; text: string; voice: string; outPath: string }> = [];
      for (const seg of workItems) {
        const segEngine = seg.tts_engine ?? cfg.TTS_ENGINE;
        if (segEngine !== 'edge') continue;
        const spkInfo = translatedProj.speakers[seg.speaker];
        const speakerGender = spkInfo?.gender ?? 'unknown';
        const voice = resolveStrictVoiceForSpeaker({
          engine: 'edge',
          targetLang: seg.lang,
          speakerGender,
          voiceOverridden: spkInfo?.voice_overridden,
          speakerVoice: spkInfo?.voice,
          candidateVoice: seg.voice_name,
          voicePools: cfg.VOICE_POOLS,
        });
        const existingAbs = seg.tts_file ? getClipAbsolutePath(projectId, seg.tts_file) : '';
        const canResume =
          !force &&
          seg.tts_ms > 0 &&
          (isRecap || (seg.voice_name === voice && seg.rate >= 0.999 && seg.rate <= 1.251)) &&
          (!isRecap || seg.rate >= 1.17) &&
          Boolean(existingAbs) &&
          (await fileExists(existingAbs));
        if (canResume) continue;

        const contentHash = hashString(`${seg.tgt_text}|${voice}|+0%|+0Hz`);
        batchItems.push({
          id: `${seg.lang}:${seg.id}`,
          text: seg.tgt_text,
          voice,
          outPath: path.join(cacheDir, `tts_edge_${contentHash}.mp3`),
        });
      }
      if (batchItems.length > 0) {
        emitProjectEvent(projectId, {
          type: 'stage',
          stage: 'dub',
          progress_pct: 10,
          message: `Batch-synthesizing ${batchItems.length} Edge TTS clips in single Python process...`,
        });
        await synthesizeEdgeTtsBatch(batchItems);
      }
    }

    const workerCount = Math.min(TTS_WORKER_CONCURRENCY, Math.max(1, workItems.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < workItems.length) {
          const idx = nextIndex;
          nextIndex += 1;
          await processOneCue(idx);
        }
      }),
    );

    const finalModelSummary = `TEXT: ${Array.from(textModelsSet).join(', ')} · TTS: ${Array.from(ttsModelsSet).join(', ') || (cfg.TTS_ENGINE === 'edge' ? 'edge-tts' : cfg.TTS_MODEL)}`;

    // Steps E, F, H: Duck bed, piecewise video slowdown (if needed), loudnorm dub, mix, mux, SRT, A/V <= 40ms
    const preMuxProj = await updateProject(projectId, (cur) => ({
      ...cur,
      calibrated_sps: calibratedSps,
      dub: [...workItems],
      stages: {
        ...cur.stages,
        dub: {
          status: 'running',
          progress_pct: 88,
          message: 'Mixing ducked bed + loudnorm dub + muxing MP4/WAV/SRT...',
          model_used: finalModelSummary,
          updated_at: new Date().toISOString(),
        },
      },
    }));

    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'dub',
      progress_pct: 88,
      eta_sec: 4,
      message: preMuxProj.stages.dub.message,
      project: preMuxProj,
    });

    const renderHash = hashString(
      JSON.stringify({
        langs: preMuxProj.target_langs,
        sel: preMuxProj.dub_selection,
        lines: preMuxProj.dub.map((d) => [d.lang, d.id, d.tts_file, d.tts_ms, d.video_rate, d.tgt_text]),
      }),
    );

    const { reports, combinedMp4, updatedDub } = await runTrackedStepJob({
      projectId,
      kind: 'dub_render',
      label: `Render & Mux (${preMuxProj.target_langs.join('+')})`,
      hash: renderHash,
      force: true,
      skipResult: async () => ({
        reports: preMuxProj.dub_reports,
        combinedMp4: preMuxProj.dub_combined_mp4,
        updatedDub: preMuxProj.dub,
      }),
      run: () =>
        rebuildAudioAndMuxForProject({
          project: preMuxProj,
        }),
    });

    const summaryStr = reports
      .map((r) => `${r.lang}: |A-V|=${r.av_diff_ms}ms (${r.passed_40ms ? 'PASS' : 'CHECK'})`)
      .join(' | ');

    const finalProj = await updateProject(projectId, (cur) => {
      const resolvedLang = resolveDubSingleTargetLang(cur.target_langs);
      const doneHash = hashString(
        JSON.stringify({
          syncVersion: cur.mode === 'recap' ? 'recap-v3-single-lang-aac128' : 'dub-v6-single-lang-aac128',
          langs: [resolvedLang],
          sel: cur.dub_selection,
          mode: cur.mode,
          recapMuteOriginal: cur.recap_mute_original ?? true,
          backgroundAudioMode: resolveBackgroundAudioMode({
            project: cur,
            isRecapMode: cur.mode === 'recap',
          }),
          engine: cfg.TTS_ENGINE,
          ttsModel: cfg.TTS_MODEL,
          textModel: cfg.TEXT_MODEL,
          style: cfg.SPEECH_STYLE,
          ttsVolumePct: cfg.TTS_VOLUME_PCT,
          lines: updatedDub.map((d) => [d.lang, d.id, d.tgt_text, d.voice_name, d.tts_ms, d.rate, d.video_rate]),
        }),
      );
      return {
        ...cur,
        dub: updatedDub,
        dub_reports: reports,
        dub_combined_mp4: undefined,
        stage_hashes: {
          ...cur.stage_hashes,
          dub: doneHash,
        },
        stages: {
          ...cur.stages,
          dub: {
            status: 'done',
            progress_pct: 100,
            message: `Stage 3 complete · ${summaryStr}`,
            model_used: finalModelSummary,
            updated_at: new Date().toISOString(),
          },
        },
      };
    });

    emitProjectEvent(projectId, {
      type: 'project',
      stage: 'dub',
      progress_pct: 100,
      eta_sec: 0,
      message: finalProj.stages.dub.message,
      project: finalProj,
    });

    return finalProj;
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    const erroredProj = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        dub: {
          ...cur.stages.dub,
          status: 'error',
          error: msg,
          message: msg,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: 'error',
      stage: 'dub',
      message: msg,
      project: erroredProj,
    });
    throw err;
  }
}

export async function regenerateDubLineAndRemix(params: {
  projectId: string;
  lang: TargetLang;
  segId: number;
  tgt_text?: string;
  voice_name?: string;
}): Promise<{ project: Project; segment: DubSegment }> {
  const { projectId, lang, segId, tgt_text, voice_name } = params;
  const cfg = getConfig();
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);

  const targetIdx = project.dub.findIndex((d) => d.lang === lang && d.id === segId);
  if (targetIdx === -1) {
    throw new Error(`Dub segment #${segId} (${lang}) not found.`);
  }

  const existingSeg = project.dub[targetIdx];
  const nextText = tgt_text !== undefined ? tgt_text.trim() : existingSeg.tgt_text;
  const nextVoice = voice_name !== undefined ? voice_name.trim() : existingSeg.voice_name;

  const isRecap = project.mode === 'recap';
  const rawCues = buildDubSourceCues(project.speech);
  const allCues = isRecap
    ? prepareRecapCues(rawCues, project.video.duration_ms || 0)
    : rawCues;
  const sel = selectDubCues(
    allCues,
    project.dub_selection,
    project.video.duration_ms || 0,
    project.mode,
  );

  const spkInfo = project.speakers[existingSeg.speaker];
  const spkGender = spkInfo?.gender ?? 'unknown';
  const explicitVoiceChange = Boolean(
    voice_name !== undefined && nextVoice && nextVoice !== existingSeg.voice_name,
  );
  const resolvedVoice = isRecap
    ? nextVoice || existingSeg.voice_name
    : explicitVoiceChange
      ? nextVoice
      : resolveStrictVoiceForSpeaker({
          engine: cfg.TTS_ENGINE,
          targetLang: lang,
          speakerGender: spkGender,
          voiceOverridden: spkInfo?.voice_overridden,
          speakerVoice: spkInfo?.voice,
          candidateVoice: nextVoice || existingSeg.voice_name,
          voicePools: cfg.VOICE_POOLS,
        });

  const patchedSeg: DubSegment = {
    ...existingSeg,
    tgt_text: nextText || existingSeg.tgt_text,
    voice_name: resolvedVoice,
    tts_engine: cfg.TTS_ENGINE,
    review_reason: undefined,
    syllables: countSyllables(nextText || existingSeg.tgt_text, lang),
  };

  const glossary = project.dub_glossary?.[lang] ?? {};

  const fit = isRecap
    ? await runRecapFitLoopForSegment({
        projectId,
        seg: patchedSeg,
        speakerGender: spkGender,
        glossary,
        force: true,
      })
    : await runFitLoopForSegment({
        projectId,
        seg: patchedSeg,
        speakerGender: spkGender,
        voiceOverridden: Boolean(explicitVoiceChange && resolvedVoice) || spkInfo?.voice_overridden,
        speakerVoice:
          explicitVoiceChange && resolvedVoice
            ? { engine: cfg.TTS_ENGINE, name: resolvedVoice }
            : spkInfo?.voice,
        allCues,
        rangeEndMs: sel.rangeEndMs,
        glossary,
        force: true,
      });

  const updatedDubList = [...project.dub];
  updatedDubList[targetIdx] = fit.segment;

  const withFittedSeg = await updateProject(projectId, (cur) => ({
    ...cur,
    dub: updatedDubList,
  }));

  const { reports, updatedDub } = await rebuildAudioAndMuxForProject({
    project: withFittedSeg,
    langs: [lang],
  });

  const finalSeg = updatedDub.find((d) => d.lang === lang && d.id === segId) ?? fit.segment;

  const finalProj = await updateProject(projectId, (cur) => ({
    ...cur,
    dub: updatedDub,
    dub_reports: reports,
    dub_combined_mp4: undefined,
  }));

  emitProjectEvent(projectId, {
    type: 'project',
    stage: 'dub',
    progress_pct: finalProj.stages.dub.progress_pct,
    message: `[${lang}] Regenerated line #${segId} (${finalSeg.status})`,
    project: finalProj,
  });

  return { project: finalProj, segment: finalSeg };
}

export async function retranslateDubLineCompleteAndSave(params: {
  projectId: string;
  lang: TargetLang;
  segId: number;
}): Promise<{ project: Project; segment: DubSegment }> {
  const { projectId, lang, segId } = params;
  const cfg = getConfig();
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);

  const targetIdx = project.dub.findIndex((d) => d.lang === lang && d.id === segId);
  if (targetIdx === -1) {
    throw new Error(`Dub segment #${segId} (${lang}) not found.`);
  }

  const existingSeg = project.dub[targetIdx];
  const isRecap = project.mode === 'recap';
  const rawCues = buildDubSourceCues(project.speech);
  const allCues = isRecap
    ? prepareRecapCues(rawCues, project.video.duration_ms || 0)
    : rawCues;
  const cue = allCues.find((c) => c.id === segId) ?? {
    id: existingSeg.id,
    start_ms: existingSeg.start_ms,
    end_ms: existingSeg.end_ms,
    speaker: existingSeg.speaker,
    src_lang: existingSeg.src_lang,
    text: existingSeg.src_text,
    merged_ids: existingSeg.merged_ids ?? [existingSeg.id],
  };

  const glossary = project.dub_glossary?.[lang] ?? {};
  let complete: { translation: string; review_reason?: string; model_used: string };
  if (isRecap) {
    const recapRes = await translateRecapCuesBatched({
      projectId,
      cues: [cue],
      allCues,
      targetLang: lang,
      glossary,
      speechStyle: cfg.SPEECH_STYLE,
      modelId: cfg.TEXT_MODEL,
      force: true,
    });
    const item = recapRes.translations.get(cue.id);
    complete = {
      translation: item?.translation || existingSeg.tgt_text,
      review_reason: item?.review_reason,
      model_used: item?.model_used || recapRes.modelsUsed[0] || cfg.TEXT_MODEL,
    };
  } else {
    complete = await retranslateLineComplete({
      projectId,
      cue,
      allCues,
      currentTranslation: existingSeg.tgt_text,
      targetLang: lang,
      speechStyle: cfg.SPEECH_STYLE,
      glossary,
      modelId: cfg.TEXT_MODEL,
    });
  }

  const patchedSeg: DubSegment = {
    ...existingSeg,
    tgt_text: complete.translation,
    review_reason: complete.review_reason,
    model_used: complete.model_used,
    tts_engine: cfg.TTS_ENGINE,
    status: complete.review_reason ? 'needs_review' : 'ok',
    syllables: countSyllables(complete.translation, lang),
  };

  await updateProject(projectId, (cur) => ({
    ...cur,
    dub: cur.dub.map((d) => (d.lang === lang && d.id === segId ? patchedSeg : d)),
  }));

  if (project.stages.dub.status === 'done' || Boolean(existingSeg.tts_file)) {
    return regenerateDubLineAndRemix({
      projectId,
      lang,
      segId,
      tgt_text: complete.translation,
      voice_name: existingSeg.voice_name,
    });
  }

  const refreshed = await getProject(projectId);
  const finalSeg = refreshed?.dub.find((d) => d.lang === lang && d.id === segId) ?? patchedSeg;
  return { project: refreshed ?? project, segment: finalSeg };
}



export async function saveExportLogoPng(params: {
  projectId: string;
  dataUrl: string;
}): Promise<string> {
  const { projectId, dataUrl } = params;
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid logo image data URL.');
  }
  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.dubDir, { recursive: true });
  const logoPath = path.join(paths.dubDir, 'export_logo.png');
  const buf = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  const tmpLogo = `${logoPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpLogo, buf);
  await fs.rename(tmpLogo, logoPath);
  return 'work/dub/export_logo.png';
}

export async function exportProjectWithVisualConfig(params: {
  projectId: string;
  lang?: TargetLang;
  visualConfig: ExportVisualConfig;
}): Promise<Project> {
  const { exportProjectWithVisualConfig: runExport } = await import('./srtBuilder.ts');
  return runExport(params);
}


