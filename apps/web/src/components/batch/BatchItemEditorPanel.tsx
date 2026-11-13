import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Image as ImageIcon,
  Crop,
  Sliders,
  Volume2,
  Subtitles,
  Film,
  Scissors,
  ScanFace,
  Layers,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Move,
  Play,
  Download,
  Trash2,
  ChevronDown,
  ChevronUp,
  Clock,
  XCircle,
  RefreshCw,
  ArrowDownToLine,
  Eye,
  Upload,
  Settings2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Sparkles,
  Plus,
  Crosshair,
  SplitSquareHorizontal,
} from 'lucide-react';
import { extractApiError, videoApi } from '@/api/videoApi';
import {
  InteractiveVideoPreview,
  type CropBoxPatch,
} from '@/components/studio/InteractiveVideoPreview';
import { PositionGridPicker } from '@/components/studio/PositionGridPicker';
import { COLOR_PRESETS } from '@/lib/colorPresets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { HintTooltip } from '@/components/ui/tooltip';
import {
  ASPECT_RATIO_PRESETS,
  DEFAULT_CROP_SETTINGS,
  computeAspectCropSize,
  resolveTargetOutputDimensions,
} from '@/lib/cropMath';
import { formatFriendlyDuration, formatTimecode } from '@/lib/timecode';
import type { StudioNavbarTab } from '@/store/useWorkflowStore';
import type {
  AnchorPosition,
  AspectRatioPreset,
  Asset,
  AudioEnhancementSettings,
  BatchDetail,
  BatchItemDetail,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  validating: 'Validating',
  probing: 'Probing Media',
  auto_framing: 'AI Face Framing',
  transcribing: 'Transcribing',
  trimming: 'Trimming & Framing',
  rendering_main: 'Rendering FX & Overlays',
  normalizing_outro: 'Normalizing Outro',
  joining_outro: 'Joining Outro',
  validating_output: 'Verifying MP4',
  uploading_output: 'Finalizing',
};

const BATCH_AUDIO_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  values: Omit<
    AudioEnhancementSettings,
    'enabled' | 'preset' | 'apply_to_transcription'
  >;
}> = [
  {
    id: 'clean_voice',
    label: 'Clean Voice',
    hint: 'Balanced FFT denoise + vocal presence',
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
    hint: 'Crisp studio dialogue + -16 LUFS loudness',
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
    hint: 'Aggressive room noise & hiss suppression',
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
    id: 'broadcast_warm',
    label: 'Broadcast',
    hint: 'Warm low-end body + smooth compression',
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

const SAMPLE_SUBTITLE_CUES: SubtitleCue[] = [
  {
    sequence: 1,
    start_ms: 0,
    end_ms: 3_600_000,
    text: 'Live Subtitle Style Preview',
  },
];

const TAB_HEADERS: Record<
  StudioNavbarTab,
  { title: string; icon: React.ComponentType<{ className?: string }> }
> = {
  trim: { title: 'Trim', icon: Scissors },
  crop: { title: 'Ratio & Face', icon: Crop },
  subtitles: { title: 'Subtitles', icon: Subtitles },
  color: { title: 'Color Grade', icon: Sliders },
  audio: { title: 'Audio DSP', icon: Volume2 },
  logo: { title: 'Brand Logo', icon: ImageIcon },
  outro: { title: 'Outro', icon: Film },
  export: { title: 'Output Quality', icon: Settings2 },
};

export interface BatchRowWorkbenchCardProps {
  batch: BatchDetail;
  item: BatchItemDetail;
  rowNumber: number;
  activeTab: StudioNavbarTab;
  queueWaitingPosition: number | null;
  selectedItemIds: string[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  allowedFonts: string[];
  supportedLanguages: Array<{ code: string; name: string }>;
  singleLogoAsset?: Asset;
  singleOutroAsset?: Asset;
  uploadingSingleKind: 'source' | 'logo' | 'outro' | null;
  onTriggerSingleLogoUpload: () => void;
  onRemoveSingleLogo: () => Promise<void>;
  onTriggerSingleOutroUpload: () => void;
  onRemoveSingleOutro: () => Promise<void>;
  getLiveSettingsForRow: (rowId: string) => EditSettings | undefined;
  onLiveDraftChange: (
    rowId: string,
    settings: EditSettings,
    isDirty: boolean
  ) => void;
  onApplyToSelectedRows: (
    sourceRowNumber: number,
    settings: EditSettings
  ) => Promise<void>;
  onExportSingleRow: (
    rowId: string,
    latestSettings: EditSettings
  ) => Promise<void>;
  onDeleteRow: (rowId: string) => Promise<void>;
  onBatchUpdated: (updated: BatchDetail) => void;
}

export const BatchItemEditorPanel: React.FC<BatchRowWorkbenchCardProps> = ({
  batch,
  item,
  rowNumber,
  activeTab,
  queueWaitingPosition,
  selectedItemIds,
  isCollapsed,
  onToggleCollapse,
  allowedFonts,
  supportedLanguages,
  singleLogoAsset,
  singleOutroAsset,
  uploadingSingleKind,
  onTriggerSingleLogoUpload,
  onRemoveSingleLogo,
  onTriggerSingleOutroUpload,
  onRemoveSingleOutro,
  getLiveSettingsForRow,
  onLiveDraftChange,
  onApplyToSelectedRows,
  onExportSingleRow,
  onDeleteRow,
  onBatchUpdated,
}) => {
  const [draft, setDraft] = useState<EditSettings>(item.settings);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>(
    'idle'
  );
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [cropBoxEditMode, setCropBoxEditMode] = useState(false);
  const [previewMode, setPreviewMode] = useState<'canvas' | 'rendered'>(
    'canvas'
  );
  const [bypassColor, setBypassColor] = useState(false);
  const [bypassAudio, setBypassAudio] = useState(false);
  const [isWidePreview, setIsWidePreview] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [subtitleSubTab, setSubtitleSubTab] = useState<'cues' | 'style'>(
    'style'
  );

  // Per-row AI Subtitles & Live Cue Editing
  const [localCuesOverride, setLocalCuesOverride] = useState<
    SubtitleCue[] | null
  >(null);
  const [cuesDirty, setCuesDirty] = useState(false);
  const [transcribeJobId, setTranscribeJobId] = useState<string | null>(null);
  const [startingTranscribe, setStartingTranscribe] = useState(false);

  const [inheritFromRowId, setInheritFromRowId] = useState<string>('');
  const [exportingSingle, setExportingSingle] = useState(false);
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [detectingFace, setDetectingFace] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  const draftRevisionRef = useRef(0);

  const subtitleQuery = useQuery({
    queryKey: ['row-subtitles', item.project_id, item.subtitle_cue_count],
    queryFn: () => videoApi.getSubtitleVersion(item.project_id, 0),
    enabled: !isCollapsed && Boolean(item.project_id),
    staleTime: 15_000,
  });

  const transcribeJobQuery = useQuery({
    queryKey: ['row-transcribe-job', transcribeJobId],
    queryFn: async () => {
      const job = await videoApi.getJob(transcribeJobId!);
      if (job.status === 'completed') {
        setTranscribeJobId(null);
        setLocalCuesOverride(null);
        await subtitleQuery.refetch();
        const refreshed = await videoApi.getBatch(batch.id);
        onBatchUpdated(refreshed);
      } else if (job.status === 'failed' || job.status === 'canceled') {
        setTranscribeJobId(null);
        setFeedback({
          kind: 'err',
          text: job.error_message_safe || 'AI transcription failed.',
        });
      }
      return job;
    },
    enabled: Boolean(transcribeJobId),
    refetchInterval: transcribeJobId ? 900 : false,
  });

  const activeSubVersion = subtitleQuery.data?.version ?? 0;
  const effectiveCues = useMemo(
    () => localCuesOverride ?? subtitleQuery.data?.cues ?? [],
    [localCuesOverride, subtitleQuery.data?.cues]
  );

  // Auto-save edited subtitle cues after 550ms
  useEffect(() => {
    if (!cuesDirty || localCuesOverride === null) return;
    const cuesSnapshot = localCuesOverride;
    const timer = window.setTimeout(async () => {
      try {
        await videoApi.saveSubtitleVersion(
          item.project_id,
          activeSubVersion,
          draft.subtitles.language || 'en',
          cuesSnapshot
        );
        setCuesDirty(false);
        await subtitleQuery.refetch();
      } catch (err) {
        setFeedback({
          kind: 'err',
          text: extractApiError(err, 'Failed to save subtitle cues.'),
        });
      }
    }, 550);
    return () => window.clearTimeout(timer);
  }, [
    cuesDirty,
    localCuesOverride,
    item.project_id,
    activeSubVersion,
    draft.subtitles.language,
    subtitleQuery,
  ]);

  const otherRows = useMemo(
    () => batch.items.filter((r) => r.id !== item.id),
    [batch.items, item.id]
  );

  const resolvedInheritRowId =
    inheritFromRowId && otherRows.some((r) => r.id === inheritFromRowId)
      ? inheritFromRowId
      : otherRows[0]?.id || '';

  const sourceAsset: Asset | undefined = item.source_asset_id
    ? batch.videos.find((v) => v.id === item.source_asset_id)
    : batch.videos[0];

  const logoAsset: Asset | undefined = item.logo_asset_id
    ? batch.logos.find((l) => l.id === item.logo_asset_id) ?? singleLogoAsset
    : singleLogoAsset;

  const outroAsset: Asset | undefined = item.outro_asset_id
    ? batch.outros.find((o) => o.id === item.outro_asset_id) ?? singleOutroAsset
    : singleOutroAsset;

  useEffect(() => {
    if (!dirty) return;
    const revSnapshot = draftRevisionRef.current;
    const snapshot = draft;
    const timer = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        const updated = await videoApi.updateBatchItem(batch.id, item.id, {
          use_custom_settings: true,
          settings: snapshot,
        });
        onBatchUpdated(updated);
        if (draftRevisionRef.current === revSnapshot) {
          setDirty(false);
          onLiveDraftChange(item.id, snapshot, false);
          setSaveState('saved');
        }
      } catch (err) {
        setSaveState('idle');
        setFeedback({
          kind: 'err',
          text: extractApiError(err, 'Auto-save failed.'),
        });
      }
    }, 420);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, batch.id, item.id, onBatchUpdated, onLiveDraftChange]);

  const updateDraft = (updater: (prev: EditSettings) => EditSettings) => {
    setDraft((prev) => {
      const next = updater(prev);
      draftRevisionRef.current += 1;
      onLiveDraftChange(item.id, next, true);
      return next;
    });
    setDirty(true);
    setSaveState('idle');
    setFeedback(null);
    if (previewMode === 'rendered') {
      setPreviewMode('canvas');
    }
  };

  const handleInheritFromOtherRow = async (donorId?: string) => {
    const targetDonorId = donorId ?? resolvedInheritRowId;
    if (!targetDonorId) return;
    const donorRow = batch.items.find((r) => r.id === targetDonorId);
    if (!donorRow) return;
    const donorIndex = batch.items.findIndex((r) => r.id === targetDonorId) + 1;
    const donorSettings =
      getLiveSettingsForRow(donorRow.id) ?? donorRow.settings;

    const sameSourceVideo = donorRow.source_asset_id === item.source_asset_id;
    const adapted: EditSettings = {
      ...donorSettings,
      logo: {
        ...donorSettings.logo,
        asset_id: item.settings.logo.asset_id,
      },
      outro: {
        ...donorSettings.outro,
        asset_id: item.settings.outro.asset_id,
      },
      crop: sameSourceVideo
        ? { ...donorSettings.crop }
        : {
            ...donorSettings.crop,
            detected_face: null,
            keyframes: [],
          },
      trim: sameSourceVideo
        ? { ...donorSettings.trim }
        : {
            start_ms: donorSettings.trim.start_ms,
            end_ms: null,
          },
    };

    draftRevisionRef.current += 1;
    setDraft(adapted);
    setDirty(false);
    setPreviewMode('canvas');
    onLiveDraftChange(item.id, adapted, false);
    setSaveState('saving');

    try {
      const updated = await videoApi.updateBatchItem(batch.id, item.id, {
        use_custom_settings: true,
        settings: adapted,
      });
      onBatchUpdated(updated);
      setSaveState('saved');
      setFeedback({
        kind: 'ok',
        text: `Inherited from Row #${donorIndex}.`,
      });
    } catch (err) {
      setSaveState('idle');
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Failed to inherit edits.'),
      });
    }
  };

  const handleSelectAspectPreset = (presetId: AspectRatioPreset) => {
    const srcW = sourceAsset?.width || 1920;
    const srcH = sourceAsset?.height || 1080;
    if (presetId === 'original') {
      updateDraft((prev) => ({
        ...prev,
        crop: {
          ...(prev.crop || DEFAULT_CROP_SETTINGS),
          enabled: false,
          aspect_ratio: 'original',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          zoom: 1,
          keyframes: [],
        },
      }));
      setCropBoxEditMode(false);
      return;
    }

    const curZoom = draft.crop?.zoom || 1;
    const box = computeAspectCropSize(presetId, srcW, srcH, curZoom);
    const centeredX = Math.max(
      0,
      Math.min(1 - box.width, (1 - box.width) / 2)
    );
    const centeredY = Math.max(
      0,
      Math.min(1 - box.height, (1 - box.height) / 2)
    );

    updateDraft((prev) => ({
      ...prev,
      crop: {
        ...(prev.crop || DEFAULT_CROP_SETTINGS),
        enabled: true,
        aspect_ratio: presetId,
        x: centeredX,
        y: centeredY,
        width: box.width,
        height: box.height,
        keyframes: [],
      },
    }));
  };

  const handleUpdateCropBox = (patch: Partial<CropBoxPatch>) => {
    updateDraft((prev) => {
      const cur = prev.crop || DEFAULT_CROP_SETTINGS;
      return {
        ...prev,
        crop: {
          ...cur,
          enabled: true,
          x: patch.x ?? cur.x,
          y: patch.y ?? cur.y,
          width: patch.width ?? cur.width,
          height: patch.height ?? cur.height,
          zoom: patch.zoom ?? cur.zoom,
          aspect_ratio:
            cur.aspect_ratio === 'original' ? 'custom' : cur.aspect_ratio,
          auto_face_framing: false,
          keyframes: [],
        },
      };
    });
  };

  const handleCenterCropFrame = () => {
    updateDraft((prev) => {
      const cur = prev.crop || DEFAULT_CROP_SETTINGS;
      const w = cur.width || 1;
      const h = cur.height || 1;
      return {
        ...prev,
        crop: {
          ...cur,
          x: Number(Math.max(0, (1 - w) / 2).toFixed(4)),
          y: Number(Math.max(0, (1 - h) / 2).toFixed(4)),
          auto_face_framing: false,
          keyframes: [],
        },
      };
    });
  };

  const handleTestAutoFaceOnCurrent = async () => {
    if (!sourceAsset) return;
    setDetectingFace(true);
    setFeedback(null);
    try {
      const ratio =
        draft.crop?.aspect_ratio && draft.crop.aspect_ratio !== 'original'
          ? draft.crop.aspect_ratio
          : '9:16';
      const res = await videoApi.autoFrameProject(item.project_id, {
        aspectRatio: ratio,
        dynamicTracking: Boolean(draft.crop?.dynamic_tracking),
        targetZoom: draft.crop?.zoom || 1.0,
      });
      updateDraft((prev) => ({
        ...prev,
        crop: {
          ...res.crop,
          enabled: true,
        },
      }));
      setFeedback({
        kind: 'ok',
        text: res.message,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Auto face framing failed.'),
      });
    } finally {
      setDetectingFace(false);
    }
  };

  const handleGenerateRowSubtitles = async () => {
    if (!sourceAsset) return;
    setStartingTranscribe(true);
    setFeedback(null);
    try {
      // Ensure latest trim/audio settings are persisted before Whisper runs
      const nextDraft: EditSettings = {
        ...draft,
        subtitles: { ...draft.subtitles, enabled: true },
      };
      setDraft(nextDraft);
      const updatedBatch = await videoApi.updateBatchItem(batch.id, item.id, {
        use_custom_settings: true,
        settings: nextDraft,
      });
      onBatchUpdated(updatedBatch);
      await videoApi.updateProject(item.project_id, { settings: nextDraft });

      const job = await videoApi.startTranscription(
        item.project_id,
        nextDraft.subtitles.language || 'auto',
        true
      );
      setTranscribeJobId(job.id);
      setSubtitleSubTab('cues');
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Could not start AI subtitle generation.'),
      });
    } finally {
      setStartingTranscribe(false);
    }
  };

  const mutateRowCues = (updater: (prev: SubtitleCue[]) => SubtitleCue[]) => {
    const next = updater(effectiveCues).map((c, idx) => ({
      ...c,
      sequence: idx + 1,
    }));
    setLocalCuesOverride(next);
    setCuesDirty(true);
    if (!draft.subtitles.enabled) {
      updateDraft((prev) => ({
        ...prev,
        subtitles: { ...prev.subtitles, enabled: true },
      }));
    }
  };

  const handleAddCueAtPlayhead = () => {
    const startMs = Math.max(
      0,
      Math.min(trimmedLengthMs - 400, Math.round(currentTimeMs))
    );
    const endMs = Math.min(trimmedLengthMs, startMs + 2000);
    mutateRowCues((prev) => [
      ...prev,
      {
        sequence: prev.length + 1,
        start_ms: startMs,
        end_ms: Math.max(startMs + 250, endMs),
        text: 'New caption',
      },
    ]);
    setSubtitleSubTab('cues');
  };

  const handleSingleExportClick = async () => {
    setExportingSingle(true);
    setFeedback(null);
    try {
      if (cuesDirty && localCuesOverride !== null) {
        await videoApi.saveSubtitleVersion(
          item.project_id,
          activeSubVersion,
          draft.subtitles.language || 'en',
          localCuesOverride
        );
        setCuesDirty(false);
      }
      await onExportSingleRow(item.id, draft);
      setDirty(false);
      setSaveState('saved');
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Failed to queue single video export.'),
      });
    } finally {
      setExportingSingle(false);
    }
  };

  const handlePushToSelected = async () => {
    setApplyingBulk(true);
    setFeedback(null);
    try {
      await onApplyToSelectedRows(rowNumber, draft);
      setFeedback({
        kind: 'ok',
        text: `Copied to ${selectedItemIds.length || 'shared'} row(s).`,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Failed to copy settings.'),
      });
    } finally {
      setApplyingBulk(false);
    }
  };

  const previewSettings: EditSettings = {
    ...draft,
    logo: {
      ...draft.logo,
      enabled: draft.logo.enabled && Boolean(logoAsset),
    },
  };

  const previewCues: SubtitleCue[] =
    effectiveCues.length > 0
      ? effectiveCues
      : activeTab === 'subtitles'
      ? SAMPLE_SUBTITLE_CUES
      : [];

  const srcDurationMs = sourceAsset?.duration_ms || 10_000;
  const srcDurationSec = Math.max(1, srcDurationMs / 1000);
  const trimStartMs = Math.max(0, draft.trim.start_ms || 0);
  const trimEndMs =
    draft.trim.end_ms !== null && draft.trim.end_ms > trimStartMs
      ? Math.min(srcDurationMs, draft.trim.end_ms)
      : srcDurationMs;
  const trimmedLengthMs = Math.max(200, trimEndMs - trimStartMs);
  const absolutePlayheadMs = Math.min(
    srcDurationMs,
    trimStartMs + currentTimeMs
  );

  const srcW = sourceAsset?.width || 1920;
  const srcH = sourceAsset?.height || 1080;
  const autoFrameDims = resolveTargetOutputDimensions(
    draft.crop,
    srcW,
    srcH,
    null,
    null
  );
  const effectiveOutDims = resolveTargetOutputDimensions(
    draft.crop,
    srcW,
    srcH,
    draft.output?.width,
    draft.output?.height
  );

  const applyResolutionTier = (longEdge: number | null) => {
    if (longEdge === null) {
      updateDraft((prev) => ({
        ...prev,
        output: { ...prev.output, width: null, height: null },
      }));
      return;
    }
    const aspect = autoFrameDims.width / Math.max(1, autoFrameDims.height);
    const isPortrait = aspect < 1;
    const outW = isPortrait
      ? Math.max(2, Math.round((longEdge * aspect) / 2) * 2)
      : Math.max(2, Math.round(longEdge / 2) * 2);
    const outH = isPortrait
      ? Math.max(2, Math.round(longEdge / 2) * 2)
      : Math.max(2, Math.round((longEdge / aspect) / 2) * 2);

    updateDraft((prev) => ({
      ...prev,
      output: { ...prev.output, width: outW, height: outH },
    }));
  };

  const isQueued = item.status === 'queued';
  const isProcessing = item.status === 'processing';
  const isCompleted =
    item.status === 'completed' && item.output_asset !== null;
  const isFailed = item.status === 'failed';
  const pct = Math.max(
    0,
    Math.min(100, Math.round((item.progress ?? 0) * 100))
  );
  const stageText = item.stage
    ? STAGE_LABELS[item.stage] || item.stage
    : isQueued
    ? 'Queued'
    : 'Rendering';

  const isTranscribingRow = Boolean(
    startingTranscribe ||
      (transcribeJobId &&
        transcribeJobQuery.data?.status !== 'completed' &&
        transcribeJobQuery.data?.status !== 'failed')
  );

  const cardBorderClass = isProcessing
    ? 'border-primary/70 ring-1 ring-primary/30 bg-card'
    : isFailed
    ? 'border-destructive/45 bg-card'
    : 'border-border bg-card hover:border-border';

  const TabHeaderIcon = TAB_HEADERS[activeTab].icon;
  const cropMaxPanX = Math.max(0, 1 - (draft.crop?.width ?? 1));
  const cropMaxPanY = Math.max(0, 1 - (draft.crop?.height ?? 1));

  return (
    <section
      id={`batch-row-card-${item.id}`}
      className={`rounded-2xl border transition-all overflow-hidden scroll-mt-32 shadow-2xs ${cardBorderClass}`}
    >
      {/* Minimal Single-Line Row Header */}
      <div className="px-4 py-2.5 bg-muted/30 border-b border-border flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <HintTooltip
            label={
              item.selected
                ? 'Included in Export Queue'
                : 'Excluded from Export Queue'
            }
            side="top"
          >
            <input
              type="checkbox"
              checked={item.selected}
              onChange={async (e) => {
                const updated = await videoApi.updateBatchItem(
                  batch.id,
                  item.id,
                  {
                    selected: e.target.checked,
                  }
                );
                onBatchUpdated(updated);
              }}
              aria-label={`Include Row #${rowNumber} in queue`}
              className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer shrink-0"
            />
          </HintTooltip>

          <Badge
            variant={isProcessing ? 'default' : 'secondary'}
            className="font-mono text-[11px]"
          >
            #{rowNumber}
          </Badge>

          <div className="min-w-0 flex-1 max-w-xs">
            <HintTooltip
              label="Output Filename Title"
              detail="Click to rename this row"
              side="top"
            >
              <input
                type="text"
                defaultValue={item.title}
                key={`${item.id}-${item.title}`}
                onBlur={async (e) => {
                  const next = e.target.value.trim();
                  if (next && next !== item.title) {
                    const updated = await videoApi.updateBatchItem(
                      batch.id,
                      item.id,
                      {
                        title: next,
                      }
                    );
                    onBatchUpdated(updated);
                  }
                }}
                className="w-full text-sm font-semibold bg-transparent border-b border-transparent hover:border-border focus:border-primary focus:outline-none truncate"
              />
            </HintTooltip>
          </div>

          {sourceAsset && (
            <span className="hidden md:inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono shrink-0">
              {sourceAsset.width}×{sourceAsset.height} ·{' '}
              {formatFriendlyDuration(sourceAsset.duration_ms || 0)}
            </span>
          )}

          {isProcessing ? (
            <Badge variant="default" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {stageText} {pct}%
            </Badge>
          ) : isQueued ? (
            <Badge variant="secondary" className="gap-1">
              <Clock className="h-3 w-3" />
              Queued{queueWaitingPosition ? ` #${queueWaitingPosition}` : ''}
            </Badge>
          ) : isCompleted ? (
            <Badge variant="secondary" className="gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Ready
            </Badge>
          ) : isFailed ? (
            <Badge variant="destructive" className="gap-1">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : null}

          {saveState === 'saving' && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          {saveState === 'saved' && !dirty && (
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              Saved
            </span>
          )}
        </div>

        {/* Right Row Action Buttons with Hover Hints */}
        <div className="flex flex-wrap items-center gap-1.5">
          {otherRows.length > 0 && (
            <div className="inline-flex items-center rounded-lg bg-background border border-border p-0.5">
              <select
                value={resolvedInheritRowId}
                onChange={(e) => setInheritFromRowId(e.target.value)}
                aria-label={`Choose row to inherit edits into Row #${rowNumber}`}
                className="bg-transparent pl-2 pr-1 py-0.5 text-[11px] text-muted-foreground focus:outline-none max-w-28 truncate"
              >
                {otherRows.map((r) => {
                  const rNum =
                    batch.items.findIndex((x) => x.id === r.id) + 1;
                  return (
                    <option key={r.id} value={r.id}>
                      #{rNum} {r.title}
                    </option>
                  );
                })}
              </select>
              <HintTooltip
                label="Inherit Edits"
                detail="Copy all editing settings from the selected row into this row"
                side="top"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void handleInheritFromOtherRow()}
                >
                  <ArrowDownToLine className="h-3 w-3" />
                  <span className="hidden sm:inline">Inherit</span>
                </Button>
              </HintTooltip>
            </div>
          )}

          {(isQueued || isProcessing) && item.active_job_id && (
            <HintTooltip label="Cancel Render Job" side="top">
              <Button
                type="button"
                variant="destructive"
                size="xs"
                onClick={async () => {
                  await videoApi.cancelJob(item.active_job_id!);
                  const refreshed = await videoApi.getBatch(batch.id);
                  onBatchUpdated(refreshed);
                }}
              >
                <XCircle className="h-3 w-3" />
                Cancel
              </Button>
            </HintTooltip>
          )}

          {isFailed && item.active_job_id && (
            <HintTooltip label="Retry Failed Render" side="top">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={async () => {
                  await videoApi.retryJob(item.active_job_id!);
                  const refreshed = await videoApi.getBatch(batch.id);
                  onBatchUpdated(refreshed);
                }}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </Button>
            </HintTooltip>
          )}

          {!isQueued && !isProcessing && (
            <HintTooltip
              label={
                isCompleted
                  ? `Re-export Row #${rowNumber}`
                  : `Export Row #${rowNumber}`
              }
              detail="Render this single video to MP4"
              side="top"
            >
              <Button
                type="button"
                size="xs"
                disabled={exportingSingle || !sourceAsset}
                onClick={() => void handleSingleExportClick()}
              >
                {exportingSingle ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 fill-current" />
                )}
                <span>Export #{rowNumber}</span>
              </Button>
            </HintTooltip>
          )}

          {item.output_asset && (
            <HintTooltip label="Download Rendered MP4" side="top">
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                onClick={() =>
                  void videoApi.downloadOutputAsset(
                    item.output_asset!.id,
                    `${item.title.replace(/[^a-zA-Z0-9._-]+/g, '_')}.mp4`
                  )
                }
                aria-label="Download MP4"
              >
                <Download className="h-3 w-3" />
              </Button>
            </HintTooltip>
          )}

          <HintTooltip label="Remove Row" side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void onDeleteRow(item.id)}
              aria-label="Remove video row"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </HintTooltip>

          <HintTooltip
            label={isCollapsed ? 'Expand Row' : 'Collapse Row'}
            side="top"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onToggleCollapse}
              aria-label={isCollapsed ? 'Expand row' : 'Collapse row'}
              className="border border-primary/25 bg-primary/12 text-primary hover:bg-primary hover:text-primary-foreground"
            >
              {isCollapsed ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" />
              )}
            </Button>
          </HintTooltip>
        </div>
      </div>

      {/* Thin Progress Line */}
      {(isProcessing || isQueued) && (
        <div className="h-1 w-full bg-muted overflow-hidden">
          <div
            style={{ width: isQueued ? '100%' : `${Math.max(4, pct)}%` }}
            className={`h-full transition-all duration-300 ${
              isQueued ? 'bg-muted-foreground/30 animate-pulse' : 'bg-primary'
            }`}
          />
        </div>
      )}

      {isFailed && item.error_message_safe && (
        <div className="px-4 py-1.5 bg-destructive/10 border-b border-destructive/25 text-xs text-destructive flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{item.error_message_safe}</span>
        </div>
      )}

      {/* 2-Column Studio Body */}
      {!isCollapsed &&
        (() => {
          const inspectorNode = (
            <div className="space-y-2.5">
              <div className="rounded-xl bg-background/75 border border-border p-3.5 space-y-3.5">
                {/* Inspector Header */}
                <div className="flex items-center justify-between pb-2 border-b border-border/70">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <TabHeaderIcon className="h-3.5 w-3.5 text-primary" />
                    {TAB_HEADERS[activeTab].title}
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {effectiveOutDims.width}×{effectiveOutDims.height}
                  </span>
                </div>

                {/* ==================== 1. TRIM TAB ==================== */}
                {activeTab === 'trim' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                        Playhead {formatTimecode(absolutePlayheadMs)}
                      </span>
                      <div className="flex items-center gap-1">
                        <HintTooltip
                          label="Nudge -0.1s"
                          detail="Step playhead back 100ms"
                          side="top"
                        >
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() =>
                              setCurrentTimeMs((t) => Math.max(0, t - 100))
                            }
                            className="font-mono text-[10px]"
                          >
                            -0.1s
                          </Button>
                        </HintTooltip>
                        <HintTooltip
                          label="Nudge +0.1s"
                          detail="Step playhead forward 100ms"
                          side="top"
                        >
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() =>
                              setCurrentTimeMs((t) =>
                                Math.min(trimmedLengthMs, t + 100)
                              )
                            }
                            className="font-mono text-[10px]"
                          >
                            +0.1s
                          </Button>
                        </HintTooltip>
                        <HintTooltip
                          label="Set In Point ["
                          detail="Mark trim start at current playhead"
                          side="top"
                        >
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            onClick={() => {
                              const nextStart = Math.max(
                                0,
                                Math.min(trimEndMs - 250, absolutePlayheadMs)
                              );
                              updateDraft((prev) => ({
                                ...prev,
                                trim: {
                                  ...prev.trim,
                                  start_ms: Math.round(nextStart),
                                },
                              }));
                              setCurrentTimeMs(0);
                            }}
                          >
                            [ In
                          </Button>
                        </HintTooltip>
                        <HintTooltip
                          label="Set Out Point ]"
                          detail="Mark trim end at current playhead"
                          side="top"
                        >
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            onClick={() => {
                              const nextEnd = Math.min(
                                srcDurationMs,
                                Math.max(trimStartMs + 250, absolutePlayheadMs)
                              );
                              updateDraft((prev) => ({
                                ...prev,
                                trim: {
                                  ...prev.trim,
                                  end_ms: Math.round(nextEnd),
                                },
                              }));
                            }}
                          >
                            Out ]
                          </Button>
                        </HintTooltip>
                      </div>
                    </div>

                    {/* Visual Trim Bar */}
                    <div className="space-y-1.5">
                      <div className="relative h-2.5 rounded-full bg-muted border border-border overflow-hidden">
                        <div
                          style={{
                            left: `${(trimStartMs / Math.max(1, srcDurationMs)) * 100}%`,
                            width: `${(trimmedLengthMs / Math.max(1, srcDurationMs)) * 100}%`,
                          }}
                          className="absolute top-0 bottom-0 bg-primary/85 rounded-full"
                        />
                      </div>
                      <div className="flex justify-between text-[11px] font-mono text-muted-foreground tabular-nums">
                        <span>{formatTimecode(trimStartMs)}</span>
                        <span className="text-foreground font-medium">
                          {formatFriendlyDuration(trimmedLengthMs)}
                        </span>
                        <span>{formatTimecode(trimEndMs)}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">
                          Start (s)
                        </label>
                        <NumberInput
                          min={0}
                          max={Number(Math.max(0, trimEndMs / 1000 - 0.25).toFixed(2))}
                          step={0.1}
                          value={Number((trimStartMs / 1000).toFixed(2))}
                          ariaLabel="Trim start seconds"
                          onValueChange={(val) => {
                            const sec = Math.max(0, val ?? 0);
                            const nextMs = Math.min(
                              Math.round(sec * 1000),
                              Math.max(0, trimEndMs - 250)
                            );
                            updateDraft((prev) => ({
                              ...prev,
                              trim: { ...prev.trim, start_ms: nextMs },
                            }));
                            setCurrentTimeMs(0);
                          }}
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">
                          End (s)
                        </label>
                        <NumberInput
                          min={Number(
                            Math.min(srcDurationSec, trimStartMs / 1000 + 0.25).toFixed(2)
                          )}
                          max={Number(srcDurationSec.toFixed(2))}
                          step={0.1}
                          value={Number((trimEndMs / 1000).toFixed(2))}
                          ariaLabel="Trim end seconds"
                          onValueChange={(val) => {
                            const sec = Math.min(
                              srcDurationSec,
                              Math.max(0.25, val ?? srcDurationSec)
                            );
                            const nextMs = Math.max(
                              trimStartMs + 250,
                              Math.round(sec * 1000)
                            );
                            updateDraft((prev) => ({
                              ...prev,
                              trim: {
                                ...prev.trim,
                                end_ms: nextMs >= srcDurationMs - 20 ? null : nextMs,
                              },
                            }));
                          }}
                        />
                      </div>
                    </div>

                    {(trimStartMs > 0 || draft.trim.end_ms !== null) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          updateDraft((prev) => ({
                            ...prev,
                            trim: { start_ms: 0, end_ms: null },
                          }));
                          setCurrentTimeMs(0);
                        }}
                        className="text-muted-foreground"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Reset Full Clip
                      </Button>
                    )}
                  </div>
                )}

                {/* ==================== 2. RATIO & FACE TAB ==================== */}
                {activeTab === 'crop' && (
                  <div className="space-y-3.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Reframe / Aspect Ratio</span>
                      <Switch
                        checked={Boolean(draft.crop?.enabled)}
                        onCheckedChange={(checked) => {
                          if (!checked) {
                            handleSelectAspectPreset('original');
                          } else {
                            handleSelectAspectPreset(
                              draft.crop?.aspect_ratio &&
                                draft.crop.aspect_ratio !== 'original'
                                ? (draft.crop.aspect_ratio as AspectRatioPreset)
                                : '9:16'
                            );
                          }
                        }}
                      />
                    </div>

                    {/* Aspect Ratio Pills */}
                    <div className="grid grid-cols-4 gap-1.5">
                      {ASPECT_RATIO_PRESETS.filter((p) => p.id !== 'custom').map(
                        (p) => {
                          const active =
                            (draft.crop?.enabled
                              ? draft.crop.aspect_ratio
                              : 'original') === p.id;
                          return (
                            <HintTooltip
                              key={p.id}
                              label={`${p.label} (${p.subtitle})`}
                              side="top"
                            >
                              <button
                                type="button"
                                onClick={() => handleSelectAspectPreset(p.id)}
                                className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-all ${
                                  active
                                    ? 'bg-primary text-primary-foreground border-primary shadow-2xs'
                                    : 'bg-card border-border text-muted-foreground hover:text-foreground'
                                }`}
                              >
                                {p.label}
                              </button>
                            </HintTooltip>
                          );
                        }
                      )}
                    </div>

                    {draft.crop?.enabled && (
                      <div className="space-y-3 pt-1 border-t border-border/60">
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="inline-flex rounded-lg bg-muted p-0.5 border border-border">
                            {(['crop', 'pad'] as const).map((mode) => (
                              <HintTooltip
                                key={mode}
                                label={
                                  mode === 'crop'
                                    ? 'Crop to Fill Frame'
                                    : 'Fit Inside with Letterbox Bars'
                                }
                                side="top"
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateDraft((prev) => ({
                                      ...prev,
                                      crop: {
                                        ...(prev.crop || DEFAULT_CROP_SETTINGS),
                                        fit_mode: mode,
                                      },
                                    }))
                                  }
                                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
                                    draft.crop?.fit_mode === mode
                                      ? 'bg-primary text-primary-foreground'
                                      : 'text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  {mode}
                                </button>
                              </HintTooltip>
                            ))}
                          </div>

                          <div className="flex items-center gap-1">
                            <HintTooltip
                              label="Center Crop Window"
                              detail="Snap pan X/Y back to frame center"
                              side="top"
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                onClick={handleCenterCropFrame}
                                aria-label="Center crop frame"
                              >
                                <Crosshair className="h-3.5 w-3.5" />
                              </Button>
                            </HintTooltip>

                            <HintTooltip
                              label="Interactive Crop Canvas"
                              detail="Drag & resize the crop box on the full source frame"
                              side="top"
                            >
                              <Button
                                type="button"
                                variant={cropBoxEditMode ? 'default' : 'outline'}
                                size="xs"
                                onClick={() => setCropBoxEditMode((v) => !v)}
                              >
                                <Move className="h-3 w-3" />
                                {cropBoxEditMode ? 'Done' : 'Drag Box'}
                              </Button>
                            </HintTooltip>
                          </div>
                        </div>

                        {/* Zoom Slider */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Zoom</span>
                            <span className="font-mono tabular-nums">
                              {(draft.crop?.zoom || 1).toFixed(2)}×
                            </span>
                          </div>
                          <Slider
                            min={1.0}
                            max={2.5}
                            step={0.05}
                            value={[draft.crop?.zoom || 1]}
                            onValueChange={(vals) => {
                              const z = vals[0] ?? 1;
                              const srcWidth = sourceAsset?.width || 1920;
                              const srcHeight = sourceAsset?.height || 1080;
                              const cur = draft.crop || DEFAULT_CROP_SETTINGS;
                              const box = computeAspectCropSize(
                                cur.aspect_ratio || '9:16',
                                srcWidth,
                                srcHeight,
                                z
                              );
                              const cx = cur.x + cur.width / 2;
                              const cy = cur.y + cur.height / 2;
                              updateDraft((prev) => ({
                                ...prev,
                                crop: {
                                  ...(prev.crop || DEFAULT_CROP_SETTINGS),
                                  enabled: true,
                                  zoom: z,
                                  width: box.width,
                                  height: box.height,
                                  x: Math.max(
                                    0,
                                    Math.min(1 - box.width, cx - box.width / 2)
                                  ),
                                  y: Math.max(
                                    0,
                                    Math.min(1 - box.height, cy - box.height / 2)
                                  ),
                                },
                              }));
                            }}
                          />
                        </div>

                        {/* Manual Horizontal & Vertical Pan Sliders */}
                        {cropMaxPanX > 0.002 && (
                          <div className="space-y-1">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">
                                Pan X
                              </span>
                              <span className="font-mono tabular-nums">
                                {Math.round(
                                  ((draft.crop?.x || 0) / cropMaxPanX) * 100
                                )}
                                %
                              </span>
                            </div>
                            <Slider
                              min={0}
                              max={Number(cropMaxPanX.toFixed(4))}
                              step={0.005}
                              value={[
                                Math.min(draft.crop?.x || 0, cropMaxPanX),
                              ]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  handleUpdateCropBox({ x: vals[0] });
                                }
                              }}
                            />
                          </div>
                        )}

                        {cropMaxPanY > 0.002 && (
                          <div className="space-y-1">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">
                                Pan Y
                              </span>
                              <span className="font-mono tabular-nums">
                                {Math.round(
                                  ((draft.crop?.y || 0) / cropMaxPanY) * 100
                                )}
                                %
                              </span>
                            </div>
                            <Slider
                              min={0}
                              max={Number(cropMaxPanY.toFixed(4))}
                              step={0.005}
                              value={[
                                Math.min(draft.crop?.y || 0, cropMaxPanY),
                              ]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  handleUpdateCropBox({ y: vals[0] });
                                }
                              }}
                            />
                          </div>
                        )}

                        {/* AI Face Framing Card */}
                        <div className="rounded-lg bg-muted/45 border border-border p-2.5 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <ScanFace className="h-3.5 w-3.5 text-primary" />
                              AI Face Framing
                            </span>
                            <Switch
                              checked={Boolean(draft.crop?.auto_face_framing)}
                              onCheckedChange={(checked) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  crop: {
                                    ...(prev.crop || DEFAULT_CROP_SETTINGS),
                                    enabled: true,
                                    auto_face_framing: checked,
                                  },
                                }))
                              }
                            />
                          </div>

                          {draft.crop?.auto_face_framing && (
                            <div className="flex items-center justify-between gap-2 pt-1">
                              <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
                                <Switch
                                  checked={Boolean(draft.crop?.dynamic_tracking)}
                                  onCheckedChange={(checked) =>
                                    updateDraft((prev) => ({
                                      ...prev,
                                      crop: {
                                        ...(prev.crop || DEFAULT_CROP_SETTINGS),
                                        dynamic_tracking: checked,
                                      },
                                    }))
                                  }
                                />
                                Track Speaker
                              </label>

                              <HintTooltip
                                label="Run Face Detection Now"
                                detail="Sample frames with YuNet ONNX & preview speaker crop"
                                side="top"
                              >
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="xs"
                                  disabled={detectingFace || !sourceAsset}
                                  onClick={() =>
                                    void handleTestAutoFaceOnCurrent()
                                  }
                                >
                                  {detectingFace ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <ScanFace className="h-3 w-3" />
                                  )}
                                  Detect
                                </Button>
                              </HintTooltip>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== 3. SUBTITLES TAB ==================== */}
                {activeTab === 'subtitles' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Burn-in Subtitles</span>
                      <Switch
                        checked={draft.subtitles.enabled}
                        onCheckedChange={(checked) =>
                          updateDraft((prev) => ({
                            ...prev,
                            subtitles: { ...prev.subtitles, enabled: checked },
                          }))
                        }
                      />
                    </div>

                    {/* AI Transcription Action Row + Sub-tab Switcher */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="inline-flex rounded-lg bg-muted p-0.5 border border-border">
                        <button
                          type="button"
                          onClick={() => setSubtitleSubTab('cues')}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                            subtitleSubTab === 'cues'
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Cues ({effectiveCues.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setSubtitleSubTab('style')}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                            subtitleSubTab === 'style'
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Style
                        </button>
                      </div>

                      <div className="flex items-center gap-1">
                        {effectiveCues.length > 0 && activeSubVersion > 0 && (
                          <HintTooltip
                            label="Export .SRT File"
                            detail="Download SubRip captions for external platforms"
                            side="top"
                          >
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() =>
                                void videoApi.downloadSubtitlesSrt(
                                  item.project_id,
                                  activeSubVersion
                                )
                              }
                            >
                              <Download className="h-3 w-3" />
                              SRT
                            </Button>
                          </HintTooltip>
                        )}

                        <HintTooltip
                          label="Generate AI Subtitles"
                          detail="Transcribe speech for this clip with Whisper"
                          side="top"
                        >
                          <Button
                            type="button"
                            size="xs"
                            disabled={isTranscribingRow || !sourceAsset}
                            onClick={() => void handleGenerateRowSubtitles()}
                          >
                            {isTranscribingRow ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Sparkles className="h-3 w-3" />
                            )}
                            {isTranscribingRow
                              ? 'Transcribing...'
                              : effectiveCues.length > 0
                              ? 'Regenerate'
                              : 'Generate AI'}
                          </Button>
                        </HintTooltip>
                      </div>
                    </div>

                    {subtitleSubTab === 'cues' ? (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <select
                            value={draft.subtitles.language}
                            onChange={(e) =>
                              updateDraft((prev) => ({
                                ...prev,
                                subtitles: {
                                  ...prev.subtitles,
                                  language: e.target.value,
                                },
                              }))
                            }
                            aria-label="Transcription language"
                            className="rounded-lg bg-card border border-border px-2 py-1 text-[11px]"
                          >
                            {supportedLanguages.map((lang) => (
                              <option key={lang.code} value={lang.code}>
                                {lang.name}
                              </option>
                            ))}
                          </select>

                          <HintTooltip
                            label="Add Cue at Playhead"
                            detail="Insert manual subtitle cue at current timestamp"
                            side="top"
                          >
                            <Button
                              type="button"
                              variant="secondary"
                              size="xs"
                              onClick={handleAddCueAtPlayhead}
                            >
                              <Plus className="h-3 w-3" />
                              Add Cue
                            </Button>
                          </HintTooltip>
                        </div>

                        {effectiveCues.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-border py-6 px-3 text-center text-[11px] text-muted-foreground">
                            Click <strong>Generate AI</strong> or{' '}
                            <strong>Add Cue</strong> to edit captions.
                          </div>
                        ) : (
                          <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                            {effectiveCues.map((cue, idx) => {
                              const isCurrent =
                                currentTimeMs >= cue.start_ms &&
                                currentTimeMs <= cue.end_ms;
                              return (
                                <div
                                  key={`cue-${idx}`}
                                  className={`rounded-lg border p-2 space-y-1.5 transition-colors ${
                                    isCurrent
                                      ? 'border-primary/60 bg-primary/5'
                                      : 'border-border bg-card'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-1.5">
                                    <div className="flex items-center gap-1">
                                      <HintTooltip
                                        label="Jump Playhead to Cue"
                                        side="top"
                                      >
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setCurrentTimeMs(cue.start_ms)
                                          }
                                          className="text-[10px] font-mono font-semibold text-primary px-1"
                                        >
                                          #{idx + 1}
                                        </button>
                                      </HintTooltip>
                                      <NumberInput
                                        size="sm"
                                        min={0}
                                        max={Number(
                                          Math.max(0, (cue.end_ms - 100) / 1000).toFixed(2)
                                        )}
                                        step={0.1}
                                        value={Number(
                                          (cue.start_ms / 1000).toFixed(2)
                                        )}
                                        ariaLabel={`Cue ${idx + 1} start seconds`}
                                        className="w-20"
                                        onValueChange={(val) => {
                                          const ms = Math.max(
                                            0,
                                            Math.round((val ?? 0) * 1000)
                                          );
                                          mutateRowCues((prev) =>
                                            prev.map((c, i) =>
                                              i === idx
                                                ? {
                                                    ...c,
                                                    start_ms: Math.min(
                                                      ms,
                                                      c.end_ms - 100
                                                    ),
                                                  }
                                                : c
                                            )
                                          );
                                        }}
                                      />
                                      <span className="text-muted-foreground">
                                        →
                                      </span>
                                      <NumberInput
                                        size="sm"
                                        min={Number(
                                          ((cue.start_ms + 100) / 1000).toFixed(2)
                                        )}
                                        step={0.1}
                                        value={Number(
                                          (cue.end_ms / 1000).toFixed(2)
                                        )}
                                        ariaLabel={`Cue ${idx + 1} end seconds`}
                                        className="w-20"
                                        onValueChange={(val) => {
                                          const ms = Math.max(
                                            cue.start_ms + 100,
                                            Math.round((val ?? 0.1) * 1000)
                                          );
                                          mutateRowCues((prev) =>
                                            prev.map((c, i) =>
                                              i === idx
                                                ? { ...c, end_ms: ms }
                                                : c
                                            )
                                          );
                                        }}
                                      />
                                    </div>

                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() =>
                                        mutateRowCues((prev) =>
                                          prev.filter((_, i) => i !== idx)
                                        )
                                      }
                                      aria-label={`Delete cue ${idx + 1}`}
                                      className="text-muted-foreground hover:text-destructive"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>

                                  <textarea
                                    rows={2}
                                    value={cue.text}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      mutateRowCues((prev) =>
                                        prev.map((c, i) =>
                                          i === idx ? { ...c, text: val } : c
                                        )
                                      );
                                    }}
                                    className="w-full rounded bg-background border border-border px-2 py-1 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* Full Typography & Style Controls */
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground">
                              Font
                            </label>
                            <select
                              value={draft.subtitles.style.font_family}
                              onChange={(e) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  subtitles: {
                                    ...prev.subtitles,
                                    style: {
                                      ...prev.subtitles.style,
                                      font_family: e.target.value,
                                    },
                                  },
                                }))
                              }
                              className="w-full rounded-lg bg-card border border-border px-2 py-1.5 text-xs"
                            >
                              {allowedFonts.map((f) => (
                                <option key={f} value={f}>
                                  {f}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground">
                              Alignment
                            </label>
                            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-0.5 border border-border">
                              {(
                                [
                                  { id: 'left', icon: AlignLeft, label: 'Left' },
                                  {
                                    id: 'center',
                                    icon: AlignCenter,
                                    label: 'Center',
                                  },
                                  {
                                    id: 'right',
                                    icon: AlignRight,
                                    label: 'Right',
                                  },
                                ] as const
                              ).map((al) => {
                                const Icon = al.icon;
                                const active =
                                  (draft.subtitles.style.alignment ||
                                    'center') === al.id;
                                return (
                                  <HintTooltip
                                    key={al.id}
                                    label={`Align ${al.label}`}
                                    side="top"
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateDraft((prev) => ({
                                          ...prev,
                                          subtitles: {
                                            ...prev.subtitles,
                                            style: {
                                              ...prev.subtitles.style,
                                              alignment: al.id,
                                            },
                                          },
                                        }))
                                      }
                                      className={`h-7 rounded flex items-center justify-center transition-colors ${
                                        active
                                          ? 'bg-primary text-primary-foreground'
                                          : 'text-muted-foreground hover:text-foreground'
                                      }`}
                                    >
                                      <Icon className="h-3.5 w-3.5" />
                                    </button>
                                  </HintTooltip>
                                );
                              })}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Size</span>
                            <span className="font-mono tabular-nums">
                              {draft.subtitles.style.font_size}px
                            </span>
                          </div>
                          <Slider
                            min={18}
                            max={84}
                            step={1}
                            value={[draft.subtitles.style.font_size]}
                            onValueChange={(vals) => {
                              if (vals[0] !== undefined) {
                                updateDraft((prev) => ({
                                  ...prev,
                                  subtitles: {
                                    ...prev.subtitles,
                                    style: {
                                      ...prev.subtitles.style,
                                      font_size: vals[0],
                                    },
                                  },
                                }));
                              }
                            }}
                          />
                        </div>

                        {/* Text Color + Outline + Shadow + Background */}
                        <div className="grid grid-cols-2 gap-2">
                          <label className="flex items-center justify-between rounded-lg bg-card border border-border px-2.5 py-1.5">
                            <span className="text-[11px] text-muted-foreground">
                              Text
                            </span>
                            <input
                              type="color"
                              value={draft.subtitles.style.text_color}
                              onChange={(e) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  subtitles: {
                                    ...prev.subtitles,
                                    style: {
                                      ...prev.subtitles.style,
                                      text_color: e.target.value,
                                    },
                                  },
                                }))
                              }
                              className="h-5 w-7 rounded border border-border bg-transparent cursor-pointer"
                            />
                          </label>

                          <div className="flex items-center justify-between rounded-lg bg-card border border-border px-2.5 py-1.5">
                            <span className="text-[11px] text-muted-foreground">
                              Shadow
                            </span>
                            <Switch
                              checked={draft.subtitles.style.shadow_enabled}
                              onCheckedChange={(checked) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  subtitles: {
                                    ...prev.subtitles,
                                    style: {
                                      ...prev.subtitles.style,
                                      shadow_enabled: checked,
                                    },
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>

                        {draft.subtitles.style.shadow_enabled && (
                          <div className="space-y-1">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">
                                Shadow Depth
                              </span>
                              <span className="font-mono tabular-nums">
                                {draft.subtitles.style.shadow_depth}px
                              </span>
                            </div>
                            <Slider
                              min={1}
                              max={8}
                              step={1}
                              value={[draft.subtitles.style.shadow_depth || 2]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    subtitles: {
                                      ...prev.subtitles,
                                      style: {
                                        ...prev.subtitles.style,
                                        shadow_depth: vals[0],
                                      },
                                    },
                                  }));
                                }
                              }}
                            />
                          </div>
                        )}

                        {/* Outline Controls */}
                        <div className="rounded-lg bg-card border border-border p-2.5 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium">
                              Outline Stroke
                            </span>
                            <div className="flex items-center gap-2">
                              {draft.subtitles.style.outline_enabled && (
                                <input
                                  type="color"
                                  value={draft.subtitles.style.outline_color}
                                  onChange={(e) =>
                                    updateDraft((prev) => ({
                                      ...prev,
                                      subtitles: {
                                        ...prev.subtitles,
                                        style: {
                                          ...prev.subtitles.style,
                                          outline_color: e.target.value,
                                        },
                                      },
                                    }))
                                  }
                                  className="h-5 w-6 rounded border border-border bg-transparent cursor-pointer"
                                />
                              )}
                              <Switch
                                checked={draft.subtitles.style.outline_enabled}
                                onCheckedChange={(checked) =>
                                  updateDraft((prev) => ({
                                    ...prev,
                                    subtitles: {
                                      ...prev.subtitles,
                                      style: {
                                        ...prev.subtitles.style,
                                        outline_enabled: checked,
                                      },
                                    },
                                  }))
                                }
                              />
                            </div>
                          </div>

                          {draft.subtitles.style.outline_enabled && (
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">
                                  Thickness
                                </span>
                                <span className="font-mono">
                                  {draft.subtitles.style.outline_thickness}px
                                </span>
                              </div>
                              <Slider
                                min={1}
                                max={8}
                                step={1}
                                value={[
                                  draft.subtitles.style.outline_thickness || 3,
                                ]}
                                onValueChange={(vals) => {
                                  if (vals[0] !== undefined) {
                                    updateDraft((prev) => ({
                                      ...prev,
                                      subtitles: {
                                        ...prev.subtitles,
                                        style: {
                                          ...prev.subtitles.style,
                                          outline_thickness: vals[0],
                                        },
                                      },
                                    }));
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>

                        {/* Background Box Controls */}
                        <div className="rounded-lg bg-card border border-border p-2.5 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium">
                              Background Box
                            </span>
                            <div className="flex items-center gap-2">
                              {draft.subtitles.style.background_enabled && (
                                <input
                                  type="color"
                                  value={draft.subtitles.style.background_color}
                                  onChange={(e) =>
                                    updateDraft((prev) => ({
                                      ...prev,
                                      subtitles: {
                                        ...prev.subtitles,
                                        style: {
                                          ...prev.subtitles.style,
                                          background_color: e.target.value,
                                        },
                                      },
                                    }))
                                  }
                                  className="h-5 w-6 rounded border border-border bg-transparent cursor-pointer"
                                />
                              )}
                              <Switch
                                checked={
                                  draft.subtitles.style.background_enabled
                                }
                                onCheckedChange={(checked) =>
                                  updateDraft((prev) => ({
                                    ...prev,
                                    subtitles: {
                                      ...prev.subtitles,
                                      style: {
                                        ...prev.subtitles.style,
                                        background_enabled: checked,
                                      },
                                    },
                                  }))
                                }
                              />
                            </div>
                          </div>

                          {draft.subtitles.style.background_enabled && (
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">
                                  Opacity
                                </span>
                                <span className="font-mono">
                                  {Math.round(
                                    (draft.subtitles.style.background_opacity ??
                                      0.65) * 100
                                  )}
                                  %
                                </span>
                              </div>
                              <Slider
                                min={0.1}
                                max={1.0}
                                step={0.05}
                                value={[
                                  draft.subtitles.style.background_opacity ??
                                    0.65,
                                ]}
                                onValueChange={(vals) => {
                                  if (vals[0] !== undefined) {
                                    updateDraft((prev) => ({
                                      ...prev,
                                      subtitles: {
                                        ...prev.subtitles,
                                        style: {
                                          ...prev.subtitles.style,
                                          background_opacity: vals[0],
                                        },
                                      },
                                    }));
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>

                        {/* Anchor + Margins */}
                        <div className="grid grid-cols-2 gap-3 items-start pt-1">
                          <PositionGridPicker
                            label="Anchor"
                            value={draft.subtitles.style.position}
                            customCoordinatesActive={
                              draft.subtitles.style.x_ratio !== null
                            }
                            onChange={(pos: AnchorPosition) =>
                              updateDraft((prev) => ({
                                ...prev,
                                subtitles: {
                                  ...prev.subtitles,
                                  style: {
                                    ...prev.subtitles.style,
                                    position: pos,
                                    x_ratio: null,
                                    y_ratio: null,
                                  },
                                },
                              }))
                            }
                          />

                          <div className="space-y-2.5">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">
                                  Margin V
                                </span>
                                <span className="font-mono">
                                  {Math.round(
                                    (draft.subtitles.style.margin_v_ratio ??
                                      0.06) * 100
                                  )}
                                  %
                                </span>
                              </div>
                              <Slider
                                min={0}
                                max={0.2}
                                step={0.01}
                                value={[
                                  draft.subtitles.style.margin_v_ratio ?? 0.06,
                                ]}
                                onValueChange={(vals) => {
                                  if (vals[0] !== undefined) {
                                    updateDraft((prev) => ({
                                      ...prev,
                                      subtitles: {
                                        ...prev.subtitles,
                                        style: {
                                          ...prev.subtitles.style,
                                          margin_v_ratio: vals[0],
                                        },
                                      },
                                    }));
                                  }
                                }}
                              />
                            </div>

                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">
                                  Margin H
                                </span>
                                <span className="font-mono">
                                  {Math.round(
                                    (draft.subtitles.style.margin_h_ratio ??
                                      0.05) * 100
                                  )}
                                  %
                                </span>
                              </div>
                              <Slider
                                min={0.02}
                                max={0.2}
                                step={0.01}
                                value={[
                                  draft.subtitles.style.margin_h_ratio ?? 0.05,
                                ]}
                                onValueChange={(vals) => {
                                  if (vals[0] !== undefined) {
                                    updateDraft((prev) => ({
                                      ...prev,
                                      subtitles: {
                                        ...prev.subtitles,
                                        style: {
                                          ...prev.subtitles.style,
                                          margin_h_ratio: vals[0],
                                        },
                                      },
                                    }));
                                  }
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== 4. COLOR TAB ==================== */}
                {activeTab === 'color' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Color Grading</span>
                      <div className="flex items-center gap-1.5">
                        {draft.color_correction?.enabled && (
                          <>
                            <HintTooltip
                              label="A/B Bypass Grade"
                              detail="Compare ungraded source vs active grade"
                              side="top"
                            >
                              <Button
                                type="button"
                                variant={bypassColor ? 'default' : 'ghost'}
                                size="xs"
                                onClick={() => setBypassColor((v) => !v)}
                              >
                                <SplitSquareHorizontal className="h-3 w-3" />
                                A/B
                              </Button>
                            </HintTooltip>
                            <HintTooltip label="Reset Color" side="top">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                onClick={() =>
                                  updateDraft((prev) => ({
                                    ...prev,
                                    color_correction: {
                                      ...prev.color_correction,
                                      enabled: false,
                                      preset: 'none',
                                      brightness: 0,
                                      contrast: 1,
                                      saturation: 1,
                                      gamma: 1,
                                      temperature: 0,
                                      tint: 0,
                                      sharpen: 0,
                                    },
                                  }))
                                }
                              >
                                <RotateCcw className="h-3 w-3" />
                              </Button>
                            </HintTooltip>
                          </>
                        )}
                        <Switch
                          checked={Boolean(draft.color_correction?.enabled)}
                          onCheckedChange={(checked) =>
                            updateDraft((prev) => ({
                              ...prev,
                              color_correction: {
                                ...prev.color_correction,
                                enabled: checked,
                              },
                            }))
                          }
                        />
                      </div>
                    </div>

                    {/* All Color Presets */}
                    <div className="grid grid-cols-3 gap-1.5">
                      {COLOR_PRESETS.map((p) => {
                        const active =
                          (draft.color_correction?.enabled
                            ? draft.color_correction.preset
                            : 'none') === p.id;
                        return (
                          <HintTooltip
                            key={p.id}
                            label={p.label}
                            detail={p.badge}
                            side="top"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  color_correction: {
                                    ...prev.color_correction,
                                    enabled: p.id !== 'none',
                                    preset: p.id,
                                    ...p.values,
                                  },
                                }))
                              }
                              className={`py-1 px-2 rounded-lg border text-[11px] font-medium truncate transition-all ${
                                active
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-card border-border text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {p.label}
                            </button>
                          </HintTooltip>
                        );
                      })}
                    </div>

                    {/* Full 7 Color Sliders */}
                    {draft.color_correction?.enabled && (
                      <div className="space-y-2.5 pt-1 border-t border-border/60">
                        {(
                          [
                            {
                              key: 'brightness',
                              label: 'Brightness',
                              min: -0.4,
                              max: 0.4,
                              step: 0.02,
                              fmt: (v: number) =>
                                `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`,
                            },
                            {
                              key: 'contrast',
                              label: 'Contrast',
                              min: 0.6,
                              max: 1.7,
                              step: 0.02,
                              fmt: (v: number) => `${v.toFixed(2)}×`,
                            },
                            {
                              key: 'saturation',
                              label: 'Saturation',
                              min: 0,
                              max: 2.2,
                              step: 0.05,
                              fmt: (v: number) => `${v.toFixed(2)}×`,
                            },
                            {
                              key: 'gamma',
                              label: 'Gamma',
                              min: 0.5,
                              max: 2.0,
                              step: 0.02,
                              fmt: (v: number) => v.toFixed(2),
                            },
                            {
                              key: 'temperature',
                              label: 'Warmth',
                              min: -0.6,
                              max: 0.6,
                              step: 0.02,
                              fmt: (v: number) =>
                                `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`,
                            },
                            {
                              key: 'tint',
                              label: 'Tint (G/M)',
                              min: -0.5,
                              max: 0.5,
                              step: 0.02,
                              fmt: (v: number) =>
                                `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`,
                            },
                            {
                              key: 'sharpen',
                              label: 'Sharpen',
                              min: 0,
                              max: 1.5,
                              step: 0.05,
                              fmt: (v: number) => `${Math.round(v * 100)}%`,
                            },
                          ] as const
                        ).map((ctrl) => {
                          const val = draft.color_correction[ctrl.key];
                          return (
                            <div key={ctrl.key} className="space-y-1">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">
                                  {ctrl.label}
                                </span>
                                <span className="font-mono tabular-nums">
                                  {ctrl.fmt(val)}
                                </span>
                              </div>
                              <Slider
                                min={ctrl.min}
                                max={ctrl.max}
                                step={ctrl.step}
                                value={[val]}
                                onValueChange={(vals) => {
                                  if (vals[0] !== undefined) {
                                    const nextVal = vals[0];
                                    updateDraft((prev) => ({
                                      ...prev,
                                      color_correction: {
                                        ...prev.color_correction,
                                        enabled: true,
                                        preset: 'custom',
                                        [ctrl.key]: nextVal,
                                      },
                                    }));
                                  }
                                }}
                              />
                            </div>
                          );
                        })}

                        <div className="flex items-center justify-between pt-1">
                          <span className="text-[11px] text-muted-foreground">
                            Apply grade to Outro clip
                          </span>
                          <Switch
                            checked={Boolean(
                              draft.color_correction.apply_to_outro
                            )}
                            onCheckedChange={(checked) =>
                              updateDraft((prev) => ({
                                ...prev,
                                color_correction: {
                                  ...prev.color_correction,
                                  apply_to_outro: checked,
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== 5. AUDIO TAB ==================== */}
                {activeTab === 'audio' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Audio Enhancement</span>
                      <div className="flex items-center gap-1.5">
                        {draft.audio_enhancement?.enabled && (
                          <HintTooltip
                            label="A/B Bypass Audio"
                            detail="Listen to raw vs cleaned audio live"
                            side="top"
                          >
                            <Button
                              type="button"
                              variant={bypassAudio ? 'default' : 'ghost'}
                              size="xs"
                              onClick={() => setBypassAudio((v) => !v)}
                            >
                              <SplitSquareHorizontal className="h-3 w-3" />
                              A/B
                            </Button>
                          </HintTooltip>
                        )}
                        <Switch
                          checked={Boolean(draft.audio_enhancement?.enabled)}
                          onCheckedChange={(checked) =>
                            updateDraft((prev) => ({
                              ...prev,
                              audio_enhancement: {
                                ...prev.audio_enhancement,
                                enabled: checked,
                              },
                            }))
                          }
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      {BATCH_AUDIO_PRESETS.map((p) => {
                        const active =
                          draft.audio_enhancement?.enabled &&
                          draft.audio_enhancement.preset === p.id;
                        return (
                          <HintTooltip
                            key={p.id}
                            label={p.label}
                            detail={p.hint}
                            side="top"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  audio_enhancement: {
                                    ...prev.audio_enhancement,
                                    enabled: true,
                                    preset: p.id,
                                    ...p.values,
                                  },
                                }))
                              }
                              className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-medium transition-all ${
                                active
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-card border-border text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {p.label}
                            </button>
                          </HintTooltip>
                        );
                      })}
                    </div>

                    {draft.audio_enhancement?.enabled && (
                      <div className="space-y-2.5 pt-1 border-t border-border/60">
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">
                              Noise Reduction
                            </span>
                            <span className="font-mono tabular-nums">
                              {Math.round(
                                (draft.audio_enhancement?.noise_reduction ||
                                  0) * 100
                              )}
                              %
                            </span>
                          </div>
                          <Slider
                            min={0}
                            max={1}
                            step={0.05}
                            value={[
                              draft.audio_enhancement?.noise_reduction || 0,
                            ]}
                            onValueChange={(vals) => {
                              if (vals[0] !== undefined) {
                                updateDraft((prev) => ({
                                  ...prev,
                                  audio_enhancement: {
                                    ...prev.audio_enhancement,
                                    enabled: true,
                                    preset: 'custom',
                                    noise_reduction: vals[0],
                                  },
                                }));
                              }
                            }}
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">
                              Voice Clarity (3 kHz)
                            </span>
                            <span className="font-mono tabular-nums">
                              {Math.round(
                                (draft.audio_enhancement?.voice_clarity || 0) *
                                  100
                              )}
                              %
                            </span>
                          </div>
                          <Slider
                            min={0}
                            max={1}
                            step={0.05}
                            value={[
                              draft.audio_enhancement?.voice_clarity || 0,
                            ]}
                            onValueChange={(vals) => {
                              if (vals[0] !== undefined) {
                                updateDraft((prev) => ({
                                  ...prev,
                                  audio_enhancement: {
                                    ...prev.audio_enhancement,
                                    enabled: true,
                                    preset: 'custom',
                                    voice_clarity: vals[0],
                                  },
                                }));
                              }
                            }}
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">
                              Volume Gain
                            </span>
                            <span className="font-mono tabular-nums">
                              {(draft.audio_enhancement?.volume_db || 0) >= 0
                                ? '+'
                                : ''}
                              {(
                                draft.audio_enhancement?.volume_db || 0
                              ).toFixed(1)}{' '}
                              dB
                            </span>
                          </div>
                          <Slider
                            min={-12}
                            max={12}
                            step={0.5}
                            value={[draft.audio_enhancement?.volume_db || 0]}
                            onValueChange={(vals) => {
                              if (vals[0] !== undefined) {
                                updateDraft((prev) => ({
                                  ...prev,
                                  audio_enhancement: {
                                    ...prev.audio_enhancement,
                                    enabled: true,
                                    preset: 'custom',
                                    volume_db: vals[0],
                                  },
                                }));
                              }
                            }}
                          />
                        </div>

                        {/* Frequency Bandpass Controls */}
                        <div className="grid grid-cols-2 gap-2.5 pt-0.5">
                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">
                                Low-Cut
                              </span>
                              <span className="font-mono">
                                {draft.audio_enhancement?.highpass_hz || 80}Hz
                              </span>
                            </div>
                            <Slider
                              min={20}
                              max={300}
                              step={5}
                              value={[
                                draft.audio_enhancement?.highpass_hz || 80,
                              ]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    audio_enhancement: {
                                      ...prev.audio_enhancement,
                                      preset: 'custom',
                                      highpass_hz: vals[0],
                                    },
                                  }));
                                }
                              }}
                            />
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">
                                High-Cut
                              </span>
                              <span className="font-mono">
                                {(
                                  (draft.audio_enhancement?.lowpass_hz ||
                                    16000) / 1000
                                ).toFixed(1)}
                                kHz
                              </span>
                            </div>
                            <Slider
                              min={4000}
                              max={20000}
                              step={500}
                              value={[
                                draft.audio_enhancement?.lowpass_hz || 16000,
                              ]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    audio_enhancement: {
                                      ...prev.audio_enhancement,
                                      preset: 'custom',
                                      lowpass_hz: vals[0],
                                    },
                                  }));
                                }
                              }}
                            />
                          </div>
                        </div>

                        <div className="space-y-2 pt-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">
                              Normalize Loudness (-16 LUFS)
                            </span>
                            <Switch
                              checked={Boolean(
                                draft.audio_enhancement?.normalize_loudness
                              )}
                              onCheckedChange={(checked) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  audio_enhancement: {
                                    ...prev.audio_enhancement,
                                    normalize_loudness: checked,
                                  },
                                }))
                              }
                            />
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">
                              Clean before AI transcription
                            </span>
                            <Switch
                              checked={Boolean(
                                draft.audio_enhancement?.apply_to_transcription
                              )}
                              onCheckedChange={(checked) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  audio_enhancement: {
                                    ...prev.audio_enhancement,
                                    apply_to_transcription: checked,
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== 6. LOGO TAB ==================== */}
                {activeTab === 'logo' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-2 rounded-lg bg-card border border-border px-2.5 py-2">
                      {logoAsset ? (
                        <div className="flex items-center gap-2 min-w-0">
                          {logoAsset.stream_url && (
                            <img
                              src={logoAsset.stream_url}
                              alt={logoAsset.original_filename}
                              className="h-6 w-8 object-contain rounded bg-black/50 p-0.5 shrink-0"
                            />
                          )}
                          <span className="font-medium truncate">
                            {logoAsset.original_filename}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          No brand logo
                        </span>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          disabled={uploadingSingleKind === 'logo'}
                          onClick={onTriggerSingleLogoUpload}
                        >
                          <Upload className="h-3 w-3" />
                          {logoAsset ? 'Replace' : 'Upload'}
                        </Button>
                        {logoAsset && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => void onRemoveSingleLogo()}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="font-medium">Overlay Brand Logo</span>
                      <Switch
                        checked={draft.logo.enabled}
                        onCheckedChange={(checked) =>
                          updateDraft((prev) => ({
                            ...prev,
                            logo: { ...prev.logo, enabled: checked },
                          }))
                        }
                      />
                    </div>

                    {draft.logo.enabled && (
                      <div className="space-y-3 pt-1 border-t border-border/60">
                        <div className="flex items-start justify-between gap-3">
                          <PositionGridPicker
                            label="Anchor"
                            value={draft.logo.position}
                            customCoordinatesActive={
                              draft.logo.x_ratio !== null &&
                              draft.logo.y_ratio !== null
                            }
                            onChange={(pos: AnchorPosition) =>
                              updateDraft((prev) => ({
                                ...prev,
                                logo: {
                                  ...prev.logo,
                                  enabled: true,
                                  position: pos,
                                  x_ratio: null,
                                  y_ratio: null,
                                },
                              }))
                            }
                          />

                          {/* Quick Size Presets + Fine X/Y */}
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
                                    updateDraft((prev) => ({
                                      ...prev,
                                      logo: {
                                        ...prev.logo,
                                        width_ratio: sz.val,
                                      },
                                    }))
                                  }
                                  className={`py-1 rounded border text-[10px] font-mono transition-colors ${
                                    Math.abs(draft.logo.width_ratio - sz.val) <
                                    0.005
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : 'bg-card border-border text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  {sz.label}
                                </button>
                              ))}
                            </div>

                            {draft.logo.x_ratio !== null &&
                              draft.logo.y_ratio !== null && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() =>
                                    updateDraft((prev) => ({
                                      ...prev,
                                      logo: {
                                        ...prev.logo,
                                        x_ratio: null,
                                        y_ratio: null,
                                      },
                                    }))
                                  }
                                  className="w-full text-[10px]"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Snap to Anchor
                                </Button>
                              )}
                          </div>
                        </div>

                        {/* Fine X / Y Position Sliders */}
                        <div className="grid grid-cols-2 gap-2.5">
                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">X</span>
                              <span className="font-mono">
                                {draft.logo.x_ratio !== null
                                  ? `${Math.round(draft.logo.x_ratio * 100)}%`
                                  : 'grid'}
                              </span>
                            </div>
                            <Slider
                              min={0}
                              max={1}
                              step={0.01}
                              value={[draft.logo.x_ratio ?? 0.95]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    logo: {
                                      ...prev.logo,
                                      x_ratio: vals[0],
                                      y_ratio: prev.logo.y_ratio ?? 0.05,
                                    },
                                  }));
                                }
                              }}
                            />
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Y</span>
                              <span className="font-mono">
                                {draft.logo.y_ratio !== null
                                  ? `${Math.round(draft.logo.y_ratio * 100)}%`
                                  : 'grid'}
                              </span>
                            </div>
                            <Slider
                              min={0}
                              max={1}
                              step={0.01}
                              value={[draft.logo.y_ratio ?? 0.05]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    logo: {
                                      ...prev.logo,
                                      x_ratio: prev.logo.x_ratio ?? 0.95,
                                      y_ratio: vals[0],
                                    },
                                  }));
                                }
                              }}
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">
                              Width
                            </span>
                            <span className="font-mono tabular-nums">
                              {Math.round(draft.logo.width_ratio * 100)}%
                            </span>
                          </div>
                          <Slider
                            min={0.04}
                            max={0.4}
                            step={0.01}
                            value={[draft.logo.width_ratio]}
                            onValueChange={(vals) => {
                              if (vals[0] !== undefined) {
                                updateDraft((prev) => ({
                                  ...prev,
                                  logo: { ...prev.logo, width_ratio: vals[0] },
                                }));
                              }
                            }}
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-2.5">
                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">
                                Opacity
                              </span>
                              <span className="font-mono">
                                {Math.round(draft.logo.opacity * 100)}%
                              </span>
                            </div>
                            <Slider
                              min={0.1}
                              max={1}
                              step={0.05}
                              value={[draft.logo.opacity]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    logo: { ...prev.logo, opacity: vals[0] },
                                  }));
                                }
                              }}
                            />
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">
                                Margin
                              </span>
                              <span className="font-mono">
                                {Math.round(draft.logo.margin_ratio * 100)}%
                              </span>
                            </div>
                            <Slider
                              min={0}
                              max={0.15}
                              step={0.005}
                              value={[draft.logo.margin_ratio]}
                              onValueChange={(vals) => {
                                if (vals[0] !== undefined) {
                                  updateDraft((prev) => ({
                                    ...prev,
                                    logo: {
                                      ...prev.logo,
                                      margin_ratio: vals[0],
                                    },
                                  }));
                                }
                              }}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                          <span className="text-[11px] text-muted-foreground">
                            Show logo during Outro
                          </span>
                          <Switch
                            checked={draft.logo.apply_to_outro}
                            onCheckedChange={(checked) =>
                              updateDraft((prev) => ({
                                ...prev,
                                logo: {
                                  ...prev.logo,
                                  apply_to_outro: checked,
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== 7. OUTRO TAB ==================== */}
                {activeTab === 'outro' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-2 rounded-lg bg-card border border-border px-2.5 py-2">
                      {outroAsset ? (
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {outroAsset.original_filename}
                          </div>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {formatFriendlyDuration(
                              outroAsset.duration_ms || 0
                            )}{' '}
                            · {outroAsset.width}×{outroAsset.height}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          No outro clip
                        </span>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          disabled={uploadingSingleKind === 'outro'}
                          onClick={onTriggerSingleOutroUpload}
                        >
                          <Upload className="h-3 w-3" />
                          {outroAsset ? 'Replace' : 'Upload'}
                        </Button>
                        {outroAsset && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => void onRemoveSingleOutro()}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="font-medium">Append Outro Clip</span>
                      <Switch
                        checked={draft.outro.enabled}
                        onCheckedChange={(checked) =>
                          updateDraft((prev) => ({
                            ...prev,
                            outro: { ...prev.outro, enabled: checked },
                          }))
                        }
                      />
                    </div>

                    {draft.outro.enabled && (
                      <div className="space-y-3 pt-1 border-t border-border/60">
                        <div className="space-y-1.5">
                          <span className="text-[11px] text-muted-foreground">
                            Aspect Fit Mode
                          </span>
                          <div className="grid grid-cols-3 gap-1.5">
                            {(
                              [
                                {
                                  id: 'pad',
                                  label: 'Pad',
                                  hint: 'Letterbox inside output frame',
                                },
                                {
                                  id: 'crop',
                                  label: 'Crop',
                                  hint: 'Zoom-crop to fill output frame',
                                },
                                {
                                  id: 'stretch',
                                  label: 'Stretch',
                                  hint: 'Stretch exact dimensions',
                                },
                              ] as const
                            ).map((mode) => (
                              <HintTooltip
                                key={mode.id}
                                label={mode.label}
                                detail={mode.hint}
                                side="top"
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateDraft((prev) => ({
                                      ...prev,
                                      outro: {
                                        ...prev.outro,
                                        normalization_mode: mode.id,
                                      },
                                    }))
                                  }
                                  className={`py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                                    draft.outro.normalization_mode === mode.id
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : 'bg-card border-border text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  {mode.label}
                                </button>
                              </HintTooltip>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2 pt-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">
                              Keep Logo on Outro
                            </span>
                            <Switch
                              checked={draft.logo.apply_to_outro}
                              onCheckedChange={(checked) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  logo: {
                                    ...prev.logo,
                                    apply_to_outro: checked,
                                  },
                                }))
                              }
                            />
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">
                              Apply Color Grade to Outro
                            </span>
                            <Switch
                              checked={Boolean(
                                draft.color_correction?.apply_to_outro
                              )}
                              onCheckedChange={(checked) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  color_correction: {
                                    ...prev.color_correction,
                                    apply_to_outro: checked,
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== 8. OUTPUT QUALITY TAB ==================== */}
                {activeTab === 'export' && (
                  <div className="space-y-3.5 text-xs">
                    {/* Resolution Presets */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          Output Resolution
                        </span>
                        <span className="font-mono text-[11px]">
                          {effectiveOutDims.width}×{effectiveOutDims.height}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(
                          [
                            { label: 'Auto', edge: null, hint: 'Match source / crop canvas' },
                            { label: '720p', edge: 1280, hint: 'HD 1280px long edge' },
                            { label: '1080p', edge: 1920, hint: 'Full HD 1920px long edge' },
                            { label: '4K', edge: 3840, hint: 'UHD 3840px long edge' },
                          ] as const
                        ).map((tier) => {
                          const curMax =
                            draft.output.width && draft.output.height
                              ? Math.max(draft.output.width, draft.output.height)
                              : null;
                          const active =
                            tier.edge === null
                              ? curMax === null
                              : curMax !== null &&
                                Math.abs(curMax - tier.edge) <= 4;
                          return (
                            <HintTooltip
                              key={tier.label}
                              label={tier.label}
                              detail={tier.hint}
                              side="top"
                            >
                              <button
                                type="button"
                                onClick={() => applyResolutionTier(tier.edge)}
                                className={`py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                                  active
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-card border-border text-muted-foreground hover:text-foreground'
                                }`}
                              >
                                {tier.label}
                              </button>
                            </HintTooltip>
                          );
                        })}
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="space-y-0.5">
                          <label className="text-[10px] text-muted-foreground">
                            Width (px)
                          </label>
                          <NumberInput
                            allowEmpty
                            min={120}
                            max={7680}
                            step={2}
                            fallbackValue={autoFrameDims.width}
                            placeholder={`${autoFrameDims.width}`}
                            value={draft.output.width ?? ''}
                            ariaLabel="Output width pixels"
                            onValueChange={(val) => {
                              const evenVal =
                                val !== null
                                  ? Math.max(2, Math.round(val / 2) * 2)
                                  : null;
                              updateDraft((prev) => ({
                                ...prev,
                                output: { ...prev.output, width: evenVal },
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-0.5">
                          <label className="text-[10px] text-muted-foreground">
                            Height (px)
                          </label>
                          <NumberInput
                            allowEmpty
                            min={120}
                            max={7680}
                            step={2}
                            fallbackValue={autoFrameDims.height}
                            placeholder={`${autoFrameDims.height}`}
                            value={draft.output.height ?? ''}
                            ariaLabel="Output height pixels"
                            onValueChange={(val) => {
                              const evenVal =
                                val !== null
                                  ? Math.max(2, Math.round(val / 2) * 2)
                                  : null;
                              updateDraft((prev) => ({
                                ...prev,
                                output: { ...prev.output, height: evenVal },
                              }));
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Frame Rate */}
                    <div className="space-y-1.5">
                      <span className="text-muted-foreground">Frame Rate</span>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(
                          [
                            { label: 'Source', fps: null },
                            { label: '24 fps', fps: 24 },
                            { label: '30 fps', fps: 30 },
                            { label: '60 fps', fps: 60 },
                          ] as const
                        ).map((opt) => {
                          const active =
                            (draft.output.fps ?? null) === opt.fps;
                          return (
                            <button
                              key={opt.label}
                              type="button"
                              onClick={() =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  output: { ...prev.output, fps: opt.fps },
                                }))
                              }
                              className={`py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                                active
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-card border-border text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* CRF Quality Slider */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <HintTooltip
                          label="H.264 Constant Rate Factor (CRF)"
                          detail="Lower = higher visual fidelity (14–18 Studio HQ, 20 Balanced, 24–28 Compact)"
                          side="top"
                        >
                          <span className="text-muted-foreground cursor-help underline decoration-dotted">
                            CRF Quality
                          </span>
                        </HintTooltip>
                        <span className="font-mono tabular-nums">
                          {draft.output.crf ?? 20}{' '}
                          <span className="text-muted-foreground">
                            (
                            {(draft.output.crf ?? 20) <= 17
                              ? 'Studio HQ'
                              : (draft.output.crf ?? 20) <= 21
                              ? 'Balanced'
                              : 'Compact'}
                            )
                          </span>
                        </span>
                      </div>
                      <Slider
                        min={14}
                        max={28}
                        step={1}
                        value={[draft.output.crf ?? 20]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateDraft((prev) => ({
                              ...prev,
                              output: { ...prev.output, crf: vals[0] },
                            }));
                          }
                        }}
                      />
                    </div>

                    {/* Encoder Preset */}
                    <div className="space-y-1.5">
                      <span className="text-muted-foreground">
                        Encoder Speed
                      </span>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(
                          [
                            { id: 'ultrafast', label: 'Turbo', hint: 'Fastest render, larger file' },
                            { id: 'fast', label: 'Fast', hint: 'Default studio speed' },
                            { id: 'medium', label: 'Medium', hint: 'Higher compression efficiency' },
                            { id: 'slow', label: 'Archival', hint: 'Best compression per byte' },
                          ] as const
                        ).map((pr) => {
                          const active =
                            (draft.output.preset || 'fast') === pr.id;
                          return (
                            <HintTooltip
                              key={pr.id}
                              label={pr.id}
                              detail={pr.hint}
                              side="top"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  updateDraft((prev) => ({
                                    ...prev,
                                    output: { ...prev.output, preset: pr.id },
                                  }))
                                }
                                className={`py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                                  active
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-card border-border text-muted-foreground hover:text-foreground'
                                }`}
                              >
                                {pr.label}
                              </button>
                            </HintTooltip>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Copy Row Edits to All Selected Rows */}
              <HintTooltip
                label="Sync Settings Across Queue"
                detail="Applies this row's active settings to all checked rows in the batch"
                side="top"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={applyingBulk}
                  onClick={() => void handlePushToSelected()}
                  className="w-full"
                >
                  {applyingBulk ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Layers className="h-3.5 w-3.5 text-primary" />
                  )}
                  <span>
                    Copy #{rowNumber} Edits to Selected (
                    {selectedItemIds.length || 'All'})
                  </span>
                </Button>
              </HintTooltip>

              {feedback && (
                <div
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] flex items-center gap-1.5 border ${
                    feedback.kind === 'ok'
                      ? 'bg-card border-border text-foreground'
                      : 'bg-destructive/10 border-destructive/30 text-destructive'
                  }`}
                >
                  {feedback.kind === 'ok' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{feedback.text}</span>
                </div>
              )}
            </div>
          );

          return (
            <div className="p-4">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                {/* Left: Interactive Preview Canvas OR Rendered MP4 */}
                <div
                  className={`${
                    isWidePreview ? 'lg:col-span-12' : 'lg:col-span-7'
                  } space-y-2`}
                >
                  {item.output_asset?.stream_url && (
                    <div className="flex items-center justify-end">
                      <div className="inline-flex rounded-lg bg-muted/60 p-0.5 border border-border">
                        <HintTooltip
                          label="Interactive Edit Canvas"
                          detail="Live preview with draggable overlays"
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={() => setPreviewMode('canvas')}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                              previewMode === 'canvas'
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <Move className="h-3 w-3" />
                            Canvas
                          </button>
                        </HintTooltip>
                        <HintTooltip
                          label="Rendered MP4 Output"
                          detail="Play the final FFmpeg-exported file"
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={() => setPreviewMode('rendered')}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                              previewMode === 'rendered'
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <Eye className="h-3 w-3" />
                            Output MP4
                          </button>
                        </HintTooltip>
                      </div>
                    </div>
                  )}

                  {previewMode === 'rendered' && item.output_asset?.stream_url ? (
                    <div className="rounded-xl bg-black/95 border border-border p-2 space-y-2">
                      <video
                        src={item.output_asset.stream_url}
                        controls
                        playsInline
                        disablePictureInPicture
                        disableRemotePlayback
                        preload="metadata"
                        className="w-full max-h-[440px] rounded-lg object-contain bg-black mx-auto"
                      />
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
                        <span className="font-mono">
                          {item.output_asset.width}×{item.output_asset.height}
                        </span>
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          onClick={() =>
                            void videoApi.downloadOutputAsset(
                              item.output_asset!.id,
                              `${item.title.replace(/[^a-zA-Z0-9._-]+/g, '_')}.mp4`
                            )
                          }
                        >
                          Save MP4
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <InteractiveVideoPreview
                      sourceAsset={sourceAsset}
                      logoAsset={logoAsset}
                      settings={previewSettings}
                      cues={previewCues}
                      currentTimeMs={currentTimeMs}
                      onTimeUpdate={setCurrentTimeMs}
                      dragMode={activeTab === 'subtitles' ? 'subtitles' : 'logo'}
                      bypassColorCorrection={bypassColor}
                      bypassAudioEnhancement={bypassAudio}
                      cropEditorMode={activeTab === 'crop' && cropBoxEditMode}
                      onUpdateCropBox={handleUpdateCropBox}
                      wideMode={isWidePreview}
                      onToggleWideMode={() => setIsWidePreview((v) => !v)}
                      fullscreenInspector={inspectorNode}
                      enableFullscreenToolTabs
                      onFullscreenChange={setIsPreviewFullscreen}
                      onDragLogo={(xRatio, yRatio) => {
                        updateDraft((prev) => ({
                          ...prev,
                          logo: {
                            ...prev.logo,
                            enabled: true,
                            x_ratio: xRatio,
                            y_ratio: yRatio,
                          },
                        }));
                      }}
                      onDragSubtitle={(xRatio, yRatio) => {
                        updateDraft((prev) => ({
                          ...prev,
                          subtitles: {
                            ...prev.subtitles,
                            enabled: true,
                            style: {
                              ...prev.subtitles.style,
                              x_ratio: xRatio,
                              y_ratio: yRatio,
                            },
                          },
                        }));
                      }}
                    />
                  )}
                </div>

                {/* Right: Focused Tool Inspector */}
                <div
                  className={`${
                    isWidePreview ? 'lg:col-span-12' : 'lg:col-span-5'
                  }`}
                >
                  {!isPreviewFullscreen && inspectorNode}
                </div>
              </div>
            </div>
          );
        })()}
    </section>
  );
};
