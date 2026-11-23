import type { SpeechSegment, TargetLang, VoicePoolsConfig } from './projectTypes.ts';

export interface SentenceUnitCue {
  id: number;
  start_ms: number;
  end_ms: number;
  speaker: string;
  src_lang: string;
  text: string;
  merged_ids: number[];
}

const SENTENCE_END_REGEX = /[。！？.!?…။]["'”’)\]]*$/;
const CJK_TAIL_OR_HEAD_REGEX = /[\u3000-\u9FFF\uAC00-\uD7AF\u1000-\u109F]$/;
const CJK_START_REGEX = /^[\u3000-\u9FFF\uAC00-\uD7AF\u1000-\u109F]/;

function joinFragmentTexts(left: string, right: string): string {
  const a = left.trim();
  const b = right.trim();
  if (!a) return b;
  if (!b) return a;
  if (CJK_TAIL_OR_HEAD_REGEX.test(a) || CJK_START_REGEX.test(b)) {
    return `${a}${b}`;
  }
  return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}

/**
 * Fix 3: Groups consecutive same-speaker fragments into short sentence units
 * until a sentence-ending mark (。！？.!?…။) OR a pause >= 400 ms, strictly capped at 8 s (8000 ms).
 */
export function mergeSentenceUnits(speechSegments: SpeechSegment[]): SentenceUnitCue[] {
  const sorted = [...speechSegments]
    .filter((s) => s.text.trim().length > 0 && s.end_ms > s.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms);

  if (sorted.length === 0) return [];

  const units: SentenceUnitCue[] = [];
  let cur: SentenceUnitCue = {
    id: 1,
    start_ms: sorted[0].start_ms,
    end_ms: sorted[0].end_ms,
    speaker: sorted[0].speaker,
    src_lang: sorted[0].src_lang,
    text: sorted[0].text.trim(),
    merged_ids: [sorted[0].id],
  };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const pauseMs = next.start_ms - cur.end_ms;
    const combinedDurationMs = Math.max(cur.end_ms, next.end_ms) - cur.start_ms;
    const sameSpeaker = next.speaker === cur.speaker;
    const hasSentenceEnd = SENTENCE_END_REGEX.test(cur.text);

    if (sameSpeaker && !hasSentenceEnd && pauseMs < 400 && combinedDurationMs <= 8000) {
      cur = {
        ...cur,
        end_ms: Math.max(cur.end_ms, next.end_ms),
        text: joinFragmentTexts(cur.text, next.text),
        merged_ids: [...cur.merged_ids, next.id],
      };
    } else {
      units.push(cur);
      cur = {
        id: units.length + 1,
        start_ms: next.start_ms,
        end_ms: next.end_ms,
        speaker: next.speaker,
        src_lang: next.src_lang,
        text: next.text.trim(),
        merged_ids: [next.id],
      };
    }
  }
  units.push(cur);

  return units.map((u, idx) => ({
    ...u,
    id: idx + 1,
  }));
}

export interface TranslationValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Fix 1c: Validates that translated dialogue is grammatically closed and not truncated.
 * - Burmese (my-MM): must end with ။
 * - English (en-US): must end with . (or ?/!)
 * - Must not be suspiciously short compared to source text.
 */
export function validateTranslationCompleteness(
  srcText: string,
  tgtText: string,
  targetLang: TargetLang,
): TranslationValidationResult {
  const src = srcText.trim();
  const tgt = tgtText.trim();
  if (!tgt) {
    return { valid: false, reason: 'Empty translation.' };
  }

  if (targetLang === 'my-MM') {
    if (!/[။]["'”’)\]]*$/.test(tgt)) {
      return {
        valid: false,
        reason: 'Burmese sentence missing ending punctuation (။).',
      };
    }
  } else {
    if (!/[.!?]["'”’)\]]*$/.test(tgt)) {
      return {
        valid: false,
        reason: 'English sentence missing terminal period/punctuation (.).',
      };
    }
  }

  // Suspiciously short ratio check (calibrated to avoid false-positives on brief interjections)
  const srcCjkCount = (src.match(/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) ?? []).length;
  const srcLatinWords = src
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

  if (targetLang === 'my-MM') {
    const myCharCount = (tgt.match(/[\u1000-\u109F]/g) ?? []).length;
    if (srcCjkCount >= 10 && myCharCount < Math.max(8, Math.floor(srcCjkCount * 0.8))) {
      return {
        valid: false,
        reason: `Translation appears incomplete/short (${myCharCount} Myanmar chars for ${srcCjkCount} source CJK chars).`,
      };
    }
    if (srcCjkCount < 4 && srcLatinWords >= 7 && myCharCount < Math.max(8, Math.floor(srcLatinWords * 1.1))) {
      return {
        valid: false,
        reason: `Translation appears incomplete/short (${myCharCount} Myanmar chars for ${srcLatinWords} source words).`,
      };
    }
  } else {
    const enWordCount = tgt
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean).length;
    if (srcCjkCount >= 10 && enWordCount < Math.max(4, Math.floor(srcCjkCount * 0.35))) {
      return {
        valid: false,
        reason: `Translation appears incomplete/short (${enWordCount} English words for ${srcCjkCount} source CJK chars).`,
      };
    }
    if (srcCjkCount < 4 && srcLatinWords >= 7 && enWordCount < Math.max(4, Math.floor(srcLatinWords * 0.4))) {
      return {
        valid: false,
        reason: `Translation appears incomplete/short (${enWordCount} English words for ${srcLatinWords} source words).`,
      };
    }
  }

  return { valid: true };
}

export const GEMINI_VOICE_GENDER_MAP: Record<string, 'female' | 'male'> = {
  Zephyr: 'female',
  Puck: 'male',
  Charon: 'male',
  Kore: 'female',
  Fenrir: 'male',
  Leda: 'female',
  Orus: 'male',
  Aoede: 'female',
  Callirrhoe: 'female',
  Autonoe: 'female',
  Enceladus: 'male',
  Iapetus: 'male',
  Umbriel: 'male',
  Algieba: 'male',
  Despina: 'female',
  Erinome: 'female',
  Algenib: 'male',
  Rasalgethi: 'male',
  Laomedeia: 'female',
  Achernar: 'female',
  Alnilam: 'male',
  Schedar: 'male',
  Gacrux: 'female',
  Pulcherrima: 'female',
  Achird: 'male',
  Zubenelgenubi: 'male',
  Vindemiatrix: 'female',
  Sadachbia: 'male',
  Sadaltager: 'male',
  Sulafat: 'female',
};

export const KNOWN_EDGE_VOICE_GENDER_MAP: Record<string, 'female' | 'male'> = {
  'my-MM-NilarNeural': 'female',
  'my-MM-ThihaNeural': 'male',
  'en-US-JennyNeural': 'female',
  'en-US-AriaNeural': 'female',
  'en-US-AvaNeural': 'female',
  'en-US-EmmaNeural': 'female',
  'en-US-AnaNeural': 'female',
  'en-US-MichelleNeural': 'female',
  'en-US-MonicaNeural': 'female',
  'en-US-GuyNeural': 'male',
  'en-US-AndrewNeural': 'male',
  'en-US-AndrewMultilingualNeural': 'male',
  'en-US-BrianNeural': 'male',
  'en-US-ChristopherNeural': 'male',
  'en-US-DavisNeural': 'male',
  'en-US-EricNeural': 'male',
  'en-US-RogerNeural': 'male',
  'en-US-SteffanNeural': 'male',
  'en-US-TonyNeural': 'male',
};

export function getVoiceGender(
  voiceName: string | undefined,
  engine: 'edge' | 'gemini',
  edgeCatalog?: Array<{ name: string; gender: 'female' | 'male' }>,
  voicePools?: VoicePoolsConfig,
  targetLang?: TargetLang,
): 'female' | 'male' | null {
  if (!voiceName) return null;
  if (engine === 'gemini') {
    const known = GEMINI_VOICE_GENDER_MAP[voiceName];
    if (known) return known;
    if (voicePools && targetLang) {
      const pool = voicePools.gemini?.[targetLang];
      if (pool?.female?.includes(voiceName)) return 'female';
      if (pool?.male?.includes(voiceName)) return 'male';
    }
    return null;
  }
  const fromCatalog = edgeCatalog?.find((v) => v.name === voiceName);
  if (fromCatalog) return fromCatalog.gender;
  const knownEdge = KNOWN_EDGE_VOICE_GENDER_MAP[voiceName];
  if (knownEdge) return knownEdge;
  if (voicePools && targetLang) {
    const pool = voicePools.edge?.[targetLang];
    if (pool?.female?.includes(voiceName)) return 'female';
    if (pool?.male?.includes(voiceName)) return 'male';
  }
  return null;
}

export function defaultVoiceForGender(
  engine: 'edge' | 'gemini',
  targetLang: TargetLang,
  gender: 'male' | 'female' | 'unknown',
): string {
  const effectiveGender = gender === 'male' ? 'male' : 'female';
  if (engine === 'edge') {
    if (targetLang === 'my-MM') {
      return effectiveGender === 'male' ? 'my-MM-ThihaNeural' : 'my-MM-NilarNeural';
    }
    return effectiveGender === 'male' ? 'en-US-GuyNeural' : 'en-US-JennyNeural';
  }
  return effectiveGender === 'male' ? 'Charon' : 'Kore';
}

export function voiceMatchesEngineAndLang(
  voiceName: string | undefined,
  engine: 'edge' | 'gemini',
  targetLang: TargetLang,
): boolean {
  const clean = voiceName?.trim();
  if (!clean) return false;
  if (engine === 'edge') {
    if (!clean.includes('-')) return false;
    if (targetLang === 'my-MM') return /^my-MM-/i.test(clean);
    if (targetLang === 'en-US') return /^en-/i.test(clean);
    return true;
  }
  return !clean.includes('-');
}

export function resolveStrictVoiceForSpeaker(params: {
  engine: 'edge' | 'gemini';
  targetLang: TargetLang;
  speakerGender: 'male' | 'female' | 'unknown';
  voiceOverridden?: boolean;
  speakerVoice?: { engine: 'edge' | 'gemini'; name: string };
  candidateVoice?: string;
  edgeCatalog?: Array<{ name: string; gender: 'female' | 'male' }>;
  voicePools?: VoicePoolsConfig;
}): string {
  const {
    engine,
    targetLang,
    speakerGender,
    voiceOverridden,
    speakerVoice,
    candidateVoice,
    edgeCatalog,
    voicePools,
  } = params;

  if (
    voiceOverridden &&
    speakerVoice?.engine === engine &&
    voiceMatchesEngineAndLang(speakerVoice.name, engine, targetLang)
  ) {
    return speakerVoice.name;
  }

  const candidates = [
    candidateVoice,
    speakerVoice?.engine === engine ? speakerVoice.name : undefined,
  ].filter((v): v is string => Boolean(v && v.trim()));

  for (const cand of candidates) {
    if (!voiceMatchesEngineAndLang(cand, engine, targetLang)) continue;
    if (speakerGender === 'male' || speakerGender === 'female') {
      const vg = getVoiceGender(cand, engine, edgeCatalog, voicePools, targetLang);
      if (vg !== speakerGender) continue;
    }
    return cand;
  }

  const effectiveGender = speakerGender === 'male' ? 'male' : 'female';
  const configuredPool = voicePools?.[engine]?.[targetLang]?.[effectiveGender] ?? [];
  for (const pooled of configuredPool) {
    if (!voiceMatchesEngineAndLang(pooled, engine, targetLang)) continue;
    const vg = getVoiceGender(pooled, engine, edgeCatalog, voicePools, targetLang);
    if (vg === null || vg === effectiveGender) {
      return pooled;
    }
  }

  return defaultVoiceForGender(engine, targetLang, speakerGender);
}

export function isDualSubtitleMode(targetLangs: TargetLang[]): boolean {
  return targetLangs.includes('my-MM') && targetLangs.includes('en-US');
}

