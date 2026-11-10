import React, { useState } from 'react';
import {
  Sparkles,
  Plus,
  Trash2,
  Download,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Subtitles,
  Palette,
  Play,
} from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { formatTimecode, parseTimecodeToMs } from '@/lib/timecode';
import { InteractiveVideoPreview } from '../InteractiveVideoPreview';
import { PositionGridPicker } from '../PositionGridPicker';
import type {
  AnchorPosition,
  Asset,
  EditSettings,
  ProcessingJob,
  SubtitleCue,
} from '@/types/video';

interface SubtitlesStepProps {
  projectId: string;
  sourceAsset: Asset | undefined;
  logoAsset: Asset | undefined;
  settings: EditSettings;
  cues: SubtitleCue[];
  cuesDirty: boolean;
  subtitleVersion: number;
  detectedLanguage: string | null;
  allowedFonts: string[];
  supportedLanguages: Array<{ code: string; name: string }>;
  activeTranscribeJob: ProcessingJob | undefined;
  currentTimeMs: number;
  onTimeUpdate: (ms: number) => void;
  onUpdateSettings: (updater: (prev: EditSettings) => EditSettings) => void;
  onUpdateCues: (cues: SubtitleCue[], markDirty?: boolean) => void;
  onSaveSettings: () => Promise<void>;
  onSaveCues: () => Promise<void>;
  onTranscriptionStarted: (job: ProcessingJob) => void;
  onBack: () => void;
  onNext: () => void;
}

export const SubtitlesStep: React.FC<SubtitlesStepProps> = ({
  projectId,
  sourceAsset,
  logoAsset,
  settings,
  cues,
  cuesDirty,
  subtitleVersion,
  detectedLanguage,
  allowedFonts,
  supportedLanguages,
  activeTranscribeJob,
  currentTimeMs,
  onTimeUpdate,
  onUpdateSettings,
  onUpdateCues,
  onSaveSettings,
  onSaveCues,
  onTranscriptionStarted,
  onBack,
  onNext,
}) => {
  const [activeTab, setActiveTab] = useState<'cues' | 'style'>('cues');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const sourceDurationMs = sourceAsset?.duration_ms || 10000;
  const trimStartMs = settings.trim.start_ms || 0;
  const trimEndMs = settings.trim.end_ms ?? sourceDurationMs;
  const trimmedDurationMs = Math.max(200, trimEndMs - trimStartMs);

  const subCfg = settings.subtitles;
  const styleCfg = subCfg.style;

  const isTranscribing =
    activeTranscribeJob &&
    !['completed', 'failed', 'canceled'].includes(activeTranscribeJob.status);

  const handleGenerateSubtitles = async (forceOverwrite = false) => {
    if (cues.length > 0 && !forceOverwrite) {
      setConfirmRegenerate(true);
      return;
    }
    setConfirmRegenerate(false);
    setError(null);
    try {
      await onSaveSettings();
      const job = await videoApi.startTranscription(
        projectId,
        subCfg.language || 'auto',
        true
      );
      onTranscriptionStarted(job);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ||
          "We couldn't generate subtitles. Your video is safe; try again or continue without subtitles."
      );
    }
  };

  const handleAddCue = () => {
    const lastCue = cues[cues.length - 1];
    const nextStart = lastCue ? Math.min(trimmedDurationMs - 400, lastCue.end_ms + 100) : 0;
    const nextEnd = Math.min(trimmedDurationMs, nextStart + 1800);
    if (nextEnd <= nextStart) {
      setError('No remaining timeline space at the end of the clip for a new cue.');
      return;
    }
    setError(null);
    const updated: SubtitleCue[] = [
      ...cues,
      {
        sequence: cues.length + 1,
        start_ms: Math.max(0, nextStart),
        end_ms: nextEnd,
        text: 'New subtitle line',
      },
    ];
    onUpdateCues(updated, true);
    onUpdateSettings((prev) => ({
      ...prev,
      subtitles: { ...prev.subtitles, enabled: true },
    }));
  };

  const handleDeleteCue = (index: number) => {
    const updated = cues.filter((_, idx) => idx !== index);
    onUpdateCues(updated, true);
  };

  const handleCueChange = (index: number, patch: Partial<SubtitleCue>) => {
    const updated = cues.map((item, idx) => (idx === index ? { ...item, ...patch } : item));
    onUpdateCues(updated, true);
  };

  const validateLocalCues = (): string | null => {
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (!c.text.trim()) return `Cue #${i + 1} cannot have empty text.`;
      if (c.start_ms < 0) return `Cue #${i + 1} start time cannot be negative.`;
      if (c.end_ms <= c.start_ms)
        return `Cue #${i + 1} end time must be greater than start time.`;
      if (c.end_ms > trimmedDurationMs)
        return `Cue #${i + 1} end time (${formatTimecode(
          c.end_ms
        )}) exceeds trimmed clip duration (${formatTimecode(trimmedDurationMs)}).`;
      if (i > 0 && c.start_ms < cues[i - 1].end_ms) {
        return `Cue #${i + 1} overlaps with Cue #${i}. Adjust timestamps so cues do not overlap.`;
      }
    }
    return null;
  };

  const localCueError = validateLocalCues();

  const handleSaveAll = async (proceedAfter = false) => {
    if (localCueError) {
      setError(localCueError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (cuesDirty || cues.length > 0) {
        await onSaveCues();
      }
      await onSaveSettings();
      if (proceedAfter) onNext();
    } catch (err: any) {
      setError(
        err?.response?.data?.message || 'Failed to save subtitle cues or styling.'
      );
    } finally {
      setSaving(false);
    }
  };

  const resetStyleDefaults = () => {
    onUpdateSettings((prev) => ({
      ...prev,
      subtitles: {
        ...prev.subtitles,
        style: {
          position: 'bottom-center',
          x_ratio: null,
          y_ratio: null,
          font_family: allowedFonts[0] || 'DejaVu Sans',
          font_size: 42,
          text_color: '#FFFFFF',
          background_enabled: false,
          background_color: '#000000',
          background_opacity: 0.65,
          outline_enabled: true,
          outline_color: '#000000',
          outline_thickness: 3,
          shadow_enabled: true,
          shadow_depth: 2,
          alignment: 'center',
          margin_v_ratio: 0.06,
          margin_h_ratio: 0.05,
        },
      },
    }));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">
            Step 5: AI Subtitles, Review & Styling (Optional)
          </h2>
          <p className="text-xs text-muted-foreground">
            AI-generated subtitles can contain mistakes. You can review, edit timestamps, and customize ASS styling before export.
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
            disabled={saving || Boolean(isTranscribing)}
            onClick={() => handleSaveAll(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold transition-all shadow-sm"
          >
            {saving ? 'Saving...' : 'Continue to Outro'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Top AI Generation Bar */}
      <div className="rounded-2xl bg-card/80 border border-border p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={subCfg.enabled}
              onChange={(e) =>
                onUpdateSettings((prev) => ({
                  ...prev,
                  subtitles: { ...prev.subtitles, enabled: e.target.checked },
                }))
              }
              className="h-4 w-4 rounded accent-indigo-600"
            />
            <span className="text-sm font-semibold">Enable Burned-In Subtitles</span>
          </label>

          <div className="flex items-center gap-2">
            <label htmlFor="sub-lang-select" className="text-xs text-muted-foreground">
              Language:
            </label>
            <select
              id="sub-lang-select"
              value={subCfg.language || 'auto'}
              onChange={(e) =>
                onUpdateSettings((prev) => ({
                  ...prev,
                  subtitles: { ...prev.subtitles, language: e.target.value },
                }))
              }
              className="rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {supportedLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
          </div>

          {subtitleVersion > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              <CheckCircle2 className="h-3.5 w-3.5" />
              v{subtitleVersion} · {cues.length} cues ({detectedLanguage || 'en'})
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {subtitleVersion > 0 && cues.length > 0 && (
            <a
              href={`/api/v1/projects/${projectId}/subtitle-versions/${subtitleVersion}/srt`}
              download={`subtitles_v${subtitleVersion}.srt`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border hover:bg-muted text-xs font-medium transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Export .SRT
            </a>
          )}

          <button
            type="button"
            disabled={Boolean(isTranscribing)}
            onClick={() => handleGenerateSubtitles(false)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 text-xs font-semibold transition-all cursor-pointer"
          >
            {isTranscribing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Transcribing ({activeTranscribeJob?.stage})...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                {cues.length > 0 ? 'Regenerate AI Subtitles' : 'Generate AI Subtitles'}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Overwrite Confirmation Dialog Banner */}
      {confirmRegenerate && (
        <div
          role="alertdialog"
          aria-labelledby="regen-confirm-title"
          className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="text-xs text-amber-200">
            <strong id="regen-confirm-title" className="block font-semibold text-amber-300">
              Overwrite current subtitle cues?
            </strong>
            Regenerating AI subtitles will create a new version and replace your current cue list.
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmRegenerate(false)}
              className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleGenerateSubtitles(true)}
              className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold"
            >
              Confirm Regenerate
            </button>
          </div>
        </div>
      )}

      {(error || localCueError || activeTranscribeJob?.status === 'failed') && (
        <div
          role="alert"
          className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3.5 text-xs text-rose-300 flex items-start gap-2"
        >
          <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
          <span>
            {error ||
              localCueError ||
              activeTranscribeJob?.error_message_safe ||
              'Subtitle validation failed.'}
          </span>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-6">
          <InteractiveVideoPreview
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={settings}
            cues={cues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={onTimeUpdate}
            dragMode="subtitles"
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
                  style: {
                    ...prev.subtitles.style,
                    x_ratio: xr,
                    y_ratio: yr,
                  },
                },
              }))
            }
          />
        </div>

        <div className="lg:col-span-6 bg-card/70 border border-border rounded-2xl overflow-hidden">
          {/* Panel Tabs */}
          <div className="grid grid-cols-2 border-b border-border bg-muted/40">
            <button
              type="button"
              onClick={() => setActiveTab('cues')}
              className={`py-3 px-4 text-xs font-semibold flex items-center justify-center gap-2 border-b-2 transition-colors ${
                activeTab === 'cues'
                  ? 'border-indigo-500 text-foreground bg-card'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Subtitles className="h-4 w-4 text-indigo-400" />
              Cue Editor ({cues.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('style')}
              className={`py-3 px-4 text-xs font-semibold flex items-center justify-center gap-2 border-b-2 transition-colors ${
                activeTab === 'style'
                  ? 'border-indigo-500 text-foreground bg-card'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Palette className="h-4 w-4 text-indigo-400" />
              ASS Style & Placement
            </button>
          </div>

          {activeTab === 'cues' ? (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Canonical timeline: <strong className="font-mono text-foreground">00:00.000</strong> to{' '}
                  <strong className="font-mono text-foreground">
                    {formatTimecode(trimmedDurationMs)}
                  </strong>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleAddCue}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-semibold"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Cue
                  </button>
                  {cuesDirty && (
                    <button
                      type="button"
                      disabled={saving || Boolean(localCueError)}
                      onClick={() => handleSaveAll(false)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                    >
                      Save Edits
                    </button>
                  )}
                </div>
              </div>

              {cues.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-8 text-center space-y-2">
                  <Subtitles className="h-7 w-7 text-muted-foreground mx-auto" />
                  <p className="text-xs font-medium text-foreground">No subtitle cues yet</p>
                  <p className="text-xs text-muted-foreground">
                    Click <strong>Generate AI Subtitles</strong> above to transcribe your trimmed clip, or click <strong>Add Cue</strong> to write captions manually.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                  {cues.map((cue, idx) => {
                    const isCurrent =
                      currentTimeMs >= cue.start_ms && currentTimeMs <= cue.end_ms;
                    return (
                      <div
                        key={`${cue.sequence}-${idx}`}
                        className={`rounded-xl border p-3 space-y-2 transition-colors ${
                          isCurrent
                            ? 'bg-indigo-600/10 border-indigo-500/60'
                            : 'bg-background/60 border-border'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onTimeUpdate(cue.start_ms)}
                              title="Seek preview to cue start"
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[11px] font-mono font-semibold hover:bg-indigo-500/30"
                            >
                              <Play className="h-2.5 w-2.5" />#{idx + 1}
                            </button>

                            <label className="text-[11px] text-muted-foreground flex items-center gap-1">
                              Start:
                              <input
                                type="text"
                                aria-label={`Cue ${idx + 1} start time`}
                                defaultValue={formatTimecode(cue.start_ms)}
                                key={`start-${idx}-${cue.start_ms}`}
                                onBlur={(e) => {
                                  const ms = parseTimecodeToMs(e.target.value);
                                  if (ms !== null) handleCueChange(idx, { start_ms: ms });
                                }}
                                className="w-24 rounded bg-card border border-border px-1.5 py-0.5 font-mono text-xs text-foreground"
                              />
                            </label>

                            <label className="text-[11px] text-muted-foreground flex items-center gap-1">
                              End:
                              <input
                                type="text"
                                aria-label={`Cue ${idx + 1} end time`}
                                defaultValue={formatTimecode(cue.end_ms)}
                                key={`end-${idx}-${cue.end_ms}`}
                                onBlur={(e) => {
                                  const ms = parseTimecodeToMs(e.target.value);
                                  if (ms !== null) handleCueChange(idx, { end_ms: ms });
                                }}
                                className="w-24 rounded bg-card border border-border px-1.5 py-0.5 font-mono text-xs text-foreground"
                              />
                            </label>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleDeleteCue(idx)}
                            aria-label={`Delete cue ${idx + 1}`}
                            className="text-muted-foreground hover:text-rose-400 p-1 rounded transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <textarea
                          rows={2}
                          aria-label={`Cue ${idx + 1} text`}
                          value={cue.text}
                          onChange={(e) => handleCueChange(idx, { text: e.target.value })}
                          className="w-full rounded-lg bg-card border border-border px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* ASS Style & Position Tab */
            <div className="p-4 space-y-4 max-h-[430px] overflow-y-auto">
              <div className="flex items-center justify-between">
                <PositionGridPicker
                  label="9-Position Preset (or drag subtitle in preview)"
                  value={styleCfg.position}
                  customCoordinatesActive={
                    styleCfg.x_ratio !== null && styleCfg.y_ratio !== null
                  }
                  onChange={(pos: AnchorPosition) =>
                    onUpdateSettings((prev) => ({
                      ...prev,
                      subtitles: {
                        ...prev.subtitles,
                        style: {
                          ...prev.subtitles.style,
                          position: pos,
                          x_ratio: null,
                          y_ratio: null,
                        },
                      },
                    }))
                  }
                />

                <button
                  type="button"
                  onClick={resetStyleDefaults}
                  className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium self-start"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset Style
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border">
                <div>
                  <label
                    htmlFor="sub-font-family"
                    className="block text-xs font-medium text-muted-foreground mb-1"
                  >
                    Font Family (Server Allowlist)
                  </label>
                  <select
                    id="sub-font-family"
                    value={styleCfg.font_family}
                    onChange={(e) =>
                      onUpdateSettings((prev) => ({
                        ...prev,
                        subtitles: {
                          ...prev.subtitles,
                          style: { ...prev.subtitles.style, font_family: e.target.value },
                        },
                      }))
                    }
                    className="w-full rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs"
                  >
                    {allowedFonts.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground font-medium">Font Size (1080p ref)</span>
                    <span className="font-mono text-indigo-400">{styleCfg.font_size}px</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={84}
                    step={2}
                    value={styleCfg.font_size}
                    onChange={(e) =>
                      onUpdateSettings((prev) => ({
                        ...prev,
                        subtitles: {
                          ...prev.subtitles,
                          style: {
                            ...prev.subtitles.style,
                            font_size: Number(e.target.value),
                          },
                        },
                      }))
                    }
                    className="w-full accent-indigo-500 mt-1.5"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-border">
                <label className="block text-xs font-medium text-muted-foreground">
                  Text Color
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="color"
                      value={styleCfg.text_color}
                      onChange={(e) =>
                        onUpdateSettings((prev) => ({
                          ...prev,
                          subtitles: {
                            ...prev.subtitles,
                            style: { ...prev.subtitles.style, text_color: e.target.value },
                          },
                        }))
                      }
                      className="h-7 w-10 rounded cursor-pointer border border-border bg-transparent"
                    />
                    <span className="font-mono text-[11px]">{styleCfg.text_color}</span>
                  </div>
                </label>

                <label className="block text-xs font-medium text-muted-foreground">
                  Outline Color
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="color"
                      value={styleCfg.outline_color}
                      onChange={(e) =>
                        onUpdateSettings((prev) => ({
                          ...prev,
                          subtitles: {
                            ...prev.subtitles,
                            style: {
                              ...prev.subtitles.style,
                              outline_color: e.target.value,
                            },
                          },
                        }))
                      }
                      className="h-7 w-10 rounded cursor-pointer border border-border bg-transparent"
                    />
                    <span className="font-mono text-[11px]">{styleCfg.outline_color}</span>
                  </div>
                </label>

                <label className="block text-xs font-medium text-muted-foreground">
                  Text Alignment
                  <select
                    value={styleCfg.alignment}
                    onChange={(e) =>
                      onUpdateSettings((prev) => ({
                        ...prev,
                        subtitles: {
                          ...prev.subtitles,
                          style: {
                            ...prev.subtitles.style,
                            alignment: e.target.value as 'left' | 'center' | 'right',
                          },
                        },
                      }))
                    }
                    className="w-full rounded-lg bg-background border border-border px-2 py-1.5 text-xs mt-1"
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </label>
              </div>

              {/* Background Box, Outline & Shadow Toggles */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border">
                <div className="rounded-xl bg-background/50 border border-border p-3 space-y-2">
                  <label className="inline-flex items-center gap-2 cursor-pointer text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={styleCfg.background_enabled}
                      onChange={(e) =>
                        onUpdateSettings((prev) => ({
                          ...prev,
                          subtitles: {
                            ...prev.subtitles,
                            style: {
                              ...prev.subtitles.style,
                              background_enabled: e.target.checked,
                            },
                          },
                        }))
                      }
                      className="rounded accent-indigo-600"
                    />
                    Background Box (ASS BorderStyle 3)
                  </label>
                  {styleCfg.background_enabled && (
                    <div className="flex items-center gap-3 pt-1">
                      <input
                        type="color"
                        value={styleCfg.background_color}
                        onChange={(e) =>
                          onUpdateSettings((prev) => ({
                            ...prev,
                            subtitles: {
                              ...prev.subtitles,
                              style: {
                                ...prev.subtitles.style,
                                background_color: e.target.value,
                              },
                            },
                          }))
                        }
                        className="h-6 w-8 rounded border border-border"
                      />
                      <input
                        type="range"
                        min={0.1}
                        max={1.0}
                        step={0.05}
                        value={styleCfg.background_opacity}
                        onChange={(e) =>
                          onUpdateSettings((prev) => ({
                            ...prev,
                            subtitles: {
                              ...prev.subtitles,
                              style: {
                                ...prev.subtitles.style,
                                background_opacity: Number(e.target.value),
                              },
                            },
                          }))
                        }
                        className="flex-1 accent-indigo-500"
                      />
                      <span className="text-[11px] font-mono">
                        {Math.round(styleCfg.background_opacity * 100)}%
                      </span>
                    </div>
                  )}
                </div>

                <div className="rounded-xl bg-background/50 border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="inline-flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={styleCfg.outline_enabled}
                        onChange={(e) =>
                          onUpdateSettings((prev) => ({
                            ...prev,
                            subtitles: {
                              ...prev.subtitles,
                              style: {
                                ...prev.subtitles.style,
                                outline_enabled: e.target.checked,
                              },
                            },
                          }))
                        }
                        className="rounded accent-indigo-600"
                      />
                      Outline ({styleCfg.outline_thickness}px)
                    </label>

                    <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={styleCfg.shadow_enabled}
                        onChange={(e) =>
                          onUpdateSettings((prev) => ({
                            ...prev,
                            subtitles: {
                              ...prev.subtitles,
                              style: {
                                ...prev.subtitles.style,
                                sibling: undefined,
                                shadow_enabled: e.target.checked,
                              },
                            },
                          }))
                        }
                        className="rounded accent-indigo-600"
                      />
                      Shadow
                    </label>
                  </div>

                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={1}
                    disabled={!styleCfg.outline_enabled}
                    value={styleCfg.outline_thickness}
                    onChange={(e) =>
                      onUpdateSettings((prev) => ({
                        ...prev,
                        subtitles: {
                          ...prev.subtitles,
                          style: {
                            ...prev.subtitles.style,
                            outline_thickness: Number(e.target.value),
                          },
                        },
                      }))
                    }
                    className="w-full accent-indigo-500"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
