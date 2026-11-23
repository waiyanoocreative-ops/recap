import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Film,
  HardDrive,
  Loader2,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Users,
  VolumeX,
} from 'lucide-react';
import type { CapabilitiesResponse, Project, TargetLang } from '../../../shared/projectTypes';
import { formatMsg, useI18n } from '../../i18n/I18nContext';
import type { ProjectController } from '../../hooks/useProjectController';
import { apiFetchJson, sanitizeUiErrorText } from '../../utils/apiClient';
import { formatBytes, formatSavedTimestamp, formatTimecode } from '../../utils/format';
import { Step5VisualEditor } from './Step5VisualEditor';

const TWO_HUNDRED_MB = 200 * 1024 * 1024;

function releaseMediaElement(el: HTMLMediaElement | null | undefined): void {
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute('src');
    el.src = '';
    el.load();
  } catch {
    // ignore media release errors
  }
}

interface CleanupCacheSummary {
  freedBytes: number;
  removedFiles: number;
  preservedOutFiles: string[];
  automatic?: boolean;
}

interface Step5PreviewExportProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  browserSavedAt?: string | null;
  controller: ProjectController;
  onBackToStudio: () => void;
  onStartNewProject: () => void;
}

export const Step5PreviewExport: React.FC<Step5PreviewExportProps> = ({
  project,
  capabilities,
  browserSavedAt,
  controller,
  onBackToStudio,
  onStartNewProject,
}) => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const autoCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [reviewTab, setReviewTab] = useState<'dub' | 'transcript' | 'speakers' | 'maps' | 'json'>(
    'dub',
  );
  const [copiedJson, setCopiedJson] = useState(false);
  const [includeSourceInZip, setIncludeSourceInZip] = useState<boolean>(
    () => (project.video.size_bytes || 0) <= TWO_HUNDRED_MB,
  );

  const [exportedOverlay, setExportedOverlay] = useState<Project | null>(null);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [cleanupSummary, setCleanupSummary] = useState<CleanupCacheSummary | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const effectiveProject = useMemo(() => {
    if (!exportedOverlay || exportedOverlay.id !== project.id) return project;
    const overlayTs = Date.parse(exportedOverlay.updated_at || '');
    const propTs = Date.parse(project.updated_at || '');
    return Number.isFinite(overlayTs) && (!Number.isFinite(propTs) || overlayTs > propTs)
      ? exportedOverlay
      : project;
  }, [project, exportedOverlay]);

  useEffect(() => {
    setIncludeSourceInZip((effectiveProject.video.size_bytes || 0) <= TWO_HUNDRED_MB);
    setCleanupSummary(null);
    setCleanupError(null);
  }, [effectiveProject.id, effectiveProject.video.size_bytes]);

  const previewLang: TargetLang = useMemo(() => {
    if (effectiveProject.target_langs.includes('my-MM')) return 'my-MM';
    return effectiveProject.target_langs[0] === 'en-US' ? 'en-US' : 'my-MM';
  }, [effectiveProject.target_langs]);

  const activeReport = useMemo(
    () =>
      effectiveProject.dub_reports.find((r) => r.lang === previewLang) ??
      effectiveProject.dub_reports[0] ??
      null,
    [effectiveProject.dub_reports, previewLang],
  );
  const langCues = useMemo(
    () => effectiveProject.dub.filter((d) => d.lang === previewLang),
    [effectiveProject.dub, previewLang],
  );
  const speakerEntries = useMemo(() => Object.entries(effectiveProject.speakers), [effectiveProject.speakers]);
  const durationMs = Math.max(1, effectiveProject.video.duration_ms || 1);
  const totalSpeechMs = useMemo(
    () => effectiveProject.speech.reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0),
    [effectiveProject.speech],
  );
  const speechCoveragePct = ((totalSpeechMs / durationMs) * 100).toFixed(1);

  const speakerStats = useMemo(() => {
    const map: Record<string, { count: number; totalMs: number }> = {};
    for (const seg of effectiveProject.speech) {
      const entry = map[seg.speaker] ?? { count: 0, totalMs: 0 };
      entry.count += 1;
      entry.totalMs += Math.max(0, seg.end_ms - seg.start_ms);
      map[seg.speaker] = entry;
    }
    return map;
  }, [effectiveProject.speech]);

  const seekToMs = (ms: number) => {
    const el = videoRef.current;
    const clamped = Math.max(0, Math.min(effectiveProject.video.duration_ms || ms, ms));
    setCurrentTimeMs(clamped);
    if (el) {
      el.currentTime = clamped / 1000;
    }
  };

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  };

  const isOver200Mb = (effectiveProject.video.size_bytes || 0) > TWO_HUNDRED_MB;
  const zipHref = `/api/projects/${encodeURIComponent(effectiveProject.id)}/backup.zip?includeSource=${
    includeSourceInZip ? '1' : '0'
  }`;

  const mediaCacheBust = encodeURIComponent(
    activeReport?.generated_at || activeReport?.mp4_file || 'v1',
  );

  const videoSrc = activeReport?.mp4_file
    ? `/api/projects/${encodeURIComponent(effectiveProject.id)}/media/dub/${encodeURIComponent(previewLang)}/mp4?t=${mediaCacheBust}`
    : null;

  const rawVideoSrc = videoSrc;

  // Release video/audio buffers & blob URLs when leaving Step 5 or switching video sources
  useEffect(() => {
    const root = containerRef.current;
    const vid = videoRef.current;
    return () => {
      releaseMediaElement(vid);
      if (root) {
        root.querySelectorAll('video, audio').forEach((node) => {
          releaseMediaElement(node as HTMLMediaElement);
        });
      }
      for (const url of blobUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      blobUrlsRef.current.clear();
      if (autoCleanupTimerRef.current) {
        clearTimeout(autoCleanupTimerRef.current);
        autoCleanupTimerRef.current = null;
        void fetch(`/api/projects/${encodeURIComponent(effectiveProject.id)}/cleanup-cache`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [effectiveProject.id, videoSrc]);

  // Release <audio> buffers when switching review tabs
  useEffect(() => {
    const root = containerRef.current;
    return () => {
      if (root) {
        root.querySelectorAll('audio').forEach((node) => {
          releaseMediaElement(node as HTMLAudioElement);
        });
      }
    };
  }, [reviewTab]);

  const handleCleanupWorkCache = useCallback(
    async (opts?: { automatic?: boolean }) => {
      if (cleaningCache) return;
      setCleaningCache(true);
      setCleanupError(null);
      try {
        const res = await apiFetchJson<{
          ok?: boolean;
          freedBytes?: number;
          removedFiles?: number;
          preservedOutFiles?: string[];
          error?: string;
        }>(`/api/projects/${encodeURIComponent(effectiveProject.id)}/cleanup-cache`, {
          method: 'POST',
          keepalive: Boolean(opts?.automatic),
        });
        if (!res.ok || !res.data?.ok) {
          throw new Error(res.data?.error || `Cleanup failed (HTTP ${res.status})`);
        }
        setCleanupSummary({
          freedBytes: res.data.freedBytes ?? 0,
          removedFiles: res.data.removedFiles ?? 0,
          preservedOutFiles: res.data.preservedOutFiles ?? [],
          automatic: opts?.automatic,
        });
      } catch (err) {
        if (!opts?.automatic) {
          setCleanupError(sanitizeUiErrorText(err) || 'Failed to clean work cache.');
        }
      } finally {
        setCleaningCache(false);
      }
    },
    [cleaningCache, effectiveProject.id],
  );

  const triggerAutoCleanupAfterDownload = useCallback(() => {
    if (autoCleanupTimerRef.current) {
      clearTimeout(autoCleanupTimerRef.current);
    }
    autoCleanupTimerRef.current = setTimeout(() => {
      autoCleanupTimerRef.current = null;
      void handleCleanupWorkCache({ automatic: true });
    }, 1500);
  }, [handleCleanupWorkCache]);

  const cleanupDisabled =
    cleaningCache ||
    controller.isDubRunning ||
    controller.anyStageRunning ||
    controller.anyChunkJobRunning;

  return (
    <div ref={containerRef} className="p-4 md:p-6 max-w-[1440px] mx-auto space-y-5">
      {/* Header + Primary Export / Navigation Controls */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-100">
              <Film className="w-4 h-4 text-cyan-400" />
              <span>{t.dubbing.outputTitle}</span>
            </div>
            <div className="text-xs text-slate-400 font-mono tabular-nums flex flex-wrap items-center gap-2">
              <span className="font-sans text-slate-200">{project.title}</span>
              <span aria-hidden="true">·</span>
              <span>{formatTimecode(project.video.duration_ms)}</span>
              {activeReport && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className={`px-2 py-0.5 rounded-full border text-[11px] ${
                      activeReport.passed_40ms
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                    }`}
                  >
                    {t.dubbing.qaAvSyncLabel}: {activeReport.av_diff_ms} ms
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onBackToStudio}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{t.wizard.backToStudioBtn}</span>
            </button>

            <button
              type="button"
              disabled={cleanupDisabled}
              onClick={() => void handleCleanupWorkCache()}
              title="Delete temporary chunks, WAVs, stems, and proxy inside work/ while preserving final exported MP4s in out/"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-amber-500/60 hover:text-amber-200 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {cleaningCache ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
              ) : (
                <Trash2 className="w-3.5 h-3.5 text-amber-400" />
              )}
              <span>{cleaningCache ? 'Cleaning...' : 'Clean Temp Cache'}</span>
            </button>

            {activeReport?.mp4_file ? (
              <a
                href={`/api/projects/${encodeURIComponent(effectiveProject.id)}/media/dub/${encodeURIComponent(previewLang)}/mp4?download=1&t=${mediaCacheBust}`}
                download
                onClick={() => triggerAutoCleanupAfterDownload()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
              >
                <Download className="w-3.5 h-3.5" />
                <span>
                  {t.dubbing.downloadMp4} ({previewLang})
                </span>
              </a>
            ) : (
              <button
                type="button"
                onClick={onStartNewProject}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
              >
                <span>{t.wizard.startNewProjectBtn}</span>
              </button>
            )}
          </div>
        </div>

        {cleanupSummary && (
          <div className="border border-emerald-500/30 bg-emerald-950/25 rounded-lg px-3.5 py-2 text-xs text-emerald-200 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>
                {cleanupSummary.automatic ? 'Auto-cleaned after download: ' : 'Temp cache cleaned: '}
                <strong className="font-mono text-emerald-100">
                  {formatBytes(cleanupSummary.freedBytes)}
                </strong>{' '}
                freed ({cleanupSummary.removedFiles} temp files removed). Final MP4 in{' '}
                <code className="font-mono">out/</code> preserved.
              </span>
            </span>
            {cleanupSummary.preservedOutFiles.length > 0 && (
              <span className="font-mono text-[11px] text-emerald-300/80">
                out/: {cleanupSummary.preservedOutFiles.join(', ')}
              </span>
            )}
          </div>
        )}

        {cleanupError && (
          <div className="border border-red-500/30 bg-red-950/25 rounded-lg px-3.5 py-2 text-xs text-red-200 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span>{cleanupError}</span>
          </div>
        )}
      </div>

      {/* Rendered Output: Sticky Split-Screen */}
      {!activeReport ? (
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-10 text-center space-y-3">
          <Film className="w-8 h-8 text-slate-500 mx-auto" />
          <div className="text-sm font-semibold text-slate-200">{t.wizard.noRenderYetTitle}</div>
          <p className="text-xs text-slate-400 max-w-md mx-auto">{t.wizard.noRenderYetDesc}</p>
          <button
            type="button"
            onClick={onBackToStudio}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{t.wizard.backToStudioBtn}</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* LEFT COLUMN (Pinned): 60fps Visual Editor + Playback + Downloads + QA + ZIP */}
          <div className="lg:col-span-6 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto space-y-4">
            <Step5VisualEditor
              project={effectiveProject}
              previewLang={previewLang}
              videoRef={videoRef}
              videoSrc={videoSrc}
              rawVideoSrc={rawVideoSrc}
              currentTimeMs={currentTimeMs}
              durationMs={durationMs}
              isPlaying={isPlaying}
              onTimeUpdateMs={setCurrentTimeMs}
              onPlayingChange={setIsPlaying}
              onSeekToMs={seekToMs}
              onProjectUpdated={setExportedOverlay}
              onDownloadMp4={triggerAutoCleanupAfterDownload}
            />

            {/* Playback & Downloads */}
            <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => seekToMs(currentTimeMs - 5000)}
                    className="p-2 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-300 hover:text-white hover:border-cyan-400/50 cursor-pointer"
                    title={t.workbench.back5s}
                  >
                    <SkipBack className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-500 text-slate-950 text-xs font-medium rounded-lg hover:bg-cyan-400 cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {isPlaying ? t.workbench.pause : t.workbench.play}
                  </button>
                  <button
                    type="button"
                    onClick={() => seekToMs(currentTimeMs + 5000)}
                    className="p-2 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-300 hover:text-white hover:border-cyan-400/50 cursor-pointer"
                    title={t.workbench.forward5s}
                  >
                    <SkipForward className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-white/[0.08] flex flex-wrap items-center gap-2">
                {activeReport?.wav_file && (
                  <a
                    href={`/api/projects/${encodeURIComponent(effectiveProject.id)}/media/dub/${encodeURIComponent(previewLang)}/wav?download=1&t=${mediaCacheBust}`}
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-cyan-400/50 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {t.dubbing.downloadWav} ({previewLang})
                  </a>
                )}
                {activeReport?.srt_file && (
                  <a
                    href={`/api/projects/${encodeURIComponent(effectiveProject.id)}/media/dub/${encodeURIComponent(previewLang)}/srt?download=1&t=${mediaCacheBust}`}
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-cyan-400/50 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {t.dubbing.downloadSrt} ({previewLang})
                  </a>
                )}
              </div>
            </div>

            {/* Step H: QA Validation */}
            {activeReport && (
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>
                    {t.dubbing.qaTitle} ({previewLang})
                  </span>
                </div>

                <div className="space-y-3 text-xs">
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">{t.dubbing.qaAvSyncLabel}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full font-mono text-[11px] border ${
                          activeReport.passed_40ms
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-red-500/15 border-red-500/40 text-red-300'
                        }`}
                      >
                        {activeReport.av_diff_ms} ms ·{' '}
                        {activeReport.passed_40ms ? t.dubbing.qaPass40 : t.dubbing.qaFail40}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-400 flex justify-between tabular-nums">
                      <span>video: {activeReport.video_duration_ms} ms</span>
                      <span>audio: {activeReport.audio_duration_ms} ms</span>
                    </div>
                  </div>

                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-lg p-3 space-y-2">
                    <div className="text-slate-400">{t.dubbing.qaStatusSummaryLabel}</div>
                    <div className="flex flex-wrap gap-1.5 font-mono text-[11px] tabular-nums">
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                        ok: {activeReport.ok_count}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-400/40 text-cyan-300">
                        compressed: {activeReport.compressed_count}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300">
                        retranslated: {activeReport.retranslated_count}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300">
                        needs_review: {activeReport.needs_review_count}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/40 text-red-300">
                        overflow: {activeReport.overflow_count}
                      </span>
                    </div>
                  </div>

                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-lg p-3 space-y-1.5">
                    <div className="text-slate-300 font-medium">{t.dubbing.qaFlaggedTitle}</div>
                    {activeReport.flagged_segments.length === 0 ? (
                      <div className="text-emerald-400 text-[11px]">{t.dubbing.qaAllClean}</div>
                    ) : (
                      <ul className="space-y-1 max-h-36 overflow-y-auto text-[11px] font-mono">
                        {activeReport.flagged_segments.map((f) => (
                          <li key={f.id} className="text-amber-300">
                            #{f.id} [{f.status}] ({f.speaker}): {f.tts_ms}ms / {f.slot_ms}ms —{' '}
                            {f.tgt_text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Project ZIP Backup & Saved State */}
            <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-3 text-xs">
              <div className="flex items-center gap-2 font-semibold text-slate-100">
                <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{t.persistence.savedCardTitle}</span>
              </div>

              <div className="text-[11px] font-mono text-slate-400 space-y-1">
                <div>
                  {t.persistence.dataDirPrefix}: {capabilities?.disk.dataDir ?? './data'}
                </div>
                <div>
                  {t.persistence.lastSavedLabel} ({t.persistence.serverSavedLabel}):{' '}
                  <span className="text-slate-200">
                    {formatSavedTimestamp(
                      project.last_saved_at || project.updated_at,
                      t.persistence.notSavedYet,
                    )}
                  </span>
                </div>
                <div>
                  {t.persistence.browserSavedLabel}:{' '}
                  <span className="text-emerald-400">
                    {formatSavedTimestamp(browserSavedAt, t.persistence.notSavedYet)}
                  </span>
                </div>
              </div>

              <div className="pt-2 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                {project.upload.completed && project.video.size_bytes > 0 && (
                  <label
                    className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none"
                    title={isOver200Mb ? t.persistence.includeSourceOverLimitHint : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={includeSourceInZip}
                      onChange={(e) => setIncludeSourceInZip(e.target.checked)}
                      className="rounded border-white/20 bg-[#0B0F19] text-cyan-500"
                    />
                    <span>
                      {formatMsg(t.persistence.includeSourceLabel, {
                        size: formatBytes(project.video.size_bytes),
                      })}
                    </span>
                  </label>
                )}

                <a
                  href={zipHref}
                  download
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.persistence.saveProjectBtn}
                </a>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN (Scrollable): Timeline Workbench Review Cards */}
          <div className="lg:col-span-6 border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl overflow-hidden">
            <div className="px-5 pt-3 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-6 text-xs font-medium overflow-x-auto">
                {(
                  [
                    [
                      'dub',
                      formatMsg(t.wizard.tabDubTimeline, { count: String(langCues.length) }),
                    ],
                    [
                      'transcript',
                      formatMsg(t.workbench.tabTranscript, { count: String(project.speech.length) }),
                    ],
                    [
                      'speakers',
                      formatMsg(t.workbench.tabSpeakers, { count: String(speakerEntries.length) }),
                    ],
                    ['maps', t.workbench.tabMaps],
                    ['json', t.workbench.tabJson],
                  ] as const
                ).map(([tabId, label]) => (
                  <button
                    key={tabId}
                    type="button"
                    onClick={() => setReviewTab(tabId)}
                    className={`pb-3 border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                      reviewTab === tabId
                        ? 'border-cyan-400/60 text-white'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {reviewTab === 'json' && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(JSON.stringify(project, null, 2));
                    setCopiedJson(true);
                    setTimeout(() => setCopiedJson(false), 1500);
                  }}
                  className="inline-flex items-center gap-1 mb-2 px-2.5 py-1 text-[11px] bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-300 hover:text-white cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  {copiedJson ? t.workbench.copiedJson : t.workbench.copyJson}
                </button>
              )}
            </div>

            {reviewTab === 'dub' && (
              <div className="p-5">
                {langCues.length === 0 ? (
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-8 text-center text-xs text-slate-400">
                    {t.dubbing.emptyCuesHint}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {langCues.map((seg) => {
                      const isActiveNow =
                        currentTimeMs >= seg.start_ms && currentTimeMs <= seg.end_ms;
                      const clipBasename = seg.tts_file ? seg.tts_file.split('/').pop() : '';
                      return (
                        <div
                          key={`${seg.lang}:${seg.id}`}
                          className={`border rounded-xl p-4 space-y-2.5 transition-all ${
                            isActiveNow
                              ? 'border-cyan-400/60 bg-cyan-950/40 shadow-[0_0_20px_rgba(6,182,212,0.18)]'
                              : 'border-white/[0.08] bg-[#0B0F19]/80 hover:bg-[#0B0F19] hover:border-white/20'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-white/10 font-mono font-semibold text-slate-200 tabular-nums">
                                #{seg.id}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full bg-[#131A2A] border font-mono text-[11px] ${
                                  (project.speakers[seg.speaker]?.gender ?? 'unknown') === 'male'
                                    ? 'border-[#38BDF8]/40 text-[#38BDF8]'
                                    : (project.speakers[seg.speaker]?.gender ?? 'unknown') ===
                                        'female'
                                      ? 'border-[#F472B6]/40 text-[#F472B6]'
                                      : 'border-white/10 text-cyan-300'
                                }`}
                              >
                                {seg.speaker}
                              </span>
                              <button
                                type="button"
                                title={t.workbench.seekBtnTitle}
                                onClick={() => seekToMs(seg.start_ms)}
                                className="font-mono text-[11px] tabular-nums text-cyan-400 hover:text-cyan-300 hover:underline cursor-pointer"
                              >
                                {formatTimecode(seg.start_ms)} – {formatTimecode(seg.end_ms)}
                              </button>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums">
                              <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-300">
                                {seg.slot_ms}ms / {seg.tts_ms > 0 ? `${seg.tts_ms}ms` : '—'}
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-200">
                                {seg.rate.toFixed(2)}x
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full border uppercase ${
                                  seg.status === 'ok'
                                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                    : seg.status === 'overflow'
                                      ? 'bg-red-500/15 border-red-500/40 text-red-300'
                                      : 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                                }`}
                              >
                                {seg.status}
                              </span>
                            </div>
                          </div>

                          {seg.src_text && (
                            <div className="text-xs text-slate-400 bg-[#131A2A]/60 border border-white/[0.05] rounded-lg px-3 py-2 leading-relaxed">
                              {seg.src_text}
                            </div>
                          )}

                          <div className="text-sm text-slate-100 leading-[1.75]">
                            {seg.tgt_text}
                          </div>

                          {clipBasename && (
                            <audio
                              controls
                              preload="none"
                              src={`/api/projects/${encodeURIComponent(project.id)}/media/dubclip/${encodeURIComponent(clipBasename)}?v=${seg.tts_ms}`}
                              className="h-8 w-64 max-w-full"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {reviewTab === 'transcript' && (
              <div className="p-5">
                {project.speech.length === 0 ? (
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-8 text-center text-xs text-slate-400">
                    {t.workbench.emptyTranscript}
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-[560px] overflow-y-auto pr-1">
                    {project.speech.map((seg) => {
                      const isActiveNow =
                        currentTimeMs >= seg.start_ms && currentTimeMs <= seg.end_ms;
                      return (
                        <div
                          key={seg.id}
                          className={`border rounded-xl p-3.5 space-y-1.5 text-xs transition-colors ${
                            isActiveNow
                              ? 'border-cyan-400/60 bg-cyan-950/40'
                              : 'border-white/[0.08] bg-[#0B0F19]/80 hover:border-white/20'
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-white/10 font-mono text-slate-300 tabular-nums">
                              #{seg.id}
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-white/10 font-mono text-cyan-300">
                              {seg.speaker}
                            </span>
                            <button
                              type="button"
                              title={t.workbench.seekBtnTitle}
                              onClick={() => seekToMs(seg.start_ms)}
                              className="font-mono tabular-nums text-cyan-400 hover:text-cyan-300 hover:underline cursor-pointer"
                            >
                              {formatTimecode(seg.start_ms)} – {formatTimecode(seg.end_ms)}
                            </button>
                          </div>
                          <div className="text-slate-200 leading-[1.75]">{seg.text}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {reviewTab === 'speakers' && (
              <div className="p-5">
                {speakerEntries.length === 0 ? (
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-8 text-center text-xs text-slate-400">
                    {t.workbench.emptySpeakers}
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-white/[0.08] rounded-xl">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead className="bg-[#0B0F19] border-b border-white/[0.08] text-[11px] font-medium text-slate-400">
                        <tr>
                          <th className="py-2.5 px-4">{t.workbench.colSpeakerId}</th>
                          <th className="py-2.5 px-4">{t.workbench.colUtterances}</th>
                          <th className="py-2.5 px-4">{t.workbench.colSampleAudio}</th>
                          <th className="py-2.5 px-4">{t.dubbing.colGender}</th>
                          <th className="py-2.5 px-4 text-right">
                            {t.dubbing.colGeminiVoice.replace(' ({engine})', '')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06] bg-[#0B0F19]/50">
                        {speakerEntries.map(([speakerId, info]) => {
                          const stats = speakerStats[speakerId] ?? { count: 0, totalMs: 0 };
                          return (
                            <tr key={speakerId} className="hover:bg-white/[0.03]">
                              <td className="py-2.5 px-4 font-mono font-semibold text-slate-100">
                                <span className="inline-flex items-center gap-1.5">
                                  <Users className="w-3.5 h-3.5 text-cyan-400" />
                                  {speakerId}
                                </span>
                              </td>
                              <td className="py-2.5 px-4 font-mono tabular-nums text-slate-300">
                                {stats.count} · {(stats.totalMs / 1000).toFixed(1)}s
                              </td>
                              <td className="py-2.5 px-4">
                                {info.sample_file ? (
                                  <audio
                                    controls
                                    preload="none"
                                    src={`/api/projects/${encodeURIComponent(project.id)}/media/sample/${encodeURIComponent(speakerId)}`}
                                    className="h-7 w-60"
                                  />
                                ) : (
                                  <span className="text-slate-500">{t.workbench.noSampleFile}</span>
                                )}
                              </td>
                              <td className="py-2.5 px-4 text-slate-200">{info.gender}</td>
                              <td className="py-2.5 px-4 text-right font-mono text-cyan-300">
                                {info.voice?.name || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {reviewTab === 'maps' && (
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-3.5">
                    <div className="text-[11px] text-slate-400">
                      {t.workbench.speechCoverageLabel}
                    </div>
                    <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                      {speechCoveragePct}%
                    </div>
                  </div>
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-3.5">
                    <div className="text-[11px] text-slate-400">
                      {t.workbench.silenceCountLabel}
                    </div>
                    <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                      {project.silence_ms.length}
                    </div>
                  </div>
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-3.5">
                    <div className="text-[11px] text-slate-400">{t.workbench.sceneCountLabel}</div>
                    <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                      {project.scene_cuts_ms.length}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-4 space-y-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                      <VolumeX className="w-4 h-4 text-slate-400" />
                      <span>{t.workbench.silenceSummaryTitle}</span>
                    </div>
                    <div className="max-h-56 overflow-y-auto flex flex-wrap gap-1.5">
                      {project.silence_ms.map(([startMs, endMs], idx) => (
                        <button
                          key={`${startMs}-${idx}`}
                          type="button"
                          title={t.workbench.seekBtnTitle}
                          onClick={() => seekToMs(startMs)}
                          className="px-2.5 py-1 text-[11px] font-mono tabular-nums bg-[#131A2A] border border-white/10 rounded-full text-slate-300 hover:border-cyan-400/50 hover:text-white cursor-pointer"
                        >
                          {formatTimecode(startMs)}–{formatTimecode(endMs)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-4 space-y-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                      <Scissors className="w-4 h-4 text-slate-400" />
                      <span>{t.workbench.sceneCutsSummaryTitle}</span>
                    </div>
                    <div className="max-h-56 overflow-y-auto flex flex-wrap gap-1.5">
                      {project.scene_cuts_ms.map((cutMs, idx) => (
                        <button
                          key={`${cutMs}-${idx}`}
                          type="button"
                          title={t.workbench.seekBtnTitle}
                          onClick={() => seekToMs(cutMs)}
                          className="px-2.5 py-1 text-[11px] font-mono tabular-nums bg-[#131A2A] border border-white/10 rounded-full text-slate-300 hover:border-cyan-400/50 hover:text-white cursor-pointer"
                        >
                          {formatTimecode(cutMs)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {reviewTab === 'json' && (
              <pre className="p-5 max-h-[520px] overflow-auto text-xs font-mono text-slate-300 bg-[#0B0F19]">
                {JSON.stringify(project, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
