import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Loader2,
  RefreshCw,
  Save,
  Terminal,
  Wifi,
} from 'lucide-react';
import type { CapabilitiesResponse } from '../../shared/projectTypes';
import { formatMsg, useI18n } from '../i18n/I18nContext';
import { apiFetchJson, sanitizeUiErrorText } from '../utils/apiClient';
import { formatBytes } from '../utils/format';

interface EnvironmentPanelProps {
  capabilities: CapabilitiesResponse | null;
  loading: boolean;
  onRefresh: () => void;
  compactMode?: boolean;
}

interface DemucsTestResult {
  ok: boolean;
  baseUrl: string;
  healthUrl: string;
  status: number | null;
  latencyMs?: number;
  body?: string;
  error: string | null;
}

// Local strings for the remote-Demucs card (kept in this file to stay within the edit scope).
const remoteDemucsText = {
  my: {
    title: 'Remote Kaggle GPU Demucs',
    desc: 'Kaggle notebook မှ Cloudflare Tunnel base URL (ဥပမာ https://xxxx.trycloudflare.com) ကို ထည့်ပါ။ အဆုံးရှိ / နှင့် မလိုလားအပ်သော /separate ကို အလိုအလျောက် ဖယ်ရှားပေးမည်။ သိမ်းလိုက်သည်နှင့် config.json တွင် ရေးပြီး ချက်ချင်း အသုံးပြုမည် — ဆာဗာ ပြန်စရန် မလိုပါ။',
    configured: 'သတ်မှတ်ပြီး',
    notConfigured: 'မသတ်မှတ်ရသေးပါ (local fallback)',
    saved: 'သိမ်းပြီး · ယခု အသုံးပြုနေသည်',
    saveBtn: 'URL သိမ်းမည်',
    testBtn: 'ချိတ်ဆက်မှု စမ်းမည်',
    testOk: 'ချိတ်ဆက်မှု ကောင်းသည် (HTTP {status} · {latency} ms)',
    testFail: 'ချိတ်ဆက်မှု မအောင်မြင်ပါ',
    baseUrlLabel: 'ပြန်လည်ပြင်ဆင်ပြီး base URL',
    saveFailed: 'URL သိမ်း၍ မရပါ',
    testFailed: 'စမ်းသပ်မှု မအောင်မြင်ပါ',
  },
  en: {
    title: 'Remote Kaggle GPU Demucs',
    desc: 'Paste the Cloudflare Tunnel base URL from your Kaggle notebook (e.g. https://xxxx.trycloudflare.com). Trailing slashes and an accidental /separate suffix are stripped automatically. Saving writes it to config.json and applies immediately — no server restart needed.',
    configured: 'Configured',
    notConfigured: 'Not configured (local fallback)',
    saved: 'Saved · active now',
    saveBtn: 'Save URL',
    testBtn: 'Test connection',
    testOk: 'Connection healthy (HTTP {status} · {latency} ms)',
    testFail: 'Connection failed',
    baseUrlLabel: 'Normalized base URL',
    saveFailed: 'Failed to save URL',
    testFailed: 'Test failed',
  },
} as const;

export const EnvironmentPanel: React.FC<EnvironmentPanelProps> = ({
  capabilities,
  loading,
  onRefresh,
  compactMode = false,
}) => {
  const { t, localizeError, lang } = useI18n();
  const dt = remoteDemucsText[lang];

  const savedDemucsUrl = capabilities?.config.demucsRemoteUrl ?? '';
  const [demucsUrl, setDemucsUrl] = useState(savedDemucsUrl);
  const [savingDemucs, setSavingDemucs] = useState(false);
  const [testingDemucs, setTestingDemucs] = useState(false);
  const [demucsSaved, setDemucsSaved] = useState(false);
  const [demucsError, setDemucsError] = useState<string | null>(null);
  const [demucsTest, setDemucsTest] = useState<DemucsTestResult | null>(null);

  // Keep the input in sync when capabilities reload from the server.
  useEffect(() => {
    setDemucsUrl(savedDemucsUrl);
  }, [savedDemucsUrl]);

  const handleSaveDemucsUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingDemucs(true);
    setDemucsSaved(false);
    setDemucsError(null);
    try {
      const res = await apiFetchJson<{ config?: { demucsRemoteUrl?: string }; error?: string }>(
        '/api/config',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ demucsRemoteUrl: demucsUrl.trim() }),
        },
      );
      if (!res.ok) {
        throw new Error(res.data?.error || t.errors.genericFailed);
      }
      // Server normalizes the URL (strips trailing slashes / accidental /separate) and stores it
      // in config.json; the runtime config is updated in place, so no restart is needed.
      const normalized = res.data?.config?.demucsRemoteUrl ?? demucsUrl.trim();
      setDemucsUrl(normalized);
      setDemucsSaved(true);
      setTimeout(() => setDemucsSaved(false), 3000);
      // Reload capabilities so the normalized URL is reflected everywhere.
      onRefresh();
    } catch (err) {
      setDemucsError(`${dt.saveFailed}: ${sanitizeUiErrorText(err)}`);
    } finally {
      setSavingDemucs(false);
    }
  };

  const handleTestDemucsUrl = async () => {
    setTestingDemucs(true);
    setDemucsTest(null);
    setDemucsError(null);
    try {
      const res = await apiFetchJson<DemucsTestResult>('/api/demucs/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Test the URL currently typed in the box, even before it is saved.
        body: JSON.stringify({ url: demucsUrl.trim() }),
      });
      if (res.data && typeof res.data.ok === 'boolean') {
        setDemucsTest(res.data);
      } else {
        setDemucsError(`${dt.testFailed}: ${res.data?.error || t.errors.genericFailed}`);
      }
    } catch (err) {
      setDemucsError(`${dt.testFailed}: ${sanitizeUiErrorText(err)}`);
    } finally {
      setTestingDemucs(false);
    }
  };

  if (!capabilities) {
    return (
      <div className={compactMode ? '' : 'p-8 max-w-5xl mx-auto'}>
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-6 text-sm text-slate-400">
          {t.environment.loading}
        </div>
      </div>
    );
  }

  return (
    <div className={compactMode ? 'space-y-5' : 'p-8 max-w-5xl mx-auto space-y-6'}>
      <div className="flex items-center justify-between gap-4">
        {!compactMode ? (
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{t.environment.title}</h1>
            <p className="text-sm text-slate-400 mt-1">{t.environment.subtitle}</p>
          </div>
        ) : (
          <div className="text-xs text-slate-400">{t.environment.subtitle}</div>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#131A2A] border border-[rgba(148,163,184,0.14)] rounded-xl text-slate-200 hover:bg-white/[0.06] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t.environment.recheckBtn}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">{t.environment.ffmpegCard}</span>
            {capabilities.ffmpeg.ok ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {formatMsg(t.environment.operational, { source: capabilities.ffmpeg.source })}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                {t.environment.unavailable}
              </span>
            )}
          </div>
          <div className="mt-3 text-xs font-mono text-slate-300 space-y-1.5 break-all">
            <div>ffmpeg: {capabilities.ffmpeg.ffmpegPath ?? '—'}</div>
            <div>ffprobe: {capabilities.ffmpeg.ffprobePath ?? '—'}</div>
            <div className="text-slate-400 truncate" title={capabilities.ffmpeg.ffmpegVersion ?? ''}>
              {capabilities.ffmpeg.ok
                ? capabilities.ffmpeg.ffmpegVersion
                : t.errors.ffmpegNotFound}
            </div>
          </div>
        </div>

        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">{t.environment.geminiCard}</span>
            {capabilities.gemini.configured && capabilities.gemini.keyValid ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t.environment.keyVerified}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                {capabilities.gemini.configured
                  ? t.environment.keyInvalid
                  : t.environment.keyMissing}
              </span>
            )}
          </div>
          <div className="mt-3 text-xs text-slate-300 space-y-1.5">
            <div className="font-mono tabular-nums">
              {t.environment.catalogCount}: {capabilities.gemini.availableModelCount}
            </div>
            {capabilities.gemini.keyError && (
              <div className="text-red-400 whitespace-pre-wrap break-words">
                {localizeError(capabilities.gemini.keyError)}
              </div>
            )}
            <div className="text-slate-400">
              {t.environment.optionalDemucs}{' '}
              <span className={capabilities.demucs.available ? 'text-emerald-400' : 'text-slate-300'}>
                {capabilities.demucs.available
                  ? t.environment.demucsFound
                  : t.environment.demucsMissing}
              </span>
            </div>
          </div>
        </div>

        <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">{t.environment.diskCard}</span>
            <HardDrive className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-3 space-y-1">
            <div className="text-lg font-mono tabular-nums text-slate-100">
              {formatBytes(capabilities.disk.freeBytes)} {t.environment.freeSuffix}
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-400">
              {t.environment.totalVolumePrefix}: {formatBytes(capabilities.disk.totalBytes)} ·{' '}
              {t.environment.diskRuleHint}
            </div>
            <div className="text-[11px] font-mono text-slate-400 pt-1 break-all">
              {t.environment.dataDirLabel}: <span className="text-slate-200">{capabilities.disk.dataDir}</span>
            </div>
          </div>
        </div>
      </div>

      <form
        onSubmit={handleSaveDemucsUrl}
        className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wifi className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-slate-100">
              {dt.title}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {savedDemucsUrl ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {dt.configured}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                {dt.notConfigured}
              </span>
            )}
            {demucsSaved && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {dt.saved}
              </span>
            )}
          </div>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          {dt.desc}
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <input
            type="text"
            value={demucsUrl}
            onChange={(e) => {
              setDemucsUrl(e.target.value);
              setDemucsSaved(false);
              setDemucsError(null);
              setDemucsTest(null);
            }}
            placeholder="https://xxxx.trycloudflare.com"
            spellCheck={false}
            className="flex-1 px-3 py-2 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/70"
          />
          <button
            type="submit"
            disabled={savingDemucs}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
          >
            {savingDemucs ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{dt.saveBtn}</span>
          </button>
          <button
            type="button"
            onClick={handleTestDemucsUrl}
            disabled={testingDemucs}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
          >
            {testingDemucs ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Wifi className="w-3.5 h-3.5" />
            )}
            <span>{dt.testBtn}</span>
          </button>
        </div>

        {demucsError && <p className="text-xs text-red-400 break-words">{demucsError}</p>}

        {demucsTest && (
          <div
            className={`rounded-lg border p-3 text-xs space-y-1 break-all ${
              demucsTest.ok
                ? 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-300'
                : 'border-red-500/30 bg-red-500/[0.06] text-red-300'
            }`}
          >
            <div className="inline-flex items-center gap-1.5 font-semibold">
              {demucsTest.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5" />
              )}
              {demucsTest.ok
                ? formatMsg(dt.testOk, {
                    status: demucsTest.status ?? 0,
                    latency: demucsTest.latencyMs ?? 0,
                  })
                : dt.testFail}
            </div>
            <div className="font-mono text-[11px] opacity-90">GET {demucsTest.healthUrl}</div>
            <div className="font-mono text-[11px] opacity-80">
              {dt.baseUrlLabel}: {demucsTest.baseUrl || '—'}
            </div>
            {demucsTest.error && (
              <div className="font-mono text-[11px] whitespace-pre-wrap">{demucsTest.error}</div>
            )}
            {demucsTest.body && (
              <div className="font-mono text-[11px] opacity-80 whitespace-pre-wrap">
                {demucsTest.body.slice(0, 300)}
              </div>
            )}
          </div>
        )}
      </form>

      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">{t.environment.configHeader}</h2>
          <span className="text-xs text-slate-400">{t.environment.configNote}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400">TEXT_MODEL</div>
            <div className="font-mono text-slate-100 mt-1">{capabilities.config.TEXT_MODEL}</div>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400">TRANSCRIBE_MODEL</div>
            <div className="font-mono text-slate-100 mt-1">{capabilities.config.TRANSCRIBE_MODEL}</div>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400">TTS_MODEL</div>
            <div className="font-mono text-slate-100 mt-1">{capabilities.config.TTS_MODEL}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
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
              <div key={key} className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
                <div className="text-slate-400 font-sans">{label}</div>
                <div className="text-slate-100 mt-1">
                  {t.environment.requestsLabel}: {count}
                </div>
                <div className="text-slate-500 text-[11px] mt-0.5">
                  conc {rl.concurrency} · {rl.intervalCap}/{rl.interval / 1000}s
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs font-mono tabular-nums">
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400 font-sans">{t.environment.chunkSizeLabel}</div>
            <div className="text-slate-200 mt-1">
              {formatBytes(capabilities.config.CHUNK_SIZE_BYTES)}
            </div>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400 font-sans">{t.environment.maxWindowLabel}</div>
            <div className="text-slate-200 mt-1">
              {capabilities.config.MAX_SPEECH_WINDOW_SEC / 60} min
            </div>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400 font-sans">{t.environment.silenceFilterLabel}</div>
            <div className="text-slate-200 mt-1">
              {capabilities.config.SILENCE_NOISE_DB}dB / {capabilities.config.SILENCE_MIN_SEC}s
            </div>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400 font-sans">{t.environment.sceneCutLabel}</div>
            <div className="text-slate-200 mt-1">gt({capabilities.config.SCENE_THRESHOLD})</div>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3 bg-[#0B0F19]">
            <div className="text-slate-400 font-sans">{t.environment.gapRatioLabel}</div>
            <div className="text-slate-200 mt-1">
              {capabilities.config.GAP_MS}ms / {capabilities.config.RECAP_RATIO}
            </div>
          </div>
        </div>

        {capabilities.gemini.resolutionNotes.length > 0 && (
          <div className="border-t border-white/[0.08] pt-3 space-y-1">
            <div className="text-xs font-medium text-slate-400">{t.environment.startupNotesTitle}</div>
            {capabilities.gemini.resolutionNotes.map((note, idx) => (
              <div key={idx} className="text-xs font-mono text-slate-300">
                · {note}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Terminal className="w-4 h-4 text-cyan-400" />
          {t.environment.localTitle}
        </div>
        <p className="text-xs text-slate-300 leading-relaxed">{t.environment.localDesc}</p>
        <pre className="text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg p-3 text-slate-200 overflow-x-auto">
          brew install ffmpeg && npm install && GEMINI_API_KEY=your_key npm run dev
        </pre>
      </div>
    </div>
  );
};
