import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Film,
  Languages,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Sparkles,
} from 'lucide-react';
import {
  MANUAL_AI_BATCH_REMINDER,
  parseManualAiJsonReply,
  type CapabilitiesResponse,
  type DubSegment,
  type ManualAiPromptsResponse,
  type Project,
  type TargetLang,
} from '../../../shared/projectTypes';
import { formatChunkClock } from '../../../shared/chunkPlanner';
import { validateTranslationCompleteness } from '../../../shared/dubUtils';
import { formatMsg, useI18n } from '../../i18n/I18nContext';
import type { ProjectController } from '../../hooks/useProjectController';
import { apiFetchJson } from '../../utils/apiClient';
import { formatTimecode } from '../../utils/format';
import { RecapScriptStudioPanel } from '../recap/RecapScriptStudioPanel';

interface Step4StudioProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  controller: ProjectController;
  onGoToStep3: () => void;
  onNextStep: () => void;
}

function countPastedJsonItems(rawText: string): number | null {
  let text = rawText.trim();
  text = text.replace(/^```(?:json|javascript|ts)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function estimateDraftSyllables(text: string, lang: TargetLang): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  if (lang === 'my-MM') {
    const clusters = cleaned.match(/[\u1000-\u102A][\u102B-\u103F]*/g);
    if (clusters && clusters.length > 0) return clusters.length;
  }
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words * 1.4));
}

export const Step4Studio: React.FC<Step4StudioProps> = ({
  project,
  capabilities,
  controller,
  onGoToStep3: _onGoToStep3,
  onNextStep,
}) => {
  const { t, localizeError } = useI18n();
  const [studioTab, setStudioTab] = useState<'dubbing' | 'recap'>(
    project.mode === 'recap' ? 'recap' : 'dubbing',
  );

  useEffect(() => {
    setStudioTab(project.mode === 'recap' ? 'recap' : 'dubbing');
  }, [project.id, project.mode]);

  const [bridgeEnabled, setBridgeEnabled] = useState<boolean>(Boolean(project.useManualAiBridge));
  const [savingBridge, setSavingBridge] = useState(false);
  const [bridgeToggleErr, setBridgeToggleErr] = useState<string | null>(null);

  useEffect(() => {
    setBridgeEnabled(Boolean(project.useManualAiBridge));
  }, [project.id, project.useManualAiBridge]);

  const effectiveProject = useMemo(
    () => ({ ...project, useManualAiBridge: bridgeEnabled }),
    [project, bridgeEnabled],
  );

  const stage2Done = project.stages.speech.status === 'done';
  const langCues = useMemo(
    () => project.dub.filter((d) => d.lang === controller.activeLang),
    [project.dub, controller.activeLang],
  );
  const importedCueIdSet = useMemo(() => new Set(langCues.map((d) => d.id)), [langCues]);

  const [dubBridgePrompts, setDubBridgePrompts] = useState<ManualAiPromptsResponse | null>(null);
  const [dubBridgeLoading, setDubBridgeLoading] = useState(false);
  const [dubBridgeLoadErr, setDubBridgeLoadErr] = useState<string | null>(null);
  const [dubBridgeBatchIdx, setDubBridgeBatchIdx] = useState(0);
  const [dubBridgeReplyByPart, setDubBridgeReplyByPart] = useState<Record<number, string>>({});
  const [dubBridgeCopiedPart, setDubBridgeCopiedPart] = useState<number | null>(null);
  const [dubBridgeImporting, setDubBridgeImporting] = useState(false);
  const [dubBridgeNotice, setDubBridgeNotice] = useState<string | null>(null);
  const [dubBridgeErr, setDubBridgeErr] = useState<string | null>(null);

  const fetchDubBridgePrompts = async () => {
    setDubBridgeLoading(true);
    setDubBridgeLoadErr(null);
    try {
      const qs = new URLSearchParams({
        mode: 'dubbing',
        lang: controller.activeLang,
      });
      const res = await apiFetchJson<ManualAiPromptsResponse & { error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/manual-ai-prompts?${qs.toString()}`,
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      setDubBridgePrompts(res.data);
      setDubBridgeBatchIdx((prev) =>
        res.data.batches.length === 0 ? 0 : Math.min(prev, res.data.batches.length - 1),
      );
    } catch (err) {
      setDubBridgeLoadErr(err instanceof Error ? err.message : t.errors.genericFailed);
    } finally {
      setDubBridgeLoading(false);
    }
  };

  useEffect(() => {
    if (!bridgeEnabled || studioTab !== 'dubbing' || !stage2Done) {
      return;
    }
    void fetchDubBridgePrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bridgeEnabled,
    studioTab,
    stage2Done,
    project.id,
    controller.activeLang,
    project.speech.length,
    project.dub_selection.mode,
    project.dub_selection.count,
    project.dub_selection.start_idx,
    project.dub_selection.end_idx,
  ]);

  const activeDubBatch = dubBridgePrompts?.batches[dubBridgeBatchIdx] ?? null;
  const activeDubRawReply = activeDubBatch
    ? dubBridgeReplyByPart[activeDubBatch.partIndex] ?? ''
    : '';
  const activeDubValidation = useMemo(() => {
    if (!activeDubBatch || !activeDubRawReply.trim()) return null;
    const parsed = parseManualAiJsonReply(activeDubRawReply, activeDubBatch.expectedIds);
    const pastedCount = countPastedJsonItems(activeDubRawReply);
    if (pastedCount !== null && pastedCount !== activeDubBatch.expectedIds.length) {
      return {
        ...parsed,
        ok: false,
        error: `Segment count mismatch: pasted JSON has ${pastedCount} item(s) but this batch expects ${activeDubBatch.expectedIds.length}. Do not merge, split, add or remove items.`,
      };
    }
    return parsed;
  }, [activeDubBatch, activeDubRawReply]);

  const handleToggleManualBridge = async () => {
    const nextVal = !bridgeEnabled;
    setBridgeEnabled(nextVal);
    setBridgeToggleErr(null);
    setSavingBridge(true);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ useManualAiBridge: nextVal }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
    } catch (err) {
      setBridgeEnabled(!nextVal);
      setBridgeToggleErr(err instanceof Error ? err.message : t.errors.genericFailed);
    } finally {
      setSavingBridge(false);
    }
  };

  const handleCopyDubPrompt = async () => {
    if (!activeDubBatch) return;
    setDubBridgeErr(null);
    try {
      await navigator.clipboard.writeText(activeDubBatch.promptText);
      setDubBridgeCopiedPart(activeDubBatch.partIndex);
      setTimeout(() => setDubBridgeCopiedPart(null), 2000);
    } catch {
      setDubBridgeErr('Clipboard copy blocked by browser — select the prompt text below and press Ctrl+C.');
    }
  };

  const handlePasteDubReply = async () => {
    if (!activeDubBatch) return;
    setDubBridgeErr(null);
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        setDubBridgeErr('Clipboard is empty. Copy the JSON reply from Gemini Web or ChatGPT first.');
        return;
      }
      setDubBridgeReplyByPart((prev) => ({
        ...prev,
        [activeDubBatch.partIndex]: clip,
      }));
    } catch {
      setDubBridgeErr('Clipboard read blocked by browser — click inside the Step 2 box and press Ctrl+V.');
    }
  };

  const handleImportDubJson = async () => {
    if (!activeDubBatch || !activeDubValidation?.ok) return;
    setDubBridgeImporting(true);
    setDubBridgeErr(null);
    setDubBridgeNotice(null);
    try {
      const res = await apiFetchJson<{
        project?: Project;
        importedCount?: number;
        totalExpectedCount?: number;
        missingIds?: number[];
        error?: string;
      }>(`/api/projects/${encodeURIComponent(project.id)}/manual-ai-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'dubbing',
          lang: controller.activeLang,
          items: activeDubValidation.items,
          expectedIds: activeDubBatch.expectedIds,
        }),
      });
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      controller.setLineDrafts((prev) => {
        const next = { ...prev };
        for (const item of activeDubValidation.items) {
          next[`${controller.activeLang}:${item.id}`] = item.text;
        }
        return next;
      });
      const rem = res.data.missingIds?.length ?? 0;
      setDubBridgeNotice(
        rem === 0
          ? `Saved Part ${activeDubBatch.partIndex}/${activeDubBatch.totalParts} (${res.data.importedCount} cues). Edge-TTS & Render are unlocked!`
          : `Saved Part ${activeDubBatch.partIndex}/${activeDubBatch.totalParts}. ${rem} cue(s) remaining in selection.`,
      );
      if (dubBridgePrompts && dubBridgeBatchIdx + 1 < dubBridgePrompts.batches.length) {
        setDubBridgeBatchIdx(dubBridgeBatchIdx + 1);
      }
    } catch (err) {
      setDubBridgeErr(err instanceof Error ? err.message : t.errors.genericFailed);
    } finally {
      setDubBridgeImporting(false);
    }
  };
  const activeReport = useMemo(
    () => project.dub_reports.find((r) => r.lang === controller.activeLang) ?? null,
    [project.dub_reports, controller.activeLang],
  );
  const hasOutput = Boolean(
    activeReport?.mp4_file || project.dub_combined_mp4 || project.dub_reports.length > 0,
  );
  const activeGlossary = project.dub_glossary?.[controller.activeLang] ?? {};
  const glossaryEntries = Object.entries(activeGlossary);
  const effectiveSps =
    project.calibrated_sps?.[controller.activeLang] ??
    capabilities?.config.SYLLABLES_PER_SEC?.[controller.activeLang] ??
    4.0;

  const previewVideoUrl = activeReport?.mp4_file
    ? `/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(controller.activeLang)}/mp4?t=${encodeURIComponent(activeReport.generated_at)}`
    : project.dub_combined_mp4
      ? `/api/projects/${encodeURIComponent(project.id)}/media/dub/dual/mp4`
      : `/api/projects/${encodeURIComponent(project.id)}/media/source`;

  const getStatusBadgeStyle = (status: DubSegment['status']) => {
    switch (status) {
      case 'ok':
        return {
          label: t.dubbing.statusOk,
          cls: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
        };
      case 'compressed':
        return {
          label: t.dubbing.statusCompressed,
          cls: 'bg-cyan-500/15 border-cyan-400/40 text-cyan-300',
        };
      case 'retranslated':
        return {
          label: t.dubbing.statusRetranslated,
          cls: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300',
        };
      case 'needs_review':
        return {
          label: t.dubbing.statusNeedsReview,
          cls: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
        };
      case 'overflow':
        return {
          label: t.dubbing.statusOverflow,
          cls: 'bg-red-500/15 border-red-500/40 text-red-300',
        };
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-[1440px] mx-auto space-y-5">
      {/* Studio Tab Bar + Preview CTA */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl px-5 pt-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-6 text-xs font-medium">
          <button
            type="button"
            onClick={() => setStudioTab('dubbing')}
            className={`pb-3 inline-flex items-center gap-2 border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              studioTab === 'dubbing'
                ? 'border-cyan-400/60 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Languages className="w-3.5 h-3.5 text-cyan-400" />
            <span>{t.wizard.studioTabDubbing}</span>
          </button>
          <button
            type="button"
            onClick={() => setStudioTab('recap')}
            className={`pb-3 inline-flex items-center gap-2 border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              studioTab === 'recap'
                ? 'border-cyan-400/60 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Film className="w-3.5 h-3.5 text-cyan-400" />
            <span>{t.wizard.studioTabRecap}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 pb-2">
          <button
            type="button"
            role="switch"
            aria-checked={bridgeEnabled}
            aria-label="Use My AI Chat App (No API Key Required)"
            disabled={savingBridge || controller.isDubRunning}
            onClick={() => void handleToggleManualBridge()}
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
              bridgeEnabled
                ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200 hover:bg-emerald-600/30'
                : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-cyan-400/50'
            }`}
          >
            <span
              className={`relative inline-flex h-4 w-7 shrink-0 rounded-full border transition-colors ${
                bridgeEnabled
                  ? 'bg-emerald-500 border-emerald-400'
                  : 'bg-slate-700 border-slate-600'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform mt-px ${
                  bridgeEnabled ? 'translate-x-3' : 'translate-x-0.5'
                }`}
              />
            </span>
            <MessageSquareText className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
            <span>Use My AI Chat App (No API Key Required)</span>
          </button>

          {hasOutput && (
            <button
              type="button"
              onClick={onNextStep}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors cursor-pointer whitespace-nowrap shadow-sm shadow-emerald-950/50"
            >
              <span>{t.wizard.nextStep5Btn}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {bridgeToggleErr && (
        <div className="border border-red-500/40 bg-red-950/50 rounded-xl px-4 py-2.5 text-xs text-red-200">
          {bridgeToggleErr}
        </div>
      )}

      {studioTab === 'recap' ? (
        <RecapScriptStudioPanel
          project={effectiveProject}
          capabilities={capabilities}
          controller={controller}
          onNextStep={onNextStep}
        />
      ) : (
        /* Dubbing Studio View: Sticky Split-Screen */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* LEFT COLUMN (Pinned): Video Player + Audio/Render Controls + Chunk Runner */}
          <div className="lg:col-span-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto space-y-4">
            {/* Video Preview Player */}
            <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 font-semibold text-slate-100">
                  <Film className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>{project.title}</span>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 tabular-nums">
                  {formatTimecode(project.video.duration_ms)}
                </span>
              </div>

              <div className="bg-black rounded-lg overflow-hidden border border-white/[0.08]">
                <video
                  key={previewVideoUrl}
                  src={previewVideoUrl}
                  controls
                  preload="metadata"
                  className="w-full max-h-[260px] object-contain"
                />
              </div>
            </div>

            {/* Action & Segment Selection Controls */}
            <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
                  <Languages className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>{t.dubbing.title}</span>
                  {project.stages.dub.model_used && (
                    <span className="text-[11px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-cyan-300">
                      {project.stages.dub.model_used}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400">{t.dubbing.subtitle}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!bridgeEnabled && (
                  <button
                    type="button"
                    disabled={!stage2Done || controller.translating || controller.isDubRunning}
                    onClick={() => void controller.handleTranslate(false)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-100 rounded-lg hover:border-cyan-400/50 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
                  >
                    {controller.translating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                    )}
                    {controller.translating ? t.dubbing.translatingBtn : t.dubbing.translateBtn}
                  </button>
                )}

                <button
                  type="button"
                  disabled={
                    !stage2Done ||
                    controller.translating ||
                    controller.isDubRunning ||
                    (bridgeEnabled && langCues.length === 0)
                  }
                  onClick={() => void controller.handleRenderDub()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 cursor-pointer whitespace-nowrap disabled:opacity-50 shadow-[0_0_20px_rgba(6,182,212,0.18)] transition-colors"
                >
                  {controller.isDubRunning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                  {controller.isDubRunning ? t.dubbing.renderingBtn : t.dubbing.renderBtn}
                </button>

                {!bridgeEnabled && (
                  <button
                    type="button"
                    disabled={!stage2Done || controller.translating || controller.isDubRunning}
                    onClick={() => void controller.handleTranslate(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 rounded-lg hover:border-white/25 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {t.dubbing.retranslateAllBtn}
                  </button>
                )}
              </div>

              {/* Segment Range Selection + Calibrated SPS + Audio Mode Notice */}
              <div className="pt-3 border-t border-white/[0.08] space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-slate-300">{t.dubbing.selectionLabel}:</span>
                  {(
                    [
                      ['first_n', t.dubbing.modeFirstN],
                      ['range', t.dubbing.modeRange],
                      ['all', t.dubbing.modeAll],
                    ] as const
                  ).map(([modeId, label]) => (
                    <button
                      key={modeId}
                      type="button"
                      disabled={controller.isDubRunning}
                      onClick={() =>
                        void controller.saveSelection({ ...controller.selection, mode: modeId })
                      }
                      className={`px-2.5 py-1 rounded-full border text-xs transition-colors cursor-pointer whitespace-nowrap ${
                        controller.selection.mode === modeId
                          ? 'bg-cyan-500 border-cyan-400 text-white'
                          : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-white/25'
                      }`}
                    >
                      {label}
                    </button>
                  ))}

                  {controller.selection.mode === 'first_n' && (
                    <label className="inline-flex items-center gap-1.5 text-slate-300 ml-1">
                      <span>{t.dubbing.firstNCountLabel}</span>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, controller.mergedCues.length || 999)}
                        disabled={controller.isDubRunning}
                        value={controller.selection.count}
                        onChange={(e) =>
                          void controller.saveSelection({
                            ...controller.selection,
                            count: Math.max(1, Number(e.target.value) || 8),
                          })
                        }
                        className="w-16 px-2 py-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 font-mono tabular-nums focus:outline-none focus:border-cyan-400/70"
                      />
                    </label>
                  )}

                  {controller.selection.mode === 'range' && (
                    <div className="inline-flex items-center gap-1.5 text-slate-300 ml-1">
                      <span>{t.dubbing.rangeStartLabel}</span>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, controller.mergedCues.length || 999)}
                        disabled={controller.isDubRunning}
                        value={controller.selection.start_idx}
                        onChange={(e) =>
                          void controller.saveSelection({
                            ...controller.selection,
                            start_idx: Math.max(1, Number(e.target.value) || 1),
                          })
                        }
                        className="w-16 px-2 py-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 font-mono tabular-nums focus:outline-none focus:border-cyan-400/70"
                      />
                      <span>{t.dubbing.rangeEndLabel}</span>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, controller.mergedCues.length || 999)}
                        disabled={controller.isDubRunning}
                        value={controller.selection.end_idx}
                        onChange={(e) =>
                          void controller.saveSelection({
                            ...controller.selection,
                            end_idx: Math.max(
                              controller.selection.start_idx,
                              Number(e.target.value) || 8,
                            ),
                          })
                        }
                        className="w-16 px-2 py-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 font-mono tabular-nums focus:outline-none focus:border-cyan-400/70"
                      />
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="px-2.5 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] font-mono text-slate-300 tabular-nums">
                    {t.dubbing.calibratedSpsLabel}{' '}
                    <strong className="text-cyan-300">{effectiveSps}</strong>
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                    {t.dubbing.duckingNotice}
                  </span>
                </div>

                <div className="text-[11px] font-mono text-slate-400">
                  {controller.selectedPreview.isFullVideo
                    ? formatMsg(t.dubbing.selectionFullVideoHint, {
                        total: controller.selectedPreview.totalCount,
                      })
                    : formatMsg(t.dubbing.selectionTestClipHint, {
                        count: controller.selectedPreview.selectedCount,
                        total: controller.selectedPreview.totalCount,
                        start: formatTimecode(controller.selectedPreview.startMs),
                        end: formatTimecode(controller.selectedPreview.endMs),
                      })}
                </div>
              </div>

              {/* Live Progress & ETA */}
              {(controller.isDubRunning || project.chunk_progress?.active) && (
                <div className="border border-cyan-400/40 bg-cyan-950/30 rounded-lg p-3 space-y-1.5">
                  {project.chunk_progress?.message && (
                    <div className="text-xs font-semibold text-amber-200">
                      {project.chunk_progress.message}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between text-xs gap-2">
                    <span className="text-cyan-200 font-medium">
                      {project.stages.dub.message || t.dubbing.renderingBtn}
                    </span>
                    <span className="font-mono text-cyan-300 tabular-nums">
                      {project.stages.dub.progress_pct}%
                      {controller.dubEtaSec !== null && controller.dubEtaSec > 0
                        ? ` · ${t.dubbing.etaLabel} ~${controller.dubEtaSec}${t.dubbing.secondsUnit}`
                        : ''}
                    </span>
                  </div>
                  <div className="h-2 bg-[#0B0F19] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300"
                      style={{ width: `${project.stages.dub.progress_pct}%` }}
                    />
                  </div>
                </div>
              )}

              {(controller.actionError || project.stages.dub.error) && (
                <div className="border border-red-500/40 bg-red-950/50 rounded-lg px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-red-200">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <p className="whitespace-pre-wrap break-words leading-relaxed">
                      {controller.actionError || localizeError(project.stages.dub.error)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={controller.isDubRunning || controller.anyChunkJobRunning}
                    onClick={() => {
                      if (controller.isLongVideo || project.chunks.some((c) => c.status === 'error')) {
                        void controller.handleRunChunkedPipeline(false);
                      } else {
                        void controller.handleRenderDub();
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-700/80 hover:bg-red-600 text-white rounded-lg border border-red-500/50 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t.workbench.resumeFailedBtn}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Long Video Smart Chunking Runner (> 10 minutes) */}
            {controller.isLongVideo &&
              (() => {
                const allChunksRendered =
                  project.chunks.length > 0 && project.chunks.every((c) => c.status === 'done');
                const allChunksAnalyzed =
                  project.chunks.length > 0 &&
                  project.chunks.every((c) => c.analyze_done || c.status === 'done') &&
                  project.stages.speech.status === 'done' &&
                  project.stages.speakers.status === 'done';
                const chunksReady = allChunksRendered || allChunksAnalyzed;
                const readyCount = project.chunks.filter(
                  (c) => c.status === 'done' || c.analyze_done,
                ).length;

                return (
                  <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Scissors className="w-4 h-4 text-cyan-400 shrink-0" />
                          <h2 className="text-sm font-semibold text-slate-100">
                            {t.workbench.chunksTitle}
                          </h2>
                          {project.chunks.length > 0 && (
                            <span className="text-xs font-mono text-slate-400 tabular-nums">
                              · {readyCount} / {project.chunks.length}
                            </span>
                          )}
                          {chunksReady && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Chunks Ready (Cached)
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400">{t.workbench.chunksSubtitle}</p>
                      </div>

                      {!allChunksRendered && (
                        <button
                          type="button"
                          disabled={
                            controller.anyStageRunning ||
                            controller.anyChunkJobRunning ||
                            !capabilities?.ffmpeg.ok
                          }
                          onClick={() => void controller.handleRunChunkedPipeline(false)}
                          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                        >
                          {!chunksReady && controller.anyChunkJobRunning ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              {t.workbench.chunksRunningBtn}
                            </>
                          ) : project.chunks.some((c) => c.status === 'done' || c.analyze_done) ? (
                            t.workbench.chunksResumeBtn
                          ) : (
                            t.workbench.chunksRunBtn
                          )}
                        </button>
                      )}
                    </div>

                {project.chunk_progress?.message && (
                  <div
                    className={`border rounded-lg px-3.5 py-2 text-xs font-medium ${
                      project.chunk_progress.phase === 'error'
                        ? 'border-red-500/40 bg-red-950/50 text-red-200'
                        : project.chunk_progress.active
                          ? 'border-cyan-400/40 bg-cyan-950/40 text-cyan-200'
                          : 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
                    }`}
                  >
                    {project.chunk_progress.message}
                  </div>
                )}

                {project.chunks.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {project.chunks.map((c) => (
                      <div
                        key={c.index}
                        title={c.error || undefined}
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
                        {c.status === 'error' && c.error && (
                          <div className="text-[10px] text-red-300 font-sans truncate mt-1">
                            {c.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                  </div>
                );
              })()}
          </div>

          {/* RIGHT COLUMN (Scrollable): Manual AI Chat Bridge (if enabled) + Glossary + Script Beats */}
          <div className="lg:col-span-7 space-y-4">
            {bridgeEnabled && (
              <div className="border border-cyan-400/35 bg-[#131A2A] rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
                    <MessageSquareText className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>No-API-Key AI Chat Bridge · Dubbing ({controller.activeLang})</span>
                    {dubBridgePrompts && (
                      <span className="text-[11px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300">
                        {dubBridgePrompts.totalCues} / {dubBridgePrompts.totalAvailableCues} cues
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {dubBridgePrompts &&
                      dubBridgePrompts.totalCues < dubBridgePrompts.totalAvailableCues && (
                        <button
                          type="button"
                          disabled={controller.isDubRunning}
                          onClick={() =>
                            void controller.saveSelection({
                              ...controller.selection,
                              mode: 'all',
                            })
                          }
                          className="px-2.5 py-1 text-[11px] font-medium bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 rounded-lg hover:bg-cyan-400/30 cursor-pointer"
                        >
                          Switch to All ({dubBridgePrompts.totalAvailableCues} cues)
                        </button>
                      )}
                    <button
                      type="button"
                      disabled={dubBridgeLoading || !stage2Done}
                      onClick={() => void fetchDubBridgePrompts()}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 rounded-lg hover:border-cyan-400/50 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${dubBridgeLoading ? 'animate-spin' : ''}`} />
                      <span>Refresh</span>
                    </button>
                  </div>
                </div>

                <div className="border border-amber-500/30 bg-amber-500/10 rounded-lg px-3.5 py-2 text-xs text-amber-200">
                  {dubBridgePrompts?.reminder || MANUAL_AI_BATCH_REMINDER}
                </div>

                {dubBridgeLoadErr && (
                  <div className="border border-red-500/40 bg-red-950/40 rounded-lg px-3 py-2 text-xs text-red-200">
                    {dubBridgeLoadErr}
                  </div>
                )}

                {dubBridgePrompts && dubBridgePrompts.batches.length > 0 && activeDubBatch ? (
                  <div className="space-y-4">
                    {/* Smart Batching Pills */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {dubBridgePrompts.batches.map((b, idx) => {
                        const partDone = b.expectedIds.every((id) => importedCueIdSet.has(id));
                        const isActive = idx === dubBridgeBatchIdx;
                        return (
                          <button
                            key={b.partIndex}
                            type="button"
                            onClick={() => setDubBridgeBatchIdx(idx)}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-colors cursor-pointer ${
                              isActive
                                ? 'bg-cyan-500 border-cyan-400 text-white'
                                : partDone
                                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                  : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-white/25'
                            }`}
                          >
                            {partDone && <CheckCircle2 className="w-3 h-3" />}
                            <span>
                              Part {b.partIndex}/{b.totalParts}: IDs {b.startId}–{b.endId}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Step 1: Copy Prompt & JSON */}
                    <div className="border border-white/[0.08] bg-[#0B0F19]/80 rounded-xl p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-100">
                          1 · Copy Prompt &amp; JSON ({activeDubBatch.cueCount} cues · IDs {activeDubBatch.startId}–{activeDubBatch.endId})
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href="https://gemini.google.com/app"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-[#131A2A] border border-white/10 text-sky-300 rounded-lg hover:border-sky-400/60 transition-colors"
                          >
                            <span>Gemini Web ↗</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <a
                            href="https://chatgpt.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-[#131A2A] border border-white/10 text-emerald-300 rounded-lg hover:border-emerald-400/60 transition-colors"
                          >
                            <span>ChatGPT ↗</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() => void handleCopyDubPrompt()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer"
                          >
                            {dubBridgeCopiedPart === activeDubBatch.partIndex ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {dubBridgeCopiedPart === activeDubBatch.partIndex
                                ? 'Copied!'
                                : '1 · Copy Prompt & JSON'}
                            </span>
                          </button>
                        </div>
                      </div>
                      <textarea
                        readOnly
                        rows={4}
                        value={activeDubBatch.promptText}
                        onFocus={(e) => e.currentTarget.select()}
                        className="w-full px-3 py-2 text-[11px] font-mono bg-[#131A2A] border border-[rgba(148,163,184,0.14)] rounded-lg text-slate-300 focus:outline-none"
                      />
                    </div>

                    {/* Step 2: Paste AI JSON Reply */}
                    <div className="border border-white/[0.08] bg-[#0B0F19]/80 rounded-xl p-4 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-100">
                          2 · Paste AI JSON Reply
                        </span>
                        <button
                          type="button"
                          onClick={() => void handlePasteDubReply()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#131A2A] border border-white/10 text-slate-200 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer"
                        >
                          <ClipboardPaste className="w-3.5 h-3.5 text-cyan-400" />
                          <span>Paste from Clipboard</span>
                        </button>
                      </div>
                      <textarea
                        rows={5}
                        placeholder='Paste JSON reply here (markdown ```json fences are stripped automatically), e.g. [{"id": 1, "text": "..."}]'
                        value={activeDubRawReply}
                        onChange={(e) => {
                          const val = e.target.value;
                          setDubBridgeReplyByPart((prev) => ({
                            ...prev,
                            [activeDubBatch.partIndex]: val,
                          }));
                        }}
                        className="w-full px-3 py-2 text-xs font-mono bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
                      />
                      {activeDubValidation && (
                        <div
                          className={`text-[11px] px-3 py-1.5 rounded-lg border ${
                            activeDubValidation.ok
                              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                              : 'bg-red-500/10 border-red-500/40 text-red-300'
                          }`}
                        >
                          {activeDubValidation.ok
                            ? `Valid JSON: matched ${activeDubValidation.matchedCount}/${activeDubBatch.expectedIds.length} cue IDs cleanly.`
                            : activeDubValidation.error || 'JSON reply does not match expected IDs.'}
                        </div>
                      )}
                    </div>

                    {/* Step 3: Save & Continue */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs space-y-1">
                        {dubBridgeErr && <div className="text-red-300">{dubBridgeErr}</div>}
                        {dubBridgeNotice && <div className="text-emerald-300">{dubBridgeNotice}</div>}
                      </div>
                      <button
                        type="button"
                        disabled={!activeDubValidation?.ok || dubBridgeImporting || controller.isDubRunning}
                        onClick={() => void handleImportDubJson()}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {dubBridgeImporting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )}
                        <span>3 · Save &amp; Continue</span>
                      </button>
                    </div>
                  </div>
                ) : !dubBridgeLoading ? (
                  <div className="text-xs text-slate-400">
                    Run Stage 2 speech analysis first to generate dialogue cues for this video.
                  </div>
                ) : null}
              </div>
            )}

            {/* Extracted Glossary */}
            {glossaryEntries.length > 0 && (
              <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-4 space-y-2.5">
                <div className="text-xs font-semibold text-slate-200">
                  {t.dubbing.glossaryTitle} ({controller.activeLang})
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {glossaryEntries.map(([src, tgt]) => (
                    <span
                      key={src}
                      className="px-2.5 py-1 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200"
                    >
                      <span className="text-slate-400">{src}</span> → <span>{tgt}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Dubbing Script Beat Cards */}
            <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-sm font-semibold text-slate-100">
                    {t.dubbing.cuesTableTitle}
                  </h2>
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 tabular-nums">
                    {langCues.length}
                  </span>
                </div>

                {project.target_langs.length > 1 && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-400">{t.dubbing.langFilterLabel}</span>
                    {project.target_langs.map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => controller.setActiveLang(l)}
                        className={`px-3 py-1 rounded-full border cursor-pointer transition-colors ${
                          controller.activeLang === l
                            ? 'bg-cyan-500 border-cyan-400 text-white'
                            : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-white/25'
                        }`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {langCues.length === 0 ? (
                <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-8 text-center text-xs text-slate-400">
                  {t.dubbing.emptyCuesHint}
                </div>
              ) : (
                <div className="space-y-3">
                  {langCues.map((seg) => {
                    const key = `${seg.lang}:${seg.id}`;
                    const draftText = controller.lineDrafts[key] ?? seg.tgt_text;
                    const isRegen = controller.regeneratingKey === key;
                    const isRetrans = controller.retranslatingKey === key;
                    const badge = getStatusBadgeStyle(seg.status);
                    const clipBasename = seg.tts_file ? seg.tts_file.split('/').pop() : '';
                    const draftSyl = estimateDraftSyllables(draftText, seg.lang);
                    const estMs = Math.round((draftSyl / Math.max(0.5, effectiveSps)) * 1000);
                    const completenessCheck = validateTranslationCompleteness(
                      seg.src_text,
                      draftText,
                      seg.lang,
                    );

                    return (
                      <div
                        key={key}
                        className="border border-white/[0.08] bg-[#0B0F19]/80 hover:bg-[#0B0F19] hover:border-cyan-400/40 rounded-xl p-4 space-y-3 transition-all"
                      >
                        {/* Card Header: ID, Speaker, Timecode & Compact Status/Speed Badges */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
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
                            <span className="font-mono text-[11px] text-slate-300 tabular-nums">
                              {formatTimecode(seg.start_ms)} – {formatTimecode(seg.end_ms)}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono tabular-nums">
                            <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-300">
                              {seg.slot_ms}ms ·{' '}
                              <span
                                className={
                                  seg.tts_ms > 0
                                    ? seg.tts_ms <= seg.slot_ms
                                      ? 'text-emerald-400'
                                      : 'text-amber-300'
                                    : 'text-slate-500'
                                }
                              >
                                {seg.tts_ms > 0 ? `${seg.tts_ms}ms` : '—'}
                              </span>
                            </span>

                            <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-200">
                              {seg.rate.toFixed(2)}x
                            </span>

                            {seg.video_rate !== undefined && seg.video_rate < 0.999 && (
                              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300">
                                {t.dubbing.videoRateLabel}: {seg.video_rate.toFixed(2)}x
                              </span>
                            )}

                            <span className={`px-2 py-0.5 rounded-full border ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </div>
                        </div>

                        {/* Source Text */}
                        <div className="text-xs text-slate-300 bg-[#131A2A]/70 border border-white/[0.05] rounded-lg px-3 py-2 leading-relaxed">
                          {seg.src_text}
                        </div>

                        {/* Prominent Burmese Editable Textarea */}
                        <div className="space-y-1.5">
                          <textarea
                            rows={2}
                            value={draftText}
                            onChange={(e) =>
                              controller.setLineDrafts((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            className="w-full px-3.5 py-2.5 text-sm leading-[1.75] bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70 transition-colors"
                          />
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400">
                            <span>
                              {t.dubbing.lengthVsSlotLabel}: {draftSyl} syl · est ~{estMs}ms /{' '}
                              {seg.slot_ms}ms
                            </span>
                            {(seg.model_used || seg.tts_model_used) && (
                              <span className="text-[10px] text-cyan-300/80">
                                {seg.model_used || seg.tts_model_used}
                              </span>
                            )}
                          </div>
                        </div>

                        {(!completenessCheck.valid || seg.review_reason || seg.error) && (
                          <div className="border border-amber-500/40 bg-amber-950/35 rounded-lg px-3 py-2 text-[11px] text-amber-200 whitespace-pre-wrap break-words">
                            <span className="font-semibold text-amber-300">
                              {t.dubbing.incompleteWarningPrefix}:{' '}
                            </span>
                            {[
                              !completenessCheck.valid ? completenessCheck.reason : null,
                              seg.review_reason || null,
                              seg.error || null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}

                        {/* Card Footer: Clip Preview + Line Actions */}
                        <div className="pt-1 flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            {clipBasename && (
                              <audio
                                controls
                                preload="none"
                                src={`/api/projects/${encodeURIComponent(project.id)}/media/dubclip/${encodeURIComponent(clipBasename)}?v=${seg.tts_ms}`}
                                className="h-8 w-64 max-w-full"
                              />
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={
                                isRegen ||
                                isRetrans ||
                                controller.isDubRunning ||
                                !draftText.trim()
                              }
                              onClick={() => void controller.handleRegenerateLine(seg)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 hover:border-cyan-400/50 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
                            >
                              {isRegen ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3 h-3 text-cyan-400" />
                              )}
                              {isRegen ? t.dubbing.regeneratingBtn : t.dubbing.regenerateBtn}
                            </button>
                            {!bridgeEnabled && (
                              <button
                                type="button"
                                disabled={isRegen || isRetrans || controller.isDubRunning}
                                onClick={() => void controller.handleRetranslateCompleteLine(seg)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#131A2A] border border-white/10 rounded-lg text-cyan-300 hover:border-cyan-400/50 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
                              >
                                {isRetrans ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Sparkles className="w-3 h-3 text-cyan-400" />
                                )}
                                {isRetrans
                                  ? t.dubbing.retranslatingCompleteBtn
                                  : t.dubbing.retranslateCompleteBtn}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
