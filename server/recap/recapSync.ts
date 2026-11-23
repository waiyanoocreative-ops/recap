import path from 'node:path';
import { defaultVoiceForGender } from '../../shared/dubUtils.ts';
import type { DubSegment, Gender, TargetLang, TtsEngineType } from '../../shared/projectTypes.ts';
import { getConfig } from '../config.ts';
import { prepareClip48kWithTempoAndFades, synthesizeCachedTts } from '../dub/audioDsp.ts';
import { countSyllables } from '../dub/syllables.ts';
import { getProjectPaths } from '../storage/projectStore.ts';
import {
  computeRecapMaxSyllables,
  retranslateRecapCueShorter,
  validateRecapTranslation,
} from './recapTranslator.ts';

function getClipRelativePath(lang: TargetLang, cueId: number): string {
  return path.posix.join('work', 'dub', 'clips', `${lang}_seg_${cueId}.wav`);
}

function getClipAbsolutePath(projectId: string, relPath: string): string {
  const paths = getProjectPaths(projectId);
  return path.join(paths.root, relPath);
}

export const RECAP_BASE_TTS_RATE = 1.18;
export const RECAP_MAX_TTS_RATE = 1.22;
export const RECAP_MIN_VIDEO_RATE = 0.6;
export const RECAP_DEMUCS_BED_GAIN = 0.2;
export const RECAP_MIN_TTS_VOLUME_PCT = 150;

export interface RecapFitResult {
  segment: DubSegment;
  madeLiveTtsCall: boolean;
  empiricalSpsSample?: number;
}

/**
 * Recap Mode cue-by-cue audio-video sync lock:
 * - Baseline narrator TTS rate: 1.18x (+18%) for crisp storytelling pacing.
 * - If tts_ms > slot_ms: slows ONLY that beat's video clip down to 0.60x (speed = Math.max(0.60, slot_ms / tts_ms)).
 * - If tts_ms is still slightly longer than the 0.60x slowed clip (slot_ms / 0.60),
 *   speeds up TTS slightly up to 1.22x and locks video_rate = Math.max(0.60, slot_ms / finalTtsMs)
 *   so video_duration === tts_ms frame-accurately for every beat.
 */
export async function runRecapFitLoopForSegment(params: {
  projectId: string;
  seg: DubSegment;
  speakerGender?: Gender;
  glossary: Record<string, string>;
  force: boolean;
}): Promise<RecapFitResult> {
  const { projectId, seg, speakerGender = 'unknown', glossary, force } = params;
  const cfg = getConfig();
  const engine: TtsEngineType = seg.tts_engine ?? cfg.TTS_ENGINE;
  const voice = seg.voice_name || defaultVoiceForGender(engine, seg.lang, speakerGender);
  const relClipPath = getClipRelativePath(seg.lang, seg.id);
  const absClipPath = getClipAbsolutePath(projectId, relClipPath);
  const slotMs = Math.max(200, seg.slot_ms || seg.end_ms - seg.start_ms);
  const maxSlowedSlotMs = Math.floor(slotMs / RECAP_MIN_VIDEO_RATE);

  let madeLiveTtsCall = false;
  let empiricalSpsSample: number | undefined;
  let textModelUsed = seg.model_used || cfg.TEXT_MODEL;

  const attemptSync = async (
    rawTts: Awaited<ReturnType<typeof synthesizeCachedTts>>,
    textStr: string,
    wasRetranslated: boolean,
  ): Promise<{ fitted: DubSegment | null; lastTtsMs: number }> => {
    const syl = countSyllables(textStr, seg.lang);
    const valCheck = validateRecapTranslation(textStr, slotMs, seg.lang);
    const reviewReason = valCheck.valid ? undefined : valCheck.reason;

    const baseCommon = {
      ...seg,
      slot_ms: slotMs,
      tgt_text: textStr,
      tts_file: relClipPath,
      syllables: syl,
      model_used: textModelUsed,
      tts_model_used: rawTts.modelUsed,
      tts_engine: rawTts.engine,
      borrowed_end_ms: undefined,
      review_reason: reviewReason,
      error: undefined,
    };

    // 1. Baseline 1.18x TTS storytelling rate
    const dur120Ms = await prepareClip48kWithTempoAndFades({
      inWavPath: rawTts.wavPath,
      outWavPath: absClipPath,
      rate: RECAP_BASE_TTS_RATE,
    });

    if (dur120Ms <= slotMs) {
      return {
        fitted: {
          ...baseCommon,
          tts_ms: dur120Ms,
          rate: RECAP_BASE_TTS_RATE,
          video_rate: 1.0,
          status: wasRetranslated ? 'retranslated' : 'ok',
        },
        lastTtsMs: dur120Ms,
      };
    }

    // 2. Slow ONLY this beat's video clip via setpts down to 0.60x
    const rawSpeed = slotMs / Math.max(1, dur120Ms);
    if (rawSpeed >= RECAP_MIN_VIDEO_RATE) {
      const videoRate = Number(Math.max(RECAP_MIN_VIDEO_RATE, Math.min(0.999, rawSpeed)).toFixed(6));
      return {
        fitted: {
          ...baseCommon,
          tts_ms: dur120Ms,
          rate: RECAP_BASE_TTS_RATE,
          video_rate: videoRate,
          status: wasRetranslated ? 'retranslated' : 'compressed',
        },
        lastTtsMs: dur120Ms,
      };
    }

    // 3. TTS is still longer than 0.60x slowed clip -> speed up TTS slightly (up to 1.22x)
    const neededRate = (rawTts.durationMs / Math.max(1, maxSlowedSlotMs)) * 1.005;
    const fastRate = Number(
      Math.min(RECAP_MAX_TTS_RATE, Math.max(RECAP_BASE_TTS_RATE + 0.005, neededRate)).toFixed(3),
    );
    const durFastMs = await prepareClip48kWithTempoAndFades({
      inWavPath: rawTts.wavPath,
      outWavPath: absClipPath,
      rate: fastRate,
    });

    if (durFastMs <= slotMs) {
      return {
        fitted: {
          ...baseCommon,
          tts_ms: durFastMs,
          rate: fastRate,
          video_rate: 1.0,
          status: wasRetranslated ? 'retranslated' : 'compressed',
        },
        lastTtsMs: durFastMs,
      };
    }

    if (durFastMs <= maxSlowedSlotMs) {
      const speed = slotMs / Math.max(1, durFastMs);
      const videoRate = Number(Math.max(RECAP_MIN_VIDEO_RATE, Math.min(0.999, speed)).toFixed(6));
      return {
        fitted: {
          ...baseCommon,
          tts_ms: durFastMs,
          rate: fastRate,
          video_rate: videoRate,
          status: wasRetranslated ? 'retranslated' : 'compressed',
        },
        lastTtsMs: durFastMs,
      };
    }

    return { fitted: null, lastTtsMs: durFastMs };
  };

  const firstTts = await synthesizeCachedTts({
    projectId,
    engine,
    text: seg.tgt_text,
    voice,
    style: cfg.SPEECH_STYLE,
    modelId: cfg.TTS_MODEL,
    force,
    jobLabel: `Recap TTS [${seg.lang}] #${seg.id} (${voice})`,
  });
  if (!firstTts.fromCache) madeLiveTtsCall = true;

  const firstSyl = countSyllables(seg.tgt_text, seg.lang);
  if (firstTts.durationMs > 250 && firstSyl > 0) {
    empiricalSpsSample = Math.max(1.5, Math.min(9.0, firstSyl / (firstTts.durationMs / 1000)));
  }

  const primary = await attemptSync(firstTts, seg.tgt_text, false);
  if (primary.fitted) {
    return {
      segment: primary.fitted,
      madeLiveTtsCall,
      empiricalSpsSample,
    };
  }

  // 4. Safety fallback: 1 punchy concise recap retranslation targeting max_syllables
  let bestText = seg.tgt_text;
  let bestTts = firstTts;
  let bestDurMs = primary.lastTtsMs;

  try {
    const shorter = await retranslateRecapCueShorter({
      projectId,
      srcText: seg.src_text,
      currentTranslation: seg.tgt_text,
      slotMs,
      targetLang: seg.lang,
      glossary,
      modelId: cfg.TEXT_MODEL,
    });
    textModelUsed = shorter.model_used || textModelUsed;

    if (shorter.translation && shorter.translation !== seg.tgt_text) {
      const secondTts = await synthesizeCachedTts({
        projectId,
        engine,
        text: shorter.translation,
        voice,
        style: cfg.SPEECH_STYLE,
        modelId: cfg.TTS_MODEL,
        force,
        jobLabel: `Recap shorten TTS [${seg.lang}] #${seg.id} (${voice})`,
      });
      if (!secondTts.fromCache) madeLiveTtsCall = true;

      if (secondTts.durationMs < bestTts.durationMs) {
        bestText = shorter.translation;
        bestTts = secondTts;
        const retry = await attemptSync(bestTts, bestText, true);
        if (retry.fitted) {
          return {
            segment: retry.fitted,
            madeLiveTtsCall,
            empiricalSpsSample,
          };
        }
        bestDurMs = retry.lastTtsMs;
      }
    }
  } catch (err) {
    console.warn(`[Recap Sync] Shorter retranslation failed for seg #${seg.id}:`, err);
  }

  // Finalize WAV at RECAP_MAX_TTS_RATE (1.22x) + 0.60x video if still slightly over budget
  if (bestTts !== firstTts || bestDurMs !== primary.lastTtsMs) {
    bestDurMs = await prepareClip48kWithTempoAndFades({
      inWavPath: bestTts.wavPath,
      outWavPath: absClipPath,
      rate: RECAP_MAX_TTS_RATE,
    });
  } else {
    bestDurMs = await prepareClip48kWithTempoAndFades({
      inWavPath: firstTts.wavPath,
      outWavPath: absClipPath,
      rate: RECAP_MAX_TTS_RATE,
    });
  }

  const maxSyl = computeRecapMaxSyllables(slotMs);
  return {
    segment: {
      ...seg,
      slot_ms: slotMs,
      tgt_text: bestText,
      tts_ms: bestDurMs,
      tts_file: relClipPath,
      rate: RECAP_MAX_TTS_RATE,
      video_rate: RECAP_MIN_VIDEO_RATE,
      borrowed_end_ms: undefined,
      status: 'overflow',
      review_reason: `Recap TTS ${bestDurMs}ms exceeds 0.60x slowed beat ${maxSlowedSlotMs}ms (limit ${maxSyl} syl)`,
      syllables: countSyllables(bestText, seg.lang),
      model_used: textModelUsed,
      tts_model_used: bestTts.modelUsed,
      tts_engine: bestTts.engine,
      error: undefined,
    },
    madeLiveTtsCall,
    empiricalSpsSample,
  };
}

/**
 * Builds strict chronological slow intervals for Recap Mode without trimming 50ms off touching beats.
 */
export function buildRecapSlowIntervals(
  orderedSegs: DubSegment[],
): Array<{ startMs: number; endMs: number; videoRate: number }> {
  return orderedSegs
    .map((s, idx) => {
      if ((s.video_rate ?? 1) >= 0.999) return null;
      const nextSeg = orderedSegs[idx + 1];
      const safeEnd = nextSeg ? Math.min(s.end_ms, nextSeg.start_ms) : s.end_ms;
      if (safeEnd <= s.start_ms) return null;
      return {
        startMs: s.start_ms,
        endMs: safeEnd,
        videoRate: Math.max(RECAP_MIN_VIDEO_RATE, s.video_rate!),
      };
    })
    .filter((iv): iv is { startMs: number; endMs: number; videoRate: number } => iv !== null);
}
