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
  Palette,
  Image as ImageIcon,
  Subtitles,
  Film,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { formatBytes, formatFriendlyDuration, formatTimecode } from '@/lib/timecode';
import type {
  Asset,
  EditSettings,
  ProcessingJob,
  SubtitleCue,
} from '@/types/video';

const PIPELINE_STAGES = [
  { key: 'queued', label: 'Queued' },
  { key: 'validating', label: 'Validating Settings' },
  { key: 'probing', label: 'Probing Media (FFprobe)' },
  { key: 'trimming', label: 'Frame-Accurate Trim' },
  { key: 'rendering_main', label: 'Logo & ASS Subtitle Burn-in' },
  { key: 'normalizing_outro', label: 'Normalizing Outro' },
  { key: 'joining_outro', label: 'Concatenating Segments' },
  { key: 'validating_output', label: 'Output FFprobe Verification' },
  { key: 'uploading_output', label: 'Publishing Output' },
  { key: 'completed', label: 'Completed' },
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
    } catch (err: any) {
      setError(
        err?.response?.data?.message || 'Failed to submit export job. Please verify settings.'
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
    const { download_url } = await videoApi.getSignedDownloadUrl(outputAsset.id);
    window.open(download_url, '_blank', 'noopener,noreferrer');
  };

  const currentStageIndex = latestExportJob
    ? PIPELINE_STAGES.findIndex((s) => s.key === latestExportJob.stage)
    : -1;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">Step 7: Review Settings & Export MP4</h2>
          <p className="text-xs text-muted-foreground">
            Confirm your workflow configuration and launch an asynchronous FFmpeg export job.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-border hover:bg-muted text-xs font-medium transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Edit
          </button>
          <button
            type="button"
            disabled={!sourceAsset || submitting || Boolean(isRunning)}
            onClick={handleStartExport}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold transition-all shadow-md cursor-pointer"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing Export...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                {latestExportJob?.status === 'completed' ? 'Re-Export Video' : 'Start Export'}
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-4 text-xs text-rose-300 flex items-center gap-2"
        >
          <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Configuration Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="rounded-2xl bg-card/70 border border-border p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400">
            <Scissors className="h-4 w-4" />
            1. Source & Trim Range
          </div>
          <div className="text-xs space-y-1 text-muted-foreground">
            <p className="text-foreground font-medium truncate">
              {sourceAsset?.original_filename || 'None'}
            </p>
            <p>
              Interval:{' '}
              <span className="font-mono text-foreground">
                {formatTimecode(trimStartMs)} → {formatTimecode(trimEndMs)}
              </span>
            </p>
            <p>
              Clip Duration:{' '}
              <span className="font-mono font-semibold text-indigo-400">
                {formatFriendlyDuration(mainDurationMs)}
              </span>
            </p>
          </div>
        </div>

        <div className="rounded-2xl bg-card/70 border border-border p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400">
            <Palette className="h-4 w-4" />
            2. Color Grading
          </div>
          <div className="text-xs space-y-1 text-muted-foreground">
            <p className="text-foreground font-medium">
              {settings.color_correction?.enabled
                ? `Enabled (${settings.color_correction.preset})`
                : 'Original Colors (Bypassed)'}
            </p>
            {settings.color_correction?.enabled && (
              <>
                <p>
                  Contrast / Sat:{' '}
                  <span className="font-mono text-foreground">
                    {settings.color_correction.contrast.toFixed(2)}× ·{' '}
                    {settings.color_correction.saturation.toFixed(2)}×
                  </span>
                </p>
                <p>
                  WB / Sharpness:{' '}
                  <span className="font-mono text-foreground">
                    Temp {settings.color_correction.temperature >= 0 ? '+' : ''}
                    {Math.round(settings.color_correction.temperature * 100)} ·{' '}
                    {Math.round(settings.color_correction.sharpen * 100)}%
                  </span>
                </p>
              </>
            )}
          </div>
        </div>

        <div className="rounded-2xl bg-card/70 border border-border p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400">
            <ImageIcon className="h-4 w-4" />
            3. Brand Logo Overlay
          </div>
          <div className="text-xs space-y-1 text-muted-foreground">
            <p className="text-foreground font-medium">
              {settings.logo.enabled && logoAsset ? 'Enabled on Main Segment' : 'Disabled'}
            </p>
            {settings.logo.enabled && logoAsset && (
              <>
                <p>
                  Position:{' '}
                  <span className="font-mono text-foreground">
                    {settings.logo.x_ratio !== null
                      ? 'Custom Coordinates'
                      : settings.logo.position}
                  </span>
                </p>
                <p>
                  Scale / Opacity:{' '}
                  <span className="font-mono text-foreground">
                    {Math.round(settings.logo.width_ratio * 100)}% width ·{' '}
                    {Math.round(settings.logo.opacity * 100)}% alpha
                  </span>
                </p>
              </>
            )}
          </div>
        </div>

        <div className="rounded-2xl bg-card/70 border border-border p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400">
            <Subtitles className="h-4 w-4" />
            4. AI Subtitles (ASS)
          </div>
          <div className="text-xs space-y-1 text-muted-foreground">
            <p className="text-foreground font-medium">
              {settings.subtitles.enabled && cues.length > 0
                ? `Enabled (${cues.length} cues · v${subtitleVersion})`
                : 'Disabled'}
            </p>
            {settings.subtitles.enabled && cues.length > 0 && (
              <>
                <p>
                  Language / Font:{' '}
                  <span className="font-mono text-foreground">
                    {detectedLanguage || settings.subtitles.language} ·{' '}
                    {settings.subtitles.style.font_family}
                  </span>
                </p>
                <p>
                  Placement:{' '}
                  <span className="font-mono text-foreground">
                    {settings.subtitles.style.position} ({settings.subtitles.style.font_size}px)
                  </span>
                </p>
              </>
            )}
          </div>
        </div>

        <div className="rounded-2xl bg-card/70 border border-border p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400">
            <Film className="h-4 w-4" />
            5. Outro & Final Output
          </div>
          <div className="text-xs space-y-1 text-muted-foreground">
            <p className="text-foreground font-medium">
              {settings.outro.enabled && outroAsset
                ? `Outro Attached (+${formatFriendlyDuration(outroDurationMs)})`
                : 'No Outro Attached'}
            </p>
            <p>
              Total Expected Length:{' '}
              <span className="font-mono font-semibold text-emerald-400">
                {formatFriendlyDuration(totalExpectedMs)}
              </span>
            </p>
            <p>
              Format:{' '}
              <span className="font-mono text-foreground">
                MP4 (H.264 / AAC / yuv420p)
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Live Job Status & Output Player Panel */}
      {latestExportJob && (
        <div
          aria-live="polite"
          className="rounded-2xl bg-card border border-border p-6 space-y-5 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {latestExportJob.status === 'completed' ? (
                <div className="h-10 w-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
              ) : latestExportJob.status === 'failed' ||
                latestExportJob.status === 'canceled' ? (
                <div className="h-10 w-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400">
                  <XCircle className="h-5 w-5" />
                </div>
              ) : (
                <div className="h-10 w-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold">
                    Export Job Status:{' '}
                    <span className="uppercase tracking-wider text-indigo-400">
                      {latestExportJob.stage.replace(/_/g, ' ')}
                    </span>
                  </h3>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    Ref: {latestExportJob.id.slice(0, 8)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {latestExportJob.status === 'completed'
                    ? 'Output passed FFprobe verification and is ready for download.'
                    : latestExportJob.status === 'failed'
                    ? latestExportJob.error_message_safe ||
                      `Rendering failed. Reference: ${latestExportJob.id}`
                    : latestExportJob.status === 'canceled'
                    ? 'Export job was canceled.'
                    : 'Executing asynchronous FFmpeg media pipeline...'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {isRunning && (
                <button
                  type="button"
                  onClick={handleCancelJob}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-rose-500/40 hover:bg-rose-500/10 text-rose-300 text-xs font-semibold"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Cancel Job
                </button>
              )}

              {(latestExportJob.status === 'failed' ||
                latestExportJob.status === 'canceled') && (
                <button
                  type="button"
                  onClick={handleRetryJob}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry Export
                </button>
              )}

              {latestExportJob.status === 'completed' && outputAsset && (
                <button
                  type="button"
                  onClick={handleDownloadOutput}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition-all cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  Download Final MP4 ({formatBytes(outputAsset.size_bytes)})
                </button>
              )}
            </div>
          </div>

          {/* Stage Progress Pipeline Pills */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2">
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
                  className={`px-3 py-2 rounded-xl border text-[11px] font-medium flex items-center gap-2 ${
                    done
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : active
                      ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500/40'
                      : 'bg-muted/30 border-border/50 text-muted-foreground'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      done
                        ? 'bg-emerald-400'
                        : active
                        ? 'bg-indigo-400 animate-pulse'
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
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-4 border-t border-border items-center">
              <div className="lg:col-span-7">
                <video
                  src={outputAsset.stream_url}
                  controls
                  playsInline
                  className="w-full max-h-[380px] rounded-xl bg-black border border-emerald-500/40 shadow-lg object-contain"
                />
              </div>
              <div className="lg:col-span-5 space-y-3 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-4">
                <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold">
                  <ShieldCheck className="h-4 w-4" />
                  FFprobe Output Verification Passed
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Output File:</span>
                    <span className="font-mono font-medium">
                      {outputAsset.original_filename}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Verified Duration:</span>
                    <span className="font-mono font-semibold text-emerald-400">
                      {formatFriendlyDuration(outputAsset.duration_ms)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Resolution & FPS:</span>
                    <span className="font-mono">
                      {outputAsset.width}×{outputAsset.height} @ {outputAsset.frame_rate} fps
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Codecs:</span>
                    <span className="font-mono">
                      {outputAsset.video_codec} / {outputAsset.audio_codec || 'aac'} (
                      {outputAsset.pixel_format})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">File Size:</span>
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
