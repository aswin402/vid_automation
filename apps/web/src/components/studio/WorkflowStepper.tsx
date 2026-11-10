import React from 'react';
import {
  Upload,
  Scissors,
  Sliders,
  Volume2,
  Image as ImageIcon,
  Subtitles,
  Film,
  Sparkles,
  Check,
} from 'lucide-react';
import type { WorkflowStepId } from '@/types/video';

interface StepItem {
  id: WorkflowStepId;
  number: number;
  label: string;
  optional?: boolean;
  icon: React.ComponentType<{ className?: string }>;
}

export const WORKFLOW_STEPS: StepItem[] = [
  { id: 'upload', number: 1, label: 'Upload', icon: Upload },
  { id: 'trim', number: 2, label: 'Trim', icon: Scissors },
  { id: 'color', number: 3, label: 'Color Grade', optional: true, icon: Sliders },
  { id: 'audio', number: 4, label: 'Audio Clean', optional: true, icon: Volume2 },
  { id: 'logo', number: 5, label: 'Logo', optional: true, icon: ImageIcon },
  { id: 'subtitles', number: 6, label: 'Subtitles', optional: true, icon: Subtitles },
  { id: 'outro', number: 7, label: 'Outro', optional: true, icon: Film },
  { id: 'export', number: 8, label: 'Export', icon: Sparkles },
];

interface WorkflowStepperProps {
  activeStep: WorkflowStepId;
  hasSourceVideo: boolean;
  hasColorCorrection: boolean;
  hasAudioEnhancement: boolean;
  hasLogo: boolean;
  hasSubtitles: boolean;
  hasOutro: boolean;
  onSelectStep: (step: WorkflowStepId) => void;
}

export const WorkflowStepper: React.FC<WorkflowStepperProps> = ({
  activeStep,
  hasSourceVideo,
  hasColorCorrection,
  hasAudioEnhancement,
  hasLogo,
  hasSubtitles,
  hasOutro,
  onSelectStep,
}) => {
  const activeIdx = WORKFLOW_STEPS.findIndex((s) => s.id === activeStep);

  const stepCompletionMap: Record<WorkflowStepId, boolean> = {
    upload: hasSourceVideo,
    trim: hasSourceVideo,
    color: hasColorCorrection,
    audio: hasAudioEnhancement,
    logo: hasLogo,
    subtitles: hasSubtitles,
    outro: hasOutro,
    export: false,
  };

  return (
    <nav aria-label="Video editing workflow steps" className="w-full">
      <ol className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {WORKFLOW_STEPS.map((step, idx) => {
          const Icon = step.icon;
          const isActive = step.id === activeStep;
          const isPast = idx < activeIdx;
          const configured = stepCompletionMap[step.id];
          const disabled = step.id !== 'upload' && !hasSourceVideo;

          return (
            <li key={step.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelectStep(step.id)}
                aria-current={isActive ? 'step' : undefined}
                className={`w-full flex items-center gap-2 px-2.5 py-2.5 rounded-xl border text-left transition-all ${
                  isActive
                    ? 'bg-indigo-600/15 border-indigo-500 text-foreground shadow-sm ring-1 ring-indigo-500/40'
                    : disabled
                    ? 'bg-muted/30 border-border/40 text-muted-foreground/40 cursor-not-allowed'
                    : isPast || configured
                    ? 'bg-card/80 border-border hover:border-indigo-500/50 text-foreground'
                    : 'bg-card/40 border-border/60 hover:border-border text-muted-foreground'
                }`}
              >
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold transition-colors ${
                    isActive
                      ? 'bg-indigo-600 text-white'
                      : configured
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {configured && !isActive ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-semibold truncate">
                      {step.number}. {step.label}
                    </span>
                  </div>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {step.optional
                      ? configured
                        ? 'Enabled'
                        : 'Optional'
                      : configured
                      ? 'Ready'
                      : 'Required'}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
