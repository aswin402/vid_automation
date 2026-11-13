import React, { useState } from 'react';
import {
  Play,
  Download,
  FolderOutput,
  Loader2,
  Clock,
  AlertCircle,
  RefreshCw,
  XCircle,
  SlidersHorizontal,
  Settings2,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronUp,
  Film,
  Sparkles,
} from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { HintTooltip } from '@/components/ui/tooltip';
import { STAGE_LABELS } from '@/lib/batchSettingsMerge';
import { resolveTargetOutputDimensions } from '@/lib/cropMath';
import { formatFriendlyDuration } from '@/lib/timecode';
import type { Asset, BatchDetail, EditSettings } from '@/types/video';

interface BatchOutputColumnProps {
  batch: BatchDetail;
  masterSettings: EditSettings;
  runningBatch: boolean;
  exportingFolder: boolean;
  isDesktop: boolean;
  onUpdateMaster: (updater: (prev: EditSettings) => EditSettings) => void;
  onBatchUpdated: (updated: BatchDetail) => void;
  onExportAllQueue: () => Promise<void>;
  onExportSelectedQueue: (itemIds: string[]) => Promise<void>;
  onEditVideosSubset: (itemIds: string[]) => Promise<void>;
  onPickOutputFolder: () => Promise<void>;
  onClearOutputFolder: () => Promise<void>;
  onDownloadOrSaveReady: () => Promise<void>;
}

export const BatchOutputColumn: React.FC<BatchOutputColumnProps> = ({
  batch,
  masterSettings,
  runningBatch,
  exportingFolder,
  isDesktop,
  onUpdateMaster,
  onBatchUpdated,
  onExportAllQueue,
  onExportSelectedQueue,
  onEditVideosSubset,
  onPickOutputFolder,
  onClearOutputFolder,
  onDownloadOrSaveReady,
}) => {
  const [showQualityPanel, setShowQualityPanel] = useState(false);
  const [exportingSingleId, setExportingSingleId] = useState<string | null>(
    null
  );

  const items = batch.items;
  const selectedItems = items.filter((i) => i.selected);
  const completedItems = items.filter(
    (i) => i.status === 'completed' && i.output_asset !== null
  );
  const processingItems = items.filter((i) => i.status === 'processing');
  const queuedItems = items.filter((i) => i.status === 'queued');
  const queueBusy =
    runningBatch || processingItems.length > 0 || queuedItems.length > 0;

  const isSubsetSelected =
    selectedItems.length > 0 && selectedItems.length < items.length;

  const handleToggleSelectAll = async (selectAll: boolean) => {
    const updated = await videoApi.setBatchItems(
      batch.id,
      items.map((i) => ({
        id: i.id,
        selected: selectAll,
        title: i.title,
        source_asset_id: i.source_asset_id,
        logo_asset_id: i.logo_asset_id,
        outro_asset_id: i.outro_asset_id,
        use_custom_settings: i.use_custom_settings,
      }))
    );
    onBatchUpdated(updated);
  };

  const applyMasterResolutionTier = (longEdge: number | null) => {
    if (longEdge === null) {
      onUpdateMaster((prev) => ({
        ...prev,
        output: { ...prev.output, width: null, height: null },
      }));
      return;
    }
    const sampleVideo = batch.videos[0];
    const autoDims = resolveTargetOutputDimensions(
      masterSettings.crop,
      sampleVideo?.width || 1920,
      sampleVideo?.height || 1080,
      null,
      null
    );
    const aspect = autoDims.width / Math.max(1, autoDims.height);
    const isPortrait = aspect < 1;
    const outW = isPortrait
      ? Math.max(2, Math.round((longEdge * aspect) / 2) * 2)
      : Math.max(2, Math.round(longEdge / 2) * 2);
    const outH = isPortrait
      ? Math.max(2, Math.round(longEdge / 2) * 2)
      : Math.max(2, Math.round((longEdge / aspect) / 2) * 2);

    onUpdateMaster((prev) => ({
      ...prev,
      output: { ...prev.output, width: outW, height: outH },
    }));
  };

  const currentResLabel = masterSettings.output?.height
    ? `${masterSettings.output.width}×${masterSettings.output.height}`
    : 'Auto Frame';

  return (
    <div className="space-y-5">
      {/* Top Output Command Card */}
      <section className="rounded-2xl border border-border bg-card p-4 space-y-3.5 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-foreground">
                Sequential Output Queue
              </h2>
              {queueBusy ? (
                <Badge variant="default" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Rendering 1-by-1 ({processingItems.length + queuedItems.length}{' '}
                  in queue)
                </Badge>
              ) : (
                <Badge variant="secondary">
                  {completedItems.length}/{items.length} Ready
                </Badge>
              )}
              {isSubsetSelected && (
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary bg-primary/10"
                >
                  {selectedItems.length} Selected
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Generates edited videos one by one in sequence. Scroll down to
              play rendered videos or select specific videos to edit & export
              again.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Quality & Folder Settings Toggle */}
            <HintTooltip
              label="Output Quality & Folder"
              detail="Configure resolution, FPS, CRF quality, speed, and destination folder"
              side="top"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowQualityPanel((v) => !v)}
              >
                <Settings2 className="h-3.5 w-3.5" />
                <span>
                  {currentResLabel} · CRF {masterSettings.output?.crf ?? 20}
                </span>
                {showQualityPanel ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </HintTooltip>

            {/* Download / Save Ready MP4s */}
            {completedItems.length > 0 && (
              <HintTooltip
                label={
                  batch.output_dir
                    ? 'Copy Ready MP4s to Output Folder'
                    : 'Download All Ready MP4s'
                }
                side="top"
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={exportingFolder}
                  onClick={() => void onDownloadOrSaveReady()}
                >
                  {exportingFolder ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : batch.output_dir ? (
                    <FolderOutput className="h-3.5 w-3.5" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {batch.output_dir
                    ? `Save Ready (${completedItems.length})`
                    : `Download All (${completedItems.length})`}
                </Button>
              </HintTooltip>
            )}

            {/* Selective Edit Button when 1+ videos checked */}
            {selectedItems.length > 0 && selectedItems.length < items.length && (
              <HintTooltip
                label="Edit Selected Videos Alone"
                detail="Open editor for only the checked video(s) without affecting other videos"
                side="top"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void onEditVideosSubset(selectedItems.map((i) => i.id))
                  }
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
                  Edit Selected ({selectedItems.length})
                </Button>
              </HintTooltip>
            )}

            {/* Primary Sequential Queue Export Button(s) */}
            {isSubsetSelected ? (
              <>
                <HintTooltip
                  label="Export Selected Videos Only"
                  detail="Queues and re-generates only the selected video(s) one by one"
                  side="top"
                >
                  <Button
                    type="button"
                    size="sm"
                    disabled={runningBatch}
                    onClick={() =>
                      void onExportSelectedQueue(selectedItems.map((i) => i.id))
                    }
                  >
                    {runningBatch ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5 fill-current" />
                    )}
                    Export Selected ({selectedItems.length})
                  </Button>
                </HintTooltip>

                <HintTooltip
                  label="Export All Videos in Batch"
                  detail="Queues all videos sequentially from #1 to the end"
                  side="top"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={runningBatch}
                    onClick={() => void onExportAllQueue()}
                  >
                    Export All ({items.length})
                  </Button>
                </HintTooltip>
              </>
            ) : (
              <HintTooltip
                label="Queue & Export All Videos Sequentially"
                detail="Generates edited MP4s one by one (#1 → #2 → ...) and displays them below"
                side="top"
              >
                <Button
                  type="button"
                  size="sm"
                  disabled={runningBatch || items.length === 0}
                  onClick={() => void onExportAllQueue()}
                >
                  {runningBatch ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" />
                  )}
                  Export All ({items.length})
                </Button>
              </HintTooltip>
            )}
          </div>
        </div>

        {/* Selection Quick Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/60 text-xs">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleToggleSelectAll(true)}
            >
              <CheckSquare className="h-3 w-3" />
              Select All ({items.length})
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleToggleSelectAll(false)}
            >
              <Square className="h-3 w-3" />
              Select None
            </Button>
          </div>

          {isDesktop && (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void onPickOutputFolder()}
              >
                <FolderOutput className="h-3 w-3 text-primary" />
                {batch.output_dir
                  ? `Auto-Save: ${batch.output_dir.split(/[\\/]/).pop()}`
                  : 'Set Auto-Save Folder'}
              </Button>
              {batch.output_dir && (
                <button
                  type="button"
                  onClick={() => void onClearOutputFolder()}
                  className="text-[11px] text-muted-foreground hover:text-foreground px-1"
                >
                  ×
                </button>
              )}
            </div>
          )}
        </div>

        {/* Expandable Master Output Quality Drawer */}
        {showQualityPanel && (
          <div className="rounded-xl bg-background/80 border border-border p-3.5 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="space-y-1.5">
              <span className="text-[11px] text-muted-foreground block">
                Master Resolution
              </span>
              <div className="grid grid-cols-4 gap-1">
                {(
                  [
                    { label: 'Auto', edge: null },
                    { label: '720p', edge: 1280 },
                    { label: '1080p', edge: 1920 },
                    { label: '4K', edge: 3840 },
                  ] as const
                ).map((tier) => {
                  const isAuto =
                    !masterSettings.output?.width &&
                    !masterSettings.output?.height;
                  const curLong = Math.max(
                    masterSettings.output?.width || 0,
                    masterSettings.output?.height || 0
                  );
                  const active =
                    tier.edge === null
                      ? isAuto
                      : !isAuto && Math.abs(curLong - tier.edge) <= 24;
                  return (
                    <button
                      key={tier.label}
                      type="button"
                      onClick={() => applyMasterResolutionTier(tier.edge)}
                      className={`py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tier.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">
                  Frame Rate
                </label>
                <select
                  value={
                    masterSettings.output?.fps
                      ? String(masterSettings.output.fps)
                      : 'auto'
                  }
                  onChange={(e) =>
                    onUpdateMaster((prev) => ({
                      ...prev,
                      output: {
                        ...prev.output,
                        fps:
                          e.target.value === 'auto'
                            ? null
                            : Number(e.target.value),
                      },
                    }))
                  }
                  className="w-full rounded-lg bg-card border border-border px-2 py-1.5 text-xs"
                >
                  <option value="auto">Source FPS</option>
                  <option value="24">24 fps</option>
                  <option value="30">30 fps</option>
                  <option value="60">60 fps</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">
                  Encode Speed
                </label>
                <select
                  value={masterSettings.output?.preset || 'fast'}
                  onChange={(e) =>
                    onUpdateMaster((prev) => ({
                      ...prev,
                      output: { ...prev.output, preset: e.target.value },
                    }))
                  }
                  className="w-full rounded-lg bg-card border border-border px-2 py-1.5 text-xs"
                >
                  <option value="ultrafast">Ultrafast</option>
                  <option value="veryfast">Veryfast</option>
                  <option value="fast">Fast</option>
                  <option value="medium">Medium</option>
                  <option value="slow">Slow (HQ)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-[11px] text-muted-foreground">
                  Quality (CRF)
                </span>
                <span className="font-mono">
                  CRF {masterSettings.output?.crf ?? 20}
                </span>
              </div>
              <Slider
                min={14}
                max={30}
                step={1}
                value={[masterSettings.output?.crf ?? 20]}
                onValueChange={(vals) => {
                  if (vals[0] !== undefined) {
                    onUpdateMaster((prev) => ({
                      ...prev,
                      output: { ...prev.output, crf: vals[0] },
                    }));
                  }
                }}
              />
            </div>
          </div>
        )}
      </section>

      {/* Vertical Scrollable Column of Output Videos */}
      <div className="max-w-4xl mx-auto space-y-5">
        {items.map((item, idx) => {
          const rowNumber = idx + 1;
          const sourceAsset: Asset | undefined = item.source_asset_id
            ? batch.videos.find((v) => v.id === item.source_asset_id)
            : undefined;

          const isQueued = item.status === 'queued';
          const isProcessing = item.status === 'processing';
          const isCompleted =
            item.status === 'completed' && item.output_asset !== null;
          const isFailed = item.status === 'failed';
          const pct = Math.max(
            0,
            Math.min(100, Math.round((item.progress ?? 0) * 100))
          );
          const waitPos = isQueued
            ? queuedItems.findIndex((q) => q.id === item.id) + 1
            : 0;
          const stageText = item.stage
            ? STAGE_LABELS[item.stage] || item.stage
            : isQueued
            ? 'Queued'
            : 'Rendering';

          const outDims = item.output_asset?.width
            ? {
                width: item.output_asset.width,
                height: item.output_asset.height || 1080,
              }
            : resolveTargetOutputDimensions(
                item.settings.crop,
                sourceAsset?.width || 1920,
                sourceAsset?.height || 1080,
                item.settings.output?.width,
                item.settings.output?.height
              );

          const separateTools = item.settings.overridden_tools ?? [];

          return (
            <article
              key={item.id}
              id={`output-video-card-${item.id}`}
              className={`rounded-2xl border overflow-hidden transition-all shadow-2xs ${
                isProcessing
                  ? 'border-primary/70 ring-1 ring-primary/30 bg-card'
                  : item.selected && isSubsetSelected
                  ? 'border-primary/45 bg-card'
                  : 'border-border bg-card'
              }`}
            >
              {/* Output Card Header */}
              <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <HintTooltip
                    label={
                      item.selected
                        ? 'Selected for Re-edit / Export'
                        : 'Select this video to edit or export alone'
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
                      aria-label={`Select output video #${rowNumber}`}
                      className="h-4 w-4 rounded border-border accent-primary cursor-pointer shrink-0"
                    />
                  </HintTooltip>

                  <Badge
                    variant={isProcessing ? 'default' : 'secondary'}
                    className="font-mono text-[11px]"
                  >
                    #{rowNumber}
                  </Badge>

                  <span className="text-sm font-semibold truncate">
                    {item.title}
                  </span>

                  <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono shrink-0">
                    {outDims.width}×{outDims.height} ·{' '}
                    {formatFriendlyDuration(
                      item.output_asset?.duration_ms ??
                        sourceAsset?.duration_ms ??
                        0
                    )}
                  </span>

                  {separateTools.length > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-amber-500/35 text-amber-300 bg-amber-500/10"
                    >
                      Separate: {separateTools.join(', ')}
                    </Badge>
                  )}

                  {isProcessing ? (
                    <Badge variant="default" className="gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {stageText} {pct}%
                    </Badge>
                  ) : isQueued ? (
                    <Badge variant="secondary" className="gap-1">
                      <Clock className="h-3 w-3" />
                      Queued #{waitPos}
                    </Badge>
                  ) : isCompleted ? (
                    <Badge variant="secondary" className="gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Ready MP4
                    </Badge>
                  ) : isFailed ? (
                    <Badge variant="destructive" className="gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Failed
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Pending Export
                    </Badge>
                  )}
                </div>

                {/* Output Card Right Actions */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {(isQueued || isProcessing) && item.active_job_id && (
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
                  )}

                  {isFailed && item.active_job_id && (
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
                  )}

                  {/* Edit This Video Alone */}
                  <HintTooltip
                    label={`Edit Video #${rowNumber} Alone`}
                    detail="Isolates this video in the editor so you can adjust it separately and re-export just this video"
                    side="top"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void onEditVideosSubset([item.id])}
                    >
                      <SlidersHorizontal className="h-3 w-3 text-primary" />
                      Edit #{rowNumber}
                    </Button>
                  </HintTooltip>

                  {/* Re-Export / Export This Single Video */}
                  {!isQueued && !isProcessing && (
                    <HintTooltip
                      label={
                        isCompleted
                          ? `Re-export Video #${rowNumber} Only`
                          : `Export Video #${rowNumber} Only`
                      }
                      side="top"
                    >
                      <Button
                        type="button"
                        variant={isCompleted ? 'secondary' : 'default'}
                        size="xs"
                        disabled={
                          exportingSingleId === item.id || !sourceAsset
                        }
                        onClick={async () => {
                          setExportingSingleId(item.id);
                          try {
                            await onExportSelectedQueue([item.id]);
                          } finally {
                            setExportingSingleId(null);
                          }
                        }}
                      >
                        {exportingSingleId === item.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Play className="h-3 w-3 fill-current" />
                        )}
                        {isCompleted ? 'Re-export' : 'Export'}
                      </Button>
                    </HintTooltip>
                  )}

                  {item.output_asset && (
                    <HintTooltip label="Download Rendered MP4" side="top">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          void videoApi.downloadOutputAsset(
                            item.output_asset!.id,
                            `${item.title.replace(
                              /[^a-zA-Z0-9._-]+/g,
                              '_'
                            )}.mp4`
                          )
                        }
                      >
                        <Download className="h-3 w-3" />
                        MP4
                      </Button>
                    </HintTooltip>
                  )}
                </div>
              </div>

              {/* Live Queue Progress Bar */}
              {(isProcessing || isQueued) && (
                <div className="h-1.5 w-full bg-muted overflow-hidden">
                  <div
                    style={{
                      width: isQueued ? '100%' : `${Math.max(5, pct)}%`,
                    }}
                    className={`h-full transition-all duration-300 ${
                      isQueued
                        ? 'bg-muted-foreground/30 animate-pulse'
                        : 'bg-primary'
                    }`}
                  />
                </div>
              )}

              {isFailed && item.error_message_safe && (
                <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/25 text-xs text-destructive flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{item.error_message_safe}</span>
                </div>
              )}

              {/* Vertical Column Playable Video Stage */}
              <div className="bg-black/95 flex items-center justify-center">
                {isCompleted && item.output_asset?.stream_url ? (
                  <video
                    key={item.output_asset.id}
                    src={item.output_asset.stream_url}
                    controls
                    playsInline
                    preload="metadata"
                    disablePictureInPicture
                    controlsList="nodownload noremoteplayback"
                    className="w-full max-h-[540px] object-contain"
                  />
                ) : isProcessing || isQueued ? (
                  <div className="py-16 px-6 text-center space-y-2.5">
                    {isProcessing ? (
                      <>
                        <Loader2 className="h-7 w-7 animate-spin text-primary mx-auto" />
                        <p className="text-sm font-medium text-foreground">
                          Rendering Video #{rowNumber} — {stageText} ({pct}%)
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Playable MP4 will appear right here as soon as encoding
                          completes.
                        </p>
                      </>
                    ) : (
                      <>
                        <Clock className="h-7 w-7 text-muted-foreground mx-auto" />
                        <p className="text-sm font-medium text-foreground">
                          Queued #{waitPos} in Sequential Pipeline
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Starts automatically once the preceding video finishes.
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="py-12 px-6 text-center space-y-2.5">
                    <Film className="h-6 w-6 text-muted-foreground mx-auto" />
                    <p className="text-xs text-muted-foreground">
                      Ready to generate{' '}
                      <strong className="text-foreground">{item.title}</strong>.
                      Click <strong>Export All</strong> above to render in
                      queue.
                    </p>
                    <div className="inline-flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-muted-foreground">
                      {item.settings.audio_enhancement?.enabled && (
                        <span className="px-2 py-0.5 rounded bg-card border border-border">
                          Clean Audio ({item.settings.audio_enhancement.preset})
                        </span>
                      )}
                      {item.logo_asset_id && item.settings.logo.enabled && (
                        <span className="px-2 py-0.5 rounded bg-card border border-border">
                          Logo{' '}
                          {Math.round(
                            (item.settings.logo.width_ratio || 0.26) * 100
                          )}
                          %
                        </span>
                      )}
                      {item.settings.subtitles.enabled && (
                        <span className="px-2 py-0.5 rounded bg-card border border-border inline-flex items-center gap-1">
                          <Sparkles className="h-2.5 w-2.5 text-primary" />
                          Subtitles
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};
