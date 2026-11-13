import type { ColorCorrectionSettings } from '@/types/video';

export interface ColorPresetDefinition {
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
