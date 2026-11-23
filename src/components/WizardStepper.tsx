import React from 'react';
import { Check, Loader2, Lock } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

export type WizardStepId = 1 | 2 | 3 | 4 | 5;

export interface WizardStepMeta {
  id: WizardStepId;
  title: string;
  subtitle: string;
  completed: boolean;
  unlocked: boolean;
  running?: boolean;
  error?: boolean;
}

interface WizardStepperProps {
  activeStep: WizardStepId;
  steps: WizardStepMeta[];
  onSelectStep: (step: WizardStepId) => void;
}

export const WizardStepper: React.FC<WizardStepperProps> = ({
  activeStep,
  steps,
  onSelectStep,
}) => {
  const { t, lang } = useI18n();

  return (
    <div className="border-b border-white/[0.06] bg-[#0B0F19] px-4 md:px-6 py-3">
      <nav
        aria-label="Workflow steps"
        className="max-w-[1440px] mx-auto flex items-stretch gap-2.5 overflow-x-auto pb-0.5"
      >
        {steps.map((step) => {
          const isActive = step.id === activeStep;
          const canClick = step.unlocked || step.completed || isActive;
          const isDone = step.completed && !step.running;
          const number = String(step.id).padStart(2, '0');

          return (
            <button
              key={step.id}
              type="button"
              disabled={!canClick}
              title={!canClick ? t.wizard.lockedStepHint : step.title}
              onClick={() => canClick && onSelectStep(step.id)}
              className={`group relative flex-1 min-w-[190px] flex items-center gap-3 px-3.5 py-2.5 rounded-xl border text-left transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-cyan-500/15 to-indigo-500/10 border-cyan-400/60 text-white shadow-[0_0_20px_rgba(6,182,212,0.18)] ring-1 ring-cyan-400/40 cursor-pointer'
                  : isDone
                    ? 'bg-[#131A2A] border-emerald-500/25 text-slate-200 hover:border-emerald-400/45 cursor-pointer'
                    : canClick
                      ? 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-200 hover:border-white/20 hover:bg-[#172033] cursor-pointer'
                      : 'bg-[#131A2A]/45 border-white/[0.05] text-slate-500 cursor-not-allowed opacity-60'
              }`}
            >
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-mono font-semibold shrink-0 tabular-nums border transition-all ${
                  step.error
                    ? 'bg-red-950/80 border-red-500/60 text-red-300'
                    : step.running
                      ? 'bg-cyan-950/80 border-cyan-400 text-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.45)]'
                      : isDone
                        ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.45)]'
                        : isActive
                          ? 'bg-cyan-500 border-cyan-400 text-slate-950 shadow-[0_0_12px_rgba(6,182,212,0.5)]'
                          : 'bg-[#0E1422] border-white/10 text-slate-500'
                }`}
              >
                {step.running ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : isDone && !isActive ? (
                  <Check className="w-4 h-4" />
                ) : (
                  number
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">{number}</span>
                  <span
                    className={`text-xs font-semibold truncate leading-snug ${
                      isActive ? 'text-white' : canClick ? 'text-slate-100' : 'text-slate-500'
                    }`}
                  >
                    {step.title}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 truncate leading-snug">
                  {step.subtitle}
                </div>
              </div>

              {isDone && (
                <span className="hidden xl:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/40 text-[10px] font-medium text-emerald-300 whitespace-nowrap shrink-0">
                  <Check className="w-3 h-3" />
                  {lang === 'my' ? 'ပြီးစီး' : 'Completed'}
                </span>
              )}
              {!canClick && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[#0E1422] border border-white/[0.08] text-slate-500 shrink-0">
                  <Lock className="w-3 h-3" />
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
};
