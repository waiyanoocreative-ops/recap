import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  Film,
  Languages,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  MANUAL_AI_BATCH_REMINDER,
  parseManualAiJsonReply,
  type CapabilitiesResponse,
  type DubSegment,
  type DubSelection,
  type EdgeVoiceInfo,
  type Gender,
  type GeminiVoiceInfo,
  type ManualAiPromptsResponse,
  type Project,
  type SpeechStyle,
  type TargetLang,
  type TtsEngineType,
  type VoicesCatalogResponse,
} from '../../shared/projectTypes';
import {
  getVoiceGender,
  mergeSentenceUnits,
  validateTranslationCompleteness,
  type SentenceUnitCue,
} from '../../shared/dubUtils';
import {
  filterTextModels,
  filterTranscribeModels,
  filterTtsModels,
} from '../../shared/modelFilters';
import { formatMsg, useI18n } from '../i18n/I18nContext';
import { apiFetchJson, sanitizeUiErrorText } from '../utils/apiClient';
import { formatTimecode } from '../utils/format';

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

interface DubbingStudioPanelProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  dubEtaSec: number | null;
  onProjectChange: (project: Project) => void;
  onGenderChange: (speakerId: string, gender: Gender) => Promise<void>;
  onConfigSaved: () => Promise<void> | void;
}

const FALLBACK_EDGE_VOICES: EdgeVoiceInfo[] = [
  { name: 'my-MM-NilarNeural', friendlyName: 'Microsoft Nilar Online (Natural) - Burmese', gender: 'female', locale: 'my-MM' },
  { name: 'my-MM-ThihaNeural', friendlyName: 'Microsoft Thiha Online (Natural) - Burmese', gender: 'male', locale: 'my-MM' },
  { name: 'en-US-JennyNeural', friendlyName: 'Microsoft Jenny Online (Natural) - English (US)', gender: 'female', locale: 'en-US' },
  { name: 'en-US-AriaNeural', friendlyName: 'Microsoft Aria Online (Natural) - English (US)', gender: 'female', locale: 'en-US' },
  { name: 'en-US-GuyNeural', friendlyName: 'Microsoft Guy Online (Natural) - English (US)', gender: 'male', locale: 'en-US' },
  { name: 'en-US-AndrewMultilingualNeural', friendlyName: 'Microsoft AndrewMultilingual Online (Natural) - English (US)', gender: 'male', locale: 'en-US' },
];

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

function defaultEdgeVoiceFor(
  lang: TargetLang,
  gender: Gender,
  catalog: EdgeVoiceInfo[],
): string {
  const list = catalog.length > 0 ? catalog : FALLBACK_EDGE_VOICES;
  const g = gender === 'male' ? 'male' : 'female';
  const exact = list.find((v) => v.locale === lang && v.gender === g);
  if (exact) return exact.name;
  const langPrefix = lang.split('-')[0];
  const samePrefix = list.find((v) => v.locale.startsWith(`${langPrefix}-`) && v.gender === g);
  if (samePrefix) return samePrefix.name;
  return g === 'male' ? 'my-MM-ThihaNeural' : 'my-MM-NilarNeural';
}

export const DubbingStudioPanel: React.FC<DubbingStudioPanelProps> = ({
  project,
  capabilities,
  dubEtaSec,
  onProjectChange,
  onGenderChange,
  onConfigSaved,
}) => {
  const { t, localizeError } = useI18n();

  const [selection, setSelection] = useState<DubSelection>(project.dub_selection);
  const [activeLang, setActiveLang] = useState<TargetLang>(project.target_langs[0] ?? 'my-MM');
  const [translating, setTranslating] = useState(false);
  const [renderingReq, setRenderingReq] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  const [edgeVoices, setEdgeVoices] = useState<EdgeVoiceInfo[]>([]);
  const [edgeUnavailable, setEdgeUnavailable] = useState(false);
  const [geminiVoices, setGeminiVoices] = useState<GeminiVoiceInfo[]>([]);
  const [savingVoiceSpk, setSavingVoiceSpk] = useState<string | null>(null);
  const [previewingSpk, setPreviewingSpk] = useState<string | null>(null);
  const [voicePreviewAudio, setVoicePreviewAudio] = useState<{
    speaker: string;
    voice: string;
    src: string;
  } | null>(null);

  const [savingSettings, setSavingSettings] = useState(false);

  const [lineDrafts, setLineDrafts] = useState<Record<string, string>>({});
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [retranslatingKey, setRetranslatingKey] = useState<string | null>(null);

  const [bridgeEnabled, setBridgeEnabled] = useState<boolean>(Boolean(project.useManualAiBridge));
  const [savingBridge, setSavingBridge] = useState(false);
  const [dubBridgePrompts, setDubBridgePrompts] = useState<ManualAiPromptsResponse | null>(null);
  const [dubBridgeLoading, setDubBridgeLoading] = useState(false);
  const [dubBridgeLoadErr, setDubBridgeLoadErr] = useState<string | null>(null);
  const [dubBridgeBatchIdx, setDubBridgeBatchIdx] = useState(0);
  const [dubBridgeReplyByPart, setDubBridgeReplyByPart] = useState<Record<number, string>>({});
  const [dubBridgeCopiedPart, setDubBridgeCopiedPart] = useState<number | null>(null);
  const [dubBridgeImporting, setDubBridgeImporting] = useState(false);
  const [dubBridgeNotice, setDubBridgeNotice] = useState<string | null>(null);
  const [dubBridgeErr, setDubBridgeErr] = useState<string | null>(null);

  const activeEngine: TtsEngineType =
    capabilities?.config.TTS_ENGINE ?? (edgeUnavailable ? 'gemini' : 'edge');
  const speechStyle: SpeechStyle = capabilities?.config.SPEECH_STYLE ?? 'polite';
  const configuredTtsModel = capabilities?.config.TTS_MODEL ?? '';
  const configuredTtsFallbacks = useMemo(
    () => capabilities?.config.TTS_FALLBACK_MODELS ?? [],
    [capabilities?.config.TTS_FALLBACK_MODELS],
  );
  const configuredTextModel = capabilities?.config.TEXT_MODEL ?? '';
  const configuredTranscribeModel = capabilities?.config.TRANSCRIBE_MODEL ?? '';
  const configuredTtsVolumePct = capabilities?.config.TTS_VOLUME_PCT ?? 150;
  const [ttsVolumeDraft, setTtsVolumeDraft] = useState<number>(configuredTtsVolumePct);
  const availableModels = useMemo(
    () => capabilities?.gemini.availableModels ?? [],
    [capabilities?.gemini.availableModels],
  );

  const textModelOptions = useMemo(
    () => filterTextModels(availableModels, configuredTextModel),
    [availableModels, configuredTextModel],
  );
  const transcribeModelOptions = useMemo(
    () => filterTranscribeModels(availableModels, configuredTranscribeModel),
    [availableModels, configuredTranscribeModel],
  );
  const ttsModelOptions = useMemo(
    () => filterTtsModels(availableModels, configuredTtsModel, configuredTtsFallbacks),
    [availableModels, configuredTtsModel, configuredTtsFallbacks],
  );

  useEffect(() => {
    setTtsVolumeDraft(configuredTtsVolumePct);
  }, [configuredTtsVolumePct]);

  useEffect(() => {
    setSelection(project.dub_selection);
  }, [project.id, project.dub_selection]);

  useEffect(() => {
    if (!project.target_langs.includes(activeLang)) {
      setActiveLang(project.target_langs[0] ?? 'my-MM');
    }
  }, [project.target_langs, activeLang]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetchJson<VoicesCatalogResponse>('/api/voices');
        if (!active || !res.ok) return;
        if (res.data.gemini?.voices) {
          setGeminiVoices(res.data.gemini.voices);
        }
        if (res.data.edge?.voices) {
          setEdgeVoices(res.data.edge.voices);
        }
        if (res.data.edge?.error) {
          setEdgeUnavailable(true);
        }
      } catch {
        // Ignore transient voices catalog failure
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setLineDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const seg of project.dub) {
        const k = `${seg.lang}:${seg.id}`;
        next[k] = prev[k] !== undefined ? prev[k] : seg.tgt_text;
      }
      return next;
    });
  }, [project.id, project.dub]);

  const mergedCues = useMemo(() => mergeSentenceUnits(project.speech), [project.speech]);
  const selectedPreview = useMemo(() => {
    if (mergedCues.length === 0) {
      return {
        selectedCount: 0,
        totalCount: 0,
        isFullVideo: true,
        startMs: 0,
        endMs: project.video.duration_ms || 0,
      };
    }
    let slice: SentenceUnitCue[];
    if (selection.mode === 'all') {
      slice = mergedCues;
    } else if (selection.mode === 'range') {
      const s = Math.max(1, Math.min(mergedCues.length, selection.start_idx));
      const e = Math.max(s, Math.min(mergedCues.length, selection.end_idx));
      slice = mergedCues.slice(s - 1, e);
    } else {
      const cnt = Math.max(1, Math.min(mergedCues.length, selection.count));
      slice = mergedCues.slice(0, cnt);
    }
    const isFullVideo = slice.length === mergedCues.length;
    const startMs = isFullVideo ? 0 : Math.max(0, slice[0].start_ms - 400);
    const endMs = isFullVideo
      ? project.video.duration_ms || 0
      : Math.min(
          project.video.duration_ms || slice[slice.length - 1].end_ms + 600,
          slice[slice.length - 1].end_ms + 600,
        );
    return {
      selectedCount: slice.length,
      totalCount: mergedCues.length,
      isFullVideo,
      startMs,
      endMs,
    };
  }, [mergedCues, selection, project.video.duration_ms]);

  useEffect(() => {
    setBridgeEnabled(Boolean(project.useManualAiBridge));
  }, [project.id, project.useManualAiBridge]);

  const isDubRunning = renderingReq || project.stages.dub.status === 'running';
  const stage2Done = project.stages.speech.status === 'done';

  const langCues = useMemo(
    () => project.dub.filter((d) => d.lang === activeLang),
    [project.dub, activeLang],
  );
  const importedCueIdSet = useMemo(() => new Set(langCues.map((d) => d.id)), [langCues]);

  const fetchDubBridgePrompts = async () => {
    setDubBridgeLoading(true);
    setDubBridgeLoadErr(null);
    try {
      const qs = new URLSearchParams({
        mode: 'dubbing',
        lang: activeLang,
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
    if (!bridgeEnabled || !stage2Done) {
      return;
    }
    void fetchDubBridgePrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bridgeEnabled,
    stage2Done,
    project.id,
    activeLang,
    project.speech.length,
    selection.mode,
    selection.count,
    selection.start_idx,
    selection.end_idx,
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
    setPanelError(null);
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
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
    } catch (err) {
      setBridgeEnabled(!nextVal);
      setPanelError(localizeError(err instanceof Error ? err.message : null));
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
          lang: activeLang,
          items: activeDubValidation.items,
          expectedIds: activeDubBatch.expectedIds,
        }),
      });
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
      setLineDrafts((prev) => {
        const next = { ...prev };
        for (const item of activeDubValidation.items) {
          next[`${activeLang}:${item.id}`] = item.text;
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

  const saveConfigPatch = async (patch: Record<string, unknown>) => {
    setPanelError(null);
    setSavingSettings(true);
    try {
      const res = await apiFetchJson<{ error?: string }>('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        throw new Error(res.data?.error || t.errors.genericFailed);
      }
      await onConfigSaved();
    } catch (err) {
      setPanelError(localizeError(sanitizeUiErrorText(err)));
    } finally {
      setSavingSettings(false);
    }
  };

  const saveSelection = async (next: DubSelection) => {
    setSelection(next);
    try {
      const res = await apiFetchJson<{ project?: Project }>(
        `/api/projects/${encodeURIComponent(project.id)}/dub/selection`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        },
      );
      if (res.ok && res.data.project) {
        onProjectChange(res.data.project);
      }
    } catch {
      // Selection will also be submitted on Translate/Render
    }
  };

  const handleTranslate = async (force = false) => {
    setPanelError(null);
    setTranslating(true);
    setLineDrafts({});
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/dub/translate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selection, force }),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
    } catch (err) {
      setPanelError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setTranslating(false);
    }
  };

  const handleRenderDub = async () => {
    setPanelError(null);
    setRenderingReq(true);
    try {
      const res = await apiFetchJson<{ error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/dub/render`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selection }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
    } catch (err) {
      setPanelError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRenderingReq(false);
    }
  };

  const handleAssignVoice = async (speakerId: string, voiceName: string) => {
    setPanelError(null);
    setSavingVoiceSpk(speakerId);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/speakers/${encodeURIComponent(speakerId)}/voice`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceName, engine: activeEngine }),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
    } catch (err) {
      setPanelError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setSavingVoiceSpk(null);
    }
  };

  const handlePreviewVoice = async (speakerId: string, voiceName: string) => {
    setPanelError(null);
    setPreviewingSpk(speakerId);
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
          voice: voiceName,
          lang: activeLang,
          ...(activeEngine === 'gemini' && configuredTtsModel
            ? { model: configuredTtsModel }
            : {}),
        }),
      });
      if (!res.ok || !res.data.ok || !res.data.audioBase64) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      const fallbackMime = activeEngine === 'edge' ? 'audio/mpeg' : 'audio/wav';
      const src = `data:${res.data.mimeType || fallbackMime};base64,${res.data.audioBase64}`;
      setVoicePreviewAudio({ speaker: speakerId, voice: voiceName, src });
    } catch (err) {
      if (activeEngine === 'edge') {
        setEdgeUnavailable(true);
        void saveConfigPatch({ TTS_ENGINE: 'gemini' });
      }
      setPanelError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setPreviewingSpk(null);
    }
  };

  const handleRegenerateLine = async (seg: DubSegment) => {
    const key = `${seg.lang}:${seg.id}`;
    const draftText = lineDrafts[key] ?? seg.tgt_text;
    setPanelError(null);
    setRegeneratingKey(key);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/dub/segments/${seg.id}/regenerate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lang: seg.lang,
            tgt_text: draftText,
            voice_name: seg.voice_name,
          }),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
    } catch (err) {
      setPanelError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRegeneratingKey(null);
    }
  };

  const handleRetranslateCompleteLine = async (seg: DubSegment) => {
    const key = `${seg.lang}:${seg.id}`;
    setPanelError(null);
    setRetranslatingKey(key);
    try {
      const res = await apiFetchJson<{
        project?: Project;
        segment?: DubSegment;
        error?: string;
      }>(
        `/api/projects/${encodeURIComponent(project.id)}/dub/segments/${seg.id}/retranslate-complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang: seg.lang }),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      if (res.data.segment) {
        setLineDrafts((prev) => ({
          ...prev,
          [key]: res.data.segment!.tgt_text,
        }));
      }
      onProjectChange(res.data.project);
    } catch (err) {
      setPanelError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRetranslatingKey(null);
    }
  };

  const getStatusBadgeStyle = (status: DubSegment['status']) => {
    switch (status) {
      case 'ok':
        return {
          label: t.dubbing.statusOk,
          cls: 'bg-emerald-950/70 border-emerald-700 text-emerald-300',
        };
      case 'compressed':
        return {
          label: t.dubbing.statusCompressed,
          cls: 'bg-blue-950/70 border-blue-700 text-blue-300',
        };
      case 'retranslated':
        return {
          label: t.dubbing.statusRetranslated,
          cls: 'bg-cyan-950/70 border-cyan-700 text-cyan-300',
        };
      case 'needs_review':
        return {
          label: t.dubbing.statusNeedsReview,
          cls: 'bg-amber-950/70 border-amber-700 text-amber-300',
        };
      case 'overflow':
        return {
          label: t.dubbing.statusOverflow,
          cls: 'bg-red-950/70 border-red-700 text-red-300',
        };
    }
  };

  const activeReport = useMemo(
    () => project.dub_reports.find((r) => r.lang === activeLang) ?? null,
    [project.dub_reports, activeLang],
  );
  const speakerEntries = useMemo(() => Object.entries(project.speakers), [project.speakers]);
  const activeGlossary = project.dub_glossary?.[activeLang] ?? {};
  const glossaryEntries = Object.entries(activeGlossary);
  const effectiveSps =
    project.calibrated_sps?.[activeLang] ?? capabilities?.config.SYLLABLES_PER_SEC?.[activeLang] ?? 4.0;

  return (
    <div className="p-5 space-y-5">
      {/* Header + Ducking Notice + Selection Bar */}
      <div className="border border-slate-800 bg-[#0F172A] rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <Languages className="w-4 h-4 text-blue-400 shrink-0" />
              <span>{t.dubbing.title}</span>
              {project.stages.dub.model_used && (
                <span className="px-2 py-0.5 text-[11px] font-mono font-normal rounded bg-[#1E293B] border border-slate-700 text-blue-300">
                  {t.dubbing.modelUsedLabel}: {project.stages.dub.model_used}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">{t.dubbing.subtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={bridgeEnabled}
              aria-label="Use My AI Chat App (No API Key Required)"
              disabled={savingBridge || isDubRunning}
              onClick={() => void handleToggleManualBridge()}
              className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                bridgeEnabled
                  ? 'bg-emerald-950/60 border-emerald-600 text-emerald-200 hover:bg-emerald-900/50'
                  : 'bg-[#1E293B] border-slate-700 text-slate-300 hover:border-blue-500'
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
              <MessageSquareText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>Use My AI Chat App (No API Key Required)</span>
            </button>

            {!bridgeEnabled && (
              <button
                type="button"
                disabled={!stage2Done || translating || isDubRunning}
                onClick={() => void handleTranslate(false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-800 border border-slate-600 text-slate-100 rounded-md hover:border-blue-500 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {translating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                )}
                {translating ? t.dubbing.translatingBtn : t.dubbing.translateBtn}
              </button>
            )}

            <button
              type="button"
              disabled={
                !stage2Done ||
                translating ||
                isDubRunning ||
                (bridgeEnabled && langCues.length === 0)
              }
              onClick={() => void handleRenderDub()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-500 cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {isDubRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {isDubRunning ? t.dubbing.renderingBtn : t.dubbing.renderBtn}
            </button>

            {!bridgeEnabled && (
              <button
                type="button"
                disabled={!stage2Done || translating || isDubRunning}
                onClick={() => void handleTranslate(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1E293B] border border-slate-700 text-slate-300 rounded-md hover:border-slate-500 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t.dubbing.retranslateAllBtn}
              </button>
            )}
          </div>
        </div>

        {/* Rule 1: Segments to process + Empirical SPS + Ducking Notice */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-2 border-t border-slate-800/80 items-center">
          <div className="lg:col-span-7 flex flex-wrap items-center gap-2 text-xs">
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
                disabled={isDubRunning}
                onClick={() => void saveSelection({ ...selection, mode: modeId })}
                className={`px-2.5 py-1 rounded border transition-colors cursor-pointer whitespace-nowrap ${
                  selection.mode === modeId
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-[#1E293B] border-slate-700 text-slate-300 hover:border-slate-500'
                }`}
              >
                {label}
              </button>
            ))}

            {selection.mode === 'first_n' && (
              <label className="inline-flex items-center gap-1.5 text-slate-300 ml-1">
                <span>{t.dubbing.firstNCountLabel}</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, mergedCues.length || 999)}
                  disabled={isDubRunning}
                  value={selection.count}
                  onChange={(e) =>
                    void saveSelection({
                      ...selection,
                      count: Math.max(1, Number(e.target.value) || 8),
                    })
                  }
                  className="w-16 px-2 py-1 bg-[#1E293B] border border-slate-700 rounded text-slate-100 font-mono tabular-nums"
                />
              </label>
            )}

            {selection.mode === 'range' && (
              <div className="inline-flex items-center gap-1.5 text-slate-300 ml-1">
                <span>{t.dubbing.rangeStartLabel}</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, mergedCues.length || 999)}
                  disabled={isDubRunning}
                  value={selection.start_idx}
                  onChange={(e) =>
                    void saveSelection({
                      ...selection,
                      start_idx: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                  className="w-16 px-2 py-1 bg-[#1E293B] border border-slate-700 rounded text-slate-100 font-mono tabular-nums"
                />
                <span>{t.dubbing.rangeEndLabel}</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, mergedCues.length || 999)}
                  disabled={isDubRunning}
                  value={selection.end_idx}
                  onChange={(e) =>
                    void saveSelection({
                      ...selection,
                      end_idx: Math.max(selection.start_idx, Number(e.target.value) || 8),
                    })
                  }
                  className="w-16 px-2 py-1 bg-[#1E293B] border border-slate-700 rounded text-slate-100 font-mono tabular-nums"
                />
              </div>
            )}
          </div>

          <div className="lg:col-span-5 flex flex-wrap items-center justify-end gap-3 text-xs">
            <span className="font-mono text-slate-300 tabular-nums">
              {t.dubbing.calibratedSpsLabel}{' '}
              <strong className="text-blue-300">{effectiveSps}</strong>
            </span>
            {project.mode === 'dubbing' ? (
              <span className="px-2.5 py-1 rounded bg-slate-800 border border-emerald-700/70 text-emerald-300">
                {t.dubbing.duckingNotice}
              </span>
            ) : (
              <button
                type="button"
                disabled={isDubRunning}
                onClick={async () => {
                  const res = await apiFetchJson<{ project?: Project; error?: string }>(
                    `/api/projects/${encodeURIComponent(project.id)}`,
                    {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        recap_mute_original: !(project.recap_mute_original ?? true),
                      }),
                    },
                  );
                  if (res.ok && res.data.project) {
                    onProjectChange(res.data.project);
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                  project.recap_mute_original ?? true
                    ? 'bg-amber-950/60 border-amber-700 text-amber-200 hover:bg-amber-900/60'
                    : 'bg-emerald-950/60 border-emerald-700 text-emerald-200 hover:bg-emerald-900/60'
                }`}
              >
                {project.recap_mute_original ?? true ? (
                  <VolumeX className="w-3.5 h-3.5" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                <span>
                  {project.recap_mute_original ?? true
                    ? t.workbench.recapAudioMuted
                    : t.workbench.recapAudioOn}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="text-[11px] font-mono text-slate-400">
          {selectedPreview.isFullVideo
            ? formatMsg(t.dubbing.selectionFullVideoHint, {
                total: selectedPreview.totalCount,
              })
            : formatMsg(t.dubbing.selectionTestClipHint, {
                count: selectedPreview.selectedCount,
                total: selectedPreview.totalCount,
                start: formatTimecode(selectedPreview.startMs),
                end: formatTimecode(selectedPreview.endMs),
              })}
        </div>

        {/* Live Progress & ETA */}
        {(isDubRunning || project.chunk_progress?.active) && (
          <div className="border border-blue-900/70 bg-blue-950/30 rounded-md p-3 space-y-1.5">
            {project.chunk_progress?.message && (
              <div className="text-xs font-semibold text-amber-200">
                {project.chunk_progress.message}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between text-xs gap-2">
              <span className="text-blue-200 font-medium">
                {project.stages.dub.message || t.dubbing.renderingBtn}
              </span>
              <span className="font-mono text-blue-300 tabular-nums">
                {project.stages.dub.progress_pct}%
                {dubEtaSec !== null && dubEtaSec > 0
                  ? ` · ${t.dubbing.etaLabel} ~${dubEtaSec}${t.dubbing.secondsUnit}`
                  : ''}
              </span>
            </div>
            <div className="h-2 bg-slate-900 rounded overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${project.stages.dub.progress_pct}%` }}
              />
            </div>
          </div>
        )}

        {(panelError || project.stages.dub.error) && (
          <div className="border border-red-800 bg-red-950/60 rounded-md px-3.5 py-2.5 flex items-start gap-2.5 text-xs text-red-200">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <pre className="whitespace-pre-wrap break-words font-sans">
              {panelError || localizeError(project.stages.dub.error)}
            </pre>
          </div>
        )}
      </div>

      {/* Step C: Linked Engine & Model Settings + Speaker Voice Mapping + Preview */}
      <div className="border border-slate-800 bg-[#0F172A] rounded-lg p-4 space-y-4">
        <div className="border border-slate-800 bg-[#1E293B]/60 rounded-md p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-200">
              {t.dubbing.stepCSettingsTitle}
            </div>
            {savingSettings && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-blue-300">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t.dubbing.savingSettingsBtn}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-[11px] text-slate-400 mb-1">{t.settings.ttsEngineTitle}</div>
              <div className="inline-flex w-full p-0.5 bg-[#0F172A] border border-slate-700 rounded">
                <button
                  type="button"
                  disabled={edgeUnavailable || savingSettings || isDubRunning}
                  onClick={() => void saveConfigPatch({ TTS_ENGINE: 'edge' })}
                  className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                    edgeUnavailable
                      ? 'opacity-45 cursor-not-allowed text-slate-500'
                      : activeEngine === 'edge'
                        ? 'bg-blue-600 text-white cursor-pointer'
                        : 'text-slate-300 hover:bg-slate-800 cursor-pointer'
                  }`}
                >
                  Edge TTS
                </button>
                <button
                  type="button"
                  disabled={savingSettings || isDubRunning}
                  onClick={() => void saveConfigPatch({ TTS_ENGINE: 'gemini' })}
                  className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                    activeEngine === 'gemini'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Gemini TTS
                </button>
              </div>
              {edgeUnavailable && (
                <div className="mt-1 text-[10px] text-amber-300">{t.settings.edgeUnavailableBadge}</div>
              )}
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                {t.settings.speechStyleLabel}
              </label>
              <select
                disabled={savingSettings || isDubRunning}
                value={speechStyle}
                onChange={(e) =>
                  void saveConfigPatch({ SPEECH_STYLE: e.target.value as SpeechStyle })
                }
                className="w-full px-2.5 py-1.5 text-xs bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="polite">{t.settings.speechStylePolite}</option>
                <option value="casual">{t.settings.speechStyleCasual}</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">TEXT_MODEL</label>
              <select
                disabled={savingSettings || isDubRunning}
                value={configuredTextModel}
                onChange={(e) => void saveConfigPatch({ TEXT_MODEL: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
              >
                {textModelOptions.length === 0 && <option value="">—</option>}
                {textModelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">TRANSCRIBE_MODEL</label>
              <select
                disabled={savingSettings || isDubRunning}
                value={configuredTranscribeModel}
                onChange={(e) => void saveConfigPatch({ TRANSCRIBE_MODEL: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
              >
                {transcribeModelOptions.length === 0 && <option value="">—</option>}
                {transcribeModelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80 text-xs">
            <label className="flex items-center gap-3 flex-1 min-w-[260px]">
              <span className="text-[11px] text-slate-400 whitespace-nowrap">
                {t.dubbing.ttsVolumeLabel}
              </span>
              <input
                type="range"
                min={100}
                max={200}
                step={5}
                disabled={savingSettings || isDubRunning}
                value={ttsVolumeDraft}
                onChange={(e) => setTtsVolumeDraft(Number(e.target.value))}
                onMouseUp={(e) => {
                  const val = Number((e.target as HTMLInputElement).value);
                  if (val !== configuredTtsVolumePct) {
                    void saveConfigPatch({ TTS_VOLUME_PCT: val });
                  }
                }}
                onTouchEnd={(e) => {
                  const val = Number((e.target as HTMLInputElement).value);
                  if (val !== configuredTtsVolumePct) {
                    void saveConfigPatch({ TTS_VOLUME_PCT: val });
                  }
                }}
                onKeyUp={(e) => {
                  const val = Number((e.target as HTMLInputElement).value);
                  if (val !== configuredTtsVolumePct) {
                    void saveConfigPatch({ TTS_VOLUME_PCT: val });
                  }
                }}
                className="flex-1 accent-blue-500 cursor-pointer"
              />
              <span className="font-mono text-xs text-blue-300 tabular-nums w-12 text-right">
                {ttsVolumeDraft}%
              </span>
            </label>
            <div className="flex items-center gap-1.5">
              {[100, 150, 200].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={savingSettings || isDubRunning}
                  onClick={() => {
                    setTtsVolumeDraft(preset);
                    if (preset !== configuredTtsVolumePct) {
                      void saveConfigPatch({ TTS_VOLUME_PCT: preset });
                    }
                  }}
                  className={`px-2 py-0.5 text-[11px] font-mono rounded border cursor-pointer disabled:opacity-50 ${
                    ttsVolumeDraft === preset
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-[#0F172A] border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {preset}%
                </button>
              ))}
            </div>
          </div>

          {activeEngine === 'gemini' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800/80 text-xs">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">TTS_MODEL</label>
                <select
                  disabled={savingSettings || isDubRunning}
                  value={configuredTtsModel}
                  onChange={(e) => void saveConfigPatch({ TTS_MODEL: e.target.value })}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  {ttsModelOptions.length === 0 && <option value="">—</option>}
                  {ttsModelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-[11px] text-slate-400 mb-1">
                  {t.settings.ttsFallbacksLabel}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ttsModelOptions
                    .filter((m) => m !== configuredTtsModel)
                    .map((m) => {
                      const active = configuredTtsFallbacks.includes(m);
                      return (
                        <button
                          key={m}
                          type="button"
                          disabled={savingSettings || isDubRunning}
                          onClick={() => {
                            const next = active
                              ? configuredTtsFallbacks.filter((x) => x !== m)
                              : [...configuredTtsFallbacks, m];
                            void saveConfigPatch({ TTS_FALLBACK_MODELS: next });
                          }}
                          className={`px-2 py-1 text-[11px] font-mono rounded border cursor-pointer ${
                            active
                              ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                              : 'bg-[#0F172A] border-slate-700 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {m}
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <Volume2 className="w-4 h-4 text-blue-400" />
            <span>
              {formatMsg(t.dubbing.voiceMapTitle, {
                engine: activeEngine === 'edge' ? 'Edge TTS' : 'Gemini TTS',
              })}
            </span>
          </div>
          {voicePreviewAudio && (
            <div className="flex items-center gap-2 text-[11px] text-slate-300">
              <span className="font-mono">
                {voicePreviewAudio.speaker} ({voicePreviewAudio.voice})
              </span>
              <audio controls src={voicePreviewAudio.src} className="h-7 w-56" />
            </div>
          )}
        </div>

        {speakerEntries.length === 0 ? (
          <div className="text-xs text-slate-400">{t.dubbing.voiceMapEmpty}</div>
        ) : (
          <div className="overflow-x-auto border border-slate-800 rounded-md">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-[#1E293B] border-b border-slate-800 text-[11px] text-slate-400">
                <tr>
                  <th className="py-2 px-3">{t.dubbing.colSpeaker}</th>
                  <th className="py-2 px-3">{t.dubbing.colGender}</th>
                  <th className="py-2 px-3">
                    {formatMsg(t.dubbing.colVoiceForEngine, {
                      engine: activeEngine === 'edge' ? 'Edge' : 'Gemini',
                    })}
                  </th>
                  <th className="py-2 px-3 text-right">{t.dubbing.colPreview}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {speakerEntries.map(([speakerId, info]) => {
                  const edgeList = edgeVoices.length > 0 ? edgeVoices : FALLBACK_EDGE_VOICES;
                  const storedEngineMatches = info.voice?.engine === activeEngine && Boolean(info.voice.name);
                  const storedVoiceGender = storedEngineMatches
                    ? getVoiceGender(info.voice?.name, activeEngine, edgeList)
                    : null;
                  const genderAligned =
                    info.voice_overridden ||
                    info.gender === 'unknown' ||
                    storedVoiceGender === null ||
                    storedVoiceGender === info.gender;
                  const currentVoice =
                    storedEngineMatches && genderAligned
                      ? info.voice!.name
                      : activeEngine === 'edge'
                        ? defaultEdgeVoiceFor(activeLang, info.gender, edgeList)
                        : info.gender === 'male'
                          ? 'Charon'
                          : 'Kore';

                  const sortedEdgeList =
                    info.gender === 'male' || info.gender === 'female'
                      ? [...edgeList].sort((a, b) => {
                          const aMatch = a.gender === info.gender ? 0 : 1;
                          const bMatch = b.gender === info.gender ? 0 : 1;
                          return aMatch - bMatch;
                        })
                      : edgeList;
                  const sortedGeminiVoices =
                    info.gender === 'male' || info.gender === 'female'
                      ? [...geminiVoices].sort((a, b) => {
                          const aMatch = a.gender === info.gender ? 0 : 1;
                          const bMatch = b.gender === info.gender ? 0 : 1;
                          return aMatch - bMatch;
                        })
                      : geminiVoices;

                  return (
                    <tr key={speakerId} className="hover:bg-slate-800/30">
                      <td className="py-2 px-3 font-mono font-semibold text-slate-100">
                        {speakerId}
                      </td>
                      <td className="py-2 px-3">
                        <select
                          value={info.gender}
                          onChange={(e) => void onGenderChange(speakerId, e.target.value as Gender)}
                          className="px-2 py-1 bg-[#1E293B] border border-slate-700 rounded text-slate-100 text-xs"
                        >
                          <option value="female">{t.workbench.genderFemale}</option>
                          <option value="male">{t.workbench.genderMale}</option>
                          <option value="unknown">{t.workbench.genderUnknown}</option>
                        </select>
                      </td>
                      <td className="py-2 px-3">
                        <div className="inline-flex items-center gap-2">
                          <select
                            disabled={savingVoiceSpk === speakerId}
                            value={currentVoice}
                            onChange={(e) => void handleAssignVoice(speakerId, e.target.value)}
                            className="px-2 py-1 bg-[#1E293B] border border-slate-700 rounded text-slate-100 text-xs max-w-[260px]"
                          >
                            {activeEngine === 'edge' ? (
                              <>
                                {!sortedEdgeList.some((v) => v.name === currentVoice) && (
                                  <option value={currentVoice}>{currentVoice}</option>
                                )}
                                {sortedEdgeList.map((v) => (
                                  <option key={v.name} value={v.name}>
                                    {v.name} ({v.locale} · {v.gender})
                                  </option>
                                ))}
                              </>
                            ) : sortedGeminiVoices.length > 0 ? (
                              <>
                                {!sortedGeminiVoices.some((v) => v.name === currentVoice) && (
                                  <option value={currentVoice}>{currentVoice}</option>
                                )}
                                {sortedGeminiVoices.map((v) => (
                                  <option key={v.name} value={v.name}>
                                    {v.name} ({v.gender} · {v.style})
                                  </option>
                                ))}
                              </>
                            ) : (
                              <option value={currentVoice}>{currentVoice}</option>
                            )}
                          </select>
                          {savingVoiceSpk === speakerId && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          type="button"
                          disabled={previewingSpk === speakerId}
                          onClick={() => void handlePreviewVoice(speakerId, currentVoice)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#1E293B] border border-slate-700 rounded text-slate-200 hover:border-blue-500 cursor-pointer disabled:opacity-50"
                        >
                          {previewingSpk === speakerId ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Volume2 className="w-3 h-3 text-blue-400" />
                          )}
                          {previewingSpk === speakerId
                            ? t.dubbing.previewingVoiceBtn
                            : t.dubbing.previewVoiceBtn}
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

      {/* Output Video Preview + Downloads + Step H QA Validation */}
      {(activeReport || project.dub_combined_mp4) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 border border-slate-800 bg-[#0F172A] rounded-lg p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                <Film className="w-4 h-4 text-blue-400" />
                <span>{t.dubbing.outputTitle}</span>
              </div>

              {project.target_langs.length > 1 && (
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-slate-400 mr-1">{t.dubbing.previewLangLabel}</span>
                  {project.target_langs.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setActiveLang(l)}
                      className={`px-2 py-0.5 rounded border cursor-pointer ${
                        activeLang === l
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-[#1E293B] border-slate-700 text-slate-300'
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {activeReport?.mp4_file && (
              <div className="bg-black rounded border border-slate-800 overflow-hidden">
                <video
                  key={`${activeLang}-${activeReport.generated_at}`}
                  controls
                  src={`/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(activeLang)}/mp4?t=${encodeURIComponent(activeReport.generated_at)}`}
                  className="w-full max-h-[320px] object-contain"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {activeReport?.mp4_file && (
                <a
                  href={`/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(activeLang)}/mp4?download=1`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-500"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.dubbing.downloadMp4} ({activeLang})
                </a>
              )}
              {activeReport?.wav_file && (
                <a
                  href={`/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(activeLang)}/wav?download=1`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1E293B] border border-slate-700 text-slate-200 rounded hover:border-slate-500"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.dubbing.downloadWav} ({activeLang})
                </a>
              )}
              {activeReport?.srt_file && (
                <a
                  href={`/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(activeLang)}/srt?download=1`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1E293B] border border-slate-700 text-slate-200 rounded hover:border-slate-500"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.dubbing.downloadSrt} ({activeLang})
                </a>
              )}
              {project.dub_combined_mp4 && (
                <a
                  href={`/api/projects/${encodeURIComponent(project.id)}/media/dub/dual/mp4?download=1`}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-700 text-white rounded hover:bg-emerald-600"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.dubbing.downloadDualMp4}
                </a>
              )}
            </div>
          </div>

          {/* Step H: QA Validation Card */}
          <div className="lg:col-span-5 border border-slate-800 bg-[#0F172A] rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>
                {t.dubbing.qaTitle} ({activeLang})
              </span>
            </div>

            {activeReport && (
              <div className="space-y-3 text-xs">
                <div className="border border-slate-800 bg-[#1E293B] rounded p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">{t.dubbing.qaAvSyncLabel}</span>
                    <span
                      className={`px-2 py-0.5 rounded font-mono text-[11px] border ${
                        activeReport.passed_40ms
                          ? 'bg-emerald-950/70 border-emerald-700 text-emerald-300'
                          : 'bg-red-950/70 border-red-700 text-red-300'
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

                <div className="border border-slate-800 bg-[#1E293B] rounded p-3 space-y-2">
                  <div className="text-slate-400">{t.dubbing.qaStatusSummaryLabel}</div>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                    <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-300">
                      ok: {activeReport.ok_count}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-blue-950/60 border border-blue-800 text-blue-300">
                      compressed: {activeReport.compressed_count}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800 text-cyan-300">
                      retranslated: {activeReport.retranslated_count}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-amber-950/60 border border-amber-800 text-amber-300">
                      needs_review: {activeReport.needs_review_count}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-red-950/60 border border-red-800 text-red-300">
                      overflow: {activeReport.overflow_count}
                    </span>
                  </div>
                </div>

                <div className="border border-slate-800 bg-[#1E293B] rounded p-3 space-y-1.5">
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
            )}
          </div>
        </div>
      )}

      {/* Manual AI Chat Bridge (No API Key Required) */}
      {bridgeEnabled && (
        <div className="border border-blue-500/40 bg-[#0F172A] rounded-lg p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <MessageSquareText className="w-4 h-4 text-blue-400 shrink-0" />
              <span>No-API-Key AI Chat Bridge · Dubbing ({activeLang})</span>
              {dubBridgePrompts && (
                <span className="text-[11px] font-mono font-normal px-2 py-0.5 rounded bg-[#1E293B] border border-slate-700 text-slate-300">
                  {dubBridgePrompts.totalCues} / {dubBridgePrompts.totalAvailableCues} cues
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {dubBridgePrompts &&
                dubBridgePrompts.totalCues < dubBridgePrompts.totalAvailableCues && (
                  <button
                    type="button"
                    disabled={isDubRunning}
                    onClick={() => void saveSelection({ ...selection, mode: 'all' })}
                    className="px-2.5 py-1 text-[11px] font-medium bg-blue-600/20 border border-blue-500/40 text-blue-200 rounded hover:bg-blue-600/30 cursor-pointer"
                  >
                    Switch to All ({dubBridgePrompts.totalAvailableCues} cues)
                  </button>
                )}
              <button
                type="button"
                disabled={dubBridgeLoading || !stage2Done}
                onClick={() => void fetchDubBridgePrompts()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#1E293B] border border-slate-700 text-slate-300 rounded hover:border-blue-500 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${dubBridgeLoading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          <div className="border border-amber-700/60 bg-amber-950/40 rounded px-3.5 py-2 text-xs text-amber-200">
            {dubBridgePrompts?.reminder || MANUAL_AI_BATCH_REMINDER}
          </div>

          {dubBridgeLoadErr && (
            <div className="border border-red-800 bg-red-950/60 rounded px-3 py-2 text-xs text-red-200">
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
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-blue-600 border-blue-400 text-white'
                          : partDone
                            ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300'
                            : 'bg-[#1E293B] border-slate-700 text-slate-300 hover:border-slate-500'
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
              <div className="border border-slate-800 bg-[#1E293B]/60 rounded-md p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100">
                    1 · Copy Prompt &amp; JSON ({activeDubBatch.cueCount} cues · IDs {activeDubBatch.startId}–{activeDubBatch.endId})
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href="https://gemini.google.com/app"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-[#0F172A] border border-slate-700 text-sky-300 rounded hover:border-sky-400 transition-colors"
                    >
                      <span>Gemini Web ↗</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                      href="https://chatgpt.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-[#0F172A] border border-slate-700 text-emerald-300 rounded hover:border-emerald-400 transition-colors"
                    >
                      <span>ChatGPT ↗</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <button
                      type="button"
                      onClick={() => void handleCopyDubPrompt()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors cursor-pointer"
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
                  className="w-full px-3 py-2 text-[11px] font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-300 focus:outline-none"
                />
              </div>

              {/* Step 2: Paste AI JSON Reply */}
              <div className="border border-slate-800 bg-[#1E293B]/60 rounded-md p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100">
                    2 · Paste AI JSON Reply
                  </span>
                  <button
                    type="button"
                    onClick={() => void handlePasteDubReply()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0F172A] border border-slate-700 text-slate-200 rounded hover:border-blue-500 transition-colors cursor-pointer"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5 text-blue-400" />
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
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
                />
                {activeDubValidation && (
                  <div
                    className={`text-[11px] px-3 py-1.5 rounded border ${
                      activeDubValidation.ok
                        ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300'
                        : 'bg-red-950/60 border-red-700 text-red-300'
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
                  disabled={!activeDubValidation?.ok || dubBridgeImporting || isDubRunning}
                  onClick={() => void handleImportDubJson()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-50"
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

      {/* Glossary (if terms extracted) */}
      {glossaryEntries.length > 0 && (
        <div className="border border-slate-800 bg-[#0F172A] rounded-lg p-3.5 space-y-2">
          <div className="text-xs font-semibold text-slate-300">
            {t.dubbing.glossaryTitle} ({activeLang})
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            {glossaryEntries.map(([src, tgt]) => (
              <span
                key={src}
                className="px-2 py-0.5 rounded bg-[#1E293B] border border-slate-700 text-slate-200"
              >
                <span className="text-slate-400">{src}</span> → <span>{tgt}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Step G: Dubbing Lines Table (source, translation editable, slot_ms, tts_ms, rate, status, regenerate) */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-100">{t.dubbing.cuesTableTitle}</h3>
          {project.target_langs.length > 1 && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400">{t.dubbing.langFilterLabel}</span>
              {project.target_langs.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setActiveLang(l)}
                  className={`px-2.5 py-1 rounded border cursor-pointer ${
                    activeLang === l
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-[#0F172A] border-slate-700 text-slate-300'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>

        {langCues.length === 0 ? (
          <div className="border border-slate-800 bg-[#0F172A] rounded-md p-6 text-center text-xs text-slate-400">
            {t.dubbing.emptyCuesHint}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto border border-slate-800 rounded-md">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-[#0F172A] border-b border-slate-800 text-[11px] font-medium text-slate-400 z-10">
                <tr>
                  <th className="py-2.5 px-3 w-12">{t.dubbing.colLineId}</th>
                  <th className="py-2.5 px-3 w-48">{t.dubbing.colSourceText}</th>
                  <th className="py-2.5 px-3">{t.dubbing.colTranslationEdit}</th>
                  <th className="py-2.5 px-3 w-36">{t.dubbing.colSlotTts}</th>
                  <th className="py-2.5 px-3 w-20">{t.dubbing.colRate}</th>
                  <th className="py-2.5 px-3 w-28">{t.dubbing.colStatus}</th>
                  <th className="py-2.5 px-3 w-36 text-right">{t.dubbing.colAction}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-xs bg-[#0F172A]/50">
                {langCues.map((seg) => {
                  const key = `${seg.lang}:${seg.id}`;
                  const draftText = lineDrafts[key] ?? seg.tgt_text;
                  const isRegen = regeneratingKey === key;
                  const isRetrans = retranslatingKey === key;
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
                    <tr key={key} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-2.5 px-3 align-top font-mono text-slate-400 tabular-nums space-y-0.5">
                        <div>#{seg.id}</div>
                        <div className="text-[10px] text-slate-500">{seg.speaker}</div>
                        {(seg.model_used || seg.tts_model_used) && (
                          <div className="text-[10px] text-blue-300/80 break-all">
                            {seg.model_used || seg.tts_model_used}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 align-top space-y-1">
                        <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                          {formatTimecode(seg.start_ms)} – {formatTimecode(seg.end_ms)}
                        </div>
                        <div className="text-slate-300 leading-relaxed">{seg.src_text}</div>
                      </td>
                      <td className="py-2.5 px-3 align-top space-y-1.5">
                        <textarea
                          rows={2}
                          value={draftText}
                          onChange={(e) =>
                            setLineDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          className="w-full min-w-[240px] px-2.5 py-1.5 text-xs bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
                        />
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums text-slate-400">
                          <span>
                            {t.dubbing.lengthVsSlotLabel}: {draftSyl} syl · est ~{estMs}ms /{' '}
                            {seg.slot_ms}ms
                          </span>
                        </div>
                        {(!completenessCheck.valid || seg.review_reason || seg.error) && (
                          <div className="border border-amber-700/80 bg-amber-950/40 rounded px-2 py-1 text-[11px] text-amber-200 whitespace-pre-wrap break-words">
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
                        {clipBasename && (
                          <audio
                            controls
                            preload="none"
                            src={`/api/projects/${encodeURIComponent(project.id)}/media/dubclip/${encodeURIComponent(clipBasename)}?v=${seg.tts_ms}`}
                            className="h-7 w-64"
                          />
                        )}
                      </td>
                      <td className="py-2.5 px-3 align-top font-mono tabular-nums text-slate-300">
                        <div>{seg.slot_ms} ms</div>
                        <div
                          className={
                            seg.tts_ms > 0
                              ? seg.tts_ms <= seg.slot_ms
                                ? 'text-emerald-400'
                                : 'text-amber-300'
                              : 'text-slate-500'
                          }
                        >
                          {seg.tts_ms > 0 ? `${seg.tts_ms} ms` : '—'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 align-top font-mono tabular-nums text-slate-300 space-y-1">
                        <div>{seg.rate.toFixed(2)}x</div>
                        {seg.video_rate !== undefined && seg.video_rate < 0.999 && (
                          <div className="text-[10px] text-amber-300">
                            {t.dubbing.videoRateLabel}: {seg.video_rate.toFixed(2)}x
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 align-top">
                        <span
                          className={`inline-block px-2 py-0.5 rounded border text-[11px] font-mono ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 align-top text-right">
                        <div className="flex flex-col items-end gap-1.5">
                          <button
                            type="button"
                            disabled={isRegen || isRetrans || isDubRunning || !draftText.trim()}
                            onClick={() => void handleRegenerateLine(seg)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-[#1E293B] border border-slate-600 rounded text-slate-100 hover:border-blue-500 cursor-pointer whitespace-nowrap disabled:opacity-50"
                          >
                            {isRegen ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3 h-3 text-blue-400" />
                            )}
                            {isRegen ? t.dubbing.regeneratingBtn : t.dubbing.regenerateBtn}
                          </button>
                          {!bridgeEnabled && (
                            <button
                              type="button"
                              disabled={isRegen || isRetrans || isDubRunning}
                              onClick={() => void handleRetranslateCompleteLine(seg)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-[#0F172A] border border-slate-700 rounded text-blue-300 hover:border-blue-500 cursor-pointer whitespace-nowrap disabled:opacity-50"
                            >
                              {isRetrans ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Sparkles className="w-3 h-3 text-blue-400" />
                              )}
                              {isRetrans
                                ? t.dubbing.retranslatingCompleteBtn
                                : t.dubbing.retranslateCompleteBtn}
                            </button>
                          )}
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
    </div>
  );
};
