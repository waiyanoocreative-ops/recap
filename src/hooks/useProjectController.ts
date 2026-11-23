import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CapabilitiesResponse,
  DubSegment,
  DubSelection,
  EdgeVoiceInfo,
  GeminiVoiceInfo,
  Gender,
  Project,
  ProjectEventPayload,
  ProjectMode,
  ResilientQueueStatus,
  SpeechSegment,
  TargetLang,
  TtsEngineType,
  VoicesCatalogResponse,
} from '../../shared/projectTypes';
import { mergeSentenceUnits, type SentenceUnitCue } from '../../shared/dubUtils';
import { isLongVideoDuration } from '../../shared/chunkPlanner';
import { useI18n } from '../i18n/I18nContext';
import { apiFetchJson, sanitizeUiErrorText } from '../utils/apiClient';
import { uploadFileInChunks } from '../utils/chunkUploader';

export interface SegmentDraft {
  start_ms: number;
  end_ms: number;
  speaker: string;
  src_lang: string;
  text: string;
}

export const FALLBACK_EDGE_VOICES: EdgeVoiceInfo[] = [
  {
    name: 'my-MM-NilarNeural',
    friendlyName: 'Microsoft Nilar Online (Natural) - Burmese',
    gender: 'female',
    locale: 'my-MM',
  },
  {
    name: 'my-MM-ThihaNeural',
    friendlyName: 'Microsoft Thiha Online (Natural) - Burmese',
    gender: 'male',
    locale: 'my-MM',
  },
  {
    name: 'en-US-JennyNeural',
    friendlyName: 'Microsoft Jenny Online (Natural) - English (US)',
    gender: 'female',
    locale: 'en-US',
  },
  {
    name: 'en-US-AriaNeural',
    friendlyName: 'Microsoft Aria Online (Natural) - English (US)',
    gender: 'female',
    locale: 'en-US',
  },
  {
    name: 'en-US-GuyNeural',
    friendlyName: 'Microsoft Guy Online (Natural) - English (US)',
    gender: 'male',
    locale: 'en-US',
  },
  {
    name: 'en-US-AndrewMultilingualNeural',
    friendlyName: 'Microsoft AndrewMultilingual Online (Natural) - English (US)',
    gender: 'male',
    locale: 'en-US',
  },
];

export function defaultEdgeVoiceFor(
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

export function useProjectController(params: {
  project: Project | null;
  capabilities: CapabilitiesResponse | null;
  onProjectChange: (project: Project) => void;
  onConfigSaved: () => Promise<void> | void;
}) {
  const { project, capabilities, onProjectChange, onConfigSaved } = params;
  const { t, localizeError } = useI18n();
  const uploadAbortRef = useRef<AbortController | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedChunks: number;
    totalChunks: number;
    pct: number;
    bytesUploaded: number;
    totalBytes: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const MAX_SSE_LOGS = 200;
  const blobUrlsRef = useRef<Set<string>>(new Set());

  const [analyzing, setAnalyzing] = useState(false);
  const [liveLog, setLiveLog] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [dubEtaSec, setDubEtaSec] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resilientStatus, setResilientStatus] = useState<ResilientQueueStatus | null>(null);

  // S1 inline editor state
  const [segmentDrafts, setSegmentDrafts] = useState<Record<number, SegmentDraft>>({});
  const [savingSegId, setSavingSegId] = useState<number | null>(null);
  const [savedSegId, setSavedSegId] = useState<number | null>(null);
  const [savingSpeakerId, setSavingSpeakerId] = useState<string | null>(null);
  const [savedSpeakerId, setSavedSpeakerId] = useState<string | null>(null);
  const [startingChunkRun, setStartingChunkRun] = useState(false);

  // Voices & Dubbing Studio state
  const [selection, setSelection] = useState<DubSelection>(
    project?.dub_selection ?? { mode: 'first_n', count: 8, start_idx: 1, end_idx: 8 },
  );
  const [activeLang, setActiveLang] = useState<TargetLang>(project?.target_langs[0] ?? 'my-MM');
  const [translating, setTranslating] = useState(false);
  const [renderingReq, setRenderingReq] = useState(false);

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

  const projectId = project?.id ?? null;

  const revokeManagedBlobUrl = useCallback((url: string | null | undefined) => {
    if (url && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
      blobUrlsRef.current.delete(url);
    }
  }, []);

  const appendLiveLog = useCallback((msg: string) => {
    setLiveLog(msg);
    setLiveLogs((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_SSE_LOGS ? next.slice(-MAX_SSE_LOGS) : next;
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      blobUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setUploadError(null);
    setActionError(null);
    setUploadProgress(null);
    setLiveLog(null);
    setLiveLogs([]);
    setDubEtaSec(null);
    setVoicePreviewAudio((prev) => {
      revokeManagedBlobUrl(prev?.src);
      return null;
    });
  }, [projectId, revokeManagedBlobUrl]);

  useEffect(() => {
    if (!project) {
      setSegmentDrafts({});
      return;
    }
    setSegmentDrafts((prev) => {
      const next: Record<number, SegmentDraft> = {};
      for (const seg of project.speech) {
        next[seg.id] = {
          start_ms: prev[seg.id]?.start_ms ?? seg.start_ms,
          end_ms: prev[seg.id]?.end_ms ?? seg.end_ms,
          speaker: prev[seg.id]?.speaker ?? seg.speaker,
          src_lang: prev[seg.id]?.src_lang ?? seg.src_lang,
          text: prev[seg.id]?.text ?? seg.text,
        };
      }
      return next;
    });
  }, [project?.id, project?.speech]);

  useEffect(() => {
    if (!project) return;
    setSelection(project.dub_selection);
  }, [project?.id, project?.dub_selection]);

  useEffect(() => {
    if (!project) return;
    if (!project.target_langs.includes(activeLang)) {
      setActiveLang(project.target_langs[0] ?? 'my-MM');
    }
  }, [project?.target_langs, activeLang]);

  useEffect(() => {
    if (!project) {
      setLineDrafts({});
      return;
    }
    setLineDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const seg of project.dub) {
        const k = `${seg.lang}:${seg.id}`;
        next[k] = prev[k] !== undefined ? prev[k] : seg.tgt_text;
      }
      return next;
    });
  }, [project?.id, project?.dub]);

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
    if (!projectId) return;
    let disposed = false;

    const handleEventPayload = (payload: ProjectEventPayload) => {
      if (payload.type === 'heartbeat') return;
      if (payload.resilient) {
        setResilientStatus(payload.resilient);
      }
      if (payload.message) appendLiveLog(payload.message);
      if (typeof payload.eta_sec === 'number') {
        setDubEtaSec(payload.eta_sec);
      }
      if (payload.type === 'error') {
        if (payload.message) setActionError(localizeError(payload.message));
        setAnalyzing(false);
        setStartingChunkRun(false);
        setRenderingReq(false);
      }
      if (payload.project) {
        onProjectChange(payload.project);
        const stage2Stages = [
          payload.project.stages.ingest,
          payload.project.stages.speech,
          payload.project.stages.speakers,
          payload.project.stages.maps,
        ];
        const anyRunning = stage2Stages.some((s) => s.status === 'running');
        const allDone = stage2Stages.every((s) => s.status === 'done');
        if (!anyRunning && (allDone || payload.type === 'error')) {
          setAnalyzing(false);
        }
        if (payload.project.stages.dub?.status !== 'running') {
          setDubEtaSec(null);
        }
      }
    };

    const es = new EventSource(`/api/events/${encodeURIComponent(projectId)}`);
    es.onmessage = (evt) => {
      try {
        handleEventPayload(JSON.parse(evt.data) as ProjectEventPayload);
      } catch {
        // ignore parse errors
      }
    };

    let ws: WebSocket | null = null;
    try {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/events/${encodeURIComponent(projectId)}`;
      ws = new WebSocket(wsUrl);
      ws.onmessage = (evt) => {
        if (disposed || typeof evt.data !== 'string') return;
        try {
          handleEventPayload(JSON.parse(evt.data) as ProjectEventPayload);
        } catch {
          // ignore parse errors
        }
      };
      ws.onerror = () => {
        // SSE remains active as fallback
      };
    } catch {
      ws = null;
    }

    return () => {
      disposed = true;
      es.close();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [projectId, onProjectChange, localizeError, appendLiveLog]);

  const activeEngine: TtsEngineType =
    capabilities?.config.TTS_ENGINE ?? (edgeUnavailable ? 'gemini' : 'edge');
  const configuredTtsModel = capabilities?.config.TTS_MODEL ?? '';
  const chunkSizeBytes = capabilities?.config.CHUNK_SIZE_BYTES ?? 8388608;

  const isLongVideo = project
    ? isLongVideoDuration(project.video.duration_ms) || project.chunks.length > 0
    : false;
  const anyChunkJobRunning = project
    ? startingChunkRun ||
      Boolean(project.chunk_progress?.active) ||
      project.stages.dub.status === 'running'
    : false;

  const anyStageRunning = project
    ? analyzing ||
      [
        project.stages.ingest,
        project.stages.speech,
        project.stages.speakers,
        project.stages.maps,
      ].some((s) => s.status === 'running')
    : false;

  const allAnalyzeDone = project
    ? [
        project.stages.ingest,
        project.stages.speech,
        project.stages.speakers,
        project.stages.maps,
      ].every((s) => s.status === 'done')
    : false;

  const isDubRunning = project ? renderingReq || project.stages.dub.status === 'running' : false;

  const startChunkUpload = async (file: File) => {
    if (!project) return;
    setUploadError(null);
    setActionError(null);
    setUploading(true);
    const controller = new AbortController();
    uploadAbortRef.current = controller;

    try {
      const updated = await uploadFileInChunks({
        project,
        file,
        chunkSizeBytes,
        callbacks: {
          signal: controller.signal,
          onProgress: (info) => setUploadProgress(info),
        },
      });
      onProjectChange(updated);
      appendLiveLog(t.workbench.doneBtn);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setUploadError(t.errors.uploadInterrupted);
      } else {
        setUploadError(localizeError(err instanceof Error ? err.message : null));
      }
    } finally {
      setUploading(false);
      uploadAbortRef.current = null;
    }
  };

  const handlePauseUpload = () => {
    uploadAbortRef.current?.abort();
  };

  const handleRunAnalysis = async (force = false) => {
    if (!project) return;
    setActionError(null);
    setAnalyzing(true);
    setSegmentDrafts({});
    try {
      const res = await apiFetchJson<{ error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      appendLiveLog(t.workbench.processingIngest);
    } catch (err) {
      setAnalyzing(false);
      setActionError(localizeError(err instanceof Error ? err.message : null));
    }
  };

  const handleRunChunkedPipeline = async (force = false) => {
    if (!project) return;
    setActionError(null);
    setStartingChunkRun(true);
    try {
      const res = await apiFetchJson<{ error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/chunks/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      appendLiveLog(project.chunk_progress?.message || t.workbench.chunksRunningBtn);
    } catch (err) {
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setStartingChunkRun(false);
    }
  };

  const handleUpdateProjectSettings = async (patch: {
    mode?: ProjectMode;
    target_langs?: TargetLang[];
    recap_mute_original?: boolean;
  }) => {
    if (!project) return;
    setActionError(null);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok || !res.data.project) throw new Error(res.data.error || t.errors.genericFailed);
      onProjectChange(res.data.project);
    } catch (err) {
      setActionError(localizeError(err instanceof Error ? err.message : null));
    }
  };

  const saveConfigPatch = async (patch: Record<string, unknown>) => {
    setActionError(null);
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
      setActionError(localizeError(sanitizeUiErrorText(err)));
    } finally {
      setSavingSettings(false);
    }
  };

  const updateSegmentDraft = (seg: SpeechSegment, patch: Partial<SegmentDraft>) => {
    setSegmentDrafts((prev) => {
      const base = prev[seg.id] ?? {
        start_ms: seg.start_ms,
        end_ms: seg.end_ms,
        speaker: seg.speaker,
        src_lang: seg.src_lang,
        text: seg.text,
      };
      return {
        ...prev,
        [seg.id]: { ...base, ...patch },
      };
    });
  };

  const isSegmentDirty = (seg: SpeechSegment): boolean => {
    const draft = segmentDrafts[seg.id];
    if (!draft) return false;
    return (
      draft.start_ms !== seg.start_ms ||
      draft.end_ms !== seg.end_ms ||
      draft.speaker !== seg.speaker ||
      draft.src_lang !== seg.src_lang ||
      draft.text !== seg.text
    );
  };

  const handleSaveSegment = async (seg: SpeechSegment) => {
    if (!project) return;
    const draft = segmentDrafts[seg.id] ?? {
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      speaker: seg.speaker,
      src_lang: seg.src_lang,
      text: seg.text,
    };
    setActionError(null);
    setSavingSegId(seg.id);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/segments/${seg.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
      setSavedSegId(seg.id);
      setTimeout(() => setSavedSegId((cur) => (cur === seg.id ? null : cur)), 2000);
    } catch (err) {
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setSavingSegId(null);
    }
  };

  const handleSpeakerGenderChange = async (speakerId: string, gender: Gender) => {
    if (!project) return;
    setActionError(null);
    setSavingSpeakerId(speakerId);
    try {
      const res = await apiFetchJson<{ project?: Project; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/speakers/${encodeURIComponent(speakerId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gender }),
        },
      );
      if (!res.ok || !res.data.project) {
        throw new Error(res.data.error || t.errors.genericFailed);
      }
      onProjectChange(res.data.project);
      setSavedSpeakerId(speakerId);
      setTimeout(() => setSavedSpeakerId((cur) => (cur === speakerId ? null : cur)), 2000);
    } catch (err) {
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setSavingSpeakerId(null);
    }
  };

  const handleAssignVoice = async (speakerId: string, voiceName: string) => {
    if (!project) return;
    setActionError(null);
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
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setSavingVoiceSpk(null);
    }
  };

  const handlePreviewVoice = async (speakerId: string, voiceName: string) => {
    setActionError(null);
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
      const mimeType = res.data.mimeType || fallbackMime;
      const binary = atob(res.data.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      blobUrlsRef.current.add(blobUrl);
      setVoicePreviewAudio((prev) => {
        revokeManagedBlobUrl(prev?.src);
        return { speaker: speakerId, voice: voiceName, src: blobUrl };
      });
    } catch (err) {
      if (activeEngine === 'edge') {
        setEdgeUnavailable(true);
        void saveConfigPatch({ TTS_ENGINE: 'gemini' });
      }
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setPreviewingSpk(null);
    }
  };

  const saveSelection = async (next: DubSelection) => {
    setSelection(next);
    if (!project) return;
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
    if (!project) return;
    setActionError(null);
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
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setTranslating(false);
    }
  };

  const handleRenderDub = async () => {
    if (!project) return;
    setActionError(null);
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
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRenderingReq(false);
    }
  };

  const handleRegenerateLine = async (seg: DubSegment) => {
    if (!project) return;
    const key = `${seg.lang}:${seg.id}`;
    const draftText = lineDrafts[key] ?? seg.tgt_text;
    setActionError(null);
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
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRegeneratingKey(null);
    }
  };

  const handleRetranslateCompleteLine = async (seg: DubSegment) => {
    if (!project) return;
    const key = `${seg.lang}:${seg.id}`;
    setActionError(null);
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
      setActionError(localizeError(err instanceof Error ? err.message : null));
    } finally {
      setRetranslatingKey(null);
    }
  };

  const mergedCues = useMemo(
    () => (project ? mergeSentenceUnits(project.speech) : []),
    [project?.speech],
  );

  const selectedPreview = useMemo(() => {
    if (!project || mergedCues.length === 0) {
      return {
        selectedCount: 0,
        totalCount: 0,
        isFullVideo: true,
        startMs: 0,
        endMs: project?.video.duration_ms || 0,
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
  }, [mergedCues, selection, project]);

  return {
    // status & logs
    uploading,
    uploadProgress,
    uploadError,
    analyzing,
    liveLog,
    liveLogs,
    dubEtaSec,
    actionError,
    setActionError,
    resilientStatus,
    anyStageRunning,
    allAnalyzeDone,
    isLongVideo,
    anyChunkJobRunning,
    isDubRunning,
    translating,
    renderingReq,
    savingSettings,
    chunkSizeBytes,
    // drafts & edits
    segmentDrafts,
    setSegmentDrafts,
    savingSegId,
    savedSegId,
    savingSpeakerId,
    savedSpeakerId,
    updateSegmentDraft,
    isSegmentDirty,
    handleSaveSegment,
    handleSpeakerGenderChange,
    // voices & dub
    activeEngine,
    edgeVoices,
    edgeUnavailable,
    setEdgeUnavailable,
    geminiVoices,
    savingVoiceSpk,
    previewingSpk,
    voicePreviewAudio,
    activeLang,
    setActiveLang,
    selection,
    saveSelection,
    mergedCues,
    selectedPreview,
    lineDrafts,
    setLineDrafts,
    regeneratingKey,
    retranslatingKey,
    // actions
    startChunkUpload,
    handlePauseUpload,
    handleRunAnalysis,
    handleRunChunkedPipeline,
    handleUpdateProjectSettings,
    saveConfigPatch,
    handleAssignVoice,
    handlePreviewVoice,
    handleTranslate,
    handleRenderDub,
    handleRegenerateLine,
    handleRetranslateCompleteLine,
  };
}

export type ProjectController = ReturnType<typeof useProjectController>;
