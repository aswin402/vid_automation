import type { AspectRatioPreset, CropSettings, FaceBox } from '@/types/video';

export interface AspectPresetMeta {
  id: AspectRatioPreset;
  label: string;
  subtitle: string;
  previewW: number;
  previewH: number;
}

export const ASPECT_RATIO_PRESETS: AspectPresetMeta[] = [
  { id: 'original', label: 'Original', subtitle: 'Source Ratio', previewW: 16, previewH: 12 },
  { id: '9:16', label: '9:16', subtitle: 'Reels / Shorts', previewW: 9, previewH: 16 },
  { id: '1:1', label: '1:1', subtitle: 'Square Feed', previewW: 13, previewH: 13 },
  { id: '4:5', label: '4:5', subtitle: 'IG / LinkedIn', previewW: 11, previewH: 14 },
  { id: '16:9', label: '16:9', subtitle: 'YouTube HD', previewW: 16, previewH: 9 },
  { id: '4:3', label: '4:3', subtitle: 'Classic TV', previewW: 15, previewH: 11 },
  { id: '21:9', label: '21:9', subtitle: 'Cinema Wide', previewW: 18, previewH: 8 },
  { id: 'custom', label: 'Custom', subtitle: 'Freeform Box', previewW: 14, previewH: 12 },
];

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

export function roundEven(val: number, minEven = 2): number {
  const half = Math.max(1, Math.round(val / 2));
  return Math.max(minEven, half * 2);
}

export function parseAspectRatio(
  preset: string,
  srcW: number,
  srcH: number
): number | null {
  const sw = Math.max(2, srcW);
  const sh = Math.max(2, srcH);
  switch (preset.trim()) {
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
    case '4:5':
      return 4 / 5;
    case '16:9':
      return 16 / 9;
    case '4:3':
      return 4 / 3;
    case '21:9':
      return 21 / 9;
    case 'custom':
      return null;
    default:
      return sw / sh;
  }
}

export function computeAspectCropSize(
  aspectRatio: string,
  srcW: number,
  srcH: number,
  zoom: number
): { width: number; height: number } {
  const z = Math.min(Math.max(zoom || 1, 1), 3);
  const sw = Math.max(2, srcW);
  const sh = Math.max(2, srcH);
  const srcAspect = sw / sh;

  const targetAspect = parseAspectRatio(aspectRatio, sw, sh);
  if (targetAspect === null) {
    const side = Math.min(Math.max(1 / z, 0.05), 1);
    return { width: side, height: side };
  }

  let maxW: number;
  let maxH: number;
  if (targetAspect <= srcAspect) {
    maxW = Math.min(Math.max(targetAspect / srcAspect, 0.05), 1);
    maxH = 1;
  } else {
    maxW = 1;
    maxH = Math.min(Math.max(srcAspect / targetAspect, 0.05), 1);
  }

  return {
    width: Math.min(Math.max(maxW / z, 0.05), 1),
    height: Math.min(Math.max(maxH / z, 0.05), 1),
  };
}

/**
 * Matches backend `resolve_target_output_dimensions` in `crates/celestiavid-core/src/media/crop.rs` 1:1.
 */
export function resolveTargetOutputDimensions(
  cropCfg: CropSettings | undefined | null,
  srcW: number,
  srcH: number,
  explicitW?: number | null,
  explicitH?: number | null
): { width: number; height: number } {
  if (explicitW && explicitH) {
    return {
      width: Math.max(2, Math.floor(explicitW / 2) * 2),
      height: Math.max(2, Math.floor(explicitH / 2) * 2),
    };
  }

  const sw = Math.max(2, Math.floor(srcW / 2) * 2);
  const sh = Math.max(2, Math.floor(srcH / 2) * 2);

  if (!cropCfg || !cropCfg.enabled) {
    return { width: sw, height: sh };
  }

  if (cropCfg.aspect_ratio === 'custom') {
    const cw = roundEven(sw * Math.min(Math.max(cropCfg.width, 0.05), 1), 2);
    const ch = roundEven(sh * Math.min(Math.max(cropCfg.height, 0.05), 1), 2);
    return { width: cw, height: ch };
  }

  if (!cropCfg.aspect_ratio || cropCfg.aspect_ratio === 'original') {
    return { width: sw, height: sh };
  }

  const targetAspect = parseAspectRatio(cropCfg.aspect_ratio, sw, sh);
  if (targetAspect === null) {
    return { width: sw, height: sh };
  }

  const baseDim = Math.max(2, Math.min(sw, sh));
  const maxLong = Math.max(2, Math.max(sw, sh));

  let wF: number;
  let hF: number;
  if (targetAspect < 1 - 1e-4) {
    wF = baseDim;
    hF = baseDim / targetAspect;
  } else if (Math.abs(targetAspect - 1) <= 1e-4) {
    wF = baseDim;
    hF = baseDim;
  } else {
    wF = baseDim * targetAspect;
    hF = baseDim;
  }

  const longest = Math.max(wF, hF);
  if (longest > maxLong * 1.02) {
    const scaleDown = maxLong / longest;
    wF *= scaleDown;
    hF *= scaleDown;
  }

  return {
    width: roundEven(wF, 2),
    height: roundEven(hF, 2),
  };
}

/**
 * Matches backend `compute_face_framed_crop_origin` in `crop.rs` 1:1.
 */
export function computeFaceFramedCropOrigin(
  face: FaceBox,
  cropW: number,
  cropH: number
): { x: number; y: number } {
  const fcx = face.x + face.width * 0.5;
  const fcy = face.y + face.height * 0.5;

  const idealX = fcx - 0.5 * cropW;
  let idealY = fcy - 0.36 * cropH;

  const crownGuardY = face.y - 0.35 * face.height;
  if (idealY > crownGuardY && face.height * 1.65 < cropH) {
    idealY = crownGuardY;
  }

  const maxX = Math.max(0, 1 - cropW);
  const maxY = Math.max(0, 1 - cropH);
  return {
    x: Number(Math.min(Math.max(idealX, 0), maxX).toFixed(4)),
    y: Number(Math.min(Math.max(idealY, 0), maxY).toFixed(4)),
  };
}

/**
 * Evaluates piecewise-linear camera trajectory at `currentTimeMs` matching
 * backend `build_piecewise_linear_ffmpeg_expr` 1:1.
 */
export function interpolateDynamicCropOrigin(
  cropCfg: CropSettings | undefined | null,
  currentTimeMs: number
): { x: number; y: number } {
  if (!cropCfg || !cropCfg.enabled) {
    return { x: 0, y: 0 };
  }
  const wNorm = Math.min(Math.max(cropCfg.width || 1, 0.05), 1);
  const hNorm = Math.min(Math.max(cropCfg.height || 1, 0.05), 1);
  const maxX = Math.max(0, 1 - wNorm);
  const maxY = Math.max(0, 1 - hNorm);

  const kfs = cropCfg.keyframes;
  if (!cropCfg.dynamic_tracking || !kfs || kfs.length < 2) {
    return {
      x: Math.min(Math.max(cropCfg.x || 0, 0), maxX),
      y: Math.min(Math.max(cropCfg.y || 0, 0), maxY),
    };
  }

  if (currentTimeMs <= kfs[0].time_ms) {
    return {
      x: Math.min(Math.max(kfs[0].x, 0), maxX),
      y: Math.min(Math.max(kfs[0].y, 0), maxY),
    };
  }
  const last = kfs[kfs.length - 1];
  if (currentTimeMs >= last.time_ms) {
    return {
      x: Math.min(Math.max(last.x, 0), maxX),
      y: Math.min(Math.max(last.y, 0), maxY),
    };
  }

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (currentTimeMs >= a.time_ms && currentTimeMs <= b.time_ms) {
      const dt = b.time_ms - a.time_ms;
      const t = dt > 0 ? (currentTimeMs - a.time_ms) / dt : 0;
      const ix = a.x + (b.x - a.x) * t;
      const iy = a.y + (b.y - a.y) * t;
      return {
        x: Math.min(Math.max(ix, 0), maxX),
        y: Math.min(Math.max(iy, 0), maxY),
      };
    }
  }

  return {
    x: Math.min(Math.max(cropCfg.x || 0, 0), maxX),
    y: Math.min(Math.max(cropCfg.y || 0, 0), maxY),
  };
}
