import React, { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, FolderTree, Loader2, Save, Volume2, X } from 'lucide-react';
import type { CapabilitiesResponse, ResilientQueueStatus } from '../../shared/projectTypes';
import { useI18n } from '../i18n/I18nContext';
import { apiFetchJson, sanitizeUiErrorText } from '../utils/apiClient';
import { EnvironmentPanel } from './EnvironmentPanel';
import { SettingsVoicesPanel } from './SettingsVoicesPanel';

export type SettingsDrawerTab = 'models' | 'voices' | 'paths';

interface SettingsDrawerProps {
  open: boolean;
  initialTab?: SettingsDrawerTab;
  capabilities: CapabilitiesResponse | null;
  capLoading: boolean;
  resilientStatus: ResilientQueueStatus | null;
  onClose: () => void;
  onConfigSaved: () => Promise<void> | void;
  onRefreshCapabilities: () => void;
}

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  open,
  initialTab = 'models',
  capabilities,
  capLoading,
  resilientStatus,
  onClose,
  onConfigSaved,
  onRefreshCapabilities,
}) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsDrawerTab>(initialTab);
  const [demucsRemoteUrl, setDemucsRemoteUrl] = useState(
    capabilities?.config.demucsRemoteUrl ?? '',
  );
  const [savingDemucsUrl, setSavingDemucsUrl] = useState(false);
  const [demucsUrlSaved, setDemucsUrlSaved] = useState(false);
  const [demucsUrlError, setDemucsUrlError] = useState<string | null>(null);

  const [groqApiKey, setGroqApiKey] = useState(
    capabilities?.config.groqApiKey ?? '',
  );
  const [savingGroqKey, setSavingGroqKey] = useState(false);
  const [groqKeySaved, setGroqKeySaved] = useState(false);
  const [groqKeyError, setGroqKeyError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setDemucsRemoteUrl(capabilities?.config.demucsRemoteUrl ?? '');
      setGroqApiKey(capabilities?.config.groqApiKey ?? '');
      setDemucsUrlSaved(false);
      setDemucsUrlError(null);
      setGroqKeySaved(false);
      setGroqKeyError(null);
    }
  }, [open, initialTab, capabilities?.config.demucsRemoteUrl, capabilities?.config.groqApiKey]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const handleSaveDemucsRemoteUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingDemucsUrl(true);
    setDemucsUrlSaved(false);
    setDemucsUrlError(null);
    try {
      const res = await apiFetchJson<{ error?: string }>('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          demucsRemoteUrl: demucsRemoteUrl.trim(),
        }),
      });
      if (!res.ok) {
        throw new Error(res.data?.error || t.errors.genericFailed);
      }
      await onConfigSaved();
      setDemucsUrlSaved(true);
      setTimeout(() => setDemucsUrlSaved(false), 3000);
    } catch (err) {
      setDemucsUrlError(sanitizeUiErrorText(err));
    } finally {
      setSavingDemucsUrl(false);
    }
  };

  const handleSaveGroqApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGroqKey(true);
    setGroqKeySaved(false);
    setGroqKeyError(null);
    try {
      const res = await apiFetchJson<{ error?: string }>('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groqApiKey: groqApiKey.trim(),
        }),
      });
      if (!res.ok) {
        throw new Error(res.data?.error || t.errors.genericFailed);
      }
      await onConfigSaved();
      setGroqKeySaved(true);
      setTimeout(() => setGroqKeySaved(false), 3000);
    } catch (err) {
      setGroqKeyError(sanitizeUiErrorText(err));
    } finally {
      setSavingGroqKey(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t.wizard.drawerTitle}
    >
      <div
        className="w-full max-w-4xl h-full bg-[#0B0F19] border-l border-white/[0.08] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[rgba(148,163,184,0.14)] bg-[#131A2A]/60 flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-slate-100">{t.wizard.drawerTitle}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{t.wizard.drawerSubtitle}</p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={t.wizard.closeBtn}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#131A2A] border border-white/10 rounded-lg text-slate-300 hover:text-white hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <X className="w-4 h-4" />
            <span>{t.wizard.closeBtn}</span>
          </button>
        </div>

        <div className="px-6 pt-3 border-b border-[rgba(148,163,184,0.14)] bg-[#131A2A]/30 flex items-center gap-6 text-xs font-medium shrink-0">
          {(
            [
              ['models', t.wizard.drawerTabModels, Cpu],
              ['voices', t.wizard.drawerTabVoices, Volume2],
              ['paths', t.wizard.drawerTabPaths, FolderTree],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`pb-3 inline-flex items-center gap-2 border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                tab === id
                  ? 'border-cyan-400/60 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="px-6 py-4 border-b border-[rgba(148,163,184,0.14)] bg-[#131A2A]/70 shrink-0 space-y-4">
          <form onSubmit={handleSaveDemucsRemoteUrl} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="settings-demucs-remote-url"
                className="text-xs font-semibold text-slate-100"
              >
                Kaggle GPU Demucs URL (Optional)
              </label>
              {demucsUrlSaved && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {t.settings.savedNotice}
                </span>
              )}
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                id="settings-demucs-remote-url"
                type="text"
                value={demucsRemoteUrl}
                onChange={(e) => {
                  setDemucsRemoteUrl(e.target.value);
                  setDemucsUrlSaved(false);
                  setDemucsUrlError(null);
                }}
                placeholder="https://xxxx.trycloudflare.com"
                className="flex-1 px-3 py-2 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/70"
              />
              <button
                type="submit"
                disabled={savingDemucsUrl}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {savingDemucsUrl ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>{t.settings.saveConfigBtn}</span>
              </button>
            </div>
            {demucsUrlError && <p className="text-xs text-red-400">{demucsUrlError}</p>}
          </form>

          <form onSubmit={handleSaveGroqApiKey} className="space-y-2 pt-2 border-t border-white/[0.06]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="settings-groq-api-key"
                className="text-xs font-semibold text-slate-100"
              >
                Groq API Key (Optional for ultra-fast S1)
              </label>
              {groqKeySaved && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {t.settings.savedNotice}
                </span>
              )}
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                id="settings-groq-api-key"
                type="password"
                value={groqApiKey}
                onChange={(e) => {
                  setGroqApiKey(e.target.value);
                  setGroqKeySaved(false);
                  setGroqKeyError(null);
                }}
                placeholder="gsk_..."
                className="flex-1 px-3 py-2 text-xs font-mono bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/70"
              />
              <button
                type="submit"
                disabled={savingGroqKey}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {savingGroqKey ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>{t.settings.saveConfigBtn}</span>
              </button>
            </div>
            {groqKeyError && <p className="text-xs text-red-400">{groqKeyError}</p>}
          </form>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'models' && (
            <SettingsVoicesPanel
              capabilities={capabilities}
              onConfigSaved={onConfigSaved}
              section="models"
              compactMode
              resilientStatus={resilientStatus}
            />
          )}

          {tab === 'voices' && (
            <SettingsVoicesPanel
              capabilities={capabilities}
              onConfigSaved={onConfigSaved}
              section="voices"
              compactMode
              resilientStatus={resilientStatus}
            />
          )}

          {tab === 'paths' && (
            <EnvironmentPanel
              capabilities={capabilities}
              loading={capLoading}
              onRefresh={onRefreshCapabilities}
              compactMode
            />
          )}
        </div>
      </div>
    </div>
  );
};
