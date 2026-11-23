import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectSchema, type Project, type ProjectMode, type TargetLang } from '../../shared/projectTypes.ts';
import { getConfig } from '../config.ts';

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
);
export const DATA_ROOT = path.join(DATA_DIR, 'projects');

const writeLocks = new Map<string, Promise<unknown>>();

function withProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeLocks.set(
    projectId,
    next.finally(() => {
      if (writeLocks.get(projectId) === next) {
        writeLocks.delete(projectId);
      }
    }),
  );
  return next;
}

export interface ProjectPaths {
  root: string;
  projectJson: string;
  sourceDir: string;
  workDir: string;
  windowsDir: string;
  samplesDir: string;
  dubDir: string;
  cacheDir: string;
  chunksDir: string;
  outDir: string;
}

export function getProjectPaths(projectId: string): ProjectPaths {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId || safeId !== projectId) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  const root = path.join(DATA_ROOT, safeId);
  return {
    root,
    projectJson: path.join(root, 'project.json'),
    sourceDir: path.join(root, 'source'),
    workDir: path.join(root, 'work'),
    windowsDir: path.join(root, 'work', 'windows'),
    samplesDir: path.join(root, 'work', 'samples'),
    dubDir: path.join(root, 'work', 'dub'),
    cacheDir: path.join(root, 'cache'),
    chunksDir: path.join(root, 'cache', 'chunks'),
    outDir: path.join(root, 'out'),
  };
}

export async function ensureDataRoot(): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
}

export async function ensureProjectDirs(projectId: string): Promise<ProjectPaths> {
  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.sourceDir, { recursive: true });
  await fs.mkdir(paths.workDir, { recursive: true });
  await fs.mkdir(paths.windowsDir, { recursive: true });
  await fs.mkdir(paths.samplesDir, { recursive: true });
  await fs.mkdir(paths.dubDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  await fs.mkdir(paths.chunksDir, { recursive: true });
  await fs.mkdir(paths.outDir, { recursive: true });
  return paths;
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const serialized = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, serialized, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export async function readJsonWithSchema<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function checkDiskSpace(requiredBytes = 0): Promise<{
  freeBytes: number;
  totalBytes: number;
  requiredBytes: number;
  sufficient: boolean;
}> {
  await ensureDataRoot();
  const stats = await fs.statfs(DATA_ROOT);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return {
    freeBytes,
    totalBytes,
    requiredBytes,
    sufficient: freeBytes >= requiredBytes,
  };
}

export async function generateNextProjectId(): Promise<string> {
  await ensureDataRoot();
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
  let maxNum = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const m = /^p_(\d+)$/.exec(entry.name);
      if (m) {
        maxNum = Math.max(maxNum, Number(m[1]));
      }
    }
  }
  const next = String(maxNum + 1).padStart(3, '0');
  return `p_${next}`;
}

export async function createProject(input: {
  title: string;
  mode: ProjectMode;
  target_langs: TargetLang[];
  id?: string;
}): Promise<Project> {
  const cfg = getConfig();
  const id = input.id ? input.id.replace(/[^a-zA-Z0-9_-]/g, '') : await generateNextProjectId();
  const paths = await ensureProjectDirs(id);
  const now = new Date().toISOString();

  const project: Project = ProjectSchema.parse({
    id,
    title: input.title.trim() || `Project ${id}`,
    mode: input.mode,
    target_langs: input.target_langs,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    no_dialogue: false,
    recap_mute_original: true,
    video: {
      filename: '',
      size_bytes: 0,
      fps: 0,
      width: 0,
      height: 0,
      is_vfr: false,
      duration_ms: 0,
      v_start_ms: 0,
      a_start_ms: 0,
      stream_offset_ms: 0,
      has_audio: true,
    },
    upload: {
      total_chunks: 0,
      received_chunks: [],
      chunk_size_bytes: cfg.CHUNK_SIZE_BYTES,
      expected_size_bytes: 0,
      completed: false,
    },
    stages: {
      ingest: { status: 'pending', progress_pct: 0 },
      maps: { status: 'pending', progress_pct: 0 },
      speech: { status: 'pending', progress_pct: 0 },
      speakers: { status: 'pending', progress_pct: 0 },
      dub: { status: 'pending', progress_pct: 0 },
    },
    stage_hashes: {},
    speech: [],
    speakers: {},
    silence_ms: [],
    scene_cuts_ms: [],
    dub_selection: {
      mode: 'first_n',
      count: 8,
      start_idx: 1,
      end_idx: 8,
    },
    dub_glossary: {},
    calibrated_sps: {},
    dub: [],
    dub_reports: [],
    chunks: [],
    recap: [],
  });

  await atomicWriteJson(paths.projectJson, project);
  return project;
}

export async function getProject(projectId: string): Promise<Project | null> {
  const paths = getProjectPaths(projectId);
  const parsed = await readJsonWithSchema(paths.projectJson, ProjectSchema);
  return parsed;
}

export async function updateProject(
  projectId: string,
  mutator: (current: Project) => Project | Promise<Project>,
): Promise<Project> {
  return withProjectLock(projectId, async () => {
    const current = await getProject(projectId);
    if (!current) {
      throw new Error(`Project "${projectId}" not found.`);
    }
    const updated = await mutator(current);
    const nowIso = new Date().toISOString();
    updated.updated_at = nowIso;
    updated.last_saved_at = nowIso;
    const validated = ProjectSchema.parse(updated);
    const paths = getProjectPaths(projectId);
    await atomicWriteJson(paths.projectJson, validated);
    return validated;
  });
}

export async function listProjects(): Promise<Project[]> {
  await ensureDataRoot();
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const proj = await getProject(entry.name);
    if (proj) {
      projects.push(proj);
    }
  }
  projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return projects;
}

export async function resetInterruptedStagesOnStartup(): Promise<void> {
  const projects = await listProjects();
  for (const proj of projects) {
    let changed = false;
    for (const key of ['ingest', 'maps', 'speech', 'speakers', 'dub'] as const) {
      if (proj.stages[key].status === 'running') {
        proj.stages[key] = {
          ...proj.stages[key],
          status: 'pending',
          message: 'Interrupted by server restart — ready to resume from checkpoint.',
          updated_at: new Date().toISOString(),
        };
        changed = true;
      }
    }
    if (proj.chunks.some((c) => c.status === 'running')) {
      proj.chunks = proj.chunks.map((c) =>
        c.status === 'running' ? { ...c, status: 'pending' } : c,
      );
      changed = true;
    }
    if (proj.chunk_progress?.active) {
      proj.chunk_progress = {
        ...proj.chunk_progress,
        active: false,
        phase: 'error',
        message: 'Interrupted by server restart — ready to resume from last unfinished chunk.',
      };
      changed = true;
    }
    if (changed) {
      const paths = getProjectPaths(proj.id);
      await atomicWriteJson(paths.projectJson, proj);
    }
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const paths = getProjectPaths(projectId);
  await fs.rm(paths.root, { recursive: true, force: true });
}

async function measureDirStats(dirPath: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await measureDirStats(fullPath);
        bytes += sub.bytes;
        files += sub.files;
      } else if (entry.isFile()) {
        files += 1;
        try {
          const st = await fs.stat(fullPath);
          bytes += st.size;
        } catch {
          // ignore stat race
        }
      }
    }
  } catch {
    // directory may not exist
  }
  return { bytes, files };
}

export interface CleanupWorkCacheResult {
  projectId: string;
  workDir: string;
  freedBytes: number;
  removedFiles: number;
  preservedOutFiles: string[];
}

export async function cleanupProjectWorkCache(projectId: string): Promise<CleanupWorkCacheResult> {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found.`);
    }
    const paths = getProjectPaths(projectId);
    const resolvedRoot = path.resolve(paths.root);
    const resolvedWork = path.resolve(paths.workDir);
    if (!resolvedWork.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Refusing unsafe work directory cleanup outside project root: ${resolvedWork}`);
    }

    const beforeStats = await measureDirStats(resolvedWork);

    // Delete all temporary intermediate files inside ./data/projects/:id/work/
    // (chunk videos, raw .wav files, stems, temp TTS segments, proxy video)
    // while strictly preserving ./data/projects/:id/out/ and project.json.
    try {
      const workEntries = await fs.readdir(resolvedWork, { withFileTypes: true });
      for (const entry of workEntries) {
        const target = path.join(resolvedWork, entry.name);
        await fs.rm(target, { recursive: true, force: true });
      }
    } catch {
      // workDir may not exist yet
    }

    // Re-create empty standard work subdirectories so project layout remains valid
    await fs.mkdir(paths.workDir, { recursive: true });
    await fs.mkdir(paths.windowsDir, { recursive: true });
    await fs.mkdir(paths.samplesDir, { recursive: true });
    await fs.mkdir(paths.dubDir, { recursive: true });

    let preservedOutFiles: string[] = [];
    try {
      const outEntries = await fs.readdir(paths.outDir, { withFileTypes: true });
      preservedOutFiles = outEntries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      preservedOutFiles = [];
    }

    return {
      projectId,
      workDir: paths.workDir,
      freedBytes: beforeStats.bytes,
      removedFiles: beforeStats.files,
      preservedOutFiles,
    };
  });
}

export async function readProjectSnapshot(projectId: string): Promise<{
  project: Project;
  cacheJson: Record<string, unknown>;
} | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const paths = getProjectPaths(projectId);
  const cacheJson: Record<string, unknown> = {};
  try {
    const entries = await fs.readdir(paths.cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(paths.cacheDir, entry.name), 'utf-8');
        cacheJson[entry.name] = JSON.parse(raw) as unknown;
      } catch {
        // Skip unreadable cache entry
      }
    }
  } catch {
    // cache dir may not exist yet
  }
  return { project, cacheJson };
}
