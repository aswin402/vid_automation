import React, { useState } from 'react';
import {
  Sliders,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  Eye,
  Sparkles,
  Info,
} from 'lucide-react';
import { InteractiveVideoPreview } from '../InteractiveVideoPreview';
import type {
  Asset,
  ColorCorrectionSettings,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

interface ColorPresetDefinition {
  id: string;
  label: string;
  badge: string;
  values: Omit<ColorCorrectionSettings, 'enabled' | 'preset' | 'apply_to_outro'>;
}

export const COLOR_PRESETS: readonly ColorPresetDefinition[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    badge: 'Flat 1:1',
    values: {
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      gamma: 1.0,
      temperature: 0.0,
      tint: 0.0,
      sharpen: 0.0,
    },
  },
  {
    id: 'natural_boost',
    label: 'Natural Boost',
    badge: 'Balanced',
    values: {
      brightness: 0.03,
      contrast: 1.12,
      saturation: 1.18,
      gamma: 1.04,
      temperature: 0.08,
      tint: 0.0,
      sharpen: 0.35,
    },
  },
  {
    id: 'warm_cinema',
    label: 'Warm Cinema',
    badge: 'Golden',
    values: {
      brightness: 0.02,
      contrast: 1.15,
      saturation: 1.12,
      gamma: 1.02,
      temperature: 0.42,
      tint: 0.06,
      sharpen: 0.25,
    },
  },
  {
    id: 'cool_crisp',
    label: 'Cool Studio',
    badge: 'Clean',
    values: {
      brightness: 0.02,
      contrast: 1.16,
      saturation: 1.06,
      gamma: 1.05,
      temperature: -0.38,
      tint: -0.04,
      sharpen: 0.5,
    },
  },
  {
    id: 'high_contrast',
    label: 'Punchy Pop',
    badge: 'Vibrant',
    values: {
      brightness: 0.0,
      contrast: 1.32,
      saturation: 1.28,
      gamma: 0.96,
      temperature: 0.05,
      tint: 0.0,
      sharpen: 0.6,
    },
  },
  {
    id: 'vintage_matte',
    label: 'Vintage Matte',
    badge: 'Film',
    values: {
      brightness: 0.05,
      contrast: 0.9,
      saturation: 0.82,
      gamma: 1.12,
      temperature: 0.28,
      tint: 0.1,
      sharpen: 0.0,
    },
  },
  {
    id: 'bw_noir',
    label: 'B&W Noir',
    badge: 'Mono',
    values: {
      brightness: 0.0,
      contrast: 1.35,
      saturation: 0.0,
      gamma: 0.95,
      temperature: 0.0,
      tint: 0.0,
      sharpen: 0.45,
    },
  },
];

type NumericColorKey = keyof Omit<
  ColorCorrectionSettings,
  'enabled' | 'preset' | 'apply_to_outro'
>;

interface SliderDescriptor {
  key: NumericColorKey;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  formatDisplay: (v: number) => string;
}

const COLOR_SLIDERS: readonly SliderDescriptor[] = [
  {
    key: 'brightness',
    label: 'Brightness (Exposure Lift)',
    min: -0.5,
    max: 0.5,
    step: 0.01,
    defaultValue: 0.0,
    formatDisplay: (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`,
  },
  {
    key: 'contrast',
    label: 'Contrast (Dynamic Range)',
    min: 0.5,
    max: 2.0,
    step: 0.02,
    defaultValue: 1.0,
    formatDisplay: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'saturation',
    label: 'Saturation (Color Intensity)',
    min: 0.0,
    max: 2.5,
    step: 0.02,
    defaultValue: 1.0,
    formatDisplay: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'gamma',
    label: 'Gamma (Midtone Curve)',
    min: 0.5,
    max: 2.0,
    step: 0.02,
    defaultValue: 1.0,
    formatDisplay: (v) => v.toFixed(2),
  },
  {
    key: 'temperature',
    label: 'Temperature (Cool ↔ Warm)',
    min: -1.0,
    max: 1.0,
    step: 0.02,
    defaultValue: 0.0,
    formatDisplay: (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`,
  },
  {
    key: 'tint',
    label: 'Tint (Green ↔ Magenta)',
    min: -1.0,
    max: 1.0,
    step: 0.02,
    defaultValue: 0.0,
    formatDisplay: (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`,
  },
  {
    key: 'sharpen',
    label: 'Sharpness (Luma Unsharp Mask)',
    min: 0.0,
    max: 1.5,
    step: 0.05,
    defaultValue: 0.0,
    formatDisplay: (v) => `${Math.round((v / 1.5) * 100)}%`,
  },
];

interface ColorCorrectionStepProps {
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

export const ColorCorrectionStep: React.FC<ColorCorrectionStepProps> = ({
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
  const [saving, setSaving] = useState(false);
  const [comparingOriginal, setComparingOriginal] = useState(false);

  const colorCfg: ColorCorrectionSettings = settings.color_correction || {
    enabled: false,
    preset: 'custom',
    brightness: 0.0,
    contrast: 1.0,
    saturation: 1.0,
    gamma: 1.0,
    temperature: 0.0,
    tint: 0.0,
    sharpen: 0.0,
    apply_to_outro: false,
  };

  const handleApplyPreset = (preset: ColorPresetDefinition) => {
    onUpdateSettings((prev) => ({
      ...prev,
      color_correction: {
        ...prev.color_correction,
        enabled: preset.id !== 'neutral' ? true : prev.color_correction?.enabled ?? false,
        preset: preset.id,
        ...preset.values,
      },
    }));
  };

  const handleSliderChange = (key: NumericColorKey, val: number) => {
    onUpdateSettings((prev) => ({
      ...prev,
      color_correction: {
        ...prev.color_correction,
        enabled: true,
        preset: 'custom',
        [key]: val,
      },
    }));
  };

  const handleResetNeutral = () => {
    const neutral = COLOR_PRESETS[0];
    onUpdateSettings((prev) => ({
      ...prev,
      color_correction: {
        ...prev.color_correction,
        enabled: false,
        preset: 'neutral',
        ...neutral.values,
        apply_to_outro: false,
      },
    }));
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
          <h2 className="text-lg font-bold">
            Step 3: Color Correction & Grading (Optional)
          </h2>
          <p className="text-xs text-muted-foreground">
            Adjust exposure, contrast, saturation, white-balance temperature/tint, and sharpness with 1:1 FFmpeg filter parity.
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
            {saving ? 'Saving...' : 'Continue to Audio Clean'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-2">
          <InteractiveVideoPreview
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={settings}
            cues={cues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={onTimeUpdate}
            bypassColorCorrection={comparingOriginal}
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

        <div className="lg:col-span-5 space-y-5 bg-card/70 border border-border rounded-2xl p-5">
          {/* Enable Toggle + Before/After Compare + Reset */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={colorCfg.enabled}
                onChange={(e) =>
                  onUpdateSettings((prev) => ({
                    ...prev,
                    color_correction: {
                      ...colorCfg,
                      enabled: e.target.checked,
                    },
                  }))
                }
                className="h-4 w-4 rounded accent-indigo-600"
              />
              <span className="text-sm font-semibold">Enable Color Correction</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onPointerDown={() => setComparingOriginal(true)}
                onPointerUp={() => setComparingOriginal(false)}
                onPointerLeave={() => setComparingOriginal(false)}
                disabled={!colorCfg.enabled}
                title="Hold down to compare with ungraded original video"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-muted hover:bg-muted/80 disabled:opacity-40 text-[11px] font-medium select-none cursor-pointer"
              >
                <Eye className="h-3 w-3 text-indigo-400" />
                {comparingOriginal ? 'Showing Original' : 'Hold to Compare'}
              </button>

              <button
                type="button"
                onClick={handleResetNeutral}
                className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </div>
          </div>

          {/* Look Presets */}
          <div className="space-y-2 pt-2 border-t border-border">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              One-Click Look Presets
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {COLOR_PRESETS.map((preset) => {
                const isSelected =
                  colorCfg.enabled && colorCfg.preset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleApplyPreset(preset)}
                    className={`px-2.5 py-2 rounded-xl border text-left transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600/20 border-indigo-500 text-foreground ring-1 ring-indigo-500/40'
                        : 'bg-background/60 border-border hover:border-indigo-500/40 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span className="block text-xs font-semibold truncate text-foreground">
                      {preset.label}
                    </span>
                    <span className="block text-[10px] text-indigo-400/90 font-mono">
                      {preset.badge}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fine-Tune Sliders */}
          <div className="space-y-3 pt-2 border-t border-border max-h-[310px] overflow-y-auto pr-1">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Sliders className="h-3.5 w-3.5 text-indigo-400" />
                Fine-Tune Parameters
              </span>
              <span className="text-[10px] text-muted-foreground">
                Double-click any slider to reset
              </span>
            </div>

            {COLOR_SLIDERS.map((slider) => {
              const currentVal = Number(colorCfg[slider.key] ?? slider.defaultValue);
              const isModified = Math.abs(currentVal - slider.defaultValue) > 1e-4;
              return (
                <div key={slider.key} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span
                      className={
                        isModified ? 'font-semibold text-foreground' : 'text-muted-foreground'
                      }
                    >
                      {slider.label}
                    </span>
                    <span className="font-mono text-indigo-400">
                      {slider.formatDisplay(currentVal)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    value={currentVal}
                    onDoubleClick={() => handleSliderChange(slider.key, slider.defaultValue)}
                    onChange={(e) =>
                      handleSliderChange(slider.key, Number(e.target.value))
                    }
                    className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-muted rounded-lg"
                  />
                </div>
              );
            })}
          </div>

          {/* Apply to Outro Checkbox */}
          <div className="pt-2 border-t border-border flex items-center justify-between">
            <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              <input
                type="checkbox"
                checked={Boolean(colorCfg.apply_to_outro)}
                onChange={(e) =>
                  onUpdateSettings((prev) => ({
                    ...prev,
                    color_correction: {
                      ...colorCfg,
                      apply_to_outro: e.target.checked,
                    },
                  }))
                }
                className="rounded accent-indigo-600"
              />
              <span>Also apply color grade to Outro clip</span>
            </label>
          </div>

          <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
            <span>
              <strong>Non-Destructive Layering:</strong> Color grading is applied to the video stream <em>before</em> your brand logo and subtitles are overlaid, preserving exact brand and text colors.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
