import JSZip from 'jszip';
import type { Project } from '../../shared/projectTypes';
import { apiFetchJson } from './apiClient';

const DB_NAME = 'kinetix_studio_backup_v1';
const DB_VERSION = 1;
const STORE_NAME = 'backups';
const BACKUP_DEBOUNCE_MS = 10_000;

export interface BrowserBackupRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  saved_at: string;
  project: Project;
  cacheJson: Record<string, unknown>;
  clips: Record<string, ArrayBuffer>;
  clipMeta?: Record<string, { tts_ms?: number }>;
}

function openBackupDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'));
  });
}

export async function listBrowserBackups(): Promise<BrowserBackupRecord[]> {
  try {
    const db = await openBackupDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = Array.isArray(req.result) ? (req.result as BrowserBackupRecord[]) : [];
        items.sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
        resolve(items);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll failed.'));
      tx.oncomplete = () => db.close();
    });
  } catch {
    return [];
  }
}

export async function getBrowserBackup(projectId: string): Promise<BrowserBackupRecord | null> {
  try {
    const db = await openBackupDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(projectId);
      req.onsuccess = () => resolve((req.result as BrowserBackupRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed.'));
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function putBrowserBackup(record: BrowserBackupRecord): Promise<void> {
  const db = await openBackupDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('IndexedDB put failed.'));
    tx.oncomplete = () => db.close();
  });
}

export async function deleteBrowserBackup(projectId: string): Promise<void> {
  try {
    const db = await openBackupDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(projectId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed.'));
      tx.oncomplete = () => db.close();
    });
  } catch {
    // ignore
  }
}

const activeSyncs = new Set<string>();
const pendingProjects = new Map<string, Project>();
const syncWaiters = new Map<string, Array<(savedAt: string) => void>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastWriteTimestamps = new Map<string, number>();

async function performProjectSync(initialProject: Project): Promise<string> {
  let targetProject = initialProject;
  try {
    const snapRes = await apiFetchJson<{ project?: Project; cacheJson?: Record<string, unknown> }>(
      `/api/projects/${encodeURIComponent(targetProject.id)}/snapshot`,
      { cache: 'no-store' },
    );
    if (snapRes.ok && snapRes.data.project) {
      targetProject = snapRes.data.project;
    }

    // Store lightweight JSON metadata only — never buffer large binary video/WAV blobs in JS RAM or IndexedDB
    const cacheJson: Record<string, unknown> =
      snapRes.ok && snapRes.data.cacheJson ? snapRes.data.cacheJson : {};

    const savedAt = new Date().toISOString();
    const record: BrowserBackupRecord = {
      id: targetProject.id,
      title: targetProject.title,
      created_at: targetProject.created_at,
      updated_at: targetProject.updated_at,
      saved_at: savedAt,
      project: targetProject,
      cacheJson,
      clips: {},
      clipMeta: {},
    };

    await putBrowserBackup(record);
    lastWriteTimestamps.set(targetProject.id, Date.now());
    return savedAt;
  } catch {
    return new Date().toISOString();
  }
}

function flushDebouncedSync(projectId: string): void {
  if (activeSyncs.has(projectId)) {
    return;
  }
  if (!pendingProjects.has(projectId)) {
    return;
  }

  activeSyncs.add(projectId);
  void (async () => {
    let lastSavedAt = new Date().toISOString();
    try {
      const nextProj = pendingProjects.get(projectId);
      pendingProjects.delete(projectId);
      if (nextProj) {
        lastSavedAt = await performProjectSync(nextProj);
      }
    } finally {
      activeSyncs.delete(projectId);
      if (pendingProjects.has(projectId)) {
        // More updates arrived while writing: respect the 10-second throttle before next write
        scheduleProjectSync(projectId);
      } else {
        const list = syncWaiters.get(projectId) ?? [];
        syncWaiters.delete(projectId);
        for (const fn of list) fn(lastSavedAt);
      }
    }
  })();
}

function scheduleProjectSync(projectId: string): void {
  if (debounceTimers.has(projectId) || activeSyncs.has(projectId)) {
    return;
  }
  const lastTs = lastWriteTimestamps.get(projectId) ?? 0;
  const elapsed = Date.now() - lastTs;
  const waitMs = Math.max(0, BACKUP_DEBOUNCE_MS - elapsed);

  const timer = setTimeout(() => {
    debounceTimers.delete(projectId);
    flushDebouncedSync(projectId);
  }, waitMs);
  debounceTimers.set(projectId, timer);
}

export function syncProjectToBrowserBackup(project: Project): Promise<string> {
  pendingProjects.set(project.id, project);

  return new Promise<string>((resolve) => {
    const waiters = syncWaiters.get(project.id) ?? [];
    waiters.push(resolve);
    syncWaiters.set(project.id, waiters);
    scheduleProjectSync(project.id);
  });
}

export async function restoreZipBlobToServer(
  blob: Blob,
  overwrite = false,
): Promise<{ project: Project; restoredFiles: number }> {
  const res = await apiFetchJson<{ project?: Project; restoredFiles?: number; error?: string }>(
    `/api/projects/restore${overwrite ? '?overwrite=1' : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    },
  );
  if (!res.ok || !res.data.project) {
    throw new Error(res.data?.error || 'Failed to restore project ZIP.');
  }
  return {
    project: res.data.project,
    restoredFiles: res.data.restoredFiles ?? 0,
  };
}

export async function restoreBrowserBackupToServer(
  backup: BrowserBackupRecord,
): Promise<{ project: Project; restoredFiles: number }> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(backup.project, null, 2));
  zip.file(
    'translations.json',
    JSON.stringify(
      {
        project_id: backup.project.id,
        target_langs: backup.project.target_langs,
        dub_selection: backup.project.dub_selection,
        dub_glossary: backup.project.dub_glossary,
        calibrated_sps: backup.project.calibrated_sps,
        cues: backup.project.dub,
      },
      null,
      2,
    ),
  );
  zip.file('speakers.json', JSON.stringify(backup.project.speakers, null, 2));

  for (const [name, data] of Object.entries(backup.cacheJson || {})) {
    zip.file(`cache/${name}`, JSON.stringify(data, null, 2));
  }
  for (const [relPath, buf] of Object.entries(backup.clips || {})) {
    zip.file(relPath, buf);
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return restoreZipBlobToServer(zipBlob, true);
}
