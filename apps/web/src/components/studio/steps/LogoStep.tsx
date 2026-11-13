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
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
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
        enabled: true,
        position: 'bottom-right',
        x_ratio: 0.89,
        y_ratio: 0.68,
        width_ratio: 0.26,
        opacity: 1.0,
        margin_ratio: 0.03,
        apply_to_outro: false,
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

  const inspectorNode = (
    <div className="space-y-4 bg-card/70 border border-border rounded-2xl p-5 text-xs">
      <div className="flex items-center justify-between gap-2 rounded-xl bg-card border border-border px-3 py-2.5">
        {logoAsset ? (
          <div className="flex items-center gap-2.5 min-w-0">
            {logoAsset.stream_url && (
              <img
                src={logoAsset.stream_url}
                alt={logoAsset.original_filename}
                className="h-7 w-9 object-contain rounded bg-black/50 p-0.5 shrink-0"
              />
            )}
            <span className="font-medium truncate">
              {logoAsset.original_filename}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <ImageIcon className="h-4 w-4 text-primary shrink-0" />
            <span>No brand logo uploaded</span>
          </div>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          {isTauriDesktop() ? (
            <button
              type="button"
              disabled={uploadingLogo}
              onClick={handleDesktopPickLogo}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadingLogo ? 'Importing...' : logoAsset ? 'Replace' : 'Upload'}
            </button>
          ) : (
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium cursor-pointer">
              <Upload className="h-3.5 w-3.5" />
              {uploadingLogo ? 'Uploading...' : logoAsset ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleQuickLogoUpload(f);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={logoCfg.enabled}
            onChange={(e) =>
              onUpdateSettings((prev) => ({
                ...prev,
                logo: { ...prev.logo, enabled: e.target.checked },
              }))
            }
            className="h-4 w-4 rounded accent-indigo-600"
          />
          <span className="text-sm font-semibold">Overlay Brand Logo</span>
        </label>

        <button
          type="button"
          onClick={handleResetDefaults}
          className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
        >
          <RotateCcw className="h-3 w-3" />
          Reset Default
        </button>
      </div>

      {logoCfg.enabled && (
        <div className="space-y-4 pt-2 border-t border-border">
          <div className="flex items-start justify-between gap-3">
            <PositionGridPicker
              label="Anchor"
              value={logoCfg.position}
              customCoordinatesActive={
                logoCfg.x_ratio !== null && logoCfg.y_ratio !== null
              }
              onChange={handlePositionSelect}
            />

            <div className="flex-1 space-y-2">
              <span className="block text-[11px] text-muted-foreground">
                Quick Scale
              </span>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { label: 'S 8%', val: 0.08 },
                  { label: 'M 14%', val: 0.14 },
                  { label: 'L 22%', val: 0.22 },
                ].map((sz) => (
                  <button
                    key={sz.label}
                    type="button"
                    onClick={() =>
                      onUpdateSettings((prev) => ({
                        ...prev,
                        logo: { ...prev.logo, width_ratio: sz.val },
                      }))
                    }
                    className={`py-1 rounded border text-[10px] font-mono transition-colors cursor-pointer ${
                      Math.abs((logoCfg.width_ratio || 0.26) - sz.val) < 0.005
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {sz.label}
                  </button>
                ))}
              </div>

              {logoCfg.x_ratio !== null && logoCfg.y_ratio !== null && (
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings((prev) => ({
                      ...prev,
                      logo: { ...prev.logo, x_ratio: null, y_ratio: null },
                    }))
                  }
                  className="w-full inline-flex items-center justify-center gap-1 py-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <RotateCcw className="h-3 w-3" />
                  Snap to Anchor
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/60">
            <div>
              <div className="flex justify-between text-[11px] mb-1">
                <span className="text-muted-foreground">X</span>
                <span className="font-mono">
                  {logoCfg.x_ratio !== null
                    ? `${Math.round(logoCfg.x_ratio * 100)}%`
                    : 'grid'}
                </span>
              </div>
              <input
                type="range"
                min={0.0}
                max={1.0}
                step={0.01}
                value={logoCfg.x_ratio ?? 0.89}
                onChange={(e) =>
                  onUpdateSettings((prev) => ({
                    ...prev,
                    logo: {
                      ...prev.logo,
                      x_ratio: Number(e.target.value),
                      y_ratio: prev.logo.y_ratio ?? 0.68,
                    },
                  }))
                }
                className="w-full accent-indigo-500 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-[11px] mb-1">
                <span className="text-muted-foreground">Y</span>
                <span className="font-mono">
                  {logoCfg.y_ratio !== null
                    ? `${Math.round(logoCfg.y_ratio * 100)}%`
                    : 'grid'}
                </span>
              </div>
              <input
                type="range"
                min={0.0}
                max={1.0}
                step={0.01}
                value={logoCfg.y_ratio ?? 0.68}
                onChange={(e) =>
                  onUpdateSettings((prev) => ({
                    ...prev,
                    logo: {
                      ...prev.logo,
                      x_ratio: prev.logo.x_ratio ?? 0.89,
                      y_ratio: Number(e.target.value),
                    },
                  }))
                }
                className="w-full accent-indigo-500 cursor-pointer"
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-muted-foreground">Width</span>
              <span className="font-mono">
                {Math.round((logoCfg.width_ratio || 0.26) * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.04}
              max={0.45}
              step={0.01}
              value={logoCfg.width_ratio || 0.26}
              onChange={(e) =>
                onUpdateSettings((prev) => ({
                  ...prev,
                  logo: { ...prev.logo, width_ratio: Number(e.target.value) },
                }))
              }
              className="w-full accent-indigo-500 cursor-pointer"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between text-[11px] mb-1">
                <span className="text-muted-foreground">Opacity</span>
                <span className="font-mono">
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
              <div className="flex justify-between text-[11px] mb-1">
                <span className="text-muted-foreground">Margin</span>
                <span className="font-mono">
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

          <label className="flex items-center justify-between pt-1 cursor-pointer">
            <span className="text-[11px] text-muted-foreground">
              Show logo during Outro
            </span>
            <input
              type="checkbox"
              checked={logoCfg.apply_to_outro}
              onChange={(e) =>
                onUpdateSettings((prev) => ({
                  ...prev,
                  logo: { ...prev.logo, apply_to_outro: e.target.checked },
                }))
              }
              className="h-4 w-4 rounded accent-indigo-600"
            />
          </label>
        </div>
      )}

      <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
        <Info className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
        <span>
          <strong>Outro Policy:</strong> By default, the brand logo is burned into the{' '}
          <strong>main trimmed segment only</strong> and is not overlaid on your outro clip.
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">Step 6: Brand Logo Overlay (Optional)</h2>
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
            fullscreenInspector={inspectorNode}
            onFullscreenChange={setIsPreviewFullscreen}
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
