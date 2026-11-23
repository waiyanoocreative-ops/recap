import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  UploadCloud,
  Users,
  Mic2,
  FileAudio,
  PlayCircle,
} from 'lucide-react';
import type {
  CapabilitiesResponse,
  Project,
  ProjectMode,
  TargetLang,
} from '../shared/projectTypes';
import { SettingsDrawer, type SettingsDrawerTab } from './components/SettingsDrawer';
import { TopBar } from './components/TopBar';
import { WizardStepper, type WizardStepId, type WizardStepMeta } from './components/WizardStepper';
import { Step1UploadProject } from './components/wizard/Step1UploadProject';
import { Step2Analyze } from './components/wizard/Step2Analyze';
import { Step3ModeVoices } from './components/wizard/Step3ModeVoices';
import { Step4Studio } from './components/wizard/Step4Studio';
import { Step5PreviewExport } from './components/wizard/Step5PreviewExport';
import { useProjectController } from './hooks/useProjectController';
import { I18nProvider, useI18n } from './i18n/I18nContext';
import {
  apiFetchJson,
  pollServerHealth,
  sanitizeUiErrorText,
  subscribeServerHealth,
  type ServerHealthStatus,
} from './utils/apiClient';
import {
  deleteBrowserBackup,
  listBrowserBackups,
  restoreBrowserBackupToServer,
  restoreZipBlobToServer,
  syncProjectToBrowserBackup,
  type BrowserBackupRecord,
} from './utils/indexedDbBackup';

function inferInitialWizardStep(proj: Project): WizardStepId {
  if (!proj.upload.completed) return 1;
  const analyzeDone = [
    proj.stages.ingest,
    proj.stages.speech,
    proj.stages.speakers,
    proj.stages.maps,
  ].every((s) => s.status === 'done');
  if (!analyzeDone) return 2;
  if (proj.dub_reports.some((r) => Boolean(r.mp4_file)) || Boolean(proj.dub_combined_mp4)) {
    return 5;
  }
  if (
    proj.dub.length > 0 ||
    proj.chunks.some((c) => c.status !== 'pending' || c.analyze_done)
  ) {
    return 4;
  }
  return 3;
}

function AppShell() {
  const { t, localizeError } = useI18n();
  const [activeStep, setActiveStep] = useState<WizardStepId>(1);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsDrawerTab>('models');

  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [capLoading, setCapLoading] = useState(true);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const [browserBackups, setBrowserBackups] = useState<BrowserBackupRecord[]>([]);
  const [browserSavedTimes, setBrowserSavedTimes] = useState<Record<string, string>>({});

  const [serverHealth, setServerHealth] = useState<ServerHealthStatus>({
    phase: 'ok',
    attempt: 0,
    maxAttempts: 5,
    error: null,
    serverLogLines: [],
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    return subscribeServerHealth(setServerHealth);
  }, []);

  const refreshBrowserBackups = useCallback(async () => {
    const list = await listBrowserBackups();
    setBrowserBackups(list);
    setBrowserSavedTimes((prev) => {
      const next = { ...prev };
      for (const b of list) {
        if (!next[b.id] || b.saved_at > next[b.id]) {
          next[b.id] = b.saved_at;
        }
      }
      return next;
    });
    return list;
  }, []);

  const syncSingleToBrowser = useCallback(
    (proj: Project) => {
      void syncProjectToBrowserBackup(proj).then((savedAt) => {
        setBrowserSavedTimes((prev) => ({ ...prev, [proj.id]: savedAt }));
        void refreshBrowserBackups();
      });
    },
    [refreshBrowserBackups],
  );

  const loadCapabilities = useCallback(async () => {
    setCapLoading(true);
    try {
      const res = await apiFetchJson<CapabilitiesResponse>('/api/capabilities');
      if (res.ok) {
        setCapabilities(res.data);
      }
    } catch {
      // ServerHealthStatus banner handles startup/retry UI feedback
    } finally {
      setCapLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const [res, idbList] = await Promise.all([
        apiFetchJson<{ projects: Project[] }>('/api/projects'),
        refreshBrowserBackups(),
      ]);
      if (res.ok) {
        const loaded = res.data.projects;
        setProjects(loaded);
        const idbMap = new Map(idbList.map((b) => [b.id, b]));
        for (const p of loaded) {
          const existing = idbMap.get(p.id);
          if (!existing || p.updated_at > existing.updated_at) {
            syncSingleToBrowser(p);
          }
        }
      }
    } catch {
      // ServerHealthStatus banner handles startup/retry UI feedback
    } finally {
      setProjectsLoading(false);
    }
  }, [refreshBrowserBackups, syncSingleToBrowser]);

  const prevHealthPhaseRef = useRef<ServerHealthStatus['phase']>('ok');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await pollServerHealth();
      if (cancelled || !ok) return;
      await Promise.all([loadCapabilities(), loadProjects()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCapabilities, loadProjects]);

  useEffect(() => {
    const prev = prevHealthPhaseRef.current;
    prevHealthPhaseRef.current = serverHealth.phase;
    if (prev !== 'ok' && serverHealth.phase === 'ok' && !capabilities) {
      void Promise.all([loadCapabilities(), loadProjects()]);
    }
  }, [serverHealth.phase, capabilities, loadCapabilities, loadProjects]);

  const handleRetryHealth = async () => {
    const ok = await pollServerHealth();
    if (ok) {
      await Promise.all([loadCapabilities(), loadProjects()]);
    }
  };

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const missingBrowserBackups = useMemo(() => {
    if (projectsLoading) return [];
    const serverIds = new Set(projects.map((p) => p.id));
    return browserBackups.filter((b) => !serverIds.has(b.id));
  }, [browserBackups, projects, projectsLoading]);

  const handleProjectChange = useCallback(
    (updated: Project) => {
      setProjects((prev) => {
        const exists = prev.some((p) => p.id === updated.id);
        return exists ? prev.map((p) => (p.id === updated.id ? updated : p)) : [updated, ...prev];
      });
      syncSingleToBrowser(updated);
    },
    [syncSingleToBrowser],
  );

  const controller = useProjectController({
    project: activeProject,
    capabilities,
    onProjectChange: handleProjectChange,
    onConfigSaved: loadCapabilities,
  });

  const handleCreateProject = async (input: {
    title: string;
    mode: ProjectMode;
    target_langs: TargetLang[];
  }) => {
    const res = await apiFetchJson<{ project?: Project; error?: string }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok || !res.data.project) {
      throw new Error(sanitizeUiErrorText(res.data?.error) || t.errors.genericFailed);
    }
    const created = res.data.project;
    setProjects((prev) => [created, ...prev]);
    syncSingleToBrowser(created);
    setActiveProjectId(created.id);
    setShowProjectSwitcher(false);
    setActiveStep(1);
  };

  const handleOpenProject = async (projectId: string) => {
    let targetProj = projects.find((p) => p.id === projectId) ?? null;
    try {
      const res = await apiFetchJson<{ project?: Project }>(
        `/api/projects/${encodeURIComponent(projectId)}`,
      );
      if (res.ok && res.data.project) {
        const fetched = res.data.project;
        targetProj = fetched;
        setProjects((prev) => prev.map((p) => (p.id === fetched.id ? fetched : p)));
      }
    } catch {
      // fallback to local list item if refresh failed cleanly
    }
    setActiveProjectId(projectId);
    setShowProjectSwitcher(false);
    setActiveStep(targetProj ? inferInitialWizardStep(targetProj) : 1);
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      const res = await apiFetchJson(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
        await deleteBrowserBackup(projectId);
        await refreshBrowserBackups();
        if (activeProjectId === projectId) {
          setActiveProjectId(null);
          setActiveStep(1);
        }
      }
    } catch {
      // ServerHealthStatus handles transient errors
    }
  };

  const handleRestoreFromZip = async (file: File) => {
    const restored = await restoreZipBlobToServer(file, false);
    setProjects((prev) => {
      const filtered = prev.filter((p) => p.id !== restored.project.id);
      return [restored.project, ...filtered];
    });
    syncSingleToBrowser(restored.project);
    return restored;
  };

  const handleRestoreFromBrowser = async (backup: BrowserBackupRecord) => {
    const restored = await restoreBrowserBackupToServer(backup);
    setProjects((prev) => {
      const filtered = prev.filter((p) => p.id !== restored.project.id);
      return [restored.project, ...filtered];
    });
    syncSingleToBrowser(restored.project);
    return restored;
  };

  const handleDismissBrowserBackup = async (projectId: string) => {
    await deleteBrowserBackup(projectId);
    await refreshBrowserBackups();
  };

  const openSettings = (tab: SettingsDrawerTab = 'models') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  const wizardSteps: WizardStepMeta[] = useMemo(() => {
    const uploadDone = Boolean(activeProject?.upload.completed);
    const analyzeDone = controller.allAnalyzeDone;
    const analyzeError = Boolean(
      activeProject &&
        [
          activeProject.stages.ingest,
          activeProject.stages.speech,
          activeProject.stages.speakers,
          activeProject.stages.maps,
        ].some((s) => s.status === 'error'),
    );
    const hasDubCuesOrChunks = Boolean(
      activeProject &&
        (activeProject.dub.length > 0 ||
          activeProject.dub_reports.length > 0 ||
          activeProject.chunks.some((c) => c.status === 'done' || c.analyze_done)),
    );
    const hasOutput = Boolean(
      activeProject &&
        (activeProject.dub_reports.some((r) => Boolean(r.mp4_file)) ||
          Boolean(activeProject.dub_combined_mp4)),
    );

    return [
      {
        id: 1,
        title: t.wizard.step1Title,
        subtitle: t.wizard.step1Sub,
        unlocked: true,
        completed: uploadDone,
        running: controller.uploading,
        error: Boolean(controller.uploadError),
      },
      {
        id: 2,
        title: t.wizard.step2Title,
        subtitle: t.wizard.step2Sub,
        unlocked: uploadDone,
        completed: analyzeDone,
        running: controller.anyStageRunning,
        error: analyzeError,
      },
      {
        id: 3,
        title: t.wizard.step3Title,
        subtitle: t.wizard.step3Sub,
        unlocked: analyzeDone || Boolean(activeProject && activeProject.speech.length > 0),
        completed: hasDubCuesOrChunks,
      },
      {
        id: 4,
        title: t.wizard.step4Title,
        subtitle: t.wizard.step4Sub,
        unlocked:
          analyzeDone ||
          Boolean(
            activeProject && (activeProject.dub.length > 0 || activeProject.chunks.length > 0),
          ),
        completed: hasOutput,
        running: controller.isDubRunning || controller.translating || controller.anyChunkJobRunning,
        error: activeProject?.stages.dub.status === 'error',
      },
      {
        id: 5,
        title: t.wizard.step5Title,
        subtitle: t.wizard.step5Sub,
        unlocked:
          hasOutput ||
          Boolean(
            activeProject &&
              (activeProject.dub_reports.length > 0 || activeProject.stages.dub.status === 'done'),
          ),
        completed: hasOutput,
      },
    ];
  }, [
    activeProject,
    controller.allAnalyzeDone,
    controller.anyChunkJobRunning,
    controller.anyStageRunning,
    controller.isDubRunning,
    controller.translating,
    controller.uploadError,
    controller.uploading,
    t.wizard,
  ]);

  const hasSystemWarning = Boolean(
    capabilities && (!capabilities.ffmpeg.ok || !capabilities.gemini.configured || !capabilities.gemini.keyValid),
  );

  const sidebarNav: { id: WizardStepId; icon: typeof UploadCloud; label: string }[] = [
    { id: 1, icon: UploadCloud, label: t.wizard.step1Title },
    { id: 2, icon: Users, label: t.wizard.step2Title },
    { id: 3, icon: Mic2, label: t.wizard.step3Title },
    { id: 4, icon: FileAudio, label: t.wizard.step4Title },
    { id: 5, icon: PlayCircle, label: t.wizard.step5Title },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0F19] text-slate-100">
      <TopBar
        activeProject={activeProject}
        hasSystemWarning={hasSystemWarning}
        onGoHome={() => {
          setActiveStep(1);
          setShowProjectSwitcher(true);
        }}
        onOpenSettings={() => openSettings('models')}
      />

      <WizardStepper
        activeStep={activeStep}
        steps={wizardSteps}
        onSelectStep={(step) => {
          if (step !== 1) setShowProjectSwitcher(false);
          setActiveStep(step);
        }}
      />

      <div className="flex-1 flex min-h-0">
        {/* Collapsible Project Pipeline sidebar — desktop only, purely navigational */}
        <aside
          className={`hidden lg:flex flex-col shrink-0 border-r border-white/[0.06] bg-[#0B0F19]/90 transition-[width] duration-200 ${
            sidebarCollapsed ? 'w-14' : 'w-60'
          }`}
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-4 pb-2">
            {!sidebarCollapsed && (
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 truncate">
                {t.wizard.pipelineTitle}
              </span>
            )}
            <button
              type="button"
              onClick={() => setSidebarCollapsed((prev) => !prev)}
              aria-label="Toggle sidebar"
              className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[rgba(148,163,184,0.14)] bg-[#131A2A] text-slate-400 hover:text-cyan-300 hover:border-cyan-400/40 transition-colors cursor-pointer shrink-0"
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronLeft className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          <nav aria-label="Project pipeline" className="flex-1 px-2.5 space-y-1 overflow-y-auto">
            {wizardSteps.map((step, idx) => {
              const Icon = sidebarNav[idx].icon;
              const isActive = step.id === activeStep;
              const canClick = step.unlocked || step.completed || isActive;
              return (
                <button
                  key={step.id}
                  type="button"
                  disabled={!canClick}
                  title={step.title}
                  onClick={() => {
                    if (!canClick) return;
                    if (step.id !== 1) setShowProjectSwitcher(false);
                    setActiveStep(step.id);
                  }}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-cyan-500/15 to-indigo-500/10 border-cyan-400/50 text-white shadow-[0_0_14px_rgba(6,182,212,0.12)]'
                      : step.completed
                        ? 'bg-transparent border-transparent text-slate-300 hover:bg-white/[0.04] hover:border-white/[0.08] cursor-pointer'
                        : canClick
                          ? 'bg-transparent border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200 cursor-pointer'
                          : 'bg-transparent border-transparent text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      isActive
                        ? 'text-cyan-300'
                        : step.completed
                          ? 'text-emerald-400/80'
                          : canClick
                            ? 'text-slate-500'
                            : 'text-slate-700'
                    }`}
                  />
                  {!sidebarCollapsed && (
                    <>
                      <span className="truncate flex-1">{step.title}</span>
                      <span
                        aria-hidden="true"
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          step.error
                            ? 'bg-red-400'
                            : step.running
                              ? 'bg-cyan-400 animate-pulse'
                              : step.completed
                                ? 'bg-emerald-400'
                                : isActive
                                  ? 'bg-cyan-400'
                                  : 'bg-slate-700'
                        }`}
                      />
                    </>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="p-2.5 pb-4">
            {activeProject ? (
              <div className="rounded-xl border border-[rgba(148,163,184,0.14)] bg-[#131A2A] p-3 space-y-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="text-xs font-semibold text-slate-100 truncate">
                    {activeProject.title}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/30 text-[10px] font-medium text-cyan-300">
                    {activeProject.mode === 'recap'
                      ? t.workbench.modeRecap
                      : t.workbench.modeDubbing}
                  </span>
                  {activeProject.target_langs.map((l) => (
                    <span
                      key={l}
                      className="inline-flex items-center px-2 py-0.5 rounded-full bg-[#0E1422] border border-white/[0.08] text-[10px] font-mono text-slate-300"
                    >
                      {l}
                    </span>
                  ))}
                </div>
                <div className="text-[10px] text-slate-500 font-mono tabular-nums">
                  {activeProject.upload.completed
                    ? `${activeProject.dub.length} cues · ${activeProject.chunks.length} chunks`
                    : t.wizard.step1Sub}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-white/[0.08] bg-[#131A2A]/50 p-3 text-[11px] text-slate-500 leading-relaxed">
                {t.wizard.pipelineEmptyHint}
              </div>
            )}
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          {serverHealth.phase === 'starting' && (
        <div className="bg-amber-950/90 border-b border-amber-800 px-6 py-3 flex items-center gap-3 text-xs text-amber-100">
          <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
          <span>
            {t.errors.serverStartingRetry} ({serverHealth.attempt}/{serverHealth.maxAttempts})
          </span>
        </div>
      )}

      {serverHealth.phase === 'failed' && (
        <div className="bg-red-950/95 border-b border-red-800 px-6 py-3 space-y-2 text-xs text-red-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{t.errors.serverStartupFailed}</span>
            </div>
            <button
              type="button"
              onClick={() => void handleRetryHealth()}
              className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-900/70 border border-red-700 rounded text-red-100 hover:bg-red-800 cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {t.errors.retryHealthBtn}
            </button>
          </div>
          {serverHealth.serverLogLines.length > 0 && (
            <div className="pl-7 space-y-1">
              <div className="text-[11px] font-medium text-red-300">
                {t.errors.serverLogsTitle}
              </div>
              <pre className="p-2.5 rounded bg-black/40 border border-red-900/80 font-mono text-[11px] text-red-200 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {serverHealth.serverLogLines.join('\n')}
              </pre>
            </div>
          )}
        </div>
      )}

      {capabilities && !capabilities.ffmpeg.ok && (
        <div className="bg-red-950/90 border-b border-red-800 px-6 py-3 flex items-center gap-3 text-xs text-red-100">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{t.errors.ffmpegNotFound}</span>
        </div>
      )}

      {capabilities && (!capabilities.gemini.configured || !capabilities.gemini.keyValid) && (
        <div className="bg-amber-950/60 border-b border-amber-800/80 px-6 py-2.5 flex items-center justify-between gap-3 text-xs text-amber-100">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              {!capabilities.gemini.configured
                ? t.errors.missingGeminiKey
                : localizeError(capabilities.gemini.keyError)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => openSettings('models')}
            className="px-2.5 py-1 text-[11px] font-medium bg-amber-900/50 border border-amber-700 rounded text-amber-100 hover:bg-amber-800/60 cursor-pointer whitespace-nowrap"
          >
            {t.wizard.settingsBtn}
          </button>
        </div>
      )}

      <main className="flex-1">
        {(activeStep === 1 || !activeProject) && (
          <Step1UploadProject
            project={activeProject}
            controller={controller}
            projects={projects}
            projectsLoading={projectsLoading}
            capabilities={capabilities}
            missingBrowserBackups={missingBrowserBackups}
            browserSavedTimes={browserSavedTimes}
            showCreateModal={showCreateModal}
            showProjectSwitcher={showProjectSwitcher}
            onToggleProjectSwitcher={setShowProjectSwitcher}
            onToggleCreateModal={setShowCreateModal}
            onCreateProject={handleCreateProject}
            onOpenProject={(id) => void handleOpenProject(id)}
            onDeleteProject={handleDeleteProject}
            onRestoreFromZip={handleRestoreFromZip}
            onRestoreFromBrowser={handleRestoreFromBrowser}
            onDismissBrowserBackup={handleDismissBrowserBackup}
            onNextStep={() => setActiveStep(2)}
          />
        )}

        {activeStep === 2 && activeProject && (
          <Step2Analyze
            project={activeProject}
            capabilities={capabilities}
            controller={controller}
            onNextStep={() => setActiveStep(3)}
          />
        )}

        {activeStep === 3 && activeProject && (
          <Step3ModeVoices
            project={activeProject}
            capabilities={capabilities}
            controller={controller}
            onOpenSettings={(tab) => openSettings(tab ?? 'models')}
            onNextStep={() => setActiveStep(4)}
          />
        )}

        {activeStep === 4 && activeProject && (
          <Step4Studio
            project={activeProject}
            capabilities={capabilities}
            controller={controller}
            onGoToStep3={() => setActiveStep(3)}
            onNextStep={() => setActiveStep(5)}
          />
        )}

        {activeStep === 5 && activeProject && (
          <Step5PreviewExport
            project={activeProject}
            capabilities={capabilities}
            browserSavedAt={browserSavedTimes[activeProject.id] ?? null}
            controller={controller}
            onBackToStudio={() => setActiveStep(4)}
            onStartNewProject={() => {
              setActiveStep(1);
              setShowProjectSwitcher(true);
              setShowCreateModal(true);
            }}
          />
        )}
      </main>
        </div>
      </div>

      <SettingsDrawer
        open={settingsOpen}
        initialTab={settingsTab}
        capabilities={capabilities}
        capLoading={capLoading}
        resilientStatus={controller.resilientStatus}
        onClose={() => setSettingsOpen(false)}
        onConfigSaved={loadCapabilities}
        onRefreshCapabilities={() => void loadCapabilities()}
      />
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  );
}

