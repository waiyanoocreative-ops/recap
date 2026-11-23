import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Film,
  Languages,
  Loader2,
  MessageSquareText,
  Settings,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  CapabilitiesResponse,
  Gender,
  Project,
  SpeechStyle,
} from '../../../shared/projectTypes';
import { getVoiceGender } from '../../../shared/dubUtils';
import { formatMsg, useI18n } from '../../i18n/I18nContext';
import { apiFetchJson } from '../../utils/apiClient';
import {
  FALLBACK_EDGE_VOICES,
  defaultEdgeVoiceFor,
  type ProjectController,
} from '../../hooks/useProjectController';

interface Step3ModeVoicesProps {
  project: Project;
  capabilities: CapabilitiesResponse | null;
  controller: ProjectController;
  onOpenSettings: (tab?: 'models' | 'voices' | 'paths') => void;
  onNextStep: () => void;
}

export const Step3ModeVoices: React.FC<Step3ModeVoicesProps> = ({
  project,
  capabilities,
  controller,
  onOpenSettings,
  onNextStep,
}) => {
  const { t } = useI18n();

  const speechStyle: SpeechStyle = capabilities?.config.SPEECH_STYLE ?? 'polite';
  const configuredTtsVolumePct = capabilities?.config.TTS_VOLUME_PCT ?? 150;
  const [ttsVolumeDraft, setTtsVolumeDraft] = useState<number>(configuredTtsVolumePct);

  useEffect(() => {
    setTtsVolumeDraft(configuredTtsVolumePct);
  }, [configuredTtsVolumePct]);

  const langChoiceValue: 'my-MM' | 'en-US' | 'both' =
    project.target_langs.length === 2
      ? 'both'
      : project.target_langs[0] === 'en-US'
        ? 'en-US'
        : 'my-MM';

  const recapMuted = project.mode === 'recap' && (project.recap_mute_original ?? true);
  const speakerEntries = useMemo(() => Object.entries(project.speakers), [project.speakers]);

  const [bridgeEnabled, setBridgeEnabled] = useState<boolean>(Boolean(project.useManualAiBridge));
  const [savingBridge, setSavingBridge] = useState(false);
  const [bridgeErr, setBridgeErr] = useState<string | null>(null);

  useEffect(() => {
    setBridgeEnabled(Boolean(project.useManualAiBridge));
  }, [project.id, project.useManualAiBridge]);

  const handleToggleManualBridge = async () => {
    const nextVal = !bridgeEnabled;
    setBridgeEnabled(nextVal);
    setBridgeErr(null);
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
      setBridgeErr(err instanceof Error ? err.message : t.errors.genericFailed);
    } finally {
      setSavingBridge(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-[1440px] mx-auto space-y-5">
      {/* Header + Primary CTA */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-slate-100">{t.wizard.step3Title}</h1>
          <p className="text-xs text-slate-400">
            {project.mode === 'recap'
              ? t.wizard.recapVoiceHint
              : t.wizard.modelsManagedInSettingsHint}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onOpenSettings('models')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-200 rounded-lg hover:border-cyan-400/50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Settings className="w-3.5 h-3.5 text-cyan-400" />
            <span>{t.wizard.settingsBtn}</span>
          </button>

          <button
            type="button"
            onClick={onNextStep}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
          >
            <span>{t.wizard.nextStep4Btn}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {controller.actionError && (
        <div className="border border-red-500/40 bg-red-950/50 rounded-xl px-4 py-3 flex items-start gap-3 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <p className="whitespace-pre-wrap break-words leading-relaxed">{controller.actionError}</p>
        </div>
      )}

      {/* 1. Workflow Mode + 2. Target Language */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">{t.wizard.modeSectionTitle}</h2>
            {project.mode === 'dubbing' ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
                <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{t.dubbing.duckingNotice}</span>
              </span>
            ) : (
              <button
                type="button"
                disabled={controller.isDubRunning}
                onClick={() =>
                  void controller.handleUpdateProjectSettings({
                    recap_mute_original: !(project.recap_mute_original ?? true),
                  })
                }
                className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                  recapMuted
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-200 hover:bg-amber-900/40'
                    : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-900/40'
                }`}
              >
                {recapMuted ? (
                  <VolumeX className="w-3.5 h-3.5" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                <span>
                  {recapMuted ? t.workbench.recapAudioMuted : t.workbench.recapAudioOn}
                </span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              disabled={controller.isDubRunning}
              onClick={() => void controller.handleUpdateProjectSettings({ mode: 'dubbing' })}
              className={`p-4 rounded-xl border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                project.mode === 'dubbing'
                  ? 'bg-cyan-950/40 border-cyan-400/60 text-white shadow-[0_0_20px_rgba(6,182,212,0.18)] ring-1 ring-cyan-400/30'
                  : 'bg-[#0B0F19] border-white/[0.08] text-slate-300 hover:border-white/20'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                <span className="inline-flex items-center gap-2">
                  <Languages className="w-4 h-4 text-cyan-400" />
                  <span>{t.workbench.modeDubbing}</span>
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {t.projects.modeDubbingShort}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                {t.wizard.modeDubbingDesc}
              </p>
            </button>

            <button
              type="button"
              disabled={controller.isDubRunning}
              onClick={() => void controller.handleUpdateProjectSettings({ mode: 'recap' })}
              className={`p-4 rounded-xl border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                project.mode === 'recap'
                  ? 'bg-cyan-950/40 border-cyan-400/60 text-white shadow-[0_0_20px_rgba(6,182,212,0.18)] ring-1 ring-cyan-400/30'
                  : 'bg-[#0B0F19] border-white/[0.08] text-slate-300 hover:border-white/20'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                <span className="inline-flex items-center gap-2">
                  <Film className="w-4 h-4 text-cyan-400" />
                  <span>{t.workbench.modeRecap}</span>
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {t.projects.modeRecapShort}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                {t.wizard.modeRecapDesc}
              </p>
            </button>
          </div>
        </div>

        <div className="lg:col-span-5 border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            {t.wizard.targetLangSectionTitle}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {(['my-MM', 'en-US', 'both'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={controller.isDubRunning}
                onClick={() =>
                  void controller.handleUpdateProjectSettings({
                    target_langs: choice === 'both' ? ['my-MM', 'en-US'] : [choice],
                  })
                }
                className={`px-3 py-3 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                  langChoiceValue === choice
                    ? 'bg-cyan-500 border-cyan-400 text-white'
                    : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-white/25'
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

          {langChoiceValue === 'both' && (
            <div className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
              {t.workbench.dualSubModeHint}
            </div>
          )}

          <div className="pt-2 border-t border-white/[0.08] text-xs text-slate-400 flex items-center justify-between gap-3">
            <span>{t.wizard.modelsManagedInSettingsHint}</span>
            <button
              type="button"
              onClick={() => onOpenSettings('models')}
              className="text-cyan-400 hover:text-cyan-300 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t.wizard.drawerTabModels}
            </button>
          </div>
        </div>
      </div>

      {/* 2b. No-API-Key Manual AI Chat Bridge Toggle */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3 max-w-2xl">
          <div className="w-9 h-9 rounded-lg bg-cyan-500/15 border border-cyan-400/30 flex items-center justify-center shrink-0 mt-0.5">
            <MessageSquareText className="w-4 h-4 text-cyan-300" />
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-100">
                Use My AI Chat App (No API Key Required)
              </span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                  bridgeEnabled
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-[#0B0F19] border-white/10 text-slate-400'
                }`}
              >
                {bridgeEnabled ? 'ON · Gemini Web / ChatGPT' : 'OFF · Gemini API'}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Bypass Gemini API keys completely across Recap, Recap-to-Recap, and Dubbing (up to 240-minute videos). Copy smart-batched prompts (200 cues/batch) into Gemini Web or ChatGPT, paste JSON back in Step 4, and synthesize Edge-TTS + compact MP4.
            </p>
            {bridgeErr && <p className="text-xs text-red-300">{bridgeErr}</p>}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={bridgeEnabled}
          aria-label="Use My AI Chat App (No API Key Required)"
          disabled={savingBridge || controller.isDubRunning}
          onClick={() => void handleToggleManualBridge()}
          className={`inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
            bridgeEnabled
              ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200 hover:bg-emerald-600/30'
              : 'bg-[#0B0F19] border-white/15 text-slate-300 hover:border-cyan-400/50'
          }`}
        >
          <span
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors ${
              bridgeEnabled
                ? 'bg-emerald-500 border-emerald-400'
                : 'bg-slate-700 border-slate-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
                bridgeEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </span>
          <span>Use My AI Chat App (No API Key Required)</span>
        </button>
      </div>

      {/* 3. TTS Engine, Speech Style & Voice Volume */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span>{t.wizard.voiceEngineSectionTitle}</span>
          </div>
          {controller.savingSettings && (
            <span className="inline-flex items-center gap-1.5 text-xs text-cyan-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t.dubbing.savingSettingsBtn}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start text-xs">
          <div className="md:col-span-4 space-y-1.5">
            <div className="text-[11px] text-slate-400">{t.settings.ttsEngineTitle}</div>
            <div className="inline-flex w-full p-1 bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg">
              <button
                type="button"
                disabled={
                  controller.edgeUnavailable || controller.savingSettings || controller.isDubRunning
                }
                onClick={() => void controller.saveConfigPatch({ TTS_ENGINE: 'edge' })}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  controller.edgeUnavailable
                    ? 'opacity-45 cursor-not-allowed text-slate-500'
                    : controller.activeEngine === 'edge'
                      ? 'bg-cyan-500 text-slate-950 cursor-pointer'
                      : 'text-slate-300 hover:bg-white/[0.05] cursor-pointer'
                }`}
              >
                {t.settings.engineEdge}
              </button>
              <button
                type="button"
                disabled={controller.savingSettings || controller.isDubRunning}
                onClick={() => void controller.saveConfigPatch({ TTS_ENGINE: 'gemini' })}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  controller.activeEngine === 'gemini'
                    ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-300 hover:bg-white/[0.05]'
                }`}
              >
                {t.settings.engineGemini}
              </button>
            </div>
            {controller.edgeUnavailable && (
              <div className="text-[11px] text-amber-300">{t.settings.edgeUnavailableBadge}</div>
            )}
          </div>

          <div className="md:col-span-4 space-y-1.5">
            <label className="block text-[11px] text-slate-400">
              {t.settings.speechStyleLabel}
            </label>
            <select
              disabled={controller.savingSettings || controller.isDubRunning}
              value={speechStyle}
              onChange={(e) =>
                void controller.saveConfigPatch({ SPEECH_STYLE: e.target.value as SpeechStyle })
              }
              className="w-full px-3 py-2 text-xs bg-[#0E1422] border border-[rgba(148,163,184,0.18)] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400/70"
            >
              <option value="polite">{t.settings.speechStylePolite}</option>
              <option value="casual">{t.settings.speechStyleCasual}</option>
            </select>
          </div>

          <div className="md:col-span-4 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>{t.dubbing.ttsVolumeLabel}</span>
              <span className="font-mono text-xs text-cyan-300 tabular-nums">{ttsVolumeDraft}%</span>
            </div>
            <div className="flex items-center gap-2.5">
              <input
                type="range"
                min={100}
                max={200}
                step={5}
                disabled={controller.savingSettings || controller.isDubRunning}
                value={ttsVolumeDraft}
                onChange={(e) => setTtsVolumeDraft(Number(e.target.value))}
                onMouseUp={(e) => {
                  const val = Number((e.target as HTMLInputElement).value);
                  if (val !== configuredTtsVolumePct) {
                    void controller.saveConfigPatch({ TTS_VOLUME_PCT: val });
                  }
                }}
                onTouchEnd={(e) => {
                  const val = Number((e.target as HTMLInputElement).value);
                  if (val !== configuredTtsVolumePct) {
                    void controller.saveConfigPatch({ TTS_VOLUME_PCT: val });
                  }
                }}
                onKeyUp={(e) => {
                  const val = Number((e.target as HTMLInputElement).value);
                  if (val !== configuredTtsVolumePct) {
                    void controller.saveConfigPatch({ TTS_VOLUME_PCT: val });
                  }
                }}
                className="flex-1 accent-cyan-500 cursor-pointer"
              />
              <div className="flex items-center gap-1">
                {[100, 150, 200].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={controller.savingSettings || controller.isDubRunning}
                    onClick={() => {
                      setTtsVolumeDraft(preset);
                      if (preset !== configuredTtsVolumePct) {
                        void controller.saveConfigPatch({ TTS_VOLUME_PCT: preset });
                      }
                    }}
                    className={`px-2 py-1 text-[11px] font-mono rounded-lg border cursor-pointer disabled:opacity-50 tabular-nums ${
                      ttsVolumeDraft === preset
                        ? 'bg-cyan-500 border-cyan-400 text-white'
                        : 'bg-[#0B0F19] border-white/10 text-slate-300 hover:border-white/25'
                    }`}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Speaker Gender & Voice Assignment */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Volume2 className="w-4 h-4 text-cyan-400" />
            <span>{t.wizard.speakersVoiceTitle}</span>
            <span className="text-xs font-mono font-normal text-slate-400">
              · {controller.activeEngine === 'edge' ? 'Edge TTS' : 'Gemini TTS'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {controller.voicePreviewAudio && (
              <div className="flex items-center gap-2 text-[11px] text-slate-300">
                <span className="font-mono">
                  {controller.voicePreviewAudio.speaker} ({controller.voicePreviewAudio.voice})
                </span>
                <audio controls src={controller.voicePreviewAudio.src} className="h-7 w-56" />
              </div>
            )}
            <button
              type="button"
              onClick={() => onOpenSettings('voices')}
              className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline cursor-pointer whitespace-nowrap"
            >
              {t.wizard.drawerTabVoices}
            </button>
          </div>
        </div>

        {speakerEntries.length === 0 ? (
          <div className="border border-white/[0.08] bg-[#0B0F19] rounded-xl p-6 text-center text-xs text-slate-400">
            {t.dubbing.voiceMapEmpty}
          </div>
        ) : (
          <div className="overflow-x-auto border border-white/[0.08] rounded-xl">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-[#0B0F19] border-b border-white/[0.08] text-[11px] text-slate-400">
                <tr>
                  <th className="py-2.5 px-4">{t.dubbing.colSpeaker}</th>
                  <th className="py-2.5 px-4">{t.dubbing.colGender}</th>
                  <th className="py-2.5 px-4">
                    {formatMsg(t.dubbing.colVoiceForEngine, {
                      engine: controller.activeEngine === 'edge' ? 'Edge' : 'Gemini',
                    })}
                  </th>
                  <th className="py-2.5 px-4 text-right">{t.dubbing.colPreview}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] bg-[#0B0F19]/60">
                {speakerEntries.map(([speakerId, info]) => {
                  const edgeList =
                    controller.edgeVoices.length > 0 ? controller.edgeVoices : FALLBACK_EDGE_VOICES;
                  const storedEngineMatches =
                    info.voice?.engine === controller.activeEngine && Boolean(info.voice.name);
                  const storedVoiceGender = storedEngineMatches
                    ? getVoiceGender(info.voice?.name, controller.activeEngine, edgeList)
                    : null;
                  const genderAligned =
                    info.voice_overridden ||
                    info.gender === 'unknown' ||
                    storedVoiceGender === null ||
                    storedVoiceGender === info.gender;
                  const currentVoice =
                    storedEngineMatches && genderAligned
                      ? info.voice!.name
                      : controller.activeEngine === 'edge'
                        ? defaultEdgeVoiceFor(controller.activeLang, info.gender, edgeList)
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
                      ? [...controller.geminiVoices].sort((a, b) => {
                          const aMatch = a.gender === info.gender ? 0 : 1;
                          const bMatch = b.gender === info.gender ? 0 : 1;
                          return aMatch - bMatch;
                        })
                      : controller.geminiVoices;

                  return (
                    <tr key={speakerId} className="hover:bg-white/[0.03] transition-colors">
                      <td className="py-2.5 px-4">
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
                      <td className="py-2.5 px-4">
                        <select
                          disabled={controller.savingSpeakerId === speakerId}
                          value={info.gender}
                          onChange={(e) =>
                            void controller.handleSpeakerGenderChange(
                              speakerId,
                              e.target.value as Gender,
                            )
                          }
                          className="px-2.5 py-1.5 bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 text-xs focus:outline-none focus:border-cyan-400/70"
                        >
                          <option value="female">{t.workbench.genderFemale}</option>
                          <option value="male">{t.workbench.genderMale}</option>
                          <option value="unknown">{t.workbench.genderUnknown}</option>
                        </select>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="inline-flex items-center gap-2">
                          <select
                            disabled={controller.savingVoiceSpk === speakerId}
                            value={currentVoice}
                            onChange={(e) =>
                              void controller.handleAssignVoice(speakerId, e.target.value)
                            }
                            className="px-2.5 py-1.5 bg-[#131A2A] border border-white/10 rounded-lg text-slate-100 text-xs max-w-[300px] focus:outline-none focus:border-cyan-400/70"
                          >
                            {controller.activeEngine === 'edge' ? (
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
                          {controller.savingVoiceSpk === speakerId && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          disabled={controller.previewingSpk === speakerId}
                          onClick={() => void controller.handlePreviewVoice(speakerId, currentVoice)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#131A2A] border border-white/10 rounded-lg text-slate-200 hover:border-cyan-400/50 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                        >
                          {controller.previewingSpk === speakerId ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Volume2 className="w-3 h-3 text-cyan-400" />
                          )}
                          {controller.previewingSpk === speakerId
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
    </div>
  );
};
