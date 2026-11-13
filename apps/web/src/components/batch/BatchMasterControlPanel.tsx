import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Crop,
  Sliders,
  Volume2,
  Image as ImageIcon,
  Subtitles,
  Film,
  Sparkles,
  ScanFace,
  RotateCcw,
  UploadCloud,
  Trash2,
  Loader2,
  Ear,
  SplitSquareHorizontal,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ChevronDown,
  ChevronUp,
  Layers,
  CheckCircle2,
  AlertCircle,
  Download,
  Plus,
} from 'lucide-react';
import { extractApiError, videoApi } from '@/api/videoApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { HintTooltip } from '@/components/ui/tooltip';
import {
  BATCH_AUDIO_PRESETS,
  COLOR_PRESETS,
  DEFAULT_CLEAN_AUDIO_PRESET,
  DEFAULT_CROP_SETTINGS,
  DEFAULT_LOGO_PRESET,
  SAMPLE_SUBTITLE_CUES,
  isToolOverriddenOnSettings,
  studioTabToToolKey,
} from '@/lib/batchSettingsMerge';
import {
  ASPECT_RATIO_PRESETS,
  computeAspectCropSize,
  resolveTargetOutputDimensions,
} from '@/lib/cropMath';
import {
  InteractiveVideoPreview,
  type CropBoxPatch,
} from '@/components/studio/InteractiveVideoPreview';
import { PositionGridPicker } from '@/components/studio/PositionGridPicker';
import type { StudioNavbarTab } from '@/store/useWorkflowStore';
import type {
  AnchorPosition,
  AspectRatioPreset,
  Asset,
  BatchDetail,
  EditSettings,
  SubtitleCue,
} from '@/types/video';

interface BatchMasterControlPanelProps {
  batch: BatchDetail;
  activeTab: StudioNavbarTab;
  masterSettings: EditSettings;
  saveState: 'idle' | 'saving' | 'saved';
  allowedFonts: string[];
  supportedLanguages: Array<{ code: string; name: string }>;
  singleLogoAsset: Asset | undefined;
  singleOutroAsset: Asset | undefined;
  uploadingSingleSlot: 'logo' | 'outro' | null;
  onUpdateMaster: (updater: (prev: EditSettings) => EditSettings) => void;
  onResetAllRowsToMasterForTool: () => Promise<void>;
  onBatchUpdated: (updated: BatchDetail) => void;
  onUploadGlobalSlot: (kind: 'logo' | 'outro', files: FileList | null) => void;
  onDesktopPickGlobalSlot: (kind: 'logo' | 'outro') => void;
  onRemoveGlobalSlot: (kind: 'logo' | 'outro') => void;
  isDesktop: boolean;
}

const MASTER_TAB_META: Record<
  Exclude<StudioNavbarTab, 'trim' | 'export'>,
  {
    title: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  crop: { title: 'Master Control · Ratio & Face', icon: Crop },
  subtitles: { title: 'Master Control · Subtitles', icon: Subtitles },
  color: { title: 'Master Control · Color', icon: Sliders },
  audio: { title: 'Master Control · Audio', icon: Volume2 },
  logo: { title: 'Master Control · Logo', icon: ImageIcon },
  outro: { title: 'Master Control · Outro', icon: Film },
};

export const BatchMasterControlPanel: React.FC<BatchMasterControlPanelProps> = ({
  batch,
  activeTab,
  masterSettings,
  saveState,
  allowedFonts,
  supportedLanguages,
  singleLogoAsset,
  singleOutroAsset,
  uploadingSingleSlot,
  onUpdateMaster,
  onResetAllRowsToMasterForTool,
  onBatchUpdated,
  onUploadGlobalSlot,
  onDesktopPickGlobalSlot,
  onRemoveGlobalSlot,
  isDesktop,
}) => {
  const queryClient = useQueryClient();
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const outroInputRef = useRef<HTMLInputElement | null>(null);
  const completedBulkJobIdsRef = useRef<Set<string>>(new Set());

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [previewItemId, setPreviewItemId] = useState<string>('');
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [widePreview, setWidePreview] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [bypassColor, setBypassColor] = useState(false);
  const [comparingRawAudio, setComparingRawAudio] = useState(false);
  const [cropBoxEditMode, setCropBoxEditMode] = useState(false);
  const [subtitleSubTab, setSubtitleSubTab] = useState<'style' | 'cues'>(
    'style'
  );
  const [localRefCuesOverride, setLocalRefCuesOverride] = useState<{
    projectId: string;
    cues: SubtitleCue[];
  } | null>(null);
  const [refCuesDirty, setRefCuesDirty] = useState(false);
  const [bulkTranscribeJobs, setBulkTranscribeJobs] = useState<
    Array<{ projectId: string; jobId: string }>
  >([]);
  const [runningBulkAction, setRunningBulkAction] = useState(false);
  const [resettingOverrides, setResettingOverrides] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  const activeToolKey = studioTabToToolKey(activeTab);

  const referenceItem = useMemo(() => {
    if (previewItemId) {
      const found = batch.items.find((i) => i.id === previewItemId);
      if (found) return found;
    }
    return batch.items[0] ?? null;
  }, [batch.items, previewItemId]);

  const previewSourceAsset: Asset | undefined = useMemo(() => {
    if (!referenceItem?.source_asset_id) return batch.videos[0];
    return (
      batch.videos.find((v) => v.id === referenceItem.source_asset_id) ??
      batch.videos[0]
    );
  }, [batch.videos, referenceItem]);

  const refSubtitlesQuery = useQuery({
    queryKey: [
      'row-subtitles',
      referenceItem?.project_id,
      referenceItem?.subtitle_cue_count,
    ],
    queryFn: () => videoApi.getSubtitleVersion(referenceItem!.project_id, 0),
    enabled:
      Boolean(referenceItem?.project_id) &&
      (activeTab === 'subtitles' || masterSettings.subtitles.enabled),
    staleTime: 15_000,
  });

  const activeRefSubVersion = refSubtitlesQuery.data?.version ?? 0;

  const effectiveRefCues = useMemo<SubtitleCue[]>(() => {
    if (
      localRefCuesOverride !== null &&
      localRefCuesOverride.projectId === referenceItem?.project_id
    ) {
      return localRefCuesOverride.cues;
    }
    return refSubtitlesQuery.data?.cues ?? [];
  }, [
    localRefCuesOverride,
    referenceItem?.project_id,
    refSubtitlesQuery.data?.cues,
  ]);

  // Debounced auto-save when editing preview video cues inside Master Control
  useEffect(() => {
    if (
      !refCuesDirty ||
      localRefCuesOverride === null ||
      localRefCuesOverride.projectId !== referenceItem?.project_id
    ) {
      return;
    }
    const targetProjectId = localRefCuesOverride.projectId;
    const cuesSnapshot = localRefCuesOverride.cues;
    const timer = window.setTimeout(async () => {
      try {
        await videoApi.saveSubtitleVersion(
          targetProjectId,
          activeRefSubVersion,
          masterSettings.subtitles.language || 'en',
          cuesSnapshot
        );
        setRefCuesDirty(false);
        setLocalRefCuesOverride((cur) =>
          cur?.projectId === targetProjectId ? null : cur
        );
        await queryClient.invalidateQueries({
          queryKey: ['row-subtitles', targetProjectId],
        });
        const refreshed = await videoApi.getBatch(batch.id);
        onBatchUpdated(refreshed);
      } catch (err) {
        setFeedback({
          kind: 'err',
          text: extractApiError(err, 'Failed to save subtitle cues.'),
        });
      }
    }, 550);
    return () => window.clearTimeout(timer);
  }, [
    refCuesDirty,
    localRefCuesOverride,
    referenceItem?.project_id,
    activeRefSubVersion,
    masterSettings.subtitles.language,
    queryClient,
    batch.id,
    onBatchUpdated,
  ]);

  // Live polling for bulk Whisper AI transcription jobs started from Master Control
  const bulkTranscribePollQuery = useQuery({
    queryKey: [
      'batch-master-bulk-transcribe',
      batch.id,
      bulkTranscribeJobs.map((j) => j.jobId).join(','),
    ],
    queryFn: async () => {
      const statuses = await Promise.all(
        bulkTranscribeJobs.map(async (entry) => {
          const job = await videoApi.getJob(entry.jobId);
          return { ...entry, job };
        })
      );

      let newlyCompleted = false;
      let completedCount = 0;
      let failedCount = 0;

      for (const s of statuses) {
        if (s.job.status === 'completed') {
          completedCount += 1;
          if (!completedBulkJobIdsRef.current.has(s.jobId)) {
            completedBulkJobIdsRef.current.add(s.jobId);
            newlyCompleted = true;
            await queryClient.invalidateQueries({
              queryKey: ['row-subtitles', s.projectId],
            });
          }
        } else if (s.job.status === 'failed' || s.job.status === 'canceled') {
          failedCount += 1;
        }
      }

      const allFinished =
        completedCount + failedCount === statuses.length && statuses.length > 0;

      if (newlyCompleted || allFinished) {
        setLocalRefCuesOverride(null);
        const refreshed = await videoApi.getBatch(batch.id);
        onBatchUpdated(refreshed);
        await queryClient.invalidateQueries({ queryKey: ['row-subtitles'] });
      }

      if (allFinished) {
        completedBulkJobIdsRef.current.clear();
        setBulkTranscribeJobs([]);
        if (completedCount > 0) {
          setFeedback({
            kind: 'ok',
            text: `Generated AI subtitles for ${completedCount} video${
              completedCount === 1 ? '' : 's'
            }.`,
          });
        } else {
          const firstErr = statuses.find((s) => s.job.error_message_safe)?.job
            .error_message_safe;
          setFeedback({
            kind: 'err',
            text: firstErr || 'AI subtitle transcription failed.',
          });
        }
      }

      return {
        total: statuses.length,
        completedCount,
        failedCount,
      };
    },
    enabled: bulkTranscribeJobs.length > 0,
    refetchInterval: bulkTranscribeJobs.length > 0 ? 850 : false,
  });

  if (activeTab === 'trim' || activeTab === 'export' || !activeToolKey) {
    return null;
  }

  const totalCount = batch.items.length;
  const overriddenCount = batch.items.filter((i) =>
    isToolOverriddenOnSettings(i.settings, activeToolKey)
  ).length;
  const linkedCount = Math.max(0, totalCount - overriddenCount);

  const srcW = previewSourceAsset?.width || 1920;
  const srcH = previewSourceAsset?.height || 1080;

  const refSrcDurationMs = previewSourceAsset?.duration_ms || 10_000;
  const refTrimStartMs = Math.max(
    0,
    referenceItem?.settings.trim.start_ms || 0
  );
  const refTrimEndMs =
    referenceItem?.settings.trim.end_ms !== null &&
    referenceItem?.settings.trim.end_ms !== undefined &&
    referenceItem.settings.trim.end_ms > refTrimStartMs
      ? Math.min(refSrcDurationMs, referenceItem.settings.trim.end_ms)
      : refSrcDurationMs;
  const refTrimmedLengthMs = Math.max(200, refTrimEndMs - refTrimStartMs);

  const effectivePreviewSettings: EditSettings = {
    ...masterSettings,
    trim: referenceItem?.settings.trim ?? { start_ms: 0, end_ms: null },
    logo: {
      ...masterSettings.logo,
      enabled: masterSettings.logo.enabled && Boolean(singleLogoAsset),
    },
  };

  const effectiveOutDims = resolveTargetOutputDimensions(
    masterSettings.crop,
    srcW,
    srcH,
    masterSettings.output?.width,
    masterSettings.output?.height
  );

  const previewCues: SubtitleCue[] =
    effectiveRefCues.length > 0
      ? effectiveRefCues
      : activeTab === 'subtitles'
      ? SAMPLE_SUBTITLE_CUES
      : [];

  const isBulkTranscribing =
    runningBulkAction || bulkTranscribeJobs.length > 0;
  const bulkDoneCount = bulkTranscribePollQuery.data?.completedCount ?? 0;
  const bulkTotalCount =
    bulkTranscribePollQuery.data?.total || bulkTranscribeJobs.length;

  const updateMasterSubtitleStyle = (
    styleUpdater: (
      prevStyle: EditSettings['subtitles']['style']
    ) => EditSettings['subtitles']['style']
  ) => {
    onUpdateMaster((prev) => ({
      ...prev,
      subtitles: {
        ...prev.subtitles,
        enabled: true,
        style: styleUpdater(prev.subtitles.style),
      },
    }));
  };

  const mutateReferenceCues = (
    updater: (prev: SubtitleCue[]) => SubtitleCue[]
  ) => {
    if (!referenceItem?.project_id) return;
    const next = updater(effectiveRefCues).map((c, idx) => ({
      ...c,
      sequence: idx + 1,
    }));
    setLocalRefCuesOverride({
      projectId: referenceItem.project_id,
      cues: next,
    });
    setRefCuesDirty(true);
    if (!masterSettings.subtitles.enabled) {
      onUpdateMaster((prev) => ({
        ...prev,
        subtitles: { ...prev.subtitles, enabled: true },
      }));
    }
  };

  const handleAddReferenceCueAtPlayhead = () => {
    const startMs = Math.max(
      0,
      Math.min(refTrimmedLengthMs - 400, Math.round(currentTimeMs))
    );
    const endMs = Math.min(refTrimmedLengthMs, startMs + 2000);
    mutateReferenceCues((prev) => [
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

  const handleSelectAspectPreset = (presetId: AspectRatioPreset) => {
    if (presetId === 'original') {
      onUpdateMaster((prev) => ({
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

    const curZoom = masterSettings.crop?.zoom || 1;
    const box = computeAspectCropSize(presetId, srcW, srcH, curZoom);
    const centeredX = Math.max(0, Math.min(1 - box.width, (1 - box.width) / 2));
    const centeredY = Math.max(
      0,
      Math.min(1 - box.height, (1 - box.height) / 2)
    );

    onUpdateMaster((prev) => ({
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
    onUpdateMaster((prev) => {
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

  const handleBulkGenerateSubtitles = async () => {
    const linkedItems = batch.items.filter(
      (i) =>
        Boolean(i.source_asset_id) &&
        !isToolOverriddenOnSettings(i.settings, 'subtitles')
    );
    if (linkedItems.length === 0) return;

    setRunningBulkAction(true);
    setFeedback(null);
    completedBulkJobIdsRef.current.clear();
    try {
      const nextMaster: EditSettings = {
        ...masterSettings,
        subtitles: { ...masterSettings.subtitles, enabled: true },
      };
      onUpdateMaster(() => nextMaster);
      const synced = await videoApi.updateBatch(batch.id, {
        shared_settings: nextMaster,
      });
      onBatchUpdated(synced);

      const spawned: Array<{ projectId: string; jobId: string }> = [];
      for (const item of linkedItems) {
        try {
          const job = await videoApi.startTranscription(
            item.project_id,
            nextMaster.subtitles.language || 'auto',
            true
          );
          spawned.push({ projectId: item.project_id, jobId: job.id });
        } catch {
          // Skip clips without audio track cleanly
        }
      }

      const refreshed = await videoApi.getBatch(batch.id);
      onBatchUpdated(refreshed);

      if (spawned.length > 0) {
        setBulkTranscribeJobs(spawned);
        setSubtitleSubTab('cues');
      } else {
        setFeedback({
          kind: 'err',
          text: 'No audio tracks found to transcribe in linked videos.',
        });
      }
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Bulk AI subtitle generation failed.'),
      });
    } finally {
      setRunningBulkAction(false);
    }
  };

  const handleBulkAutoFaceFrame = async () => {
    const linkedItems = batch.items.filter(
      (i) =>
        Boolean(i.source_asset_id) &&
        !isToolOverriddenOnSettings(i.settings, 'crop')
    );
    if (linkedItems.length === 0) return;

    setRunningBulkAction(true);
    setFeedback(null);
    try {
      const ratio =
        masterSettings.crop?.aspect_ratio &&
        masterSettings.crop.aspect_ratio !== 'original'
          ? masterSettings.crop.aspect_ratio
          : '9:16';
      const nextMaster: EditSettings = {
        ...masterSettings,
        crop: {
          ...(masterSettings.crop || DEFAULT_CROP_SETTINGS),
          enabled: true,
          aspect_ratio: ratio,
          auto_face_framing: true,
        },
      };
      onUpdateMaster(() => nextMaster);
      await videoApi.updateBatch(batch.id, { shared_settings: nextMaster });

      let framedCount = 0;
      for (const item of linkedItems) {
        try {
          await videoApi.autoFrameProject(item.project_id, {
            aspectRatio: ratio,
            dynamicTracking: Boolean(nextMaster.crop.dynamic_tracking),
            targetZoom: nextMaster.crop.zoom || 1.0,
          });
          framedCount += 1;
        } catch {
          // Continue across remaining videos
        }
      }
      const refreshed = await videoApi.getBatch(batch.id);
      onBatchUpdated(refreshed);
      setFeedback({
        kind: 'ok',
        text: `Speaker face framing analyzed across ${framedCount} video(s).`,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: extractApiError(err, 'Bulk face framing failed.'),
      });
    } finally {
      setRunningBulkAction(false);
    }
  };

  const HeaderIcon = MASTER_TAB_META[activeTab].icon;

  const inspectorNode = (
    <div className="space-y-2.5">
      <div className="rounded-xl bg-background/80 border border-primary/25 p-3.5 space-y-3.5">
        <div className="flex items-center justify-between pb-2 border-b border-border/70">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <HeaderIcon className="h-3.5 w-3.5 text-primary" />
            {MASTER_TAB_META[activeTab].title}
          </span>
          <span className="text-[11px] font-mono text-muted-foreground">
            {effectiveOutDims.width}×{effectiveOutDims.height}
          </span>
        </div>

        {/* ==================== MASTER: RATIO & FACE ==================== */}
        {activeTab === 'crop' && (
          <div className="space-y-3.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium">Reframe All Linked Videos</span>
              <Switch
                checked={Boolean(masterSettings.crop?.enabled)}
                onCheckedChange={(checked) => {
                  if (!checked) {
                    handleSelectAspectPreset('original');
                  } else {
                    handleSelectAspectPreset(
                      masterSettings.crop?.aspect_ratio &&
                        masterSettings.crop.aspect_ratio !== 'original'
                        ? (masterSettings.crop.aspect_ratio as AspectRatioPreset)
                        : '9:16'
                    );
                  }
                }}
              />
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {ASPECT_RATIO_PRESETS.filter((p) => p.id !== 'custom').map((p) => {
                const active =
                  (masterSettings.crop?.enabled
                    ? masterSettings.crop.aspect_ratio
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
              })}
            </div>

            {masterSettings.crop?.enabled && (
              <div className="space-y-3 pt-1 border-t border-border/60">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="inline-flex rounded-lg bg-muted p-0.5 border border-border">
                    {(['crop', 'pad'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() =>
                          onUpdateMaster((prev) => ({
                            ...prev,
                            crop: {
                              ...(prev.crop || DEFAULT_CROP_SETTINGS),
                              fit_mode: mode,
                            },
                          }))
                        }
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
                          masterSettings.crop?.fit_mode === mode
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>

                  <span className="text-[11px] text-muted-foreground">
                    Zoom {(masterSettings.crop?.zoom || 1).toFixed(2)}×
                  </span>
                </div>

                <Slider
                  min={1.0}
                  max={2.5}
                  step={0.05}
                  value={[masterSettings.crop?.zoom || 1]}
                  onValueChange={(vals) => {
                    const z = vals[0] ?? 1;
                    onUpdateMaster((prev) => ({
                      ...prev,
                      crop: {
                        ...(prev.crop || DEFAULT_CROP_SETTINGS),
                        enabled: true,
                        zoom: z,
                      },
                    }));
                  }}
                />

                <div className="rounded-lg bg-muted/45 border border-border p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <ScanFace className="h-3.5 w-3.5 text-primary" />
                      AI Face Framing (Per Speaker)
                    </span>
                    <Switch
                      checked={Boolean(masterSettings.crop?.auto_face_framing)}
                      onCheckedChange={(checked) =>
                        onUpdateMaster((prev) => ({
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

                  {masterSettings.crop?.auto_face_framing && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
                        <Switch
                          checked={Boolean(masterSettings.crop?.dynamic_tracking)}
                          onCheckedChange={(checked) =>
                            onUpdateMaster((prev) => ({
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
                        label="Detect Faces Across All Linked Videos"
                        detail="Runs neural face framing per video so you can preview every row below"
                        side="top"
                      >
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          disabled={runningBulkAction || linkedCount === 0}
                          onClick={() => void handleBulkAutoFaceFrame()}
                        >
                          {runningBulkAction ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ScanFace className="h-3 w-3" />
                          )}
                          Detect All ({linkedCount})
                        </Button>
                      </HintTooltip>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ==================== MASTER: SUBTITLES ==================== */}
        {activeTab === 'subtitles' && (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium">Burn-in Subtitles (Master)</span>
              <Switch
                checked={masterSettings.subtitles.enabled}
                onCheckedChange={(checked) =>
                  onUpdateMaster((prev) => ({
                    ...prev,
                    subtitles: { ...prev.subtitles, enabled: checked },
                  }))
                }
              />
            </div>

            {/* Sub-tab Switcher (Style | Cues) + Bulk Whisper AI Action */}
            <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 border-b border-border/60">
              <div className="inline-flex rounded-lg bg-muted p-0.5 border border-border">
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
                <button
                  type="button"
                  onClick={() => setSubtitleSubTab('cues')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    subtitleSubTab === 'cues'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Cues ({effectiveRefCues.length})
                </button>
              </div>

              <div className="flex items-center gap-1">
                {effectiveRefCues.length > 0 &&
                  activeRefSubVersion > 0 &&
                  referenceItem && (
                    <HintTooltip
                      label="Export .SRT File"
                      detail="Download SubRip captions for the previewed clip"
                      side="top"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          void videoApi.downloadSubtitlesSrt(
                            referenceItem.project_id,
                            activeRefSubVersion
                          )
                        }
                      >
                        <Download className="h-3 w-3" />
                        SRT
                      </Button>
                    </HintTooltip>
                  )}

                <HintTooltip
                  label="Generate AI Captions for Linked Videos"
                  detail="Transcribes speech per clip with Whisper while inheriting Master Subtitle Style"
                  side="top"
                >
                  <Button
                    type="button"
                    size="xs"
                    disabled={isBulkTranscribing || linkedCount === 0}
                    onClick={() => void handleBulkGenerateSubtitles()}
                  >
                    {isBulkTranscribing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    {isBulkTranscribing && bulkTotalCount > 0
                      ? `Transcribing ${bulkDoneCount}/${bulkTotalCount}...`
                      : isBulkTranscribing
                      ? 'Starting AI...'
                      : `Generate AI All (${linkedCount})`}
                  </Button>
                </HintTooltip>
              </div>
            </div>

            {subtitleSubTab === 'cues' ? (
              /* Cues Inspector & Editor for Previewed Video */
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {batch.items.length > 1 && (
                      <select
                        value={referenceItem?.id ?? ''}
                        onChange={(e) => {
                          setPreviewItemId(e.target.value);
                          setCurrentTimeMs(0);
                        }}
                        aria-label="Select video clip for subtitle cues"
                        className="rounded-lg bg-card border border-border px-2 py-1 text-[11px] max-w-32 truncate"
                      >
                        {batch.items.map((it, idx) => (
                          <option key={it.id} value={it.id}>
                            #{idx + 1} {it.title}
                          </option>
                        ))}
                      </select>
                    )}

                    <select
                      value={masterSettings.subtitles.language}
                      onChange={(e) =>
                        onUpdateMaster((prev) => ({
                          ...prev,
                          subtitles: {
                            ...prev.subtitles,
                            language: e.target.value,
                          },
                        }))
                      }
                      aria-label="Master transcription language"
                      className="rounded-lg bg-card border border-border px-2 py-1 text-[11px]"
                    >
                      {supportedLanguages.map((lang) => (
                        <option key={lang.code} value={lang.code}>
                          {lang.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <HintTooltip
                    label="Add Cue at Playhead"
                    detail="Insert manual subtitle cue on the previewed clip"
                    side="top"
                  >
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      disabled={!referenceItem}
                      onClick={handleAddReferenceCueAtPlayhead}
                    >
                      <Plus className="h-3 w-3" />
                      Add Cue
                    </Button>
                  </HintTooltip>
                </div>

                {isBulkTranscribing && effectiveRefCues.length === 0 ? (
                  <div className="rounded-lg border border-primary/35 bg-primary/8 py-6 px-3 text-center space-y-1.5 text-[11px]">
                    <Loader2 className="h-4 w-4 animate-spin text-primary mx-auto" />
                    <div className="font-medium text-foreground">
                      Generating Whisper AI subtitles (
                      {bulkDoneCount}/{Math.max(1, bulkTotalCount)})...
                    </div>
                    <div className="text-muted-foreground">
                      Captions will appear on the preview automatically.
                    </div>
                  </div>
                ) : effectiveRefCues.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border py-6 px-3 text-center text-[11px] text-muted-foreground">
                    Click <strong>Generate AI All ({linkedCount})</strong> to
                    transcribe linked videos, or <strong>Add Cue</strong> to
                    type manual captions.
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                    {effectiveRefCues.map((cue, idx) => {
                      const isCurrent =
                        currentTimeMs >= cue.start_ms &&
                        currentTimeMs <= cue.end_ms;
                      return (
                        <div
                          key={`master-cue-${idx}`}
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
                                  onClick={() => setCurrentTimeMs(cue.start_ms)}
                                  className="text-[10px] font-mono font-semibold text-primary px-1"
                                >
                                  #{idx + 1}
                                </button>
                              </HintTooltip>
                              <NumberInput
                                size="sm"
                                min={0}
                                max={Number(
                                  Math.max(
                                    0,
                                    (cue.end_ms - 100) / 1000
                                  ).toFixed(2)
                                )}
                                step={0.1}
                                value={Number((cue.start_ms / 1000).toFixed(2))}
                                ariaLabel={`Master cue ${idx + 1} start seconds`}
                                className="w-20"
                                onValueChange={(val) => {
                                  const ms = Math.max(
                                    0,
                                    Math.round((val ?? 0) * 1000)
                                  );
                                  mutateReferenceCues((prev) =>
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
                              <span className="text-muted-foreground">→</span>
                              <NumberInput
                                size="sm"
                                min={Number(
                                  ((cue.start_ms + 100) / 1000).toFixed(2)
                                )}
                                step={0.1}
                                value={Number((cue.end_ms / 1000).toFixed(2))}
                                ariaLabel={`Master cue ${idx + 1} end seconds`}
                                className="w-20"
                                onValueChange={(val) => {
                                  const ms = Math.max(
                                    cue.start_ms + 100,
                                    Math.round((val ?? 0.1) * 1000)
                                  );
                                  mutateReferenceCues((prev) =>
                                    prev.map((c, i) =>
                                      i === idx ? { ...c, end_ms: ms } : c
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
                                mutateReferenceCues((prev) =>
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
                              mutateReferenceCues((prev) =>
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
              /* Master Typography & Position (Inherited Across Linked Videos) */
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Transcription Language
                  </span>
                  <select
                    value={masterSettings.subtitles.language}
                    onChange={(e) =>
                      onUpdateMaster((prev) => ({
                        ...prev,
                        subtitles: {
                          ...prev.subtitles,
                          language: e.target.value,
                        },
                      }))
                    }
                    aria-label="Master transcription language"
                    className="rounded-lg bg-card border border-border px-2 py-1 text-[11px]"
                  >
                    {supportedLanguages.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] text-muted-foreground">
                      Font
                    </label>
                    <select
                      value={masterSettings.subtitles.style.font_family}
                      onChange={(e) =>
                        updateMasterSubtitleStyle((st) => ({
                          ...st,
                          font_family: e.target.value,
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
                          { id: 'center', icon: AlignCenter, label: 'Center' },
                          { id: 'right', icon: AlignRight, label: 'Right' },
                        ] as const
                      ).map((al) => {
                        const Icon = al.icon;
                        const active =
                          (masterSettings.subtitles.style.alignment ||
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
                                updateMasterSubtitleStyle((st) => ({
                                  ...st,
                                  alignment: al.id,
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
                      {masterSettings.subtitles.style.font_size}px
                    </span>
                  </div>
                  <Slider
                    min={18}
                    max={84}
                    step={1}
                    value={[masterSettings.subtitles.style.font_size]}
                    onValueChange={(vals) => {
                      if (vals[0] !== undefined) {
                        updateMasterSubtitleStyle((st) => ({
                          ...st,
                          font_size: vals[0],
                        }));
                      }
                    }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center justify-between rounded-lg bg-card border border-border px-2.5 py-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Text
                    </span>
                    <input
                      type="color"
                      value={masterSettings.subtitles.style.text_color}
                      onChange={(e) =>
                        updateMasterSubtitleStyle((st) => ({
                          ...st,
                          text_color: e.target.value,
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
                      checked={masterSettings.subtitles.style.shadow_enabled}
                      onCheckedChange={(checked) =>
                        updateMasterSubtitleStyle((st) => ({
                          ...st,
                          shadow_enabled: checked,
                        }))
                      }
                    />
                  </div>
                </div>

                {masterSettings.subtitles.style.shadow_enabled && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground">
                        Shadow Depth
                      </span>
                      <span className="font-mono tabular-nums">
                        {masterSettings.subtitles.style.shadow_depth || 2}px
                      </span>
                    </div>
                    <Slider
                      min={1}
                      max={8}
                      step={1}
                      value={[masterSettings.subtitles.style.shadow_depth || 2]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          updateMasterSubtitleStyle((st) => ({
                            ...st,
                            shadow_depth: vals[0],
                          }));
                        }
                      }}
                    />
                  </div>
                )}

                <div className="rounded-lg bg-card border border-border p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium">
                      Outline Stroke
                    </span>
                    <div className="flex items-center gap-2">
                      {masterSettings.subtitles.style.outline_enabled && (
                        <input
                          type="color"
                          value={masterSettings.subtitles.style.outline_color}
                          onChange={(e) =>
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              outline_color: e.target.value,
                            }))
                          }
                          className="h-5 w-6 rounded border border-border bg-transparent cursor-pointer"
                        />
                      )}
                      <Switch
                        checked={masterSettings.subtitles.style.outline_enabled}
                        onCheckedChange={(checked) =>
                          updateMasterSubtitleStyle((st) => ({
                            ...st,
                            outline_enabled: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  {masterSettings.subtitles.style.outline_enabled && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Thickness</span>
                        <span className="font-mono">
                          {masterSettings.subtitles.style.outline_thickness}px
                        </span>
                      </div>
                      <Slider
                        min={1}
                        max={8}
                        step={1}
                        value={[
                          masterSettings.subtitles.style.outline_thickness || 3,
                        ]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              outline_thickness: vals[0],
                            }));
                          }
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="rounded-lg bg-card border border-border p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium">
                      Background Box
                    </span>
                    <div className="flex items-center gap-2">
                      {masterSettings.subtitles.style.background_enabled && (
                        <input
                          type="color"
                          value={
                            masterSettings.subtitles.style.background_color
                          }
                          onChange={(e) =>
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              background_color: e.target.value,
                            }))
                          }
                          className="h-5 w-6 rounded border border-border bg-transparent cursor-pointer"
                        />
                      )}
                      <Switch
                        checked={
                          masterSettings.subtitles.style.background_enabled
                        }
                        onCheckedChange={(checked) =>
                          updateMasterSubtitleStyle((st) => ({
                            ...st,
                            background_enabled: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  {masterSettings.subtitles.style.background_enabled && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Opacity</span>
                        <span className="font-mono">
                          {Math.round(
                            (masterSettings.subtitles.style
                              .background_opacity ?? 0.65) * 100
                          )}
                          %
                        </span>
                      </div>
                      <Slider
                        min={0.1}
                        max={1.0}
                        step={0.05}
                        value={[
                          masterSettings.subtitles.style.background_opacity ??
                            0.65,
                        ]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              background_opacity: vals[0],
                            }));
                          }
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 items-start pt-1">
                  <PositionGridPicker
                    label="Anchor"
                    value={masterSettings.subtitles.style.position}
                    customCoordinatesActive={
                      masterSettings.subtitles.style.x_ratio !== null
                    }
                    onChange={(pos: AnchorPosition) =>
                      updateMasterSubtitleStyle((st) => ({
                        ...st,
                        position: pos,
                        x_ratio: null,
                        y_ratio: null,
                      }))
                    }
                  />

                  <div className="space-y-2.5">
                    {masterSettings.subtitles.style.x_ratio !== null && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="w-full"
                        onClick={() =>
                          updateMasterSubtitleStyle((st) => ({
                            ...st,
                            x_ratio: null,
                            y_ratio: null,
                          }))
                        }
                      >
                        <RotateCcw className="h-3 w-3" />
                        Snap to Anchor
                      </Button>
                    )}

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Margin V</span>
                        <span className="font-mono">
                          {Math.round(
                            (masterSettings.subtitles.style.margin_v_ratio ??
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
                          masterSettings.subtitles.style.margin_v_ratio ?? 0.06,
                        ]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              margin_v_ratio: vals[0],
                            }));
                          }
                        }}
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Margin H</span>
                        <span className="font-mono">
                          {Math.round(
                            (masterSettings.subtitles.style.margin_h_ratio ??
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
                          masterSettings.subtitles.style.margin_h_ratio ?? 0.05,
                        ]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              margin_h_ratio: vals[0],
                            }));
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>

                {masterSettings.subtitles.style.x_ratio !== null && (
                  <div className="grid grid-cols-2 gap-2.5 pt-1">
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">X</span>
                        <span className="font-mono tabular-nums">
                          {Math.round(
                            (masterSettings.subtitles.style.x_ratio ?? 0.5) *
                              100
                          )}
                          %
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={1}
                        step={0.01}
                        value={[
                          masterSettings.subtitles.style.x_ratio ?? 0.5,
                        ]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              x_ratio: vals[0],
                              y_ratio: st.y_ratio ?? 0.85,
                            }));
                          }
                        }}
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Y</span>
                        <span className="font-mono tabular-nums">
                          {Math.round(
                            (masterSettings.subtitles.style.y_ratio ?? 0.85) *
                              100
                          )}
                          %
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={1}
                        step={0.01}
                        value={[
                          masterSettings.subtitles.style.y_ratio ?? 0.85,
                        ]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            updateMasterSubtitleStyle((st) => ({
                              ...st,
                              x_ratio: st.x_ratio ?? 0.5,
                              y_ratio: vals[0],
                            }));
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================== MASTER: COLOR ==================== */}
        {activeTab === 'color' && (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">Color Grading (Master)</span>
              <div className="flex items-center gap-1.5">
                {masterSettings.color_correction?.enabled && (
                  <>
                    <HintTooltip label="A/B Bypass Grade" side="top">
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
                    <HintTooltip label="Reset Master Color" side="top">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() =>
                          onUpdateMaster((prev) => ({
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
                  checked={Boolean(masterSettings.color_correction?.enabled)}
                  onCheckedChange={(checked) =>
                    onUpdateMaster((prev) => ({
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

            <div className="grid grid-cols-3 gap-1.5">
              {COLOR_PRESETS.map((p) => {
                const active =
                  (masterSettings.color_correction?.enabled
                    ? masterSettings.color_correction.preset
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
                        onUpdateMaster((prev) => ({
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

            {masterSettings.color_correction?.enabled && (
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
                      fmt: (v: number) => v.toFixed(2),
                    },
                  ] as const
                ).map((s) => {
                  const val = Number(
                    masterSettings.color_correction[s.key] ?? 0
                  );
                  return (
                    <div key={s.key} className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{s.label}</span>
                        <span className="font-mono tabular-nums">
                          {s.fmt(val)}
                        </span>
                      </div>
                      <Slider
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        value={[val]}
                        onValueChange={(vals) => {
                          if (vals[0] !== undefined) {
                            onUpdateMaster((prev) => ({
                              ...prev,
                              color_correction: {
                                ...prev.color_correction,
                                enabled: true,
                                preset: 'custom',
                                [s.key]: vals[0],
                              },
                            }));
                          }
                        }}
                      />
                    </div>
                  );
                })}

                <label className="flex items-center justify-between pt-1 cursor-pointer">
                  <span className="text-[11px] text-muted-foreground">
                    Apply color grade to Outro
                  </span>
                  <Switch
                    checked={Boolean(
                      masterSettings.color_correction.apply_to_outro
                    )}
                    onCheckedChange={(checked) =>
                      onUpdateMaster((prev) => ({
                        ...prev,
                        color_correction: {
                          ...prev.color_correction,
                          apply_to_outro: checked,
                        },
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {/* ==================== MASTER: AUDIO ==================== */}
        {activeTab === 'audio' && (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">Clean Audio (Master Default)</span>
              <div className="flex items-center gap-1.5">
                {masterSettings.audio_enhancement?.enabled && (
                  <>
                    <HintTooltip
                      label="Hold to Compare Raw Audio"
                      detail="Press and hold while playing to hear unfiltered audio"
                      side="top"
                    >
                      <Button
                        type="button"
                        variant={comparingRawAudio ? 'default' : 'outline'}
                        size="xs"
                        onPointerDown={() => setComparingRawAudio(true)}
                        onPointerUp={() => setComparingRawAudio(false)}
                        onPointerLeave={() => setComparingRawAudio(false)}
                      >
                        <Ear className="h-3 w-3" />
                        Hold Raw
                      </Button>
                    </HintTooltip>
                    <HintTooltip
                      label="Reset to Clean Voice Default"
                      side="top"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() =>
                          onUpdateMaster((prev) => ({
                            ...prev,
                            audio_enhancement: { ...DEFAULT_CLEAN_AUDIO_PRESET },
                          }))
                        }
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    </HintTooltip>
                  </>
                )}
                <Switch
                  checked={Boolean(masterSettings.audio_enhancement?.enabled)}
                  onCheckedChange={(checked) =>
                    onUpdateMaster((prev) => {
                      const cur = prev.audio_enhancement;
                      const needsDefault =
                        checked &&
                        cur.noise_reduction === 0 &&
                        cur.voice_clarity === 0;
                      return {
                        ...prev,
                        audio_enhancement: {
                          ...cur,
                          enabled: checked,
                          ...(needsDefault
                            ? {
                                preset: 'clean_voice',
                                ...BATCH_AUDIO_PRESETS[0].values,
                              }
                            : {}),
                        },
                      };
                    })
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {BATCH_AUDIO_PRESETS.map((p) => {
                const presetVal = masterSettings.audio_enhancement?.preset;
                const active =
                  Boolean(masterSettings.audio_enhancement?.enabled) &&
                  (presetVal === p.id ||
                    (p.id === 'clean_voice' &&
                      (!presetVal || presetVal === 'none')));
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
                        onUpdateMaster((prev) => ({
                          ...prev,
                          audio_enhancement: {
                            ...prev.audio_enhancement,
                            enabled: true,
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

            {masterSettings.audio_enhancement?.enabled && (
              <div className="space-y-2.5 pt-1 border-t border-border/60">
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Noise Reduction
                    </span>
                    <span className="font-mono">
                      {Math.round(
                        (masterSettings.audio_enhancement.noise_reduction ||
                          0) * 100
                      )}
                      %
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.02}
                    value={[
                      masterSettings.audio_enhancement.noise_reduction || 0,
                    ]}
                    onValueChange={(vals) => {
                      if (vals[0] !== undefined) {
                        onUpdateMaster((prev) => ({
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
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Voice Clarity</span>
                    <span className="font-mono">
                      {Math.round(
                        (masterSettings.audio_enhancement.voice_clarity || 0) *
                          100
                      )}
                      %
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.02}
                    value={[
                      masterSettings.audio_enhancement.voice_clarity || 0,
                    ]}
                    onValueChange={(vals) => {
                      if (vals[0] !== undefined) {
                        onUpdateMaster((prev) => ({
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

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground">Low-Cut</span>
                      <span className="font-mono">
                        {masterSettings.audio_enhancement.highpass_hz || 95}Hz
                      </span>
                    </div>
                    <Slider
                      min={20}
                      max={300}
                      step={5}
                      value={[
                        masterSettings.audio_enhancement.highpass_hz || 95,
                      ]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          onUpdateMaster((prev) => ({
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
                      <span className="text-muted-foreground">High-Cut</span>
                      <span className="font-mono">
                        {(
                          (masterSettings.audio_enhancement.lowpass_hz ||
                            14000) / 1000
                        ).toFixed(1)}
                        kHz
                      </span>
                    </div>
                    <Slider
                      min={4000}
                      max={20000}
                      step={250}
                      value={[
                        masterSettings.audio_enhancement.lowpass_hz || 14000,
                      ]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          onUpdateMaster((prev) => ({
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

                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Output Gain</span>
                    <span className="font-mono">
                      {(masterSettings.audio_enhancement.volume_db || 0) >= 0
                        ? '+'
                        : ''}
                      {(
                        masterSettings.audio_enhancement.volume_db || 0
                      ).toFixed(1)}{' '}
                      dB
                    </span>
                  </div>
                  <Slider
                    min={-12}
                    max={12}
                    step={0.5}
                    value={[masterSettings.audio_enhancement.volume_db || 0]}
                    onValueChange={(vals) => {
                      if (vals[0] !== undefined) {
                        onUpdateMaster((prev) => ({
                          ...prev,
                          audio_enhancement: {
                            ...prev.audio_enhancement,
                            preset: 'custom',
                            volume_db: vals[0],
                          },
                        }));
                      }
                    }}
                  />
                </div>

                <div className="space-y-2 pt-1">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-[11px] text-muted-foreground">
                      Speech Leveler
                    </span>
                    <Switch
                      checked={Boolean(
                        masterSettings.audio_enhancement.normalize_loudness
                      )}
                      onCheckedChange={(checked) =>
                        onUpdateMaster((prev) => ({
                          ...prev,
                          audio_enhancement: {
                            ...prev.audio_enhancement,
                            normalize_loudness: checked,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-[11px] text-muted-foreground">
                      Denoise before AI Subtitles
                    </span>
                    <Switch
                      checked={Boolean(
                        masterSettings.audio_enhancement.apply_to_transcription
                      )}
                      onCheckedChange={(checked) =>
                        onUpdateMaster((prev) => ({
                          ...prev,
                          audio_enhancement: {
                            ...prev.audio_enhancement,
                            apply_to_transcription: checked,
                          },
                        }))
                      }
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ==================== MASTER: LOGO ==================== */}
        {activeTab === 'logo' && (
          <div className="space-y-3.5 text-xs">
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                onUploadGlobalSlot('logo', e.target.files);
                e.target.value = '';
              }}
            />
            <div className="rounded-lg bg-card border border-border p-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                {singleLogoAsset?.stream_url ? (
                  <img
                    src={singleLogoAsset.stream_url}
                    alt="Brand logo"
                    className="h-8 w-8 rounded object-contain bg-muted p-1 border border-border shrink-0"
                  />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted border border-border flex items-center justify-center shrink-0">
                    <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <span className="font-medium truncate">
                  {singleLogoAsset
                    ? singleLogoAsset.original_filename
                    : 'No brand logo uploaded'}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  disabled={uploadingSingleSlot === 'logo'}
                  onClick={() =>
                    isDesktop
                      ? onDesktopPickGlobalSlot('logo')
                      : logoInputRef.current?.click()
                  }
                >
                  {uploadingSingleSlot === 'logo' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <UploadCloud className="h-3 w-3" />
                  )}
                  {singleLogoAsset ? 'Replace' : 'Upload'}
                </Button>
                {singleLogoAsset && (
                  <HintTooltip label="Remove Brand Logo" side="top">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onRemoveGlobalSlot('logo')}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </HintTooltip>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="font-medium">Overlay Brand Logo</span>
              <div className="flex items-center gap-1.5">
                <HintTooltip
                  label="Reset Default Logo Placement"
                  detail="X 89% · Y 68% · Width 26% · Opacity 100% · Margin 3%"
                  side="top"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      onUpdateMaster((prev) => ({
                        ...prev,
                        logo: {
                          ...prev.logo,
                          ...DEFAULT_LOGO_PRESET,
                        },
                      }))
                    }
                  >
                    <RotateCcw className="h-3 w-3" />
                    Default
                  </Button>
                </HintTooltip>
                <Switch
                  checked={masterSettings.logo.enabled}
                  onCheckedChange={(checked) =>
                    onUpdateMaster((prev) => ({
                      ...prev,
                      logo: { ...prev.logo, enabled: checked },
                    }))
                  }
                />
              </div>
            </div>

            {masterSettings.logo.enabled && (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <PositionGridPicker
                    label="Anchor"
                    value={masterSettings.logo.position}
                    customCoordinatesActive={
                      masterSettings.logo.x_ratio !== null &&
                      masterSettings.logo.y_ratio !== null
                    }
                    onChange={(pos: AnchorPosition) =>
                      onUpdateMaster((prev) => ({
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

                  <div className="flex-1 space-y-2">
                    <span className="text-[11px] text-muted-foreground block">
                      Quick Scale
                    </span>
                    <div className="grid grid-cols-3 gap-1">
                      {[
                        { label: 'S 8%', w: 0.08 },
                        { label: 'M 14%', w: 0.14 },
                        { label: 'L 22%', w: 0.22 },
                      ].map((Preset) => (
                        <button
                          key={Preset.label}
                          type="button"
                          onClick={() =>
                            onUpdateMaster((prev) => ({
                              ...prev,
                              logo: {
                                ...prev.logo,
                                width_ratio: Preset.w,
                              },
                            }))
                          }
                          className={`py-1 rounded-md border text-[10px] font-mono transition-colors ${
                            Math.abs(
                              (masterSettings.logo.width_ratio || 0.26) -
                                Preset.w
                            ) < 0.005
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-card border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {Preset.label}
                        </button>
                      ))}
                    </div>

                    {masterSettings.logo.x_ratio !== null &&
                      masterSettings.logo.y_ratio !== null && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            onUpdateMaster((prev) => ({
                              ...prev,
                              logo: {
                                ...prev.logo,
                                x_ratio: null,
                                y_ratio: null,
                              },
                            }))
                          }
                          className="w-full"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Snap to Anchor
                        </Button>
                      )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5 pt-1 border-t border-border/60">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground">X</span>
                      <span className="font-mono">
                        {masterSettings.logo.x_ratio !== null
                          ? `${Math.round(masterSettings.logo.x_ratio * 100)}%`
                          : 'grid'}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={[masterSettings.logo.x_ratio ?? 0.89]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          onUpdateMaster((prev) => ({
                            ...prev,
                            logo: {
                              ...prev.logo,
                              x_ratio: vals[0],
                              y_ratio: prev.logo.y_ratio ?? 0.68,
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
                        {masterSettings.logo.y_ratio !== null
                          ? `${Math.round(masterSettings.logo.y_ratio * 100)}%`
                          : 'grid'}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={[masterSettings.logo.y_ratio ?? 0.68]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          onUpdateMaster((prev) => ({
                            ...prev,
                            logo: {
                              ...prev.logo,
                              x_ratio: prev.logo.x_ratio ?? 0.89,
                              y_ratio: vals[0],
                            },
                          }));
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Width</span>
                    <span className="font-mono">
                      {Math.round(
                        (masterSettings.logo.width_ratio || 0.26) * 100
                      )}
                      %
                    </span>
                  </div>
                  <Slider
                    min={0.04}
                    max={0.45}
                    step={0.01}
                    value={[masterSettings.logo.width_ratio || 0.26]}
                    onValueChange={(vals) => {
                      if (vals[0] !== undefined) {
                        onUpdateMaster((prev) => ({
                          ...prev,
                          logo: {
                            ...prev.logo,
                            width_ratio: vals[0],
                          },
                        }));
                      }
                    }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Opacity</span>
                      <span className="font-mono">
                        {Math.round((masterSettings.logo.opacity ?? 1) * 100)}%
                      </span>
                    </div>
                    <Slider
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={[masterSettings.logo.opacity ?? 1]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          onUpdateMaster((prev) => ({
                            ...prev,
                            logo: {
                              ...prev.logo,
                              opacity: vals[0],
                            },
                          }));
                        }
                      }}
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Margin</span>
                      <span className="font-mono">
                        {Math.round(
                          (masterSettings.logo.margin_ratio ?? 0.03) * 100
                        )}
                        %
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={0.15}
                      step={0.005}
                      value={[masterSettings.logo.margin_ratio ?? 0.03]}
                      onValueChange={(vals) => {
                        if (vals[0] !== undefined) {
                          onUpdateMaster((prev) => ({
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

                <label className="flex items-center justify-between pt-1 cursor-pointer">
                  <span className="text-[11px] text-muted-foreground">
                    Show logo during Outro
                  </span>
                  <Switch
                    checked={masterSettings.logo.apply_to_outro}
                    onCheckedChange={(checked) =>
                      onUpdateMaster((prev) => ({
                        ...prev,
                        logo: {
                          ...prev.logo,
                          apply_to_outro: checked,
                        },
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {/* ==================== MASTER: OUTRO ==================== */}
        {activeTab === 'outro' && (
          <div className="space-y-3.5 text-xs">
            <input
              ref={outroInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska"
              className="hidden"
              onChange={(e) => {
                onUploadGlobalSlot('outro', e.target.files);
                e.target.value = '';
              }}
            />
            <div className="rounded-lg bg-card border border-border p-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Film className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium truncate">
                  {singleOutroAsset
                    ? singleOutroAsset.original_filename
                    : 'No outro video uploaded'}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  disabled={uploadingSingleSlot === 'outro'}
                  onClick={() =>
                    isDesktop
                      ? onDesktopPickGlobalSlot('outro')
                      : outroInputRef.current?.click()
                  }
                >
                  {uploadingSingleSlot === 'outro' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <UploadCloud className="h-3 w-3" />
                  )}
                  {singleOutroAsset ? 'Replace' : 'Upload'}
                </Button>
                {singleOutroAsset && (
                  <HintTooltip label="Remove Outro Video" side="top">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onRemoveGlobalSlot('outro')}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </HintTooltip>
                )}
              </div>
            </div>

            {singleOutroAsset && (
              <>
                {singleOutroAsset.stream_url && (
                  <div className="rounded-lg overflow-hidden border border-border bg-black">
                    <video
                      src={singleOutroAsset.stream_url}
                      controls
                      preload="metadata"
                      disablePictureInPicture
                      controlsList="nodownload noremoteplayback"
                      className="w-full max-h-32 object-contain"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    Append Outro to Linked Videos
                  </span>
                  <Switch
                    checked={masterSettings.outro.enabled}
                    onCheckedChange={(checked) =>
                      onUpdateMaster((prev) => ({
                        ...prev,
                        outro: { ...prev.outro, enabled: checked },
                      }))
                    }
                  />
                </div>

                {masterSettings.outro.enabled && (
                  <div className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground block">
                      Aspect Match Mode
                    </span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          {
                            id: 'pad',
                            label: 'Pad',
                            hint: 'Letterbox to fit cleanly',
                          },
                          {
                            id: 'crop',
                            label: 'Crop',
                            hint: 'Center-fill output frame',
                          },
                          {
                            id: 'stretch',
                            label: 'Stretch',
                            hint: 'Stretch exact dimensions',
                          },
                        ] as const
                      ).map((m) => (
                        <HintTooltip
                          key={m.id}
                          label={m.label}
                          detail={m.hint}
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateMaster((prev) => ({
                                ...prev,
                                outro: {
                                  ...prev.outro,
                                  normalization_mode: m.id,
                                },
                              }))
                            }
                            className={`py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                              masterSettings.outro.normalization_mode === m.id
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-card border-border text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {m.label}
                          </button>
                        </HintTooltip>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {feedback && (
        <div
          className={`rounded-lg px-3 py-1.5 text-[11px] flex items-center gap-1.5 border ${
            feedback.kind === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-destructive/10 border-destructive/30 text-destructive'
          }`}
        >
          {feedback.kind === 'ok' ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{feedback.text}</span>
        </div>
      )}
    </div>
  );

  return (
    <section className="rounded-2xl border border-primary/35 bg-card/95 ring-1 ring-primary/15 overflow-hidden shadow-xs">
      {/* Master Control Header */}
      <div className="px-4 py-2.5 bg-primary/8 border-b border-primary/20 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
          <Badge variant="default" className="gap-1">
            <Layers className="h-3 w-3" />
            Master Control
          </Badge>

          <span className="text-xs font-semibold text-foreground">
            {MASTER_TAB_META[activeTab].title.replace('Master Control · ', '')}
          </span>

          <Badge variant="secondary" className="text-[11px]">
            Inheriting to {linkedCount} of {totalCount} video
            {totalCount === 1 ? '' : 's'}
          </Badge>

          {overriddenCount > 0 && (
            <Badge
              variant="outline"
              className="text-[11px] border-amber-500/35 text-amber-300 bg-amber-500/10"
            >
              {overriddenCount} Separate Edit{overriddenCount === 1 ? '' : 's'}
            </Badge>
          )}

          {saveState === 'saving' && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          {saveState === 'saved' && (
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              Inherited
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {batch.items.length > 1 && !isCollapsed && (
            <div className="inline-flex items-center gap-1 rounded-lg bg-background border border-border px-2 py-0.5">
              <span className="text-[10px] text-muted-foreground">Preview:</span>
              <select
                value={referenceItem?.id ?? ''}
                onChange={(e) => {
                  setPreviewItemId(e.target.value);
                  setCurrentTimeMs(0);
                }}
                aria-label="Choose reference video for Master Control preview"
                className="bg-transparent py-0.5 text-[11px] text-foreground focus:outline-none max-w-36 truncate"
              >
                {batch.items.map((it, idx) => (
                  <option key={it.id} value={it.id}>
                    #{idx + 1} {it.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {overriddenCount > 0 && (
            <HintTooltip
              label="Sync All Videos Back to Master"
              detail={`Clears separate ${activeTab} edits on ${overriddenCount} video(s) so all ${totalCount} inherit Master Control`}
              side="top"
            >
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={resettingOverrides}
                onClick={async () => {
                  setResettingOverrides(true);
                  try {
                    await onResetAllRowsToMasterForTool();
                  } finally {
                    setResettingOverrides(false);
                  }
                }}
              >
                {resettingOverrides ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Sync All ({totalCount}) to Master
              </Button>
            </HintTooltip>
          )}

          <HintTooltip
            label={
              isCollapsed ? 'Expand Master Control' : 'Collapse Master Control'
            }
            side="top"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setIsCollapsed((v) => !v)}
              aria-label={
                isCollapsed
                  ? 'Expand Master Control'
                  : 'Collapse Master Control'
              }
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

      {!isCollapsed && (
        <div
          className={`p-4 grid grid-cols-1 ${
            widePreview ? '' : 'lg:grid-cols-12'
          } gap-4 items-start`}
        >
          <div className={widePreview ? 'w-full' : 'lg:col-span-7'}>
            <InteractiveVideoPreview
              sourceAsset={previewSourceAsset}
              logoAsset={singleLogoAsset}
              settings={effectivePreviewSettings}
              cues={previewCues}
              currentTimeMs={currentTimeMs}
              onTimeUpdate={setCurrentTimeMs}
              bypassColorCorrection={bypassColor}
              bypassAudioEnhancement={comparingRawAudio}
              wideMode={widePreview}
              onToggleWideMode={() => setWidePreview((v) => !v)}
              fullscreenInspector={inspectorNode}
              enableFullscreenToolTabs
              onFullscreenChange={setIsPreviewFullscreen}
              cropEditorMode={
                activeTab === 'crop' &&
                cropBoxEditMode &&
                Boolean(masterSettings.crop?.enabled)
              }
              onUpdateCropBox={handleUpdateCropBox}
              dragMode={
                activeTab === 'subtitles'
                  ? 'subtitles'
                  : activeTab === 'logo' &&
                    masterSettings.logo.enabled &&
                    Boolean(singleLogoAsset)
                  ? 'logo'
                  : 'none'
              }
              onDragLogo={(xr, yr) =>
                onUpdateMaster((prev) => ({
                  ...prev,
                  logo: {
                    ...prev.logo,
                    enabled: true,
                    x_ratio: xr,
                    y_ratio: yr,
                  },
                }))
              }
              onDragSubtitle={(xr, yr) =>
                onUpdateMaster((prev) => ({
                  ...prev,
                  subtitles: {
                    ...prev.subtitles,
                    enabled: true,
                    style: {
                      ...prev.subtitles.style,
                      x_ratio: xr,
                      y_ratio: yr,
                    },
                  },
                }))
              }
            />
          </div>

          {!isPreviewFullscreen && (
            <div className={widePreview ? 'w-full' : 'lg:col-span-5'}>
              {inspectorNode}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
