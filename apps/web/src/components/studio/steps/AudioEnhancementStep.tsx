import React, { useState } from 'react';
import {
  Volume2,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  Ear,
  Sparkles,
  Check,
  Mic,
  Waves,
} from 'lucide-react';
import { InteractiveVideoPreview } from '../InteractiveVideoPreview';
import type {
  Asset,
  AudioEnhancementSettings,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

interface AudioEnhancementStepProps {
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

interface AudioPreset {
  id: string;
  label: string;
  badge: string;
  values: Omit<
    AudioEnhancementSettings,
    'enabled' | 'preset' | 'apply_to_transcription'
  >;
}

const AUDIO_PRESETS: readonly AudioPreset[] = [
  {
    id: 'neutral',
    label: 'Original (Flat)',
    badge: 'Bypass',
    values: {
      noise_reduction: 0.0,
      voice_clarity: 0.0,
      highpass_hz: 80,
      lowpass_hz: 16000,
      volume_db: 0.0,
      normalize_loudness: false,
    },
  },
  {
    id: 'clean_voice',
    label: 'Clean Voice',
    badge: 'Recommended',
    values: {
      noise_reduction: 0.45,
      voice_clarity: 0.35,
      highpass_hz: 95,
      lowpass_hz: 14000,
      volume_db: 1.5,
      normalize_loudness: true,
    },
  },
  {
    id: 'podcast_studio',
    label: 'Podcast Studio',
    badge: 'Presence + Level',
    values: {
      noise_reduction: 0.55,
      voice_clarity: 0.55,
      highpass_hz: 110,
      lowpass_hz: 13500,
      volume_db: 2.5,
      normalize_loudness: true,
    },
  },
  {
    id: 'heavy_denoise',
    label: 'Heavy Denoise',
    badge: 'AC / Traffic',
    values: {
      noise_reduction: 0.85,
      voice_clarity: 0.45,
      highpass_hz: 140,
      lowpass_hz: 11000,
      volume_db: 2.0,
      normalize_loudness: true,
    },
  },
  {
    id: 'outdoor_wind',
    label: 'Outdoor Wind Cut',
    badge: '180Hz Rumble Cut',
    values: {
      noise_reduction: 0.65,
      voice_clarity: 0.4,
      highpass_hz: 180,
      lowpass_hz: 12500,
      volume_db: 1.5,
      normalize_loudness: true,
    },
  },
  {
    id: 'broadcast_warm',
    label: 'Broadcast Warm',
    badge: 'Smooth',
    values: {
      noise_reduction: 0.35,
      voice_clarity: 0.25,
      highpass_hz: 75,
      lowpass_hz: 15000,
      volume_db: 2.0,
      normalize_loudness: true,
    },
  },
];

type NumericAudioKey =
  | 'noise_reduction'
  | 'voice_clarity'
  | 'highpass_hz'
  | 'lowpass_hz'
  | 'volume_db';

interface AudioSliderDescriptor {
  key: NumericAudioKey;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  formatDisplay: (v: number) => string;
}

const AUDIO_SLIDERS: readonly AudioSliderDescriptor[] = [
  {
    key: 'noise_reduction',
    label: 'FFT Background Noise Reduction (afftdn)',
    min: 0.0,
    max: 1.0,
    step: 0.02,
    defaultValue: 0.45,
    formatDisplay: (v) =>
      v <= 0.01 ? 'Off (0%)' : `${Math.round(v * 100)}% (-${(10 + v * 38).toFixed(0)} dB)`,
  },
  {
    key: 'voice_clarity',
    label: 'Voice Clarity / 3kHz Presence Boost',
    min: 0.0,
    max: 1.0,
    step: 0.02,
    defaultValue: 0.35,
    formatDisplay: (v) =>
      v <= 0.01 ? 'Flat (0%)' : `${Math.round(v * 100)}% (+${(v * 6.5).toFixed(1)} dB)`,
  },
  {
    key: 'highpass_hz',
    label: 'Low-Cut Rumble Filter (High-Pass)',
    min: 20,
    max: 300,
    step: 5,
    defaultValue: 95,
    formatDisplay: (v) => `${Math.round(v)} Hz`,
  },
  {
    key: 'lowpass_hz',
    label: 'High-Cut Hiss Roll-Off (Low-Pass)',
    min: 4000,
    max: 20000,
    step: 250,
    defaultValue: 14000,
    formatDisplay: (v) => `${(v / 1000).toFixed(1)} kHz`,
  },
  {
    key: 'volume_db',
    label: 'Output Gain (Volume Trim)',
    min: -12.0,
    max: 12.0,
    step: 0.5,
    defaultValue: 1.5,
    formatDisplay: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
  },
];

export const AudioEnhancementStep: React.FC<AudioEnhancementStepProps> = ({
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
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);

  const audio: AudioEnhancementSettings = settings.audio_enhancement || {
    enabled: true,
    preset: 'clean_voice',
    noise_reduction: 0.45,
    voice_clarity: 0.35,
    highpass_hz: 95,
    lowpass_hz: 14000,
    volume_db: 1.5,
    normalize_loudness: true,
    apply_to_transcription: true,
  };

  const applyPreset = (preset: AudioPreset) => {
    onUpdateSettings((prev) => ({
      ...prev,
      audio_enhancement: {
        ...prev.audio_enhancement,
        enabled: preset.id !== 'neutral',
        preset: preset.id,
        ...preset.values,
      },
    }));
  };

  const handleSliderChange = (key: NumericAudioKey, val: number) => {
    onUpdateSettings((prev) => ({
      ...prev,
      audio_enhancement: {
        ...prev.audio_enhancement,
        enabled: true,
        preset: 'custom',
        [key]: val,
      },
    }));
  };

  const handleResetFlat = () => {
    const cleanDefault = AUDIO_PRESETS[1];
    onUpdateSettings((prev) => ({
      ...prev,
      audio_enhancement: {
        ...prev.audio_enhancement,
        enabled: true,
        preset: 'clean_voice',
        ...cleanDefault.values,
        apply_to_transcription: true,
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

  const inspectorNode = (
    <div className="space-y-5 bg-card/70 border border-border rounded-2xl p-5">
      {/* Enable Toggle & Hold-to-Compare */}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={audio.enabled}
            onChange={(e) => {
              const checked = e.target.checked;
              onUpdateSettings((prev) => {
                const current = prev.audio_enhancement || audio;
                const shouldApplyCleanDefault =
                  checked &&
                  current.noise_reduction === 0 &&
                  current.voice_clarity === 0;
                return {
                  ...prev,
                  audio_enhancement: {
                    ...current,
                    enabled: checked,
                    ...(shouldApplyCleanDefault
                      ? {
                          preset: 'clean_voice',
                          ...AUDIO_PRESETS[1].values,
                        }
                      : {}),
                  },
                };
              });
            }}
            className="h-4 w-4 rounded accent-indigo-500"
          />
          <span className="text-sm font-semibold flex items-center gap-1.5">
            <Volume2 className="h-4 w-4 text-indigo-400" />
            Enable Audio Noise Reduction
          </span>
        </label>

        <div className="flex items-center gap-2">
          {audio.enabled && (
            <button
              type="button"
              onPointerDown={() => setComparingOriginal(true)}
              onPointerUp={() => setComparingOriginal(false)}
              onPointerLeave={() => setComparingOriginal(false)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-muted hover:bg-muted/80 text-[11px] font-medium text-foreground select-none cursor-pointer border border-border"
              title="Press and hold while playing to compare with raw audio"
            >
              <Ear className="h-3 w-3 text-indigo-400" />
              Hold to Compare
            </button>
          )}
          <button
            type="button"
            onClick={handleResetFlat}
            className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>
      </div>

      {/* 6 One-Click Audio Presets */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
          One-Click Voice & Denoise Presets
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {AUDIO_PRESETS.map((preset) => {
            const isSelected =
              preset.id === 'neutral'
                ? !audio.enabled
                : audio.enabled &&
                  (audio.preset === preset.id ||
                    (preset.id === 'clean_voice' &&
                      (!audio.preset || audio.preset === 'none')));
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`px-2.5 py-2 rounded-xl border text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-indigo-600/20 border-indigo-500 text-foreground ring-1 ring-indigo-500/40'
                    : 'bg-background/60 border-border hover:border-indigo-500/40 text-muted-foreground hover:text-foreground'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold truncate">
                    {preset.label}
                  </span>
                  {isSelected && (
                    <Check className="h-3 w-3 text-indigo-400 shrink-0" />
                  )}
                </div>
                <span className="block text-[10px] text-muted-foreground truncate">
                  {preset.badge}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 5 Fine-Tune Sliders */}
      <div className="space-y-3.5 pt-3 border-t border-border">
        {AUDIO_SLIDERS.map((slider) => {
          const val = Number(audio[slider.key] ?? slider.defaultValue);
          const isModified = Math.abs(val - slider.defaultValue) > 0.005;
          return (
            <div key={slider.key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <label
                  htmlFor={`audio-slider-${slider.key}`}
                  className="font-medium text-muted-foreground"
                >
                  {slider.label}
                </label>
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono font-semibold ${
                      isModified && audio.enabled
                        ? 'text-indigo-400'
                        : 'text-foreground'
                    }`}
                  >
                    {slider.formatDisplay(val)}
                  </span>
                  {isModified && (
                    <button
                      type="button"
                      onClick={() =>
                        handleSliderChange(slider.key, slider.defaultValue)
                      }
                      className="text-[10px] text-muted-foreground hover:text-foreground underline"
                    >
                      reset
                    </button>
                  )}
                </div>
              </div>
              <input
                id={`audio-slider-${slider.key}`}
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={val}
                onChange={(e) =>
                  handleSliderChange(slider.key, Number(e.target.value))
                }
                className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-muted rounded-lg"
              />
            </div>
          );
        })}
      </div>

      {/* Speech Leveler & AI Transcription Denoising Options */}
      <div className="pt-3 border-t border-border space-y-2.5">
        <label className="flex items-center gap-2.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={audio.normalize_loudness}
            onChange={(e) =>
              onUpdateSettings((prev) => ({
                ...prev,
                audio_enhancement: {
                  ...prev.audio_enhancement,
                  enabled: true,
                  normalize_loudness: e.target.checked,
                },
              }))
            }
            className="h-3.5 w-3.5 rounded accent-indigo-500"
          />
          <span>
            Enable Dynamic Speech Leveler (<code className="text-[11px]">acompressor</code>) to balance quiet and loud words
          </span>
        </label>

        <label className="flex items-center gap-2.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={audio.apply_to_transcription}
            onChange={(e) =>
              onUpdateSettings((prev) => ({
                ...prev,
                audio_enhancement: {
                  ...prev.audio_enhancement,
                  apply_to_transcription: e.target.checked,
                },
              }))
            }
            className="h-3.5 w-3.5 rounded accent-indigo-500"
          />
          <span className="flex items-center gap-1">
            <Mic className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
            Denoise audio before running AI Subtitle Transcription (improves speech recognition accuracy)
          </span>
        </label>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">
            Step 5: Audio Noise Reduction & Voice Clarity (Optional)
          </h2>
          <p className="text-xs text-muted-foreground">
            Suppress background hum, fan noise, and room hiss using adaptive FFT spectral denoising (`afftdn`), rumble/hiss filters, and 3kHz vocal presence boost.
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
            {saving ? 'Saving...' : 'Continue to Logo'}
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
            bypassAudioEnhancement={comparingOriginal}
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

          {audio.enabled && (
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs">
              <span className="text-indigo-300 font-medium flex items-center gap-1.5">
                <Waves className="h-3.5 w-3.5 text-indigo-400" />
                {comparingOriginal
                  ? 'Listening to Original Unfiltered Audio (Bypassed)'
                  : `Live Audio Denoiser Active (${
                      AUDIO_PRESETS.find((p) => p.id === audio.preset)?.label ||
                      'Custom'
                    })`}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">
                NR {Math.round(audio.noise_reduction * 100)}% · Clarity{' '}
                {Math.round(audio.voice_clarity * 100)}% · HP {audio.highpass_hz}Hz
              </span>
            </div>
          )}
        </div>

        <div className="lg:col-span-5">{!isPreviewFullscreen && inspectorNode}</div>
      </div>
    </div>
  );
};
