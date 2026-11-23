import React from 'react';
import { FolderKanban, Settings } from 'lucide-react';
import type { Project } from '../../shared/projectTypes';
import { useI18n } from '../i18n/I18nContext';

interface TopBarProps {
  activeProject: Project | null;
  hasSystemWarning: boolean;
  onGoHome: () => void;
  onOpenSettings: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeProject,
  hasSystemWarning,
  onGoHome,
  onOpenSettings,
}) => {
  const { lang, setLang, t } = useI18n();

  return (
    <header className="h-14 border-b border-white/[0.06] bg-[#0B0F19]/95 backdrop-blur-md px-5 md:px-6 flex items-center justify-between gap-6 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onGoHome}
          className="inline-flex items-center gap-2.5 text-base font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0 cursor-pointer group"
        >
          <span className="relative">
            <img
              src="/logo.png"
              alt="creativebysaihtin"
              className="h-8 w-8 rounded-lg object-contain border border-white/10 bg-[#131A2A] shrink-0 transition-shadow group-hover:shadow-[0_0_16px_rgba(6,182,212,0.25)]"
            />
            <span
              aria-hidden="true"
              className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-cyan-400 border-2 border-[#0B0F19]"
            />
          </span>
          <span className="flex flex-col items-start leading-none">
            <span className="bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent font-bold tracking-tight">
              creativebysaihtin
            </span>
            <span className="mt-1 text-[10px] font-medium tracking-wide text-slate-500 uppercase">
              AI Video Dubbing &amp; Recap Studio
            </span>
          </span>
        </button>
      </div>

      <div className="hidden md:flex items-center gap-3 text-xs text-slate-400 min-w-0">
        {activeProject ? (
          <>
            <div className="flex items-center gap-2 min-w-0 truncate px-3 py-1 rounded-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)]">
              <span className="font-medium text-slate-200 truncate max-w-[240px]">
                {activeProject.title}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="whitespace-nowrap text-cyan-300">
                {activeProject.mode === 'recap' ? t.workbench.modeRecap : t.workbench.modeDubbing}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="font-mono whitespace-nowrap text-slate-300">
                {activeProject.target_langs.join(' + ')}
              </span>
            </div>
            <button
              type="button"
              onClick={onGoHome}
              className="inline-flex items-center gap-1.5 text-slate-300 hover:text-white hover:underline transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <FolderKanban className="w-3.5 h-3.5 text-cyan-400" />
              <span>{t.wizard.switchProjectBtn}</span>
            </button>
          </>
        ) : (
          <span className="truncate text-slate-400">{t.projects.title}</span>
        )}
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        <div className="flex items-center p-0.5 bg-[#0E1422] border border-white/[0.08] rounded-lg">
          <button
            type="button"
            onClick={() => setLang('my')}
            className={`px-2.5 py-1 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              lang === 'my'
                ? 'bg-cyan-500 text-slate-950 shadow-[0_0_20px_rgba(6,182,212,0.18)]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            MY
          </button>
          <button
            type="button"
            onClick={() => setLang('en')}
            className={`px-2.5 py-1 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              lang === 'en'
                ? 'bg-cyan-500 text-slate-950 shadow-[0_0_20px_rgba(6,182,212,0.18)]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            EN
          </button>
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            hasSystemWarning
              ? 'bg-amber-950/60 border-amber-500/40 text-amber-200 hover:bg-amber-900/60'
              : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-100 hover:border-cyan-400/50 hover:shadow-[0_0_14px_rgba(6,182,212,0.15)]'
          }`}
        >
          <Settings className="w-3.5 h-3.5 text-cyan-400" />
          <span>{t.wizard.settingsBtn}</span>
        </button>
      </div>
    </header>
  );
};
