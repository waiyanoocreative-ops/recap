import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface PythonWhisperStatus {
  available: boolean;
  pythonPath: string | null;
  hasTransformers: boolean;
  hasTorch: boolean;
  hasFasterWhisper: boolean;
  backend: 'transformers' | 'faster_whisper' | 'none';
}

export interface BinaryStatus {
  ok: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  source: 'system' | 'static' | 'missing';
  error: string | null;
  demucsAvailable: boolean;
  demucsPath: string | null;
  pythonWhisper?: PythonWhisperStatus;
}

let cachedStatus: BinaryStatus | null = null;
let cachedWhisperStatus: PythonWhisperStatus | null = null;

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnCommand(
  command: string,
  args: string[],
  options?: {
    onStderrLine?: (line: string) => void;
    onStdoutLine?: (line: string) => void;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options?.env ? { env: options.env } : {}),
    });

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    const timer = options?.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`Command timed out after ${options.timeoutMs} ms: ${command}`));
          }
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      if (options?.onStdoutLine) {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) options.onStdoutLine(line);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      if (options?.onStderrLine) {
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n|\r/);
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) options.onStderrLine(line);
        }
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (stdoutBuffer.trim() && options?.onStdoutLine) {
        options.onStdoutLine(stdoutBuffer);
      }
      if (stderrBuffer.trim() && options?.onStderrLine) {
        options.onStderrLine(stderrBuffer);
      }
      if (!settled) {
        settled = true;
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
        });
      }
    });
  });
}

async function testBinary(binPath: string, args: string[]): Promise<{ ok: boolean; firstLine: string | null }> {
  try {
    const res = await spawnCommand(binPath, args, { timeoutMs: 8000 });
    if (res.code === 0) {
      const firstLine = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() || 'OK';
      return { ok: true, firstLine };
    }
    return { ok: false, firstLine: null };
  } catch {
    return { ok: false, firstLine: null };
  }
}

export const COMMON_PYTHON_BIN_DIRS = [
  '/Library/Frameworks/Python.framework/Versions/3.12/bin',
  '/Library/Frameworks/Python.framework/Versions/3.13/bin',
  '/Library/Frameworks/Python.framework/Versions/3.11/bin',
  '/Library/Frameworks/Python.framework/Versions/3.10/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), 'Library/Python/3.12/bin'),
  path.join(os.homedir(), 'Library/Python/3.13/bin'),
  path.join(os.homedir(), 'Library/Python/3.11/bin'),
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), 'miniconda3/bin'),
  path.join(os.homedir(), 'anaconda3/bin'),
];

export async function resolveDemucsBinaryPath(): Promise<string | null> {
  const pathCheck = await testBinary('demucs', ['--help']);
  if (pathCheck.ok) {
    return 'demucs';
  }

  for (const dir of COMMON_PYTHON_BIN_DIRS) {
    const candidate = path.join(dir, 'demucs');
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const check = await testBinary(candidate, ['--help']);
    if (check.ok) {
      return candidate;
    }
  }

  return null;
}

const PYTHON_WHISPER_PROBE_CODE = [
  'import json',
  'res = {"torch": False, "transformers": False, "faster_whisper": False}',
  'try:\n import torch\n res["torch"] = True\nexcept Exception:\n pass',
  'try:\n import transformers\n res["transformers"] = True\nexcept Exception:\n pass',
  'try:\n import faster_whisper\n res["faster_whisper"] = True\nexcept Exception:\n pass',
  'print(json.dumps(res))',
].join('\n');

async function probePythonWhisperAtPath(pythonBin: string): Promise<PythonWhisperStatus | null> {
  try {
    const res = await spawnCommand(pythonBin, ['-c', PYTHON_WHISPER_PROBE_CODE], {
      timeoutMs: 12_000,
    });
    if (res.code !== 0) return null;
    const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? '';
    const parsed = JSON.parse(lastLine) as {
      torch?: boolean;
      transformers?: boolean;
      faster_whisper?: boolean;
    };
    const hasTorch = Boolean(parsed.torch);
    const hasTransformers = Boolean(parsed.transformers);
    const hasFasterWhisper = Boolean(parsed.faster_whisper);
    const backend: PythonWhisperStatus['backend'] =
      hasTransformers && hasTorch ? 'transformers' : hasFasterWhisper ? 'faster_whisper' : 'none';
    return {
      available: backend !== 'none',
      pythonPath: pythonBin,
      hasTransformers,
      hasTorch,
      hasFasterWhisper,
      backend,
    };
  } catch {
    return null;
  }
}

export async function detectPythonWhisper(forceRefresh = false): Promise<PythonWhisperStatus> {
  if (cachedWhisperStatus && !forceRefresh) {
    return cachedWhisperStatus;
  }

  const candidates: string[] = [];
  const envPython = process.env.WHISPER_PYTHON_PATH?.trim() || process.env.PYTHON_BIN?.trim();
  if (envPython) candidates.push(envPython);

  const cwdVenvPython3 = path.join(process.cwd(), '.venv', 'bin', 'python3');
  const cwdVenvPython = path.join(process.cwd(), 'venv', 'bin', 'python3');
  candidates.push(cwdVenvPython3, cwdVenvPython, 'python3', 'python');

  for (const dir of COMMON_PYTHON_BIN_DIRS) {
    candidates.push(path.join(dir, 'python3'));
    candidates.push(path.join(dir, 'python'));
  }

  const seen = new Set<string>();
  let fallbackFoundPython: PythonWhisperStatus | null = null;

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

    const status = await probePythonWhisperAtPath(candidate);
    if (!status) continue;

    if (status.available) {
      cachedWhisperStatus = status;
      return status;
    }
    if (!fallbackFoundPython) {
      fallbackFoundPython = status;
    }
  }

  cachedWhisperStatus = fallbackFoundPython ?? {
    available: false,
    pythonPath: null,
    hasTransformers: false,
    hasTorch: false,
    hasFasterWhisper: false,
    backend: 'none',
  };
  return cachedWhisperStatus;
}

export function getPythonWhisperStatus(): PythonWhisperStatus {
  if (!cachedWhisperStatus) {
    return {
      available: false,
      pythonPath: null,
      hasTransformers: false,
      hasTorch: false,
      hasFasterWhisper: false,
      backend: 'none',
    };
  }
  return cachedWhisperStatus;
}

export async function checkMediaBinariesAtStartup(): Promise<BinaryStatus> {
  if (cachedStatus) return cachedStatus;

  let ffmpegPath: string | null = null;
  let ffprobePath: string | null = null;
  let ffmpegVersion: string | null = null;
  let ffprobeVersion: string | null = null;
  let source: 'system' | 'static' | 'missing' = 'missing';

  const sysFfmpeg = await testBinary('ffmpeg', ['-version']);
  const sysFfprobe = await testBinary('ffprobe', ['-version']);

  if (sysFfmpeg.ok && sysFfprobe.ok) {
    ffmpegPath = 'ffmpeg';
    ffprobePath = 'ffprobe';
    ffmpegVersion = sysFfmpeg.firstLine;
    ffprobeVersion = sysFfprobe.firstLine;
    source = 'system';
  } else {
    let staticFfmpegPath: string | null = null;
    let staticFfprobePath: string | null = null;

    if (!sysFfmpeg.ok) {
      try {
        const mod = (await import('ffmpeg-static')) as { default?: string | null } | string;
        const resolved = typeof mod === 'string' ? mod : mod?.default;
        staticFfmpegPath = typeof resolved === 'string' ? resolved : null;
      } catch (err) {
        console.error('[Media Binaries] Dynamic import of ffmpeg-static failed:', err);
      }
    }

    if (!sysFfprobe.ok) {
      try {
        const mod = (await import('ffprobe-static')) as {
          default?: { path?: string };
          path?: string;
        };
        const resolved = mod?.path ?? mod?.default?.path;
        staticFfprobePath = typeof resolved === 'string' ? resolved : null;
      } catch (err) {
        console.error('[Media Binaries] Dynamic import of ffprobe-static failed:', err);
      }
    }

    const statFfmpeg = staticFfmpegPath
      ? await testBinary(staticFfmpegPath, ['-version'])
      : { ok: false, firstLine: null };
    const statFfprobe = staticFfprobePath
      ? await testBinary(staticFfprobePath, ['-version'])
      : { ok: false, firstLine: null };

    if (sysFfmpeg.ok) {
      ffmpegPath = 'ffmpeg';
      ffmpegVersion = sysFfmpeg.firstLine;
    } else if (statFfmpeg.ok && staticFfmpegPath) {
      ffmpegPath = staticFfmpegPath;
      ffmpegVersion = statFfmpeg.firstLine;
    }

    if (sysFfprobe.ok) {
      ffprobePath = 'ffprobe';
      ffprobeVersion = sysFfprobe.firstLine;
    } else if (statFfprobe.ok && staticFfprobePath) {
      ffprobePath = staticFfprobePath;
      ffprobeVersion = statFfprobe.firstLine;
    }

    if (ffmpegPath && ffprobePath) {
      source = sysFfmpeg.ok && sysFfprobe.ok ? 'system' : 'static';
    }
  }

  const demucsPath = await resolveDemucsBinaryPath();
  const pythonWhisper = await detectPythonWhisper();

  const missing: string[] = [];
  if (!ffmpegPath) missing.push('ffmpeg');
  if (!ffprobePath) missing.push('ffprobe');

  const ok = Boolean(ffmpegPath && ffprobePath);
  const error = ok
    ? null
    : `Required media tool(s) failed startup verification: ${missing.join(', ')}. Install ffmpeg/ffprobe on PATH (e.g. brew install ffmpeg on macOS) and restart the server.`;

  cachedStatus = {
    ok,
    ffmpegPath,
    ffprobePath,
    ffmpegVersion,
    ffprobeVersion,
    source,
    error,
    demucsAvailable: Boolean(demucsPath),
    demucsPath,
    pythonWhisper,
  };

  return cachedStatus;
}

export function getBinaryStatus(): BinaryStatus {
  if (!cachedStatus) {
    throw new Error('Media binaries not checked yet. Call checkMediaBinariesAtStartup() first.');
  }
  return cachedStatus;
}

export function requireFfmpeg(): { ffmpeg: string; ffprobe: string } {
  const status = getBinaryStatus();
  if (!status.ok || !status.ffmpegPath || !status.ffprobePath) {
    throw new Error(status.error || 'ffmpeg and ffprobe are not available on this server.');
  }
  return {
    ffmpeg: status.ffmpegPath,
    ffprobe: status.ffprobePath,
  };
}
