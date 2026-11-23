import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  ArchiveRestore,
  CheckCircle2,
  Download,
  Film,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Project, ProjectMode, TargetLang } from '../../shared/projectTypes';
import { formatMsg, useI18n } from '../i18n/I18nContext';
import { formatBytes, formatSavedTimestamp, formatShortTime } from '../utils/format';
import type { BrowserBackupRecord } from '../utils/indexedDbBackup';

interface ProjectHubProps {
  projects: Project[];
  loading: boolean;
  dataDir: string;
  missingBrowserBackups: BrowserBackupRecord[];
  browserSavedTimes: Record<string, string>;
  showCreateModal: boolean;
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
  compactMode?: boolean;
}

export const ProjectHub: React.FC<ProjectHubProps> = ({
  projects,
  loading,
  dataDir,
  missingBrowserBackups,
  browserSavedTimes,
  showCreateModal,
  onToggleCreateModal,
  onCreateProject,
  onOpenProject,
  onDeleteProject,
  onRestoreFromZip,
  onRestoreFromBrowser,
  onDismissBrowserBackup,
  compactMode = false,
}) => {
  const { t, localizeError } = useI18n();
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ProjectMode>('dubbing');
  const [langChoice, setLangChoice] = useState<'my-MM' | 'en-US' | 'both'>('my-MM');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [restoringZip, setRestoringZip] = useState(false);
  const [restoringBrowserId, setRestoringBrowserId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<{
    project: Project;
    files: number;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const target_langs: TargetLang[] =
        langChoice === 'both' ? ['my-MM', 'en-US'] : [langChoice];
      await onCreateProject({
        title: title.trim() || `${t.projects.defaultTitlePrefix} ${projects.length + 1}`,
        mode,
        target_langs,
      });
      setTitle('');
      onToggleCreateModal(false);
    } catch (err) {
      setError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setCreating(false);
    }
  };

  const handleZipFileChosen = async (file: File) => {
    setRestoreError(null);
    setRestoreSuccess(null);
    setRestoringZip(true);
    try {
      const res = await onRestoreFromZip(file);
      setRestoreSuccess({ project: res.project, files: res.restoredFiles });
    } catch (err) {
      setRestoreError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRestoringZip(false);
      if (zipInputRef.current) zipInputRef.current.value = '';
    }
  };

  const handleBrowserRestoreClick = async (backup: BrowserBackupRecord) => {
    setRestoreError(null);
    setRestoreSuccess(null);
    setRestoringBrowserId(backup.id);
    try {
      const res = await onRestoreFromBrowser(backup);
      setRestoreSuccess({ project: res.project, files: res.restoredFiles });
    } catch (err) {
      setRestoreError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRestoringBrowserId(null);
    }
  };

  return (
    <div className={compactMode ? 'space-y-5' : 'p-8 max-w-6xl mx-auto space-y-6'}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">{t.projects.title}</h1>
          <p className="text-sm text-slate-400 mt-1">{t.projects.subtitle}</p>
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
            <HardDrive className="w-3.5 h-3.5 text-slate-500" />
            <span>
              {t.persistence.dataDirPrefix}: <span className="text-slate-300">{dataDir}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleZipFileChosen(file);
            }}
          />
          <button
            type="button"
            disabled={restoringZip}
            onClick={() => zipInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#131A2A] border border-white/10 text-slate-100 rounded-lg hover:border-cyan-400/50 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {restoringZip ? (
              <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
            ) : (
              <Upload className="w-4 h-4 text-cyan-400" />
            )}
            {restoringZip ? t.persistence.restoringZipLabel : t.persistence.restoreProjectBtn}
          </button>

          <button
            type="button"
            onClick={() => onToggleCreateModal(!showCreateModal)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-[0_0_20px_rgba(6,182,212,0.18)]"
          >
            <Plus className="w-4 h-4" />
            {t.projects.newProjectBtn}
          </button>
        </div>
      </div>

      {restoreError && (
        <div className="border border-red-500/40 bg-red-950/50 rounded-xl px-4 py-3 flex items-center gap-3 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{restoreError}</span>
        </div>
      )}

      {restoreSuccess && (
        <div className="border border-emerald-500/40 bg-emerald-950/40 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-emerald-100">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              {formatMsg(t.persistence.restoreSuccessMsg, {
                title: restoreSuccess.project.title,
                files: String(restoreSuccess.files),
              })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onOpenProject(restoreSuccess.project.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 cursor-pointer whitespace-nowrap"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {t.projects.openBtn}
          </button>
        </div>
      )}

      {missingBrowserBackups.length > 0 && (
        <div className="border border-amber-500/40 bg-amber-950/30 rounded-xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <ArchiveRestore className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-amber-100">
                {formatMsg(t.persistence.browserBannerTitle, {
                  count: String(missingBrowserBackups.length),
                })}
              </h2>
              <p className="text-xs text-amber-200/80">{t.persistence.browserBannerDesc}</p>
            </div>
          </div>

          <div className="divide-y divide-amber-900/50 border border-amber-900/60 rounded-xl bg-[#0B0F19]/80">
            {missingBrowserBackups.map((b) => {
              const ttsReadyCount = b.project.dub.filter((d) => d.tts_ms > 0).length;
              const isBusy = restoringBrowserId === b.id;
              return (
                <div
                  key={b.id}
                  className="p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">{b.title}</span>
                      <span className="font-mono text-slate-400">{b.id}</span>
                      <span className="font-mono text-slate-400">
                        · {b.project.target_langs.join(' + ')}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-slate-400">
                      {t.persistence.lastSavedLabel} ({t.persistence.browserSavedLabel}):{' '}
                      <span className="text-amber-300">
                        {formatSavedTimestamp(b.saved_at, t.persistence.notSavedYet)}
                      </span>
                      {' · '}S1: {b.project.speech.length} · Dub: {b.project.dub.length} · TTS:{' '}
                      {ttsReadyCount}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleBrowserRestoreClick(b)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-500 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ArchiveRestore className="w-3.5 h-3.5" />
                      )}
                      {isBusy
                        ? t.persistence.restoringBrowserLabel
                        : t.persistence.restoreFromBrowserBtn}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void onDismissBrowserBackup(b.id)}
                      className="px-2.5 py-2 text-xs text-slate-400 hover:text-red-400 cursor-pointer"
                    >
                      {t.persistence.dismissBrowserBackup}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showCreateModal && (
        <form
          onSubmit={handleSubmit}
          className="border border-white/[0.12] bg-[#131A2A] rounded-xl p-6 space-y-5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">{t.projects.createTitle}</h2>
            <button
              type="button"
              onClick={() => onToggleCreateModal(false)}
              className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              {t.projects.cancel}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.projects.projectTitleLabel}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t.projects.projectTitlePlaceholder}
                className="w-full px-3 py-2 text-sm bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/70"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.projects.modeLabel}
              </label>
              <div className="grid grid-cols-2 gap-1 p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
                <button
                  type="button"
                  onClick={() => setMode('dubbing')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    mode === 'dubbing'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.projects.modeDubbingShort}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('recap')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    mode === 'recap'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.projects.modeRecapShort}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.projects.outputLangLabel}
              </label>
              <div className="grid grid-cols-3 gap-1 p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
                <button
                  type="button"
                  onClick={() => setLangChoice('my-MM')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    langChoice === 'my-MM'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.projects.langMy}
                </button>
                <button
                  type="button"
                  onClick={() => setLangChoice('en-US')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    langChoice === 'en-US'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.projects.langEn}
                </button>
                <button
                  type="button"
                  onClick={() => setLangChoice('both')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    langChoice === 'both'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.projects.langBoth}
                </button>
              </div>
            </div>
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer disabled:opacity-50"
            >
              {creating ? t.projects.creating : t.projects.createSubmit}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-6 text-sm text-slate-400">
          {t.projects.loadingList}
        </div>
      ) : projects.length === 0 ? (
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-12 text-center space-y-3">
          <Film className="w-8 h-8 text-slate-500 mx-auto" />
          <h2 className="text-base font-semibold text-slate-200">{t.projects.emptyTitle}</h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">{t.projects.emptyDesc}</p>
          <div className="pt-2 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => onToggleCreateModal(true)}
              className="px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer"
            >
              {t.projects.createFirstBtn}
            </button>
            <button
              type="button"
              onClick={() => zipInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {t.persistence.restoreProjectBtn}
            </button>
          </div>
        </div>
      ) : (
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.08] text-xs font-medium text-slate-400 bg-[#0B0F19]/40">
                <th className="py-3 px-4">{t.projects.colProject}</th>
                <th className="py-3 px-4">{t.projects.colMode}</th>
                <th className="py-3 px-4">{t.projects.colMedia}</th>
                <th className="py-3 px-4">{t.projects.colProgress}</th>
                <th className="py-3 px-4 text-right">{t.projects.colActions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-sm">
              {projects.map((p) => {
                const s0Done = p.stages.ingest.status === 'done';
                const doneStages = (
                  [
                    p.stages.ingest.status === 'done' ? 'S0' : null,
                    p.stages.speech.status === 'done' ? 'S1' : null,
                    p.stages.speakers.status === 'done' ? 'S2' : null,
                    p.stages.maps.status === 'done' ? 'S3' : null,
                    p.stages.dub.status === 'done' ? 'Dub' : null,
                  ] as const
                )
                  .filter(Boolean)
                  .join('·');
                const ttsReadyCount = p.dub.filter((d) => d.tts_ms > 0).length;
                const savedAt = p.last_saved_at || p.updated_at;
                const browserSyncAt = browserSavedTimes[p.id];

                return (
                  <tr key={p.id} className="hover:bg-white/[0.03] transition-colors">
                    <td className="py-3.5 px-4">
                      <button
                        type="button"
                        onClick={() => onOpenProject(p.id)}
                        className="font-medium text-slate-100 hover:text-cyan-400 transition-colors cursor-pointer text-left"
                      >
                        {p.title}
                      </button>
                      <div className="text-xs font-mono text-slate-500 mt-0.5">{p.id}</div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        {t.persistence.lastSavedLabel}:{' '}
                        <span className="text-slate-300">
                          {formatSavedTimestamp(savedAt, t.persistence.notSavedYet)}
                        </span>
                        {browserSyncAt && (
                          <span className="text-emerald-400/90 ml-1.5">· IDB ✓</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-300">
                      <span>
                        {p.mode === 'recap' ? t.workbench.modeRecap : t.workbench.modeDubbing}
                      </span>
                      <span className="mx-1.5 text-slate-600">·</span>
                      <span className="font-mono">{p.target_langs.join(' + ')}</span>
                    </td>
                    <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-slate-300">
                      {p.video.filename ? (
                        <div>
                          <div className="truncate max-w-[220px] font-sans text-slate-200">
                            {p.video.filename}
                          </div>
                          <div className="text-slate-400">
                            {p.video.duration_ms > 0
                              ? formatShortTime(p.video.duration_ms)
                              : t.projects.uploadingLabel}{' '}
                            · {formatBytes(p.video.size_bytes)}
                          </div>
                        </div>
                      ) : (
                        <span className="font-sans text-slate-500">{t.projects.noVideoUploaded}</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-xs space-y-1">
                      <div>
                        <span className={s0Done ? 'text-emerald-400 font-medium' : 'text-slate-400'}>
                          {doneStages || (s0Done ? t.projects.stage1DoneLabel : t.projects.stage1PendingLabel)}
                        </span>
                        {p.no_dialogue && s0Done && (
                          <span className="ml-2 text-amber-400">{t.projects.noDialogue}</span>
                        )}
                      </div>
                      {(p.speech.length > 0 || p.dub.length > 0) && (
                        <div className="text-[11px] font-mono text-slate-400">
                          S1:{p.speech.length} · Dub:{p.dub.length} · TTS:{ttsReadyCount}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <a
                          href={`/api/projects/${encodeURIComponent(p.id)}/backup.zip`}
                          download
                          title={t.persistence.saveProjectBtn}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-emerald-500/60 hover:text-emerald-300 transition-colors whitespace-nowrap"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {t.persistence.saveProjectBtn}
                        </a>
                        <button
                          type="button"
                          onClick={() => onOpenProject(p.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          {t.projects.openBtn}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteProject(p.id)}
                          aria-label={t.projects.deleteAria}
                          className="p-1.5 text-slate-500 hover:text-red-400 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
