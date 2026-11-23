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
  Loader2,
  MessageSquareText,
  Mic,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ScanEye,
  Sparkles,
  Trash2,
  Video,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  MANUAL_AI_BATCH_REMINDER,
  parseManualAiJsonReply,
  type CapabilitiesResponse,
  type ManualAiPromptsResponse,
  type Project,
  type RecapBeat,
  type RecapSourceMode,
  type TargetLang,
} from '../../../shared/projectTypes';
import type { ProjectController } from '../../hooks/useProjectController';
import { formatMsg, useI18n } from '../../i18n/I18nContext';
import { apiFetchJson } from '../../utils/apiClient';
import { formatTimecode } from '../../utils/format';

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

interface RecapScriptStudioPanelProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  controller: ProjectController;
  onNextStep: () => void;
}

function estimateRecapSyllables(text: string, lang: TargetLang): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  if (lang === 'my-MM') {
    const myMatches = cleaned.match(
      /[\u1000-\u1021\u1023-\u102A\u1040-\u1049](?!\u103A)(?<!\u1039[\u1000-\u1021])/g,
    );
    const latinWords = cleaned.match(/[A-Za-z0-9]+/g);
    const myCount = myMatches ? myMatches.length : 0;
    const latinCount = latinWords ? latinWords.length : 0;
    return Math.max(1, myCount + latinCount);
  }
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words * 1.4));
}

function computeBudgetSyllables(slotMs: number): number {
  return Math.max(8, Math.floor((Math.max(200, slotMs) / 1000) * 3.8));
}

export const RecapScriptStudioPanel: React.FC<RecapScriptStudioPanelProps> = ({
  project,
  capabilities,
  controller,
  onNextStep,
}) => {
  const { t, localizeError } = useI18n();
  const [sourceMode, setSourceMode] = useState<RecapSourceMode>(
    project.recap_source_mode ?? (project.no_dialogue || project.speech.length === 0 ? 'raw_movie' : 'existing_vo'),
  );
  const [autoDetectedMode, setAutoDetectedMode] = useState<RecapSourceMode>('raw_movie');
  const [detectReason, setDetectReason] = useState<string>('');

  const primaryLang: TargetLang = controller.activeLang ?? project.target_langs[0] ?? 'my-MM';
  const activeEngine = capabilities?.config.TTS_ENGINE ?? controller.activeEngine;

  const narratorVoiceOptions = useMemo(() => {
    if (activeEngine === 'gemini') {
      const list = controller.geminiVoices.map((v) => ({
        name: v.name,
        label: `${v.name} (${v.gender} · ${v.style})`,
      }));
      return list.length > 0
        ? list
        : [
            { name: 'Charon', label: 'Charon (male)' },
            { name: 'Kore', label: 'Kore (female)' },
          ];
    }

    const baseEdge =
      controller.edgeVoices.length > 0
        ? controller.edgeVoices
        : [
            { name: 'my-MM-ThihaNeural', friendlyName: 'Thiha (Burmese Male)', gender: 'male' as const, locale: 'my-MM' },
            { name: 'my-MM-NilarNeural', friendlyName: 'Nilar (Burmese Female)', gender: 'female' as const, locale: 'my-MM' },
            { name: 'en-US-AndrewMultilingualNeural', friendlyName: 'Andrew (English Male)', gender: 'male' as const, locale: 'en-US' },
            { name: 'en-US-JennyNeural', friendlyName: 'Jenny (English Female)', gender: 'female' as const, locale: 'en-US' },
          ];

    const matching = baseEdge.filter((v) =>
      primaryLang === 'my-MM' ? v.locale.startsWith('my-') : v.locale.startsWith('en-'),
    );
    const list = matching.length > 0 ? matching : baseEdge;
    return list.map((v) => ({
      name: v.name,
      label: `${v.name} (${v.gender})`,
    }));
  }, [activeEngine, controller.edgeVoices, controller.geminiVoices, primaryLang]);

  const defaultNarratorVoice = useMemo(() => {
    const saved = project.recap_narrator_voice;
    if (saved && narratorVoiceOptions.some((o) => o.name === saved)) {
      return saved;
    }
    if (activeEngine === 'edge') {
      return primaryLang === 'my-MM' ? 'my-MM-ThihaNeural' : 'en-US-AndrewMultilingualNeural';
    }
    return narratorVoiceOptions[0]?.name ?? 'Charon';
  }, [activeEngine, narratorVoiceOptions, primaryLang, project.recap_narrator_voice]);

  const [narratorVoice, setNarratorVoice] = useState<string>(defaultNarratorVoice);
  const [beatDrafts, setBeatDrafts] = useState<RecapBeat[]>(() => project.recap ?? []);
  const [dirty, setDirty] = useState(false);

  const [generatingReq, setGeneratingReq] = useState(false);
  const [savingDrafts, setSavingDrafts] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [renderingReq, setRenderingReq] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [voicePreviewSrc, setVoicePreviewSrc] = useState<string | null>(null);

  // Sync local narrator voice default when engine/project switches
  useEffect(() => {
    setNarratorVoice(defaultNarratorVoice);
  }, [defaultNarratorVoice]);

  // Auto-detect raw movie vs existing voiceover on project load/analysis changes
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetchJson<{ mode: RecapSourceMode; reason: string }>(
          `/api/projects/${encodeURIComponent(project.id)}/recap/detect`,
        );
        if (!active || !res.ok) return;
        setAutoDetectedMode(res.data.mode);
        setDetectReason(res.data.reason);
        if (!project.recap_source_mode) {
          setSourceMode(res.data.mode);
        } else {
          setSourceMode(project.recap_source_mode);
        }
      } catch {
        // Fallback to client inference cleanly
      }
    })();
    return () => {
      active = false;
    };
  }, [project.id, project.recap_source_mode, project.speech.length, project.no_dialogue]);

  // Keep local beat drafts synced from SSE/server updates when user has no unsaved edits
  useEffect(() => {
    if (!dirty) {
      setBeatDrafts(project.recap ?? []);
    }
  }, [project.recap, project.id, dirty]);

  const langBeats = useMemo(
    () =>
      beatDrafts
        .filter((b) => b.lang === primaryLang)
        .sort((a, b) => a.start_ms - b.start_ms || a.id - b.id),
    [beatDrafts, primaryLang],
  );

  const stageRunning = project.stages.dub.status === 'running';
  const isBusy = generatingReq || renderingReq || stageRunning || savingDrafts;
  const stage2Ready = project.stages.ingest.status === 'done';
  const hasOutput = Boolean(
    project.dub_reports.some((r) => r.lang === primaryLang && Boolean(r.mp4_file)) ||
      project.dub_reports.length > 0,
  );
  const muteOriginal = project.recap_mute_original ?? true;
  const manualBridgeActive = Boolean(project.useManualAiBridge);

  const [bridgePrompts, setBridgePrompts] = useState<ManualAiPromptsResponse | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeLoadErr, setBridgeLoadErr] = useState<string | null>(null);
  const [bridgeBatchIdx, setBridgeBatchIdx] = useState(0);
  const [bridgeReplyByPart, setBridgeReplyByPart] = useState<Record<number, string>>({});
  const [bridgeCopiedPart, setBridgeCopiedPart] = useState<number | null>(null);
  const [bridgeImporting, setBridgeImporting] = useState(false);
  const [bridgeImportNotice, setBridgeImportNotice] = useState<string | null>(null);
  const [bridgeImportErr, setBridgeImportErr] = useState<string | null>(null);

  const fetchRecapBridgePrompts = async () => {
    setBridgeLoading(true);
    setBridgeLoadErr(null);
    try {
      const qs = new URLSearchParams({
        mode: 'recap',
        sourceMode,
        lang: primaryLang,
      });
      const res = await apiFetchJson<ManualAiPromptsResponse & { error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/manual-ai-prompts?${qs.toString()}`,
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      setBridgePrompts(res.data);
      setBridgeBatchIdx((prev) =>
        res.data.batches.length === 0 ? 0 : Math.min(prev, res.data.batches.length - 1),
      );
    } catch (err) {
      setBridgeLoadErr(err instanceof Error ? err.message : t.errors.genericFailed);
    } finally {
      setBridgeLoading(false);
    }
  };

  useEffect(() => {
    if (!manualBridgeActive || !stage2Ready) {
      return;
    }
    void fetchRecapBridgePrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualBridgeActive, stage2Ready, project.id, sourceMode, primaryLang, project.speech.length, project.video.duration_ms]);

  const activeBridgeBatch = bridgePrompts?.batches[bridgeBatchIdx] ?? null;
  const activeBridgeRawReply = activeBridgeBatch
    ? bridgeReplyByPart[activeBridgeBatch.partIndex] ?? ''
    : '';
  const activeBridgeValidation = useMemo(() => {
    if (!activeBridgeBatch) return null;
    if (!activeBridgeRawReply.trim()) return null;
    const parsed = parseManualAiJsonReply(activeBridgeRawReply, activeBridgeBatch.expectedIds);
    const pastedCount = countPastedJsonItems(activeBridgeRawReply);
    if (pastedCount !== null && pastedCount !== activeBridgeBatch.expectedIds.length) {
      return {
        ...parsed,
        ok: false,
        error: `Segment count mismatch: pasted JSON has ${pastedCount} item(s) but this batch expects ${activeBridgeBatch.expectedIds.length}. Do not merge, split, add or remove items.`,
      };
    }
    return parsed;
  }, [activeBridgeBatch, activeBridgeRawReply]);

  const importedBeatIdSet = useMemo(() => new Set(langBeats.map((b) => b.id)), [langBeats]);

  const handleCopyPrompt = async () => {
    if (!activeBridgeBatch) return;
    setBridgeImportErr(null);
    try {
      await navigator.clipboard.writeText(activeBridgeBatch.promptText);
      setBridgeCopiedPart(activeBridgeBatch.partIndex);
      setTimeout(() => setBridgeCopiedPart(null), 2000);
    } catch {
      setBridgeImportErr('Clipboard copy blocked by browser — select the prompt preview text below and press Ctrl+C.');
    }
  };

  const handlePasteReply = async () => {
    if (!activeBridgeBatch) return;
    setBridgeImportErr(null);
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        setBridgeImportErr('Clipboard is empty. Copy the JSON reply from Gemini Web or ChatGPT first.');
        return;
      }
      setBridgeReplyByPart((prev) => ({
        ...prev,
        [activeBridgeBatch.partIndex]: clip,
      }));
    } catch {
      setBridgeImportErr('Clipboard read blocked by browser — click inside the Step 2 box and press Ctrl+V.');
    }
  };

  const handleImportRecapJson = async () => {
    if (!activeBridgeBatch || !activeBridgeValidation?.ok) return;
    setBridgeImporting(true);
    setBridgeImportErr(null);
    setBridgeImportNotice(null);
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
          mode: 'recap',
          sourceMode,
          lang: primaryLang,
          narratorVoice,
          items: activeBridgeValidation.items,
          expectedIds: activeBridgeBatch.expectedIds,
        }),
      });
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      setBeatDrafts(res.data.project.recap ?? []);
      setDirty(false);
      const rem = res.data.missingIds?.length ?? 0;
      setBridgeImportNotice(
        rem === 0
          ? `Saved Part ${activeBridgeBatch.partIndex}/${activeBridgeBatch.totalParts} (${res.data.importedCount} beats). Edge-TTS & Video Render are unlocked!`
          : `Saved Part ${activeBridgeBatch.partIndex}/${activeBridgeBatch.totalParts}. ${rem} beat(s) remaining in other parts.`,
      );
      if (bridgePrompts && bridgeBatchIdx + 1 < bridgePrompts.batches.length) {
        setBridgeBatchIdx(bridgeBatchIdx + 1);
      }
    } catch (err) {
      setBridgeImportErr(err instanceof Error ? err.message : t.errors.genericFailed);
    } finally {
      setBridgeImporting(false);
    }
  };

  const handleToggleMuteOriginal = async () => {
    setLocalError(null);
    const nextMute = !muteOriginal;
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/recap`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recapMuteOriginal: nextMute }),
        },
      );
      if (!res.ok) throw new Error(res.data.error || t.errors.genericFailed);
    } catch (err) {
      setLocalError(localizeError(err instanceof Error ? err.message : null));
    }
  };

  const handlePreviewNarrator = async () => {
    setLocalError(null);
    setPreviewingVoice(true);
    try {
      const res = await apiFetchJson<{
        ok?: boolean;
        audioBase64?: string;
        mimeType?: string;
        error?: string;
      }>('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: activeEngine,
          voice: narratorVoice,
          lang: primaryLang,
          ...(activeEngine === 'gemini' && capabilities?.config.TTS_MODEL
            ? { model: capabilities.config.TTS_MODEL }
            : {}),
        }),
      });
      if (!res.ok || !res.data.ok || !res.data.audioBase64) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      const fallbackMime = activeEngine === 'edge' ? 'audio/mpeg' : 'audio/wav';
      setVoicePreviewSrc(`data:${res.data.mimeType || fallbackMime};base64,${res.data.audioBase64}`);
    } catch (err) {
      setLocalError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setPreviewingVoice(false);
    }
  };

  const handleGenerateScript = async (force = false, visualAi = false) => {
    setLocalError(null);
    setGeneratingReq(true);
    setDirty(false);
    try {
      const res = await apiFetchJson<{ started?: boolean; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/recap/generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceMode,
            narratorVoice,
            force,
            ...(visualAi ? { visualAi: true } : {}),
          }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
    } catch (err) {
      setLocalError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setGeneratingReq(false);
    }
  };

  const handleGenerateVisualScript = async () => {
    await handleGenerateScript(langBeats.length > 0, true);
  };

  const updateSingleBeatDraft = (beat: RecapBeat, patch: Partial<RecapBeat>) => {
    setDirty(true);
    setSavedNotice(false);
    setBeatDrafts((prev) =>
      prev.map((item) => {
        if (item.lang !== beat.lang || item.id !== beat.id) return item;
        const nextStart = patch.start_ms !== undefined ? Math.max(0, patch.start_ms) : item.start_ms;
        const nextEnd =
          patch.end_ms !== undefined ? Math.max(nextStart + 200, patch.end_ms) : Math.max(nextStart + 200, item.end_ms);
        const slotMs = Math.max(200, nextEnd - nextStart);
        const nextText = patch.narration_text !== undefined ? patch.narration_text : item.narration_text;
        return {
          ...item,
          ...patch,
          start_ms: nextStart,
          end_ms: nextEnd,
          slot_ms: slotMs,
          max_syllables: computeBudgetSyllables(slotMs),
          syllables: estimateRecapSyllables(nextText, item.lang),
        };
      }),
    );
  };

  const handleAddBeat = () => {
    setDirty(true);
    setSavedNotice(false);
    const maxDur = project.video.duration_ms || 30_000;
    const sorted = [...langBeats].sort((a, b) => a.start_ms - b.start_ms);
    const lastEnd = sorted.length > 0 ? sorted[sorted.length - 1].end_ms : 0;
    const startMs = Math.min(Math.max(0, lastEnd), Math.max(0, maxDur - 1000));
    const endMs = Math.min(maxDur, startMs + 4000);
    const slotMs = Math.max(200, endMs - startMs);
    const nextId = sorted.reduce((m, b) => Math.max(m, b.id), 0) + 1;

    const newBeat: RecapBeat = {
      id: nextId,
      lang: primaryLang,
      start_ms: startMs,
      end_ms: endMs,
      src_text: '',
      scene_note: `Custom beat @ ${formatTimecode(startMs)}`,
      narration_text: primaryLang === 'my-MM' ? 'ဇာတ်လမ်းဆက်လက်ဖြစ်ပွားနေတယ်။' : 'The story continues.',
      slot_ms: slotMs,
      max_syllables: computeBudgetSyllables(slotMs),
      syllables: 8,
      tts_ms: 0,
      tts_file: '',
      rate: 1.2,
      video_rate: 1.0,
      status: 'ok',
      voice_name: narratorVoice,
      tts_engine: activeEngine,
    };

    setBeatDrafts((prev) => [...prev, newBeat]);
  };

  const handleDeleteBeat = (beat: RecapBeat) => {
    setDirty(true);
    setSavedNotice(false);
    setBeatDrafts((prev) => prev.filter((b) => !(b.lang === beat.lang && b.id === beat.id)));
  };

  const handleSaveEdits = async () => {
    setLocalError(null);
    setSavingDrafts(true);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/recap`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            beats: beatDrafts,
            sourceMode,
            narratorVoice,
            recapMuteOriginal: muteOriginal,
          }),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      setBeatDrafts(res.data.project.recap ?? []);
      setDirty(false);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
    } catch (err) {
      setLocalError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setSavingDrafts(false);
    }
  };

  const handleApproveAndRender = async () => {
    setLocalError(null);
    setRenderingReq(true);
    try {
      const res = await apiFetchJson<{ started?: boolean; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/recap/approve-render`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            beats: beatDrafts,
            sourceMode,
            narratorVoice,
            recapMuteOriginal: muteOriginal,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      setDirty(false);
    } catch (err) {
      setLocalError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRenderingReq(false);
    }
  };

  const renderedReport =
    project.dub_reports.find((r) => r.lang === primaryLang && Boolean(r.mp4_file)) ??
    project.dub_reports[0] ??
    null;
  const previewVideoUrl = renderedReport?.mp4_file
    ? `/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(renderedReport.lang)}/mp4?t=${encodeURIComponent(renderedReport.generated_at)}`
    : project.video.proxy_480p_file
      ? `/api/projects/${encodeURIComponent(project.id)}/media/proxy`
      : `/api/projects/${encodeURIComponent(project.id)}/media/source`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* LEFT COLUMN (Pinned): Video Preview + Recap Controls */}
      <div className="lg:col-span-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto space-y-4">
        {/* Video Player */}
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

        {/* Header + Primary Generate & Approve Controls */}
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <Film className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{t.recapStudio.title}</span>
              {project.stages.dub.model_used && (
                <span className="text-[11px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-cyan-300">
                  {project.stages.dub.model_used}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">{t.recapStudio.subtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!manualBridgeActive && (
              <button
                type="button"
                disabled={!stage2Ready || isBusy}
                onClick={() => void handleGenerateScript(langBeats.length > 0)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-100 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {generatingReq || (stageRunning && project.recap_script_status === 'idle') ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                ) : langBeats.length > 0 ? (
                  <RotateCcw className="w-3.5 h-3.5 text-cyan-400" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                )}
                <span>
                  {generatingReq
                    ? t.recapStudio.generatingBtn
                    : langBeats.length > 0
                      ? t.recapStudio.regenerateBtn
                      : t.recapStudio.generateBtn}
                </span>
              </button>
            )}

            {!manualBridgeActive && (
              <button
                type="button"
                disabled={!stage2Ready || isBusy}
                onClick={() => void handleGenerateVisualScript()}
                title={t.recapStudio.visualAiHint}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F19] border border-cyan-500/40 text-cyan-200 rounded-lg hover:border-cyan-400/70 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <ScanEye className="w-3.5 h-3.5 text-cyan-300" />
                <span>{t.recapStudio.visualAiBtn}</span>
              </button>
            )}

            {langBeats.length > 0 && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleSaveEdits()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-white/25 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {savingDrafts ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : savedNotice ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Save className="w-3.5 h-3.5 text-slate-300" />
                )}
                <span>
                  {savingDrafts
                    ? t.recapStudio.savingBtn
                    : savedNotice
                      ? t.recapStudio.savedBadge
                      : t.recapStudio.saveEditsBtn}
                </span>
              </button>
            )}

            <button
              type="button"
              disabled={!stage2Ready || langBeats.length === 0 || isBusy}
              onClick={() => void handleApproveAndRender()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 shadow-[0_0_20px_rgba(6,182,212,0.18)]"
            >
              {renderingReq || (stageRunning && project.recap_script_status === 'approved') ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>
                {renderingReq || (stageRunning && project.recap_script_status === 'approved')
                  ? t.recapStudio.renderingBtn
                  : t.recapStudio.approveRenderBtn}
              </span>
            </button>
          </div>

          {/* 2-Option Source Mode Selector (with Auto-Detection) */}
          <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-200">{t.recapStudio.sourceModeTitle}</span>
              {detectReason && <span className="text-[11px] text-slate-400">{detectReason}</span>}
            </div>

            <div className="grid grid-cols-1 gap-2.5">
              {(
                [
                  {
                    id: 'raw_movie' as const,
                    title: t.recapStudio.optionATitle,
                    desc: t.recapStudio.optionADesc,
                    icon: Video,
                  },
                  {
                    id: 'existing_vo' as const,
                    title: t.recapStudio.optionBTitle,
                    desc: t.recapStudio.optionBDesc,
                    icon: Mic,
                  },
                ] as const
              ).map((opt) => {
                const Icon = opt.icon;
                const selected = sourceMode === opt.id;
                const isAuto = autoDetectedMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() => setSourceMode(opt.id)}
                    className={`text-left border rounded-xl p-3.5 transition-colors cursor-pointer space-y-1.5 ${
                      selected
                        ? 'bg-cyan-950/40 border-cyan-400/60 text-slate-100'
                        : 'bg-[#0B0F19] border-white/[0.08] text-slate-300 hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-xs font-semibold">
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            selected ? 'text-cyan-400' : 'text-slate-400'
                          }`}
                        />
                        <span>{opt.title}</span>
                      </span>
                      {isAuto && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 shrink-0">
                          {t.recapStudio.autoDetectedBadge}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Single-Narrator Voice Selector + Original Audio Mute Control */}
          <div className="pt-3 border-t border-white/[0.08] space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex flex-wrap items-center gap-2 text-slate-300 w-full">
                <span className="font-medium whitespace-nowrap">
                  {t.recapStudio.narratorVoiceLabel} ({activeEngine}):
                </span>
                <select
                  value={narratorVoice}
                  disabled={isBusy}
                  onChange={(e) => {
                    setNarratorVoice(e.target.value);
                    setDirty(true);
                  }}
                  className="flex-1 min-w-[180px] px-2.5 py-1.5 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 text-xs font-mono focus:outline-none focus:border-cyan-400/70"
                >
                  {narratorVoiceOptions.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={previewingVoice || isBusy}
                  onClick={() => void handlePreviewNarrator()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-cyan-400/50 cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  {previewingVoice ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Volume2 className="w-3 h-3 text-cyan-400" />
                  )}
                  <span>{t.recapStudio.previewVoiceBtn}</span>
                </button>

                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleToggleMuteOriginal()}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                    muteOriginal
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                  }`}
                  title={t.recapStudio.audioBedInfo}
                >
                  {muteOriginal ? (
                    <VolumeX className="w-3.5 h-3.5" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {muteOriginal ? t.workbench.recapAudioMuted : t.workbench.recapAudioOn}
                  </span>
                </button>
              </div>

              {voicePreviewSrc && (
                <audio controls autoPlay src={voicePreviewSrc} className="h-8 w-full" />
              )}
            </div>
          </div>

          {/* Live Progress & Errors */}
          {(stageRunning || generatingReq || renderingReq) && (
            <div className="border border-cyan-400/40 bg-cyan-950/30 rounded-lg p-3 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between text-xs gap-2">
                <span className="text-cyan-200 font-medium">
                  {project.stages.dub.message || controller.liveLog || t.recapStudio.renderingBtn}
                </span>
                <span className="font-mono text-cyan-300 tabular-nums">
                  {project.stages.dub.progress_pct}%
                  {controller.dubEtaSec !== null && controller.dubEtaSec > 0
                    ? ` · ~${controller.dubEtaSec}s`
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

          {(localError || controller.actionError || project.stages.dub.error) && (
            <div className="border border-red-500/40 bg-red-950/50 rounded-lg px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-red-200">
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="whitespace-pre-wrap break-words leading-relaxed">
                  {localError || controller.actionError || localizeError(project.stages.dub.error)}
                </p>
              </div>
              <button
                type="button"
                disabled={!stage2Ready || isBusy}
                onClick={() => {
                  if (langBeats.length === 0) {
                    void handleGenerateScript(false);
                  } else {
                    void handleApproveAndRender();
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-700/80 hover:bg-red-600 text-white rounded-lg border border-red-500/50 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t.workbench.resumeFailedBtn}</span>
              </button>
            </div>
          )}

          {hasOutput && !stageRunning && (
            <div className="border border-emerald-500/40 bg-emerald-950/30 rounded-lg px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-emerald-200">
              <span>{project.stages.dub.message || 'Recap video rendered & synced.'}</span>
              <button
                type="button"
                onClick={onNextStep}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 font-medium cursor-pointer whitespace-nowrap"
              >
                <span>{t.wizard.nextStep5Btn}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* RIGHT COLUMN (Scrollable): Manual AI Chat Bridge (if enabled) + Editable Script Beats */}
      <div className="lg:col-span-7 space-y-4">
        {manualBridgeActive && (
          <div className="border border-cyan-400/35 bg-[#131A2A] rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <MessageSquareText className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>No-API-Key AI Chat Bridge · Recap ({sourceMode === 'existing_vo' ? 'Recap-to-Recap' : 'Movie Recap'})</span>
              </div>
              <button
                type="button"
                disabled={bridgeLoading || !stage2Ready}
                onClick={() => void fetchRecapBridgePrompts()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 rounded-lg hover:border-cyan-400/50 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${bridgeLoading ? 'animate-spin' : ''}`} />
                <span>Refresh Batches</span>
              </button>
            </div>

            <div className="border border-amber-500/30 bg-amber-500/10 rounded-lg px-3.5 py-2 text-xs text-amber-200">
              {bridgePrompts?.reminder || MANUAL_AI_BATCH_REMINDER}
            </div>

            {bridgeLoadErr && (
              <div className="border border-red-500/40 bg-red-950/40 rounded-lg px-3 py-2 text-xs text-red-200">
                {bridgeLoadErr}
              </div>
            )}

            {bridgePrompts && bridgePrompts.batches.length > 0 && activeBridgeBatch ? (
              <div className="space-y-4">
                {/* Smart Batch Part Selector */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {bridgePrompts.batches.map((b, idx) => {
                    const partDone = b.expectedIds.every((id) => importedBeatIdSet.has(id));
                    const isActive = idx === bridgeBatchIdx;
                    return (
                      <button
                        key={b.partIndex}
                        type="button"
                        onClick={() => setBridgeBatchIdx(idx)}
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
                      1 · Copy Prompt &amp; JSON ({activeBridgeBatch.cueCount} beats · IDs {activeBridgeBatch.startId}–{activeBridgeBatch.endId})
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
                        onClick={() => void handleCopyPrompt()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer"
                      >
                        {bridgeCopiedPart === activeBridgeBatch.partIndex ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {bridgeCopiedPart === activeBridgeBatch.partIndex
                            ? 'Copied!'
                            : '1 · Copy Prompt & JSON'}
                        </span>
                      </button>
                    </div>
                  </div>
                  <textarea
                    readOnly
                    rows={4}
                    value={activeBridgeBatch.promptText}
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
                      onClick={() => void handlePasteReply()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#131A2A] border border-white/10 text-slate-200 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer"
                    >
                      <ClipboardPaste className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Paste from Clipboard</span>
                    </button>
                  </div>
                  <textarea
                    rows={5}
                    placeholder='Paste JSON reply here (markdown ```json fences are stripped automatically), e.g. [{"id": 1, "text": "..."}]'
                    value={activeBridgeRawReply}
                    onChange={(e) => {
                      const val = e.target.value;
                      setBridgeReplyByPart((prev) => ({
                        ...prev,
                        [activeBridgeBatch.partIndex]: val,
                      }));
                    }}
                    className="w-full px-3 py-2 text-xs font-mono bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
                  />
                  {activeBridgeValidation && (
                    <div
                      className={`text-[11px] px-3 py-1.5 rounded-lg border ${
                        activeBridgeValidation.ok
                          ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                          : 'bg-red-500/10 border-red-500/40 text-red-300'
                      }`}
                    >
                      {activeBridgeValidation.ok
                        ? `Valid JSON: matched ${activeBridgeValidation.matchedCount}/${activeBridgeBatch.expectedIds.length} cue IDs cleanly.`
                        : activeBridgeValidation.error || 'JSON reply does not match expected IDs.'}
                    </div>
                  )}
                </div>

                {/* Step 3: Save & Continue */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs space-y-1">
                    {bridgeImportErr && <div className="text-red-300">{bridgeImportErr}</div>}
                    {bridgeImportNotice && <div className="text-emerald-300">{bridgeImportNotice}</div>}
                  </div>
                  <button
                    type="button"
                    disabled={!activeBridgeValidation?.ok || bridgeImporting || isBusy}
                    onClick={() => void handleImportRecapJson()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {bridgeImporting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    <span>3 · Save &amp; Continue</span>
                  </button>
                </div>
              </div>
            ) : !bridgeLoading ? (
              <div className="text-xs text-slate-400">
                {sourceMode === 'existing_vo' && project.speech.length === 0
                  ? 'No voiceover dialogue found for Recap-to-Recap. Switch to Option A (Movie Recap) above to narrate scene windows.'
                  : 'Complete Stage 1 ingest so timeline beats can be prepared.'}
              </div>
            ) : null}
          </div>
        )}

      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <span>
                {formatMsg(t.recapStudio.beatsSummaryLabel, { count: String(langBeats.length) })}
              </span>
              {dirty && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-normal bg-amber-500/15 border border-amber-500/40 text-amber-300">
                  {t.recapStudio.unsavedHint}
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-400">{t.recapStudio.audioBedInfo}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {project.target_langs.length > 1 && (
              <div className="flex items-center gap-1 text-xs mr-1">
                {project.target_langs.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => controller.setActiveLang(l)}
                    className={`px-3 py-1 rounded-full border cursor-pointer transition-colors ${
                      primaryLang === l
                        ? 'bg-cyan-500 border-cyan-400 text-white'
                        : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-white/25'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              disabled={isBusy}
              onClick={handleAddBeat}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-cyan-400/50 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-cyan-400" />
              <span>{t.recapStudio.addBeatBtn.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        </div>

        {langBeats.length === 0 ? (
          <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-10 text-center text-xs text-slate-400">
            {t.recapStudio.emptyScriptHint}
          </div>
        ) : (
          <div className="space-y-3">
            {langBeats.map((beat) => {
              const slotMs = Math.max(200, beat.end_ms - beat.start_ms);
              const maxSyl = beat.max_syllables ?? computeBudgetSyllables(slotMs);
              const syl = estimateRecapSyllables(beat.narration_text, beat.lang);
              const sylOk = syl <= maxSyl;
              const clipBasename = beat.tts_file ? beat.tts_file.split('/').pop() : '';

              return (
                <div
                  key={`${beat.lang}:${beat.id}`}
                  className="border border-white/[0.08] bg-[#0B0F19]/80 hover:bg-[#0B0F19] hover:border-cyan-400/40 rounded-xl p-4 space-y-3 transition-all"
                >
                  {/* Beat Card Header: ID, Timecode, Inline Slot ms, Speed/Sync Pills & Delete */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-white/10 font-mono font-semibold text-slate-200 tabular-nums">
                        #{beat.id}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] font-mono text-[10px] text-slate-300 tabular-nums">
                        {(slotMs / 1000).toFixed(1)}s slot
                      </span>
                      <span className="font-mono text-[11px] text-cyan-300 tabular-nums">
                        {formatTimecode(beat.start_ms)} – {formatTimecode(beat.end_ms)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono tabular-nums">
                      <span
                        className={`px-2 py-0.5 rounded-full border ${
                          sylOk
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                        }`}
                      >
                        {formatMsg(
                          sylOk ? t.recapStudio.syllableOkLabel : t.recapStudio.syllableOverLabel,
                          { syl: String(syl), max: String(maxSyl) },
                        )}
                      </span>

                      <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-300">
                        TTS: {beat.tts_ms > 0 ? `${beat.tts_ms}ms` : '—'}
                      </span>

                      <span className="px-2 py-0.5 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-cyan-300">
                        {beat.rate.toFixed(2)}x
                      </span>

                      <span
                        className={`px-2 py-0.5 rounded-full border ${
                          beat.video_rate < 0.999
                            ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                            : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        }`}
                      >
                        {beat.video_rate.toFixed(2)}x
                      </span>

                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDeleteBeat(beat)}
                        title="Delete beat"
                        className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg border border-transparent hover:border-red-500/40 cursor-pointer disabled:opacity-40 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Visual / Dialogue Context */}
                  {(beat.scene_note || (beat.src_text && beat.src_text !== beat.scene_note)) && (
                    <div className="text-xs bg-[#131A2A]/70 border border-white/[0.05] rounded-lg px-3 py-2 space-y-1">
                      {beat.scene_note && (
                        <div className="text-slate-200 leading-relaxed">{beat.scene_note}</div>
                      )}
                      {beat.src_text && beat.src_text !== beat.scene_note && (
                        <div className="text-[11px] text-slate-400 leading-relaxed">
                          {beat.src_text}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Prominent Burmese Narration Editor */}
                  <textarea
                    rows={2}
                    disabled={isBusy}
                    value={beat.narration_text}
                    onChange={(e) =>
                      updateSingleBeatDraft(beat, { narration_text: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 text-sm leading-[1.75] bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70 transition-colors"
                  />

                  {beat.review_reason && (
                    <div className="text-[11px] text-amber-300/90">{beat.review_reason}</div>
                  )}

                  {/* Footer: Precise Time Inputs + Audio Clip + Model */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1 font-mono text-[10px] tabular-nums">
                        <input
                          type="number"
                          min={0}
                          step={200}
                          disabled={isBusy}
                          value={beat.start_ms}
                          onChange={(e) =>
                            updateSingleBeatDraft(beat, { start_ms: Number(e.target.value) || 0 })
                          }
                          aria-label="start_ms"
                          className="w-20 px-2 py-1 bg-[#131A2A] border border-white/10 rounded-md text-slate-200 focus:outline-none focus:border-cyan-400/70"
                        />
                        <span className="text-slate-500">–</span>
                        <input
                          type="number"
                          min={200}
                          step={200}
                          disabled={isBusy}
                          value={beat.end_ms}
                          onChange={(e) =>
                            updateSingleBeatDraft(beat, { end_ms: Number(e.target.value) || 200 })
                          }
                          aria-label="end_ms"
                          className="w-20 px-2 py-1 bg-[#131A2A] border border-white/10 rounded-md text-slate-200 focus:outline-none focus:border-cyan-400/70"
                        />
                      </div>

                      {beat.model_used && (
                        <span className="text-[10px] font-mono text-slate-500">
                          {beat.model_used}
                        </span>
                      )}
                    </div>

                    {clipBasename && (
                      <audio
                        controls
                        preload="none"
                        src={`/api/projects/${encodeURIComponent(project.id)}/media/dubclip/${encodeURIComponent(clipBasename)}?v=${beat.tts_ms}`}
                        className="h-8 w-64 max-w-full"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
};
