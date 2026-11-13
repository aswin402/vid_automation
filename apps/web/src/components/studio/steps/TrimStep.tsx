import React, { useState } from 'react';
import {
  Scissors,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  Clock,
} from 'lucide-react';
import {
  formatFriendlyDuration,
  formatTimecode,
  parseTimecodeToMs,
} from '@/lib/timecode';
import { InteractiveVideoPreview } from '../InteractiveVideoPreview';
import type { Asset, EditSettings, SubtitleCue } from '@/types/video';

interface TrimStepProps {
  sourceAsset: Asset | undefined;
  logoAsset: Asset | undefined;
  settings: EditSettings;
  cues: SubtitleCue[];
  currentTimeMs: number;
  onTimeUpdate: (ms: number) => void;
  onUpdateSettings: (updater: (prev: EditSettings) => EditSettings) => void;
  onSaveSettings: () => Promise<void>;
  onBack: () => void;
  onNext: () => void;
}

export const TrimStep: React.FC<TrimStepProps> = ({
  sourceAsset,
  logoAsset,
  settings,
  cues,
  currentTimeMs,
  onTimeUpdate,
  onUpdateSettings,
  onSaveSettings,
  onBack,
  onNext,
}) => {
  const sourceDurationMs = sourceAsset?.duration_ms || 10000;
  const startMs = settings.trim.start_ms || 0;
  const endMs = settings.trim.end_ms ?? sourceDurationMs;

  const [editingStartText, setEditingStartText] = useState<string | null>(null);
  const [editingEndText, setEditingEndText] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);

  const startText = editingStartText ?? formatTimecode(startMs);
  const endText = editingEndText ?? formatTimecode(endMs);

  const applyTrimRange = (newStart: number, newEnd: number) => {
    if (newStart < 0) {
      setValidationError('Start time cannot be negative.');
      return;
    }
    if (newEnd <= newStart) {
      setValidationError('The end time must be later than the start time.');
      return;
    }
    if (newEnd > sourceDurationMs) {
      setValidationError(
        `The selected end time is longer than the uploaded video (${formatTimecode(sourceDurationMs)}).`
      );
      return;
    }
    if (newEnd - newStart < 200) {
      setValidationError('Selected clip must be at least 0.2 seconds long.');
      return;
    }
    setValidationError(null);
    onUpdateSettings((prev) => ({
      ...prev,
      trim: {
        start_ms: Math.round(newStart),
        end_ms: Math.round(newEnd),
      },
    }));
  };

  const handleContinue = async () => {
    if (validationError) return;
    setSaving(true);
    try {
      await onSaveSettings();
      onNext();
    } finally {
      setSaving(false);
    }
  };

  const selectedDurationMs = Math.max(0, endMs - startMs);
  const startPct = Math.min(100, Math.max(0, (startMs / sourceDurationMs) * 100));
  const endPct = Math.min(100, Math.max(0, (endMs / sourceDurationMs) * 100));

  const inspectorNode = (
    <div className="space-y-5 bg-card/70 border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <Scissors className="h-4 w-4 text-indigo-400" />
          Source Timeline Range
        </span>
        <button
          type="button"
          onClick={() => applyTrimRange(0, sourceDurationMs)}
          className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium"
        >
          <RotateCcw className="h-3 w-3" />
          Reset Full Clip
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2.5 rounded-xl bg-muted/40 border border-border p-3 text-center">
        <div>
          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
            Source Length
          </span>
          <span className="text-xs font-mono font-semibold">
            {formatFriendlyDuration(sourceDurationMs)}
          </span>
        </div>
        <div className="border-x border-border/60">
          <span className="block text-[10px] uppercase tracking-wider text-indigo-400">
            Selected Clip
          </span>
          <span className="text-xs font-mono font-bold text-indigo-400">
            {formatFriendlyDuration(selectedDurationMs)}
          </span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
            Resolution
          </span>
          <span className="text-xs font-mono font-semibold">
            {sourceAsset?.width || 1280}×{sourceAsset?.height || 720}
          </span>
        </div>
      </div>

      {/* Visual Range Bar & Sliders */}
      <div className="space-y-3">
        <div className="relative h-7 rounded-xl bg-muted border border-border overflow-hidden">
          <div
            className="absolute top-0 bottom-0 bg-indigo-500/30 border-x-2 border-indigo-400 transition-all"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(1, endPct - startPct)}%`,
            }}
          />
          <div className="absolute inset-0 flex items-center justify-between px-2.5 text-[10px] font-mono text-muted-foreground pointer-events-none">
            <span>00:00.000</span>
            <span>{formatTimecode(sourceDurationMs)}</span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">
            Start Handle ({formatTimecode(startMs)})
            <input
              type="range"
              min={0}
              max={Math.max(0, endMs - 200)}
              step={100}
              value={startMs}
              onChange={(e) => applyTrimRange(Number(e.target.value), endMs)}
              className="w-full accent-indigo-500 mt-1 block cursor-pointer"
            />
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            End Handle ({formatTimecode(endMs)})
            <input
              type="range"
              min={Math.min(sourceDurationMs, startMs + 200)}
              max={sourceDurationMs}
              step={100}
              value={endMs}
              onChange={(e) => applyTrimRange(startMs, Number(e.target.value))}
              className="w-full accent-indigo-500 mt-1 block cursor-pointer"
            />
          </label>
        </div>
      </div>

      {/* Exact Timestamp Inputs + Stepping Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-border">
        <div className="space-y-1.5">
          <label
            htmlFor="trim-start-input"
            className="block text-xs font-semibold text-foreground"
          >
            Start Timestamp (MM:SS.mmm)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="trim-start-input"
              type="text"
              value={startText}
              onChange={(e) => setEditingStartText(e.target.value)}
              onBlur={() => {
                const parsed = parseTimecodeToMs(startText);
                setEditingStartText(null);
                if (parsed === null) {
                  setValidationError('Invalid start timestamp format. Use MM:SS.mmm');
                } else {
                  applyTrimRange(parsed, endMs);
                }
              }}
              className="w-full rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyTrimRange(Math.max(0, startMs - 500), endMs)}
              className="px-2 py-1 rounded bg-muted hover:bg-muted/80 text-[11px] font-mono"
            >
              -0.5s
            </button>
            <button
              type="button"
              onClick={() =>
                applyTrimRange(Math.min(endMs - 200, startMs + 500), endMs)
              }
              className="px-2 py-1 rounded bg-muted hover:bg-muted/80 text-[11px] font-mono"
            >
              +0.5s
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="trim-end-input"
            className="block text-xs font-semibold text-foreground"
          >
            End Timestamp (MM:SS.mmm)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="trim-end-input"
              type="text"
              value={endText}
              onChange={(e) => setEditingEndText(e.target.value)}
              onBlur={() => {
                const parsed = parseTimecodeToMs(endText);
                setEditingEndText(null);
                if (parsed === null) {
                  setValidationError('Invalid end timestamp format. Use MM:SS.mmm');
                } else {
                  applyTrimRange(startMs, parsed);
                }
              }}
              className="w-full rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                applyTrimRange(startMs, Math.max(startMs + 200, endMs - 500))
              }
              className="px-2 py-1 rounded bg-muted hover:bg-muted/80 text-[11px] font-mono"
            >
              -0.5s
            </button>
            <button
              type="button"
              onClick={() =>
                applyTrimRange(startMs, Math.min(sourceDurationMs, endMs + 500))
              }
              className="px-2 py-1 rounded bg-muted hover:bg-muted/80 text-[11px] font-mono"
            >
              +0.5s
            </button>
          </div>
        </div>
      </div>

      {validationError && (
        <div
          role="alert"
          className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-xs text-rose-300 flex items-start gap-2"
        >
          <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{validationError}</span>
        </div>
      )}

      <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
        <Clock className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
        <span>
          Timestamps refer to the <strong>original uploaded video</strong>. The trimmed clip (
          {formatTimecode(selectedDurationMs)}) becomes the canonical 00:00.000 timeline for AI subtitles.
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">Step 2: Trim Selection</h2>
          <p className="text-xs text-muted-foreground">
            Select the exact start and end timestamps from your original uploaded video. We use frame-accurate re-encoding.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-border hover:bg-muted text-xs font-medium transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <button
            type="button"
            disabled={Boolean(validationError) || saving}
            onClick={handleContinue}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold transition-all shadow-sm"
          >
            {saving ? 'Saving...' : 'Continue to Frame & Crop'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7">
          <InteractiveVideoPreview
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={settings}
            cues={cues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={onTimeUpdate}
            fullscreenInspector={inspectorNode}
            onFullscreenChange={setIsPreviewFullscreen}
            onDragLogo={(xr, yr) =>
              onUpdateSettings((prev) => ({
                ...prev,
                logo: { ...prev.logo, enabled: true, x_ratio: xr, y_ratio: yr },
              }))
            }
            onDragSubtitle={(xr, yr) =>
              onUpdateSettings((prev) => ({
                ...prev,
                subtitles: {
                  ...prev.subtitles,
                  enabled: true,
                  style: { ...prev.subtitles.style, x_ratio: xr, y_ratio: yr },
                },
              }))
            }
          />
        </div>

        <div className="lg:col-span-5">{!isPreviewFullscreen && inspectorNode}</div>
      </div>
    </div>
  );
};
