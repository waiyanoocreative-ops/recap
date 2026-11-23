import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileAudio,
  Film,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Upload,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  CapabilitiesResponse,
  Gender,
  Project,
  ProjectEventPayload,
  ProjectMode,
  SpeechSegment,
  TargetLang,
} from '../../shared/projectTypes';
import { formatChunkClock, isLongVideoDuration } from '../../shared/chunkPlanner';
import { formatMsg, useI18n } from '../i18n/I18nContext';
import { apiFetchJson } from '../utils/apiClient';
import { uploadFileInChunks } from '../utils/chunkUploader';
import { formatBytes, formatSavedTimestamp, formatTimecode } from '../utils/format';
import { DubbingStudioPanel } from './DubbingStudioPanel';

const TWO_HUNDRED_MB = 200 * 1024 * 1024;
const MAX_SSE_LOGS = 200;
const SAMPLED_TIMELINE_BUCKETS = 120;

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

interface TimelineWorkbenchProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  browserSavedAt?: string | null;
  onProjectChange: (project: Project) => void;
  onConfigSaved: () => Promise<void> | void;
}

interface SegmentDraft {
  start_ms: number;
  end_ms: number;
  speaker: string;
  src_lang: string;
  text: string;
}

export const TimelineWorkbench: React.FC<TimelineWorkbenchProps> = ({
  project,
  capabilities,
  browserSavedAt,
  onProjectChange,
  onConfigSaved,
}) => {
  const { t, localizeError } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());

  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedChunks: number;
    totalChunks: number;
    pct: number;
    bytesUploaded: number;
    totalBytes: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [liveLog, setLiveLog] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [dubEtaSec, setDubEtaSec] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shellTab, setShellTab] = useState<'transcript' | 'speakers' | 'maps' | 'dub' | 'json'>('transcript');
  const [copiedJson, setCopiedJson] = useState(false);

  // Stage 2 inline editor state
  const [segmentDrafts, setSegmentDrafts] = useState<Record<number, SegmentDraft>>({});
  const [savingSegId, setSavingSegId] = useState<number | null>(null);
  const [savedSegId, setSavedSegId] = useState<number | null>(null);
  const [savingSpeakerId, setSavingSpeakerId] = useState<string | null>(null);
  const [savedSpeakerId, setSavedSpeakerId] = useState<string | null>(null);
  const [includeSourceInZip, setIncludeSourceInZip] = useState<boolean>(
    () => (project.video.size_bytes || 0) <= TWO_HUNDRED_MB,
  );
  const [startingChunkRun, setStartingChunkRun] = useState(false);

  const recapMuted = project.mode === 'recap' && (project.recap_mute_original ?? true);
  const isLongVideo =
    isLongVideoDuration(project.video.duration_ms) || project.chunks.length > 0;
  const anyChunkJobRunning =
    startingChunkRun ||
    Boolean(project.chunk_progress?.active) ||
    project.stages.dub.status === 'running';

  useEffect(() => {
    setIncludeSourceInZip((project.video.size_bytes || 0) <= TWO_HUNDRED_MB);
  }, [project.id, project.video.size_bytes]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = recapMuted;
    }
  }, [recapMuted, project.id, project.mode]);

  useEffect(() => {
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
  }, [project.id, project.speech]);

  useEffect(() => {
    setLiveLog(null);
    setLiveLogs([]);
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
  }, [project.id]);

  useEffect(() => {
    const es = new EventSource(`/api/events/${encodeURIComponent(project.id)}`);
    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data) as ProjectEventPayload;
        if (payload.type === 'heartbeat') return;
        if (payload.message) {
          const msg = payload.message;
          setLiveLog(msg);
          setLiveLogs((prev) => {
            const next = [...prev, msg];
            return next.length > MAX_SSE_LOGS ? next.slice(-MAX_SSE_LOGS) : next;
          });
        }
        if (typeof payload.eta_sec === 'number') {
          setDubEtaSec(payload.eta_sec);
        }
        if (payload.type === 'error') {
          if (payload.message) setActionError(localizeError(payload.message));
          setAnalyzing(false);
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
      } catch {
        // ignore parse errors
      }
    };
    return () => {
      es.close();
    };
  }, [project.id, onProjectChange, localizeError]);

  const chunkSizeBytes = capabilities?.config.CHUNK_SIZE_BYTES ?? 8388608;
  const stage2List = [
    project.stages.ingest,
    project.stages.speech,
    project.stages.speakers,
    project.stages.maps,
  ];
  const anyStageRunning = analyzing || stage2List.some((s) => s.status === 'running');
  const allStagesDone = stage2List.every((s) => s.status === 'done');

  const startChunkUpload = async (file: File) => {
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
      setLiveLog(t.workbench.doneBtn);
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
      setLiveLog(t.workbench.processingIngest);
    } catch (err) {
      setAnalyzing(false);
      setActionError(localizeError(err instanceof Error ? err.message : null));
    }
  };

  const handleRunChunkedPipeline = async (force = false) => {
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
      setLiveLog(project.chunk_progress?.message || t.workbench.chunksRunningBtn);
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

  const langChoiceValue: 'my-MM' | 'en-US' | 'both' =
    project.target_langs.length === 2
      ? 'both'
      : project.target_langs[0] === 'en-US'
        ? 'en-US'
        : 'my-MM';

  const durationMs = Math.max(1, project.video.duration_ms || 1);
  const videoStreamUrl =
    project.mode === 'recap' && project.video.proxy_480p_file
      ? `/api/projects/${encodeURIComponent(project.id)}/media/proxy`
      : `/api/projects/${encodeURIComponent(project.id)}/media/source`;

  // Explicitly release browser video/audio decoder buffers on unmount or source switch
  useEffect(() => {
    const root = rootRef.current;
    const vid = videoRef.current;
    return () => {
      releaseMediaElement(vid);
      if (root) {
        root.querySelectorAll('video, audio').forEach((node) => {
          releaseMediaElement(node as HTMLMediaElement);
        });
      }
    };
  }, [project.id, videoStreamUrl]);

  // Lightweight sampled timeline activity blocks from metadata (skips full-movie Float32Array PCM decode)
  const timelineBlocks = useMemo(() => {
    const buckets = Array.from({ length: SAMPLED_TIMELINE_BUCKETS }, (_, idx) => {
      const startMs = Math.round((idx / SAMPLED_TIMELINE_BUCKETS) * durationMs);
      const endMs = Math.round(((idx + 1) / SAMPLED_TIMELINE_BUCKETS) * durationMs);
      return { idx, startMs, endMs, speechRatio: 0, isSilent: false, hasCut: false };
    });
    const bucketSpan = Math.max(1, durationMs / SAMPLED_TIMELINE_BUCKETS);

    for (const seg of project.speech) {
      const iStart = Math.max(0, Math.floor(seg.start_ms / bucketSpan));
      const iEnd = Math.min(SAMPLED_TIMELINE_BUCKETS - 1, Math.floor(seg.end_ms / bucketSpan));
      for (let i = iStart; i <= iEnd; i += 1) {
        const b = buckets[i];
        const overlap = Math.max(0, Math.min(b.endMs, seg.end_ms) - Math.max(b.startMs, seg.start_ms));
        b.speechRatio = Math.min(1, b.speechRatio + overlap / Math.max(1, b.endMs - b.startMs));
      }
    }

    for (const [sMs, eMs] of project.silence_ms) {
      const iStart = Math.max(0, Math.floor(sMs / bucketSpan));
      const iEnd = Math.min(SAMPLED_TIMELINE_BUCKETS - 1, Math.floor(eMs / bucketSpan));
      for (let i = iStart; i <= iEnd; i += 1) {
        if (buckets[i].speechRatio < 0.1) buckets[i].isSilent = true;
      }
    }

    for (const cutMs of project.scene_cuts_ms) {
      const idx = Math.max(0, Math.min(SAMPLED_TIMELINE_BUCKETS - 1, Math.floor(cutMs / bucketSpan)));
      buckets[idx].hasCut = true;
    }
    return buckets;
  }, [project.speech, project.silence_ms, project.scene_cuts_ms, durationMs]);

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

  const speakerEntries = useMemo(
    () => Object.entries(project.speakers),
    [project.speakers],
  );

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
    { key: 'dub', title: t.workbench.dubStageCardTitle, state: project.stages.dub },
  ];

  return (
    <div ref={rootRef} className="p-6 max-w-[1440px] mx-auto space-y-5">
      {/* Project Header & Mode / Target Language Selector */}
      <div className="border border-slate-800 bg-[#1E293B] rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-100">{project.title}</h1>
            <span className="text-xs font-mono text-slate-400">{project.id}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>{project.video.filename || t.workbench.noVideo}</span>
            {project.video.duration_ms > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatTimecode(project.video.duration_ms)}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {project.video.width}x{project.video.height} @ {project.video.fps} fps (
                  {project.video.is_vfr ? 'VFR' : 'CFR'})
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {t.workbench.vStartLabel} {project.video.v_start_ms}ms / {t.workbench.aStartLabel}{' '}
                  {project.video.a_start_ms}ms ({t.workbench.offsetLabel}{' '}
                  {project.video.stream_offset_ms >= 0 ? '+' : ''}
                  {project.video.stream_offset_ms}ms)
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#0F172A] border border-slate-800 rounded-md">
            <button
              type="button"
              onClick={() => handleUpdateProjectSettings({ mode: 'dubbing' })}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                project.mode === 'dubbing'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.workbench.modeDubbing}
            </button>
            <button
              type="button"
              onClick={() => handleUpdateProjectSettings({ mode: 'recap' })}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                project.mode === 'recap'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.workbench.modeRecap}
            </button>
          </div>

          {project.mode === 'dubbing' ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border bg-slate-900 border-slate-700 text-emerald-300 whitespace-nowrap shrink-0">
              <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
              {t.dubbing.duckingNotice}
            </span>
          ) : (
            <button
              type="button"
              onClick={() =>
                handleUpdateProjectSettings({
                  recap_mute_original: !(project.recap_mute_original ?? true),
                })
              }
              className={`inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                recapMuted
                  ? 'bg-amber-950/60 border-amber-700 text-amber-200 hover:bg-amber-900/60'
                  : 'bg-emerald-950/60 border-emerald-700 text-emerald-200 hover:bg-emerald-900/60'
              }`}
              title={t.workbench.recapAudioToggleBtn}
            >
              {recapMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              <span>{recapMuted ? t.workbench.recapAudioMuted : t.workbench.recapAudioOn}</span>
            </button>
          )}

          <div className="flex items-center gap-1 p-1 bg-[#0F172A] border border-slate-800 rounded-md">
            {(['my-MM', 'en-US', 'both'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() =>
                  handleUpdateProjectSettings({
                    target_langs: choice === 'both' ? ['my-MM', 'en-US'] : [choice],
                  })
                }
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  langChoiceValue === choice
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {choice === 'both'
                  ? t.workbench.langBoth
                  : choice === 'my-MM'
                    ? t.workbench.langMy
                    : t.workbench.langEn}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Persistence, Saved Status, Last Saved Time & Save ZIP */}
      {(() => {
        const doneStagesStr =
          [
            project.stages.ingest.status === 'done' ? 'S0' : null,
            project.stages.speech.status === 'done' ? 'S1' : null,
            project.stages.speakers.status === 'done' ? 'S2' : null,
            project.stages.maps.status === 'done' ? 'S3' : null,
            project.stages.dub.status === 'done' ? 'Dub' : null,
          ]
            .filter(Boolean)
            .join('·') || '—';
        const ttsReadyCount = project.dub.filter((d) => d.tts_ms > 0).length;
        const isOver200Mb = (project.video.size_bytes || 0) > TWO_HUNDRED_MB;
        const mediaStatus = !project.upload.completed
          ? t.persistence.mediaPending
          : project.video.proxy_480p_file
            ? isOver200Mb && !includeSourceInZip
              ? t.persistence.mediaProxyOnly
              : t.persistence.mediaOriginalAndProxy
            : t.persistence.mediaOriginalAndProxy;
        const zipHref = `/api/projects/${encodeURIComponent(project.id)}/backup.zip?includeSource=${
          includeSourceInZip ? '1' : '0'
        }`;

        return (
          <div className="border border-slate-800 bg-[#1E293B] rounded-lg px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
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
                  speechCount: String(project.speech.length),
                  speakerCount: String(speakerEntries.length),
                  dubCount: String(project.dub.length),
                  ttsCount: String(ttsReadyCount),
                  mediaStatus,
                })}
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-400">
                <span>
                  {t.persistence.lastSavedLabel} ({t.persistence.serverSavedLabel}):{' '}
                  <span className="text-slate-200">
                    {formatSavedTimestamp(
                      project.last_saved_at || project.updated_at,
                      t.persistence.notSavedYet,
                    )}
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
              {project.upload.completed && project.video.size_bytes > 0 && (
                <label
                  className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none"
                  title={isOver200Mb ? t.persistence.includeSourceOverLimitHint : undefined}
                >
                  <input
                    type="checkbox"
                    checked={includeSourceInZip}
                    onChange={(e) => setIncludeSourceInZip(e.target.checked)}
                    className="rounded border-slate-600 bg-[#0F172A] text-blue-500"
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
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-emerald-700 text-white rounded-md hover:bg-emerald-600 transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                {t.persistence.saveProjectBtn}
              </a>
            </div>
          </div>
        );
      })()}

      {actionError && (
        <div className="border border-red-800 bg-red-950/60 rounded-lg px-4 py-3 flex items-start gap-3 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <pre className="font-mono whitespace-pre-wrap break-all">{actionError}</pre>
        </div>
      )}

      {/* S0 Chunked Upload Screen + Guide Panel */}
      {!project.upload.completed && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-7 border border-slate-800 bg-[#1E293B] rounded-lg p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  {t.workbench.uploadCardTitle}
                </h2>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  {formatMsg(t.workbench.uploadCardDesc, {
                    chunkSize: formatBytes(chunkSizeBytes),
                  })}
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void startChunkUpload(file);
                }}
              />
              <div className="flex items-center gap-2">
                {uploading ? (
                  <button
                    type="button"
                    onClick={handlePauseUpload}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-amber-600 text-white rounded-md hover:bg-amber-500 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    {t.workbench.pauseUploadBtn}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!capabilities?.ffmpeg.ok}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-500 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {project.upload.received_chunks.length > 0
                      ? formatMsg(t.workbench.resumeVideoBtn, {
                          filename: project.video.filename,
                        })
                      : t.workbench.selectVideoBtn}
                  </button>
                )}
              </div>
            </div>

            {project.upload.received_chunks.length > 0 && !uploading && (
              <div className="text-xs font-mono text-amber-300">
                {t.workbench.partialSavedPrefix}: {project.upload.received_chunks.length}/
                {project.upload.total_chunks} {t.workbench.chunksUnit} ({project.video.filename}).{' '}
                {t.workbench.reselectHint}
              </div>
            )}

            {uploadProgress && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono tabular-nums text-slate-300">
                  <span>
                    {t.workbench.chunkLabel} {uploadProgress.uploadedChunks}/
                    {uploadProgress.totalChunks} ({formatBytes(uploadProgress.bytesUploaded)} /{' '}
                    {formatBytes(uploadProgress.totalBytes)})
                  </span>
                  <span>{uploadProgress.pct}%</span>
                </div>
                <div className="w-full h-2.5 bg-[#0F172A] rounded overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-150"
                    style={{ width: `${uploadProgress.pct}%` }}
                  />
                </div>
              </div>
            )}

            {uploadError && (
              <div className="border border-red-800 bg-red-950/60 rounded-md px-3.5 py-2.5 flex items-start gap-2 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <pre className="whitespace-pre-wrap break-words font-sans">{uploadError}</pre>
              </div>
            )}
          </div>

          <div className="lg:col-span-5 border border-slate-800 bg-[#1E293B] rounded-lg p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <BookOpen className="w-4 h-4 text-blue-400 shrink-0" />
              <span>{t.workbench.guideTitle}</span>
            </div>
            <div className="space-y-2.5 text-xs text-slate-200 leading-relaxed">
              {t.workbench.guideSteps.map((step, idx) => (
                <p key={idx}>{step}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Stage 1 & 2 Progress Card */}
      {project.upload.completed && (
        <div className="border border-slate-800 bg-[#1E293B] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">{t.workbench.stage1Header}</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {liveLog ||
                  project.stages.speakers.message ||
                  project.stages.speech.message ||
                  project.stages.maps.message ||
                  project.stages.ingest.message ||
                  formatMsg(t.workbench.stage1DefaultLog, { id: project.id })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={anyStageRunning || !capabilities?.ffmpeg.ok}
                onClick={() => handleRunAnalysis(false)}
                className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                  allStagesDone
                    ? 'bg-emerald-700 text-white hover:bg-emerald-600'
                    : 'bg-blue-600 text-white hover:bg-blue-500'
                }`}
              >
                {anyStageRunning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t.workbench.processingIngest}
                  </>
                ) : allStagesDone ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {t.workbench.doneBtn}
                  </>
                ) : (
                  t.workbench.verifyIngestBtn
                )}
              </button>
              <button
                type="button"
                disabled={anyStageRunning || !capabilities?.ffmpeg.ok}
                onClick={() => handleRunAnalysis(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0F172A] border border-slate-700 text-slate-300 rounded-md hover:border-slate-500 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t.workbench.rerunBtn}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {stageCards.map(({ key, title, state }) => {
              const done = state.status === 'done';
              const running = state.status === 'running';
              const errored = state.status === 'error';
              return (
                <div key={key} className="border border-slate-800 bg-[#0F172A] rounded-md p-3">
                  <div className="flex items-center justify-between text-xs gap-2">
                    <span className="font-medium text-slate-200 truncate">{title}</span>
                    <span
                      className={`font-medium shrink-0 ${
                        done
                          ? 'text-emerald-400'
                          : running
                            ? 'text-blue-400'
                            : errored
                              ? 'text-red-400'
                              : 'text-slate-400'
                      }`}
                    >
                      {getStageStatusText(state.status)}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 bg-slate-800 rounded overflow-hidden">
                    <div
                      className={`h-full transition-all duration-200 ${
                        errored
                          ? 'bg-red-500'
                          : done
                            ? 'bg-emerald-500'
                            : 'bg-blue-500'
                      }`}
                      style={{ width: `${state.progress_pct}%` }}
                    />
                  </div>
                  <div
                    className={`mt-1.5 text-[11px] ${
                      errored ? 'text-red-300 whitespace-pre-wrap break-words' : 'text-slate-400 truncate'
                    }`}
                    title={state.error || state.message}
                  >
                    {state.error
                      ? localizeError(state.error)
                      : done
                        ? state.message || t.workbench.statusDone
                        : state.message || t.workbench.statusPending}
                  </div>
                  {state.model_used && (
                    <div
                      className="mt-1 text-[10px] font-mono text-blue-300 truncate"
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
      )}

      {/* Long Video Smart Chunking Progress & Resume Card (> 10 minutes) */}
      {project.upload.completed && isLongVideo && (
        <div className="border border-slate-800 bg-[#1E293B] rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Scissors className="w-4 h-4 text-blue-400 shrink-0" />
                <h2 className="text-sm font-semibold text-slate-100">{t.workbench.chunksTitle}</h2>
                {project.chunks.length > 0 && (
                  <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-[#0F172A] border border-slate-700 text-slate-300 tabular-nums">
                    {project.chunks.filter((c) => c.status === 'done').length} / {project.chunks.length}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">{t.workbench.chunksSubtitle}</p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={anyStageRunning || anyChunkJobRunning || !capabilities?.ffmpeg.ok}
                onClick={() => void handleRunChunkedPipeline(false)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-500 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {anyChunkJobRunning ? (
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
            </div>
          </div>

          {project.chunk_progress?.message && (
            <div
              className={`border rounded-md px-3.5 py-2 text-xs font-medium ${
                project.chunk_progress.phase === 'error'
                  ? 'border-red-800 bg-red-950/50 text-red-200'
                  : project.chunk_progress.active
                    ? 'border-blue-800 bg-blue-950/40 text-blue-200'
                    : 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
              }`}
            >
              {project.chunk_progress.message}
            </div>
          )}

          {project.chunks.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {project.chunks.map((c) => (
                <div
                  key={c.index}
                  className={`border rounded-md p-2 text-[11px] font-mono ${
                    c.status === 'done'
                      ? 'border-emerald-800/80 bg-emerald-950/30 text-emerald-200'
                      : c.status === 'running'
                        ? 'border-blue-600 bg-blue-950/40 text-blue-200'
                        : c.status === 'error'
                          ? 'border-red-800 bg-red-950/40 text-red-200'
                          : 'border-slate-800 bg-[#0F172A] text-slate-300'
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
          )}
        </div>
      )}

      {/* No Dialogue Banner (<5% speech coverage or no audio) */}
      {project.upload.completed && project.no_dialogue && project.stages.speech.status === 'done' && (
        <div className="border border-amber-700 bg-amber-950/50 rounded-lg px-4 py-3 flex items-center gap-3 text-xs text-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>{formatMsg(t.workbench.noDialogueBanner, { pct: speechCoveragePct })}</span>
        </div>
      )}

      {/* Video & Extracted WAVs Preview */}
      {project.upload.completed && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 border border-slate-800 bg-[#1E293B] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Film className="w-4 h-4 text-blue-400" />
                {project.mode === 'recap' && project.video.proxy_480p_file
                  ? t.workbench.previewProxyTitle
                  : t.workbench.previewSourceTitle}
              </div>
              <div className="font-mono tabular-nums text-xs text-slate-300">
                {formatTimecode(currentTimeMs)} / {formatTimecode(durationMs)}
              </div>
            </div>

            <div className="bg-black rounded-md overflow-hidden border border-slate-800 flex items-center justify-center min-h-[260px]">
              <video
                ref={videoRef}
                src={videoStreamUrl}
                preload="metadata"
                muted={recapMuted}
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

            {/* Lightweight Sampled Timeline Blocks (Zero Raw PCM Decoding) */}
            {durationMs > 1 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>
                    {isLongVideo
                      ? 'Sampled timeline blocks (>10m long video · raw PCM decode skipped)'
                      : 'Sampled timeline blocks'}
                  </span>
                  {liveLogs.length > 0 && (
                    <span className="truncate max-w-[260px]" title={liveLogs[liveLogs.length - 1]}>
                      {liveLogs.length}/{MAX_SSE_LOGS} logs
                    </span>
                  )}
                </div>
                <div className="relative h-7 bg-[#0F172A] border border-slate-800 rounded flex items-end gap-[1px] p-1 overflow-hidden">
                  {timelineBlocks.map((b) => {
                    const active = currentTimeMs >= b.startMs && currentTimeMs <= b.endMs;
                    const heightPct = b.speechRatio > 0 ? Math.max(25, Math.round(b.speechRatio * 100)) : b.isSilent ? 12 : 20;
                    return (
                      <button
                        key={b.idx}
                        type="button"
                        onClick={() => seekToMs(b.startMs)}
                        title={`${formatTimecode(b.startMs)} – ${formatTimecode(b.endMs)}`}
                        className={`flex-1 rounded-[1px] transition-colors cursor-pointer ${
                          active
                            ? 'bg-amber-400'
                            : b.speechRatio > 0
                              ? 'bg-blue-500/80 hover:bg-blue-400'
                              : b.hasCut
                                ? 'bg-violet-500/70 hover:bg-violet-400'
                                : 'bg-slate-700/60 hover:bg-slate-600'
                        }`}
                        style={{ height: `${heightPct}%` }}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => seekToMs(currentTimeMs - 5000)}
                  className="p-2 bg-[#0F172A] border border-slate-700 rounded text-slate-300 hover:text-white cursor-pointer"
                  title={t.workbench.back5s}
                >
                  <SkipBack className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={togglePlay}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-500 cursor-pointer whitespace-nowrap"
                >
                  {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  {isPlaying ? t.workbench.pause : t.workbench.play}
                </button>
                <button
                  type="button"
                  onClick={() => seekToMs(currentTimeMs + 5000)}
                  className="p-2 bg-[#0F172A] border border-slate-700 rounded text-slate-300 hover:text-white cursor-pointer"
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

          <div className="lg:col-span-5 border border-slate-800 bg-[#1E293B] rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <FileAudio className="w-4 h-4 text-blue-400" />
              {t.workbench.extractedAudioTitle}
            </div>

            {project.video.has_audio ? (
              <div className="space-y-3">
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-3 space-y-1.5">
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

                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-3 space-y-1.5">
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
              <div className="border border-slate-800 bg-[#0F172A] rounded-md p-4 text-xs text-amber-300">
                {t.workbench.noAudioNotice}
              </div>
            )}

            <div className="border border-slate-800 bg-[#0F172A] rounded-md p-3.5 text-xs font-mono tabular-nums space-y-1.5 text-slate-300">
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

      {/* Stage 2 Analyze Tabs: Transcript, Speakers, Silence & Scene Cuts, Live JSON */}
      {project.upload.completed && (
        <div className="border border-slate-800 bg-[#1E293B] rounded-lg overflow-hidden">
          <div className="px-5 pt-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-6 text-xs font-medium">
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
                  [
                    'dub',
                    formatMsg(t.workbench.tabDubbing, { count: String(project.dub.length) }),
                  ],
                  ['json', t.workbench.tabJson],
                ] as const
              ).map(([tabId, label]) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => setShellTab(tabId)}
                  className={`pb-3 border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                    shellTab === tabId
                      ? 'border-blue-500 text-white'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {shellTab === 'json' && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify(project, null, 2));
                  setCopiedJson(true);
                  setTimeout(() => setCopiedJson(false), 1500);
                }}
                className="inline-flex items-center gap-1 mb-2 px-2.5 py-1 text-[11px] bg-[#0F172A] border border-slate-700 rounded text-slate-300 hover:text-white cursor-pointer"
              >
                <Copy className="w-3 h-3" />
                {copiedJson ? t.workbench.copiedJson : t.workbench.copyJson}
              </button>
            )}
          </div>

          {shellTab === 'transcript' && (
            <div className="p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">
                    {t.workbench.shellTranscriptTitle}
                  </h3>
                  {project.stages.speech.model_used && (
                    <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-[#0F172A] border border-slate-700 text-blue-300">
                      {t.workbench.modelUsedPrefix}: {project.stages.speech.model_used}
                    </span>
                  )}
                </div>
                <span className="text-xs font-mono text-slate-400 tabular-nums">
                  {t.workbench.speechCoverageLabel}: {speechCoveragePct}%
                </span>
              </div>

              {project.speech.length === 0 ? (
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-6 text-center text-xs text-slate-400">
                  {t.workbench.emptyTranscript}
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[520px] overflow-y-auto border border-slate-800 rounded-md">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-[#0F172A] border-b border-slate-800 text-[11px] font-medium text-slate-400">
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
                    <tbody className="divide-y divide-slate-800 text-xs bg-[#0F172A]/50">
                      {project.speech.map((seg) => {
                        const draft = segmentDrafts[seg.id] ?? {
                          start_ms: seg.start_ms,
                          end_ms: seg.end_ms,
                          speaker: seg.speaker,
                          src_lang: seg.src_lang,
                          text: seg.text,
                        };
                        const dirty = isSegmentDirty(seg);
                        const isActiveNow =
                          currentTimeMs >= seg.start_ms && currentTimeMs <= seg.end_ms;
                        const isSaving = savingSegId === seg.id;
                        const isSaved = savedSegId === seg.id;

                        return (
                          <tr
                            key={seg.id}
                            className={`transition-colors ${
                              isActiveNow
                                ? 'bg-blue-950/40 border-l-2 border-l-blue-500'
                                : 'hover:bg-slate-800/30'
                            }`}
                          >
                            <td className="py-2 px-3 font-mono tabular-nums text-slate-400 align-top">
                              {seg.id}
                            </td>
                            <td className="py-2 px-3 align-top space-y-1">
                              <button
                                type="button"
                                title={t.workbench.seekBtnTitle}
                                onClick={() => seekToMs(draft.start_ms)}
                                className="font-mono tabular-nums text-blue-400 hover:text-blue-300 cursor-pointer block"
                              >
                                {formatTimecode(draft.start_ms)} – {formatTimecode(draft.end_ms)}
                              </button>
                              <div className="flex items-center gap-1 font-mono text-[11px]">
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.start_ms}
                                  onChange={(e) =>
                                    updateSegmentDraft(seg, {
                                      start_ms: Math.max(0, Number(e.target.value) || 0),
                                    })
                                  }
                                  className="w-20 px-1.5 py-0.5 bg-[#0F172A] border border-slate-700 rounded text-slate-200 tabular-nums"
                                />
                                <span className="text-slate-500">–</span>
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.end_ms}
                                  onChange={(e) =>
                                    updateSegmentDraft(seg, {
                                      end_ms: Math.max(0, Number(e.target.value) || 0),
                                    })
                                  }
                                  className="w-20 px-1.5 py-0.5 bg-[#0F172A] border border-slate-700 rounded text-slate-200 tabular-nums"
                                />
                              </div>
                            </td>
                            <td className="py-2 px-3 font-mono tabular-nums text-slate-300 align-top">
                              {((Math.max(0, draft.end_ms - draft.start_ms)) / 1000).toFixed(2)}s
                            </td>
                            <td className="py-2 px-3 align-top">
                              <input
                                type="text"
                                value={draft.speaker}
                                onChange={(e) =>
                                  updateSegmentDraft(seg, { speaker: e.target.value })
                                }
                                className="w-20 px-2 py-1 text-xs font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-100"
                              />
                            </td>
                            <td className="py-2 px-3 align-top">
                              <input
                                type="text"
                                value={draft.src_lang}
                                onChange={(e) =>
                                  updateSegmentDraft(seg, { src_lang: e.target.value })
                                }
                                className="w-16 px-2 py-1 text-xs font-mono bg-[#0F172A] border border-slate-700 rounded text-slate-100"
                              />
                            </td>
                            <td className="py-2 px-3 align-top">
                              <textarea
                                rows={2}
                                value={draft.text}
                                onChange={(e) => updateSegmentDraft(seg, { text: e.target.value })}
                                className="w-full min-w-[260px] px-2.5 py-1.5 text-xs bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
                              />
                            </td>
                            <td className="py-2 px-3 text-right align-top">
                              <button
                                type="button"
                                disabled={isSaving || !dirty}
                                onClick={() => void handleSaveSegment(seg)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded border transition-colors whitespace-nowrap ${
                                  isSaved && !dirty
                                    ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300'
                                    : dirty
                                      ? 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500 cursor-pointer'
                                      : 'bg-[#0F172A] border-slate-800 text-slate-500 cursor-not-allowed'
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

          {shellTab === 'speakers' && (
            <div className="p-5 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Users className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-semibold text-slate-100">
                  {t.workbench.shellSpeakersTitle}
                </h3>
                {project.stages.speakers.model_used && (
                  <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-[#0F172A] border border-slate-700 text-blue-300">
                    {t.workbench.modelUsedPrefix}: {project.stages.speakers.model_used}
                  </span>
                )}
              </div>

              {speakerEntries.length === 0 ? (
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-6 text-center text-xs text-slate-400">
                  {t.workbench.emptySpeakers}
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-800 rounded-md">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-[#0F172A] border-b border-slate-800 text-[11px] font-medium text-slate-400">
                      <tr>
                        <th className="py-2.5 px-4">{t.workbench.colSpeakerId}</th>
                        <th className="py-2.5 px-4">{t.workbench.colMergedFrom}</th>
                        <th className="py-2.5 px-4">{t.workbench.colUtterances}</th>
                        <th className="py-2.5 px-4">{t.workbench.colSampleAudio}</th>
                        <th className="py-2.5 px-4">{t.workbench.colGenderSelect}</th>
                        <th className="py-2.5 px-4 text-right">{t.workbench.colConfidence}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-xs bg-[#0F172A]/50">
                      {speakerEntries.map(([speakerId, info]) => {
                        const stats = speakerStats[speakerId] ?? { count: 0, totalMs: 0 };
                        const isSaving = savingSpeakerId === speakerId;
                        const isSaved = savedSpeakerId === speakerId;
                        return (
                          <tr key={speakerId} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-3 px-4 font-mono font-semibold text-slate-100">
                              {speakerId}
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
                                    void handleSpeakerGenderChange(
                                      speakerId,
                                      e.target.value as Gender,
                                    )
                                  }
                                  className="px-2.5 py-1.5 text-xs bg-[#0F172A] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
                                >
                                  <option value="female">{t.workbench.genderFemale}</option>
                                  <option value="male">{t.workbench.genderMale}</option>
                                  <option value="unknown">{t.workbench.genderUnknown}</option>
                                </select>
                                {isSaving && (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
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

          {shellTab === 'maps' && (
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-3">
                  <div className="text-[11px] text-slate-400">
                    {t.workbench.speechCoverageLabel}
                  </div>
                  <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                    {speechCoveragePct}%
                  </div>
                </div>
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-3">
                  <div className="text-[11px] text-slate-400">
                    {t.workbench.silenceCountLabel}
                  </div>
                  <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                    {project.silence_ms.length}
                  </div>
                </div>
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-3">
                  <div className="text-[11px] text-slate-400">{t.workbench.sceneCountLabel}</div>
                  <div className="text-base font-mono font-semibold text-slate-100 tabular-nums mt-0.5">
                    {project.scene_cuts_ms.length}
                  </div>
                </div>
              </div>

              {project.silence_ms.length === 0 && project.scene_cuts_ms.length === 0 ? (
                <div className="border border-slate-800 bg-[#0F172A] rounded-md p-6 text-center text-xs text-slate-400">
                  {t.workbench.emptyMaps}
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="border border-slate-800 bg-[#0F172A] rounded-md p-4 space-y-2.5">
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
                          onClick={() => seekToMs(startMs)}
                          className="px-2 py-1 text-[11px] font-mono tabular-nums bg-[#1E293B] border border-slate-700 rounded text-slate-300 hover:border-blue-500 hover:text-white cursor-pointer"
                        >
                          {formatTimecode(startMs)}–{formatTimecode(endMs)} (
                          {((endMs - startMs) / 1000).toFixed(1)}s)
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="border border-slate-800 bg-[#0F172A] rounded-md p-4 space-y-2.5">
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
                          onClick={() => seekToMs(cutMs)}
                          className="px-2 py-1 text-[11px] font-mono tabular-nums bg-[#1E293B] border border-slate-700 rounded text-slate-300 hover:border-blue-500 hover:text-white cursor-pointer"
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

          {shellTab === 'dub' && (
            <DubbingStudioPanel
              project={project}
              capabilities={capabilities}
              dubEtaSec={dubEtaSec}
              onProjectChange={onProjectChange}
              onGenderChange={handleSpeakerGenderChange}
              onConfigSaved={onConfigSaved}
            />
          )}

          {shellTab === 'json' && (
            <pre className="p-5 max-h-[380px] overflow-auto text-xs font-mono text-slate-300 bg-[#0F172A]">
              {JSON.stringify(project, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
