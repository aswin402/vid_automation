import React, { useState } from 'react';
import {
  Film,
  ArrowLeft,
  ArrowRight,
  Info,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { isTauriDesktop, videoApi } from '@/api/videoApi';
import { resolveTargetOutputDimensions } from '@/lib/cropMath';
import { formatBytes, formatFriendlyDuration } from '@/lib/timecode';
import type { Asset, EditSettings } from '@/types/video';

interface OutroStepProps {
  projectId: string;
  sourceAsset: Asset | undefined;
  outroAsset: Asset | undefined;
  settings: EditSettings;
  onUpdateSettings: (updater: (prev: EditSettings) => EditSettings) => void;
  onSaveSettings: () => Promise<void>;
  onAssetsChanged: () => void;
  onBack: () => void;
  onNext: () => void;
}

export const OutroStep: React.FC<OutroStepProps> = ({
  projectId,
  sourceAsset,
  outroAsset,
  settings,
  onUpdateSettings,
  onSaveSettings,
  onAssetsChanged,
  onBack,
  onNext,
}) => {
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const outroCfg = settings.outro;
  const targetOutDims = resolveTargetOutputDimensions(
    settings.crop,
    sourceAsset?.width || 1280,
    sourceAsset?.height || 720,
    settings.output?.width,
    settings.output?.height
  );

  const handleUploadOutro = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await videoApi.uploadAssetWithSignedUrl(projectId, 'outro', file);
      onUpdateSettings((prev) => ({
        ...prev,
        outro: {
          ...prev.outro,
          enabled: true,
          asset_id: uploaded.id,
        },
      }));
      onAssetsChanged();
    } finally {
      setUploading(false);
    }
  };

  const handleDesktopPickOutro = async () => {
    setUploading(true);
    try {
      const imported = await videoApi.pickAndImportLocalAsset(projectId, 'outro');
      if (imported) {
        onUpdateSettings((prev) => ({
          ...prev,
          outro: {
            ...prev.outro,
            enabled: true,
            asset_id: imported.id,
          },
        }));
        onAssetsChanged();
      }
    } finally {
      setUploading(false);
    }
  };

  const handleContinue = async () => {
    setSaving(true);
    try {
      await onSaveSettings();
      onNext();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">Step 8: Outro Attachment (Optional)</h2>
          <p className="text-xs text-muted-foreground">
            Append a standard brand outro after your edited main clip. Automatically normalized to match resolution, frame rate, and audio.
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
            disabled={saving}
            onClick={handleContinue}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-sm"
          >
            {saving ? 'Saving...' : 'Continue to Review & Export'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 bg-card/70 border border-border rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold flex items-center gap-2">
              <Film className="h-4 w-4 text-indigo-400" />
              Outro Video Preview
            </span>
            {outroAsset && (
              <span className="text-xs font-mono text-muted-foreground">
                {outroAsset.original_filename}
              </span>
            )}
          </div>

          {outroAsset?.stream_url ? (
            <video
              src={outroAsset.stream_url}
              crossOrigin="anonymous"
              controls
              playsInline
              disablePictureInPicture
              disableRemotePlayback
              className="w-full max-h-[360px] rounded-xl bg-black border border-border object-contain"
            />
          ) : (
            <div className="h-64 rounded-xl bg-muted/30 border border-dashed border-border flex flex-col items-center justify-center p-6 text-center space-y-3">
              <Film className="h-8 w-8 text-muted-foreground" />
              <p className="text-xs text-muted-foreground max-w-sm">
                No outro video uploaded yet. Upload an MP4 or MOV outro clip to append it after your main segment.
              </p>
              {isTauriDesktop() ? (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={handleDesktopPickOutro}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {uploading ? 'Importing & Probing...' : 'Select Outro Video'}
                </button>
              ) : (
                <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer">
                  <Upload className="h-3.5 w-3.5" />
                  {uploading ? 'Uploading & Probing...' : 'Upload Outro Video'}
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUploadOutro(f);
                    }}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="lg:col-span-5 bg-card/70 border border-border rounded-2xl p-5 space-y-5">
          <label className="inline-flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={outroCfg.enabled}
              disabled={!outroAsset}
              onChange={(e) =>
                onUpdateSettings((prev) => ({
                  ...prev,
                  outro: { ...prev.outro, enabled: e.target.checked },
                }))
              }
              className="h-4 w-4 rounded accent-indigo-600"
            />
            <span className="text-sm font-semibold">Append Outro to Export</span>
          </label>

          <div className="space-y-1.5">
            <label
              htmlFor="outro-norm-mode"
              className="block text-xs font-medium text-muted-foreground"
            >
              Aspect-Ratio Normalization Mode
            </label>
            <select
              id="outro-norm-mode"
              disabled={!outroAsset || !outroCfg.enabled}
              value={outroCfg.normalization_mode || 'pad'}
              onChange={(e) =>
                onUpdateSettings((prev) => ({
                  ...prev,
                  outro: {
                    ...prev.outro,
                    normalization_mode: e.target.value as 'pad' | 'crop' | 'stretch',
                  },
                }))
              }
              className="w-full rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs"
            >
              <option value="pad">Scale to Fit + Safe Padding (Recommended)</option>
              <option value="crop">Scale to Fill + Center Crop</option>
              <option value="stretch">Stretch to Exact Dimensions</option>
            </select>
          </div>

          {outroAsset && (
            <div className="rounded-xl bg-muted/40 border border-border p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Outro Duration:</span>
                <span className="font-mono font-semibold">
                  {formatFriendlyDuration(outroAsset.duration_ms)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Source Dimensions:</span>
                <span className="font-mono">
                  {outroAsset.width}×{outroAsset.height} ({outroAsset.frame_rate} fps)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Target Match (Main Clip):</span>
                <span className="font-mono text-indigo-400">
                  {targetOutDims.width}×{targetOutDims.height} (yuv420p)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">File Size:</span>
                <span className="font-mono">{formatBytes(outroAsset.size_bytes)}</span>
              </div>
              <div className="flex justify-between items-center pt-1 border-t border-border/60">
                <span className="text-muted-foreground">Audio Stream:</span>
                {outroAsset.has_audio ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                    <Volume2 className="h-3.5 w-3.5" />
                    Sequential Audio Preserved
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                    <VolumeX className="h-3.5 w-3.5" />
                    Silent Audio Auto-Generated
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="space-y-2.5 text-xs text-muted-foreground rounded-xl bg-indigo-500/5 border border-indigo-500/20 p-4">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              <Info className="h-4 w-4 text-indigo-400" />
              Normalization & Audio Policy
            </div>
            <ul className="list-disc list-inside space-y-1 text-[11px]">
              <li>
                Outro is scaled-to-fit with safe padding to match the main video's resolution, frame rate, and H.264/AAC codec profile.
              </li>
              <li>
                Main clip audio plays first, followed immediately by outro audio (no crossfade).
              </li>
              <li>
                If either clip lacks an audio stream, compatible stereo silence is synthesized automatically so concatenation never fails.
              </li>
              <li>
                Brand logo and AI subtitles are applied only to the main segment, not the outro.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
