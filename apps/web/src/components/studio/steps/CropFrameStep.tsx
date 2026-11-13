import React, { useState } from 'react';
import {
  Crop,
  ScanFace,
  Sparkles,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  Eye,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Maximize2,
  Crosshair,
} from 'lucide-react';
import { extractApiError, videoApi } from '@/api/videoApi';
import {
  ASPECT_RATIO_PRESETS,
  DEFAULT_CROP_SETTINGS,
  computeAspectCropSize,
  computeFaceFramedCropOrigin,
  resolveTargetOutputDimensions,
} from '@/lib/cropMath';
import { InteractiveVideoPreview, type CropBoxPatch } from '../InteractiveVideoPreview';
import type {
  AspectRatioPreset,
  Asset,
  CropSettings,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

interface CropFrameStepProps {
  projectId: string;
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

export const CropFrameStep: React.FC<CropFrameStepProps> = ({
  projectId,
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
  const [previewFramedOutput, setPreviewFramedOutput] = useState(false);
  const [analyzingFace, setAnalyzingFace] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);

  const srcW = sourceAsset?.width || 1920;
  const srcH = sourceAsset?.height || 1080;
  const cropCfg: CropSettings = settings.crop || DEFAULT_CROP_SETTINGS;

  const outDims = resolveTargetOutputDimensions(
    cropCfg,
    srcW,
    srcH,
    settings.output?.width,
    settings.output?.height
  );

  const patchCrop = (updater: (prev: CropSettings) => CropSettings) => {
    onUpdateSettings((prev) => {
      const base = prev.crop || DEFAULT_CROP_SETTINGS;
      return {
        ...prev,
        crop: updater(base),
      };
    });
  };

  const handleSelectAspectRatio = (presetId: AspectRatioPreset) => {
    setErrorMessage(null);
    patchCrop((prev) => {
      if (presetId === 'original' && !prev.auto_face_framing && (prev.zoom || 1) <= 1.01) {
        return {
          ...DEFAULT_CROP_SETTINGS,
          detected_face: prev.detected_face,
        };
      }

      if (presetId === 'custom') {
        const w = prev.enabled && prev.width < 0.99 ? prev.width : 0.8;
        const h = prev.enabled && prev.height < 0.99 ? prev.height : 0.8;
        const x = Math.min(Math.max((1 - w) * 0.5, 0), 1 - w);
        const y = Math.min(Math.max((1 - h) * 0.5, 0), 1 - h);
        return {
          ...prev,
          enabled: true,
          aspect_ratio: 'custom',
          x: Number(x.toFixed(4)),
          y: Number(y.toFixed(4)),
          width: Number(w.toFixed(4)),
          height: Number(h.toFixed(4)),
          zoom: 1,
          dynamic_tracking: false,
          keyframes: [],
        };
      }

      const activeZoom =
        presetId === 'original' ? Math.max(1.25, prev.zoom || 1) : prev.zoom || 1;
      const { width, height } = computeAspectCropSize(presetId, srcW, srcH, activeZoom);

      let origin = {
        x: Math.min(Math.max(prev.x + prev.width * 0.5 - width * 0.5, 0), Math.max(0, 1 - width)),
        y: Math.min(Math.max(prev.y + prev.height * 0.5 - height * 0.5, 0), Math.max(0, 1 - height)),
      };
      if (prev.auto_face_framing && prev.detected_face) {
        origin = computeFaceFramedCropOrigin(prev.detected_face, width, height);
      }

      return {
        ...prev,
        enabled: true,
        aspect_ratio: presetId,
        x: Number(origin.x.toFixed(4)),
        y: Number(origin.y.toFixed(4)),
        width: Number(width.toFixed(4)),
        height: Number(height.toFixed(4)),
        zoom: activeZoom,
        dynamic_tracking: false,
        keyframes: [],
      };
    });
  };

  const handleUpdateCropBox = (patch: CropBoxPatch) => {
    patchCrop((prev) => {
      const nextW = patch.width ?? prev.width;
      const nextH = patch.height ?? prev.height;
      const nextZoom = patch.zoom ?? prev.zoom;
      return {
        ...prev,
        enabled: true,
        x: patch.x,
        y: patch.y,
        width: nextW,
        height: nextH,
        zoom: nextZoom,
        auto_face_framing: false,
        dynamic_tracking: false,
        keyframes: [],
      };
    });
  };

  const handleZoomChange = (newZoom: number) => {
    const z = Number(Math.min(Math.max(newZoom, 1.0), 2.5).toFixed(2));
    patchCrop((prev) => {
      const preset = prev.aspect_ratio === 'custom' ? 'original' : prev.aspect_ratio || 'original';
      const { width, height } = computeAspectCropSize(preset, srcW, srcH, z);
      const isNoopOriginal = preset === 'original' && z <= 1.005 && !prev.auto_face_framing;
      if (isNoopOriginal) {
        return {
          ...DEFAULT_CROP_SETTINGS,
          detected_face: prev.detected_face,
        };
      }

      let origin = {
        x: Math.min(Math.max(prev.x + prev.width * 0.5 - width * 0.5, 0), Math.max(0, 1 - width)),
        y: Math.min(Math.max(prev.y + prev.height * 0.5 - height * 0.5, 0), Math.max(0, 1 - height)),
      };
      if (prev.auto_face_framing && prev.detected_face) {
        origin = computeFaceFramedCropOrigin(prev.detected_face, width, height);
      }

      return {
        ...prev,
        enabled: true,
        aspect_ratio: preset,
        x: Number(origin.x.toFixed(4)),
        y: Number(origin.y.toFixed(4)),
        width: Number(width.toFixed(4)),
        height: Number(height.toFixed(4)),
        zoom: z,
        dynamic_tracking: false,
        keyframes: [],
      };
    });
  };

  const runAutoFaceFraming = async (overrideDynamicTracking?: boolean) => {
    if (!sourceAsset) return;
    setAnalyzingFace(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      // Flush current trim range first so backend samples frames from the active trimmed clip
      await onSaveSettings();
      const targetAspect =
        cropCfg.aspect_ratio === 'custom' ? 'original' : cropCfg.aspect_ratio || 'original';
      const useDynamic = overrideDynamicTracking ?? Boolean(cropCfg.dynamic_tracking);
      const resp = await videoApi.autoFrameProject(projectId, {
        aspectRatio: targetAspect,
        dynamicTracking: useDynamic,
        targetZoom: null,
      });
      onUpdateSettings((prev) => ({
        ...prev,
        crop: resp.crop,
      }));
      setStatusMessage(resp.message);
    } catch (err: unknown) {
      setErrorMessage(
        extractApiError(err, 'Failed to analyze video frames for AI Face Framing.')
      );
    } finally {
      setAnalyzingFace(false);
    }
  };

  const handleResetCrop = () => {
    setStatusMessage(null);
    setErrorMessage(null);
    onUpdateSettings((prev) => ({
      ...prev,
      crop: { ...DEFAULT_CROP_SETTINGS },
    }));
  };

  const handleCenterCrop = () => {
    patchCrop((prev) => {
      const cx = Math.max(0, (1 - prev.width) * 0.5);
      const cy = Math.max(0, (1 - prev.height) * 0.5);
      return {
        ...prev,
        enabled: prev.aspect_ratio !== 'original' || prev.zoom > 1.01 || prev.width < 0.999 || prev.height < 0.999,
        x: Number(cx.toFixed(4)),
        y: Number(cy.toFixed(4)),
        auto_face_framing: false,
        dynamic_tracking: false,
        keyframes: [],
      };
    });
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

  const maxPanX = Math.max(0, 1 - (cropCfg.width || 1));
  const maxPanY = Math.max(0, 1 - (cropCfg.height || 1));

  const inspectorNode = (
    <div className="space-y-5 bg-card/70 border border-border rounded-2xl p-5">
      {isPreviewFullscreen && (
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-border">
          <div className="inline-flex rounded-lg bg-background/80 p-0.5 border border-border">
            <button
              type="button"
              onClick={() => setPreviewFramedOutput(false)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                !previewFramedOutput
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Crop className="h-3 w-3" />
              Crop Box
            </button>
            <button
              type="button"
              onClick={() => setPreviewFramedOutput(true)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                previewFramedOutput
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Eye className="h-3 w-3" />
              Framed
            </button>
          </div>

          {cropCfg.enabled && (
            <button
              type="button"
              onClick={handleResetCrop}
              className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>
      )}

      {/* 1. Aspect Ratio Presets */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <Maximize2 className="h-4 w-4 text-indigo-400" />
            Target Aspect Ratio
          </span>
          <span className="text-[11px] font-mono text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-md">
            Output: {outDims.width}×{outDims.height}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {ASPECT_RATIO_PRESETS.map((preset) => {
            const isSelected =
              preset.id === 'original'
                ? !cropCfg.enabled || cropCfg.aspect_ratio === 'original'
                : cropCfg.enabled && cropCfg.aspect_ratio === preset.id;

            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectAspectRatio(preset.id)}
                className={`flex flex-col items-center justify-center gap-1 p-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-indigo-600/20 border-indigo-500 text-foreground ring-1 ring-indigo-500/40'
                    : 'bg-background/60 border-border hover:border-indigo-500/40 text-muted-foreground hover:text-foreground'
                }`}
              >
                <div className="h-5 flex items-center justify-center">
                  <span
                    style={{
                      width: `${preset.previewW}px`,
                      height: `${preset.previewH}px`,
                    }}
                    className={`inline-block rounded-[2px] border-2 ${
                      isSelected ? 'border-indigo-400 bg-indigo-400/25' : 'border-current opacity-65'
                    }`}
                  />
                </div>
                <span className="text-xs font-bold leading-none">{preset.label}</span>
                <span className="text-[9px] text-muted-foreground leading-tight truncate w-full">
                  {preset.subtitle}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. AI Auto Face Framing Card */}
      <div className="rounded-2xl bg-gradient-to-br from-indigo-500/10 via-emerald-500/5 to-transparent border border-indigo-500/30 p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-bold text-foreground">
              <ScanFace className="h-4 w-4 text-emerald-400" />
              AI Auto Face Framing (UltraFace ONNX)
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Detects the primary speaker in your trimmed clip and locks rule-of-thirds headroom & framing automatically.
            </p>
          </div>
          {cropCfg.auto_face_framing && cropCfg.detected_face && (
            <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-300">
              {Math.round(cropCfg.detected_face.confidence * 100)}% Match
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={!sourceAsset || analyzingFace}
          onClick={() => runAutoFaceFraming()}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
        >
          {analyzingFace ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning Speaker Faces Across Clip...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              {cropCfg.auto_face_framing
                ? 'Re-Scan & Lock Speaker Frame'
                : 'Auto-Detect & Frame Speaker'}
            </>
          )}
        </button>

        <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer">
          <div>
            <span className="block text-xs font-semibold text-foreground">
              Follow Moving Speaker (Dynamic Tracking)
            </span>
            <span className="block text-[10px] text-muted-foreground">
              Smoothly pans the crop window if the speaker walks or shifts across frame
            </span>
          </div>
          <input
            type="checkbox"
            checked={Boolean(cropCfg.dynamic_tracking)}
            disabled={!sourceAsset || analyzingFace}
            onChange={async (e) => {
              const enabled = e.target.checked;
              if (enabled) {
                await runAutoFaceFraming(true);
              } else {
                patchCrop((prev) => ({
                  ...prev,
                  dynamic_tracking: false,
                  keyframes: [],
                }));
              }
            }}
            className="h-4 w-4 rounded accent-emerald-500 cursor-pointer"
          />
        </label>

        {statusMessage && (
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 p-2.5 text-[11px] text-emerald-300 flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>{statusMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-2.5 text-[11px] text-rose-300 flex items-start gap-2"
          >
            <AlertCircle className="h-3.5 w-3.5 text-rose-400 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* 3. Fine-Tune Zoom, Pan & Fit Mode */}
      <div className="space-y-3.5 pt-2 border-t border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            Fine-Tune Framing & Fit
          </span>
          <button
            type="button"
            onClick={handleCenterCrop}
            className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
          >
            <Crosshair className="h-3 w-3" />
            Center Box
          </button>
        </div>

        {/* Fit Mode Toggle (Crop to Fill vs Letterbox Pad) */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() =>
              patchCrop((prev) => ({ ...prev, enabled: true, fit_mode: 'crop' }))
            }
            className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${
              (cropCfg.fit_mode || 'crop') === 'crop'
                ? 'bg-indigo-600/20 border-indigo-500 text-foreground'
                : 'bg-background/60 border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            Crop to Fill Frame
          </button>
          <button
            type="button"
            onClick={() =>
              patchCrop((prev) => ({
                ...prev,
                enabled: true,
                fit_mode: 'pad',
                dynamic_tracking: false,
              }))
            }
            className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${
              cropCfg.fit_mode === 'pad'
                ? 'bg-indigo-600/20 border-indigo-500 text-foreground'
                : 'bg-background/60 border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            Fit Inside (Letterbox)
          </button>
        </div>

        {/* Zoom Slider */}
        <label className="block space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground font-medium">Camera Zoom</span>
            <span className="font-mono font-semibold text-foreground">
              {(cropCfg.zoom || 1).toFixed(2)}×
            </span>
          </div>
          <input
            type="range"
            min={1.0}
            max={2.5}
            step={0.02}
            value={cropCfg.zoom || 1}
            disabled={cropCfg.aspect_ratio === 'custom'}
            onChange={(e) => handleZoomChange(Number(e.target.value))}
            className="w-full accent-indigo-500 cursor-pointer disabled:opacity-40"
          />
        </label>

        {/* Horizontal & Vertical Pan Sliders */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Horizontal Pan</span>
              <span className="font-mono text-foreground">
                {maxPanX > 0.001
                  ? `${Math.round(((cropCfg.x || 0) / maxPanX) * 100)}%`
                  : 'Locked'}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0.0001, maxPanX)}
              step={0.005}
              disabled={maxPanX <= 0.001}
              value={Math.min(cropCfg.x || 0, maxPanX)}
              onChange={(e) =>
                handleUpdateCropBox({
                  x: Number(Number(e.target.value).toFixed(4)),
                  y: cropCfg.y || 0,
                })
              }
              className="w-full accent-indigo-500 cursor-pointer disabled:opacity-35"
            />
          </label>

          <label className="block space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Vertical Pan</span>
              <span className="font-mono text-foreground">
                {maxPanY > 0.001
                  ? `${Math.round(((cropCfg.y || 0) / maxPanY) * 100)}%`
                  : 'Locked'}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0.0001, maxPanY)}
              step={0.005}
              disabled={maxPanY <= 0.001}
              value={Math.min(cropCfg.y || 0, maxPanY)}
              onChange={(e) =>
                handleUpdateCropBox({
                  x: cropCfg.x || 0,
                  y: Number(Number(e.target.value).toFixed(4)),
                })
              }
              className="w-full accent-indigo-500 cursor-pointer disabled:opacity-35"
            />
          </label>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">
            Step 3: Aspect Ratio, Crop & AI Face Framing
          </h2>
          <p className="text-xs text-muted-foreground">
            Reframe for Shorts/Reels (`9:16`), Square (`1:1`), Portrait (`4:5`), or Widescreen (`16:9`), drag the crop box, or auto-frame speakers with local neural face detection.
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
            disabled={saving || analyzingFace}
            onClick={handleContinue}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold transition-all shadow-sm"
          >
            {saving ? 'Saving...' : 'Continue to Color Grade'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Interactive Crop Canvas / Framed Output Switcher */}
        <div className="lg:col-span-7 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 border border-border rounded-xl p-1.5">
            <div className="inline-flex rounded-lg bg-background/80 p-0.5 border border-border">
              <button
                type="button"
                onClick={() => setPreviewFramedOutput(false)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  !previewFramedOutput
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Crop className="h-3.5 w-3.5" />
                Interactive Crop Box
              </button>
              <button
                type="button"
                onClick={() => setPreviewFramedOutput(true)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  previewFramedOutput
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview Framed Result ({outDims.width}×{outDims.height})
              </button>
            </div>

            {cropCfg.enabled && (
              <button
                type="button"
                onClick={handleResetCrop}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Reset Original
              </button>
            )}
          </div>

          <InteractiveVideoPreview
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={settings}
            cues={cues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={onTimeUpdate}
            cropEditorMode={!previewFramedOutput}
            onUpdateCropBox={handleUpdateCropBox}
            fullscreenInspector={inspectorNode}
            onFullscreenChange={setIsPreviewFullscreen}
          />
        </div>

        {/* Right Column: Aspect Ratio Presets, AI Face Framing & Crop Controls */}
        <div className="lg:col-span-5">{!isPreviewFullscreen && inspectorNode}</div>
      </div>
    </div>
  );
};
