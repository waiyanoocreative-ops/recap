import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  EdgeVoiceInfo,
  GeminiVoiceInfo,
  ScriptEmotion,
  TtsEngineType,
  TtsProvider,
} from '../../shared/projectTypes.ts';
import { hashString } from '../analyze/cache.ts';
import { getConfig, requestCounts } from '../config.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { redactSecrets } from '../gemini/keyPool.ts';
import { executeResilientGeminiCall } from '../gemini/resilientClient.ts';
import { COMMON_PYTHON_BIN_DIRS, getBinaryStatus, spawnCommand } from '../media/binaries.ts';
import { getProject, getProjectPaths } from '../storage/projectStore.ts';
import { withExponentialBackoffRetry } from '../utils/retry.ts';

export type EdgeTtsBackend = 'npm' | 'python-cli' | 'unavailable';

export interface EdgeTtsRuntimeStatus {
  backend: EdgeTtsBackend;
  checkedAt: string | null;
  npmOk: boolean;
  npmError: string | null;
  cliOk: boolean;
  cliError: string | null;
}

export const edgeTtsRuntime: EdgeTtsRuntimeStatus = {
  backend: 'npm',
  checkedAt: null,
  npmOk: false,
  npmError: null,
  cliOk: false,
  cliError: null,
};

async function loadEdgeTtsModule() {
  try {
    return await import('edge-tts-universal');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load edge-tts-universal: ${msg}`);
  }
}

export interface TtsSynthesizeRequest {
  text: string;
  voice: string;
  rate?: string;
  pitch?: string;
  model?: string;
  emotion?: ScriptEmotion;
  maxRetries?: number;
  projectId?: string;
  jobHash?: string;
  jobLabel?: string;
  interactive?: boolean;
  force?: boolean;
  onAudioReady?: (res: TtsSynthesizeResult) => Promise<void> | void;
}

export interface TtsSynthesizeResult {
  audio: Buffer;
  mimeType: string;
  durationSec: number;
  ms: number;
  model?: string;
}

export interface TtsEngine {
  readonly id: 'edge' | 'gemini' | 'f5-myanmar';
  synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>;
}

export const GEMINI_PREBUILT_VOICES: GeminiVoiceInfo[] = [
  { name: 'Zephyr', gender: 'female', style: 'Bright' },
  { name: 'Puck', gender: 'male', style: 'Upbeat' },
  { name: 'Charon', gender: 'male', style: 'Informative' },
  { name: 'Kore', gender: 'female', style: 'Firm' },
  { name: 'Fenrir', gender: 'male', style: 'Excitable' },
  { name: 'Leda', gender: 'female', style: 'Youthful' },
  { name: 'Orus', gender: 'male', style: 'Firm' },
  { name: 'Aoede', gender: 'female', style: 'Breezy' },
  { name: 'Callirrhoe', gender: 'female', style: 'Easy-going' },
  { name: 'Autonoe', gender: 'female', style: 'Bright' },
  { name: 'Enceladus', gender: 'male', style: 'Breathy' },
  { name: 'Iapetus', gender: 'male', style: 'Clear' },
  { name: 'Umbriel', gender: 'male', style: 'Easy-going' },
  { name: 'Algieba', gender: 'male', style: 'Smooth' },
  { name: 'Despina', gender: 'female', style: 'Smooth' },
  { name: 'Erinome', gender: 'female', style: 'Clear' },
  { name: 'Algenib', gender: 'male', style: 'Gravelly' },
  { name: 'Rasalgethi', gender: 'male', style: 'Informative' },
  { name: 'Laomedeia', gender: 'female', style: 'Upbeat' },
  { name: 'Achernar', gender: 'female', style: 'Soft' },
  { name: 'Alnilam', gender: 'male', style: 'Firm' },
  { name: 'Schedar', gender: 'male', style: 'Even' },
  { name: 'Gacrux', gender: 'female', style: 'Mature' },
  { name: 'Pulcherrima', gender: 'female', style: 'Forward' },
  { name: 'Achird', gender: 'male', style: 'Friendly' },
  { name: 'Zubenelgenubi', gender: 'male', style: 'Casual' },
  { name: 'Vindemiatrix', gender: 'female', style: 'Gentle' },
  { name: 'Sadachbia', gender: 'male', style: 'Lively' },
  { name: 'Sadaltager', gender: 'male', style: 'Knowledgeable' },
  { name: 'Sulafat', gender: 'female', style: 'Warm' },
];

let cachedEdgeVoices: { fetchedAt: number; voices: EdgeVoiceInfo[] } | null = null;
let inFlightEdgeVoicesPromise: Promise<EdgeVoiceInfo[]> | null = null;
const EDGE_VOICE_CACHE_MS = 5 * 60 * 1000;

export async function measureAudioDurationSec(audio: Buffer, mimeType: string): Promise<number> {
  if (audio.length === 0) return 0;

  try {
    const bin = getBinaryStatus();
    if (bin.ok && bin.ffprobePath) {
      const ext = mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3' : 'wav';
      const tmpFile = path.join(
        os.tmpdir(),
        `tts_probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`,
      );
      try {
        await fs.writeFile(tmpFile, audio);
        const res = await spawnCommand(
          bin.ffprobePath,
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            tmpFile,
          ],
          { timeoutMs: 5000 },
        );
        if (res.code === 0) {
          const parsed = Number.parseFloat(res.stdout.trim());
          if (Number.isFinite(parsed) && parsed > 0) {
            return Number(parsed.toFixed(2));
          }
        }
      } catch {
        // fall through to header estimation
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    }
  } catch {
    // getBinaryStatus may not be checked yet during early startup
  }

  // Fallback estimation for standard 24kHz mono 16-bit WAV
  if (mimeType.includes('wav') && audio.length > 44) {
    return Number(((audio.length - 44) / (24000 * 2)).toFixed(2));
  }
  return 0;
}

const EDGE_TTS_TIMEOUT_MS = 30000;
const GEMINI_TTS_TIMEOUT_MS = 20000;
export const EDGE_TTS_CONCURRENCY = 4;

function createConcurrencyLimiter(maxConcurrent: number) {
  let activeCount = 0;
  const waitingQueue: Array<() => void> = [];

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (activeCount >= maxConcurrent) {
      await new Promise<void>((resolve) => {
        waitingQueue.push(resolve);
      });
    }
    activeCount += 1;
    try {
      return await task();
    } finally {
      activeCount -= 1;
      const next = waitingQueue.shift();
      if (next) next();
    }
  };
}

const runEdgeTtsWithWorkerLimit = createConcurrencyLimiter(EDGE_TTS_CONCURRENCY);

async function retryEdgeWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
): Promise<T> {
  return withExponentialBackoffRetry(() => fn(), {
    maxAttempts,
    baseDelayMs: 1000,
    factor: 2,
    label: `Edge TTS (${label})`,
    shouldRetry: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return !/ENOENT|not found on PATH/i.test(msg);
    },
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function sortAndFilterEdgeVoices(voices: EdgeVoiceInfo[]): EdgeVoiceInfo[] {
  const filtered = voices.filter((v) => v.locale === 'my-MM' || v.locale.startsWith('en-'));
  filtered.sort((a, b) => {
    const rank = (loc: string) => (loc === 'my-MM' ? 0 : loc === 'en-US' ? 1 : 2);
    const rDiff = rank(a.locale) - rank(b.locale);
    if (rDiff !== 0) return rDiff;
    const locDiff = a.locale.localeCompare(b.locale);
    if (locDiff !== 0) return locDiff;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

async function listVoicesWithEdgeNpm(): Promise<EdgeVoiceInfo[]> {
  const { listVoices } = await loadEdgeTtsModule();
  const raw = await withTimeout(listVoices(), EDGE_TTS_TIMEOUT_MS, 'Edge TTS listVoices (npm)');
  const mapped: EdgeVoiceInfo[] = raw.map((v) => {
    const withLocaleName = v as typeof v & { LocaleName?: string };
    return {
      name: v.ShortName,
      friendlyName: v.FriendlyName,
      gender: v.Gender.toLowerCase() === 'female' ? 'female' : 'male',
      locale: v.Locale,
      localeName: withLocaleName.LocaleName,
    };
  });
  return sortAndFilterEdgeVoices(mapped);
}

function parseEdgeCliVoicesOutput(stdout: string): EdgeVoiceInfo[] {
  const lines = stdout.split(/\r?\n/);
  const voices: EdgeVoiceInfo[] = [];

  // Format A (edge-tts >= 6.1): tabular columns "Name  Gender  ContentCategories  VoicePersonalities"
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Name ') || line.startsWith('---')) continue;
    const colMatch = /^([a-z]{2,3}-[A-Z]{2}(?:-[A-Za-z0-9]+)?-[A-Za-z0-9_-]+)\s+(Female|Male)\b(.*)$/i.exec(
      line,
    );
    if (colMatch) {
      const name = colMatch[1].trim();
      const gender = colMatch[2].toLowerCase() === 'female' ? 'female' : 'male';
      const localeMatch = /^([a-z]{2,3}-[A-Z]{2})/.exec(name);
      const locale = localeMatch ? localeMatch[1] : 'en-US';
      const extra = colMatch[3].trim().replace(/\s{2,}/g, ' · ');
      voices.push({
        name,
        friendlyName: extra ? `${name} (${extra})` : name,
        gender,
        locale,
      });
    }
  }
  if (voices.length > 0) {
    return sortAndFilterEdgeVoices(voices);
  }

  // Format B (older Python edge-tts): Name: ... / ShortName: ... / Gender: ... / Locale: ...
  let current: Partial<EdgeVoiceInfo> = {};
  const flushBlock = () => {
    if (current.name && current.locale) {
      voices.push({
        name: current.name,
        friendlyName: current.friendlyName || current.name,
        gender: current.gender === 'female' ? 'female' : 'male',
        locale: current.locale,
      });
    }
    current = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushBlock();
      continue;
    }
    if (line.startsWith('Name:')) current.friendlyName = line.slice(5).trim();
    else if (line.startsWith('ShortName:')) current.name = line.slice(10).trim();
    else if (line.startsWith('Gender:')) {
      current.gender = line.slice(7).trim().toLowerCase() === 'female' ? 'female' : 'male';
    } else if (line.startsWith('Locale:')) {
      current.locale = line.slice(7).trim();
    }
  }
  flushBlock();
  return sortAndFilterEdgeVoices(voices);
}

async function listVoicesWithEdgeCli(): Promise<EdgeVoiceInfo[]> {
  const res = await spawnCommand('edge-tts', ['--list-voices'], {
    timeoutMs: EDGE_TTS_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    throw new Error(`Python CLI edge-tts --list-voices exited with ${res.code}: ${res.stderr || res.stdout}`);
  }
  const parsed = parseEdgeCliVoicesOutput(res.stdout);
  if (parsed.length === 0) {
    throw new Error('Python CLI edge-tts --list-voices returned no parseable my-MM/en-* voices.');
  }
  return parsed;
}

async function synthesizeWithEdgeNpm(
  text: string,
  voice: string,
  maxAttempts = 4,
  opts?: { rate?: string; pitch?: string },
): Promise<Buffer> {
  const { Communicate } = await loadEdgeTtsModule();
  const clampedRate = opts?.rate ? clampEdgeTtsRateStr(opts.rate) : undefined;
  const safeRate = clampedRate && clampedRate !== '+0%' ? clampedRate : undefined;
  const runStream = async (): Promise<Buffer> => {
    const communicate = new Communicate(text, {
      voice,
      ...(safeRate ? { rate: safeRate } : {}),
      ...(opts?.pitch ? { pitch: opts.pitch } : {}),
      connectionTimeout: 25000,
    });
    const audioChunks: Buffer[] = [];
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        audioChunks.push(Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data));
      }
    }
    if (audioChunks.length === 0) {
      throw new Error(`Edge TTS (npm) returned no audio data for voice "${voice}".`);
    }
    return Buffer.concat(audioChunks);
  };

  return retryEdgeWithBackoff(
    () =>
      withTimeout(
        runStream(),
        EDGE_TTS_TIMEOUT_MS,
        `Edge TTS WebSocket (npm) for voice "${voice}"`,
      ),
    `npm voice "${voice}"`,
    maxAttempts,
  );
}

async function synthesizeWithEdgeCliAttempt(
  text: string,
  voice: string,
  opts?: { rate?: string; pitch?: string },
): Promise<Buffer> {
  const tmpMp3 = path.join(
    os.tmpdir(),
    `edge_cli_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`,
  );
  try {
    const args = [`--voice=${voice}`];
    const clampedRate = opts?.rate ? clampEdgeTtsRateStr(opts.rate) : undefined;
    if (clampedRate && clampedRate !== '+0%') args.push(`--rate=${clampedRate}`);
    if (opts?.pitch && opts.pitch !== '+0Hz') args.push(`--pitch=${opts.pitch}`);
    args.push(`--text=${text}`, `--write-media=${tmpMp3}`);

    const res = await spawnCommand('edge-tts', args, { timeoutMs: EDGE_TTS_TIMEOUT_MS });
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(`Python CLI edge-tts failed (exit ${res.code})${detail ? `: ${detail}` : ''}`);
    }
    const audio = await fs.readFile(tmpMp3);
    if (audio.length === 0) {
      throw new Error(`Python CLI edge-tts produced an empty file for voice "${voice}".`);
    }
    return audio;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(msg)) {
      throw new Error('Python CLI `edge-tts` command not found on PATH (install via: pip install edge-tts).');
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    await fs.unlink(tmpMp3).catch(() => {});
  }
}

async function synthesizeWithEdgeCli(
  text: string,
  voice: string,
  maxAttempts = 4,
  opts?: { rate?: string; pitch?: string },
): Promise<Buffer> {
  return retryEdgeWithBackoff(
    () => synthesizeWithEdgeCliAttempt(text, voice, opts),
    `python-cli voice "${voice}"`,
    maxAttempts,
  );
}

export interface EdgeTtsBatchItem {
  id: string;
  text: string;
  voice: string;
  rate?: string;
  outPath: string;
}

export interface EdgeTtsBatchResult {
  total: number;
  skipped: number;
  synthesized: number;
  failed: Array<{ id: string; error: string }>;
  ms: number;
}

let cachedEdgePythonBin: string | null | undefined;

async function resolveEdgeTtsPythonBin(): Promise<string | null> {
  if (cachedEdgePythonBin !== undefined) {
    return cachedEdgePythonBin;
  }

  const candidates: string[] = [];
  const envPy = process.env.EDGE_TTS_PYTHON_PATH?.trim() || process.env.PYTHON_BIN?.trim();
  if (envPy) candidates.push(envPy);

  candidates.push(
    path.join(process.cwd(), '.venv', 'bin', 'python3'),
    path.join(process.cwd(), 'venv', 'bin', 'python3'),
    'python3',
    'python',
  );
  for (const dir of COMMON_PYTHON_BIN_DIRS) {
    candidates.push(path.join(dir, 'python3'));
    candidates.push(path.join(dir, 'python'));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (path.isAbsolute(candidate)) {
      try {
        await fs.access(candidate);
      } catch {
        continue;
      }
    }

    try {
      const probe = await spawnCommand(candidate, ['-c', 'import edge_tts'], { timeoutMs: 8000 });
      if (probe.code === 0) {
        cachedEdgePythonBin = candidate;
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }

  cachedEdgePythonBin = null;
  return null;
}

// Valid 24kHz mono 32kbps MPEG-2 Layer 3 silent frame (96 bytes, 24ms each; x21 = 0.504s)
const SILENT_MP3_FRAME_B64 =
  '//NExFMAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu';

function createSilentHalfSecAudioBuffer(outPath = '.mp3'): Buffer {
  if (outPath.toLowerCase().endsWith('.wav')) {
    const sampleRate = 24000;
    const pcmBytes = Math.round(sampleRate * 0.5) * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 4, 'ascii');
    header.writeUInt32LE(36 + pcmBytes, 4);
    header.write('WAVE', 8, 4, 'ascii');
    header.write('fmt ', 12, 4, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 4, 'ascii');
    header.writeUInt32LE(pcmBytes, 40);
    return Buffer.concat([header, Buffer.alloc(pcmBytes)]);
  }
  const frame = Buffer.from(SILENT_MP3_FRAME_B64, 'base64');
  return Buffer.concat(Array.from({ length: 21 }, () => frame));
}

const PYTHON_EDGE_TTS_BATCH_SCRIPT = [
  'import asyncio, base64, json, os, struct, sys',
  'import edge_tts',
  '',
  `SILENT_MP3_BYTES = base64.b64decode('${SILENT_MP3_FRAME_B64}') * 21`,
  'RETRY_DELAYS = (1.0, 2.0, 4.0)',
  '',
  'def write_silent_fallback(out_path, tmp_path):',
  '    parent = os.path.dirname(out_path)',
  '    if parent:',
  '        os.makedirs(parent, exist_ok=True)',
  "    if out_path.lower().endswith('.wav'):",
  '        sr = 24000',
  '        pcm_bytes = int(sr * 0.5) * 2',
  "        header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + pcm_bytes, b'WAVE', b'fmt ', 16, 1, 1, sr, sr * 2, 2, 16, b'data', pcm_bytes)",
  '        payload = header + (b"\\x00" * pcm_bytes)',
  '    else:',
  '        payload = SILENT_MP3_BYTES',
  "    with open(tmp_path, 'wb') as sf:",
  '        sf.write(payload)',
  '    os.replace(tmp_path, out_path)',
  '',
  'async def main():',
  "    with open(sys.argv[1], 'r', encoding='utf-8') as f:",
  '        items = json.load(f)',
  '    sem = asyncio.Semaphore(4)',
  '',
  '    async def run_one(idx, item):',
  "        item_id = item.get('id', str(idx))",
  "        out_path = item['outPath']",
  '        tmp_path = f"{out_path}.tmp.{os.getpid()}.{idx}"',
  '        last_err = None',
  '        try:',
  '            if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:',
  "                return {'id': item_id, 'ok': True, 'skipped': True}",
  '            parent = os.path.dirname(out_path)',
  '            if parent:',
  '                os.makedirs(parent, exist_ok=True)',
  "            kwargs = {'voice': item['voice']}",
  "            rate = (item.get('rate') or '').strip()",
  "            if rate and rate != '+0%':",
  "                kwargs['rate'] = rate",
  "            text = (item.get('text') or '').strip()",
  '            if text:',
  '                for attempt in range(len(RETRY_DELAYS) + 1):',
  '                    try:',
  '                        async with sem:',
  '                            comm = edge_tts.Communicate(text, **kwargs)',
  '                            await asyncio.wait_for(comm.save(tmp_path), timeout=30.0)',
  '                        if os.path.isfile(tmp_path) and os.path.getsize(tmp_path) > 0:',
  '                            os.replace(tmp_path, out_path)',
  "                            return {'id': item_id, 'ok': True, 'skipped': False}",
  "                        last_err = 'empty audio output'",
  '                    except Exception as exc:',
  '                        last_err = str(exc) or exc.__class__.__name__',
  '                        try:',
  '                            if os.path.exists(tmp_path):',
  '                                os.unlink(tmp_path)',
  '                        except Exception:',
  '                            pass',
  '                    if attempt < len(RETRY_DELAYS):',
  '                        await asyncio.sleep(RETRY_DELAYS[attempt])',
  '            else:',
  "                last_err = 'empty text'",
  '        except Exception as exc:',
  '            last_err = str(exc) or exc.__class__.__name__',
  '        print(f"[Edge TTS Batch] Warning: line {item_id} failed after 3 retries ({last_err}); generating 0.5s silent audio.", file=sys.stderr)',
  '        try:',
  '            write_silent_fallback(out_path, tmp_path)',
  "            return {'id': item_id, 'ok': True, 'skipped': False, 'silent_fallback': True, 'warning': last_err}",
  '        except Exception as fallback_exc:',
  '            print(f"[Edge TTS Batch] Warning: line {item_id} silent fallback write failed ({fallback_exc}).", file=sys.stderr)',
  "            return {'id': item_id, 'ok': False, 'error': f'{last_err}; silent fallback failed: {fallback_exc}'}",
  '',
  '    results = await asyncio.gather(*(run_one(idx, it) for idx, it in enumerate(items)))',
  "    print('EDGE_TTS_BATCH_JSON:' + json.dumps(results, ensure_ascii=False))",
  '',
  'asyncio.run(main())',
].join('\n');

/**
 * Synthesizes a batch of Edge TTS lines using a SINGLE Python process (`python3 -c ...`)
 * powered by `asyncio` + `edge_tts.Communicate` with `asyncio.Semaphore(4)`,
 * per-line auto-retries (3 retries: 1s, 2s, 4s), and 0.5s silent audio fallback on persistent failures.
 * Skips any item whose `outPath` already exists on disk with `size > 0`.
 * Falls back to `edge-tts-universal` (npm) concurrently if Python `edge_tts` is unavailable.
 */
export function clampEdgeTtsRateStr(rawRate?: string): string {
  const clean = rawRate?.trim();
  if (!clean) return '+0%';
  let pct = 0;
  if (clean.endsWith('%')) {
    const parsed = Number.parseFloat(clean.slice(0, -1));
    if (Number.isFinite(parsed)) {
      pct = parsed;
    }
  } else {
    const parsed = Number.parseFloat(clean);
    if (Number.isFinite(parsed)) {
      // Treat small decimal values (e.g. 0.8..2.0) as speed multipliers, otherwise percentage points
      pct = parsed > 0 && parsed <= 3 ? (parsed - 1) * 100 : parsed;
    }
  }
  const clamped = Math.max(0, Math.min(20, Math.round(pct)));
  return `+${clamped}%`;
}

export async function synthesizeEdgeTtsBatch(
  items: EdgeTtsBatchItem[],
): Promise<EdgeTtsBatchResult> {
  const startedAt = Date.now();
  if (items.length === 0) {
    return { total: 0, skipped: 0, synthesized: 0, failed: [], ms: 0 };
  }

  let skipped = 0;
  const pending: EdgeTtsBatchItem[] = [];
  const seenOutPaths = new Set<string>();

  for (const item of items) {
    try {
      const stat = await fs.stat(item.outPath);
      if (stat.isFile() && stat.size > 0) {
        skipped += 1;
        continue;
      }
    } catch {
      // file does not exist yet
    }
    if (seenOutPaths.has(item.outPath)) {
      skipped += 1;
      continue;
    }
    seenOutPaths.add(item.outPath);
    pending.push({
      ...item,
      rate: clampEdgeTtsRateStr(item.rate),
    });
  }

  if (pending.length === 0) {
    return {
      total: items.length,
      skipped,
      synthesized: 0,
      failed: [],
      ms: Date.now() - startedAt,
    };
  }

  const uniqueDirs = Array.from(new Set(pending.map((it) => path.dirname(it.outPath)).filter(Boolean)));
  await Promise.all(uniqueDirs.map((dir) => fs.mkdir(dir, { recursive: true })));

  let synthesized = 0;
  const failed: Array<{ id: string; error: string }> = [];
  const remainingForNpmFallback: EdgeTtsBatchItem[] = [];

  const pythonBin = await resolveEdgeTtsPythonBin();
  if (pythonBin) {
    const manifestPath = path.join(
      os.tmpdir(),
      `edge_tts_batch_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
    );
    try {
      await fs.writeFile(manifestPath, JSON.stringify(pending), 'utf-8');
      console.log(
        `[Edge TTS Batch] Spawning 1 Python process (${pythonBin}, Semaphore(4)) for ${pending.length} lines (${skipped} cached skipped)...`,
      );
      const res = await spawnCommand(
        pythonBin,
        ['-c', PYTHON_EDGE_TTS_BATCH_SCRIPT, manifestPath],
        { timeoutMs: Math.max(180_000, pending.length * 15_000) },
      );

      if (res.stderr.trim()) {
        console.warn(`[Edge TTS Batch stderr] ${res.stderr.trim().slice(-1200)}`);
      }

      const markerLine = res.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('EDGE_TTS_BATCH_JSON:'));

      if (res.code === 0 && markerLine) {
        const parsed = JSON.parse(markerLine.slice('EDGE_TTS_BATCH_JSON:'.length)) as Array<{
          id: string;
          ok: boolean;
          skipped?: boolean;
          silent_fallback?: boolean;
          error?: string;
        }>;
        const resultById = new Map(parsed.map((r) => [r.id, r]));
        for (const item of pending) {
          const r = resultById.get(item.id);
          if (r?.ok) {
            if (r.skipped) skipped += 1;
            else synthesized += 1;
          } else {
            remainingForNpmFallback.push(item);
          }
        }
      } else {
        console.warn(
          `[Edge TTS Batch] Python batch exited (${res.code}): ${(res.stderr || res.stdout).slice(-400)}; falling back to npm.`,
        );
        remainingForNpmFallback.push(...pending);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Edge TTS Batch] Python batch failed (${msg}); falling back to npm.`);
      remainingForNpmFallback.push(...pending);
    } finally {
      await fs.unlink(manifestPath).catch(() => {});
    }
  } else {
    remainingForNpmFallback.push(...pending);
  }

  if (remainingForNpmFallback.length > 0) {
    const batchLimiter = createConcurrencyLimiter(4);
    await Promise.all(
      remainingForNpmFallback.map((item) =>
        batchLimiter(async () => {
          try {
            const stat = await fs.stat(item.outPath).catch(() => null);
            if (stat && stat.isFile() && stat.size > 0) {
              skipped += 1;
              return;
            }
            const clampedRate = clampEdgeTtsRateStr(item.rate);
            const opts = clampedRate !== '+0%' ? { rate: clampedRate } : undefined;
            const audio = await synthesizeWithEdgeNpm(item.text, item.voice, 4, opts);
            const tmpOut = `${item.outPath}.tmp.${process.pid}.${Date.now()}`;
            await fs.writeFile(tmpOut, audio);
            await fs.rename(tmpOut, item.outPath);
            synthesized += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[Edge TTS Batch] Line ${item.id} failed after retries (${msg}); writing 0.5s silent fallback audio.`,
            );
            try {
              const silentBuf = createSilentHalfSecAudioBuffer(item.outPath);
              const tmpOut = `${item.outPath}.tmp.${process.pid}.${Date.now()}`;
              await fs.writeFile(tmpOut, silentBuf);
              await fs.rename(tmpOut, item.outPath);
              synthesized += 1;
            } catch (writeErr) {
              const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
              failed.push({ id: item.id, error: `${msg}; silent fallback failed: ${writeMsg}` });
            }
          }
        }),
      ),
    );
  }

  const ms = Date.now() - startedAt;
  console.log(
    `[Edge TTS Batch] Completed in ${ms}ms: total=${items.length}, synthesized=${synthesized}, skipped=${skipped}, failed=${failed.length}`,
  );
  return { total: items.length, skipped, synthesized, failed, ms };
}

export async function initEdgeTtsAtStartup(): Promise<EdgeTtsRuntimeStatus> {
  const testText = 'Hello';
  const testVoice = 'en-US-AriaNeural';

  try {
    const npmAudio = await synthesizeWithEdgeNpm(testText, testVoice, 2);
    edgeTtsRuntime.backend = 'npm';
    edgeTtsRuntime.npmOk = true;
    edgeTtsRuntime.npmError = null;
    edgeTtsRuntime.checkedAt = new Date().toISOString();
    console.log(
      `[Edge TTS] Startup self-test: backend=npm (edge-tts-universal) ok=true bytes=${npmAudio.length}`,
    );
    return { ...edgeTtsRuntime };
  } catch (npmErr) {
    const npmMsg = npmErr instanceof Error ? npmErr.message : String(npmErr);
    edgeTtsRuntime.npmOk = false;
    edgeTtsRuntime.npmError = npmMsg;
  }

  try {
    const cliAudio = await synthesizeWithEdgeCli(testText, testVoice, 2);
    edgeTtsRuntime.backend = 'python-cli';
    edgeTtsRuntime.cliOk = true;
    edgeTtsRuntime.cliError = null;
    edgeTtsRuntime.checkedAt = new Date().toISOString();
    console.log(
      `[Edge TTS] Startup self-test: npm failed; switched automatically to Python CLI 'edge-tts' ok=true bytes=${cliAudio.length}`,
    );
    return { ...edgeTtsRuntime };
  } catch (cliErr) {
    const cliMsg = cliErr instanceof Error ? cliErr.message : String(cliErr);
    edgeTtsRuntime.cliOk = false;
    edgeTtsRuntime.cliError = cliMsg;
    edgeTtsRuntime.backend = 'unavailable';
    edgeTtsRuntime.checkedAt = new Date().toISOString();
    console.warn(
      `[Edge TTS] Startup self-test: unavailable (npm: ${edgeTtsRuntime.npmError} | python-cli: ${cliMsg})`,
    );
    return { ...edgeTtsRuntime };
  }
}

export async function listEdgeVoicesFiltered(forceRefresh = false): Promise<EdgeVoiceInfo[]> {
  if (!forceRefresh && cachedEdgeVoices && Date.now() - cachedEdgeVoices.fetchedAt < EDGE_VOICE_CACHE_MS) {
    return cachedEdgeVoices.voices;
  }

  if (inFlightEdgeVoicesPromise) {
    return inFlightEdgeVoicesPromise;
  }

  inFlightEdgeVoicesPromise = (async () => {
    console.log(
      `[TTS Request] engine=edge backend=${edgeTtsRuntime.backend} action=listVoices forceRefresh=${forceRefresh}`,
    );
    try {
      let filtered: EdgeVoiceInfo[];
      if (edgeTtsRuntime.backend === 'python-cli') {
        try {
          filtered = await listVoicesWithEdgeCli();
        } catch (cliErr) {
          try {
            filtered = await listVoicesWithEdgeNpm();
            edgeTtsRuntime.backend = 'npm';
          } catch {
            throw cliErr;
          }
        }
      } else {
        try {
          filtered = await listVoicesWithEdgeNpm();
        } catch (npmErr) {
          try {
            filtered = await listVoicesWithEdgeCli();
            edgeTtsRuntime.backend = 'python-cli';
            edgeTtsRuntime.cliOk = true;
            edgeTtsRuntime.cliError = null;
          } catch (cliErr) {
            const npmMsg = npmErr instanceof Error ? npmErr.message : String(npmErr);
            const cliMsg = cliErr instanceof Error ? cliErr.message : String(cliErr);
            throw new Error(`npm failed (${npmMsg}); Python CLI edge-tts failed (${cliMsg})`);
          }
        }
      }

      cachedEdgeVoices = { fetchedAt: Date.now(), voices: filtered };
      console.log(
        `[TTS Result] engine=edge backend=${edgeTtsRuntime.backend} action=listVoices ok=true count=${filtered.length}`,
      );
      return filtered;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TTS Result] engine=edge action=listVoices ok=false error=${msg}`);
      throw err;
    } finally {
      inFlightEdgeVoicesPromise = null;
    }
  })();

  return inFlightEdgeVoicesPromise;
}

function isF5MyanmarEnvSelected(): boolean {
  const rawEngine = (process.env.TTS_ENGINE || '').trim().toLowerCase();
  const rawMyanmarEngine = (process.env.MYANMAR_TTS_ENGINE || '').trim().toLowerCase();
  const flag = (process.env.F5_MYANMAR_TTS || '').trim().toLowerCase();
  return (
    rawEngine === 'f5-myanmar' ||
    rawMyanmarEngine === 'f5-myanmar' ||
    flag === '1' ||
    flag === 'true'
  );
}

function isBurmeseTtsRequest(req: TtsSynthesizeRequest): boolean {
  return req.voice.startsWith('my-MM') || /[\u1000-\u109F]/.test(req.text);
}

export class EdgeTtsEngine implements TtsEngine {
  readonly id = 'edge' as const;

  async synthesizeDirect(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const normRate = clampEdgeTtsRateStr(req.rate);
    const normPitch = req.pitch?.trim() || '+0Hz';
    const contentHash = hashString(`${req.text}|${req.voice}|${normRate}|${normPitch}`);
    const edgeCacheDir =
      req.projectId && req.projectId !== '__preview__'
        ? getProjectPaths(req.projectId).cacheDir
        : path.join(os.tmpdir(), 'edge_tts_cache');
    const cachedMp3Path = path.join(edgeCacheDir, `tts_edge_${contentHash}.mp3`);

    // Strict content-hash disk cache check before queuing or spawning edge-tts
    if (!req.force) {
      try {
        const stat = await fs.stat(cachedMp3Path);
        if (stat.isFile() && stat.size > 0) {
          const cachedAudio = await fs.readFile(cachedMp3Path);
          if (cachedAudio.length > 0) {
            const mimeType = 'audio/mpeg';
            const durationSec = await measureAudioDurationSec(cachedAudio, mimeType);
            return { audio: cachedAudio, mimeType, durationSec, ms: 0 };
          }
        }
      } catch {
        // cache miss
      }
    }

    const ttsOpts = {
      ...(normRate !== '+0%' ? { rate: normRate } : {}),
      ...(normPitch !== '+0Hz' ? { pitch: normPitch } : {}),
    };

    return runEdgeTtsWithWorkerLimit(async () => {
      // Re-check cache after acquiring worker slot in case a concurrent task wrote the same line
      if (!req.force) {
        try {
          const stat = await fs.stat(cachedMp3Path);
          if (stat.isFile() && stat.size > 0) {
            const cachedAudio = await fs.readFile(cachedMp3Path);
            if (cachedAudio.length > 0) {
              const mimeType = 'audio/mpeg';
              const durationSec = await measureAudioDurationSec(cachedAudio, mimeType);
              return { audio: cachedAudio, mimeType, durationSec, ms: 0 };
            }
          }
        } catch {
          // cache miss
        }
      }

      const startedAt = Date.now();
      requestCounts.edgeTts += 1;
      console.log(
        `[TTS Request] engine=edge backend=${edgeTtsRuntime.backend} voice=${req.voice} textLen=${req.text.length} text=${JSON.stringify(req.text.slice(0, 60))}`,
      );

      try {
        let audio: Buffer;
        if (edgeTtsRuntime.backend === 'python-cli') {
          audio = await synthesizeWithEdgeCli(req.text, req.voice, 4, ttsOpts);
        } else {
          try {
            audio = await synthesizeWithEdgeNpm(req.text, req.voice, 4, ttsOpts);
            edgeTtsRuntime.npmOk = true;
            edgeTtsRuntime.npmError = null;
          } catch (npmErr) {
            const npmMsg = npmErr instanceof Error ? npmErr.message : String(npmErr);
            edgeTtsRuntime.npmOk = false;
            edgeTtsRuntime.npmError = npmMsg;
            try {
              audio = await synthesizeWithEdgeCli(req.text, req.voice, 4, ttsOpts);
              edgeTtsRuntime.backend = 'python-cli';
              edgeTtsRuntime.cliOk = true;
              edgeTtsRuntime.cliError = null;
              console.warn(`[Edge TTS] Switched runtime backend from npm to Python CLI 'edge-tts'.`);
            } catch (cliErr) {
              const cliMsg = cliErr instanceof Error ? cliErr.message : String(cliErr);
              edgeTtsRuntime.cliOk = false;
              edgeTtsRuntime.cliError = cliMsg;
              throw new Error(`Edge TTS npm failed (${npmMsg}); Python CLI fallback failed (${cliMsg})`);
            }
          }
        }

        if (audio.length > 0) {
          await fs.mkdir(edgeCacheDir, { recursive: true });
          const tmpCachePath = `${cachedMp3Path}.tmp.${process.pid}.${Date.now()}`;
          await fs.writeFile(tmpCachePath, audio);
          await fs.rename(tmpCachePath, cachedMp3Path);
        }

        const mimeType = 'audio/mpeg';
        const durationSec = await measureAudioDurationSec(audio, mimeType);
        const ms = Date.now() - startedAt;

        console.log(
          `[TTS Result] engine=edge backend=${edgeTtsRuntime.backend} voice=${req.voice} ok=true bytes=${audio.length} duration_s=${durationSec} ms=${ms}`,
        );
        return { audio, mimeType, durationSec, ms };
      } catch (err) {
        const ms = Date.now() - startedAt;
        const msg = err instanceof Error ? err.message : String(err);
        if (!req.interactive) {
          console.warn(
            `[Edge TTS] Single-line synthesis failed after 3 retries (${msg}); generating 0.5s silent fallback audio.`,
          );
          const silentAudio = createSilentHalfSecAudioBuffer('.mp3');
          try {
            await fs.mkdir(edgeCacheDir, { recursive: true });
            const tmpCachePath = `${cachedMp3Path}.tmp.${process.pid}.${Date.now()}`;
            await fs.writeFile(tmpCachePath, silentAudio);
            await fs.rename(tmpCachePath, cachedMp3Path);
          } catch {
            // non-fatal cache write error
          }
          return {
            audio: silentAudio,
            mimeType: 'audio/mpeg',
            durationSec: 0.5,
            ms,
          };
        }
        console.error(
          `[TTS Result] engine=edge backend=${edgeTtsRuntime.backend} voice=${req.voice} ok=false ms=${ms} error=${msg}`,
        );
        throw err instanceof Error ? err : new Error(msg);
      }
    });
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    if (isF5MyanmarEnvSelected() && isBurmeseTtsRequest(req)) {
      return f5MyanmarTtsEngine.synthesize(req);
    }
    return this.synthesizeDirect(req);
  }
}

function ensureWavBuffer(rawBuf: Buffer, rawMimeType?: string): { wav: Buffer; mimeType: string } {
  const isAlreadyWav =
    rawBuf.length >= 12 &&
    rawBuf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    rawBuf.subarray(8, 12).toString('ascii') === 'WAVE';

  if (isAlreadyWav) {
    return { wav: rawBuf, mimeType: 'audio/wav' };
  }

  let sampleRate = 24000;
  let channels = 1;
  const bitsPerSample = 16;

  if (rawMimeType) {
    const rateMatch = /rate=(\d+)/i.exec(rawMimeType);
    if (rateMatch) {
      const parsedRate = Number.parseInt(rateMatch[1], 10);
      if (Number.isFinite(parsedRate) && parsedRate > 0) sampleRate = parsedRate;
    }
    const chanMatch = /channels=(\d+)/i.exec(rawMimeType);
    if (chanMatch) {
      const parsedChan = Number.parseInt(chanMatch[1], 10);
      if (Number.isFinite(parsedChan) && parsedChan > 0) channels = parsedChan;
    }
  }

  const dataSize = rawBuf.length;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return {
    wav: Buffer.concat([header, rawBuf]),
    mimeType: 'audio/wav',
  };
}

let lastGeminiTtsFinishedAt = 0;

export class GeminiTtsEngine implements TtsEngine {
  readonly id = 'gemini' as const;

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const cfg = getConfig();
    const startedAt = Date.now();
    const primaryModel = (req.model?.trim() || cfg.TTS_MODEL || '').replace(/^models\//, '').trim();
    if (!primaryModel) {
      throw new Error('TTS_MODEL is not configured in Settings.');
    }
    const minSpacingMs = cfg.GEMINI_TTS_MIN_SPACING_MS ?? 3500;
    const projectId = req.projectId || '__preview__';
    const jobHash = req.jobHash || hashString(`${req.text}|${req.voice}|${primaryModel}`);
    const jobLabel = req.jobLabel || `Gemini TTS (${req.voice})`;

    console.log(
      `[TTS Request] engine=gemini apiVersion=v1beta model=${primaryModel} voice=${req.voice} textLen=${req.text.length} text=${JSON.stringify(req.text.slice(0, 60))}`,
    );

    try {
      const { result } = await withExponentialBackoffRetry(
        () =>
          executeResilientGeminiCall<TtsSynthesizeResult>({
            projectId,
            kind: 'dub_tts_clip',
            label: jobLabel,
            hash: jobHash,
            queueName: 'geminiTts',
            primaryModel,
            fallbackModels: cfg.TTS_FALLBACK_MODELS,
            clientMode: 'tts',
            interactive: Boolean(req.interactive),
            recordJob: !req.interactive && Boolean(req.projectId),
            force: Boolean(req.force),
            maxNetworkWaitAttempts: 1,
            maxQuotaWaitAttempts: 1,
            onWaiting: (info) => {
              if (req.projectId) {
                emitProjectEvent(req.projectId, {
                  type: 'stage',
                  stage: 'dub',
                  message: info.message,
                });
              }
            },
            onResult: async (ttsRes) => {
              if (req.onAudioReady) {
                await req.onAudioReady(ttsRes);
              }
            },
            call: async ({ ai, modelId }) => {
              const elapsedSinceLast = Date.now() - lastGeminiTtsFinishedAt;
              if (lastGeminiTtsFinishedAt > 0 && elapsedSinceLast < minSpacingMs) {
                await new Promise((resolve) => setTimeout(resolve, minSpacingMs - elapsedSinceLast));
              }

              const attemptStart = Date.now();
              const sdkRequestPayload = {
                model: modelId,
                contents: [
                  {
                    role: 'user',
                    parts: [{ text: req.text }],
                  },
                ],
                config: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: req.voice,
                      },
                    },
                  },
                },
              };

              try {
                const response = await withTimeout(
                  ai.models.generateContent(sdkRequestPayload),
                  GEMINI_TTS_TIMEOUT_MS,
                  `Gemini TTS (${modelId}) for voice "${req.voice}"`,
                );

                const parts = response.candidates?.[0]?.content?.parts ?? [];
                const audioPart = parts.find((p) => p.inlineData?.data);
                const base64Audio = audioPart?.inlineData?.data;
                if (!base64Audio) {
                  const textFallback = response.text?.trim();
                  throw new Error(
                    textFallback
                      ? `Gemini TTS (${modelId}) did not return audio: ${textFallback}`
                      : `Gemini TTS (${modelId}) returned no audio data for voice "${req.voice}".`,
                  );
                }

                const rawAudio = Buffer.from(base64Audio, 'base64');
                const { wav: audio, mimeType } = ensureWavBuffer(
                  rawAudio,
                  audioPart?.inlineData?.mimeType,
                );
                const durationSec = await measureAudioDurationSec(audio, mimeType);
                const ms = Date.now() - attemptStart;

                console.log(
                  `[TTS Result] engine=gemini model=${modelId} voice=${req.voice} ok=true bytes=${audio.length} duration_s=${durationSec} ms=${ms}`,
                );
                return { audio, mimeType, durationSec, ms, model: modelId };
              } finally {
                lastGeminiTtsFinishedAt = Date.now();
              }
            },
          }),
        {
          maxAttempts: Math.max(1, req.maxRetries ?? 3),
          baseDelayMs: 1000,
          factor: 2,
          label: `Gemini TTS (${req.voice})`,
        },
      );

      return result;
    } catch (err) {
      const ms = Date.now() - startedAt;
      const cleanErr = redactSecrets(err instanceof Error ? err.message : String(err));
      console.error(
        `[TTS Result] engine=gemini model=${primaryModel} voice=${req.voice} ok=false ms=${ms} error=${cleanErr}`,
      );
      throw new Error(cleanErr);
    }
  }
}

const F5_TTS_TIMEOUT_MS = 120_000;

async function resolveSegmentEmotion(req: TtsSynthesizeRequest): Promise<ScriptEmotion> {
  if (req.emotion) return req.emotion;
  if (req.projectId && req.projectId !== '__preview__') {
    try {
      const project = await getProject(req.projectId);
      if (project) {
        const needle = req.text.trim();
        const recapMatch = project.recap.find(
          (b) => b.emotion && b.narration_text.trim() === needle,
        );
        if (recapMatch?.emotion) return recapMatch.emotion;

        const dubMatch = project.dub.find(
          (d) => d.emotion && d.tgt_text.trim() === needle,
        );
        if (dubMatch?.emotion) return dubMatch.emotion;

        const speechMatch = project.speech.find(
          (s) => s.emotion && s.text.trim() === needle,
        );
        if (speechMatch?.emotion) return speechMatch.emotion;
      }
    } catch {
      // ignore project lookup errors and fall back to neutral
    }
  }
  return 'neutral';
}

function isWavBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

async function encodeAudioBufferToMp3(rawAudio: Buffer, contentType: string): Promise<Buffer> {
  const looksLikeMp3 =
    !isWavBuffer(rawAudio) &&
    (contentType.includes('mpeg') ||
      contentType.includes('mp3') ||
      (rawAudio.length >= 3 && rawAudio.subarray(0, 3).toString('ascii') === 'ID3') ||
      (rawAudio.length >= 2 && rawAudio[0] === 0xff && (rawAudio[1] & 0xe0) === 0xe0));

  if (looksLikeMp3) {
    return rawAudio;
  }

  const bin = getBinaryStatus();
  if (!bin.ok || !bin.ffmpegPath) {
    throw new Error('FFmpeg unavailable to encode Kaggle TTS audio into MP3 cache.');
  }

  const ext = isWavBuffer(rawAudio) ? 'wav' : 'audio';
  const tmpIn = path.join(
    os.tmpdir(),
    `f5_in_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`,
  );
  const tmpOut = path.join(
    os.tmpdir(),
    `f5_out_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`,
  );

  try {
    await fs.writeFile(tmpIn, rawAudio);
    const res = await spawnCommand(
      bin.ffmpegPath,
      ['-y', '-i', tmpIn, '-vn', '-codec:a', 'libmp3lame', '-b:a', '192k', tmpOut],
      { timeoutMs: 20_000 },
    );
    if (res.code !== 0) {
      throw new Error(`FFmpeg MP3 transcode failed: ${res.stderr.slice(-500)}`);
    }
    const mp3Buf = await fs.readFile(tmpOut);
    if (mp3Buf.length === 0) {
      throw new Error('FFmpeg MP3 transcode produced an empty file.');
    }
    return mp3Buf;
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

export class F5MyanmarTtsEngine implements TtsEngine {
  readonly id = 'f5-myanmar' as const;

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const startedAt = Date.now();
    const emotion = await resolveSegmentEmotion(req);
    const cacheDir =
      req.projectId && req.projectId !== '__preview__'
        ? getProjectPaths(req.projectId).cacheDir
        : path.join(os.tmpdir(), 'f5_myanmar_tts_cache');
    const cacheHash = hashString(`f5-myanmar|${req.text}|${emotion}`);
    const cachedMp3Path = path.join(cacheDir, `tts_f5_${cacheHash}.mp3`);

    if (!req.force) {
      try {
        const cachedMp3 = await fs.readFile(cachedMp3Path);
        if (cachedMp3.length > 0) {
          const durationSec = await measureAudioDurationSec(cachedMp3, 'audio/mpeg');
          const ms = Date.now() - startedAt;
          console.log(
            `[TTS Result] engine=f5-myanmar cache=hit emotion=${emotion} bytes=${cachedMp3.length} duration_s=${durationSec} ms=${ms}`,
          );
          return {
            audio: cachedMp3,
            mimeType: 'audio/mpeg',
            durationSec,
            ms,
            model: 'f5-myanmar',
          };
        }
      } catch {
        // cache miss
      }
    }

    const cfg = getConfig();
    const kaggleUrl = (
      cfg.demucsRemoteUrl ||
      process.env.KAGGLE_TUNNEL_URL ||
      process.env.DEMUCS_REMOTE_URL ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');

    if (!kaggleUrl) {
      console.warn(
        `[F5-Myanmar TTS] Kaggle Tunnel URL is not configured; falling back to Edge TTS for segment.`,
      );
      return edgeTtsEngine.synthesizeDirect(req);
    }

    console.log(
      `[TTS Request] engine=f5-myanmar endpoint=${kaggleUrl}/tts emotion=${emotion} textLen=${req.text.length} text=${JSON.stringify(req.text.slice(0, 60))}`,
    );

    try {
      const response = await fetch(`${kaggleUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'close',
        },
        body: JSON.stringify({
          text: req.text,
          emotion,
        }),
        signal: AbortSignal.timeout(F5_TTS_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(
          `Kaggle /tts HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
        );
      }

      const rawBuf = Buffer.from(await response.arrayBuffer());
      if (rawBuf.length === 0) {
        throw new Error('Kaggle /tts returned an empty audio buffer.');
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const mp3Buf = await encodeAudioBufferToMp3(rawBuf, contentType);

      await fs.mkdir(cacheDir, { recursive: true });
      const tmpCachePath = `${cachedMp3Path}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmpCachePath, mp3Buf);
      await fs.rename(tmpCachePath, cachedMp3Path);

      const durationSec = await measureAudioDurationSec(mp3Buf, 'audio/mpeg');
      const ms = Date.now() - startedAt;

      console.log(
        `[TTS Result] engine=f5-myanmar emotion=${emotion} ok=true bytes=${mp3Buf.length} duration_s=${durationSec} ms=${ms}`,
      );
      return {
        audio: mp3Buf,
        mimeType: 'audio/mpeg',
        durationSec,
        ms,
        model: 'f5-myanmar',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[F5-Myanmar TTS] Kaggle tunnel failed/timed out (${msg}); gracefully falling back to Edge TTS.`,
      );
      return edgeTtsEngine.synthesizeDirect(req);
    }
  }
}

export const edgeTtsEngine = new EdgeTtsEngine();
export const geminiTtsEngine = new GeminiTtsEngine();
export const f5MyanmarTtsEngine = new F5MyanmarTtsEngine();

export function getTtsEngine(engine: TtsEngineType | TtsProvider): TtsEngine {
  if (engine === 'gemini') return geminiTtsEngine;
  if (engine === 'f5-myanmar') return f5MyanmarTtsEngine;
  return edgeTtsEngine;
}

