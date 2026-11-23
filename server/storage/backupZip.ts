import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { ProjectSchema, type Project } from '../../shared/projectTypes.ts';
import { getBinaryStatus, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import {
  DATA_ROOT,
  atomicWriteJson,
  ensureProjectDirs,
  generateNextProjectId,
  getProject,
  getProjectPaths,
} from './projectStore.ts';

const TWO_HUNDRED_MB = 200 * 1024 * 1024;

async function collectFilesRecursive(
  baseDir: string,
  relPrefix: string,
): Promise<Array<{ relZipPath: string; absPath: string }>> {
  const out: Array<{ relZipPath: string; absPath: string }> = [];
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const absPath = path.join(baseDir, entry.name);
    const relZipPath = path.posix.join(relPrefix, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFilesRecursive(absPath, relZipPath);
      out.push(...sub);
    } else if (entry.isFile()) {
      out.push({ relZipPath, absPath });
    }
  }
  return out;
}

async function ensureProxyVideoIfNeeded(project: Project): Promise<void> {
  const paths = getProjectPaths(project.id);
  const proxyPath = path.join(paths.workDir, 'proxy_480p.mp4');
  if (await fileExists(proxyPath)) return;

  if (!project.video.filename) return;
  const sourcePath = path.join(paths.sourceDir, project.video.filename);
  if (!(await fileExists(sourcePath))) return;

  const bin = getBinaryStatus();
  if (!bin.ok || !bin.ffmpegPath) return;

  await fs.mkdir(paths.workDir, { recursive: true });
  const args = [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    'scale=-2:480',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    ...(project.video.has_audio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
    proxyPath,
  ];
  const res = await spawnCommand(bin.ffmpegPath, args);
  if (res.code === 0 && (await fileExists(proxyPath))) {
    const updated = {
      ...project,
      video: {
        ...project.video,
        proxy_480p_file: 'work/proxy_480p.mp4',
      },
    };
    await atomicWriteJson(paths.projectJson, updated);
  }
}

export async function createProjectBackupZip(params: {
  projectId: string;
  includeSource?: boolean;
}): Promise<{ zipBuffer: Buffer; filename: string; includedSource: boolean }> {
  const { projectId } = params;
  const initialProject = await getProject(projectId);
  if (!initialProject) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const includeSource =
    params.includeSource !== undefined
      ? params.includeSource
      : initialProject.video.size_bytes <= TWO_HUNDRED_MB;

  if (!includeSource) {
    await ensureProxyVideoIfNeeded(initialProject);
  }

  const project = (await getProject(projectId)) ?? initialProject;
  const paths = getProjectPaths(projectId);
  const zip = new JSZip();

  // 1. project.json + explicit translations.json + speakers.json
  zip.file('project.json', JSON.stringify(project, null, 2) + '\n');
  zip.file(
    'translations.json',
    JSON.stringify(
      {
        project_id: project.id,
        target_langs: project.target_langs,
        dub_selection: project.dub_selection,
        dub_glossary: project.dub_glossary,
        calibrated_sps: project.calibrated_sps,
        cues: project.dub,
      },
      null,
      2,
    ) + '\n',
  );
  zip.file('speakers.json', JSON.stringify(project.speakers, null, 2) + '\n');

  // 2. Proxy video + extracted WAVs + speaker samples + dub TTS clips
  const workFiles = await collectFilesRecursive(paths.workDir, 'work');
  for (const item of workFiles) {
    // Skip raw window splits if huge or temporary files; keep proxy, 16k/48k, samples, dub/clips
    if (item.relZipPath.endsWith('.tmp') || item.relZipPath.endsWith('.raw.pcm')) continue;
    if (item.relZipPath.startsWith('work/windows/') && item.relZipPath.endsWith('.wav')) continue;
    const data = await fs.readFile(item.absPath);
    zip.file(item.relZipPath, data);
  }

  // 3. Hash caches & cached TTS WAVs (prevents re-calling APIs on restore)
  const cacheFiles = await collectFilesRecursive(paths.cacheDir, 'cache');
  for (const item of cacheFiles) {
    const data = await fs.readFile(item.absPath);
    zip.file(item.relZipPath, data);
  }

  // 4. Rendered outputs (MP4 / WAV / SRT / QA reports)
  const outFiles = await collectFilesRecursive(paths.outDir, 'out');
  for (const item of outFiles) {
    const data = await fs.readFile(item.absPath);
    zip.file(item.relZipPath, data);
  }

  // 5. Original video (optional, off by default if > 200 MB)
  let includedSource = false;
  if (includeSource && project.video.filename) {
    const srcPath = path.join(paths.sourceDir, project.video.filename);
    if (await fileExists(srcPath)) {
      const data = await fs.readFile(srcPath);
      zip.file(path.posix.join('source', project.video.filename), data);
      includedSource = true;
    }
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 3 },
  });

  const safeTitle = project.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || project.id;
  return {
    zipBuffer,
    filename: `${project.id}_${safeTitle}_backup.zip`,
    includedSource,
  };
}

function isSafeArchivePath(entryName: string): string | null {
  const norm = path.posix.normalize(entryName).replace(/^\/+/, '');
  if (!norm || norm === '.' || norm.startsWith('..') || norm.includes('/../')) {
    return null;
  }
  const top = norm.split('/')[0];
  if (
    top === 'project.json' ||
    top === 'translations.json' ||
    top === 'speakers.json' ||
    top === 'work' ||
    top === 'cache' ||
    top === 'out' ||
    top === 'source'
  ) {
    return norm;
  }
  return null;
}

export async function restoreProjectFromZipBuffer(params: {
  zipBuffer: Buffer;
  overwriteExisting?: boolean;
}): Promise<{ project: Project; restoredFiles: number }> {
  const zip = await JSZip.loadAsync(params.zipBuffer);
  const projectFile = zip.file('project.json');
  if (!projectFile) {
    throw new Error('Invalid backup ZIP: missing project.json.');
  }

  const rawProjectJson = await projectFile.async('string');
  const parsedProject = ProjectSchema.parse(JSON.parse(rawProjectJson));

  let targetId = parsedProject.id.replace(/[^a-zA-Z0-9_-]/g, '') || (await generateNextProjectId());
  const existingAtSameId = await getProject(targetId);
  if (
    existingAtSameId &&
    !params.overwriteExisting &&
    existingAtSameId.created_at !== parsedProject.created_at
  ) {
    targetId = await generateNextProjectId();
  }

  await fs.mkdir(DATA_ROOT, { recursive: true });
  const paths = await ensureProjectDirs(targetId);

  let restoredFiles = 0;
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const safeRel = isSafeArchivePath(entryName);
    if (!safeRel || safeRel === 'project.json') continue;

    const absDest = path.resolve(paths.root, safeRel);
    if (!absDest.startsWith(paths.root + path.sep)) continue;

    await fs.mkdir(path.dirname(absDest), { recursive: true });
    const content = await entry.async('nodebuffer');
    await fs.writeFile(absDest, content);
    restoredFiles += 1;
  }

  const nowIso = new Date().toISOString();
  const hasAnyVideoOrAudio =
    (parsedProject.video.filename &&
      (await fileExists(path.join(paths.sourceDir, parsedProject.video.filename)))) ||
    (await fileExists(path.join(paths.workDir, 'proxy_480p.mp4'))) ||
    (await fileExists(path.join(paths.workDir, 'audio_48k.wav')));

  // Normalize any interrupted stages and refresh timestamps without wiping completed stage states
  const nextStages = { ...parsedProject.stages };
  for (const k of ['ingest', 'maps', 'speech', 'speakers', 'dub'] as const) {
    if (nextStages[k].status === 'running') {
      nextStages[k] = {
        ...nextStages[k],
        status: 'pending',
        message: 'Restored from backup — ready to resume.',
        updated_at: nowIso,
      };
    }
  }

  const restoredProject: Project = ProjectSchema.parse({
    ...parsedProject,
    id: targetId,
    updated_at: nowIso,
    last_saved_at: nowIso,
    upload: {
      ...parsedProject.upload,
      completed: parsedProject.upload.completed || Boolean(hasAnyVideoOrAudio),
    },
    stages: nextStages,
  });

  await atomicWriteJson(paths.projectJson, restoredProject);
  restoredFiles += 1;

  return { project: restoredProject, restoredFiles };
}
