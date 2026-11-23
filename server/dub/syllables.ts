import { mergeSentenceUnits } from '../../shared/dubUtils.ts';
import type { DubSelection, ProjectMode, SpeechSegment, TargetLang } from '../../shared/projectTypes.ts';

export interface MergedDubCue {
  id: number;
  start_ms: number;
  end_ms: number;
  speaker: string;
  src_lang: string;
  text: string;
  merged_ids: number[];
}

/**
 * Counts approximate spoken syllables for Burmese (my-MM) or English (en-US)
 * to calculate line syllable budgets and track empirical speaking rates.
 */
export function countSyllables(text: string, lang: TargetLang): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;

  if (lang === 'my-MM') {
    // Count Myanmar consonants/independent vowels that start a syllable (not killed by asat \u103A or stacked via virama \u1039)
    // Plus any Latin words embedded in Burmese lines.
    let count = 0;
    const myMatches = cleaned.match(/[\u1000-\u1021\u1023-\u102A\u1040-\u1049](?!\u103A)(?<!\u1039[\u1000-\u1021])/g);
    if (myMatches) {
      count += myMatches.length;
    }
    const latinWords = cleaned.match(/[A-Za-z0-9]+/g);
    if (latinWords) {
      for (const w of latinWords) {
        count += countEnglishWordSyllables(w);
      }
    }
    return Math.max(1, count);
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const word of words) {
    total += countEnglishWordSyllables(word);
  }
  return Math.max(1, total);
}

function countEnglishWordSyllables(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!word) return 0;
  if (/^\d+$/.test(word)) return Math.max(1, word.length);
  if (word.length <= 3) return 1;
  const trimmed = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Step A (Fix 3): Group consecutive same-speaker fragments into short sentence units
 * until a sentence-ending mark (。！？.!?…။) OR pause >= 400 ms, strictly capped at 8 s.
 */
export function buildDubSourceCues(speechSegments: SpeechSegment[]): MergedDubCue[] {
  return mergeSentenceUnits(speechSegments);
}

/**
 * Rule 1: Quota-safe segment selection.
 * Never calls TTS outside selected cues.
 * When all cues are selected -> full video; when a subset is selected -> test clip range only.
 * In Recap Mode, preview/opening selections always begin at 00:00 (0 ms) so the opening beat is never dropped.
 */
export function selectDubCues(
  allCues: MergedDubCue[],
  selection: DubSelection,
  videoDurationMs: number,
  mode?: ProjectMode,
): {
  selected: MergedDubCue[];
  isFullVideo: boolean;
  rangeStartMs: number;
  rangeEndMs: number;
} {
  if (allCues.length === 0) {
    return {
      selected: [],
      isFullVideo: true,
      rangeStartMs: 0,
      rangeEndMs: Math.max(0, videoDurationMs),
    };
  }

  let selected: MergedDubCue[];
  if (selection.mode === 'all') {
    selected = [...allCues];
  } else if (selection.mode === 'range') {
    const startIdx = Math.max(1, Math.min(allCues.length, selection.start_idx));
    const endIdx = Math.max(startIdx, Math.min(allCues.length, selection.end_idx));
    selected = allCues.slice(startIdx - 1, endIdx);
  } else {
    const count = Math.max(1, Math.min(allCues.length, selection.count));
    selected = allCues.slice(0, count);
  }

  const isFullVideo = selected.length === allCues.length;
  if (isFullVideo) {
    return {
      selected,
      isFullVideo: true,
      rangeStartMs: 0,
      rangeEndMs: Math.max(0, videoDurationMs),
    };
  }

  const first = selected[0];
  const last = selected[selected.length - 1];
  const keepFromZero =
    mode === 'recap' && (selection.mode === 'first_n' || selection.start_idx <= 1);
  const rangeStartMs = keepFromZero ? 0 : Math.max(0, first.start_ms - 400);
  const rangeEndMs = Math.min(Math.max(last.end_ms, videoDurationMs), last.end_ms + 600);

  return {
    selected,
    isFullVideo: false,
    rangeStartMs,
    rangeEndMs: Math.max(rangeStartMs + 500, rangeEndMs),
  };
}
