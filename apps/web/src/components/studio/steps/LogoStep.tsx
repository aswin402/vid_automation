import React, { useState } from 'react';
import {
  Image as ImageIcon,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  Info,
  Upload,
} from 'lucide-react';
import { InteractiveVideoPreview } from '../InteractiveVideoPreview';
import { PositionGridPicker } from '../PositionGridPicker';
import { isTauriDesktop, videoApi } from '@/api/videoApi';
import type { AnchorPosition, Asset, EditSettings, SubtitleCue } from '@/types/video';

interface LogoStepProps {
  projectId: string;
  sourceAsset: Asset | undefined;
  logoAsset: Asset | undefined;
  settings: EditSettings;
  cues: SubtitleCue[];
  currentTimeMs: number;
  onTimeUpdate: (ms: number) => void;
  onUpdateSettings: (updater: (prev: EditSettings) => EditSettings) => void;
  onSaveSettings: () => Promise<void>;
  onAssetsChanged: () => void;
  onBack: () => void;
  onNext: () => void;
}

export const LogoStep: React.FC<LogoStepProps> = ({
  projectId,
  sourceAsset,
  logoAsset,
  settings,
  cues,
  currentTimeMs,
  onTimeUpdate,
  onUpdateSettings,
  onSaveSettings,
  onAssetsChanged,
  onBack,
  onNext,
}) => {
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoCfg = settings.logo;

  const handlePositionSelect = (pos: AnchorPosition) => {
    onUpdateSettings((prev) => ({
      ...prev,
      logo: {
        ...prev.logo,
        enabled: true,
        position: pos,
        x_ratio: null,
        y_ratio: null,
      },
    }));
  };

  const handleDragLogo = (xRatio: number, yRatio: number) => {
    onUpdateSettings((prev) => ({
      ...prev,
      logo: {
        ...prev.logo,
        enabled: true,
        x_ratio: xRatio,
        y_ratio: yRatio,
      },
    }));
  };

  const handleResetDefaults = () => {
    onUpdateSettings((prev) => ({
      ...prev,
      logo: {
        ...prev.logo,
        enabled: Boolean(logoAsset),
        position: 'top-right',
        x_ratio: null,
        y_ratio: null,
        width_ratio: 0.14,
        opacity: 1.0,
        margin_ratio: 0.03,
      },
    }));
  };

  const handleQuickLogoUpload = async (file: File) => {
    setUploadingLogo(true);
    try {
      const uploaded = await videoApi.uploadAssetWithSignedUrl(projectId, 'logo', file);
      onUpdateSettings((prev) => ({
        ...prev,
        logo: {
          ...prev.logo,
          enabled: true,
          asset_id: uploaded.id,
        },
      }));
      onAssetsChanged();
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleDesktopPickLogo = async () => {
    setUploadingLogo(true);
    try {
      const imported = await videoApi.pickAndImportLocalAsset(projectId, 'logo');
      if (imported) {
        onUpdateSettings((prev) => ({
          ...prev,
          logo: {
            ...prev.logo,
            enabled: true,
            asset_id: imported.id,
          },
        }));
        onAssetsChanged();
      }
    } finally {
      setUploadingLogo(false);
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
          <h2 className="text-lg font-bold">Step 5: Brand Logo Overlay (Optional)</h2>
          <p className="text-xs text-muted-foreground">
            Configure logo anchor position, drag placement, normalized scale, and opacity across any output resolution.
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
            {saving ? 'Saving...' : 'Continue to Subtitles'}
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
            dragMode={logoCfg.enabled && logoAsset ? 'logo' : 'none'}
            onDragLogo={handleDragLogo}
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

        <div className="lg:col-span-5 space-y-5 bg-card/70 border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <label className="inline-flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={logoCfg.enabled}
                disabled={!logoAsset}
                onChange={(e) =>
                  onUpdateSettings((prev) => ({
                    ...prev,
                    logo: { ...prev.logo, enabled: e.target.checked },
                  }))
                }
                className="h-4 w-4 rounded accent-indigo-600"
              />
              <span className="text-sm font-semibold">Enable Brand Logo Overlay</span>
            </label>

            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium"
            >
              <RotateCcw className="h-3 w-3" />
              Reset Default
            </button>
          </div>

          {!logoAsset && (
            <div className="rounded-xl bg-muted/40 border border-dashed border-border p-4 text-center space-y-2.5">
              <ImageIcon className="h-6 w-6 text-indigo-400 mx-auto" />
              <p className="text-xs text-muted-foreground">
                No logo uploaded yet. Upload a transparent PNG, WebP, or JPEG logo to brand your video.
              </p>
              {isTauriDesktop() ? (
                <button
                  type="button"
                  disabled={uploadingLogo}
                  onClick={handleDesktopPickLogo}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {uploadingLogo ? 'Importing...' : 'Select Logo Image'}
                </button>
              ) : (
                <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer">
                  <Upload className="h-3.5 w-3.5" />
                  {uploadingLogo ? 'Uploading...' : 'Upload Logo Image'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleQuickLogoUpload(f);
                    }}
                  />
                </label>
              )}
            </div>
          )}

          <div
            className={`space-y-4 ${
              !logoAsset || !logoCfg.enabled ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <PositionGridPicker
              label="Anchor Preset (or drag logo in preview)"
              value={logoCfg.position}
              customCoordinatesActive={logoCfg.x_ratio !== null && logoCfg.y_ratio !== null}
              onChange={handlePositionSelect}
            />

            <div className="space-y-3 pt-2 border-t border-border">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="font-medium">Logo Size (% of Video Width)</span>
                  <span className="font-mono text-indigo-400">
                    {Math.round((logoCfg.width_ratio || 0.14) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.05}
                  max={0.45}
                  step={0.01}
                  value={logoCfg.width_ratio || 0.14}
                  onChange={(e) =>
                    onUpdateSettings((prev) => ({
                      ...prev,
                      logo: { ...prev.logo, width_ratio: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="font-medium">Logo Opacity</span>
                  <span className="font-mono text-indigo-400">
                    {Math.round((logoCfg.opacity ?? 1.0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  value={logoCfg.opacity ?? 1.0}
                  onChange={(e) =>
                    onUpdateSettings((prev) => ({
                      ...prev,
                      logo: { ...prev.logo, opacity: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="font-medium">Safe-Area Edge Margin</span>
                  <span className="font-mono text-indigo-400">
                    {Math.round((logoCfg.margin_ratio ?? 0.03) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.0}
                  max={0.15}
                  step={0.005}
                  value={logoCfg.margin_ratio ?? 0.03}
                  onChange={(e) =>
                    onUpdateSettings((prev) => ({
                      ...prev,
                      logo: { ...prev.logo, margin_ratio: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
            <span>
              <strong>Outro Policy:</strong> By default, the brand logo is burned into the{' '}
              <strong>main trimmed segment only</strong> and is not overlaid on your outro clip.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
