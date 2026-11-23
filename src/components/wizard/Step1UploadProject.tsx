import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Download,
  Film,
  FolderKanban,
  HardDrive,
  Pause,
  Scissors,
  Upload,
} from 'lucide-react';
import type {
  CapabilitiesResponse,
  Project,
  ProjectMode,
  TargetLang,
} from '../../../shared/projectTypes';
import {
  formatChunkClock,
  isLongVideoDuration,
  planSmartVideoChunks,
} from '../../../shared/chunkPlanner';
import { formatMsg, useI18n } from '../../i18n/I18nContext';
import type { ProjectController } from '../../hooks/useProjectController';
import { formatBytes, formatSavedTimestamp, formatTimecode } from '../../utils/format';
import type { BrowserBackupRecord } from '../../utils/indexedDbBackup';
import { ProjectHub } from '../ProjectHub';

const TWO_HUNDRED_MB = 200 * 1024 * 1024;

interface Step1UploadProjectProps {
  project: Project | null;
  controller: ProjectController;
  projects: Project[];
  projectsLoading: boolean;
  capabilities: CapabilitiesResponse | null;
  missingBrowserBackups: BrowserBackupRecord[];
  browserSavedTimes: Record<string, string>;
  showCreateModal: boolean;
  showProjectSwitcher: boolean;
  onToggleProjectSwitcher: (open: boolean) => void;
  onToggleCreateModal: (open: boolean) => void;
  onCreateProject: (input: {
    title: string;
    mode: ProjectMode;
    target_langs: TargetLang[];
  }) => Promise<void>;
  onOpenProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => Promise<void>;
  onRestoreFromZip: (file: File) => Promise<{ project: Project; restoredFiles: number }>;
  onRestoreFromBrowser: (
    backup: BrowserBackupRecord,
  ) => Promise<{ project: Project; restoredFiles: number }>;
  onDismissBrowserBackup: (projectId: string) => Promise<void>;
  onNextStep: () => void;
}

export const Step1UploadProject: React.FC<Step1UploadProjectProps> = ({
  project,
  controller,
  projects,
  projectsLoading,
  capabilities,
  missingBrowserBackups,
  browserSavedTimes,
  showCreateModal,
  showProjectSwitcher,
  onToggleProjectSwitcher,
  onToggleCreateModal,
  onCreateProject,
  onOpenProject,
  onDeleteProject,
  onRestoreFromZip,
  onRestoreFromBrowser,
  onDismissBrowserBackup,
  onNextStep,
}) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [includeSourceInZip, setIncludeSourceInZip] = useState<boolean>(
    () => (project?.video.size_bytes || 0) <= TWO_HUNDRED_MB,
  );

  useEffect(() => {
    setIncludeSourceInZip((project?.video.size_bytes || 0) <= TWO_HUNDRED_MB);
  }, [project?.id, project?.video.size_bytes]);

  const isLongVideo = project
    ? isLongVideoDuration(project.video.duration_ms) || project.chunks.length > 0
    : false;

  const chunkPreview = useMemo(() => {
    if (!project || !project.upload.completed || !isLongVideo) return [];
    if (project.chunks.length > 0) return project.chunks;
    return planSmartVideoChunks({
      durationMs: project.video.duration_ms,
      silenceMs: project.silence_ms,
      sceneCutsMs: project.scene_cuts_ms,
      speechSegments: project.speech,
    });
  }, [project, isLongVideo]);

  const showHub = !project || showProjectSwitcher || showCreateModal;

  const renderPersistenceBar = (proj: Project) => {
    const doneStagesStr =
      [
        proj.stages.ingest.status === 'done' ? 'S0' : null,
        proj.stages.speech.status === 'done' ? 'S1' : null,
        proj.stages.speakers.status === 'done' ? 'S2' : null,
        proj.stages.maps.status === 'done' ? 'S3' : null,
        proj.stages.dub.status === 'done' ? 'Dub' : null,
      ]
        .filter(Boolean)
        .join('·') || '—';
    const ttsReadyCount = proj.dub.filter((d) => d.tts_ms > 0).length;
    const isOver200Mb = (proj.video.size_bytes || 0) > TWO_HUNDRED_MB;
    const mediaStatus = !proj.upload.completed
      ? t.persistence.mediaPending
      : proj.video.proxy_480p_file
        ? isOver200Mb && !includeSourceInZip
          ? t.persistence.mediaProxyOnly
          : t.persistence.mediaOriginalAndProxy
        : t.persistence.mediaOriginalAndProxy;
    const zipHref = `/api/projects/${encodeURIComponent(proj.id)}/backup.zip?includeSource=${
      includeSourceInZip ? '1' : '0'
    }`;
    const browserSavedAt = browserSavedTimes[proj.id];

    return (
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <HardDrive className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="font-semibold text-slate-100">{t.persistence.savedCardTitle}</span>
            <span className="text-[11px] font-mono text-slate-400">
              · {t.persistence.dataDirPrefix}: {capabilities?.disk.dataDir ?? './data'}
            </span>
          </div>
          <div className="text-[11px] text-slate-300 font-mono">
            {formatMsg(t.persistence.savedSummaryLine, {
              stages: doneStagesStr,
              speechCount: String(proj.speech.length),
              speakerCount: String(Object.keys(proj.speakers).length),
              dubCount: String(proj.dub.length),
              ttsCount: String(ttsReadyCount),
              mediaStatus,
            })}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-400">
            <span>
              {t.persistence.lastSavedLabel} ({t.persistence.serverSavedLabel}):{' '}
              <span className="text-slate-200">
                {formatSavedTimestamp(proj.last_saved_at || proj.updated_at, t.persistence.notSavedYet)}
              </span>
            </span>
            <span>
              {t.persistence.browserSavedLabel}:{' '}
              <span className="text-emerald-400">
                {formatSavedTimestamp(browserSavedAt, t.persistence.notSavedYet)}
              </span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {proj.upload.completed && proj.video.size_bytes > 0 && (
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
                  size: formatBytes(proj.video.size_bytes),
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
    );
  };

  return (
    <div className="p-4 md:p-6 max-w-[1440px] mx-auto space-y-6">
      {project && (
        <div className="space-y-5">
          {/* Active Project Action Bar */}
          <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>{t.wizard.activeProjectBanner}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{project.id}</span>
                <span aria-hidden="true">·</span>
                <span className="text-cyan-300">
                  {project.mode === 'recap' ? t.workbench.modeRecap : t.workbench.modeDubbing}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{project.target_langs.join(' + ')}</span>
              </div>
              <h1 className="text-xl font-semibold text-slate-100">{project.title}</h1>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => onToggleProjectSwitcher(!showProjectSwitcher)}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-[#0B0F19] border border-white/10 text-slate-200 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <FolderKanban className="w-3.5 h-3.5 text-cyan-400" />
                {showProjectSwitcher
                  ? t.wizard.manageProjectsHideBtn
                  : formatMsg(t.wizard.manageProjectsShowBtn, { count: projects.length })}
              </button>

              {project.upload.completed && (
                <button
                  type="button"
                  onClick={onNextStep}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
                >
                  <span>{t.wizard.nextStep2Btn}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void controller.startChunkUpload(file);
              e.target.value = '';
            }}
          />

          {/* Chunked Video Upload or Uploaded Video + Chunk Planner Preview */}
          {!project.upload.completed ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Left: video thumbnail + ingest summary */}
              <div className="lg:col-span-5 rounded-xl border border-[rgba(148,163,184,0.14)] bg-[#131A2A] p-5 space-y-4">
                <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-[#0E1422] border border-[rgba(148,163,184,0.18)] flex items-center justify-center">
                  <Film className="w-10 h-10 text-slate-700" />
                  <span className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0B0F19]/90 border border-white/10 text-[10px] font-mono tabular-nums text-slate-300">
                    {project.video.duration_ms > 0
                      ? formatTimecode(project.video.duration_ms)
                      : '--:--:--'}
                  </span>
                  <span className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#0B0F19]/90 border border-white/10 text-[10px] font-mono text-slate-300 max-w-[85%] truncate">
                    <Upload className="w-3 h-3 text-cyan-400 shrink-0" />
                    <span className="truncate">{project.video.filename}</span>
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-[10px] font-mono text-slate-300">
                    {project.video.width && project.video.height
                      ? `${project.video.width}×${project.video.height}`
                      : t.wizard.resolutionUnknownLabel}
                  </span>
                  {project.video.size_bytes > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-[10px] font-mono text-slate-300">
                      {formatBytes(project.video.size_bytes)}
                    </span>
                  )}
                  {project.video.fps > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-[10px] font-mono text-slate-300">
                      {project.video.fps} fps · {project.video.is_vfr ? 'VFR' : 'CFR'}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {controller.uploading ? (
                    <button
                      type="button"
                      onClick={controller.handlePauseUpload}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-500 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      {t.workbench.pauseUploadBtn}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={Boolean(capabilities && !capabilities.ffmpeg.ok)}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 shadow-[0_0_20px_rgba(6,182,212,0.18)]"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {project.upload.received_chunks.length > 0
                        ? formatMsg(t.workbench.resumeVideoBtn, {
                            filename: project.video.filename,
                          })
                        : t.wizard.selectVideoPrimaryBtn}
                    </button>
                  )}
                  <span className="text-[11px] font-mono text-slate-500">
                    {formatMsg(t.workbench.uploadCardDesc, {
                      chunkSize: formatBytes(controller.chunkSizeBytes),
                    })}
                  </span>
                </div>

                {project.upload.received_chunks.length > 0 && !controller.uploading && (
                  <div className="text-xs font-mono text-amber-300">
                    {t.workbench.partialSavedPrefix}: {project.upload.received_chunks.length}/
                    {project.upload.total_chunks} {t.workbench.chunksUnit} ({project.video.filename}).{' '}
                    {t.workbench.reselectHint}
                  </div>
                )}
              </div>

              {/* Right: processing pipeline card */}
              <div className="lg:col-span-7 rounded-xl border border-[rgba(148,163,184,0.14)] bg-[#131A2A] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Scissors className="w-4 h-4 text-cyan-400 shrink-0" />
                    <h2 className="text-base font-semibold text-slate-100">
                      {t.wizard.pipelineCardTitle}
                    </h2>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    {controller.uploadProgress
                      ? `${controller.uploadProgress.uploadedChunks}/${controller.uploadProgress.totalChunks} ${t.workbench.chunksUnit}`
                      : t.wizard.pipeQueued}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono tabular-nums text-slate-300">
                    <span>
                      {t.workbench.chunkLabel}{' '}
                      {controller.uploadProgress
                        ? `${controller.uploadProgress.uploadedChunks}/${controller.uploadProgress.totalChunks}`
                        : `0/${project.upload.total_chunks || 0}`}{' '}
                      (
                      {controller.uploadProgress
                        ? `${formatBytes(controller.uploadProgress.bytesUploaded)} / ${formatBytes(controller.uploadProgress.totalBytes)}`
                        : `0 B / ${formatBytes(project.video.size_bytes)}`}
                      )
                    </span>
                    <span className="text-cyan-300">{controller.uploadProgress?.pct ?? 0}%</span>
                  </div>
                  <div className="w-full h-2.5 rounded-full overflow-hidden bg-[#0E1422] border border-[rgba(148,163,184,0.18)]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-150"
                      style={{ width: `${controller.uploadProgress?.pct ?? 0}%` }}
                    />
                  </div>
                </div>

                <ul className="space-y-2">
                  {[
                    { label: t.wizard.pipeAudioExtraction, done: project.video.size_bytes > 0 },
                    { label: t.wizard.pipeVocalSeparation, done: false },
                  ].map((gate) => (
                    <li
                      key={gate.label}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-xs"
                    >
                      {gate.done ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-slate-600 shrink-0" />
                      )}
                      <span className={gate.done ? 'text-slate-200' : 'text-slate-400'}>
                        {gate.label}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="space-y-2 pt-1 border-t border-[rgba(148,163,184,0.14)]">
                  <div className="flex items-end gap-0.5 h-10 px-1">
                    {Array.from({ length: 48 }).map((_, i) => (
                      <span
                        key={`voice-${i}`}
                        className="flex-1 rounded-sm bg-gradient-to-t from-cyan-500/70 to-cyan-300/40"
                        style={{ height: `${25 + ((i * 37) % 70)}%` }}
                      />
                    ))}
                  </div>
                  <div className="text-[10px] font-mono text-cyan-300/80">
                    {t.wizard.pipeWaveVoice}
                  </div>
                  <div className="flex items-end gap-0.5 h-8 px-1">
                    {Array.from({ length: 48 }).map((_, i) => (
                      <span
                        key={`bed-${i}`}
                        className="flex-1 rounded-sm bg-gradient-to-t from-indigo-500/60 to-indigo-400/30"
                        style={{ height: `${20 + ((i * 53) % 60)}%` }}
                      />
                    ))}
                  </div>
                  <div className="text-[10px] font-mono text-indigo-300/70">
                    {t.wizard.pipeWaveMusic}
                  </div>
                </div>

                {controller.uploadError && (
                  <div className="border border-red-500/40 bg-red-950/50 rounded-lg px-3.5 py-2.5 flex items-start gap-2 text-xs text-red-200">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <pre className="whitespace-pre-wrap break-words font-sans">
                      {controller.uploadError}
                    </pre>
                  </div>
                )}

                <div className="pt-1 border-t border-[rgba(148,163,184,0.14)] space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <BookOpen className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    <span>{t.workbench.guideTitle}</span>
                  </div>
                  <div className="space-y-1.5 text-[11px] text-slate-400 leading-relaxed">
                    {t.workbench.guideSteps.map((step, idx) => (
                      <p key={idx}>{step}</p>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Uploaded Video Summary */}
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100">
                        {t.wizard.uploadedReadyTitle}
                      </h2>
                      <div className="text-xs text-slate-400 font-mono tabular-nums mt-0.5 flex flex-wrap items-center gap-2">
                        <span className="text-slate-200 font-sans">{project.video.filename}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatBytes(project.video.size_bytes)}</span>
                        {project.video.duration_ms > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{formatTimecode(project.video.duration_ms)}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {project.video.width}x{project.video.height} @ {project.video.fps} fps (
                              {project.video.is_vfr ? 'VFR' : 'CFR'})
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={controller.uploading || Boolean(capabilities && !capabilities.ffmpeg.ok)}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F19] border border-white/10 text-slate-300 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                    >
                      <Film className="w-3.5 h-3.5 text-cyan-400" />
                      {t.wizard.reuploadVideoBtn}
                    </button>
                    <button
                      type="button"
                      onClick={onNextStep}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
                    >
                      <span>{t.wizard.nextStep2Btn}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {controller.uploadProgress && controller.uploading && (
                  <div className="space-y-1.5 pt-2 border-t border-white/[0.08]">
                    <div className="flex justify-between text-xs font-mono tabular-nums text-slate-300">
                      <span>
                        {t.workbench.chunkLabel} {controller.uploadProgress.uploadedChunks}/
                        {controller.uploadProgress.totalChunks} (
                        {formatBytes(controller.uploadProgress.bytesUploaded)} /{' '}
                        {formatBytes(controller.uploadProgress.totalBytes)})
                      </span>
                      <span>{controller.uploadProgress.pct}%</span>
                    </div>
                    <div className="w-full h-2 bg-[#0B0F19] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-150"
                        style={{ width: `${controller.uploadProgress.pct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Chunk Planner Preview for >10m videos */}
              {isLongVideo && chunkPreview.length > 0 && (
                <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                        <Scissors className="w-4 h-4 text-cyan-400 shrink-0" />
                        <span>
                          {formatMsg(t.wizard.chunkPreviewTitle, {
                            count: chunkPreview.length,
                          })}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">{t.wizard.chunkPreviewDesc}</p>
                    </div>
                    <span className="text-xs font-mono text-slate-400 tabular-nums">
                      {project.chunks.length > 0
                        ? `${project.chunks.filter((c) => c.status === 'done').length} / ${project.chunks.length} ${t.workbench.chunksDoneLabel}`
                        : t.wizard.chunkPreviewEstLabel}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                    {chunkPreview.map((c) => (
                      <div
                        key={c.index}
                        className={`border rounded-lg p-2.5 text-[11px] font-mono ${
                          c.status === 'done'
                            ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                            : c.status === 'running'
                              ? 'border-cyan-400/60 bg-cyan-950/40 text-cyan-200'
                              : c.status === 'error'
                                ? 'border-red-500/40 bg-red-950/40 text-red-200'
                                : 'border-white/[0.08] bg-[#0B0F19] text-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">#{c.index + 1}</span>
                          <span className="text-[10px]">
                            {c.status === 'done'
                              ? t.workbench.chunksDoneLabel
                              : c.status === 'running'
                                ? t.workbench.statusRunning
                                : c.status === 'error'
                                  ? t.workbench.chunksErrorLabel
                                  : t.workbench.chunksPendingLabel}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 tabular-nums mt-0.5">
                          {formatChunkClock(c.start_ms)} – {formatChunkClock(c.end_ms)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {renderPersistenceBar(project)}
        </div>
      )}

      {/* Saved Projects Hub (Landing view when no project active, or expanded via switcher) */}
      {showHub && (
        <div className={project ? 'pt-2 border-t border-white/[0.08] space-y-4' : ''}>
          {project && (
            <h2 className="text-sm font-semibold text-slate-200">
              {t.wizard.allProjectsSectionTitle}
            </h2>
          )}
          <ProjectHub
            compactMode
            projects={projects}
            loading={projectsLoading}
            dataDir={capabilities?.disk.dataDir ?? './data'}
            missingBrowserBackups={missingBrowserBackups}
            browserSavedTimes={browserSavedTimes}
            showCreateModal={showCreateModal}
            onToggleCreateModal={onToggleCreateModal}
            onCreateProject={onCreateProject}
            onOpenProject={onOpenProject}
            onDeleteProject={onDeleteProject}
            onRestoreFromZip={onRestoreFromZip}
            onRestoreFromBrowser={onRestoreFromBrowser}
            onDismissBrowserBackup={onDismissBrowserBackup}
          />
        </div>
      )}
    </div>
  );
};
