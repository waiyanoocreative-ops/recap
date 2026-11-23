import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { getProjectPaths } from '../storage/projectStore.ts';

export function hashString(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
}

/**
 * Computes a deterministic SHA-256 fingerprint for a media file + extra config parameters.
 * Streams full files <= 25 MB; samples head + middle + tail + file size for large video files.
 */
export async function hashFileWithSalt(filePath: string, salt: string): Promise<string> {
  const stat = await fs.stat(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(`size:${stat.size}|salt:${salt}|`);

  if (stat.size <= 25 * 1024 * 1024) {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return hash.digest('hex').slice(0, 24);
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const sampleSize = 1024 * 1024;
    const buf = Buffer.allocUnsafe(sampleSize);
    const offsets = [0, Math.floor(stat.size / 2), Math.max(0, stat.size - sampleSize)];
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buf, 0, sampleSize, offset);
      if (bytesRead > 0) {
        hash.update(buf.subarray(0, bytesRead));
      }
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex').slice(0, 24);
}

export async function readProjectCache<T>(
  projectId: string,
  cacheKey: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const paths = getProjectPaths(projectId);
  const cachePath = path.join(paths.cacheDir, `${cacheKey}.json`);
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = schema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export async function writeProjectCache<T>(
  projectId: string,
  cacheKey: string,
  data: T,
): Promise<void> {
  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.cacheDir, { recursive: true });
  const cachePath = path.join(paths.cacheDir, `${cacheKey}.json`);
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, cachePath);
}
