import React, { useState } from 'react';
import {
  Sparkles,
  Download,
  RotateCcw,
  XCircle,
  CheckCircle2,
  Loader2,
  ArrowLeft,
  Scissors,
  Crop,
  Palette,
  Volume2,
  Image as ImageIcon,
  Subtitles,
  Film,
  ShieldCheck,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react';
import { extractApiError, videoApi } from '@/api/videoApi';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Slider } from '@/components/ui/slider';
import { HintTooltip } from '@/components/ui/tooltip';
import { resolveTargetOutputDimensions } from '@/lib/cropMath';
import { formatBytes, formatFriendlyDuration, formatTimecode } from '@/lib/timecode';
import type {
  Asset,
  EditSettings,
  OutputSettings,
  ProcessingJob,
  SubtitleCue,
} from '@/types/video';

const PIPELINE_STAGES = [
  { key: 'queued', label: 'Queued' },
  { key: 'validating', label: 'Validate' },
  { key: 'probing', label: 'Probe' },
  { key: 'trimming', label: 'Trim' },
  { key: 'rendering_main', label: 'Render' },
  { key: 'normalizing_outro', label: 'Outro Prep' },
  { key: 'joining_outro', label: 'Concat' },
  { key: 'validating_output', label: 'Verify' },
  { key: 'uploading_output', label: 'Publish' },
  { key: 'completed', label: 'Done' },
];

const RESOLUTION_PRESETS = [
  { label: 'Auto', width: null, height: null, hint: 'Match source / aspect ratio canvas' },
  { label: '720p', width: 1280, height: 720, hint: 'HD 1280×720 (or 720×1280 portrait)' },
  { label: '1080p', width: 1920, height: 1080, hint: 'Full HD 1920×1080 (or 1080×1920 portrait)' },
  { label: '4K', width: 3840, height: 2160, hint: 'Ultra HD 3840×2160 (or 2160×3840 portrait)' },
] as const;

const FPS_PRESETS: Array<{ label: string; value: number | null; hint: string }> = [
  { label: 'Source', value: null, hint: 'Preserve original source frame rate' },
  { label: '24', value: 24, hint: '24 fps cinematic cadence' },
  { label: '30', value: 30, hint: '30 fps social & web standard' },
  { label: '60', value: 60, hint: '60 fps high-motion playback' },
];

const ENCODER_PRESETS: Array<{ value: OutputSettings['preset']; label: string; hint: string }> = [
  { value: 'ultrafast', label: 'Draft', hint: 'Fastest render speed (larger file)' },
  { value: 'fast', label: 'Fast', hint: 'Quick render with balanced compression' },
  { value: 'medium', label: 'Balanced', hint: 'Recommended H.264 quality/speed balance' },
  { value: 'slow', label: 'Max Quality', hint: 'Best compression efficiency (slower render)' },
];

interface ReviewExportStepProps {
  projectId: string;
  sourceAsset: Asset | undefined;
  logoAsset: Asset | undefined;
  outroAsset: Asset | undefined;
  outputAsset: Asset | undefined;
  settings: EditSettings;
  cues: SubtitleCue[];
  subtitleVersion: number;
  detectedLanguage: string | null;
  latestExportJob: ProcessingJob | undefined;
  onUpdateSettings?: (updater: (prev: EditSettings) => EditSettings) => void;
  onFlushBeforeExport: () => Promise<number>;
  onJobUpdated: () => void;
  onBack: () => void;
}

export const ReviewExportStep: React.FC<ReviewExportStepProps> = ({
  projectId,
  sourceAsset,
  logoAsset,
  outroAsset,
  outputAsset,
  settings,
  cues,
  subtitleVersion,
  detectedLanguage,
  latestExportJob,
  onUpdateSettings,
  onFlushBeforeExport,
  onJobUpdated,
  onBack,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceDurationMs = sourceAsset?.duration_ms || 0;
  const trimStartMs = settings.trim.start_ms || 0;
  const trimEndMs = settings.trim.end_ms ?? sourceDurationMs;
  const mainDurationMs = Math.max(0, trimEndMs - trimStartMs);
  const outroDurationMs =
    settings.outro.enabled && outroAsset?.duration_ms ? outroAsset.duration_ms : 0;
  const totalExpectedMs = mainDurationMs + outroDurationMs;
  const targetOutDims = resolveTargetOutputDimensions(
    settings.crop,
    sourceAsset?.width || 1920,
    sourceAsset?.height || 1080,
    settings.output?.width,
    settings.output?.height
  );

  const outputCfg: OutputSettings = settings.output || {
    width: null,
    height: null,
    fps: null,
    video_codec: 'libx264',
    audio_codec: 'aac',
    crf: 20,
    preset: 'medium',
  };

  const isPortraitTarget = targetOutDims.height > targetOutDims.width;

  const updateOutput = (patch: Partial<OutputSettings>) => {
    if (!onUpdateSettings) return;
    onUpdateSettings((prev) => ({
      ...prev,
      output: {
        ...(prev.output || outputCfg),
        ...patch,
      },
    }));
  };

  const applyResolutionPreset = (baseW: number | null, baseH: number | null) => {
    if (baseW === null || baseH === null) {
      updateOutput({ width: null, height: null });
      return;
    }
    if (isPortraitTarget) {
      updateOutput({ width: baseH, height: baseW });
    } else if (targetOutDims.width === targetOutDims.height) {
      updateOutput({ width: baseH, height: baseH });
    } else {
      updateOutput({ width: baseW, height: baseH });
    }
  };

  const isRunning =
    latestExportJob &&
    !['completed', 'failed', 'canceled'].includes(latestExportJob.status);

  const handleStartExport = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const resolvedSubVersion = await onFlushBeforeExport();
      await videoApi.startExport(projectId, resolvedSubVersion || subtitleVersion || null);
      onJobUpdated();
    } catch (err: unknown) {
      setError(
        extractApiError(err, 'Failed to submit export job. Please verify settings.')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelJob = async () => {
    if (!latestExportJob) return;
    await videoApi.cancelJob(latestExportJob.id);
    onJobUpdated();
  };

  const handleRetryJob = async () => {
    if (!latestExportJob) return;
    await videoApi.retryJob(latestExportJob.id);
    onJobUpdated();
  };

  const handleDownloadOutput = async () => {
    if (!outputAsset) return;
    await videoApi.downloadOutputAsset(outputAsset.id, outputAsset.original_filename);
  };

  const currentStageIndex = latestExportJob
    ? PIPELINE_STAGES.findIndex((s) => s.key === latestExportJob.stage)
    : -1;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3.5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold tracking-tight">Output & Export</h2>
          <span className="px-2 py-0.5 rounded-md bg-secondary border border-border font-mono text-[11px] text-muted-foreground">
            {targetOutDims.width}×{targetOutDims.height} · {formatFriendlyDuration(totalExpectedMs)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <HintTooltip label="Back" detail="Return to previous editor tab">
            <Button type="button" variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
          </HintTooltip>
          <HintTooltip label="Export MP4" detail="Render final MP4 with current settings">
            <Button
              type="button"
              size="sm"
              disabled={!sourceAsset || submitting || Boolean(isRunning)}
              onClick={handleStartExport}
              className="px-5"
            >
              {isRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Rendering...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  {latestExportJob?.status === 'completed' ? 'Re-Export MP4' : 'Export MP4'}
                </>
              )}
            </Button>
          </HintTooltip>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-destructive/10 border border-destructive/30 p-3.5 text-xs text-destructive flex items-center gap-2"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Output Encoding Controls */}
      {onUpdateSettings && (
        <div className="rounded-xl bg-card border border-border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
              Encoding Profile
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              H.264 · AAC · CRF {outputCfg.crf} · {outputCfg.preset}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Resolution */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">Resolution</span>
              <div className="grid grid-cols-4 gap-1">
                {RESOLUTION_PRESETS.map((preset) => {
                  const isAuto =
                    preset.width === null &&
                    outputCfg.width === null &&
                    outputCfg.height === null;
                  const longEdge = Math.max(outputCfg.width || 0, outputCfg.height || 0);
                  const active = isAuto || (preset.width !== null && longEdge === preset.width);
                  return (
                    <HintTooltip key={preset.label} label={preset.label} detail={preset.hint}>
                      <button
                        type="button"
                        onClick={() => applyResolutionPreset(preset.width, preset.height)}
                        className={`h-7 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-secondary/60 border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {preset.label}
                      </button>
                    </HintTooltip>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                <NumberInput
                  size="sm"
                  allowEmpty
                  min={240}
                  max={7680}
                  step={2}
                  fallbackValue={targetOutDims.width}
                  placeholder={`W (${targetOutDims.width})`}
                  value={outputCfg.width ?? ''}
                  ariaLabel="Output width pixels"
                  onValueChange={(val) =>
                    updateOutput({
                      width: val !== null ? Math.max(240, Math.round(val / 2) * 2) : null,
                    })
                  }
                />
                <NumberInput
                  size="sm"
                  allowEmpty
                  min={240}
                  max={7680}
                  step={2}
                  fallbackValue={targetOutDims.height}
                  placeholder={`H (${targetOutDims.height})`}
                  value={outputCfg.height ?? ''}
                  ariaLabel="Output height pixels"
                  onValueChange={(val) =>
                    updateOutput({
                      height: val !== null ? Math.max(240, Math.round(val / 2) * 2) : null,
                    })
                  }
                />
              </div>
            </div>

            {/* Frame Rate */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">Frame Rate (FPS)</span>
              <div className="grid grid-cols-4 gap-1">
                {FPS_PRESETS.map((fps) => {
                  const active = (outputCfg.fps ?? null) === fps.value;
                  return (
                    <HintTooltip key={fps.label} label={`${fps.label} FPS`} detail={fps.hint}>
                      <button
                        type="button"
                        onClick={() => updateOutput({ fps: fps.value })}
                        className={`h-7 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-secondary/60 border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {fps.label}
                      </button>
                    </HintTooltip>
                  );
                })}
              </div>
            </div>

            {/* Quality (CRF) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <HintTooltip
                  label="Constant Rate Factor (CRF)"
                  detail="Lower CRF = higher visual quality & larger file (18 = lossless-like, 23 = compact)"
                >
                  <span className="font-medium text-muted-foreground cursor-help">
                    Quality (CRF)
                  </span>
                </HintTooltip>
                <span className="font-mono text-foreground">
                  {outputCfg.crf}{' '}
                  <span className="text-muted-foreground">
                    {outputCfg.crf <= 17
                      ? '(Ultra)'
                      : outputCfg.crf <= 21
                      ? '(High)'
                      : '(Compact)'}
                  </span>
                </span>
              </div>
              <Slider
                min={14}
                max={28}
                step={1}
                value={[outputCfg.crf]}
                onValueChange={([val]) => updateOutput({ crf: val })}
              />
            </div>

            {/* Encoder Speed */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">Encoder Speed</span>
              <div className="grid grid-cols-4 gap-1">
                {ENCODER_PRESETS.map((preset) => {
                  const active = outputCfg.preset === preset.value;
                  return (
                    <HintTooltip key={preset.value} label={preset.label} detail={preset.hint}>
                      <button
                        type="button"
                        onClick={() => updateOutput({ preset: preset.value })}
                        className={`h-7 rounded-md text-[10px] font-medium border transition-colors cursor-pointer truncate px-1 ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-secondary/60 border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {preset.label}
                      </button>
                    </HintTooltip>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compact Summary Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5">
        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Scissors className="h-3.5 w-3.5 text-primary" />
            Trim
          </div>
          <p className="text-xs font-mono font-medium text-foreground truncate">
            {formatTimecode(trimStartMs)}–{formatTimecode(trimEndMs)}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground">
            {formatFriendlyDuration(mainDurationMs)}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Crop className="h-3.5 w-3.5 text-primary" />
            Ratio & Face
          </div>
          <p className="text-xs font-medium text-foreground truncate">
            {settings.crop?.enabled ? settings.crop.aspect_ratio.toUpperCase() : 'Original'}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground truncate">
            {settings.crop?.enabled && settings.crop.auto_face_framing ? 'AI Face' : `${targetOutDims.width}×${targetOutDims.height}`}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Subtitles className="h-3.5 w-3.5 text-primary" />
            Subtitles
          </div>
          <p className="text-xs font-medium text-foreground truncate">
            {settings.subtitles.enabled && cues.length > 0 ? `${cues.length} cues` : 'Off'}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground truncate">
            {settings.subtitles.enabled && cues.length > 0
              ? `${detectedLanguage || settings.subtitles.language} · ${settings.subtitles.style.font_size}px`
              : 'Bypassed'}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Palette className="h-3.5 w-3.5 text-primary" />
            Color
          </div>
          <p className="text-xs font-medium text-foreground capitalize truncate">
            {settings.color_correction?.enabled ? settings.color_correction.preset : 'Off'}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground truncate">
            {settings.color_correction?.enabled
              ? `C ${settings.color_correction.contrast.toFixed(2)}× · S ${settings.color_correction.saturation.toFixed(2)}×`
              : 'Original'}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Volume2 className="h-3.5 w-3.5 text-primary" />
            Audio
          </div>
          <p className="text-xs font-medium text-foreground capitalize truncate">
            {settings.audio_enhancement?.enabled
              ? settings.audio_enhancement.preset.replace(/_/g, ' ')
              : 'Off'}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground truncate">
            {settings.audio_enhancement?.enabled
              ? `${Math.round(settings.audio_enhancement.noise_reduction * 100)}% NR`
              : 'Original'}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <ImageIcon className="h-3.5 w-3.5 text-primary" />
            Logo
          </div>
          <p className="text-xs font-medium text-foreground truncate">
            {settings.logo.enabled && logoAsset ? `${Math.round(settings.logo.width_ratio * 100)}% width` : 'Off'}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground truncate">
            {settings.logo.enabled && logoAsset
              ? settings.logo.x_ratio !== null
                ? 'Custom XY'
                : settings.logo.position
              : 'None'}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Film className="h-3.5 w-3.5 text-primary" />
            Outro
          </div>
          <p className="text-xs font-medium text-foreground truncate">
            {settings.outro.enabled && outroAsset
              ? `+${formatFriendlyDuration(outroDurationMs)}`
              : 'Off'}
          </p>
          <p className="text-[11px] font-mono text-muted-foreground truncate">
            Total {formatFriendlyDuration(totalExpectedMs)}
          </p>
        </div>
      </div>

      {/* Live Job Status & Output Player Panel */}
      {latestExportJob && (
        <div
          aria-live="polite"
          className="rounded-xl bg-card border border-border p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {latestExportJob.status === 'completed' ? (
                <div className="h-9 w-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center text-primary">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
              ) : latestExportJob.status === 'failed' ||
                latestExportJob.status === 'canceled' ? (
                <div className="h-9 w-9 rounded-lg bg-destructive/15 border border-destructive/30 flex items-center justify-center text-destructive">
                  <XCircle className="h-4 w-4" />
                </div>
              ) : (
                <div className="h-9 w-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center text-primary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                    {latestExportJob.stage.replace(/_/g, ' ')}
                  </h3>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    #{latestExportJob.id.slice(0, 8)}
                  </span>
                </div>
                {(latestExportJob.status === 'failed' || latestExportJob.status === 'canceled') && (
                  <p className="text-xs text-destructive mt-0.5">
                    {latestExportJob.error_message_safe || 'Export canceled or failed.'}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {isRunning && (
                <HintTooltip label="Cancel Export" detail="Abort active FFmpeg render">
                  <Button type="button" variant="outline" size="sm" onClick={handleCancelJob}>
                    <XCircle className="h-3.5 w-3.5 text-destructive" />
                    Cancel
                  </Button>
                </HintTooltip>
              )}

              {(latestExportJob.status === 'failed' ||
                latestExportJob.status === 'canceled') && (
                <HintTooltip label="Retry Export" detail="Re-run failed export job">
                  <Button type="button" size="sm" onClick={handleRetryJob}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </HintTooltip>
              )}

              {latestExportJob.status === 'completed' && outputAsset && (
                <HintTooltip label="Download MP4" detail="Save rendered MP4 to disk">
                  <Button type="button" size="sm" onClick={handleDownloadOutput}>
                    <Download className="h-3.5 w-3.5" />
                    Download MP4 ({formatBytes(outputAsset.size_bytes)})
                  </Button>
                </HintTooltip>
              )}
            </div>
          </div>

          {/* Stage Progress Pipeline Pills */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
            {PIPELINE_STAGES.map((stage, idx) => {
              const done =
                latestExportJob.status === 'completed' ||
                (currentStageIndex > idx && latestExportJob.status !== 'failed');
              const active =
                latestExportJob.stage === stage.key &&
                latestExportJob.status !== 'completed';
              return (
                <div
                  key={stage.key}
                  className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 ${
                    done
                      ? 'bg-secondary border-border text-foreground'
                      : active
                      ? 'bg-primary/15 border-primary text-primary'
                      : 'bg-background/50 border-border/60 text-muted-foreground'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      done
                        ? 'bg-primary'
                        : active
                        ? 'bg-primary animate-pulse'
                        : 'bg-muted-foreground/40'
                    }`}
                  />
                  <span className="truncate">{stage.label}</span>
                </div>
              );
            })}
          </div>

          {/* Completed Output Video Player & Verification Card */}
          {latestExportJob.status === 'completed' && outputAsset?.stream_url && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pt-3 border-t border-border items-center">
              <div className="lg:col-span-7">
                <video
                  key={`${outputAsset.id}-${outputAsset.checksum || ''}`}
                  src={outputAsset.stream_url}
                  crossOrigin="anonymous"
                  controls
                  playsInline
                  disablePictureInPicture
                  disableRemotePlayback
                  className="w-full max-h-[360px] rounded-xl bg-black border border-border object-contain"
                />
              </div>
              <div className="lg:col-span-5 space-y-2.5 bg-secondary/40 border border-border rounded-xl p-4">
                <div className="flex items-center gap-1.5 text-primary text-xs font-semibold">
                  <ShieldCheck className="h-4 w-4" />
                  Verified Output
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">File</span>
                    <span className="font-mono font-medium truncate">
                      {outputAsset.original_filename}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Duration</span>
                    <span className="font-mono font-semibold text-foreground">
                      {formatFriendlyDuration(outputAsset.duration_ms)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Resolution</span>
                    <span className="font-mono">
                      {outputAsset.width}×{outputAsset.height} @ {outputAsset.frame_rate} fps
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Codecs</span>
                    <span className="font-mono">
                      {outputAsset.video_codec} / {outputAsset.audio_codec || 'aac'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Size</span>
                    <span className="font-mono">{formatBytes(outputAsset.size_bytes)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
