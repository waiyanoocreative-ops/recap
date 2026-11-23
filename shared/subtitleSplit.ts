export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SplitSubtitleOptions {
  lang?: 'my-MM' | 'en-US' | 'auto';
  maxCueChars?: number;
  maxLineChars?: number;
  maxWordsPerCue?: number;
}

interface TextToken {
  text: string;
  joinWithSpaceBefore: boolean;
  isSentenceEnd: boolean;
  isPunctBreak: boolean;
  isClauseStart: boolean;
}

const MYANMAR_CHAR_REGEX = /[\u1000-\u109F]/;
const SENTENCE_END_REGEX = /[။.!?…]["'”’)\]]*$/;
const CLAUSE_PUNCT_REGEX = /[၊,;:—–\-]["'”’)\]]*$/;
const TRAILING_PUNCT_ONLY_REGEX = /^[။၊.,!?;:…—–\-'"”’)\]]+$/;
const EN_CLAUSE_START_REGEX =
  /^(because|and|so|but|or|then|when|while|if|although|though|since|that|which|who|where|until|unless)\b/i;
const MY_CLAUSE_START_REGEX =
  /^(ဒါပေမဲ့|ဒါကြောင့်|ဘာလို့လဲဆိုတော့|ဘာဖြစ်လို့လဲဆိုတော့|ပြီးတော့|အဲဒီနောက်|သို့သော်|ဒါ့အပြင်)/;

const MYANMAR_SYLLABLE_FALLBACK_REGEX =
  /[\u1000-\u102A\u103F\u1040-\u104F](?:[\u102B-\u103E\u1050-\u109F]|[\u1039][\u1000-\u1021])*|[A-Za-z0-9]+(?:'[A-Za-z]+)?|[^\s]/g;

/**
 * WYSIWYG line-length targets: every rendered line aims for ~20 characters (Burmese syllable
 * clusters and Latin words alike), with 40-char cue ceilings so a cue never exceeds 2 lines.
 * A minimum-fragment floor prevents the old splitter from producing tiny 2-4 char orphan lines.
 */
const TARGET_LINE_CHARS = 20;
const TARGET_CUE_CHARS = 40;
const MIN_FRAGMENT_CHARS = 8;

type IntlSegmenterCtor = new (
  locale?: string,
  options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
) => {
  segment(input: string): Iterable<{ segment: string }>;
};

let cachedMyanmarWordSegmenter: InstanceType<IntlSegmenterCtor> | null | undefined;

function getMyanmarWordSegmenter(): InstanceType<IntlSegmenterCtor> | null {
  if (cachedMyanmarWordSegmenter !== undefined) {
    return cachedMyanmarWordSegmenter;
  }
  try {
    const Seg = (Intl as unknown as { Segmenter?: IntlSegmenterCtor }).Segmenter;
    cachedMyanmarWordSegmenter = Seg ? new Seg('my', { granularity: 'word' }) : null;
  } catch {
    cachedMyanmarWordSegmenter = null;
  }
  return cachedMyanmarWordSegmenter;
}

function segmentMyanmarRun(run: string): string[] {
  const seg = getMyanmarWordSegmenter();
  if (seg) {
    const parts: string[] = [];
    for (const item of seg.segment(run)) {
      if (item.segment) parts.push(item.segment);
    }
    if (parts.length > 0) return parts;
  }
  return run.match(MYANMAR_SYLLABLE_FALLBACK_REGEX) ?? [run];
}

function tokenizeSubtitleText(rawText: string, isBurmese: boolean): TextToken[] {
  const normalized = rawText.replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const tokens: TextToken[] = [];

  if (!isBurmese) {
    const words = normalized.split(' ').filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      tokens.push({
        text: w,
        joinWithSpaceBefore: i > 0,
        isSentenceEnd: SENTENCE_END_REGEX.test(w),
        isPunctBreak: CLAUSE_PUNCT_REGEX.test(w),
        isClauseStart: EN_CLAUSE_START_REGEX.test(w),
      });
    }
    return tokens;
  }

  const spaceGroups = normalized.split(' ').filter(Boolean);
  for (let gIdx = 0; gIdx < spaceGroups.length; gIdx++) {
    const group = spaceGroups[gIdx];
    const pieces = segmentMyanmarRun(group);
    for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
      const piece = pieces[pIdx];
      if (!piece) continue;

      if (TRAILING_PUNCT_ONLY_REGEX.test(piece) && tokens.length > 0) {
        const prev = tokens[tokens.length - 1];
        prev.text += piece;
        prev.isSentenceEnd = SENTENCE_END_REGEX.test(prev.text);
        prev.isPunctBreak = CLAUSE_PUNCT_REGEX.test(prev.text);
        continue;
      }

      tokens.push({
        text: piece,
        joinWithSpaceBefore: gIdx > 0 && pIdx === 0 && tokens.length > 0,
        isSentenceEnd: SENTENCE_END_REGEX.test(piece),
        isPunctBreak: CLAUSE_PUNCT_REGEX.test(piece),
        isClauseStart: MY_CLAUSE_START_REGEX.test(piece) || EN_CLAUSE_START_REGEX.test(piece),
      });
    }
  }

  return tokens;
}

function joinTokens(tokens: TextToken[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i > 0 && tok.joinWithSpaceBefore) {
      out += ' ';
    }
    out += tok.text;
  }
  return out.trim();
}

function measureTokensSlice(tokens: TextToken[], start: number, end: number): number {
  let len = 0;
  for (let i = start; i <= end; i++) {
    if (i > start && tokens[i].joinWithSpaceBefore) len += 1;
    len += tokens[i].text.length;
  }
  return len;
}

function formatTwoShortLines(tokens: TextToken[], maxLineChars: number): string {
  const full = joinTokens(tokens);
  if (full.length <= maxLineChars || tokens.length <= 1) {
    return full;
  }

  let bestIdx = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < tokens.length - 1; i++) {
    const leftLen = measureTokensSlice(tokens, 0, i);
    const rightLen = measureTokensSlice(tokens, i + 1, tokens.length - 1);
    const overflowPenalty =
      Math.max(0, leftLen - maxLineChars) * 6 + Math.max(0, rightLen - maxLineChars) * 6;
    const balancePenalty = Math.abs(leftLen - rightLen) * 1.4;
    let boundaryBonus = 0;
    if (tokens[i].isSentenceEnd) boundaryBonus += 40;
    else if (tokens[i].isPunctBreak) boundaryBonus += 28;
    if (tokens[i + 1]?.isClauseStart) boundaryBonus += 18;
    if (tokens[i + 1]?.joinWithSpaceBefore) boundaryBonus += 24;
    // Discourage overly short fragments (tiny orphan lines) on either side of the break.
    const tinyPenalty = leftLen < MIN_FRAGMENT_CHARS || rightLen < MIN_FRAGMENT_CHARS ? 25 : 0;

    const score = boundaryBonus - overflowPenalty - balancePenalty - tinyPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) return full;
  const line1 = joinTokens(tokens.slice(0, bestIdx + 1));
  const line2 = joinTokens(tokens.slice(bestIdx + 1));
  if (!line2) return line1;
  return `${line1}\n${line2}`;
}

function normalizeCueTextForSplit(rawText: string): string {
  return rawText
    .replace(/([\u1000-\u109F])[ \t]*\r?\n+[ \t]*([\u1000-\u109F])/g, '$1$2')
    .replace(/\s*\r?\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a single subtitle cue into short 1-2 line sub-cues targeting ~20 chars/line
 * (single language only: Myanmar OR English) with proportional timestamps.
 */
export function splitSubtitleCue(
  cue: SubtitleCue,
  options?: SplitSubtitleOptions,
): SubtitleCue[] {
  const cleaned = normalizeCueTextForSplit(cue.text);
  if (!cleaned) return [];

  const startMs = Math.max(0, Math.round(cue.startMs));
  const endMs = Math.max(startMs + 200, Math.round(cue.endMs));

  const isBurmese =
    options?.lang === 'my-MM' ||
    (options?.lang !== 'en-US' && MYANMAR_CHAR_REGEX.test(cleaned));

  const maxCueChars = options?.maxCueChars ?? TARGET_CUE_CHARS;
  const maxLineChars = options?.maxLineChars ?? TARGET_LINE_CHARS;
  const maxWordsPerCue = options?.maxWordsPerCue ?? (isBurmese ? 14 : 7);

  const tokens = tokenizeSubtitleText(cleaned, isBurmese);
  if (tokens.length === 0) return [];

  const fitsSingleCue =
    cleaned.length <= maxCueChars && (isBurmese || tokens.length <= maxWordsPerCue);

  if (fitsSingleCue) {
    return [
      {
        startMs,
        endMs,
        text: formatTwoShortLines(tokens, maxLineChars),
      },
    ];
  }

  const subTokenGroups: TextToken[][] = [];
  let cursor = 0;

  while (cursor < tokens.length) {
    let maxEnd = cursor;
    let curLen = 0;

    for (let i = cursor; i < tokens.length; i++) {
      const addLen = (i > cursor && tokens[i].joinWithSpaceBefore ? 1 : 0) + tokens[i].text.length;
      const wordCount = i - cursor + 1;
      if (i > cursor && (curLen + addLen > maxCueChars || (!isBurmese && wordCount > maxWordsPerCue))) {
        break;
      }
      curLen += addLen;
      maxEnd = i;
    }

    if (maxEnd >= tokens.length - 1) {
      subTokenGroups.push(tokens.slice(cursor));
      break;
    }

    const remainingTotalLen = measureTokensSlice(tokens, cursor, tokens.length - 1);
    const approxChunks = Math.max(2, Math.ceil(remainingTotalLen / Math.max(12, maxCueChars * 0.78)));
    const targetLen = Math.min(maxCueChars, remainingTotalLen / approxChunks);

    let bestSplit = maxEnd;
    let bestScore = -Infinity;

    for (let k = cursor; k <= maxEnd; k++) {
      const prefixLen = measureTokensSlice(tokens, cursor, k);
      const suffixLen = measureTokensSlice(tokens, k + 1, tokens.length - 1);
      const suffixCount = tokens.length - 1 - k;

      let score = -Math.abs(prefixLen - targetLen) * 1.4;

      if (tokens[k].isSentenceEnd) score += 140;
      else if (tokens[k].isPunctBreak) score += 100;

      if (tokens[k + 1]?.isClauseStart) score += 75;
      if (isBurmese && tokens[k + 1]?.joinWithSpaceBefore) score += 48;

      if (prefixLen < Math.max(MIN_FRAGMENT_CHARS, Math.floor(maxCueChars * 0.28)) && !tokens[k].isSentenceEnd && !tokens[k].isPunctBreak) {
        score -= 45;
      }

      if (suffixLen > 0 && (suffixLen < MIN_FRAGMENT_CHARS || (!isBurmese && suffixCount === 1))) {
        score -= 70;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSplit = k;
      }
    }

    subTokenGroups.push(tokens.slice(cursor, bestSplit + 1));
    cursor = bestSplit + 1;
  }

  const subTexts = subTokenGroups
    .map((group) => formatTwoShortLines(group, maxLineChars))
    .filter((t) => t.trim().length > 0);

  if (subTexts.length <= 1) {
    return [
      {
        startMs,
        endMs,
        text: subTexts[0] ?? cleaned,
      },
    ];
  }

  const totalDur = Math.max(endMs - startMs, subTexts.length * 120);
  const weights = subTexts.map((t) => Math.max(1, t.replace(/\s+/g, '').length));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  const minCueMs = Math.min(180, Math.floor(totalDur / subTexts.length));

  const out: SubtitleCue[] = [];
  let prevEnd = startMs;
  let cumWeight = 0;

  for (let i = 0; i < subTexts.length; i++) {
    cumWeight += weights[i];
    const subStart = prevEnd;
    let subEnd: number;
    if (i === subTexts.length - 1) {
      subEnd = Math.max(subStart + minCueMs, startMs + totalDur);
    } else {
      const remainingMin = (subTexts.length - 1 - i) * minCueMs;
      const proportionalEnd = Math.round(startMs + (totalDur * cumWeight) / totalWeight);
      subEnd = Math.max(
        subStart + minCueMs,
        Math.min(startMs + totalDur - remainingMin, proportionalEnd),
      );
    }
    out.push({
      startMs: subStart,
      endMs: subEnd,
      text: subTexts[i],
    });
    prevEnd = subEnd;
  }

  return out;
}

export function splitSubtitleCues(
  cues: SubtitleCue[],
  options?: SplitSubtitleOptions,
): SubtitleCue[] {
  const result: SubtitleCue[] = [];
  for (const cue of cues) {
    result.push(...splitSubtitleCue(cue, options));
  }
  return result;
}

export function formatSrtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600_000);
  const m = Math.floor((clamped % 3600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const remMs = clamped % 1000;
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},${String(remMs).padStart(3, '0')}`
  );
}

export function parseSrtTimestampToMs(ts: string): number {
  const m = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(ts.trim());
  if (!m) return 0;
  return (
    Number(m[1]) * 3600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4])
  );
}

export function splitSrtDocument(
  rawSrt: string,
  options?: SplitSubtitleOptions,
): string {
  const blocks = rawSrt.split(/\r?\n\r?\n+/).filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return rawSrt;

  const rawCues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const tsLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsLineIdx === -1) continue;
    const [startStr, endStr] = lines[tsLineIdx].split('-->').map((s) => s.trim());
    const startMs = parseSrtTimestampToMs(startStr);
    const endMs = Math.max(startMs + 200, parseSrtTimestampToMs(endStr));
    const body = normalizeCueTextForSplit(lines.slice(tsLineIdx + 1).join('\n'));
    if (!body) continue;
    rawCues.push({ startMs, endMs, text: body });
  }

  const splitCues = splitSubtitleCues(rawCues, options);
  return splitCues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');
}
