import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import type {
  CapabilitiesResponse,
  ResilientQueueStatus,
  SpeechStyle,
  TargetLang,
  TtsEngineType,
  VoicePoolsConfig,
  VoicesCatalogResponse,
} from '../../shared/projectTypes';
import {
  filterTextModels,
  filterTranscribeModels,
  filterTtsModels,
} from '../../shared/modelFilters';
import { formatMsg, useI18n } from '../i18n/I18nContext';
import { apiFetchJson, sanitizeUiErrorText } from '../utils/apiClient';

interface SettingsVoicesPanelProps {
  capabilities: CapabilitiesResponse | null;
  onConfigSaved: () => Promise<void> | void;
  section?: 'all' | 'models' | 'voices';
  compactMode?: boolean;
  resilientStatus?: ResilientQueueStatus | null;
}

interface VoiceRowDiagnostic {
  status: 'ok' | 'error';
  engine: TtsEngineType;
  voice: string;
  durationSec?: number;
  bytes?: number;
  blobUrl?: string;
  ext?: string;
  errorText?: string;
}

interface TtsSelfTestResult {
  ok: boolean;
  bytes: number;
  ms: number;
  error: string | null;
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

export const SettingsVoicesPanel: React.FC<SettingsVoicesPanelProps> = ({
  capabilities,
  onConfigSaved,
  section = 'all',
  compactMode = false,
  resilientStatus = null,
}) => {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlsRef = useRef<string[]>([]);

  const [textModel, setTextModel] = useState(capabilities?.config.TEXT_MODEL ?? '');
  const [transcribeModel, setTranscribeModel] = useState(
    capabilities?.config.TRANSCRIBE_MODEL ?? '',
  );
  const [ttsModel, setTtsModel] = useState(capabilities?.config.TTS_MODEL ?? '');
  const [ttsFallbackModels, setTtsFallbackModels] = useState<string[]>(
    capabilities?.config.TTS_FALLBACK_MODELS ?? [],
  );
  const [speechStyle, setSpeechStyle] = useState<SpeechStyle>(
    capabilities?.config.SPEECH_STYLE ?? 'polite',
  );
  const [ttsEngine, setTtsEngine] = useState<TtsEngineType>(
    capabilities?.config.TTS_ENGINE ?? 'edge',
  );
  const [voicePools, setVoicePools] = useState<VoicePoolsConfig>(
    capabilities?.config.VOICE_POOLS ?? {
      edge: {
        'my-MM': { female: [], male: [] },
        'en-US': { female: [], male: [] },
      },
      gemini: {
        'my-MM': { female: [], male: [] },
        'en-US': { female: [], male: [] },
      },
    },
  );

  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [voicesCatalog, setVoicesCatalog] = useState<VoicesCatalogResponse | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(true);

  const [localeFilter, setLocaleFilter] = useState<'all' | 'my-MM' | 'en-*'>('all');
  const [genderFilter, setGenderFilter] = useState<'all' | 'female' | 'male'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [geminiSampleLang, setGeminiSampleLang] = useState<TargetLang>('my-MM');

  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [playingVoice, setPlayingVoice] = useState<{
    voice: string;
    lang: TargetLang;
    src: string;
    ext: string;
    text: string;
  } | null>(null);
  const [rowDiagnostics, setRowDiagnostics] = useState<Record<string, VoiceRowDiagnostic>>({});
  const [ttsError, setTtsError] = useState<string | null>(null);

  const [selfTesting, setSelfTesting] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<TtsSelfTestResult | null>(null);
  const [edgeUnavailable, setEdgeUnavailable] = useState(false);

  const markEdgeUnavailable = useCallback(async () => {
    setEdgeUnavailable(true);
    setTtsEngine('gemini');
    setSaveNotice(null);
    if (capabilities?.config.TTS_ENGINE === 'edge') {
      try {
        const res = await apiFetchJson<{ error?: string }>('/api/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ TTS_ENGINE: 'gemini' }),
        });
        if (res.ok) {
          await onConfigSaved();
        }
      } catch {
        // non-fatal background config switch
      }
    }
  }, [capabilities?.config.TTS_ENGINE, onConfigSaved]);

  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => {
      for (const u of urls) {
        URL.revokeObjectURL(u);
      }
    };
  }, []);

  useEffect(() => {
    if (!capabilities) return;
    setTextModel(capabilities.config.TEXT_MODEL);
    setTranscribeModel(capabilities.config.TRANSCRIBE_MODEL);
    setTtsModel(capabilities.config.TTS_MODEL);
    setTtsFallbackModels(capabilities.config.TTS_FALLBACK_MODELS ?? []);
    setSpeechStyle(capabilities.config.SPEECH_STYLE ?? 'polite');
    setTtsEngine(capabilities.config.TTS_ENGINE);
    setVoicePools(capabilities.config.VOICE_POOLS);
  }, [capabilities]);

  const loadVoices = useCallback(async (forceRefresh = false) => {
    setVoicesLoading(true);
    try {
      const res = await apiFetchJson<VoicesCatalogResponse & { error?: string }>(
        `/api/voices${forceRefresh ? '?refresh=1' : ''}`,
      );
      if (res.ok) {
        setVoicesCatalog(res.data);
        if (res.data.edge.error) {
          void markEdgeUnavailable();
        }
      } else {
        setTtsError(
          sanitizeUiErrorText(`HTTP ${res.status}: ${res.data?.error || res.statusText}`),
        );
        void markEdgeUnavailable();
      }
    } catch (err) {
      setTtsError(sanitizeUiErrorText(err));
      void markEdgeUnavailable();
    } finally {
      setVoicesLoading(false);
    }
  }, [markEdgeUnavailable]);

  useEffect(() => {
    void loadVoices(false);
  }, [loadVoices]);

  const handleSaveConfig = async () => {
    setSaving(true);
    setSaveNotice(null);
    setSaveError(null);
    try {
      const res = await apiFetchJson<{ error?: string }>('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          TEXT_MODEL: textModel,
          TRANSCRIBE_MODEL: transcribeModel,
          TTS_MODEL: ttsModel,
          TTS_FALLBACK_MODELS: ttsFallbackModels,
          SPEECH_STYLE: speechStyle,
          TTS_ENGINE: ttsEngine,
          VOICE_POOLS: voicePools,
        }),
      });
      if (!res.ok) {
        throw new Error(res.data?.error || t.errors.genericFailed);
      }
      await onConfigSaved();
      setSaveNotice(t.settings.savedNotice);
      setTimeout(() => setSaveNotice(null), 3000);
    } catch (err) {
      setSaveError(sanitizeUiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleVoiceInPool = (
    engine: TtsEngineType,
    lang: TargetLang,
    gender: 'female' | 'male',
    voiceName: string,
  ) => {
    setSaveNotice(null);
    setVoicePools((prev) => {
      const currentList = prev[engine][lang][gender];
      const exists = currentList.includes(voiceName);
      const nextList = exists
        ? currentList.filter((v) => v !== voiceName)
        : [...currentList, voiceName];
      return {
        ...prev,
        [engine]: {
          ...prev[engine],
          [lang]: {
            ...prev[engine][lang],
            [gender]: nextList,
          },
        },
      };
    });
  };

  const handleRunSelfTest = async () => {
    setSelfTesting(true);
    setSelfTestResult(null);
    try {
      const res = await apiFetchJson<TtsSelfTestResult>('/api/tts/selftest');
      setSelfTestResult({
        ...res.data,
        error: res.data.error ? sanitizeUiErrorText(res.data.error) : null,
      });
      if (!res.data.ok) {
        void markEdgeUnavailable();
      }
    } catch (err) {
      setSelfTestResult({
        ok: false,
        bytes: 0,
        ms: 0,
        error: sanitizeUiErrorText(err),
      });
      void markEdgeUnavailable();
    } finally {
      setSelfTesting(false);
    }
  };

  const handlePreviewVoice = async (
    engine: TtsEngineType,
    voice: string,
    lang: TargetLang,
  ) => {
    const diagKey = `${engine}:${voice}`;
    setTtsError(null);
    setPreviewingVoice(voice);
    if (audioRef.current) {
      audioRef.current.pause();
    }

    try {
      const res = await apiFetchJson<{
        ok?: boolean;
        error?: string;
        mimeType?: string;
        audioBase64?: string;
        bytes?: number;
        duration_s?: number;
        text?: string;
      }>('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine,
          voice,
          lang,
          ...(engine === 'gemini' && ttsModel ? { model: ttsModel } : {}),
        }),
      });

      const data = res.data;
      if (!res.ok || data?.ok === false || !data?.audioBase64) {
        const exactErr = data?.error
          ? `HTTP ${res.status}: ${sanitizeUiErrorText(data.error)}`
          : `HTTP ${res.status}: ${res.statusText || 'TTS request failed'}`;
        throw new Error(exactErr);
      }

      const mime = data.mimeType || (engine === 'edge' ? 'audio/mpeg' : 'audio/wav');
      const ext = mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'wav';
      const blobUrl = base64ToBlobUrl(data.audioBase64, mime);
      blobUrlsRef.current.push(blobUrl);

      const byteLen = data.bytes ?? Math.floor((data.audioBase64.length * 3) / 4);
      const durationSec = Number((data.duration_s ?? 0).toFixed(2));

      setRowDiagnostics((prev) => ({
        ...prev,
        [diagKey]: {
          status: 'ok',
          engine,
          voice,
          durationSec,
          bytes: byteLen,
          blobUrl,
          ext,
        },
      }));

      setPlayingVoice({
        voice,
        lang,
        src: blobUrl,
        ext,
        text: data.text || '',
      });

      // Attempt playback; silently ignore autoplay block since visible <audio controls> is mounted
      requestAnimationFrame(() => {
        if (audioRef.current) {
          audioRef.current.src = blobUrl;
          void audioRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
      const exactErr = sanitizeUiErrorText(err);
      setTtsError(exactErr);
      setRowDiagnostics((prev) => ({
        ...prev,
        [diagKey]: {
          status: 'error',
          engine,
          voice,
          errorText: exactErr,
        },
      }));
      if (engine === 'edge') {
        void markEdgeUnavailable();
      }
    } finally {
      setPreviewingVoice(null);
    }
  };

  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlayingVoice(null);
  };

  const availableModels = useMemo(
    () => capabilities?.gemini.availableModels ?? [],
    [capabilities?.gemini.availableModels],
  );

  const textModelOptions = useMemo(
    () => filterTextModels(availableModels, textModel),
    [availableModels, textModel],
  );

  const transcribeModelOptions = useMemo(
    () => filterTranscribeModels(availableModels, transcribeModel),
    [availableModels, transcribeModel],
  );

  const ttsModelOptions = useMemo(
    () =>
      filterTtsModels(availableModels, ttsModel, [
        ...(capabilities?.config.TTS_FALLBACK_MODELS ?? []),
        ...ttsFallbackModels,
      ]),
    [availableModels, ttsModel, capabilities?.config.TTS_FALLBACK_MODELS, ttsFallbackModels],
  );

  const toggleTtsFallback = (modelId: string) => {
    setSaveNotice(null);
    setTtsFallbackModels((prev) =>
      prev.includes(modelId) ? prev.filter((m) => m !== modelId) : [...prev, modelId],
    );
  };

  const filteredEdgeVoices = useMemo(() => {
    const list = voicesCatalog?.edge.voices ?? [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((v) => {
      if (localeFilter === 'my-MM' && v.locale !== 'my-MM') return false;
      if (localeFilter === 'en-*' && !v.locale.startsWith('en-')) return false;
      if (genderFilter !== 'all' && v.gender !== genderFilter) return false;
      if (q) {
        const hay = `${v.name} ${v.friendlyName} ${v.locale}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [voicesCatalog, localeFilter, genderFilter, searchQuery]);

  const filteredGeminiVoices = useMemo(() => {
    const list = voicesCatalog?.gemini.voices ?? [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((v) => {
      if (genderFilter !== 'all' && v.gender !== genderFilter) return false;
      if (q) {
        const hay = `${v.name} ${v.style} ${v.gender}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [voicesCatalog, genderFilter, searchQuery]);

  const activePools = voicePools[ttsEngine];
  const apiKeyPresent = Boolean(capabilities?.gemini.configured);

  const renderRowDiagnostic = (diag: VoiceRowDiagnostic | undefined) => {
    if (!diag) return null;
    if (diag.status === 'error') {
      return (
        <tr className="bg-red-950/40">
          <td colSpan={5} className="px-4 py-2.5">
            <div className="flex items-start gap-2 text-xs text-red-200">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <pre className="font-mono whitespace-pre-wrap break-all">{diag.errorText}</pre>
            </div>
          </td>
        </tr>
      );
    }

    const sizeKb = ((diag.bytes ?? 0) / 1024).toFixed(1);
    const statusLine = formatMsg(t.settings.diagnosticOkTemplate, {
      duration: (diag.durationSec ?? 0).toFixed(2),
      sizeKb,
      engine: diag.engine,
      voice: diag.voice,
    });

    return (
      <tr className="bg-[#0B0F19]/70">
        <td colSpan={5} className="px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="inline-flex items-center gap-2 text-xs font-mono tabular-nums text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>{statusLine}</span>
            </div>

            {diag.blobUrl && (
              <div className="flex flex-wrap items-center gap-3">
                <audio
                  controls
                  preload="metadata"
                  src={diag.blobUrl}
                  onLoadedMetadata={(e) => {
                    const dur = e.currentTarget.duration;
                    if (Number.isFinite(dur) && dur > 0 && (!diag.durationSec || diag.durationSec === 0)) {
                      const key = `${diag.engine}:${diag.voice}`;
                      setRowDiagnostics((prev) => ({
                        ...prev,
                        [key]: { ...prev[key], durationSec: Number(dur.toFixed(2)) },
                      }));
                    }
                  }}
                  className="h-8 w-64"
                />
                <a
                  href={diag.blobUrl}
                  download={`${diag.voice}.${diag.ext || 'wav'}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#131A2A] border border-[rgba(148,163,184,0.14)] rounded-lg text-slate-200 hover:border-cyan-400/60 transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.settings.downloadBtn}
                </a>
              </div>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const showModelsSection = section === 'all' || section === 'models';
  const showVoicesSection = section === 'all' || section === 'voices';

  return (
    <div className={compactMode ? 'space-y-5' : 'p-8 max-w-6xl mx-auto space-y-6'}>
      {/* Page Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {!compactMode ? (
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{t.settings.title}</h1>
            <p className="text-sm text-slate-400 mt-1">{t.settings.subtitle}</p>
          </div>
        ) : (
          <div className="text-xs text-slate-400">
            {showModelsSection ? t.settings.modelsSectionDesc : t.settings.poolsDesc}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {saveNotice && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              {saveNotice}
            </span>
          )}
          {showVoicesSection && (
            <button
              type="button"
              disabled={selfTesting}
              onClick={handleRunSelfTest}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-200 rounded-xl hover:border-cyan-400/60 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {selfTesting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Activity className="w-3.5 h-3.5 text-cyan-400" />
              )}
              {selfTesting ? t.settings.selfTestingBtn : t.settings.selfTestBtn}
            </button>
          )}
          <button
            type="button"
            disabled={saving || !capabilities}
            onClick={handleSaveConfig}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-xl hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? t.settings.savingConfigBtn : t.settings.saveConfigBtn}
          </button>
        </div>
      </div>

      {/* TTS Self-Test Result */}
      {selfTestResult && (
        <div
          className={`border rounded-lg px-4 py-3 flex items-start gap-3 text-xs ${
            selfTestResult.ok
              ? 'border-emerald-800 bg-emerald-950/40 text-emerald-100'
              : 'border-red-800 bg-red-950/60 text-red-100'
          }`}
        >
          {selfTestResult.ok ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1 min-w-0">
            <div className="font-semibold">{t.settings.selfTestTitle}</div>
            <pre className="font-mono tabular-nums whitespace-pre-wrap break-all">
              {JSON.stringify(selfTestResult)}
            </pre>
          </div>
        </div>
      )}

      {saveError && (
        <div className="border border-red-800 bg-red-950/60 rounded-lg px-4 py-3 flex items-start gap-3 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <pre className="whitespace-pre-wrap break-words font-sans">{saveError}</pre>
        </div>
      )}

      {/* 1. API KeyPool & Quota Status (Read-Only) */}
      {showModelsSection && (
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <KeyRound className="w-4 h-4 text-slate-400 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold text-slate-100">{t.wizard.keyPoolTitle}</h2>
                <p className="text-xs text-slate-400 mt-0.5">{t.settings.apiKeyHiddenHint}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">{t.wizard.keyPoolLoadedKeys}:</span>
                <span className="font-mono tabular-nums text-slate-100">
                  {resilientStatus?.keys.length ?? capabilities?.gemini.keyCount ?? (apiKeyPresent ? 1 : 0)}
                </span>
              </div>
              <span
                className={`font-semibold inline-flex items-center gap-1.5 ${
                  apiKeyPresent && capabilities?.gemini.keyValid !== false
                    ? 'text-emerald-400'
                    : 'text-red-400'
                }`}
              >
                {apiKeyPresent ? (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    {t.settings.apiKeyYes}
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4" />
                    {t.settings.apiKeyNo}
                  </>
                )}
              </span>
            </div>
          </div>

          {capabilities && !apiKeyPresent && (
            <div className="border border-red-800 bg-red-950/60 rounded-lg px-3.5 py-2.5 flex items-center gap-2.5 text-xs text-red-200">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{t.errors.missingGeminiKeyAiStudio}</span>
            </div>
          )}

          {capabilities && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 text-xs font-mono tabular-nums">
              {(
                [
                  ['geminiText', t.environment.apiText],
                  ['geminiTranscribe', t.environment.apiTranscribe],
                  ['geminiTts', t.environment.apiGeminiTts],
                  ['edgeTts', t.environment.apiEdgeTts],
                ] as const
              ).map(([key, label]) => {
                const rl = capabilities.config.RATE_LIMITS[key];
                const count = capabilities.requestCounts[key];
                return (
                  <div key={key} className="border border-white/[0.08] rounded-lg p-2.5 bg-[#0B0F19]">
                    <div className="text-slate-400 font-sans text-[11px]">{label}</div>
                    <div className="text-slate-100 mt-0.5">
                      {t.environment.requestsLabel}: {count}
                    </div>
                    <div className="text-slate-500 text-[10px] mt-0.5">
                      conc {rl.concurrency} · {rl.intervalCap}/{rl.interval / 1000}s
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {resilientStatus && resilientStatus.keys.length > 0 ? (
            <div className="space-y-2 pt-2 border-t border-white/[0.08]">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono">
                <span>
                  {t.wizard.keyPoolResetLabel}: {resilientStatus.nextResetAtPt}
                </span>
                {resilientStatus.jobsSummary.waitingMessage && (
                  <span className="text-amber-300">
                    {t.wizard.keyPoolWaitingLabel}: {resilientStatus.jobsSummary.waitingMessage}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {resilientStatus.keys.map((k) => (
                  <div
                    key={k.id}
                    className="border border-white/[0.08] bg-[#0B0F19] rounded-lg px-3 py-2 flex items-center justify-between text-xs font-mono"
                  >
                    <div className="min-w-0">
                      <div className="text-slate-200 truncate">
                        {k.id} · {k.masked}
                      </div>
                      <div className="text-[10px] text-slate-400 tabular-nums">
                        req: {k.total_requests_today}
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-semibold uppercase ${
                        k.state === 'ok'
                          ? 'text-emerald-400'
                          : k.state === 'cooldown'
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }`}
                    >
                      {k.state}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-slate-400">{t.wizard.keyPoolLiveHint}</div>
          )}
        </div>
      )}

      {/* 2. Three Model Dropdowns & 3. TTS Engine Selector */}
      {showModelsSection && (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{t.settings.modelsSectionTitle}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{t.settings.modelsSectionDesc}</p>
          </div>

          {availableModels.length === 0 && (
            <div className="text-xs text-amber-300">{t.settings.modelsUnavailableNotice}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.settings.textModelLabel}
              </label>
              <select
                value={textModel}
                onChange={(e) => {
                  setTextModel(e.target.value);
                  setSaveNotice(null);
                }}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
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
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.settings.transcribeModelLabel}
              </label>
              <select
                value={transcribeModel}
                onChange={(e) => {
                  setTranscribeModel(e.target.value);
                  setSaveNotice(null);
                }}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
              >
                {transcribeModelOptions.length === 0 && <option value="">—</option>}
                {transcribeModelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.settings.ttsModelLabel}
              </label>
              <select
                value={ttsModel}
                onChange={(e) => {
                  setTtsModel(e.target.value);
                  setSaveNotice(null);
                }}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
              >
                {ttsModelOptions.length === 0 && <option value="">—</option>}
                {ttsModelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-white/[0.08]">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.settings.speechStyleLabel}
              </label>
              <select
                value={speechStyle}
                onChange={(e) => {
                  setSpeechStyle(e.target.value as SpeechStyle);
                  setSaveNotice(null);
                }}
                className="w-full px-3 py-2 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
              >
                <option value="polite">{t.settings.speechStylePolite}</option>
                <option value="casual">{t.settings.speechStyleCasual}</option>
              </select>
            </div>

            <div>
              <div className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.settings.ttsFallbacksLabel}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ttsModelOptions
                  .filter((m) => m !== ttsModel)
                  .map((m) => {
                    const active = ttsFallbackModels.includes(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => toggleTtsFallback(m)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono rounded-lg border transition-colors cursor-pointer ${
                          active
                            ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-300'
                            : 'bg-[#0B0F19] border-white/[0.08] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {active && <Check className="w-3 h-3" />}
                        {m}
                      </button>
                    );
                  })}
                {ttsModelOptions.filter((m) => m !== ttsModel).length === 0 && (
                  <span className="text-[11px] text-slate-500">—</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* TTS Engine Selector */}
        <div className="lg:col-span-4 border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{t.settings.ttsEngineTitle}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{t.settings.ttsEngineDesc}</p>
          </div>

          <div className="grid grid-cols-1 gap-2 p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
            <button
              type="button"
              disabled={edgeUnavailable}
              onClick={() => {
                if (edgeUnavailable) return;
                setTtsEngine('edge');
                setTtsError(null);
                setSaveNotice(null);
              }}
              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors text-left ${
                edgeUnavailable
                  ? 'opacity-50 cursor-not-allowed text-slate-500'
                  : ttsEngine === 'edge'
                    ? 'bg-cyan-500 text-slate-950 cursor-pointer'
                    : 'text-slate-300 hover:bg-white/[0.05] cursor-pointer'
              }`}
            >
              <div>{t.settings.engineEdge}</div>
              {edgeUnavailable && (
                <div className="mt-1 text-[11px] font-normal text-amber-300">
                  {t.settings.edgeUnavailableBadge}
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setTtsEngine('gemini');
                setTtsError(null);
                setSaveNotice(null);
              }}
              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer text-left ${
                ttsEngine === 'gemini'
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-300 hover:bg-white/[0.05]'
              }`}
            >
              {t.settings.engineGemini}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Default Voice Pools */}
      {showVoicesSection && (
        <>
          <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            {formatMsg(t.settings.poolsTitle, {
              engine: ttsEngine === 'edge' ? t.settings.engineEdge : t.settings.engineGemini,
            })}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">{t.settings.poolsDesc}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {(['my-MM', 'en-US'] as const).map((langKey) => {
            const pool = activePools[langKey];
            const title =
              langKey === 'my-MM' ? t.settings.langBurmeseTitle : t.settings.langEnglishTitle;
            return (
              <div key={langKey} className="border-t border-white/[0.08] pt-3 space-y-3">
                <div className="text-xs font-semibold text-slate-200">{title}</div>

                {(['female', 'male'] as const).map((g) => {
                  const list = pool[g];
                  const label =
                    g === 'female' ? t.settings.femalePoolLabel : t.settings.malePoolLabel;
                  return (
                    <div key={g} className="space-y-1.5">
                      <div className="text-xs text-slate-400">{label}</div>
                      {list.length === 0 ? (
                        <div className="text-xs text-slate-500">{t.settings.emptyPoolHint}</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {list.map((voiceName) => (
                            <div
                              key={voiceName}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200"
                            >
                              <span>{voiceName}</span>
                              <button
                                type="button"
                                aria-label={t.settings.removeFromPoolAria}
                                onClick={() => toggleVoiceInPool(ttsEngine, langKey, g, voiceName)}
                                className="text-slate-400 hover:text-red-400 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Exact TTS Error Banner */}
      {ttsError && (
        <div className="border border-red-800 bg-red-950/70 rounded-xl px-4 py-3 flex items-start gap-3 text-xs text-red-100">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <div className="font-semibold text-red-300">{t.settings.ttsErrorTitle}</div>
            <pre className="font-mono whitespace-pre-wrap break-all text-red-100">{ttsError}</pre>
          </div>
        </div>
      )}

      {voicesCatalog?.edge.error && ttsEngine === 'edge' && (
        <div className="border border-red-800 bg-red-950/70 rounded-xl px-4 py-3 flex items-start gap-3 text-xs text-red-100">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <div className="font-semibold text-red-300">{t.settings.ttsErrorTitle}</div>
            <pre className="font-mono whitespace-pre-wrap break-all text-red-100">
              {voicesCatalog.edge.error}
            </pre>
          </div>
        </div>
      )}

      {/* Active Global Preview Player Bar (Fallback / Quick Download) */}
      {playingVoice && (
        <div className="border border-cyan-400/40 bg-[#131A2A] rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 text-xs text-slate-200 min-w-0">
            <Volume2 className="w-4 h-4 text-cyan-400 shrink-0" />
            <span className="font-medium whitespace-nowrap">
              {formatMsg(t.settings.playingBanner, {
                voice: playingVoice.voice,
                lang: playingVoice.lang,
              })}
            </span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-400 truncate">{playingVoice.text}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <audio
              ref={audioRef}
              controls
              src={playingVoice.src}
              onEnded={() => setPlayingVoice(null)}
              className="h-8 w-56"
            />
            <a
              href={playingVoice.src}
              download={`${playingVoice.voice}.${playingVoice.ext}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-cyan-400/60 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {t.settings.downloadBtn}
            </a>
            <button
              type="button"
              onClick={stopPlayback}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-white/25 cursor-pointer whitespace-nowrap"
            >
              <Square className="w-3 h-3" />
              {t.settings.stopPlaybackBtn}
            </button>
          </div>
        </div>
      )}

      {/* Voice List & Per-Row Diagnostic Preview Table */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl overflow-hidden">
        <div className="p-5 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-slate-100">
            {ttsEngine === 'edge' ? t.settings.voiceListEdgeTitle : t.settings.voiceListGeminiTitle}
          </h2>

          <div className="flex flex-wrap items-center gap-2.5">
            {ttsEngine === 'edge' && (
              <div className="flex items-center gap-1 p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
                {(
                  [
                    ['all', t.settings.filterAllLocales],
                    ['my-MM', t.settings.filterMyLocale],
                    ['en-*', t.settings.filterEnLocale],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setLocaleFilter(id)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      localeFilter === id
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {ttsEngine === 'gemini' && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">{t.settings.sampleLangLabel}</span>
                <div className="flex items-center gap-1 p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
                  <button
                    type="button"
                    onClick={() => setGeminiSampleLang('my-MM')}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      geminiSampleLang === 'my-MM'
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t.settings.sampleMyLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setGeminiSampleLang('en-US')}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      geminiSampleLang === 'en-US'
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t.settings.sampleEnLabel}
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-1 p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
              {(
                [
                  ['all', t.settings.filterAllGender],
                  ['female', t.settings.filterFemale],
                  ['male', t.settings.filterMale],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setGenderFilter(id)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    genderFilter === id
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.settings.searchPlaceholder}
              className="px-3 py-1.5 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/70"
            />

            {ttsEngine === 'edge' && (
              <button
                type="button"
                disabled={voicesLoading}
                onClick={() => void loadVoices(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-white/25 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${voicesLoading ? 'animate-spin' : ''}`} />
                {t.settings.reloadVoicesBtn}
              </button>
            )}
          </div>
        </div>

        {voicesLoading ? (
          <div className="p-6 text-xs text-slate-400">{t.settings.loadingVoices}</div>
        ) : ttsEngine === 'edge' ? (
          filteredEdgeVoices.length === 0 ? (
            <div className="p-6 text-xs text-slate-400">{t.settings.emptyVoicesFilter}</div>
          ) : (
            <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[#131A2A] border-b border-[rgba(148,163,184,0.14)] text-xs font-medium text-slate-400">
                  <tr>
                    <th className="py-3 px-4">{t.settings.colVoiceName}</th>
                    <th className="py-3 px-4">{t.settings.colGender}</th>
                    <th className="py-3 px-4">{t.settings.colLocaleStyle}</th>
                    <th className="py-3 px-4">{t.settings.colDefaultPools}</th>
                    <th className="py-3 px-4 text-right">{t.settings.colPreview}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs">
                  {filteredEdgeVoices.map((v) => {
                    const inMy = activePools['my-MM'][v.gender].includes(v.name);
                    const inEn = activePools['en-US'][v.gender].includes(v.name);
                    const sampleLang: TargetLang = v.locale === 'my-MM' ? 'my-MM' : 'en-US';
                    const isSynth = previewingVoice === v.name;
                    const diag = rowDiagnostics[`edge:${v.name}`];
                    return (
                      <React.Fragment key={v.name}>
                        <tr className="hover:bg-white/[0.03] transition-colors">
                          <td className="py-2.5 px-4">
                            <div className="font-mono text-slate-100">{v.name}</div>
                            <div className="text-[11px] text-slate-400 truncate max-w-[320px]">
                              {v.friendlyName}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-slate-300">
                            {v.gender === 'female' ? t.settings.genderFemale : t.settings.genderMale}
                          </td>
                          <td className="py-2.5 px-4 font-mono text-slate-300">{v.locale}</td>
                          <td className="py-2.5 px-4">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleVoiceInPool('edge', 'my-MM', v.gender, v.name)}
                                className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                                  inMy
                                    ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-300'
                                    : 'bg-[#0B0F19] border-white/[0.08] text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                {inMy && <Check className="w-3 h-3" />}
                                {t.settings.addToMyPool}
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleVoiceInPool('edge', 'en-US', v.gender, v.name)}
                                className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                                  inEn
                                    ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-300'
                                    : 'bg-[#0B0F19] border-white/[0.08] text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                {inEn && <Check className="w-3 h-3" />}
                                {t.settings.addToEnPool}
                              </button>
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button
                              type="button"
                              disabled={previewingVoice !== null}
                              onClick={() => void handlePreviewVoice('edge', v.name, sampleLang)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-cyan-400/60 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                            >
                              {isSynth ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Play className="w-3.5 h-3.5" />
                              )}
                              {isSynth ? t.settings.previewingBtn : t.settings.previewBtn}
                            </button>
                          </td>
                        </tr>
                        {renderRowDiagnostic(diag)}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : filteredGeminiVoices.length === 0 ? (
          <div className="p-6 text-xs text-slate-400">{t.settings.emptyVoicesFilter}</div>
        ) : (
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-[#131A2A] border-b border-[rgba(148,163,184,0.14)] text-xs font-medium text-slate-400">
                <tr>
                  <th className="py-3 px-4">{t.settings.colVoiceName}</th>
                  <th className="py-3 px-4">{t.settings.colGender}</th>
                  <th className="py-3 px-4">{t.settings.colLocaleStyle}</th>
                  <th className="py-3 px-4">{t.settings.colDefaultPools}</th>
                  <th className="py-3 px-4 text-right">{t.settings.colPreview}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {filteredGeminiVoices.map((v) => {
                  const inMy = activePools['my-MM'][v.gender].includes(v.name);
                  const inEn = activePools['en-US'][v.gender].includes(v.name);
                  const isSynth = previewingVoice === v.name;
                  const diag = rowDiagnostics[`gemini:${v.name}`];
                  return (
                    <React.Fragment key={v.name}>
                      <tr className="hover:bg-white/[0.03] transition-colors">
                        <td className="py-2.5 px-4 font-mono text-slate-100">{v.name}</td>
                        <td className="py-2.5 px-4 text-slate-300">
                          {v.gender === 'female' ? t.settings.genderFemale : t.settings.genderMale}
                        </td>
                        <td className="py-2.5 px-4 text-slate-300">
                          <span>{v.style}</span>
                          <span className="mx-1.5 text-slate-600">·</span>
                          <span className="font-mono text-slate-400">
                            {t.settings.geminiAllLocalesLabel}
                          </span>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => toggleVoiceInPool('gemini', 'my-MM', v.gender, v.name)}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                                inMy
                                  ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-300'
                                  : 'bg-[#0B0F19] border-white/[0.08] text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {inMy && <Check className="w-3 h-3" />}
                              {t.settings.addToMyPool}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleVoiceInPool('gemini', 'en-US', v.gender, v.name)}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                                inEn
                                  ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-300'
                                  : 'bg-[#0B0F19] border-white/[0.08] text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {inEn && <Check className="w-3 h-3" />}
                              {t.settings.addToEnPool}
                            </button>
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <button
                            type="button"
                            disabled={previewingVoice !== null}
                            onClick={() => void handlePreviewVoice('gemini', v.name, geminiSampleLang)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:border-cyan-400/60 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                          >
                            {isSynth ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            {isSynth ? t.settings.previewingBtn : t.settings.previewBtn}
                          </button>
                        </td>
                      </tr>
                      {renderRowDiagnostic(diag)}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
          </div>
        </>
      )}
    </div>
  );
};
