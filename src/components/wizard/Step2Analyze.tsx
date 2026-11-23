import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  FileAudio,
  Film,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Users,
  VolumeX,
} from 'lucide-react';
import type { CapabilitiesResponse, Gender, Project } from '../../../shared/projectTypes';
import { formatMsg, useI18n } from '../../i18n/I18nContext';
import type { ProjectController } from '../../hooks/useProjectController';
import { apiFetchJson, sanitizeUiErrorText } from '../../utils/apiClient';
import { formatTimecode } from '../../utils/format';

interface Step2AnalyzeProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  controller: ProjectController;
  onNextStep: () => void;
}

export const Step2Analyze: React.FC<Step2AnalyzeProps> = ({
  project,
  capabilities,
  controller,
  onNextStep,
}) => {
  const { t, localizeError } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [inspectTab, setInspectTab] = useState<'transcript' | 'speakers' | 'maps' | 'media'>(
    'transcript',
  );
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingStageRun, setPendingStageRun] = useState<'s1_only' | 's2_only' | 'reset' | null>(
    null,
  );
  const [stageRunError, setStageRunError] = useState<string | null>(null);

  const isAnalyzeBusy = controller.anyStageRunning || pendingStageRun !== null;
  const s1Completed =
    project.stages.speech.status === 'done' &&
    (project.speech.length > 0 || project.no_dialogue);
  const s2Completed = project.stages.speakers.status === 'done';
  const hasS1Segments =
    project.speech.length > 0 ||
    project.no_dialogue ||
    project.stages.speech.status === 'done';

  const handleRunAnalyzeStage = async (opts: {
    stage: 'all' | 's1_only' | 's2_only';
    forceReset: boolean;
    pendingKey: 's1_only' | 's2_only' | 'reset';
  }) => {
    setStageRunError(null);
    setPendingStageRun(opts.pendingKey);
    try {
      const res = await apiFetchJson<{ started?: boolean; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            force: opts.forceReset,
            forceReset: opts.forceReset,
            stage: opts.stage,
          }),
        },
      );
      if (!res.ok) {
        setStageRunError(localizeError(res.data?.error || `HTTP ${res.status}`));
      }
    } catch (err) {
      setStageRunError(localizeError(sanitizeUiErrorText(err)));
    } finally {
      setPendingStageRun(null);
    }
  };

  const durationMs = Math.max(1, project.video.duration_ms || 1);
  const videoStreamUrl =
    project.mode === 'recap' && project.video.proxy_480p_file
      ? `/api/projects/${encodeURIComponent(project.id)}/media/proxy`
      : `/api/projects/${encodeURIComponent(project.id)}/media/source`;

  const totalSpeechMs = useMemo(
    () => project.speech.reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0),
    [project.speech],
  );
  const speechCoveragePct = ((totalSpeechMs / durationMs) * 100).toFixed(1);

  const speakerStats = useMemo(() => {
    const map: Record<string, { count: number; totalMs: number }> = {};
    for (const seg of project.speech) {
      const entry = map[seg.speaker] ?? { count: 0, totalMs: 0 };
      entry.count += 1;
      entry.totalMs += Math.max(0, seg.end_ms - seg.start_ms);
      map[seg.speaker] = entry;
    }
    return map;
  }, [project.speech]);

  const speakerEntries = useMemo(() => Object.entries(project.speakers), [project.speakers]);

  const seekToMs = (ms: number) => {
    const el = videoRef.current;
    const clamped = Math.max(0, Math.min(project.video.duration_ms || 0, ms));
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

  const getStageStatusText = (status: 'pending' | 'running' | 'done' | 'error') => {
    if (status === 'done') return t.workbench.statusDone;
    if (status === 'running') return t.workbench.statusRunning;
    if (status === 'error') return t.workbench.statusError;
    return t.workbench.statusPending;
  };

  const stageCards = [
    { key: 'ingest', title: t.workbench.s0Title, state: project.stages.ingest },
    { key: 'speech', title: t.workbench.s1Title, state: project.stages.speech },
    { key: 'speakers', title: t.workbench.s2Title, state: project.stages.speakers },
    { key: 'maps', title: t.workbench.s3Title, state: project.stages.maps },
  ];

  const formatStageMessage = (raw?: string): string | undefined => {
    if (!raw) return raw;
    return raw
      .replace(/Waiting for S2 \(Gemini - VPN On\)\.\.\./gi, 'Waiting for S2 (Groq Speakers & Gender)...')
      .replace(/S1 complete — turn ON VPN and run S2 \(Gemini\)\./gi, 'S1 complete — run S2 (Groq Speakers & Gender) (VPN Off).')
      .replace(/Turn ON VPN to run S2\./gi, 'Run S2 (Groq Speakers & Gender) next.');
  };

  return (
    <div className="p-4 md:p-6 max-w-[1440px] mx-auto space-y-5">
      {/* Step 2 Action & S0-S3 Cards */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold text-slate-100">{t.workbench.stage1Header}</h1>
              <span className="text-[11px] font-mono text-cyan-300/90">
                · S1 &amp; S2: Groq (VPN Off)
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {formatStageMessage(
                controller.liveLog ||
                  project.stages.speakers.message ||
                  project.stages.speech.message ||
                  project.stages.maps.message ||
                  project.stages.ingest.message,
              ) || formatMsg(t.workbench.stage1DefaultLog, { id: project.id })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {controller.allAnalyzeDone ? (
              <button
                type="button"
                onClick={onNextStep}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{t.wizard.nextStep3Btn}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                disabled={isAnalyzeBusy || !capabilities?.ffmpeg.ok}
                onClick={() => {
                  setStageRunError(null);
                  void controller.handleRunAnalysis(false);
                }}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 shadow-[0_0_20px_rgba(6,182,212,0.18)]"
              >
                {controller.anyStageRunning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t.workbench.processingIngest}
                  </>
                ) : (
                  t.workbench.verifyIngestBtn
                )}
              </button>
            )}

            <button
              type="button"
              disabled={isAnalyzeBusy || !capabilities?.ffmpeg.ok}
              onClick={() =>
                void handleRunAnalyzeStage({
                  stage: 's1_only',
                  forceReset: false,
                  pendingKey: 's1_only',
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F19] border border-cyan-500/35 text-cyan-200 rounded-lg hover:border-cyan-400/70 hover:bg-cyan-950/30 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {pendingStageRun === 's1_only' ||
              (project.stages.speech.status === 'running' &&
                project.stages.speakers.status !== 'running') ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : s1Completed ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : null}
              <span>1. Run S1 (Groq - VPN Off)</span>
            </button>

            <button
              type="button"
              disabled={isAnalyzeBusy || !capabilities?.ffmpeg.ok || !hasS1Segments}
              title={
                !hasS1Segments
                  ? 'Run S1 first before running S2 speaker detection'
                  : 'Run S2 speaker & gender classification via Groq + acoustic pitch (VPN Off)'
              }
              onClick={() =>
                void handleRunAnalyzeStage({
                  stage: 's2_only',
                  forceReset: false,
                  pendingKey: 's2_only',
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F19] border border-cyan-500/35 text-cyan-200 rounded-lg hover:border-cyan-400/70 hover:bg-cyan-950/30 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {pendingStageRun === 's2_only' ||
              (project.stages.speakers.status === 'running' &&
                project.stages.speech.status !== 'running') ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : s2Completed ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : null}
              <span>2. Run S2 (Groq Speakers &amp; Gender)</span>
            </button>

            <button
              type="button"
              disabled={isAnalyzeBusy || !capabilities?.ffmpeg.ok}
              onClick={() =>
                void handleRunAnalyzeStage({
                  stage: 'all',
                  forceReset: true,
                  pendingKey: 'reset',
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 rounded-lg hover:border-white/25 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {pendingStageRun === 'reset' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              <span>Reset / Start Over</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {stageCards.map(({ key, title, state }) => {
            const done = state.status === 'done';
            const running = state.status === 'running';
            const errored = state.status === 'error';
            return (
              <div
                key={key}
                className={`border rounded-xl p-3.5 transition-colors ${
                  errored
                    ? 'border-red-500/30 bg-red-950/25'
                    : done
                      ? 'border-emerald-500/25 bg-emerald-950/15'
                      : 'border-[rgba(148,163,184,0.14)] bg-[#131A2A]'
                }`}
              >
                <div className="flex items-center justify-between text-xs gap-2">
                  <span className="font-medium text-slate-200 truncate">{title}</span>
                  <span
                    className={`font-medium shrink-0 ${
                      done
                        ? 'text-emerald-400'
                        : running
                          ? 'text-cyan-400'
                          : errored
                            ? 'text-red-400'
                            : 'text-slate-400'
                    }`}
                  >
                    {getStageStatusText(state.status)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 bg-[#0E1422] rounded-full overflow-hidden border border-[rgba(148,163,184,0.18)]">
                  <div
                    className={`h-full transition-all duration-200 ${
                      errored ? 'bg-red-500' : done ? 'bg-emerald-500' : 'bg-cyan-500'
                    }`}
                    style={{ width: `${state.progress_pct}%` }}
                  />
                </div>
                <div
                  className={`mt-1.5 text-[11px] ${
                    errored
                      ? 'text-red-300 whitespace-pre-wrap break-words'
                      : 'text-slate-400 truncate'
                  }`}
                  title={state.error || formatStageMessage(state.message)}
                >
                  {state.error
                    ? localizeError(state.error)
                    : done
                      ? formatStageMessage(state.message) || t.workbench.statusDone
                      : formatStageMessage(state.message) || t.workbench.statusPending}
                </div>
                {state.model_used && (
                  <div
                    className="mt-1 text-[10px] font-mono text-cyan-300 truncate"
                    title={state.model_used}
                  >
                    {state.model_used}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {(stageRunError ||
        controller.actionError ||
        project.stages.ingest.error ||
        project.stages.speech.error ||
        project.stages.speakers.error ||
        project.stages.maps.error) && (
        <div className="border border-red-500/40 bg-red-950/50 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-red-200">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {stageRunError ||
                controller.actionError ||
                localizeError(
                  project.stages.speech.error ||
                    project.stages.speakers.error ||
                    project.stages.ingest.error ||
                    project.stages.maps.error,
                )}
            </p>
          </div>
          <button
            type="button"
            disabled={isAnalyzeBusy || !capabilities?.ffmpeg.ok}
            onClick={() => {
              setStageRunError(null);
              void controller.handleRunAnalysis(false);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-red-700/80 hover:bg-red-600 text-white rounded-lg border border-red-500/50 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t.workbench.resumeFailedBtn}</span>
          </button>
        </div>
      )}

      {project.no_dialogue && project.stages.speech.status === 'done' && (
        <div className="border border-amber-500/40 bg-amber-950/40 rounded-xl px-4 py-3 flex items-center gap-3 text-xs text-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>{formatMsg(t.workbench.noDialogueBanner, { pct: speechCoveragePct })}</span>
        </div>
      )}

      {/* Inspection & Editing Tabs */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl overflow-hidden">
        <div className="px-5 pt-3 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-6 text-xs font-medium overflow-x-auto">
            {(
              [
                [
                  'transcript',
                  formatMsg(t.workbench.tabTranscript, { count: String(project.speech.length) }),
                ],
                [
                  'speakers',
                  formatMsg(t.workbench.tabSpeakers, { count: String(speakerEntries.length) }),
                ],
                ['maps', t.workbench.tabMaps],
                ['media', t.wizard.tabMediaPreview],
              ] as const
            ).map(([tabId, label]) => (
              <button
                key={tabId}
                type="button"
                onClick={() => setInspectTab(tabId)}
                className={`pb-3 border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  inspectTab === tabId
                    ? 'border-cyan-400/60 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-xs font-mono text-slate-400 tabular-nums pb-2">
            {t.workbench.speechCoverageLabel}: {speechCoveragePct}%
          </span>
        </div>

        {inspectTab === 'transcript' && (
          <div className="p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  {t.workbench.shellTranscriptTitle}
                </h2>
                {project.stages.speech.model_used && (
                  <span className="text-xs font-mono text-cyan-300">
                    · {t.workbench.modelUsedPrefix}: {project.stages.speech.model_used}
                  </span>
                )}
              </div>
            </div>

            {project.speech.length === 0 ? (
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-6 text-center text-xs text-slate-400">
                {t.workbench.emptyTranscript}
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[520px] overflow-y-auto border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-[#0E1422] border-b border-[rgba(148,163,184,0.18)] text-[11px] font-medium text-slate-400">
                    <tr>
                      <th className="py-2.5 px-3 w-12">{t.workbench.colId}</th>
                      <th className="py-2.5 px-3 w-48">{t.workbench.colTimeRange}</th>
                      <th className="py-2.5 px-3 w-20">{t.workbench.colDuration}</th>
                      <th className="py-2.5 px-3 w-24">{t.workbench.colSpeaker}</th>
                      <th className="py-2.5 px-3 w-20">{t.workbench.colLang}</th>
                      <th className="py-2.5 px-3">{t.workbench.colText}</th>
                      <th className="py-2.5 px-3 w-28 text-right">{t.workbench.colActions}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-xs bg-[#0B0F19]/60">
                    {project.speech.map((seg) => {
                      const draft = controller.segmentDrafts[seg.id] ?? {
                        start_ms: seg.start_ms,
                        end_ms: seg.end_ms,
                        speaker: seg.speaker,
                        src_lang: seg.src_lang,
                        text: seg.text,
                      };
                      const dirty = controller.isSegmentDirty(seg);
                      const isActiveNow =
                        currentTimeMs >= seg.start_ms && currentTimeMs <= seg.end_ms;
                      const isSaving = controller.savingSegId === seg.id;
                      const isSaved = controller.savedSegId === seg.id;

                      return (
                        <tr
                          key={seg.id}
                          className={`transition-colors ${
                            isActiveNow ? 'bg-cyan-950/40' : 'hover:bg-white/[0.03]'
                          }`}
                        >
                          <td className="py-2.5 px-3 font-mono tabular-nums text-slate-400 align-top">
                            {seg.id}
                          </td>
                          <td className="py-2.5 px-3 align-top space-y-1">
                            <button
                              type="button"
                              title={t.workbench.seekBtnTitle}
                              onClick={() => {
                                setInspectTab('media');
                                setTimeout(() => seekToMs(draft.start_ms), 50);
                              }}
                              className="font-mono tabular-nums text-cyan-400 hover:text-cyan-300 cursor-pointer block"
                            >
                              {formatTimecode(draft.start_ms)} – {formatTimecode(draft.end_ms)}
                            </button>
                            <div className="flex items-center gap-1 font-mono text-[11px]">
                              <input
                                type="number"
                                min={0}
                                value={draft.start_ms}
                                onChange={(e) =>
                                  controller.updateSegmentDraft(seg, {
                                    start_ms: Math.max(0, Number(e.target.value) || 0),
                                  })
                                }
                                className="w-20 px-1.5 py-0.5 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded text-slate-200 tabular-nums"
                              />
                              <span className="text-slate-500">–</span>
                              <input
                                type="number"
                                min={0}
                                value={draft.end_ms}
                                onChange={(e) =>
                                  controller.updateSegmentDraft(seg, {
                                    end_ms: Math.max(0, Number(e.target.value) || 0),
                                  })
                                }
                                className="w-20 px-1.5 py-0.5 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded text-slate-200 tabular-nums"
                              />
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-slate-300 align-top">
                            {(Math.max(0, draft.end_ms - draft.start_ms) / 1000).toFixed(2)}s
                          </td>
                          <td className="py-2.5 px-3 align-top">
                            <input
                              type="text"
                              value={draft.speaker}
                              onChange={(e) =>
                                controller.updateSegmentDraft(seg, { speaker: e.target.value })
                              }
                              className="w-20 px-2 py-1 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded text-slate-100"
                            />
                          </td>
                          <td className="py-2.5 px-3 align-top">
                            <input
                              type="text"
                              value={draft.src_lang}
                              onChange={(e) =>
                                controller.updateSegmentDraft(seg, { src_lang: e.target.value })
                              }
                              className="w-16 px-2 py-1 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded text-slate-100"
                            />
                          </td>
                          <td className="py-2.5 px-3 align-top">
                            <textarea
                              rows={2}
                              value={draft.text}
                              onChange={(e) =>
                                controller.updateSegmentDraft(seg, { text: e.target.value })
                              }
                              className="w-full min-w-[260px] px-3 py-1.5 text-xs leading-[1.75] bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
                            />
                          </td>
                          <td className="py-2.5 px-3 text-right align-top">
                            <button
                              type="button"
                              disabled={isSaving || !dirty}
                              onClick={() => void controller.handleSaveSegment(seg)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors whitespace-nowrap ${
                                isSaved && !dirty
                                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                  : dirty
                                    ? 'bg-cyan-500 border-cyan-400/60 text-white hover:bg-cyan-400 cursor-pointer'
                                    : 'bg-[#0B0F19] border-white/[0.08] text-slate-500 cursor-not-allowed'
                              }`}
                            >
                              {isSaving ? (
                                <>
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  {t.workbench.savingRowBtn}
                                </>
                              ) : isSaved && !dirty ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  {t.workbench.savedRowBadge}
                                </>
                              ) : (
                                <>
                                  <Save className="w-3 h-3" />
                                  {t.workbench.saveRowBtn}
                                </>
                              )}
                            </button>
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

        {inspectTab === 'speakers' && (
          <div className="p-5 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Users className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-slate-100">
                {t.workbench.shellSpeakersTitle}
              </h2>
              {project.stages.speakers.model_used && (
                <span className="text-xs font-mono text-cyan-300">
                  · {t.workbench.modelUsedPrefix}: {project.stages.speakers.model_used}
                </span>
              )}
            </div>

            {speakerEntries.length === 0 ? (
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-6 text-center text-xs text-slate-400">
                {t.workbench.emptySpeakers}
              </div>
            ) : (
              <div className="overflow-x-auto border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-[#0E1422] border-b border-[rgba(148,163,184,0.18)] text-[11px] font-medium text-slate-400">
                    <tr>
                      <th className="py-2.5 px-4">{t.workbench.colSpeakerId}</th>
                      <th className="py-2.5 px-4">{t.workbench.colMergedFrom}</th>
                      <th className="py-2.5 px-4">{t.workbench.colUtterances}</th>
                      <th className="py-2.5 px-4">{t.workbench.colSampleAudio}</th>
                      <th className="py-2.5 px-4">{t.workbench.colGenderSelect}</th>
                      <th className="py-2.5 px-4 text-right">{t.workbench.colConfidence}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-xs bg-[#0B0F19]/60">
                    {speakerEntries.map(([speakerId, info]) => {
                      const stats = speakerStats[speakerId] ?? { count: 0, totalMs: 0 };
                      const isSaving = controller.savingSpeakerId === speakerId;
                      const isSaved = controller.savedSpeakerId === speakerId;
                      return (
                        <tr key={speakerId} className="hover:bg-white/[0.03] transition-colors">
                          <td className="py-3 px-4">
                            <span
                              className={`inline-flex items-center gap-2 font-mono font-semibold ${
                                info.gender === 'male'
                                  ? 'text-[#38BDF8]'
                                  : info.gender === 'female'
                                    ? 'text-[#F472B6]'
                                    : 'text-slate-100'
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  info.gender === 'male'
                                    ? 'bg-[#38BDF8]'
                                    : info.gender === 'female'
                                      ? 'bg-[#F472B6]'
                                      : 'bg-slate-600'
                                }`}
                              />
                              {speakerId}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-400">
                            {info.merged_from && info.merged_from.length > 0
                              ? info.merged_from.join(', ')
                              : speakerId}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                            {stats.count} · {(stats.totalMs / 1000).toFixed(1)}s
                          </td>
                          <td className="py-3 px-4">
                            {info.sample_file ? (
                              <audio
                                controls
                                preload="none"
                                src={`/api/projects/${encodeURIComponent(project.id)}/media/sample/${encodeURIComponent(speakerId)}`}
                                className="h-8 w-64"
                              />
                            ) : (
                              <span className="text-slate-500">{t.workbench.noSampleFile}</span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <div className="inline-flex items-center gap-2">
                              <select
                                disabled={isSaving}
                                value={info.gender}
                                onChange={(e) =>
                                  void controller.handleSpeakerGenderChange(
                                    speakerId,
                                    e.target.value as Gender,
                                  )
                                }
                                className="px-2.5 py-1.5 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
                              >
                                <option value="female">{t.workbench.genderFemale}</option>
                                <option value="male">{t.workbench.genderMale}</option>
                                <option value="unknown">{t.workbench.genderUnknown}</option>
                              </select>
                              {isSaving && (
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                              )}
                              {isSaved && !isSaving && (
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                            {info.gender_overridden
                              ? t.workbench.savedRowBadge
                              : `${Math.round((info.confidence ?? 0) * 100)}%`}
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

        {inspectTab === 'maps' && (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-3.5">
                <div className="text-[11px] text-slate-400">{t.workbench.speechCoverageLabel}</div>
                <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                  {speechCoveragePct}%
                </div>
              </div>
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-3.5">
                <div className="text-[11px] text-slate-400">{t.workbench.silenceCountLabel}</div>
                <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                  {project.silence_ms.length}
                </div>
              </div>
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-3.5">
                <div className="text-[11px] text-slate-400">{t.workbench.sceneCountLabel}</div>
                <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                  {project.scene_cuts_ms.length}
                </div>
              </div>
            </div>

            {project.silence_ms.length === 0 && project.scene_cuts_ms.length === 0 ? (
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-6 text-center text-xs text-slate-400">
                {t.workbench.emptyMaps}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <VolumeX className="w-4 h-4 text-slate-400" />
                    <span>{t.workbench.silenceSummaryTitle}</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto flex flex-wrap gap-1.5">
                    {project.silence_ms.map(([startMs, endMs], idx) => (
                      <button
                        key={`${startMs}-${idx}`}
                        type="button"
                        title={t.workbench.seekBtnTitle}
                        onClick={() => {
                          setInspectTab('media');
                          setTimeout(() => seekToMs(startMs), 50);
                        }}
                        className="px-2.5 py-1 text-[11px] font-mono tabular-nums bg-[#131A2A] border border-white/10 rounded-full text-slate-300 hover:border-cyan-400/50 hover:text-white cursor-pointer"
                      >
                        {formatTimecode(startMs)}–{formatTimecode(endMs)} (
                        {((endMs - startMs) / 1000).toFixed(1)}s)
                      </button>
                    ))}
                  </div>
                </div>

                <div className="border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Scissors className="w-4 h-4 text-slate-400" />
                    <span>{t.workbench.sceneCutsSummaryTitle}</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto flex flex-wrap gap-1.5">
                    {project.scene_cuts_ms.map((cutMs, idx) => (
                      <button
                        key={`${cutMs}-${idx}`}
                        type="button"
                        title={t.workbench.seekBtnTitle}
                        onClick={() => {
                          setInspectTab('media');
                          setTimeout(() => seekToMs(cutMs), 50);
                        }}
                        className="px-2.5 py-1 text-[11px] font-mono tabular-nums bg-[#131A2A] border border-white/10 rounded-full text-slate-300 hover:border-cyan-400/50 hover:text-white cursor-pointer"
                      >
                        {formatTimecode(cutMs)} ({cutMs}ms)
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {inspectTab === 'media' && (
          <div className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Film className="w-4 h-4 text-cyan-400" />
                  {project.mode === 'recap' && project.video.proxy_480p_file
                    ? t.workbench.previewProxyTitle
                    : t.workbench.previewSourceTitle}
                </div>
                <div className="font-mono tabular-nums text-xs text-slate-300">
                  {formatTimecode(currentTimeMs)} / {formatTimecode(durationMs)}
                </div>
              </div>

              <div className="bg-black rounded-lg overflow-hidden border border-white/[0.08] flex items-center justify-center min-h-[240px]">
                <video
                  ref={videoRef}
                  src={videoStreamUrl}
                  controls
                  onTimeUpdate={() => {
                    if (videoRef.current) {
                      setCurrentTimeMs(Math.round(videoRef.current.currentTime * 1000));
                    }
                  }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  className="w-full max-h-[340px] object-contain"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => seekToMs(currentTimeMs - 5000)}
                    className="p-2 bg-[#131A2A] border border-white/10 rounded-lg text-slate-300 hover:text-white cursor-pointer"
                    title={t.workbench.back5s}
                  >
                    <SkipBack className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-500 text-slate-950 text-xs font-medium rounded-lg hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {isPlaying ? t.workbench.pause : t.workbench.play}
                  </button>
                  <button
                    type="button"
                    onClick={() => seekToMs(currentTimeMs + 5000)}
                    className="p-2 bg-[#131A2A] border border-white/10 rounded-lg text-slate-300 hover:text-white cursor-pointer"
                    title={t.workbench.forward5s}
                  >
                    <SkipForward className="w-4 h-4" />
                  </button>
                </div>

                <div className="text-xs font-mono tabular-nums text-slate-400">
                  {project.video.width}x{project.video.height} · {project.video.fps} fps
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 border border-[rgba(148,163,184,0.14)] bg-[#0E1422] rounded-xl p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <FileAudio className="w-4 h-4 text-cyan-400" />
                {t.workbench.extractedAudioTitle}
              </div>

              {project.video.has_audio ? (
                <div className="space-y-3">
                  <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-lg p-3 space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-200">{t.workbench.audio16kTitle}</span>
                      <span className="font-mono text-slate-400">work/audio_16k.wav</span>
                    </div>
                    <audio
                      controls
                      preload="none"
                      src={`/api/projects/${encodeURIComponent(project.id)}/media/audio16k`}
                      className="w-full h-8"
                    />
                  </div>

                  <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-lg p-3 space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-200">{t.workbench.audio48kTitle}</span>
                      <span className="font-mono text-slate-400">work/audio_48k.wav</span>
                    </div>
                    <audio
                      controls
                      preload="none"
                      src={`/api/projects/${encodeURIComponent(project.id)}/media/audio48k`}
                      className="w-full h-8"
                    />
                  </div>
                </div>
              ) : (
                <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-lg p-4 text-xs text-amber-300">
                  {t.workbench.noAudioNotice}
                </div>
              )}

              <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-lg p-3.5 text-xs font-mono tabular-nums space-y-1.5 text-slate-300">
                <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">{t.workbench.metaFpsMode}</span>
                  <span>
                    {project.video.fps} ({project.video.is_vfr ? 'VFR' : 'CFR'})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">{t.workbench.metaDuration}</span>
                  <span>{project.video.duration_ms}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">{t.workbench.metaStartTimes}</span>
                  <span>
                    {project.video.v_start_ms} / {project.video.a_start_ms}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400 font-sans">{t.workbench.metaProxy}</span>
                  <span>{project.video.proxy_480p_file ?? t.workbench.proxyNotGenerated}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
