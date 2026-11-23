import type { Project } from '../../shared/projectTypes';
import { apiFetchJson } from './apiClient';

export interface ChunkUploadCallbacks {
  onProgress: (info: {
    uploadedChunks: number;
    totalChunks: number;
    pct: number;
    bytesUploaded: number;
    totalBytes: number;
  }) => void;
  signal?: AbortSignal;
}

export async function uploadFileInChunks(params: {
  project: Project;
  file: File;
  chunkSizeBytes: number;
  callbacks: ChunkUploadCallbacks;
}): Promise<Project> {
  const { project, file, chunkSizeBytes, callbacks } = params;
  const totalSize = file.size;
  const totalChunks = Math.max(1, Math.ceil(totalSize / chunkSizeBytes));

  // 1. Pre-check free disk space (~3x file size) before sending chunk 0
  const diskRes = await apiFetchJson<{
    freeBytes: number;
    requiredBytes: number;
    sufficient: boolean;
  }>(`/api/disk-check?bytes=${encodeURIComponent(totalSize)}`, {
    signal: callbacks.signal,
  });
  if (diskRes.ok) {
    const disk = diskRes.data;
    if (!disk.sufficient) {
      const freeGb = (disk.freeBytes / 1024 ** 3).toFixed(2);
      const reqGb = (disk.requiredBytes / 1024 ** 3).toFixed(2);
      throw new Error(
        `Insufficient server disk space: need ~${reqGb} GB (3x file size), only ${freeGb} GB free.`,
      );
    }
  }

  // Resume from any previously received chunk indices if matching filename/size
  const sameFile =
    project.video.filename &&
    project.upload.expected_size_bytes === totalSize &&
    project.upload.chunk_size_bytes === chunkSizeBytes;
  const alreadyReceived = new Set<number>(sameFile ? project.upload.received_chunks : []);

  let latestProject = project;
  let uploadedCount = alreadyReceived.size;
  callbacks.onProgress({
    uploadedChunks: uploadedCount,
    totalChunks,
    pct: Math.round((uploadedCount / totalChunks) * 100),
    bytesUploaded: Math.min(totalSize, uploadedCount * chunkSizeBytes),
    totalBytes: totalSize,
  });

  for (let idx = 0; idx < totalChunks; idx++) {
    if (callbacks.signal?.aborted) {
      throw new DOMException('Upload paused by user.', 'AbortError');
    }
    if (alreadyReceived.has(idx)) {
      continue;
    }

    const start = idx * chunkSizeBytes;
    const end = Math.min(totalSize, start + chunkSizeBytes);
    const slice = file.slice(start, end);

    const res = await apiFetchJson<{
      project?: Project;
      completed?: boolean;
      receivedChunks?: number[];
      error?: string;
    }>('/api/upload/chunk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-project-id': project.id,
        'x-filename': file.name,
        'x-chunk-index': String(idx),
        'x-total-chunks': String(totalChunks),
        'x-total-size': String(totalSize),
        'x-chunk-size': String(chunkSizeBytes),
      },
      body: slice,
      signal: callbacks.signal,
    });

    if (!res.ok || !res.data.project || !res.data.receivedChunks) {
      throw new Error(res.data.error || `Chunk ${idx} upload failed (${res.status}).`);
    }

    latestProject = res.data.project;
    uploadedCount = res.data.receivedChunks.length;

    callbacks.onProgress({
      uploadedChunks: uploadedCount,
      totalChunks,
      pct: Math.round((uploadedCount / totalChunks) * 100),
      bytesUploaded: Math.min(totalSize, uploadedCount * chunkSizeBytes),
      totalBytes: totalSize,
    });
  }

  return latestProject;
}
