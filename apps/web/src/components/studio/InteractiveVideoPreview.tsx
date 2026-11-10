import React, { useEffect, useId, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Move, Eye } from 'lucide-react';
import { formatTimecode } from '@/lib/timecode';
import type {
  AnchorPosition,
  Asset,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

interface InteractiveVideoPreviewProps {
  sourceAsset: Asset | undefined;
  logoAsset: Asset | undefined;
  settings: EditSettings;
  cues: SubtitleCue[];
  currentTimeMs: number;
  onTimeUpdate?: (trimmedRelativeMs: number) => void;
  dragMode?: 'none' | 'logo' | 'subtitles';
  onDragLogo?: (xRatio: number, yRatio: number) => void;
  onDragSubtitle?: (xRatio: number, yRatio: number) => void;
  bypassColorCorrection?: boolean;
}

const ANCHOR_VECTORS: Record<AnchorPosition, readonly [number, number]> = {
  'top-left': [0.0, 0.0],
  'top-center': [0.5, 0.0],
  'top-right': [1.0, 0.0],
  'middle-left': [0.0, 0.5],
  center: [0.5, 0.5],
  'middle-right': [1.0, 0.5],
  'bottom-left': [0.0, 1.0],
  'bottom-center': [0.5, 1.0],
  'bottom-right': [1.0, 1.0],
};

/**
 * Matches backend `compute_logo_overlay_expressions` + `affine_overlay_expressions` in `pipeline.py` & `geometry.py`:
 *   x(ax, mx) = W*mx + ax*(W - w - 2*W*mx)
 *   y(ay, my) = H*my + ay*(H - h - 2*H*my)
 * In CSS:
 *   left = (mx + ax*(1 - 2*mx))*W, transformX = -ax*w
 *   => x_CSS = (mx + ax*(1 - 2*mx))*W - ax*w = W*mx + ax*(W - w - 2*W*mx) === x_FFmpeg
 */
function getLogoAnchorStyle(
  position: AnchorPosition,
  marginRatio: number,
  xRatio: number | null,
  yRatio: number | null
): React.CSSProperties {
  const hasCustom = xRatio !== null && yRatio !== null;
  const [presetAx, presetAy] = ANCHOR_VECTORS[position] ?? [1.0, 0.0];
  const ax = Math.min(Math.max(hasCustom ? Number(xRatio) : presetAx, 0), 1);
  const ay = Math.min(Math.max(hasCustom ? Number(yRatio) : presetAy, 0), 1);
  const mPct = hasCustom ? 0 : Math.min(Math.max(marginRatio, 0), 0.25) * 100;

  const leftPct = mPct + ax * (100 - 2 * mPct);
  const topPct = mPct + ay * (100 - 2 * mPct);

  return {
    left: `${leftPct}%`,
    top: `${topPct}%`,
    transform: `translate(${-100 * ax}%, ${-100 * ay}%)`,
  };
}

/**
 * Matches backend `generate_ass_content` in `ass_generator.py`:
 * - Custom (x_ratio, y_ratio): uses `{\an5\pos(px, py)}` (center-aligned at (x_ratio*W, y_ratio*H))
 * - Preset 9-grid position: uses ASS numpad Alignment (1..9) with MarginV and MarginL/MarginR
 */
function getSubtitleAnchorStyle(
  position: AnchorPosition,
  marginVRatio: number,
  marginHRatio: number,
  xRatio: number | null,
  yRatio: number | null
): React.CSSProperties {
  if (xRatio !== null && yRatio !== null) {
    const clampedX = Math.min(Math.max(Number(xRatio), 0.05), 0.95);
    const clampedY = Math.min(Math.max(Number(yRatio), 0.05), 0.95);
    return {
      left: `${clampedX * 100}%`,
      top: `${clampedY * 100}%`,
      transform: 'translate(-50%, -50%)',
    };
  }

  const [ax, ay] = ANCHOR_VECTORS[position] ?? [0.5, 1.0];
  const marginHPct = Math.min(Math.max(marginHRatio, 0), 0.25) * 100;
  const marginVPct = Math.min(Math.max(marginVRatio, 0), 0.25) * 100;

  const leftPct = marginHPct + ax * (100 - 2 * marginHPct);
  const topPct = marginVPct + ay * (100 - 2 * marginVPct);

  return {
    left: `${leftPct}%`,
    top: `${topPct}%`,
    transform: `translate(${-100 * ax}%, ${-100 * ay}%)`,
  };
}

const MAX_STAGE_HEIGHT_PX = 460;

export const InteractiveVideoPreview: React.FC<InteractiveVideoPreviewProps> = ({
  sourceAsset,
  logoAsset,
  settings,
  cues,
  currentTimeMs,
  onTimeUpdate,
  dragMode = 'none',
  onDragLogo,
  onDragSubtitle,
  bypassColorCorrection = false,
}) => {
  const rawFilterId = useId();
  const svgFilterId = `cc-grade-${rawFilterId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const logoRef = useRef<HTMLDivElement | null>(null);
  const subtitleRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [activeDragTarget, setActiveDragTarget] = useState<'none' | 'logo' | 'subtitles'>('none');
  const dragOffsetRef = useRef<{ offsetX: number; offsetY: number }>({
    offsetX: 0,
    offsetY: 0,
  });

  const [intrinsicVideoSize, setIntrinsicVideoSize] = useState<{
    width: number;
    height: number;
  }>({
    width: sourceAsset?.width || 1920,
    height: sourceAsset?.height || 1080,
  });

  const [stageWidth, setStageWidth] = useState<number>(640);

  useEffect(() => {
    if (sourceAsset?.width && sourceAsset?.height) {
      setIntrinsicVideoSize({
        width: sourceAsset.width,
        height: sourceAsset.height,
      });
    }
  }, [sourceAsset?.width, sourceAsset?.height]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = el.clientWidth - 16;
      if (w > 80) setStageWidth(w);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const videoW = Math.max(2, intrinsicVideoSize.width);
  const videoH = Math.max(2, intrinsicVideoSize.height);
  const scale = Math.min(stageWidth / videoW, MAX_STAGE_HEIGHT_PX / videoH);
  const frameWidth = Math.max(120, Math.round(videoW * scale));
  const frameHeight = Math.max(120, Math.round(videoH * scale));

  const sourceDurationMs = sourceAsset?.duration_ms || 10000;
  const trimStartMs = settings.trim.start_ms || 0;
  const trimEndMs = settings.trim.end_ms || sourceDurationMs;
  const trimmedDurationMs = Math.max(200, trimEndMs - trimStartMs);

  // Sync external seek changes when paused
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || isPlaying) return;
    const targetSec = (trimStartMs + currentTimeMs) / 1000;
    if (Math.abs(vid.currentTime - targetSec) > 0.15) {
      vid.currentTime = targetSec;
    }
  }, [currentTimeMs, trimStartMs, isPlaying]);

  const handleVideoTimeUpdate = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const absMs = Math.round(vid.currentTime * 1000);
    if (absMs >= trimEndMs) {
      vid.pause();
      vid.currentTime = trimStartMs / 1000;
      setIsPlaying(false);
      onTimeUpdate?.(0);
      return;
    }
    const relMs = Math.max(0, Math.min(trimmedDurationMs, absMs - trimStartMs));
    onTimeUpdate?.(relMs);
  };

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      const absMs = vid.currentTime * 1000;
      if (absMs < trimStartMs || absMs >= trimEndMs - 100) {
        vid.currentTime = trimStartMs / 1000;
      }
      vid
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      vid.pause();
      setIsPlaying(false);
    }
  };

  const restartClip = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.currentTime = trimStartMs / 1000;
    onTimeUpdate?.(0);
  };

  const canDragLogo = Boolean(onDragLogo) || dragMode === 'logo';
  const canDragSubtitle = Boolean(onDragSubtitle) || dragMode === 'subtitles';

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeDragTarget === 'none' || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (activeDragTarget === 'logo' && onDragLogo) {
      const logoW = logoRef.current?.offsetWidth || rect.width * (settings.logo.width_ratio || 0.14);
      const logoH = logoRef.current?.offsetHeight || logoW;
      const availW = Math.max(1, rect.width - logoW);
      const availH = Math.max(1, rect.height - logoH);

      const targetLeft = e.clientX - rect.left - dragOffsetRef.current.offsetX;
      const targetTop = e.clientY - rect.top - dragOffsetRef.current.offsetY;

      const xRatio = Math.min(Math.max(targetLeft / availW, 0.0), 1.0);
      const yRatio = Math.min(Math.max(targetTop / availH, 0.0), 1.0);
      onDragLogo(Number(xRatio.toFixed(4)), Number(yRatio.toFixed(4)));
    } else if (activeDragTarget === 'subtitles' && onDragSubtitle) {
      const targetCenterX = e.clientX - rect.left - dragOffsetRef.current.offsetX;
      const targetCenterY = e.clientY - rect.top - dragOffsetRef.current.offsetY;

      const xRatio = Math.min(Math.max(targetCenterX / rect.width, 0.05), 0.95);
      const yRatio = Math.min(Math.max(targetCenterY / rect.height, 0.05), 0.95);
      onDragSubtitle(Number(xRatio.toFixed(4)), Number(yRatio.toFixed(4)));
    }
  };

  // Find active subtitle cue at currentTimeMs (or fallback to nearest/first cue when paused so user can always position subtitles)
  const activeCue = cues.find(
    (c) => currentTimeMs >= c.start_ms && currentTimeMs <= c.end_ms
  );
  const fallbackCue = !isPlaying && cues.length > 0 ? cues[0] : null;
  const previewCueText =
    activeCue?.text ||
    (fallbackCue && (settings.subtitles.enabled || dragMode === 'subtitles')
      ? fallbackCue.text
      : dragMode === 'subtitles'
      ? 'Sample AI subtitle preview text'
      : null);

  const logoCfg = settings.logo;
  const subCfg = settings.subtitles;
  const styleCfg = subCfg.style;
  const colorCfg = settings.color_correction;

  // Compute 1:1 color correction filter matching backend `build_color_correction_filter` in `pipeline.py`
  const isColorActive = Boolean(colorCfg?.enabled && !bypassColorCorrection);
  const ccBrightness = isColorActive ? (colorCfg?.brightness ?? 0) : 0;
  const ccContrast = isColorActive ? (colorCfg?.contrast ?? 1) : 1;
  const ccSaturation = isColorActive ? (colorCfg?.saturation ?? 1) : 1;
  const ccGamma = isColorActive ? Math.min(Math.max(colorCfg?.gamma ?? 1, 0.5), 2.0) : 1;
  const ccTemp = isColorActive ? Math.min(Math.max(colorCfg?.temperature ?? 0, -1), 1) : 0;
  const ccTint = isColorActive ? Math.min(Math.max(colorCfg?.tint ?? 0, -1), 1) : 0;
  const ccSharpen = isColorActive ? Math.min(Math.max(colorCfg?.sharpen ?? 0, 0), 1.5) : 0;

  const rGain = Math.min(Math.max(1.0 + 0.18 * ccTemp + 0.08 * ccTint, 0.5), 1.6);
  const gGain = Math.min(Math.max(1.0 + 0.03 * ccTemp - 0.14 * ccTint, 0.5), 1.6);
  const bGain = Math.min(Math.max(1.0 - 0.18 * ccTemp + 0.08 * ccTint, 0.5), 1.6);
  const gammaExponent = Number((1.0 / ccGamma).toFixed(4));

  const videoCssFilter = isColorActive
    ? `brightness(${(1 + ccBrightness).toFixed(4)}) contrast(${ccContrast.toFixed(
        4
      )}) saturate(${ccSaturation.toFixed(4)}) url(#${svgFilterId})`
    : undefined;

  // Exact ASS font & border scaling relative to the true video frame dimensions
  const refDim = Math.min(videoW, videoH);
  const assScaleRatio = refDim / 1080.0;
  const scaledAssFontSize = Math.max(
    14,
    Math.round((styleCfg.font_size || 42) * assScaleRatio)
  );
  // libass Fontsize is GDI tmHeight (~1.25x CSS em font-size)
  const previewFontSizePx = Math.max(6, scaledAssFontSize * scale * 0.8);
  const previewOutlinePx = styleCfg.outline_enabled
    ? Math.max(0.5, (styleCfg.outline_thickness || 3) * assScaleRatio * scale)
    : 0;
  const previewShadowPx = styleCfg.shadow_enabled
    ? Math.max(0.5, (styleCfg.shadow_depth || 2) * assScaleRatio * scale)
    : 0;
  const marginHRatio = styleCfg.margin_h_ratio ?? 0.05;
  const marginVRatio = styleCfg.margin_v_ratio ?? 0.06;

  return (
    <div className="space-y-2.5">
      {/* Hidden SVG filter definition for exact Gamma + Temperature/Tint RGB channel gains + Sharpness */}
      <svg className="sr-only" aria-hidden="true" width="0" height="0">
        <defs>
          <filter id={svgFilterId} colorInterpolationFilters="sRGB">
            <feComponentTransfer result="gammaCorrected">
              <feFuncR type="gamma" amplitude="1" exponent={gammaExponent} offset="0" />
              <feFuncG type="gamma" amplitude="1" exponent={gammaExponent} offset="0" />
              <feFuncB type="gamma" amplitude="1" exponent={gammaExponent} offset="0" />
            </feComponentTransfer>
            <feColorMatrix
              in="gammaCorrected"
              type="matrix"
              values={`${rGain.toFixed(4)} 0 0 0 0  0 ${gGain.toFixed(4)} 0 0 0  0 0 ${bGain.toFixed(4)} 0 0  0 0 0 1 0`}
              result="tempTintCorrected"
            />
            {ccSharpen > 0.01 && (
              <feConvolveMatrix
                in="tempTintCorrected"
                order="3"
                kernelMatrix={`0 ${(-0.25 * ccSharpen).toFixed(3)} 0 ${(-0.25 * ccSharpen).toFixed(3)} ${(1 + ccSharpen).toFixed(3)} ${(-0.25 * ccSharpen).toFixed(3)} 0 ${(-0.25 * ccSharpen).toFixed(3)} 0`}
                preserveAlpha="true"
              />
            )}
          </filter>
        </defs>
      </svg>

      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/90">
          <Eye className="h-3.5 w-3.5 text-indigo-400" />
          WYSIWYG Frame Preview ({videoW}×{videoH})
        </span>
        <span className="text-[11px] bg-muted/60 border border-border px-2 py-0.5 rounded-md">
          1:1 frame-accurate coordinate mapping
        </span>
      </div>

      {/* Outer Dark Stage */}
      <div
        ref={stageRef}
        className="w-full flex items-center justify-center bg-black/95 rounded-xl border border-border p-2 shadow-inner overflow-hidden"
      >
        {/* Exact Aspect-Ratio Video Frame Container */}
        <div
          ref={containerRef}
          style={{
            width: `${frameWidth}px`,
            height: `${frameHeight}px`,
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={() => setActiveDragTarget('none')}
          onPointerLeave={() => setActiveDragTarget('none')}
          className="relative bg-black overflow-hidden select-none shadow-md"
        >
          {sourceAsset?.stream_url ? (
            <video
              ref={videoRef}
              src={sourceAsset.stream_url}
              style={{ filter: videoCssFilter }}
              className="w-full h-full object-fill block"
              playsInline
              onTimeUpdate={handleVideoTimeUpdate}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onLoadedMetadata={() => {
                const vid = videoRef.current;
                if (vid) {
                  if (vid.videoWidth > 0 && vid.videoHeight > 0) {
                    setIntrinsicVideoSize({
                      width: vid.videoWidth,
                      height: vid.videoHeight,
                    });
                  }
                  vid.currentTime = trimStartMs / 1000;
                }
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
              Upload a source video to preview
            </div>
          )}

          {/* Brand Logo Overlay */}
          {logoCfg.enabled && logoAsset?.stream_url && (
            <div
              ref={logoRef}
              onPointerDown={(e) => {
                if (canDragLogo && logoRef.current) {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const r = logoRef.current.getBoundingClientRect();
                  dragOffsetRef.current = {
                    offsetX: e.clientX - r.left,
                    offsetY: e.clientY - r.top,
                  };
                  setActiveDragTarget('logo');
                }
              }}
              style={{
                ...getLogoAnchorStyle(
                  logoCfg.position,
                  logoCfg.margin_ratio ?? 0.03,
                  logoCfg.x_ratio,
                  logoCfg.y_ratio
                ),
                width: `${Math.min(Math.max(logoCfg.width_ratio || 0.14, 0.03), 0.5) * 100}%`,
                opacity: logoCfg.opacity ?? 1.0,
              }}
              className={`absolute z-10 transition-shadow ${
                canDragLogo
                  ? 'hover:ring-2 hover:ring-indigo-400/80 rounded cursor-grab active:cursor-grabbing'
                  : 'pointer-events-none'
              } ${activeDragTarget === 'logo' ? 'ring-2 ring-indigo-400 shadow-lg' : ''}`}
            >
              <img
                src={logoAsset.stream_url}
                alt="Brand logo overlay"
                className="w-full h-auto object-contain block"
                draggable={false}
              />
            </div>
          )}

          {/* Subtitle Overlay */}
          {(subCfg.enabled || dragMode === 'subtitles') && previewCueText && (
            <div
              ref={subtitleRef}
              onPointerDown={(e) => {
                if (canDragSubtitle && subtitleRef.current) {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const r = subtitleRef.current.getBoundingClientRect();
                  const centerX = r.left + r.width / 2;
                  const centerY = r.top + r.height / 2;
                  dragOffsetRef.current = {
                    offsetX: e.clientX - centerX,
                    offsetY: e.clientY - centerY,
                  };
                  setActiveDragTarget('subtitles');
                }
              }}
              style={{
                ...getSubtitleAnchorStyle(
                  styleCfg.position,
                  marginVRatio,
                  marginHRatio,
                  styleCfg.x_ratio,
                  styleCfg.y_ratio
                ),
                width: 'max-content',
                maxWidth: `${Math.max(40, (1 - 2 * marginHRatio) * 100)}%`,
                textAlign: styleCfg.alignment || 'center',
              }}
              className={`absolute z-20 rounded transition-shadow ${
                canDragSubtitle
                  ? 'hover:ring-2 hover:ring-indigo-400/80 cursor-grab active:cursor-grabbing'
                  : 'pointer-events-none'
              } ${activeDragTarget === 'subtitles' ? 'ring-2 ring-indigo-400' : ''}`}
            >
              <span
                style={{
                  fontFamily: `"${styleCfg.font_family || 'DejaVu Sans'}", sans-serif`,
                  fontSize: `${previewFontSizePx.toFixed(2)}px`,
                  fontWeight: 700,
                  color: styleCfg.text_color || '#FFFFFF',
                  backgroundColor: styleCfg.background_enabled
                    ? `${styleCfg.background_color || '#000000'}${Math.round(
                        (styleCfg.background_opacity ?? 0.65) * 255
                      )
                        .toString(16)
                        .padStart(2, '0')}`
                    : 'transparent',
                  padding: styleCfg.background_enabled
                    ? `${Math.max(2, Math.round(4 * scale))}px ${Math.max(4, Math.round(8 * scale))}px`
                    : '0px',
                  borderRadius: `${Math.max(2, Math.round(4 * scale))}px`,
                  WebkitTextStroke:
                    styleCfg.outline_enabled && !styleCfg.background_enabled
                      ? `${previewOutlinePx.toFixed(2)}px ${styleCfg.outline_color || '#000000'}`
                      : undefined,
                  paintOrder: 'stroke fill',
                  textShadow:
                    styleCfg.shadow_enabled && !styleCfg.background_enabled
                      ? `${previewShadowPx.toFixed(1)}px ${previewShadowPx.toFixed(1)}px ${Math.max(
                          1,
                          previewShadowPx * 1.2
                        ).toFixed(1)}px rgba(0,0,0,0.85)`
                      : undefined,
                  whiteSpace: 'pre-line',
                  lineHeight: 1.2,
                }}
                className="inline-block"
              >
                {previewCueText}
              </span>
            </div>
          )}

          {(canDragLogo || canDragSubtitle) && (
            <div className="absolute top-2 left-2 z-30 bg-black/75 backdrop-blur-sm text-white text-[10px] px-2 py-1 rounded-md flex items-center gap-1.5 border border-white/15 pointer-events-none">
              <Move className="h-3 w-3 text-indigo-400" />
              Drag logo or subtitles directly on frame
            </div>
          )}
        </div>
      </div>

      {/* Playback Transport Bar */}
      <div className="flex items-center gap-3 bg-card/80 border border-border rounded-xl px-3 py-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause preview' : 'Play trimmed selection'}
          className="h-8 w-8 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-colors shrink-0"
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
        </button>
        <button
          type="button"
          onClick={restartClip}
          aria-label="Restart selection"
          title="Restart trimmed selection"
          className="h-8 w-8 rounded-lg bg-muted hover:bg-muted/80 text-foreground flex items-center justify-center transition-colors shrink-0"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        <input
          type="range"
          aria-label="Scrub trimmed clip timeline"
          min={0}
          max={trimmedDurationMs}
          step={50}
          value={Math.min(currentTimeMs, trimmedDurationMs)}
          onChange={(e) => {
            const val = Number(e.target.value);
            onTimeUpdate?.(val);
            if (videoRef.current) {
              videoRef.current.currentTime = (trimStartMs + val) / 1000;
            }
          }}
          className="flex-1 accent-indigo-500 h-1.5 bg-muted rounded-lg cursor-pointer"
        />

        <div className="text-xs font-mono text-muted-foreground shrink-0">
          <span className="text-foreground font-medium">{formatTimecode(currentTimeMs)}</span>
          {' / '}
          <span>{formatTimecode(trimmedDurationMs)}</span>
        </div>
      </div>
    </div>
  );
};
