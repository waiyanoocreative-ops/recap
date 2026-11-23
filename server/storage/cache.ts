import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, getProjectPaths } from './projectStore.ts';

export function computeHashKey(parts: Array<string | number | boolean | undefined>): string {
  const h = crypto.createHash('sha256');
  for (const part of parts) {
    h.update(String(part ?? ''));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 32);
}

export async function readCacheJson<T>(projectId: string, key: string): Promise<T | null> {
  const paths = getProjectPaths(projectId);
  const filePath = path.join(paths.cacheDir, `${key}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeCacheJson(projectId: string, key: string, data: unknown): Promise<string> {
  const paths = getProjectPaths(projectId);
  const filePath = path.join(paths.cacheDir, `${key}.json`);
  await atomicWriteJson(filePath, data);
  return filePath;
}
