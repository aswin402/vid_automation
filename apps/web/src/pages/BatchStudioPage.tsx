import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CheckSquare,
  Clock,
  Download,
  Film,
  FolderInput,
  FolderOutput,
  Image as ImageIcon,
  Layers,
  Loader2,
  Play,
  Plus,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { extractApiError, isTauriDesktop, videoApi } from '@/api/videoApi';
import { FolderImportModal } from '@/components/batch/FolderImportModal';
import { BatchItemEditorPanel } from '@/components/batch/BatchItemEditorPanel';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { HintTooltip } from '@/components/ui/tooltip';
import { formatFriendlyDuration } from '@/lib/timecode';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type {
  Asset,
  BatchDetail,
  BatchItemDetail,
  BatchItemSpec,
  EditSettings,
} from '@/types/video';

function stemName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') || filename;
}

export const BatchStudioPage: React.FC = () => {
  const { batchId } = useParams<{ batchId: string }>();
  const queryClient = useQueryClient();

  const activeStudioTab = useWorkflowStore((s) => s.activeStudioTab);

  const [showFolderModal, setShowFolderModal] = useState(false);
  const [collapsedRows, setCollapsedRows] = useState<Record<string, boolean>>(
    {}
  );
  const [externalSyncGen, setExternalSyncGen] = useState<
    Record<string, number>
  >({});
  const [dragOverPool, setDragOverPool] = useState<
    'source' | 'logo' | 'outro' | null
  >(null);

  const [forceReexport, setForceReexport] = useState(false);
  const [runningBatch, setRunningBatch] = useState(false);
  const [updatingQueue, setUpdatingQueue] = useState(false);
  const [uploadingPoolKind, setUploadingPoolKind] = useState<
    'source' | 'logo' | 'outro' | null
  >(null);
  const [exportDestDir, setExportDestDir] = useState<string | null>(null);
  const [outputPopoverOpen, setOutputPopoverOpen] = useState(false);
  const [exportingFolder, setExportingFolder] = useState(false);
  const [bannerMsg, setBannerMsg] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  const liveDraftsRef = useRef<
    Map<string, { settings: EditSettings; dirty: boolean }>
  >(new Map());

  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const outroInputRef = useRef<HTMLInputElement | null>(null);

  const { data: capabilities } = useQuery({
    queryKey: ['capabilities'],
    queryFn: videoApi.getCapabilities,
    staleTime: 60_000,
  });

  const {
    data: batch,
    isLoading,
    refetch: refetchBatch,
  } = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => videoApi.getBatch(batchId!),
    enabled: Boolean(batchId),
    refetchInterval: (query) => {
      const b = query.state.data;
      if (!b) return false;
      const hasActive = b.items.some(
        (item) => item.status === 'queued' || item.status === 'processing'
      );
      return hasActive ? 900 : false;
    },
  });

  const setBatchCache = useCallback(
    (updated: BatchDetail) => {
      queryClient.setQueryData(['batch', batchId], updated);
      queryClient.invalidateQueries({ queryKey: ['batches'] });
    },
    [batchId, queryClient]
  );

  const bumpSyncGenForRows = (rowIds: string[]) => {
    setExternalSyncGen((prev) => {
      const next = { ...prev };
      for (const id of rowIds) {
        next[id] = (next[id] || 0) + 1;
      }
      return next;
    });
  };

  const handleLiveDraftChange = useCallback(
    (rowId: string, settings: EditSettings, isDirty: boolean) => {
      liveDraftsRef.current.set(rowId, { settings, dirty: isDirty });
    },
    []
  );

  const getLiveSettingsForRow = useCallback((rowId: string) => {
    return liveDraftsRef.current.get(rowId)?.settings;
  }, []);

  const flushDirtyRowDrafts = async (targetIds?: string[]) => {
    if (!batchId) return;
    const filter = targetIds ? new Set(targetIds) : null;
    for (const [rowId, entry] of liveDraftsRef.current.entries()) {
      if (!entry.dirty) continue;
      if (filter && !filter.has(rowId)) continue;
      const updated = await videoApi.updateBatchItem(batchId, rowId, {
        use_custom_settings: true,
        settings: entry.settings,
      });
      liveDraftsRef.current.set(rowId, {
        settings: entry.settings,
        dirty: false,
      });
      setBatchCache(updated);
    }
  };

  const existingItemToSpec = (item: BatchItemDetail): BatchItemSpec => ({
    id: item.id,
    selected: item.selected,
    title: item.title,
    source_asset_id: item.source_asset_id,
    logo_asset_id: item.logo_asset_id,
    outro_asset_id: item.outro_asset_id,
    use_custom_settings: item.use_custom_settings,
  });

  const appendRowsForUnmappedVideos = async (
    latest: BatchDetail
  ): Promise<BatchDetail> => {
    const mappedVideoIds = new Set(
      latest.items
        .map((i) => i.source_asset_id)
        .filter((id): id is string => Boolean(id))
    );
    const unmappedVideos = latest.videos.filter(
      (v) => !mappedVideoIds.has(v.id)
    );
    if (unmappedVideos.length === 0) {
      setBatchCache(latest);
      return latest;
    }

    const activeLogoId = latest.logos[0]?.id || null;
    const activeOutroId = latest.outros[0]?.id || null;

    const appendedSpecs: BatchItemSpec[] = [
      ...latest.items.map(existingItemToSpec),
      ...unmappedVideos.map((vid) => ({
        selected: true,
        title: stemName(vid.original_filename),
        source_asset_id: vid.id,
        logo_asset_id: activeLogoId,
        outro_asset_id: activeOutroId,
      })),
    ];

    const synced = await videoApi.setBatchItems(
      latest.id,
      appendedSpecs,
      'many_videos_one_brand'
    );
    setBatchCache(synced);
    return synced;
  };

  const handleUploadMultipleVideos = async (
    files: FileList | File[] | null
  ) => {
    if (!batchId || !files || files.length === 0) return;
    setUploadingPoolKind('source');
    setBannerMsg(null);
    const list = Array.from(files);
    try {
      await flushDirtyRowDrafts();
      for (const f of list) {
        await videoApi.uploadBatchPoolAsset(batchId, 'source', f);
      }
      const latest = await videoApi.getBatch(batchId);
      await appendRowsForUnmappedVideos(latest);
      setBannerMsg({
        kind: 'ok',
        text: `Imported ${list.length} video${list.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to import source videos.'),
      });
    } finally {
      setUploadingPoolKind(null);
    }
  };

  const handleAddVideosClick = async () => {
    if (!batchId) return;
    if (isTauriDesktop()) {
      setUploadingPoolKind('source');
      setBannerMsg(null);
      try {
        await flushDirtyRowDrafts();
        const imported = await videoApi.pickAndImportBatchPoolAssets(
          batchId,
          'source'
        );
        if (imported.length > 0) {
          const latest = await videoApi.getBatch(batchId);
          await appendRowsForUnmappedVideos(latest);
        }
      } catch (err) {
        setBannerMsg({
          kind: 'err',
          text: extractApiError(err, 'Failed to import local videos.'),
        });
      } finally {
        setUploadingPoolKind(null);
      }
      return;
    }
    videoInputRef.current?.click();
  };

  const applyNewSingleLogoAcrossBatch = async (newLogo: Asset) => {
    if (!batchId) return;
    const latest = await videoApi.getBatch(batchId);

    let synced = latest;
    if (latest.items.length > 0) {
      const nextSpecs = latest.items.map((item) => ({
        ...existingItemToSpec(item),
        logo_asset_id: newLogo.id,
      }));
      synced = await videoApi.setBatchItems(
        batchId,
        nextSpecs,
        'many_videos_one_brand'
      );
    }

    for (const oldLogo of latest.logos) {
      if (oldLogo.id !== newLogo.id) {
        synced = await videoApi.deleteBatchPoolAsset(batchId, oldLogo.id);
      }
    }

    for (const row of synced.items) {
      liveDraftsRef.current.set(row.id, {
        settings: row.settings,
        dirty: false,
      });
    }
    bumpSyncGenForRows(synced.items.map((r) => r.id));
    setBatchCache(synced);
  };

  const handleSingleLogoFiles = async (files: FileList | File[] | null) => {
    if (!batchId || !files || files.length === 0) return;
    const singleFile = files[0];
    if (!singleFile) return;

    setUploadingPoolKind('logo');
    setBannerMsg(null);
    try {
      await flushDirtyRowDrafts();
      const uploaded = await videoApi.uploadBatchPoolAsset(
        batchId,
        'logo',
        singleFile
      );
      await applyNewSingleLogoAcrossBatch(uploaded);
      setBannerMsg({
        kind: 'ok',
        text: `Logo "${singleFile.name}" linked.`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to upload brand logo.'),
      });
    } finally {
      setUploadingPoolKind(null);
    }
  };

  const handleTriggerSingleLogoUpload = async () => {
    if (!batchId) return;
    if (isTauriDesktop()) {
      setUploadingPoolKind('logo');
      setBannerMsg(null);
      try {
        await flushDirtyRowDrafts();
        const imported = await videoApi.pickAndImportBatchPoolAssets(
          batchId,
          'logo'
        );
        if (imported[0]) {
          await applyNewSingleLogoAcrossBatch(imported[0]);
        }
      } catch (err) {
        setBannerMsg({
          kind: 'err',
          text: extractApiError(err, 'Failed to select brand logo.'),
        });
      } finally {
        setUploadingPoolKind(null);
      }
      return;
    }
    logoInputRef.current?.click();
  };

  const handleRemoveSingleLogo = async () => {
    if (!batch || !batchId || batch.logos.length === 0) return;
    setUploadingPoolKind('logo');
    try {
      await flushDirtyRowDrafts();
      let synced = batch;
      if (batch.items.length > 0) {
        const nextSpecs = batch.items.map((item) => ({
          ...existingItemToSpec(item),
          logo_asset_id: null,
        }));
        synced = await videoApi.setBatchItems(batchId, nextSpecs);
      }
      for (const l of [...batch.logos]) {
        synced = await videoApi.deleteBatchPoolAsset(batchId, l.id);
      }
      for (const row of synced.items) {
        liveDraftsRef.current.set(row.id, {
          settings: row.settings,
          dirty: false,
        });
      }
      bumpSyncGenForRows(synced.items.map((r) => r.id));
      setBatchCache(synced);
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to remove brand logo.'),
      });
    } finally {
      setUploadingPoolKind(null);
    }
  };

  const applyNewSingleOutroAcrossBatch = async (newOutro: Asset) => {
    if (!batchId) return;
    const latest = await videoApi.getBatch(batchId);

    let synced = latest;
    if (latest.items.length > 0) {
      const nextSpecs = latest.items.map((item) => ({
        ...existingItemToSpec(item),
        outro_asset_id: newOutro.id,
      }));
      synced = await videoApi.setBatchItems(
        batchId,
        nextSpecs,
        'many_videos_one_brand'
      );
    }

    for (const oldOutro of latest.outros) {
      if (oldOutro.id !== newOutro.id) {
        synced = await videoApi.deleteBatchPoolAsset(batchId, oldOutro.id);
      }
    }

    for (const row of synced.items) {
      liveDraftsRef.current.set(row.id, {
        settings: row.settings,
        dirty: false,
      });
    }
    bumpSyncGenForRows(synced.items.map((r) => r.id));
    setBatchCache(synced);
  };

  const handleSingleOutroFiles = async (files: FileList | File[] | null) => {
    if (!batchId || !files || files.length === 0) return;
    const singleFile = files[0];
    if (!singleFile) return;

    setUploadingPoolKind('outro');
    setBannerMsg(null);
    try {
      await flushDirtyRowDrafts();
      const uploaded = await videoApi.uploadBatchPoolAsset(
        batchId,
        'outro',
        singleFile
      );
      await applyNewSingleOutroAcrossBatch(uploaded);
      setBannerMsg({
        kind: 'ok',
        text: `Outro "${singleFile.name}" linked.`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to upload outro clip.'),
      });
    } finally {
      setUploadingPoolKind(null);
    }
  };

  const handleTriggerSingleOutroUpload = async () => {
    if (!batchId) return;
    if (isTauriDesktop()) {
      setUploadingPoolKind('outro');
      setBannerMsg(null);
      try {
        await flushDirtyRowDrafts();
        const imported = await videoApi.pickAndImportBatchPoolAssets(
          batchId,
          'outro'
        );
        if (imported[0]) {
          await applyNewSingleOutroAcrossBatch(imported[0]);
        }
      } catch (err) {
        setBannerMsg({
          kind: 'err',
          text: extractApiError(err, 'Failed to select outro clip.'),
        });
      } finally {
        setUploadingPoolKind(null);
      }
      return;
    }
    outroInputRef.current?.click();
  };

  const handleRemoveSingleOutro = async () => {
    if (!batch || !batchId || batch.outros.length === 0) return;
    setUploadingPoolKind('outro');
    try {
      await flushDirtyRowDrafts();
      let synced = batch;
      if (batch.items.length > 0) {
        const nextSpecs = batch.items.map((item) => ({
          ...existingItemToSpec(item),
          outro_asset_id: null,
        }));
        synced = await videoApi.setBatchItems(batchId, nextSpecs);
      }
      for (const o of [...batch.outros]) {
        synced = await videoApi.deleteBatchPoolAsset(batchId, o.id);
      }
      for (const row of synced.items) {
        liveDraftsRef.current.set(row.id, {
          settings: row.settings,
          dirty: false,
        });
      }
      bumpSyncGenForRows(synced.items.map((r) => r.id));
      setBatchCache(synced);
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to remove outro clip.'),
      });
    } finally {
      setUploadingPoolKind(null);
    }
  };

  const selectedQueueItems = useMemo(
    () => (batch?.items || []).filter((i) => i.selected),
    [batch?.items]
  );

  const handleDeleteRow = async (rowId: string) => {
    if (!batch) return;
    setUpdatingQueue(true);
    try {
      const targetRow = batch.items.find((i) => i.id === rowId);
      liveDraftsRef.current.delete(rowId);
      const remainingItems = batch.items.filter((i) => i.id !== rowId);
      const nextSpecs = remainingItems.map(existingItemToSpec);
      let updated = await videoApi.setBatchItems(batch.id, nextSpecs);

      if (
        targetRow?.source_asset_id &&
        !remainingItems.some(
          (r) => r.source_asset_id === targetRow.source_asset_id
        )
      ) {
        updated = await videoApi.deleteBatchPoolAsset(
          batch.id,
          targetRow.source_asset_id
        );
      }
      setBatchCache(updated);
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to remove video row.'),
      });
    } finally {
      setUpdatingQueue(false);
    }
  };

  const handleBulkSelectRows = async (mode: 'all' | 'none') => {
    if (!batch || batch.items.length === 0) return;
    setUpdatingQueue(true);
    try {
      const nextSpecs = batch.items.map((item) => ({
        ...existingItemToSpec(item),
        selected: mode === 'all',
      }));
      const updated = await videoApi.setBatchItems(batch.id, nextSpecs);
      setBatchCache(updated);
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to update selection.'),
      });
    } finally {
      setUpdatingQueue(false);
    }
  };

  const handleApplyCardEditsToSelected = async (
    sourceRowNumber: number,
    settings: EditSettings
  ) => {
    if (!batch) return;
    const targetIds = selectedQueueItems.map((i) => i.id);
    if (targetIds.length === 0) {
      const updated = await videoApi.updateBatch(batch.id, {
        shared_settings: settings,
      });
      setBatchCache(updated);
      return;
    }

    const updated = await videoApi.applySettingsToBatchItems(
      batch.id,
      targetIds,
      settings,
      true
    );
    for (const tid of targetIds) {
      const refreshedRow = updated.items.find((r) => r.id === tid);
      if (refreshedRow) {
        liveDraftsRef.current.set(tid, {
          settings: refreshedRow.settings,
          dirty: false,
        });
      }
    }
    bumpSyncGenForRows(targetIds);
    setBatchCache(updated);
    setBannerMsg({
      kind: 'ok',
      text: `Copied Row #${sourceRowNumber} settings to ${targetIds.length} selected row(s).`,
    });
  };

  const handleExportSingleRow = async (
    rowId: string,
    latestSettings: EditSettings
  ) => {
    if (!batch) return;
    await videoApi.updateBatchItem(batch.id, rowId, {
      use_custom_settings: true,
      settings: latestSettings,
    });
    liveDraftsRef.current.set(rowId, {
      settings: latestSettings,
      dirty: false,
    });

    const resp = await videoApi.runBatchAutomation(batch.id, [rowId], true);
    setBatchCache(resp.batch);
    const rowNum = batch.items.findIndex((i) => i.id === rowId) + 1;
    const isAnotherRunning = resp.batch.items.some(
      (i) => i.id !== rowId && i.status === 'processing'
    );
    setBannerMsg({
      kind: 'ok',
      text: isAnotherRunning
        ? `Row #${rowNum} queued next.`
        : `Rendering Row #${rowNum}.`,
    });
  };

  const handleRunBulkQueue = async () => {
    if (!batch) return;
    const ids = selectedQueueItems.map((i) => i.id);
    if (ids.length === 0) {
      setBannerMsg({
        kind: 'err',
        text: 'Select at least 1 row to export.',
      });
      return;
    }

    setRunningBatch(true);
    setBannerMsg(null);
    try {
      await flushDirtyRowDrafts(ids);
      const resp = await videoApi.runBatchAutomation(
        batch.id,
        ids,
        forceReexport
      );
      setBatchCache(resp.batch);
      setBannerMsg({
        kind: 'ok',
        text:
          resp.launched_count > 0
            ? `Queued ${resp.launched_count} video(s).`
            : 'Selected rows already rendered. Enable Re-export to overwrite.',
      });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to launch export queue.'),
      });
    } finally {
      setRunningBatch(false);
    }
  };

  const handleDownloadReadyOutputs = async () => {
    if (!batch) return;
    const targetPool =
      selectedQueueItems.length > 0 ? selectedQueueItems : batch.items;
    const readyRows = targetPool.filter((i) => i.output_asset !== null);
    if (readyRows.length === 0) return;

    for (let idx = 0; idx < readyRows.length; idx += 1) {
      const item = readyRows[idx];
      if (!item.output_asset) continue;
      const safeTitle =
        item.title.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') ||
        `batch_video_${idx + 1}`;
      await videoApi.downloadOutputAsset(
        item.output_asset.id,
        `${safeTitle}.mp4`
      );
      if (!isTauriDesktop() && idx + 1 < readyRows.length) {
        await new Promise((r) => window.setTimeout(r, 350));
      }
    }
  };

  const resolvedExportDestDir =
    exportDestDir !== null ? exportDestDir : batch?.output_dir || '';

  const handleExportToFolder = async () => {
    if (!batch || !resolvedExportDestDir.trim()) return;
    setExportingFolder(true);
    setBannerMsg(null);
    try {
      const ids = selectedQueueItems.map((i) => i.id);
      const resp = await videoApi.exportBatchOutputsToFolder(
        batch.id,
        resolvedExportDestDir.trim(),
        ids.length > 0 ? ids : undefined
      );
      await videoApi.updateBatch(batch.id, { output_dir: resp.dest_dir });
      setBannerMsg({
        kind: 'ok',
        text: `Saved ${resp.exported_count} MP4(s) to ${resp.dest_dir}`,
      });
      setOutputPopoverOpen(false);
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to export MP4s to folder.'),
      });
    } finally {
      setExportingFolder(false);
    }
  };

  if (isLoading || !batch) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-16 flex items-center justify-center gap-2.5 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span>Loading studio...</span>
      </div>
    );
  }

  const singleLogoAsset: Asset | undefined = batch.logos[0];
  const singleOutroAsset: Asset | undefined = batch.outros[0];

  const currentlyRenderingItem = batch.items.find(
    (i) => i.status === 'processing'
  );
  const queuedItems = batch.items.filter((i) => i.status === 'queued');
  const completedItems = batch.items.filter(
    (i) => i.status === 'completed' && i.output_asset !== null
  );
  const completedSelectedCount = selectedQueueItems.filter(
    (i) => i.output_asset !== null
  ).length;
  const isQueueActive = Boolean(
    currentlyRenderingItem || queuedItems.length > 0
  );

  const allowedFonts = capabilities?.allowed_fonts || [
    'DejaVu Sans',
    'Liberation Sans',
    'Ubuntu',
    'Noto Sans',
  ];
  const supportedLanguages = capabilities?.supported_languages || [
    { code: 'auto', name: 'Auto-detect' },
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
  ];

  const scrollToRow = (rowId: string) => {
    setCollapsedRows((prev) => ({ ...prev, [rowId]: false }));
    window.setTimeout(() => {
      document
        .getElementById(`batch-row-card-${rowId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-4 space-y-4">
      <input
        ref={videoInputRef}
        type="file"
        multiple
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v"
        onChange={(e) => {
          void handleUploadMultipleVideos(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />
      <input
        ref={logoInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        onChange={(e) => {
          void handleSingleLogoFiles(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />
      <input
        ref={outroInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v"
        onChange={(e) => {
          void handleSingleOutroFiles(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* Sleek Compact Media Dock (60-30-10, Zero Verbose Paragraphs) */}
      <div className="rounded-xl bg-card border border-border p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <HintTooltip label="Back to Workspace" side="bottom">
            <Button asChild variant="ghost" size="icon-sm">
              <Link to="/" aria-label="Back to Workspace">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
          </HintTooltip>

          <HintTooltip
            label="Campaign Title"
            detail="Click to rename"
            side="bottom"
          >
            <input
              type="text"
              defaultValue={batch.name}
              key={batch.name}
              onBlur={async (e) => {
                const next = e.target.value.trim();
                if (next && next !== batch.name) {
                  const updated = await videoApi.updateBatch(batch.id, {
                    name: next,
                  });
                  setBatchCache(updated);
                }
              }}
              className="text-sm font-semibold tracking-tight bg-transparent border-b border-transparent hover:border-border focus:border-primary focus:outline-none px-1 py-0.5 max-w-52 sm:max-w-64 truncate"
            />
          </HintTooltip>
        </div>

        {/* Compact Drag-and-Drop Media Pills */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 1. Multi-Video Slot */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverPool('source');
            }}
            onDragLeave={() => setDragOverPool(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverPool(null);
              void handleUploadMultipleVideos(e.dataTransfer.files);
            }}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 transition-colors ${
              dragOverPool === 'source'
                ? 'border-primary bg-primary/10'
                : 'border-border bg-muted/40'
            }`}
          >
            <HintTooltip
              label="Add Videos"
              detail="Select or drop multiple MP4/MOV/WebM clips"
              side="bottom"
            >
              <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={uploadingPoolKind === 'source'}
                onClick={() => void handleAddVideosClick()}
              >
                {uploadingPoolKind === 'source' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                <span>Videos ({batch.items.length})</span>
              </Button>
            </HintTooltip>

            <HintTooltip
              label="Import Folder"
              detail="Scan a local folder for source videos, logo & outro"
              side="bottom"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowFolderModal(true)}
                aria-label="Import from folder"
              >
                <FolderInput className="h-3.5 w-3.5" />
              </Button>
            </HintTooltip>
          </div>

          {/* 2. Single Brand Logo Pill */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverPool('logo');
            }}
            onDragLeave={() => setDragOverPool(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverPool(null);
              void handleSingleLogoFiles(e.dataTransfer.files);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors ${
              dragOverPool === 'logo'
                ? 'border-primary bg-primary/10'
                : 'border-border bg-muted/40'
            }`}
          >
            {singleLogoAsset ? (
              <>
                {singleLogoAsset.stream_url && (
                  <img
                    src={singleLogoAsset.stream_url}
                    alt={singleLogoAsset.original_filename}
                    className="h-5 w-6 object-contain rounded bg-black/50 p-0.5 shrink-0"
                  />
                )}
                <HintTooltip
                  label="Replace Brand Logo"
                  detail={`${singleLogoAsset.original_filename} (${singleLogoAsset.width}×${singleLogoAsset.height})`}
                  side="bottom"
                >
                  <button
                    type="button"
                    disabled={uploadingPoolKind === 'logo'}
                    onClick={() => void handleTriggerSingleLogoUpload()}
                    className="text-xs font-medium max-w-28 truncate hover:text-primary transition-colors"
                  >
                    {singleLogoAsset.original_filename}
                  </button>
                </HintTooltip>
                <HintTooltip label="Remove Logo" side="bottom">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void handleRemoveSingleLogo()}
                    aria-label="Remove brand logo"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </HintTooltip>
              </>
            ) : (
              <HintTooltip
                label="Upload Single Brand Logo"
                detail="Drop or pick PNG / WebP / JPG watermark applied to rows"
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={uploadingPoolKind === 'logo'}
                  onClick={() => void handleTriggerSingleLogoUpload()}
                >
                  {uploadingPoolKind === 'logo' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3 w-3" />
                  )}
                  <span>+ Logo</span>
                </Button>
              </HintTooltip>
            )}
          </div>

          {/* 3. Single Outro Pill */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverPool('outro');
            }}
            onDragLeave={() => setDragOverPool(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverPool(null);
              void handleSingleOutroFiles(e.dataTransfer.files);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors ${
              dragOverPool === 'outro'
                ? 'border-primary bg-primary/10'
                : 'border-border bg-muted/40'
            }`}
          >
            {singleOutroAsset ? (
              <>
                <Film className="h-3 w-3 text-muted-foreground shrink-0" />
                <HintTooltip
                  label="Replace Outro Clip"
                  detail={`${singleOutroAsset.original_filename} · ${formatFriendlyDuration(
                    singleOutroAsset.duration_ms || 0
                  )}`}
                  side="bottom"
                >
                  <button
                    type="button"
                    disabled={uploadingPoolKind === 'outro'}
                    onClick={() => void handleTriggerSingleOutroUpload()}
                    className="text-xs font-medium max-w-28 truncate hover:text-primary transition-colors"
                  >
                    {singleOutroAsset.original_filename}
                  </button>
                </HintTooltip>
                <HintTooltip label="Remove Outro" side="bottom">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void handleRemoveSingleOutro()}
                    aria-label="Remove outro clip"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </HintTooltip>
              </>
            ) : (
              <HintTooltip
                label="Upload Single Outro"
                detail="Drop or pick MP4 / MOV end card appended after clips"
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={uploadingPoolKind === 'outro'}
                  onClick={() => void handleTriggerSingleOutroUpload()}
                >
                  {uploadingPoolKind === 'outro' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Film className="h-3 w-3" />
                  )}
                  <span>+ Outro</span>
                </Button>
              </HintTooltip>
            )}
          </div>

          {/* 4. Output Folder Popover */}
          <Popover open={outputPopoverOpen} onOpenChange={setOutputPopoverOpen}>
            <HintTooltip
              label="Output Folder"
              detail={
                batch.output_dir
                  ? `Auto-save folder: ${batch.output_dir}`
                  : 'Set destination folder for rendered MP4s'
              }
              side="bottom"
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant={batch.output_dir ? 'secondary' : 'outline'}
                  size="sm"
                >
                  <FolderOutput className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Output</span>
                </Button>
              </PopoverTrigger>
            </HintTooltip>
            <PopoverContent className="w-80 space-y-3" align="end">
              <div className="space-y-1">
                <span className="text-xs font-semibold">Output Folder</span>
                <p className="text-[11px] text-muted-foreground">
                  Destination path for exported MP4s
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={resolvedExportDestDir}
                  onChange={(e) => setExportDestDir(e.target.value)}
                  placeholder="./exports/campaign_01"
                  className="flex-1 rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring/50"
                />
                {isTauriDesktop() && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={async () => {
                      const dir = await videoApi.pickLocalFolderPath(
                        'Choose Export Folder'
                      );
                      if (dir) setExportDestDir(dir);
                    }}
                  >
                    Browse
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  disabled={exportingFolder || !resolvedExportDestDir.trim()}
                  onClick={() => void handleExportToFolder()}
                >
                  {exportingFolder ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <FolderOutput className="h-3 w-3" />
                  )}
                  Save Ready MP4s
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Status Toast Strip */}
      {bannerMsg && (
        <div
          className={`rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs border ${
            bannerMsg.kind === 'ok'
              ? 'bg-card border-border text-foreground'
              : 'bg-destructive/10 border-destructive/30 text-destructive'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            {bannerMsg.kind === 'ok' ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            )}
            {bannerMsg.text}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setBannerMsg(null)}
            aria-label="Dismiss notification"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Sticky Quick-Jump & Queue Control Bar */}
      {batch.items.length > 0 && (
        <div className="sticky top-14 z-30 rounded-xl bg-background/92 backdrop-blur-xl border border-border p-2.5 shadow-sm space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {/* Row Jump Chips */}
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full">
              {batch.items.map((row, idx) => {
                const rNum = idx + 1;
                const rowPct = Math.round((row.progress ?? 0) * 100);
                const chipClass =
                  row.status === 'processing'
                    ? 'bg-primary text-primary-foreground border-primary animate-pulse'
                    : row.status === 'queued'
                    ? 'bg-secondary text-foreground border-border'
                    : row.status === 'completed' && row.output_asset
                    ? 'bg-card text-foreground border-emerald-500/45'
                    : row.status === 'failed'
                    ? 'bg-destructive/10 text-destructive border-destructive/40'
                    : row.selected
                    ? 'bg-card hover:bg-muted text-foreground border-primary/40'
                    : 'bg-card/50 text-muted-foreground border-border';

                return (
                  <HintTooltip
                    key={row.id}
                    label={`Row #${rNum}: ${row.title}`}
                    detail={`Status: ${row.status}`}
                    side="bottom"
                  >
                    <button
                      type="button"
                      onClick={() => scrollToRow(row.id)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-mono font-semibold transition-all shrink-0 ${chipClass}`}
                    >
                      <span>#{rNum}</span>
                      {row.status === 'processing' && (
                        <span className="text-[10px]">{rowPct}%</span>
                      )}
                      {row.status === 'queued' && (
                        <Clock className="h-2.5 w-2.5 text-muted-foreground" />
                      )}
                      {row.status === 'completed' && row.output_asset && (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      )}
                    </button>
                  </HintTooltip>
                );
              })}
            </div>

            {/* Selection + Sequential Export Controls */}
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <div className="flex items-center gap-1 border-r border-border pr-2">
                <HintTooltip label="Select all rows" side="bottom">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={updatingQueue}
                    onClick={() => void handleBulkSelectRows('all')}
                  >
                    <CheckSquare className="h-3 w-3" />
                    All
                  </Button>
                </HintTooltip>
                <HintTooltip label="Deselect all rows" side="bottom">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={updatingQueue}
                    onClick={() => void handleBulkSelectRows('none')}
                    className="text-muted-foreground"
                  >
                    <Square className="h-3 w-3" />
                    None
                  </Button>
                </HintTooltip>
              </div>

              <HintTooltip
                label="Force Re-export"
                detail="Re-render rows that already have a completed MP4"
                side="bottom"
              >
                <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer px-1">
                  <Switch
                    checked={forceReexport}
                    onCheckedChange={setForceReexport}
                  />
                  <span>Re-export</span>
                </label>
              </HintTooltip>

              {(completedSelectedCount > 0 || completedItems.length > 0) && (
                <HintTooltip
                  label="Download Finished MP4s"
                  detail="Save rendered videos locally"
                  side="bottom"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDownloadReadyOutputs()}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>
                      Download (
                      {completedSelectedCount > 0
                        ? completedSelectedCount
                        : completedItems.length}
                      )
                    </span>
                  </Button>
                </HintTooltip>
              )}

              <HintTooltip
                label="Export Selected Queue"
                detail="Renders checked rows sequentially one by one"
                side="bottom"
              >
                <Button
                  type="button"
                  size="sm"
                  disabled={runningBatch || selectedQueueItems.length === 0}
                  onClick={() => void handleRunBulkQueue()}
                >
                  {runningBatch ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" />
                  )}
                  <span>Export Queue ({selectedQueueItems.length})</span>
                </Button>
              </HintTooltip>
            </div>
          </div>

          {isQueueActive && (
            <div className="rounded-lg bg-muted/60 border border-border px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <div className="flex items-center gap-2 font-medium">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                {currentlyRenderingItem ? (
                  <span>
                    Row #
                    {batch.items.findIndex(
                      (i) => i.id === currentlyRenderingItem.id
                    ) + 1}{' '}
                    · {currentlyRenderingItem.title} (
                    {Math.round((currentlyRenderingItem.progress ?? 0) * 100)}%)
                  </span>
                ) : (
                  <span>Starting next queued video...</span>
                )}
              </div>

              <div className="flex items-center gap-3 font-mono text-muted-foreground">
                <span>Waiting: {queuedItems.length}</span>
                <span>
                  Done: {completedItems.length}/{batch.items.length}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty Queue State vs Stacked Row Workbenches */}
      {batch.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 py-14 px-6 text-center space-y-3">
          <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center text-primary mx-auto">
            <Layers className="h-5 w-5" />
          </div>
          <div className="text-sm font-medium">Add videos to start editing</div>
          <div className="flex items-center justify-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={() => void handleAddVideosClick()}
            >
              <Upload className="h-3.5 w-3.5" />
              Add Videos
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowFolderModal(true)}
            >
              <FolderInput className="h-3.5 w-3.5" />
              Import Folder
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {batch.items.map((row, idx) => {
            const queueIndex =
              row.status === 'queued'
                ? queuedItems.findIndex((q) => q.id === row.id) + 1
                : null;
            const syncGen = externalSyncGen[row.id] || 0;

            return (
              <BatchItemEditorPanel
                key={`${row.id}:sync-${syncGen}`}
                batch={batch}
                item={row}
                rowNumber={idx + 1}
                activeTab={activeStudioTab}
                queueWaitingPosition={queueIndex}
                selectedItemIds={selectedQueueItems.map((i) => i.id)}
                isCollapsed={Boolean(collapsedRows[row.id])}
                onToggleCollapse={() =>
                  setCollapsedRows((prev) => ({
                    ...prev,
                    [row.id]: !prev[row.id],
                  }))
                }
                allowedFonts={allowedFonts}
                supportedLanguages={supportedLanguages}
                singleLogoAsset={singleLogoAsset}
                singleOutroAsset={singleOutroAsset}
                uploadingSingleKind={uploadingPoolKind}
                onTriggerSingleLogoUpload={handleTriggerSingleLogoUpload}
                onRemoveSingleLogo={handleRemoveSingleLogo}
                onTriggerSingleOutroUpload={handleTriggerSingleOutroUpload}
                onRemoveSingleOutro={handleRemoveSingleOutro}
                getLiveSettingsForRow={getLiveSettingsForRow}
                onLiveDraftChange={handleLiveDraftChange}
                onApplyToSelectedRows={handleApplyCardEditsToSelected}
                onExportSingleRow={handleExportSingleRow}
                onDeleteRow={handleDeleteRow}
                onBatchUpdated={setBatchCache}
              />
            );
          })}
        </div>
      )}

      {showFolderModal && (
        <FolderImportModal
          batchId={batch.id}
          onClose={() => setShowFolderModal(false)}
          onImported={async (updated) => {
            const latest = updated ?? (await refetchBatch()).data;
            if (latest) {
              await appendRowsForUnmappedVideos(latest);
            }
          }}
        />
      )}
    </div>
  );
};
