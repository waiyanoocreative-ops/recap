import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  GenderSchema,
  type Gender,
  type Project,
  type SpeakerInfo,
  type SpeechSegment,
} from '../../shared/projectTypes.ts';
import { getConfig, getGroqApiKey } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { resolveSpeakerVoicesForEngine } from '../dub/translate.ts';
import { requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import { hashString, readProjectCache, writeProjectCache } from './cache.ts';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PITCH_MALE_FEMALE_THRESHOLD_HZ = 170;
const GROQ_BATCH_SIZE = 60;

const GroqSegmentAssignSchema = z.object({
  id: z.coerce.number().int(),
  speaker: z.string().min(1),
  gender: GenderSchema.optional().default('unknown'),
});

const GroqDiarizeResponseSchema = z.object({
  segments: z.array(GroqSegmentAssignSchema),
});

interface WavHeaderInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
}

interface SegmentPitchInfo {
  pitchHz: number | null;
}

interface KnownSpeakerSummary {
  speaker: string;
  gender: Gender;
  medianPitchHz: number | null;
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function pitchToGender(pitchHz: number | null): Gender {
  if (pitchHz === null || !Number.isFinite(pitchHz) || pitchHz <= 0) return 'unknown';
  return pitchHz < PITCH_MALE_FEMALE_THRESHOLD_HZ ? 'male' : 'female';
}

function medianOfSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const val =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(val * 10) / 10;
}

function parseWavHeaderFromBuffer(buf: Buffer): WavHeaderInfo | null {
  if (buf.length < 44 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    return null;
  }
  let dataOffset = 44;
  let dataBytes = buf.length - 44;
  let sampleRate = 16000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii');
    const sz = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= buf.length) {
      numChannels = Math.max(1, buf.readUInt16LE(offset + 10));
      sampleRate = buf.readUInt32LE(offset + 12) || 16000;
      bitsPerSample = buf.readUInt16LE(offset + 22) || 16;
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataBytes = sz;
      break;
    }
    offset += 8 + sz + (sz % 2);
  }

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    dataOffset,
    dataBytes,
  };
}

/**
 * YIN CMNDF pitch estimator (75Hz - 330Hz) on mono/stereo PCM16 samples.
 * Returns median fundamental frequency f0 in Hz, or null when unvoiced / too short.
 */
function estimatePcm16MedianF0Hz(
  pcmBuf: Buffer,
  sampleRate: number,
  numChannels: number,
  minVoicedFrames = 3,
): number | null {
  const bytesPerFrame = 2 * Math.max(1, numChannels);
  const totalSamples = Math.floor(pcmBuf.length / bytesPerFrame);
  if (totalSamples < Math.floor(sampleRate * 0.12)) return null;

  const samples = new Float32Array(totalSamples);
  if (numChannels === 1) {
    for (let i = 0; i < totalSamples; i++) {
      samples[i] = pcmBuf.readInt16LE(i * 2) / 32768;
    }
  } else {
    for (let i = 0; i < totalSamples; i++) {
      let sum = 0;
      const base = i * bytesPerFrame;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += pcmBuf.readInt16LE(base + ch * 2) / 32768;
      }
      samples[i] = sum / numChannels;
    }
  }

  const frameLen = Math.floor(sampleRate * 0.04); // 40ms frame
  const hopLen = Math.floor(sampleRate * 0.015); // 15ms hop
  const minLag = Math.max(10, Math.floor(sampleRate / 320)); // ~320Hz
  const maxLag = Math.min(Math.floor(frameLen * 0.45), Math.floor(sampleRate / 80)); // ~80Hz
  const winLen = frameLen - maxLag;
  if (winLen < 32 || maxLag <= minLag || totalSamples <= frameLen) return null;

  const diff = new Float64Array(maxLag + 1);
  const cmndf = new Float64Array(maxLag + 1);
  const f0List: number[] = [];

  const maxFramesToScan = Math.min(
    700,
    Math.floor((totalSamples - frameLen) / Math.max(1, hopLen)),
  );

  for (let f = 0; f < maxFramesToScan; f++) {
    const start = f * hopLen;
    let energy = 0;
    for (let i = 0; i < frameLen; i++) {
      const s = samples[start + i];
      energy += s * s;
    }
    const rms = Math.sqrt(energy / frameLen);
    if (rms < 0.012) continue;

    diff.fill(0);
    cmndf[0] = 1;
    let runningSum = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sqSum = 0;
      for (let i = 0; i < winLen; i++) {
        const d = samples[start + i] - samples[start + i + lag];
        sqSum += d * d;
      }
      diff[lag] = sqSum;
      runningSum += sqSum;
      cmndf[lag] = runningSum > 1e-9 ? (sqSum * lag) / runningSum : 1;
    }

    // YIN first-valley threshold avoids subharmonic / octave-halving errors (2*T0)
    let bestLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmndf[lag] < 0.2) {
        while (lag + 1 <= maxLag && cmndf[lag + 1] < cmndf[lag]) {
          lag += 1;
        }
        bestLag = lag;
        break;
      }
    }

    if (bestLag < 0) {
      let minVal = 1;
      let minIdx = -1;
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (cmndf[lag] < minVal) {
          minVal = cmndf[lag];
          minIdx = lag;
        }
      }
      if (minIdx > 0 && minVal < 0.35) {
        bestLag = minIdx;
      }
    }

    if (bestLag > 0) {
      let refinedLag = bestLag;
      if (bestLag > minLag && bestLag < maxLag) {
        const s0 = cmndf[bestLag - 1];
        const s1 = cmndf[bestLag];
        const s2 = cmndf[bestLag + 1];
        const denom = 2 * (2 * s1 - s2 - s0);
        if (Math.abs(denom) > 1e-9) {
          const delta = (s0 - s2) / denom;
          if (Math.abs(delta) < 1) {
            refinedLag = bestLag + delta;
          }
        }
      }
      const f0 = sampleRate / refinedLag;
      if (f0 >= 75 && f0 <= 330) {
        f0List.push(f0);
      }
    }
  }

  if (f0List.length < minVoicedFrames) return null;
  f0List.sort((a, b) => a - b);
  return medianOfSorted(f0List);
}

/**
 * YIN CMNDF pitch estimator (75Hz - 330Hz) on a standalone 16kHz PCM WAV file.
 */
async function estimateWavMedianF0Hz(wavPath: string): Promise<number | null> {
  try {
    const buf = await fs.readFile(wavPath);
    const header = parseWavHeaderFromBuffer(buf);
    if (!header || header.bitsPerSample !== 16) return null;
    const pcmEnd = Math.min(buf.length, header.dataOffset + header.dataBytes);
    if (pcmEnd <= header.dataOffset) return null;
    return estimatePcm16MedianF0Hz(
      buf.subarray(header.dataOffset, pcmEnd),
      header.sampleRate,
      header.numChannels,
      3,
    );
  } catch {
    return null;
  }
}

/**
 * Computes fundamental frequency f0 (Hz) for every speech segment directly from
 * `audio_16k.wav` in a single file handle without spawning FFmpeg per segment.
 */
async function measureSegmentPitchesHz(
  audio16kPath: string,
  segments: SpeechSegment[],
): Promise<Map<number, SegmentPitchInfo>> {
  const result = new Map<number, SegmentPitchInfo>();
  for (const s of segments) {
    result.set(s.id, { pitchHz: null });
  }
  if (segments.length === 0) return result;

  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(audio16kPath, 'r');
    const stat = await fh.stat();
    const headerBuf = Buffer.alloc(Math.min(4096, stat.size));
    await fh.read(headerBuf, 0, headerBuf.length, 0);
    const header = parseWavHeaderFromBuffer(headerBuf);
    if (!header || header.bitsPerSample !== 16) return result;

    const bytesPerFrame = 2 * Math.max(1, header.numChannels);
    const maxDataBytes = Math.max(0, Math.min(header.dataBytes, stat.size - header.dataOffset));

    for (const seg of segments) {
      const startFrame = Math.max(0, Math.floor((seg.start_ms / 1000) * header.sampleRate));
      // Cap single-segment scan at 10s for fast DSP on long monologues
      const cappedEndMs = Math.min(seg.end_ms, seg.start_ms + 10_000);
      const endFrame = Math.max(startFrame, Math.ceil((cappedEndMs / 1000) * header.sampleRate));

      const byteStart = startFrame * bytesPerFrame;
      const byteEnd = Math.min(maxDataBytes, endFrame * bytesPerFrame);
      const byteLen = byteEnd - byteStart;
      if (byteLen < Math.floor(header.sampleRate * 0.12) * bytesPerFrame) {
        continue;
      }

      const sliceBuf = Buffer.alloc(byteLen);
      const { bytesRead } = await fh.read(sliceBuf, 0, byteLen, header.dataOffset + byteStart);
      if (bytesRead <= 0) continue;

      const f0 = estimatePcm16MedianF0Hz(
        sliceBuf.subarray(0, bytesRead),
        header.sampleRate,
        header.numChannels,
        2,
      );
      result.set(seg.id, { pitchHz: f0 });
    }
  } catch (err) {
    console.warn(
      '[S2 Pitch] Failed to read segment pitch from audio_16k.wav:',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (fh) {
      await fh.close().catch(() => {});
    }
  }

  return result;
}

async function extractConcatenatedSample(params: {
  ffmpeg: string;
  audio16kPath: string;
  segments: SpeechSegment[];
  outPath: string;
  targetMaxMs: number;
}): Promise<boolean> {
  const { ffmpeg, audio16kPath, segments, outPath, targetMaxMs } = params;
  const chosen: SpeechSegment[] = [];
  let accumulatedMs = 0;

  for (const s of segments) {
    const dur = Math.max(0, s.end_ms - s.start_ms);
    if (dur < 250) continue;
    chosen.push(s);
    accumulatedMs += dur;
    if (accumulatedMs >= targetMaxMs || chosen.length >= 12) {
      break;
    }
  }

  if (chosen.length === 0) return false;

  if (chosen.length === 1) {
    const seg = chosen[0];
    const startSec = (seg.start_ms / 1000).toFixed(3);
    const durSec = Math.min(
      targetMaxMs / 1000,
      Math.max(0.25, (seg.end_ms - seg.start_ms) / 1000),
    ).toFixed(3);
    const res = await spawnCommand(ffmpeg, [
      '-y',
      '-ss',
      startSec,
      '-t',
      durSec,
      '-i',
      audio16kPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outPath,
    ]);
    return res.code === 0;
  }

  const filterParts = chosen.map((s, idx) => {
    const startSec = (s.start_ms / 1000).toFixed(3);
    const endSec = (s.end_ms / 1000).toFixed(3);
    return `[0:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[a${idx}]`;
  });
  const concatInputs = chosen.map((_, idx) => `[a${idx}]`).join('');
  const filterComplex = `${filterParts.join(';')};${concatInputs}concat=n=${chosen.length}:v=0:a=1[outa]`;

  const res = await spawnCommand(ffmpeg, [
    '-y',
    '-i',
    audio16kPath,
    '-filter_complex',
    filterComplex,
    '-map',
    '[outa]',
    '-t',
    (targetMaxMs / 1000).toFixed(3),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outPath,
  ]);
  return res.code === 0;
}

interface GroqBatchCallOutcome {
  assignments: z.infer<typeof GroqSegmentAssignSchema>[] | null;
  modelUsed: string | null;
  fallbackReason: string | null;
}

function parseGroqPayload(rawContent: string): z.infer<typeof GroqDiarizeResponseSchema> {
  const cleaned = stripJsonFences(rawContent);
  const rawObj = JSON.parse(cleaned) as Record<string, unknown>;
  if (Array.isArray(rawObj)) {
    return GroqDiarizeResponseSchema.parse({ segments: rawObj });
  }
  if (!Array.isArray(rawObj.segments)) {
    if (Array.isArray(rawObj.items)) {
      return GroqDiarizeResponseSchema.parse({ segments: rawObj.items });
    }
    if (Array.isArray(rawObj.results)) {
      return GroqDiarizeResponseSchema.parse({ segments: rawObj.results });
    }
  }
  return GroqDiarizeResponseSchema.parse(rawObj);
}

async function callGroqDiarizeBatch(params: {
  projectId: string;
  batchIndex: number;
  totalBatches: number;
  batch: SpeechSegment[];
  pitchMap: Map<number, SegmentPitchInfo>;
  knownSpeakers: KnownSpeakerSummary[];
  force: boolean;
}): Promise<GroqBatchCallOutcome> {
  const { projectId, batchIndex, totalBatches, batch, pitchMap, knownSpeakers, force } = params;
  const groqKey = getGroqApiKey();
  if (!groqKey) {
    return {
      assignments: null,
      modelUsed: null,
      fallbackReason: 'GROQ_API_KEY not configured',
    };
  }

  const cfg = getConfig();
  const primaryModel = cfg.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
  const fallbackModels =
    cfg.GROQ_TEXT_FALLBACK_MODELS.length > 0
      ? cfg.GROQ_TEXT_FALLBACK_MODELS
      : ['openai/gpt-oss-20b'];
  const modelChain = Array.from(new Set([primaryModel, ...fallbackModels].filter(Boolean)));

  const segInputs = batch.map((s) => ({
    id: s.id,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    pitch_hz: pitchMap.get(s.id)?.pitchHz ?? null,
    text: s.text,
  }));

  const cacheHash = hashString(
    JSON.stringify({
      v: 's2-groq-pitch-v1',
      models: modelChain,
      knownSpeakers,
      segs: segInputs,
    }),
  );
  const cacheKey = `s2_groq_b${String(batchIndex).padStart(3, '0')}_${cacheHash}`;

  if (!force) {
    const cached = await readProjectCache(projectId, cacheKey, GroqDiarizeResponseSchema);
    if (cached && cached.segments.length > 0) {
      return {
        assignments: cached.segments,
        modelUsed: `${primaryModel} (groq-cached)`,
        fallbackReason: null,
      };
    }
  }

  const knownRosterLine =
    knownSpeakers.length > 0
      ? `Already established speakers in this video (REUSE these exact IDs whenever pitch & dialogue match): ${knownSpeakers
          .map(
            (k) =>
              `${k.speaker} (${k.gender}${k.medianPitchHz !== null ? `, ~${k.medianPitchHz} Hz` : ''})`,
          )
          .join('; ')}.`
      : 'No prior speakers established yet. Assign S1, S2, S3, ... in order of appearance.';

  const systemPrompt = [
    'You are an expert audio dialogue diarization and speaker gender classifier.',
    'Given ordered transcript lines with start_ms, end_ms, and measured acoustic fundamental frequency pitch_hz (f0 in Hz):',
    '1. Use pitch_hz as the PRIMARY gender anchor: adult male voices typically measure ~85-165 Hz (< 170 Hz), while adult female voices typically measure ~175-280 Hz (>= 170 Hz).',
    '2. Use dialogue context, conversational turn-taking, and pitch continuity across adjacent segments to assign consistent speaker labels (S1, S2, S3, ...).',
    '3. NEVER assign both clearly male-pitched lines (< 160 Hz) and clearly female-pitched lines (>= 180 Hz) to the same speaker label.',
    '4. Every segment MUST receive a non-empty speaker label (S1, S2, ...) and gender ("male" or "female"). If pitch_hz is null, infer from adjacent lines of the same speaker or dialogue context.',
    '5. Return valid JSON ONLY with shape: {"segments": [{"id": 1, "speaker": "S1", "gender": "female"}]}.',
  ].join('\n');

  const userPrompt = [
    `Batch ${batchIndex + 1}/${totalBatches}.`,
    knownRosterLine,
    `Segments: ${JSON.stringify(segInputs)}`,
    'Return JSON object with "segments" containing every input id.',
  ].join('\n\n');

  let lastErrorMsg = 'Groq request failed';

  for (const model of modelChain) {
    const maxTries = model === primaryModel ? 2 : 1;
    for (let attempt = 1; attempt <= maxTries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${groqKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: controller.signal,
        });

        const rawText = await res.text();
        if (res.status === 401 || res.status === 403) {
          return {
            assignments: null,
            modelUsed: null,
            fallbackReason: `Groq HTTP ${res.status} (auth/access denied)`,
          };
        }
        if (res.status === 429) {
          lastErrorMsg = `Groq HTTP 429 rate-limited on ${model}`;
          console.warn(`[S2 Groq] ${lastErrorMsg}; trying fallback...`);
          break; // Immediately move to fallback model on rate-limit
        }
        if (!res.ok) {
          lastErrorMsg = `Groq HTTP ${res.status} on ${model}: ${rawText.slice(0, 200)}`;
          if (res.status >= 500 && attempt < maxTries) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          break;
        }

        const payload = JSON.parse(rawText) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) {
          lastErrorMsg = `Groq model ${model} returned empty content`;
          break;
        }

        const parsed = parseGroqPayload(content);
        if (parsed.segments.length === 0) {
          lastErrorMsg = `Groq model ${model} returned 0 segments`;
          break;
        }

        await writeProjectCache(projectId, cacheKey, parsed);
        return {
          assignments: parsed.segments,
          modelUsed: model,
          fallbackReason: null,
        };
      } catch (err) {
        lastErrorMsg = err instanceof Error ? err.message : String(err);
        if (attempt < maxTries) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return {
    assignments: null,
    modelUsed: null,
    fallbackReason: lastErrorMsg,
  };
}

function sanitizeSpeakerLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'S1';
  const match = /^S(\d+)$/i.exec(trimmed);
  if (match) return `S${Number(match[1])}`;
  return trimmed.replace(/\s+/g, '_');
}

function nextUnusedSpeakerId(usedIds: Set<string>): string {
  let n = 1;
  while (usedIds.has(`S${n}`)) n += 1;
  const id = `S${n}`;
  usedIds.add(id);
  return id;
}

/**
 * Reconciles Groq assignments + acoustic pitch measurements (with deterministic pitch
 * fallback when Groq is unavailable/rate-limited), ensuring every speaker label has a
 * single consistent gender and matching canonical IDs across batches/chunks.
 */
function reconcileBatchWithPitch(params: {
  batch: SpeechSegment[];
  pitchMap: Map<number, SegmentPitchInfo>;
  groqAssignments: z.infer<typeof GroqSegmentAssignSchema>[] | null;
  knownSpeakers: KnownSpeakerSummary[];
}): {
  segments: Array<SpeechSegment & { _assignedGender: Gender }>;
} {
  const { batch, pitchMap, groqAssignments, knownSpeakers } = params;
  const assignById = new Map<number, { speaker: string; gender: Gender }>();
  if (groqAssignments) {
    for (const item of groqAssignments) {
      assignById.set(item.id, {
        speaker: sanitizeSpeakerLabel(item.speaker),
        gender: item.gender,
      });
    }
  }

  // Track which canonical IDs exist for male/female when deterministic fallback runs
  const knownMale = knownSpeakers.find((k) => k.gender === 'male')?.speaker;
  const knownFemale = knownSpeakers.find((k) => k.gender === 'female')?.speaker;
  const usedIds = new Set<string>(knownSpeakers.map((k) => k.speaker));

  const distinctRawSpeakers = new Set(batch.map((s) => s.speaker.trim() || 'S1'));
  const hasPreExistingMultiSpeaker = distinctRawSpeakers.size > 1;

  let fallbackMaleId = knownMale ?? null;
  let fallbackFemaleId = knownFemale ?? null;

  const preliminary: Array<SpeechSegment & { _assignedGender: Gender }> = [];
  let lastKnownGender: Gender = 'unknown';

  for (const seg of batch) {
    const pitchHz = pitchMap.get(seg.id)?.pitchHz ?? null;
    const pitchGender = pitchToGender(pitchHz);
    const groqHit = assignById.get(seg.id);

    let resolvedGender: Gender;
    let resolvedSpeaker: string;

    if (groqHit) {
      resolvedSpeaker = groqHit.speaker;
      resolvedGender = groqHit.gender;
      if (resolvedGender === 'unknown') {
        resolvedGender = pitchGender !== 'unknown' ? pitchGender : lastKnownGender;
      } else if (pitchHz !== null) {
        // Strong acoustic pitch overrides ambiguous/mismatched LLM guess
        if (pitchHz <= 145 && resolvedGender === 'female') {
          resolvedGender = 'male';
        } else if (pitchHz >= 188 && resolvedGender === 'male') {
          resolvedGender = 'female';
        }
      }
    } else {
      // Deterministic acoustic pitch fallback: pitchHz < 170 ? "male" : "female"
      resolvedGender = pitchGender !== 'unknown' ? pitchGender : lastKnownGender;
      if (hasPreExistingMultiSpeaker) {
        resolvedSpeaker = sanitizeSpeakerLabel(seg.speaker);
      } else if (resolvedGender === 'male') {
        if (!fallbackMaleId) fallbackMaleId = nextUnusedSpeakerId(usedIds);
        resolvedSpeaker = fallbackMaleId;
      } else if (resolvedGender === 'female') {
        if (!fallbackFemaleId) fallbackFemaleId = nextUnusedSpeakerId(usedIds);
        resolvedSpeaker = fallbackFemaleId;
      } else {
        resolvedSpeaker = knownSpeakers[0]?.speaker ?? (fallbackMaleId || fallbackFemaleId || 'S1');
        usedIds.add(resolvedSpeaker);
      }
    }

    if (resolvedGender === 'male' || resolvedGender === 'female') {
      lastKnownGender = resolvedGender;
    }

    preliminary.push({
      ...seg,
      speaker: resolvedSpeaker,
      _assignedGender: resolvedGender,
    });
  }

  // Enforce strict per-speaker gender purity (never mix male & female on one S# ID)
  const countsBySpeaker = new Map<string, { male: number; female: number }>();
  for (const s of preliminary) {
    const c = countsBySpeaker.get(s.speaker) ?? { male: 0, female: 0 };
    if (s._assignedGender === 'male') c.male += 1;
    else if (s._assignedGender === 'female') c.female += 1;
    countsBySpeaker.set(s.speaker, c);
    usedIds.add(s.speaker);
  }

  const splitTargetBySpeakerAndGender = new Map<string, string>();
  for (const [spk, counts] of countsBySpeaker.entries()) {
    if (counts.male > 0 && counts.female > 0) {
      const dominant: Gender = counts.male >= counts.female ? 'male' : 'female';
      const minority: Gender = dominant === 'male' ? 'female' : 'male';
      const newSpk = nextUnusedSpeakerId(usedIds);
      splitTargetBySpeakerAndGender.set(`${spk}:${minority}`, newSpk);
    }
  }

  if (splitTargetBySpeakerAndGender.size > 0) {
    for (const s of preliminary) {
      const alt = splitTargetBySpeakerAndGender.get(`${s.speaker}:${s._assignedGender}`);
      if (alt) s.speaker = alt;
    }
  }

  return { segments: preliminary };
}

function summarizeKnownSpeakers(
  segments: Array<SpeechSegment & { _assignedGender?: Gender }>,
  pitchMap: Map<number, SegmentPitchInfo>,
  existingSpeakers?: Record<string, SpeakerInfo>,
): KnownSpeakerSummary[] {
  const bySpeaker = new Map<string, { genders: Gender[]; pitches: number[] }>();

  if (existingSpeakers) {
    for (const [spk, info] of Object.entries(existingSpeakers)) {
      bySpeaker.set(spk, {
        genders: info.gender !== 'unknown' ? [info.gender] : [],
        pitches: [],
      });
    }
  }

  for (const seg of segments) {
    const entry = bySpeaker.get(seg.speaker) ?? { genders: [], pitches: [] };
    if (seg._assignedGender && seg._assignedGender !== 'unknown') {
      entry.genders.push(seg._assignedGender);
    }
    const p = pitchMap.get(seg.id)?.pitchHz ?? null;
    if (p !== null) entry.pitches.push(p);
    bySpeaker.set(seg.speaker, entry);
  }

  const out: KnownSpeakerSummary[] = [];
  for (const [speaker, entry] of bySpeaker.entries()) {
    const maleCount = entry.genders.filter((g) => g === 'male').length;
    const femaleCount = entry.genders.filter((g) => g === 'female').length;
    const sortedPitches = [...entry.pitches].sort((a, b) => a - b);
    const medianPitchHz = medianOfSorted(sortedPitches);
    let gender: Gender = 'unknown';
    if (maleCount > 0 || femaleCount > 0) {
      gender = femaleCount > maleCount ? 'female' : 'male';
    } else if (medianPitchHz !== null) {
      gender = pitchToGender(medianPitchHz);
    }
    out.push({ speaker, gender, medianPitchHz });
  }
  return out;
}

async function classifyAndDiarizeWithGroqAndPitch(params: {
  projectId: string;
  segments: SpeechSegment[];
  audio16kPath: string;
  existingSpeakers?: Record<string, SpeakerInfo>;
  force: boolean;
  onProgress?: (pct: number, message: string) => Promise<void>;
}): Promise<{
  segments: SpeechSegment[];
  segmentGenders: Map<number, Gender>;
  pitchMap: Map<number, SegmentPitchInfo>;
  modelsUsed: string[];
}> {
  const { projectId, segments, audio16kPath, existingSpeakers, force, onProgress } = params;

  await onProgress?.(12, `S2: Measuring acoustic pitch (f0 Hz) across ${segments.length} segments...`);
  const pitchMap = await measureSegmentPitchesHz(audio16kPath, segments);

  const sorted = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  const batches: SpeechSegment[][] = [];
  for (let i = 0; i < sorted.length; i += GROQ_BATCH_SIZE) {
    batches.push(sorted.slice(i, i + GROQ_BATCH_SIZE));
  }

  const annotated: Array<SpeechSegment & { _assignedGender: Gender }> = [];
  const modelsUsed = new Set<string>();
  let usedDeterministicFallback = false;

  for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
    const batch = batches[bIdx];
    const knownSpeakers = summarizeKnownSpeakers(annotated, pitchMap, existingSpeakers);

    const pct = 18 + Math.round((bIdx / Math.max(1, batches.length)) * 32);
    await onProgress?.(
      pct,
      `S2: Classifying speakers & gender via Groq + pitch (batch ${bIdx + 1}/${batches.length})...`,
    );

    const outcome = await callGroqDiarizeBatch({
      projectId,
      batchIndex: bIdx,
      totalBatches: batches.length,
      batch,
      pitchMap,
      knownSpeakers,
      force,
    });

    if (outcome.modelUsed) {
      modelsUsed.add(outcome.modelUsed);
    }
    if (outcome.fallbackReason) {
      usedDeterministicFallback = true;
      console.warn(
        `[S2] Batch ${bIdx + 1}/${batches.length} using deterministic pitch fallback (${outcome.fallbackReason}).`,
      );
    }

    const reconciled = reconcileBatchWithPitch({
      batch,
      pitchMap,
      groqAssignments: outcome.assignments,
      knownSpeakers,
    });
    annotated.push(...reconciled.segments);
  }

  if (usedDeterministicFallback) {
    modelsUsed.add('acoustic-pitch-f0 (<170Hz=M)');
  }

  // Normalize speaker labels sequentially (S1, S2, ...) unless anchored to existingSpeakers
  const existingIds = new Set(Object.keys(existingSpeakers ?? {}));
  const remap = new Map<string, string>();
  let nextNum = 1;
  for (const id of existingIds) {
    remap.set(id, id);
    const m = /^S(\d+)$/.exec(id);
    if (m) nextNum = Math.max(nextNum, Number(m[1]) + 1);
  }
  for (const s of annotated) {
    if (!remap.has(s.speaker)) {
      if (existingIds.size === 0) {
        remap.set(s.speaker, `S${nextNum++}`);
      } else if (/^S\d+$/.test(s.speaker) && !Array.from(remap.values()).includes(s.speaker)) {
        remap.set(s.speaker, s.speaker);
        const m = /^S(\d+)$/.exec(s.speaker);
        if (m) nextNum = Math.max(nextNum, Number(m[1]) + 1);
      } else {
        while (Array.from(remap.values()).includes(`S${nextNum}`)) nextNum += 1;
        remap.set(s.speaker, `S${nextNum++}`);
      }
    }
  }

  const segmentGenders = new Map<number, Gender>();
  const finalById = new Map<number, SpeechSegment>();
  for (const s of annotated) {
    const cleanSpeaker = remap.get(s.speaker) ?? s.speaker;
    segmentGenders.set(s.id, s._assignedGender);
    const { _assignedGender: _drop, ...cleanSeg } = s;
    finalById.set(s.id, { ...cleanSeg, speaker: cleanSpeaker });
  }

  const orderedFinal = segments.map((orig) => finalById.get(orig.id) ?? orig);

  return {
    segments: orderedFinal,
    segmentGenders,
    pitchMap,
    modelsUsed: Array.from(modelsUsed),
  };
}

function resolveSpeakerGenderAndConfidence(params: {
  speakerSegs: SpeechSegment[];
  segmentGenders: Map<number, Gender>;
  pitchMap: Map<number, SegmentPitchInfo>;
  sampleMedianF0Hz: number | null;
  usedGroq: boolean;
}): { gender: Gender; confidence: number } {
  const { speakerSegs, segmentGenders, pitchMap, sampleMedianF0Hz, usedGroq } = params;

  let maleVotes = 0;
  let femaleVotes = 0;
  const segPitches: number[] = [];

  for (const seg of speakerSegs) {
    const g = segmentGenders.get(seg.id);
    if (g === 'male') maleVotes += 1;
    else if (g === 'female') femaleVotes += 1;
    const p = pitchMap.get(seg.id)?.pitchHz ?? null;
    if (p !== null) segPitches.push(p);
  }

  const segMedianF0 = medianOfSorted([...segPitches].sort((a, b) => a - b));
  const effectiveF0 = sampleMedianF0Hz ?? segMedianF0;
  const pitchGender = pitchToGender(effectiveF0);

  let gender: Gender = 'unknown';
  if (maleVotes > 0 || femaleVotes > 0) {
    gender = femaleVotes > maleVotes ? 'female' : 'male';
  }
  if (gender === 'unknown' && pitchGender !== 'unknown') {
    gender = pitchGender;
  } else if (
    effectiveF0 !== null &&
    ((effectiveF0 <= 145 && gender === 'female') || (effectiveF0 >= 188 && gender === 'male'))
  ) {
    gender = pitchGender;
  }

  let confidence = 0.5;
  if (gender === 'unknown') {
    confidence = 0;
  } else if (usedGroq && pitchGender === gender) {
    confidence = 0.92;
  } else if (usedGroq) {
    confidence = 0.82;
  } else if (effectiveF0 !== null) {
    const dist = Math.abs(effectiveF0 - PITCH_MALE_FEMALE_THRESHOLD_HZ);
    confidence = dist >= 20 ? 0.85 : 0.72;
  }

  return { gender, confidence: Number(confidence.toFixed(2)) };
}

export async function runS2Speakers(projectId: string, force = false): Promise<Project> {
  const { ffmpeg } = requireFfmpeg();
  const cfg = getConfig();
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project "${projectId}" not found.`);
  if (!project.upload.completed) throw new Error('Upload must complete before running S2 Speakers.');

  const setSpeakersProgress = async (
    pct: number,
    message: string,
    status: 'running' | 'done' | 'error' = 'running',
    error?: string,
    modelUsed?: string,
  ) => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        speakers: {
          status,
          progress_pct: pct,
          message,
          error,
          model_used: modelUsed ?? cur.stages.speakers.model_used,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: status === 'error' ? 'error' : 'stage',
      stage: 'speakers',
      progress_pct: pct,
      message,
      project: updated,
    });
    return updated;
  };

  if (!project.video.has_audio || project.speech.length === 0) {
    const emptyProj = await updateProject(projectId, (cur) => ({
      ...cur,
      speakers: {},
      stages: {
        ...cur.stages,
        speakers: {
          status: 'done',
          progress_pct: 100,
          message: 'S2 complete: no speakers detected.',
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'speakers',
      progress_pct: 100,
      message: emptyProj.stages.speakers.message,
      project: emptyProj,
    });
    return emptyProj;
  }

  const s2InputHash = hashString(
    JSON.stringify({
      pipeline: 'groq-s2-pitch-v1',
      model: cfg.GROQ_TEXT_MODEL,
      speech: project.speech.map((s) => [s.start_ms, s.end_ms, s.speaker, s.window_index ?? 0]),
    }),
  );

  if (
    !force &&
    project.stages.speakers.status === 'done' &&
    Object.keys(project.speakers).length > 0 &&
    project.stage_hashes?.s2 === s2InputHash
  ) {
    return project;
  }

  const paths = getProjectPaths(projectId);
  const audio16kPath = path.join(paths.workDir, 'audio_16k.wav');
  if (!(await fileExists(audio16kPath))) {
    throw new Error('16 kHz mono WAV missing. Run S0 Ingest first.');
  }

  try {
    await fs.mkdir(paths.samplesDir, { recursive: true });
    await setSpeakersProgress(8, 'S2: Starting Groq + acoustic pitch speaker analysis...');

    const clsRes = await classifyAndDiarizeWithGroqAndPitch({
      projectId,
      segments: project.speech,
      audio16kPath,
      force,
      onProgress: async (pct, message) => {
        await setSpeakersProgress(pct, message);
      },
    });

    const speakerSegments = new Map<string, SpeechSegment[]>();
    for (const seg of clsRes.segments) {
      const list = speakerSegments.get(seg.speaker) ?? [];
      list.push(seg);
      speakerSegments.set(seg.speaker, list);
    }

    const speakerIds = Array.from(speakerSegments.keys());
    const nextSpeakers: Record<string, SpeakerInfo> = {};
    const usedGroq = clsRes.modelsUsed.some((m) => !m.startsWith('acoustic-pitch'));
    const usedModelSummary =
      clsRes.modelsUsed.join(', ') || `${cfg.GROQ_TEXT_MODEL} + pitch-f0`;

    for (let i = 0; i < speakerIds.length; i += 1) {
      const speakerId = speakerIds[i];
      const pct = 55 + Math.round((i / Math.max(1, speakerIds.length)) * 40);
      await setSpeakersProgress(
        pct,
        `S2: Building voice sample & verifying pitch for ${speakerId} (${i + 1}/${speakerIds.length})...`,
        'running',
        undefined,
        usedModelSummary,
      );

      const safeFile = `${speakerId.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`;
      const samplePath = path.join(paths.samplesDir, safeFile);
      const segsForSpk = speakerSegments.get(speakerId) ?? [];
      const extracted = await extractConcatenatedSample({
        ffmpeg,
        audio16kPath,
        segments: segsForSpk,
        outPath: samplePath,
        targetMaxMs: 26_000,
      });

      const prevInfo = project.speakers[speakerId];
      if (!force && prevInfo?.gender_overridden) {
        nextSpeakers[speakerId] = {
          ...prevInfo,
          sample_file: extracted ? `work/samples/${safeFile}` : prevInfo.sample_file,
          merged_from: [speakerId],
        };
        continue;
      }

      const sampleMedianF0Hz =
        extracted && (await fileExists(samplePath))
          ? await estimateWavMedianF0Hz(samplePath)
          : null;

      const { gender, confidence } = resolveSpeakerGenderAndConfidence({
        speakerSegs: segsForSpk,
        segmentGenders: clsRes.segmentGenders,
        pitchMap: clsRes.pitchMap,
        sampleMedianF0Hz,
        usedGroq,
      });

      nextSpeakers[speakerId] = {
        gender,
        confidence,
        gender_overridden: false,
        ...(extracted ? { sample_file: `work/samples/${safeFile}` } : {}),
        merged_from: [speakerId],
        ...(prevInfo?.voice ? { voice: prevInfo.voice } : {}),
        ...(prevInfo?.voice_overridden ? { voice_overridden: true } : {}),
      };

      await updateProject(projectId, (cur) => ({
        ...cur,
        speakers: { ...cur.speakers, ...nextSpeakers },
      }));
    }

    const primaryLang = project.target_langs.includes('my-MM')
      ? 'my-MM'
      : (project.target_langs[0] ?? 'my-MM');
    const cuesForVoice = clsRes.segments.map((s, idx) => ({
      id: idx + 1,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      speaker: s.speaker,
      src_lang: s.src_lang,
      text: s.text,
      merged_ids: [s.id],
    }));
    const strictVoiceMap = resolveSpeakerVoicesForEngine({
      engine: cfg.TTS_ENGINE,
      speakers: nextSpeakers,
      cues: cuesForVoice,
      targetLang: primaryLang,
      voicePools: cfg.VOICE_POOLS,
    });
    for (const [spk, vName] of Object.entries(strictVoiceMap)) {
      const curSpk = nextSpeakers[spk];
      if (curSpk && !(curSpk.voice_overridden && curSpk.voice?.engine === cfg.TTS_ENGINE)) {
        nextSpeakers[spk] = {
          ...curSpk,
          voice: { engine: cfg.TTS_ENGINE, name: vName },
        };
      }
    }

    const finalProject = await updateProject(projectId, (cur) => ({
      ...cur,
      speech: clsRes.segments,
      speakers: nextSpeakers,
      stage_hashes: {
        ...cur.stage_hashes,
        s2: s2InputHash,
      },
      stages: {
        ...cur.stages,
        speakers: {
          status: 'done',
          progress_pct: 100,
          message: `S2 complete (Groq + Pitch): ${speakerIds.length} speaker(s) classified.`,
          model_used: usedModelSummary,
          updated_at: new Date().toISOString(),
        },
      },
    }));

    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'speakers',
      progress_pct: 100,
      message: finalProject.stages.speakers.message,
      project: finalProject,
    });
    return finalProject;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setSpeakersProgress(0, msg, 'error', msg);
    throw err;
  }
}

/**
 * Classifies speakers in a single smart chunk using acoustic pitch + Groq Chat Completions
 * (with deterministic pitch fallback), anchoring voices back to earlier chunks' canonical IDs.
 */
export async function runS2SpeakersForChunk(params: {
  projectId: string;
  chunkIndex: number;
  chunkSegments: SpeechSegment[];
  existingSpeakers: Record<string, SpeakerInfo>;
  audio16kPath: string;
  modelId: string;
  force: boolean;
}): Promise<{
  segments: SpeechSegment[];
  speakers: Record<string, SpeakerInfo>;
  modelsUsed: string[];
}> {
  const { projectId, chunkIndex, chunkSegments, existingSpeakers, audio16kPath, force } = params;

  if (chunkSegments.length === 0) {
    return { segments: [], speakers: { ...existingSpeakers }, modelsUsed: [] };
  }

  const { ffmpeg } = requireFfmpeg();
  const cfg = getConfig();
  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.samplesDir, { recursive: true });

  const clsRes = await classifyAndDiarizeWithGroqAndPitch({
    projectId,
    segments: chunkSegments,
    audio16kPath,
    existingSpeakers,
    force,
  });

  const localSegsBySpeaker = new Map<string, SpeechSegment[]>();
  for (const seg of clsRes.segments) {
    const list = localSegsBySpeaker.get(seg.speaker) ?? [];
    list.push(seg);
    localSegsBySpeaker.set(seg.speaker, list);
  }

  const nextSpeakers: Record<string, SpeakerInfo> = { ...existingSpeakers };
  const usedGroq = clsRes.modelsUsed.some((m) => !m.startsWith('acoustic-pitch'));

  for (const [speakerId, segsForSpk] of localSegsBySpeaker.entries()) {
    const prev = nextSpeakers[speakerId];
    const safeFile = `${speakerId.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`;
    const samplePath = path.join(paths.samplesDir, safeFile);

    let hasSample = Boolean(prev?.sample_file) && (await fileExists(samplePath));
    if (!hasSample) {
      hasSample = await extractConcatenatedSample({
        ffmpeg,
        audio16kPath,
        segments: segsForSpk,
        outPath: samplePath,
        targetMaxMs: 26_000,
      });
    }

    if (prev && !force) {
      const merged = new Set(prev.merged_from ?? []);
      merged.add(`C${chunkIndex}:${speakerId}`);
      nextSpeakers[speakerId] = {
        ...prev,
        ...(hasSample && !prev.sample_file ? { sample_file: `work/samples/${safeFile}` } : {}),
        merged_from: Array.from(merged),
      };
      continue;
    }

    const sampleMedianF0Hz =
      hasSample && (await fileExists(samplePath))
        ? await estimateWavMedianF0Hz(samplePath)
        : null;

    const { gender, confidence } = resolveSpeakerGenderAndConfidence({
      speakerSegs: segsForSpk,
      segmentGenders: clsRes.segmentGenders,
      pitchMap: clsRes.pitchMap,
      sampleMedianF0Hz,
      usedGroq,
    });

    nextSpeakers[speakerId] = {
      gender,
      confidence,
      gender_overridden: false,
      ...(hasSample ? { sample_file: `work/samples/${safeFile}` } : {}),
      merged_from: [`C${chunkIndex}:${speakerId}`],
      ...(prev?.voice ? { voice: prev.voice } : {}),
      ...(prev?.voice_overridden ? { voice_overridden: true } : {}),
    };
  }

  const projectForLang = await getProject(projectId);
  const targetLangs = projectForLang?.target_langs ?? [];
  const primaryLang = targetLangs.includes('my-MM') ? 'my-MM' : (targetLangs[0] ?? 'my-MM');
  const strictVoiceMap = resolveSpeakerVoicesForEngine({
    engine: cfg.TTS_ENGINE,
    speakers: nextSpeakers,
    cues: clsRes.segments.map((s, idx) => ({
      id: idx + 1,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      speaker: s.speaker,
      src_lang: s.src_lang,
      text: s.text,
      merged_ids: [s.id],
    })),
    targetLang: primaryLang,
    voicePools: cfg.VOICE_POOLS,
  });
  for (const [spk, vName] of Object.entries(strictVoiceMap)) {
    const curSpk = nextSpeakers[spk];
    if (curSpk && !(curSpk.voice_overridden && curSpk.voice?.engine === cfg.TTS_ENGINE)) {
      nextSpeakers[spk] = {
        ...curSpk,
        voice: { engine: cfg.TTS_ENGINE, name: vName },
      };
    }
  }

  return {
    segments: clsRes.segments,
    speakers: nextSpeakers,
    modelsUsed: clsRes.modelsUsed,
  };
}
