import React, { createContext, useContext, useMemo, useState } from 'react';
import { en } from '../locales/en';
import { my, type LocaleMessages } from '../locales/my';

export type AppLang = 'my' | 'en';

interface I18nContextValue {
  lang: AppLang;
  setLang: (lang: AppLang) => void;
  t: LocaleMessages;
  localizeError: (raw: string | null | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = 'kinetix_ui_lang';

export function formatMsg(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<AppLang>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'my') return saved;
    } catch {
      // ignore storage failure
    }
    return 'my';
  });

  const setLang = (next: AppLang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage failure
    }
  };

  const value = useMemo<I18nContextValue>(() => {
    const t = lang === 'my' ? my : en;

    const localizeError = (raw: string | null | undefined): string => {
      if (!raw) return t.errors.genericFailed;
      const lower = raw.toLowerCase();
      let localized: string | null = null;
      if (
        (lower.includes('ffmpeg') || lower.includes('ffprobe')) &&
        (lower.includes('not found') || lower.includes('unavailable') || lower.includes('failed startup'))
      ) {
        localized = t.errors.ffmpegNotFound;
      } else if (
        lower.includes('disk space') ||
        lower.includes('insufficient') ||
        lower.includes('enospc')
      ) {
        localized = t.errors.notEnoughDisk;
      } else if (
        lower.includes('429') ||
        lower.includes('resource_exhausted') ||
        lower.includes('quota') ||
        lower.includes('rate limit')
      ) {
        localized = t.errors.geminiQuotaExceeded;
      } else if (
        lower.includes('gemini_api_key') &&
        (lower.includes('not set') || lower.includes('not configured') || lower.includes('missing'))
      ) {
        localized = t.errors.missingGeminiKey;
      } else if (lower.includes('rejected') || (lower.includes('invalid') && lower.includes('key'))) {
        localized = t.errors.invalidGeminiKey;
      } else if (
        lower.includes('server startup') ||
        lower.includes('server_startup_failed') ||
        lower.includes('/api/health')
      ) {
        localized = t.errors.serverStartupFailed;
      } else if (lower.includes('non-json') || /^\s*<!doctype|^\s*<html/i.test(raw)) {
        localized = t.errors.serverStartingRetry;
      } else if (
        lower.includes('interrupted') ||
        lower.includes('paused') ||
        lower.includes('abort') ||
        lower.includes('failed to fetch') ||
        lower.includes('network') ||
        (lower.includes('chunk') && lower.includes('failed'))
      ) {
        localized = t.errors.uploadInterrupted;
      }
      if (!localized) return raw;
      return localized.includes(raw) ? localized : `${localized}\n\n${raw}`;
    };

    return { lang, setLang, t, localizeError };
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used inside I18nProvider.');
  }
  return ctx;
}
