import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Move,
  ScanFace,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  SplitSquareHorizontal,
  RectangleHorizontal,
  Columns2,
  Maximize,
  Minimize,
  SlidersHorizontal,
  GripHorizontal,
  PanelLeft,
  PanelRight,
  X,
  Scissors,
  Crop,
  Subtitles,
  Sliders,
  Image as ImageIcon,
  Film,
  Settings2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { HintTooltip } from '@/components/ui/tooltip';
import { formatTimecode } from '@/lib/timecode';
import {
  computeAspectCropSize,
  interpolateDynamicCropOrigin,
  resolveTargetOutputDimensions,
} from '@/lib/cropMath';
import {
  useWorkflowStore,
  type StudioNavbarTab,
} from '@/store/useWorkflowStore';
import type {
  AnchorPosition,
  Asset,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

const FULLSCREEN_STUDIO_TABS: ReadonlyArray<{
  id: StudioNavbarTab;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'trim', label: 'Trim', hint: 'Trim In / Out Points', icon: Scissors },
  { id: 'crop', label: 'Ratio & Face', hint: 'Aspect Ratio, Pan/Zoom & Face AI', icon: Crop },
  { id: 'subtitles', label: 'Subtitles', hint: 'AI Captions, Cue Editor & Style', icon: Subtitles },
  { id: 'color', label: 'Color', hint: 'Color Grading & LUT Presets', icon: Sliders },
  { id: 'audio', label: 'Audio', hint: 'Denoise, EQ & Loudness', icon: Volume2 },
  { id: 'logo', label: 'Logo', hint: 'Brand Watermark Overlay', icon: ImageIcon },
  { id: 'outro', label: 'Outro', hint: 'End Card Concatenation', icon: Film },
  { id: 'export', label: 'Output', hint: 'Resolution, FPS, CRF & Speed', icon: Settings2 },
];

export interface CropBoxPatch {
  x: number;
  y: number;
  width?: number;
  height?: number;
  zoom?: number;
}

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
  bypassAudioEnhancement?: boolean;
  cropEditorMode?: boolean;
  onUpdateCropBox?: (patch: CropBoxPatch) => void;
  wideMode?: boolean;
  onToggleWideMode?: () => void;
  fullscreenInspector?: React.ReactNode;
  enableFullscreenToolTabs?: boolean;
  onFullscreenChange?: (active: boolean) => void;
}

interface WebAudioFilterGraph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  highpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  rumbleAtten: BiquadFilterNode;
  hissAtten: BiquadFilterNode;
  voiceClarity: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  outputGain: GainNode;
}

const mediaAudioGraphMap = new WeakMap<HTMLVideoElement, WebAudioFilterGraph>();

function getOrCreateAudioGraph(
  videoEl: HTMLVideoElement
): WebAudioFilterGraph | null {
  const existing = mediaAudioGraphMap.get(videoEl);
  if (existing) return existing;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    const source = ctx.createMediaElementSource(videoEl);

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.Q.value = 0.707;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.Q.value = 0.707;

    const rumbleAtten = ctx.createBiquadFilter();
    rumbleAtten.type = 'peaking';
    rumbleAtten.frequency.value = 210;
    rumbleAtten.Q.value = 0.9;

    const hissAtten = ctx.createBiquadFilter();
    hissAtten.type = 'highshelf';
    hissAtten.frequency.value = 5200;

    const voiceClarity = ctx.createBiquadFilter();
    voiceClarity.type = 'peaking';
    voiceClarity.frequency.value = 3000;
    voiceClarity.Q.value = 1.2;

    const compressor = ctx.createDynamicsCompressor();
    compressor.knee.value = 12;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.18;

    const outputGain = ctx.createGain();

    source
      .connect(highpass)
      .connect(lowpass)
      .connect(rumbleAtten)
      .connect(hissAtten)
      .connect(voiceClarity)
      .connect(compressor)
      .connect(outputGain)
      .connect(ctx.destination);

    const graph: WebAudioFilterGraph = {
      ctx,
      source,
      highpass,
      lowpass,
      rumbleAtten,
      hissAtten,
      voiceClarity,
      compressor,
      outputGain,
    };
    mediaAudioGraphMap.set(videoEl, graph);
    return graph;
  } catch {
    return null;
  }
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

const MAX_STAGE_HEIGHT_PX = 450;
const WIDE_STAGE_HEIGHT_PX = 620;
const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2, 0.5] as const;

type CropHandleMode = 'none' | 'pan' | 'nw' | 'ne' | 'sw' | 'se';

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
  bypassAudioEnhancement = false,
  cropEditorMode = false,
  onUpdateCropBox,
  wideMode,
  onToggleWideMode,
  fullscreenInspector,
  enableFullscreenToolTabs = false,
  onFullscreenChange,
}) => {
  const rawFilterId = useId();
  const svgFilterId = `cc-grade-${rawFilterId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const logoRef = useRef<HTMLDivElement | null>(null);
  const subtitleRef = useRef<HTMLDivElement | null>(null);
  const floatingEditorRef = useRef<HTMLDivElement | null>(null);

  const activeStudioTab = useWorkflowStore((s) => s.activeStudioTab);
  const setActiveStudioTab = useWorkflowStore((s) => s.setActiveStudioTab);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [localCompareRaw, setLocalCompareRaw] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFullscreenEditorOpen, setIsFullscreenEditorOpen] = useState(true);
  const [floatingDockSide, setFloatingDockSide] = useState<'right' | 'left'>('right');
  const [floatingPos, setFloatingPos] = useState<{ x: number; y: number } | null>(null);
  const floatingDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [internalWideMode, setInternalWideMode] = useState(false);
  const [fullscreenStageHeight, setFullscreenStageHeight] = useState<number>(720);

  const effectiveWideMode = wideMode ?? internalWideMode;

  const [activeDragTarget, setActiveDragTarget] = useState<
    'none' | 'logo' | 'subtitles'
  >('none');
  const dragOffsetRef = useRef<{ offsetX: number; offsetY: number }>({
    offsetX: 0,
    offsetY: 0,
  });

  const [activeCropHandle, setActiveCropHandle] =
    useState<CropHandleMode>('none');
  const cropDragStartRef = useRef<{
    mode: CropHandleMode;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startZoom: number;
  } | null>(null);

  const [loadedVideoMeta, setLoadedVideoMeta] = useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);

  const [stageWidth, setStageWidth] = useState<number>(640);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const reservedVertical = enableFullscreenToolTabs ? 136 : 96;
    const updateSize = () => {
      const w = el.clientWidth - 16;
      if (w > 80) setStageWidth(w);
      if (document.fullscreenElement === previewRootRef.current) {
        setFullscreenStageHeight(Math.max(240, window.innerHeight - reservedVertical));
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [isFullscreen, effectiveWideMode, enableFullscreenToolTabs]);

  const onFullscreenChangeRef = useRef(onFullscreenChange);
  useEffect(() => {
    onFullscreenChangeRef.current = onFullscreenChange;
  }, [onFullscreenChange]);

  useEffect(() => {
    const handleFsChange = () => {
      const active = document.fullscreenElement === previewRootRef.current;
      setIsFullscreen(active);
      onFullscreenChangeRef.current?.(active);
      if (active) {
        const reservedVertical = enableFullscreenToolTabs ? 136 : 96;
        setFullscreenStageHeight(Math.max(240, window.innerHeight - reservedVertical));
      } else {
        setFloatingPos(null);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, [enableFullscreenToolTabs]);

  const activeLoadedSize =
    loadedVideoMeta && loadedVideoMeta.src === sourceAsset?.stream_url
      ? loadedVideoMeta
      : null;

  const srcVideoW = Math.max(
    2,
    activeLoadedSize?.width || sourceAsset?.width || 1920
  );
  const srcVideoH = Math.max(
    2,
    activeLoadedSize?.height || sourceAsset?.height || 1080
  );
  const cropCfg = settings.crop;
  const isCropEnabled = Boolean(cropCfg?.enabled);

  const targetOutDims = resolveTargetOutputDimensions(
    cropCfg,
    srcVideoW,
    srcVideoH,
    settings.output?.width,
    settings.output?.height
  );

  const videoW = cropEditorMode ? srcVideoW : targetOutDims.width;
  const videoH = cropEditorMode ? srcVideoH : targetOutDims.height;

  const maxStageHeight = isFullscreen
    ? fullscreenStageHeight
    : effectiveWideMode
    ? WIDE_STAGE_HEIGHT_PX
    : MAX_STAGE_HEIGHT_PX;

  const scale = Math.min(stageWidth / videoW, maxStageHeight / videoH);
  const frameWidth = Math.max(96, Math.round(videoW * scale));
  const frameHeight = Math.max(96, Math.round(videoH * scale));

  const sourceDurationMs = sourceAsset?.duration_ms || 10000;
  const trimStartMs = settings.trim.start_ms || 0;
  const trimEndMs = settings.trim.end_ms || sourceDurationMs;
  const trimmedDurationMs = Math.max(200, trimEndMs - trimStartMs);

  const activeCropW = isCropEnabled
    ? Math.min(Math.max(cropCfg?.width || 1, 0.05), 1)
    : 1;
  const activeCropH = isCropEnabled
    ? Math.min(Math.max(cropCfg?.height || 1, 0.05), 1)
    : 1;
  const dynamicOrigin = interpolateDynamicCropOrigin(cropCfg, currentTimeMs);
  const activeCropX = isCropEnabled ? dynamicOrigin.x : 0;
  const activeCropY = isCropEnabled ? dynamicOrigin.y : 0;

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || isPlaying) return;
    const targetSec = (trimStartMs + currentTimeMs) / 1000;
    if (Math.abs(vid.currentTime - targetSec) > 0.15) {
      vid.currentTime = targetSec;
    }
  }, [currentTimeMs, trimStartMs, isPlaying]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

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
      const existingGraph = mediaAudioGraphMap.get(vid);
      if (existingGraph && existingGraph.ctx.state === 'suspended') {
        existingGraph.ctx.resume().catch(() => {});
      }
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

  const seekRelativeMs = (nextRelMs: number) => {
    const clamped = Math.max(0, Math.min(trimmedDurationMs, nextRelMs));
    onTimeUpdate?.(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = (trimStartMs + clamped) / 1000;
    }
  };

  const stepPlayhead = (deltaMs: number) => {
    seekRelativeMs(currentTimeMs + deltaMs);
  };

  const restartClip = () => {
    seekRelativeMs(0);
  };

  const cyclePlaybackSpeed = () => {
    const idx = PLAYBACK_SPEEDS.indexOf(
      playbackSpeed as (typeof PLAYBACK_SPEEDS)[number]
    );
    const next = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    setPlaybackSpeed(next);
  };

  const toggleWideView = () => {
    if (onToggleWideMode) {
      onToggleWideMode();
    } else {
      setInternalWideMode((prev) => !prev);
    }
  };

  const toggleFullscreen = async () => {
    const rootEl = previewRootRef.current;
    if (!rootEl) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await rootEl.requestFullscreen();
      }
    } catch {
      // Ignore if environment blocks fullscreen API
    }
  };

  const handleFloatingHeaderPointerDown = (
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const cardEl = floatingEditorRef.current;
    if (!cardEl) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = cardEl.getBoundingClientRect();
    floatingDragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: rect.left,
      originY: rect.top,
    };
  };

  const handleFloatingHeaderPointerMove = (
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    const drag = floatingDragRef.current;
    const cardEl = floatingEditorRef.current;
    if (!drag || !cardEl) return;
    const cardW = cardEl.offsetWidth || 368;
    const cardH = Math.min(cardEl.offsetHeight || 320, window.innerHeight - 24);
    const nextX = Math.min(
      Math.max(8, drag.originX + (e.clientX - drag.startClientX)),
      Math.max(8, window.innerWidth - cardW - 8)
    );
    const nextY = Math.min(
      Math.max(8, drag.originY + (e.clientY - drag.startClientY)),
      Math.max(8, window.innerHeight - Math.min(120, cardH) - 8)
    );
    setFloatingPos({ x: Math.round(nextX), y: Math.round(nextY) });
  };

  const handleFloatingHeaderPointerUp = () => {
    floatingDragRef.current = null;
  };

  const canDragLogo =
    !cropEditorMode && (Boolean(onDragLogo) || dragMode === 'logo');
  const canDragSubtitle =
    !cropEditorMode && (Boolean(onDragSubtitle) || dragMode === 'subtitles');

  const startCropDrag = (
    e: React.PointerEvent<HTMLElement>,
    mode: CropHandleMode
  ) => {
    if (!cropEditorMode || !onUpdateCropBox) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setActiveCropHandle(mode);
    cropDragStartRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: activeCropX,
      startY: activeCropY,
      startW: activeCropW,
      startH: activeCropH,
      startZoom: cropCfg?.zoom || 1,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (
      cropEditorMode &&
      activeCropHandle !== 'none' &&
      cropDragStartRef.current &&
      onUpdateCropBox
    ) {
      const st = cropDragStartRef.current;
      const dx = (e.clientX - st.startClientX) / rect.width;
      const dy = (e.clientY - st.startClientY) / rect.height;

      if (st.mode === 'pan') {
        const nx = Math.min(
          Math.max(st.startX + dx, 0),
          Math.max(0, 1 - st.startW)
        );
        const ny = Math.min(
          Math.max(st.startY + dy, 0),
          Math.max(0, 1 - st.startH)
        );
        onUpdateCropBox({
          x: Number(nx.toFixed(4)),
          y: Number(ny.toFixed(4)),
        });
        return;
      }

      const aspectPreset = cropCfg?.aspect_ratio || 'original';
      if (aspectPreset === 'custom') {
        let x1 = st.startX;
        let y1 = st.startY;
        let x2 = st.startX + st.startW;
        let y2 = st.startY + st.startH;

        if (st.mode === 'nw' || st.mode === 'sw') {
          x1 = Math.min(Math.max(st.startX + dx, 0), x2 - 0.1);
        } else {
          x2 = Math.max(Math.min(st.startX + st.startW + dx, 1), x1 + 0.1);
        }

        if (st.mode === 'nw' || st.mode === 'ne') {
          y1 = Math.min(Math.max(st.startY + dy, 0), y2 - 0.1);
        } else {
          y2 = Math.max(Math.min(st.startY + st.startH + dy, 1), y1 + 0.1);
        }

        onUpdateCropBox({
          x: Number(x1.toFixed(4)),
          y: Number(y1.toFixed(4)),
          width: Number((x2 - x1).toFixed(4)),
          height: Number((y2 - y1).toFixed(4)),
          zoom: 1,
        });
      } else {
        const signX = st.mode === 'nw' || st.mode === 'sw' ? 1 : -1;
        const signY = st.mode === 'nw' || st.mode === 'ne' ? 1 : -1;
        const deltaInward = (dx * signX + dy * signY) * 0.85;
        const newZoom = Math.min(
          Math.max(st.startZoom * (1 + deltaInward), 1.0),
          3.0
        );
        const { width: nw, height: nh } = computeAspectCropSize(
          aspectPreset,
          srcVideoW,
          srcVideoH,
          newZoom
        );
        const centerX = st.startX + st.startW * 0.5;
        const centerY = st.startY + st.startH * 0.5;
        const nx = Math.min(
          Math.max(centerX - nw * 0.5, 0),
          Math.max(0, 1 - nw)
        );
        const ny = Math.min(
          Math.max(centerY - nh * 0.5, 0),
          Math.max(0, 1 - nh)
        );
        onUpdateCropBox({
          x: Number(nx.toFixed(4)),
          y: Number(ny.toFixed(4)),
          width: Number(nw.toFixed(4)),
          height: Number(nh.toFixed(4)),
          zoom: Number(newZoom.toFixed(2)),
        });
      }
      return;
    }

    if (activeDragTarget === 'none') return;

    if (activeDragTarget === 'logo' && onDragLogo) {
      const logoW =
        logoRef.current?.offsetWidth ||
        rect.width * (settings.logo.width_ratio || 0.14);
      const logoH = logoRef.current?.offsetHeight || logoW;
      const availW = Math.max(1, rect.width - logoW);
      const availH = Math.max(1, rect.height - logoH);

      const targetLeft = e.clientX - rect.left - dragOffsetRef.current.offsetX;
      const targetTop = e.clientY - rect.top - dragOffsetRef.current.offsetY;

      const xRatio = Math.min(Math.max(targetLeft / availW, 0.0), 1.0);
      const yRatio = Math.min(Math.max(targetTop / availH, 0.0), 1.0);
      onDragLogo(Number(xRatio.toFixed(4)), Number(yRatio.toFixed(4)));
    } else if (activeDragTarget === 'subtitles' && onDragSubtitle) {
      const targetCenterX =
        e.clientX - rect.left - dragOffsetRef.current.offsetX;
      const targetCenterY =
        e.clientY - rect.top - dragOffsetRef.current.offsetY;

      const xRatio = Math.min(Math.max(targetCenterX / rect.width, 0.05), 0.95);
      const yRatio = Math.min(
        Math.max(targetCenterY / rect.height, 0.05),
        0.95
      );
      onDragSubtitle(Number(xRatio.toFixed(4)), Number(yRatio.toFixed(4)));
    }
  };

  const endAllDrags = () => {
    setActiveDragTarget('none');
    setActiveCropHandle('none');
    cropDragStartRef.current = null;
  };

  const activeCue = cues.find(
    (c) => currentTimeMs >= c.start_ms && currentTimeMs <= c.end_ms
  );
  const fallbackCue = !isPlaying && cues.length > 0 ? cues[0] : null;
  const previewCueText =
    activeCue?.text ||
    (fallbackCue && (settings.subtitles.enabled || dragMode === 'subtitles')
      ? fallbackCue.text
      : dragMode === 'subtitles'
      ? 'Sample subtitle preview'
      : null);

  const logoCfg = settings.logo;
  const subCfg = settings.subtitles;
  const styleCfg = subCfg.style;
  const colorCfg = settings.color_correction;
  const audioCfg = settings.audio_enhancement;

  const effectiveBypassColor = bypassColorCorrection || localCompareRaw;
  const effectiveBypassAudio = bypassAudioEnhancement || localCompareRaw;

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    const isAudioActive = Boolean(audioCfg?.enabled && !effectiveBypassAudio);
    const existingGraph = mediaAudioGraphMap.get(vid);
    if (!isAudioActive && !existingGraph) return;

    const graph = existingGraph || getOrCreateAudioGraph(vid);
    if (!graph) return;

    if (isPlaying && graph.ctx.state === 'suspended') {
      graph.ctx.resume().catch(() => {});
    }

    const nr = isAudioActive
      ? Math.min(Math.max(audioCfg?.noise_reduction ?? 0, 0), 1)
      : 0;
    const clarity = isAudioActive
      ? Math.min(Math.max(audioCfg?.voice_clarity ?? 0, 0), 1)
      : 0;
    const hpHz = isAudioActive
      ? Math.min(Math.max(audioCfg?.highpass_hz ?? 80, 20), 300)
      : 20;
    const lpHz = isAudioActive
      ? Math.min(Math.max(audioCfg?.lowpass_hz ?? 16000, 4000), 20000)
      : 20000;
    const volDb = isAudioActive
      ? Math.min(Math.max(audioCfg?.volume_db ?? 0, -12), 12)
      : 0;
    const normLoudness = isAudioActive && Boolean(audioCfg?.normalize_loudness);

    graph.highpass.frequency.value = hpHz;
    graph.lowpass.frequency.value = lpHz;
    graph.rumbleAtten.gain.value = -nr * 5.0;
    graph.hissAtten.gain.value = -nr * 9.5;
    graph.voiceClarity.gain.value = clarity * 6.5;

    if (normLoudness) {
      graph.compressor.threshold.value = -18;
      graph.compressor.ratio.value = 2.5;
    } else {
      graph.compressor.threshold.value = 0;
      graph.compressor.ratio.value = 1.0;
    }

    const makeupDb = normLoudness ? 2.0 : 0.0;
    graph.outputGain.gain.value = Math.pow(10, (volDb + makeupDb) / 20);
  }, [
    audioCfg?.enabled,
    audioCfg?.noise_reduction,
    audioCfg?.voice_clarity,
    audioCfg?.highpass_hz,
    audioCfg?.lowpass_hz,
    audioCfg?.volume_db,
    audioCfg?.normalize_loudness,
    effectiveBypassAudio,
    isPlaying,
  ]);

  const isColorActive = Boolean(colorCfg?.enabled && !effectiveBypassColor);
  const ccBrightness = isColorActive ? (colorCfg?.brightness ?? 0) : 0;
  const ccContrast = isColorActive ? (colorCfg?.contrast ?? 1) : 1;
  const ccSaturation = isColorActive ? (colorCfg?.saturation ?? 1) : 1;
  const ccGamma = isColorActive
    ? Math.min(Math.max(colorCfg?.gamma ?? 1, 0.5), 2.0)
    : 1;
  const ccTemp = isColorActive
    ? Math.min(Math.max(colorCfg?.temperature ?? 0, -1), 1)
    : 0;
  const ccTint = isColorActive
    ? Math.min(Math.max(colorCfg?.tint ?? 0, -1), 1)
    : 0;
  const ccSharpen = isColorActive
    ? Math.min(Math.max(colorCfg?.sharpen ?? 0, 0), 1.5)
    : 0;

  const rGain = Math.min(
    Math.max(1.0 + 0.18 * ccTemp + 0.08 * ccTint, 0.5),
    1.6
  );
  const gGain = Math.min(
    Math.max(1.0 + 0.03 * ccTemp - 0.14 * ccTint, 0.5),
    1.6
  );
  const bGain = Math.min(
    Math.max(1.0 - 0.18 * ccTemp + 0.08 * ccTint, 0.5),
    1.6
  );
  const gammaExponent = Number((1.0 / ccGamma).toFixed(4));

  const videoCssFilter = isColorActive
    ? `brightness(${(1 + ccBrightness).toFixed(4)}) contrast(${ccContrast.toFixed(
        4
      )}) saturate(${ccSaturation.toFixed(4)}) url(#${svgFilterId})`
    : undefined;

  const refDim = Math.min(videoW, videoH);
  const assScaleRatio = refDim / 1080.0;
  const scaledAssFontSize = Math.max(
    14,
    Math.round((styleCfg.font_size || 42) * assScaleRatio)
  );
  const previewFontSizePx = Math.max(6, scaledAssFontSize * scale * 0.8);
  const previewOutlinePx = styleCfg.outline_enabled
    ? Math.max(0.5, (styleCfg.outline_thickness || 3) * assScaleRatio * scale)
    : 0;
  const previewShadowPx = styleCfg.shadow_enabled
    ? Math.max(0.5, (styleCfg.shadow_depth || 2) * assScaleRatio * scale)
    : 0;
  const marginHRatio = styleCfg.margin_h_ratio ?? 0.05;
  const marginVRatio = styleCfg.margin_v_ratio ?? 0.06;

  const renderVideoElement = () => {
    if (!sourceAsset?.stream_url) {
      return (
        <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
          No source video
        </div>
      );
    }

    const commonVideoProps = {
      ref: videoRef,
      src: sourceAsset.stream_url,
      crossOrigin: 'anonymous' as const,
      preload: 'metadata' as const,
      playsInline: true,
      disablePictureInPicture: true,
      disableRemotePlayback: true,
      muted: isMuted,
      onTimeUpdate: handleVideoTimeUpdate,
      onPause: () => setIsPlaying(false),
      onPlay: () => setIsPlaying(true),
      onLoadedMetadata: () => {
        const vid = videoRef.current;
        if (vid) {
          if (
            vid.videoWidth > 0 &&
            vid.videoHeight > 0 &&
            sourceAsset.stream_url
          ) {
            setLoadedVideoMeta({
              src: sourceAsset.stream_url,
              width: vid.videoWidth,
              height: vid.videoHeight,
            });
          }
          vid.playbackRate = playbackSpeed;
          vid.currentTime = trimStartMs / 1000;
        }
      },
    };

    if (cropEditorMode || !isCropEnabled) {
      return (
        <video
          {...commonVideoProps}
          style={{ filter: videoCssFilter }}
          className="w-full h-full object-fill block pointer-events-none"
        />
      );
    }

    if (cropCfg?.fit_mode === 'pad') {
      const croppedSrcAspect =
        (srcVideoW * activeCropW) / (srcVideoH * activeCropH);
      const outAspect = frameWidth / frameHeight;
      const [innerW, innerH] =
        croppedSrcAspect > outAspect
          ? [frameWidth, Math.round(frameWidth / croppedSrcAspect)]
          : [Math.round(frameHeight * croppedSrcAspect), frameHeight];

      return (
        <div className="w-full h-full flex items-center justify-center bg-black">
          <div
            style={{ width: `${innerW}px`, height: `${innerH}px` }}
            className="relative overflow-hidden"
          >
            <video
              {...commonVideoProps}
              style={{
                filter: videoCssFilter,
                position: 'absolute',
                maxWidth: 'none',
                width: `${(100 / activeCropW).toFixed(4)}%`,
                height: `${(100 / activeCropH).toFixed(4)}%`,
                left: `${(-(activeCropX / activeCropW) * 100).toFixed(4)}%`,
                top: `${(-(activeCropY / activeCropH) * 100).toFixed(4)}%`,
              }}
              className="object-fill block pointer-events-none"
            />
          </div>
        </div>
      );
    }

    return (
      <video
        {...commonVideoProps}
        style={{
          filter: videoCssFilter,
          position: 'absolute',
          maxWidth: 'none',
          width: `${(100 / activeCropW).toFixed(4)}%`,
          height: `${(100 / activeCropH).toFixed(4)}%`,
          left: `${(-(activeCropX / activeCropW) * 100).toFixed(4)}%`,
          top: `${(-(activeCropY / activeCropH) * 100).toFixed(4)}%`,
        }}
        className="object-fill block pointer-events-none"
      />
    );
  };

  const detectedFace = cropCfg?.detected_face;
  const hasBypassableFx = Boolean(colorCfg?.enabled || audioCfg?.enabled);

  const isToolConfigured = (tabId: StudioNavbarTab): boolean => {
    switch (tabId) {
      case 'trim':
        return (settings.trim.start_ms || 0) > 0 || settings.trim.end_ms !== null;
      case 'crop':
        return Boolean(settings.crop?.enabled);
      case 'subtitles':
        return Boolean(settings.subtitles?.enabled);
      case 'color':
        return Boolean(settings.color_correction?.enabled);
      case 'audio':
        return Boolean(settings.audio_enhancement?.enabled);
      case 'logo':
        return Boolean(settings.logo?.enabled && logoAsset);
      case 'outro':
        return Boolean(settings.outro?.enabled);
      case 'export':
        return Boolean(
          settings.output?.width ||
            settings.output?.height ||
            settings.output?.fps ||
            (settings.output?.crf && settings.output.crf !== 20)
        );
    }
  };

  return (
    <div
      ref={previewRootRef}
      data-wide-stage={
        effectiveWideMode && !isFullscreen ? 'true' : undefined
      }
      className={
        isFullscreen
          ? 'relative fixed inset-0 z-50 flex flex-col justify-between bg-black p-3 sm:p-4 gap-2 overflow-hidden'
          : 'space-y-2'
      }
    >
      <svg className="sr-only" aria-hidden="true" width="0" height="0">
        <defs>
          <filter id={svgFilterId} colorInterpolationFilters="sRGB">
            <feComponentTransfer result="gammaCorrected">
              <feFuncR
                type="gamma"
                amplitude="1"
                exponent={gammaExponent}
                offset="0"
              />
              <feFuncG
                type="gamma"
                amplitude="1"
                exponent={gammaExponent}
                offset="0"
              />
              <feFuncB
                type="gamma"
                amplitude="1"
                exponent={gammaExponent}
                offset="0"
              />
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

      {/* Fullscreen Floating Tool Pill Bar */}
      {isFullscreen && enableFullscreenToolTabs && (
        <div className="flex items-center justify-between gap-2 z-40">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px] bg-card/85 backdrop-blur-md">
              {cropEditorMode
                ? `${srcVideoW}×${srcVideoH} → ${targetOutDims.width}×${targetOutDims.height}`
                : `${videoW}×${videoH}`}
            </Badge>
            {hasBypassableFx && (
              <Button
                type="button"
                variant={localCompareRaw ? 'default' : 'secondary'}
                size="xs"
                onClick={() => setLocalCompareRaw((v) => !v)}
                className="text-[11px]"
              >
                <SplitSquareHorizontal className="h-3 w-3" />
                <span>{localCompareRaw ? 'Original' : 'A/B'}</span>
              </Button>
            )}
          </div>

          <div className="flex items-center gap-1 rounded-2xl bg-card/90 backdrop-blur-xl border border-border px-1.5 py-1 shadow-2xl max-w-[72vw] overflow-x-auto no-scrollbar">
            {FULLSCREEN_STUDIO_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeStudioTab === tab.id;
              const configured = isToolConfigured(tab.id);
              return (
                <HintTooltip key={tab.id} label={tab.label} detail={tab.hint} side="bottom">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveStudioTab(tab.id);
                      setIsFullscreenEditorOpen(true);
                    }}
                    className={`relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-medium transition-colors shrink-0 ${
                      active
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary/70'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">{tab.label}</span>
                    {configured && !active && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                </HintTooltip>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            {fullscreenInspector && (
              <HintTooltip
                label={isFullscreenEditorOpen ? 'Hide Floating Editor' : 'Show Floating Editor'}
                side="bottom"
              >
                <Button
                  type="button"
                  variant={isFullscreenEditorOpen ? 'default' : 'secondary'}
                  size="xs"
                  onClick={() => setIsFullscreenEditorOpen((v) => !v)}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Edit</span>
                </Button>
              </HintTooltip>
            )}
            <HintTooltip label="Exit Full Screen" shortcut="Esc" side="bottom">
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                onClick={() => void toggleFullscreen()}
                aria-label="Exit full screen"
              >
                <Minimize className="h-3.5 w-3.5" />
              </Button>
            </HintTooltip>
          </div>
        </div>
      )}

      {/* Minimal Canvas Status Bar (Non-Fullscreen or when Tool Tabs hidden) */}
      {(!isFullscreen || !enableFullscreenToolTabs) && (
        <div className="flex items-center justify-between gap-2 px-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <HintTooltip
              label="Output Frame Resolution"
              detail={
                cropEditorMode
                  ? `Source ${srcVideoW}×${srcVideoH} → Target ${targetOutDims.width}×${targetOutDims.height}`
                  : '1:1 frame-accurate coordinate mapping'
              }
              side="top"
            >
              <Badge variant="outline" className="font-mono text-[10px]">
                {cropEditorMode
                  ? `${srcVideoW}×${srcVideoH} → ${targetOutDims.width}×${targetOutDims.height}`
                  : `${videoW}×${videoH}`}
              </Badge>
            </HintTooltip>

            {isCropEnabled && cropCfg?.aspect_ratio && (
              <Badge variant="secondary" className="text-[10px]">
                {cropCfg.aspect_ratio.toUpperCase()}
                {cropCfg.auto_face_framing ? ' · Face AI' : ''}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {hasBypassableFx && (
              <HintTooltip
                label="A/B Original Compare"
                detail="Toggle to temporarily bypass color grading & audio filters"
                side="top"
              >
                <Button
                  type="button"
                  variant={localCompareRaw ? 'default' : 'ghost'}
                  size="xs"
                  onClick={() => setLocalCompareRaw((v) => !v)}
                  className="text-[11px]"
                >
                  <SplitSquareHorizontal className="h-3 w-3" />
                  <span>{localCompareRaw ? 'Original' : 'A/B'}</span>
                </Button>
              </HintTooltip>
            )}
            {isFullscreen && fullscreenInspector && (
              <Button
                type="button"
                variant={isFullscreenEditorOpen ? 'default' : 'secondary'}
                size="xs"
                onClick={() => setIsFullscreenEditorOpen((v) => !v)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>Edit</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Draggable Floating Edit Inspector Overlay inside Fullscreen */}
      {isFullscreen && fullscreenInspector && isFullscreenEditorOpen && (
        <div
          ref={floatingEditorRef}
          style={
            floatingPos
              ? { left: `${floatingPos.x}px`, top: `${floatingPos.y}px` }
              : floatingDockSide === 'left'
              ? { left: '16px', top: enableFullscreenToolTabs ? '60px' : '48px' }
              : { right: '16px', top: enableFullscreenToolTabs ? '60px' : '48px' }
          }
          className="fixed z-40 w-[340px] sm:w-[376px] rounded-2xl bg-card/92 backdrop-blur-xl border border-border shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-132px)]"
        >
          <div
            onPointerDown={handleFloatingHeaderPointerDown}
            onPointerMove={handleFloatingHeaderPointerMove}
            onPointerUp={handleFloatingHeaderPointerUp}
            onPointerCancel={handleFloatingHeaderPointerUp}
            className="px-3 py-2 bg-secondary/75 border-b border-border flex items-center justify-between gap-2 cursor-grab active:cursor-grabbing select-none shrink-0"
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
              <span>Floating Editor</span>
            </div>

            <div className="flex items-center gap-1">
              <HintTooltip
                label={floatingDockSide === 'right' ? 'Dock Left' : 'Dock Right'}
                detail="Snap floating editor to the opposite side"
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setFloatingPos(null);
                    setFloatingDockSide((s) => (s === 'right' ? 'left' : 'right'));
                  }}
                  aria-label="Switch dock side"
                >
                  {floatingDockSide === 'right' ? (
                    <PanelLeft className="h-3.5 w-3.5" />
                  ) : (
                    <PanelRight className="h-3.5 w-3.5" />
                  )}
                </Button>
              </HintTooltip>

              <HintTooltip label="Hide Floating Editor" side="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setIsFullscreenEditorOpen(false)}
                  aria-label="Hide floating editor"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </HintTooltip>
            </div>
          </div>

          <div className="p-2.5 overflow-y-auto flex-1">{fullscreenInspector}</div>
        </div>
      )}

      {/* Video Stage */}
      <div
        ref={stageRef}
        onDoubleClick={() => void toggleFullscreen()}
        className={`w-full flex items-center justify-center bg-black/95 rounded-xl border border-border p-2 overflow-hidden ${
          isFullscreen ? 'flex-1 min-h-0 border-white/10' : ''
        }`}
      >
        <div
          ref={containerRef}
          style={{
            width: `${frameWidth}px`,
            height: `${frameHeight}px`,
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={endAllDrags}
          onPointerLeave={endAllDrags}
          className="relative bg-black overflow-hidden select-none shadow-md"
        >
          {renderVideoElement()}

          {cropEditorMode && sourceAsset?.stream_url && (
            <>
              {detectedFace && (
                <div
                  style={{
                    left: `${detectedFace.x * 100}%`,
                    top: `${detectedFace.y * 100}%`,
                    width: `${detectedFace.width * 100}%`,
                    height: `${detectedFace.height * 100}%`,
                  }}
                  className="absolute z-10 border-2 border-dashed border-emerald-400/90 rounded-md pointer-events-none"
                >
                  <span className="absolute -top-5 left-0 bg-emerald-500/90 text-slate-950 text-[9px] font-bold px-1.5 py-0.5 rounded inline-flex items-center gap-1 whitespace-nowrap">
                    <ScanFace className="h-2.5 w-2.5" />
                    {Math.round(detectedFace.confidence * 100)}%
                  </span>
                </div>
              )}

              <div
                onPointerDown={(e) => startCropDrag(e, 'pan')}
                style={{
                  left: `${activeCropX * 100}%`,
                  top: `${activeCropY * 100}%`,
                  width: `${activeCropW * 100}%`,
                  height: `${activeCropH * 100}%`,
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.62)',
                }}
                className="absolute z-20 border-2 border-primary cursor-move"
              >
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
                  {Array.from({ length: 9 }).map((_, idx) => (
                    <div
                      key={`grid-${idx}`}
                      className="border border-white/15"
                    />
                  ))}
                </div>

                {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                  const posClass =
                    corner === 'nw'
                      ? '-top-1.5 -left-1.5 cursor-nwse-resize'
                      : corner === 'ne'
                      ? '-top-1.5 -right-1.5 cursor-nesw-resize'
                      : corner === 'sw'
                      ? '-bottom-1.5 -left-1.5 cursor-nesw-resize'
                      : '-bottom-1.5 -right-1.5 cursor-nwse-resize';
                  return (
                    <div
                      key={corner}
                      onPointerDown={(e) => startCropDrag(e, corner)}
                      className={`absolute h-3.5 w-3.5 rounded-xs bg-white border-2 border-primary shadow ${posClass}`}
                    />
                  );
                })}
              </div>

              <div className="absolute top-2 left-2 z-30 bg-black/70 backdrop-blur-xs text-white/90 text-[10px] px-2 py-0.5 rounded-md flex items-center gap-1 border border-white/15 pointer-events-none">
                <Move className="h-2.5 w-2.5 text-primary" />
                Drag to pan · Corners to zoom
              </div>
            </>
          )}

          {!cropEditorMode && logoCfg.enabled && logoAsset?.stream_url && (
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
              title={canDragLogo ? 'Drag brand logo' : undefined}
              className={`absolute z-10 transition-shadow ${
                canDragLogo
                  ? 'hover:ring-2 hover:ring-primary/80 rounded cursor-grab active:cursor-grabbing'
                  : 'pointer-events-none'
              } ${activeDragTarget === 'logo' ? 'ring-2 ring-primary shadow-lg' : ''}`}
            >
              <img
                src={logoAsset.stream_url}
                alt="Brand logo overlay"
                className="w-full h-auto object-contain block"
                draggable={false}
              />
            </div>
          )}

          {!cropEditorMode &&
            (subCfg.enabled || dragMode === 'subtitles') &&
            previewCueText && (
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
                title={canDragSubtitle ? 'Drag subtitles' : undefined}
                className={`absolute z-20 rounded transition-shadow ${
                  canDragSubtitle
                    ? 'hover:ring-2 hover:ring-primary/80 cursor-grab active:cursor-grabbing'
                    : 'pointer-events-none'
                } ${activeDragTarget === 'subtitles' ? 'ring-2 ring-primary' : ''}`}
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
        </div>
      </div>

      {/* Minimal Transport Bar with Full Controls & Hover Hints */}
      <div className="flex items-center gap-1.5 bg-card border border-border rounded-xl px-2.5 py-1.5">
        <HintTooltip
          label={isPlaying ? 'Pause' : 'Play'}
          detail="Preview trimmed clip range"
          side="top"
        >
          <Button
            type="button"
            size="icon-sm"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5 ml-0.5" />
            )}
          </Button>
        </HintTooltip>

        <HintTooltip label="Step Back 1s" side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => stepPlayhead(-1000)}
            aria-label="Step back 1 second"
          >
            <SkipBack className="h-3 w-3" />
          </Button>
        </HintTooltip>

        <HintTooltip label="Step Forward 1s" side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => stepPlayhead(1000)}
            aria-label="Step forward 1 second"
          >
            <SkipForward className="h-3 w-3" />
          </Button>
        </HintTooltip>

        <HintTooltip label="Restart Selection" side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={restartClip}
            aria-label="Restart selection"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </HintTooltip>

        <div className="flex-1 px-1.5">
          <Slider
            aria-label="Scrub trimmed clip timeline"
            min={0}
            max={trimmedDurationMs}
            step={40}
            value={[Math.min(currentTimeMs, trimmedDurationMs)]}
            onValueChange={(vals) => {
              if (vals[0] !== undefined) {
                seekRelativeMs(vals[0]);
              }
            }}
          />
        </div>

        <div className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0 hidden sm:block">
          <span className="text-foreground font-medium">
            {formatTimecode(currentTimeMs)}
          </span>
          <span className="opacity-50"> / </span>
          <span>{formatTimecode(trimmedDurationMs)}</span>
        </div>

        <HintTooltip
          label="Playback Speed"
          detail="Click to cycle 0.5× → 1× → 1.25× → 1.5× → 2×"
          side="top"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={cyclePlaybackSpeed}
            className="font-mono text-[10px] px-1.5 tabular-nums text-muted-foreground hover:text-foreground"
          >
            {playbackSpeed}×
          </Button>
        </HintTooltip>

        <HintTooltip label={isMuted ? 'Unmute' : 'Mute'} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setIsMuted((v) => !v)}
            aria-label={isMuted ? 'Unmute preview' : 'Mute preview'}
            className="text-muted-foreground hover:text-foreground"
          >
            {isMuted ? (
              <VolumeX className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </HintTooltip>

        {!isFullscreen && (
          <HintTooltip
            label={effectiveWideMode ? 'Side-by-Side Split View' : 'Side / Wide View'}
            detail={
              effectiveWideMode
                ? 'Return to side-by-side preview & inspector'
                : 'Expand preview across full width'
            }
            side="top"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!sourceAsset?.stream_url}
              onClick={toggleWideView}
              aria-label={
                effectiveWideMode ? 'Switch to split view' : 'Switch to wide view'
              }
              className={
                effectiveWideMode
                  ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }
            >
              {effectiveWideMode ? (
                <Columns2 className="h-3.5 w-3.5" />
              ) : (
                <RectangleHorizontal className="h-3.5 w-3.5" />
              )}
            </Button>
          </HintTooltip>
        )}

        {isFullscreen && fullscreenInspector && (
          <HintTooltip
            label={isFullscreenEditorOpen ? 'Hide Floating Editor' : 'Open Floating Editor'}
            detail="Edit video settings live while in full screen"
            side="top"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setIsFullscreenEditorOpen((v) => !v)}
              aria-label="Toggle floating editor"
              className={
                isFullscreenEditorOpen
                  ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
          </HintTooltip>
        )}

        <HintTooltip
          label={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
          detail="Double-click video or click to toggle full screen"
          side="top"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!sourceAsset?.stream_url}
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            className={
              isFullscreen
                ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }
          >
            {isFullscreen ? (
              <Minimize className="h-3.5 w-3.5" />
            ) : (
              <Maximize className="h-3.5 w-3.5" />
            )}
          </Button>
        </HintTooltip>
      </div>
    </div>
  );
};
