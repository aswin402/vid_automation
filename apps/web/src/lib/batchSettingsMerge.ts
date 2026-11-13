import { computeAspectCropSize } from '@/lib/cropMath';
import type { StudioNavbarTab } from '@/store/useWorkflowStore';
import type {
  AudioEnhancementSettings,
  ColorCorrectionSettings,
  CropSettings,
  EditSettings,
  LogoSettings,
  OverridableToolId,
  SubtitleCue,
} from '@/types/video';

export const DEFAULT_LOGO_PRESET: Omit<LogoSettings, 'asset_id'> = {
  enabled: true,
  position: 'bottom-right',
  x_ratio: 0.89,
  y_ratio: 0.68,
  width_ratio: 0.26,
  opacity: 1.0,
  margin_ratio: 0.03,
  apply_to_outro: false,
};

export const DEFAULT_CLEAN_AUDIO_PRESET: AudioEnhancementSettings = {
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

export const DEFAULT_CROP_SETTINGS: CropSettings = {
  enabled: false,
  aspect_ratio: 'original',
  fit_mode: 'crop',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  zoom: 1,
  auto_face_framing: false,
  dynamic_tracking: false,
  detected_face: null,
  keyframes: [],
};

export const SAMPLE_SUBTITLE_CUES: SubtitleCue[] = [
  {
    sequence: 1,
    start_ms: 0,
    end_ms: 600_000,
    text: 'Sample subtitle preview — drag on frame',
  },
];

export interface ColorPresetOption {
  id: string;
  label: string;
  badge: string;
  values: Omit<ColorCorrectionSettings, 'enabled' | 'preset' | 'apply_to_outro'>;
}

export const COLOR_PRESETS: readonly ColorPresetOption[] = [
  {
    id: 'none',
    label: 'Original',
    badge: 'Flat',
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
    id: 'clean_pop',
    label: 'Clean Pop',
    badge: 'Crisp',
    values: {
      brightness: 0.02,
      contrast: 1.1,
      saturation: 1.16,
      gamma: 1.02,
      temperature: 0.04,
      tint: 0.0,
      sharpen: 0.3,
    },
  },
  {
    id: 'warm_golden',
    label: 'Warm Glow',
    badge: 'Golden',
    values: {
      brightness: 0.03,
      contrast: 1.08,
      saturation: 1.14,
      gamma: 1.04,
      temperature: 0.34,
      tint: 0.05,
      sharpen: 0.2,
    },
  },
  {
    id: 'cool_cinema',
    label: 'Cinema Teal',
    badge: 'Film',
    values: {
      brightness: -0.01,
      contrast: 1.16,
      saturation: 0.94,
      gamma: 0.96,
      temperature: -0.3,
      tint: -0.05,
      sharpen: 0.25,
    },
  },
  {
    id: 'crisp_studio',
    label: 'Crisp Studio',
    badge: 'Neutral',
    values: {
      brightness: 0.03,
      contrast: 1.12,
      saturation: 1.06,
      gamma: 1.03,
      temperature: -0.05,
      tint: 0.0,
      sharpen: 0.5,
    },
  },
  {
    id: 'moody_contrast',
    label: 'Moody',
    badge: 'Deep',
    values: {
      brightness: -0.03,
      contrast: 1.24,
      saturation: 0.86,
      gamma: 0.92,
      temperature: -0.1,
      tint: 0.02,
      sharpen: 0.35,
    },
  },
  {
    id: 'soft_daylight',
    label: 'Daylight',
    badge: 'Airy',
    values: {
      brightness: 0.05,
      contrast: 0.96,
      saturation: 1.08,
      gamma: 1.08,
      temperature: 0.14,
      tint: 0.02,
      sharpen: 0.1,
    },
  },
  {
    id: 'vivid_social',
    label: 'Vivid Reels',
    badge: 'Punchy',
    values: {
      brightness: 0.02,
      contrast: 1.15,
      saturation: 1.32,
      gamma: 1.0,
      temperature: 0.08,
      tint: 0.03,
      sharpen: 0.4,
    },
  },
  {
    id: 'noir_bw',
    label: 'Noir B&W',
    badge: 'Mono',
    values: {
      brightness: 0.0,
      contrast: 1.28,
      saturation: 0.0,
      gamma: 0.95,
      temperature: 0.0,
      tint: 0.0,
      sharpen: 0.45,
    },
  },
];

export interface BatchAudioPresetOption {
  id: string;
  label: string;
  hint: string;
  values: Omit<
    AudioEnhancementSettings,
    'enabled' | 'preset' | 'apply_to_transcription'
  >;
}

export const BATCH_AUDIO_PRESETS: readonly BatchAudioPresetOption[] = [
  {
    id: 'clean_voice',
    label: 'Clean Voice',
    hint: 'Balanced noise reduction + vocal clarity (Default)',
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
    label: 'Podcast',
    hint: 'Warm presence boost + dynamic speech leveler',
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
    hint: 'Aggressive background fan, AC & traffic removal',
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
    label: 'Wind Cut',
    hint: '180Hz rumble filter for outdoor recordings',
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
    label: 'Warm',
    hint: 'Smooth broadcast tone with gentle denoise',
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

export const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  validating: 'Validating',
  probing: 'Inspecting',
  auto_framing: 'Face AI',
  transcribing: 'Whisper AI',
  trimming: 'Trim & Crop',
  rendering_main: 'Encoding',
  normalizing_outro: 'Outro Fit',
  joining_outro: 'Joining Outro',
  validating_output: 'Verifying',
  uploading_output: 'Saving MP4',
  completed: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
};

export function studioTabToToolKey(
  tab: StudioNavbarTab
): OverridableToolId | null {
  switch (tab) {
    case 'crop':
      return 'crop';
    case 'subtitles':
      return 'subtitles';
    case 'color':
      return 'color';
    case 'audio':
      return 'audio';
    case 'logo':
      return 'logo';
    case 'outro':
      return 'outro';
    case 'export':
      return 'output';
    case 'trim':
    default:
      return null;
  }
}

export function isToolOverriddenOnSettings(
  settings: EditSettings,
  tool: OverridableToolId | null
): boolean {
  if (!tool) return false;
  return Boolean(settings.overridden_tools?.includes(tool));
}

export function addOverriddenTool(
  existing: string[] | undefined,
  tool: OverridableToolId | null
): string[] {
  const list = existing ? [...existing] : [];
  if (tool && !list.includes(tool)) {
    list.push(tool);
  }
  return list;
}

export function removeOverriddenTool(
  existing: string[] | undefined,
  tool: OverridableToolId
): string[] {
  return (existing ?? []).filter((t) => t !== tool);
}

/**
 * Merges live Master Control (`master`) into an individual video row's `itemSettings`,
 * inheriting all tools NOT listed in `itemSettings.overridden_tools` while preserving per-video `trim`
 * and per-video `logo.asset_id` / `outro.asset_id`.
 */
export function mergeLiveMasterIntoRowSettings(
  master: EditSettings,
  itemSettings: EditSettings,
  options?: {
    hasLogoAsset?: boolean;
    hasOutroAsset?: boolean;
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  }
): EditSettings {
  const overrides = itemSettings.overridden_tools ?? [];
  const hasOverride = (tool: OverridableToolId) => overrides.includes(tool);

  let mergedCrop: CropSettings;
  if (hasOverride('crop')) {
    mergedCrop = itemSettings.crop;
  } else {
    const baseCrop = master.crop || DEFAULT_CROP_SETTINGS;
    if (
      baseCrop.enabled &&
      baseCrop.aspect_ratio !== 'original' &&
      baseCrop.aspect_ratio !== 'custom'
    ) {
      const sw = options?.sourceWidth || 1920;
      const sh = options?.sourceHeight || 1080;
      const box = computeAspectCropSize(
        baseCrop.aspect_ratio,
        sw,
        sh,
        Math.max(1, baseCrop.zoom || 1)
      );
      const centeredX = Math.max(0, Math.min(1 - box.width, (1 - box.width) / 2));
      const centeredY = Math.max(
        0,
        Math.min(1 - box.height, (1 - box.height) / 2)
      );
      const sameFaceContext =
        itemSettings.crop?.aspect_ratio === baseCrop.aspect_ratio &&
        Math.abs((itemSettings.crop?.zoom || 1) - (baseCrop.zoom || 1)) < 1e-4 &&
        Boolean(itemSettings.crop?.auto_face_framing) ===
          Boolean(baseCrop.auto_face_framing) &&
        itemSettings.crop?.detected_face !== null;

      mergedCrop = {
        ...baseCrop,
        width: box.width,
        height: box.height,
        x: sameFaceContext ? itemSettings.crop.x : centeredX,
        y: sameFaceContext ? itemSettings.crop.y : centeredY,
        detected_face: sameFaceContext ? itemSettings.crop.detected_face : null,
        keyframes: sameFaceContext ? itemSettings.crop.keyframes : [],
      };
    } else {
      mergedCrop = {
        ...baseCrop,
        detected_face: null,
        keyframes: [],
      };
    }
  }

  const baseLogo = hasOverride('logo') ? itemSettings.logo : master.logo;
  const baseOutro = hasOverride('outro') ? itemSettings.outro : master.outro;

  return {
    ...itemSettings,
    trim: itemSettings.trim,
    crop: mergedCrop,
    subtitles: hasOverride('subtitles')
      ? itemSettings.subtitles
      : master.subtitles,
    color_correction: hasOverride('color')
      ? itemSettings.color_correction
      : master.color_correction,
    audio_enhancement: hasOverride('audio')
      ? itemSettings.audio_enhancement
      : master.audio_enhancement,
    logo: {
      ...baseLogo,
      asset_id: itemSettings.logo.asset_id,
      enabled: Boolean(baseLogo.enabled),
    },
    outro: {
      ...baseOutro,
      asset_id: itemSettings.outro.asset_id,
      enabled:
        options?.hasOutroAsset === false
          ? false
          : Boolean(baseOutro.enabled),
    },
    output: hasOverride('output') ? itemSettings.output : master.output,
    overridden_tools: overrides,
  };
}
