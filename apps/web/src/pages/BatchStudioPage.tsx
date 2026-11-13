import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  Filter,
  FolderInput,
  FolderOutput,
  Image as ImageIcon,
  Layers,
  Loader2,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { extractApiError, isTauriDesktop, videoApi } from '@/api/videoApi';
import { FolderImportModal } from '@/components/batch/FolderImportModal';
import { BatchItemEditorPanel } from '@/components/batch/BatchItemEditorPanel';
import { BatchMasterControlPanel } from '@/components/batch/BatchMasterControlPanel';
import { BatchOutputColumn } from '@/components/batch/BatchOutputColumn';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { HintTooltip } from '@/components/ui/tooltip';
import {
  isToolOverriddenOnSettings,
  mergeLiveMasterIntoRowSettings,
  removeOverriddenTool,
  studioTabToToolKey,
} from '@/lib/batchSettingsMerge';
import { formatFriendlyDuration } from '@/lib/timecode';
import {
  useWorkflowStore,
  type StudioNavbarTab,
} from '@/store/useWorkflowStore';
import type {
  Asset,
  BatchDetail,
  BatchItemDetail,
  BatchItemSpec,
  EditSettings,
} from '@/types/video';

const STUDIO_STEP_SEQUENCE: ReadonlyArray<{
  id: StudioNavbarTab;
  label: string;
}> = [
  { id: 'trim', label: 'Trim' },
  { id: 'crop', label: 'Ratio & Face' },
  { id: 'subtitles', label: 'Subtitles' },
  { id: 'color', label: 'Color' },
  { id: 'audio', label: 'Audio' },
  { id: 'logo', label: 'Logo' },
  { id: 'outro', label: 'Outro' },
  { id: 'export', label: 'Output' },
];

function stemName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') || filename;
}

export const BatchStudioPage: React.FC = () => {
  const { batchId } = useParams<{ batchId: string }>();
  const queryClient = useQueryClient();

  const activeStudioTab = useWorkflowStore((s) => s.activeStudioTab);
  const setActiveStudioTab = useWorkflowStore((s) => s.setActiveStudioTab);

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

  // Master Control live draft + debounced persistence (null = synced with batch.shared_settings)
  const [localMasterDraft, setLocalMasterDraft] = useState<EditSettings | null>(
    null
  );
  const [masterSaveState, setMasterSaveState] = useState<
    'idle' | 'saving' | 'saved'
  >('idle');

  // Optional subset filter when user clicks "Edit #N" or "Edit Selected" in Output tab
  const [focusedSubsetIds, setFocusedSubsetIds] = useState<string[] | null>(
    null
  );
  const [steppingTab, setSteppingTab] = useState(false);

  const [runningBatch, setRunningBatch] = useState(false);
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

  // Debounced auto-save for Master Control edits (propagates to all non-overridden rows)
  useEffect(() => {
    if (!batchId || !localMasterDraft) return;
    const snapshot = localMasterDraft;
    const timer = window.setTimeout(async () => {
      setMasterSaveState('saving');
      try {
        const updated = await videoApi.updateBatch(batchId, {
          shared_settings: snapshot,
        });
        setBatchCache(updated);
        setLocalMasterDraft((cur) => {
          if (cur === snapshot) {
            setMasterSaveState('saved');
            return null;
          }
          return cur;
        });
      } catch (err) {
        setMasterSaveState('idle');
        setBannerMsg({
          kind: 'err',
          text: extractApiError(err, 'Failed to save Master Control settings.'),
        });
      }
    }, 420);
    return () => window.clearTimeout(timer);
  }, [batchId, localMasterDraft, setBatchCache]);

  const effectiveMasterSettings: EditSettings | undefined =
    localMasterDraft ?? batch?.shared_settings;

  const handleUpdateMaster = useCallback(
    (updater: (prev: EditSettings) => EditSettings) => {
      setLocalMasterDraft((prev) => {
        const base = prev ?? batch?.shared_settings;
        if (!base) return prev;
        return updater(base);
      });
      setMasterSaveState('idle');
    },
    [batch?.shared_settings]
  );

  const handleEnsureMasterSubtitlesEnabled = useCallback(() => {
    setLocalMasterDraft((prev) => {
      const base = prev ?? batch?.shared_settings;
      if (!base || base.subtitles.enabled) return prev;
      setMasterSaveState('idle');
      return {
        ...base,
        subtitles: { ...base.subtitles, enabled: true },
      };
    });
  }, [batch?.shared_settings]);

  const flushMasterDraft = async () => {
    if (!batchId || !localMasterDraft) return;
    setMasterSaveState('saving');
    const snapshot = localMasterDraft;
    const updated = await videoApi.updateBatch(batchId, {
      shared_settings: snapshot,
    });
    setLocalMasterDraft(null);
    setMasterSaveState('saved');
    setBatchCache(updated);
  };

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
        use_custom_settings: (entry.settings.overridden_tools?.length ?? 0) > 0,
        settings: entry.settings,
      });
      liveDraftsRef.current.set(rowId, {
        settings: entry.settings,
        dirty: false,
      });
      setBatchCache(updated);
    }
  };

  const handleResetAllRowsToMasterForTool = async () => {
    if (!batch || !effectiveMasterSettings) return;
    const toolKey = studioTabToToolKey(activeStudioTab);
    if (!toolKey) return;

    await flushMasterDraft();
    const affectedIds: string[] = [];
    let latestBatch = batch;

    for (const item of batch.items) {
      const liveEntry = liveDraftsRef.current.get(item.id);
      const rowSettings = liveEntry?.settings ?? item.settings;
      if (!isToolOverriddenOnSettings(rowSettings, toolKey)) continue;

      const remaining = removeOverriddenTool(
        rowSettings.overridden_tools,
        toolKey
      );
      const srcAsset = item.source_asset_id
        ? batch.videos.find((v) => v.id === item.source_asset_id)
        : batch.videos[0];
      const merged = mergeLiveMasterIntoRowSettings(
        effectiveMasterSettings,
        {
          ...rowSettings,
          overridden_tools: remaining,
        },
        {
          hasLogoAsset: Boolean(item.logo_asset_id || batch.logos[0]),
          hasOutroAsset: Boolean(item.outro_asset_id || batch.outros[0]),
          sourceWidth: srcAsset?.width,
          sourceHeight: srcAsset?.height,
        }
      );

      latestBatch = await videoApi.updateBatchItem(batch.id, item.id, {
        use_custom_settings: remaining.length > 0,
        settings: merged,
      });
      liveDraftsRef.current.set(item.id, {
        settings: merged,
        dirty: false,
      });
      affectedIds.push(item.id);
    }

    if (affectedIds.length > 0) {
      bumpSyncGenForRows(affectedIds);
      setBatchCache(latestBatch);
      setBannerMsg({
        kind: 'ok',
        text: `Synced ${affectedIds.length} video(s) back to Master Control.`,
      });
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
      await flushMasterDraft();
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
        await flushMasterDraft();
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
      await flushMasterDraft();
      await flushDirtyRowDrafts();
      const uploaded = await videoApi.uploadBatchPoolAsset(
        batchId,
        'logo',
        singleFile
      );
      await applyNewSingleLogoAcrossBatch(uploaded);
      setBannerMsg({
        kind: 'ok',
        text: `Logo "${singleFile.name}" linked across campaign.`,
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
        await flushMasterDraft();
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
      await flushMasterDraft();
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
      await flushMasterDraft();
      await flushDirtyRowDrafts();
      const uploaded = await videoApi.uploadBatchPoolAsset(
        batchId,
        'outro',
        singleFile
      );
      await applyNewSingleOutroAcrossBatch(uploaded);
      setBannerMsg({
        kind: 'ok',
        text: `Outro "${singleFile.name}" linked across campaign.`,
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
        await flushMasterDraft();
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
      await flushMasterDraft();
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
      if (focusedSubsetIds) {
        const remainingFocused = focusedSubsetIds.filter((id) => id !== rowId);
        setFocusedSubsetIds(
          remainingFocused.length > 0 ? remainingFocused : null
        );
      }
      setBatchCache(updated);
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to remove video row.'),
      });
    }
  };

  // Step-by-step Save & Next / Back navigation
  const handleSaveAndStepTo = async (targetTab: StudioNavbarTab) => {
    setSteppingTab(true);
    setBannerMsg(null);
    try {
      await flushMasterDraft();
      await flushDirtyRowDrafts();
      setActiveStudioTab(targetTab);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Could not save current edits before stepping.'),
      });
    } finally {
      setSteppingTab(false);
    }
  };

  // Output Tab — Queue & Export ALL videos sequentially 1-by-1
  const handleExportAllQueue = async () => {
    if (!batch || batch.items.length === 0) return;
    setRunningBatch(true);
    setBannerMsg(null);
    try {
      await flushMasterDraft();
      await flushDirtyRowDrafts();

      const allIds = batch.items.map((i) => i.id);
      if (batch.items.some((i) => !i.selected)) {
        const nextSpecs = batch.items.map((item) => ({
          ...existingItemToSpec(item),
          selected: true,
        }));
        const selectedAllBatch = await videoApi.setBatchItems(
          batch.id,
          nextSpecs
        );
        setBatchCache(selectedAllBatch);
      }

      const resp = await videoApi.runBatchAutomation(batch.id, allIds, true);
      setBatchCache(resp.batch);
      setFocusedSubsetIds(null);
      setBannerMsg({
        kind: 'ok',
        text: `Queued all ${resp.launched_count} video(s) for sequential 1-by-1 rendering.`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to start sequential export queue.'),
      });
    } finally {
      setRunningBatch(false);
    }
  };

  // Output Tab — Queue & Export ONLY selected subset sequentially 1-by-1
  const handleExportSelectedQueue = async (itemIds: string[]) => {
    if (!batch || itemIds.length === 0) return;
    setRunningBatch(true);
    setBannerMsg(null);
    try {
      await flushMasterDraft();
      await flushDirtyRowDrafts(itemIds);

      const resp = await videoApi.runBatchAutomation(batch.id, itemIds, true);
      setBatchCache(resp.batch);
      setBannerMsg({
        kind: 'ok',
        text: `Queued ${resp.launched_count} selected video(s) for sequential rendering.`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Failed to queue selected video export.'),
      });
    } finally {
      setRunningBatch(false);
    }
  };

  // Output Tab — Isolate specific video(s) to edit again without touching others
  const handleEditVideosSubset = async (itemIds: string[]) => {
    if (!batch || itemIds.length === 0) return;
    setBannerMsg(null);
    try {
      const targetSet = new Set(itemIds);
      const nextSpecs = batch.items.map((item) => ({
        ...existingItemToSpec(item),
        selected: targetSet.has(item.id),
      }));
      const updated = await videoApi.setBatchItems(batch.id, nextSpecs);
      setBatchCache(updated);
      setFocusedSubsetIds(itemIds);
      setCollapsedRows((prev) => {
        const next = { ...prev };
        for (const id of itemIds) {
          next[id] = false;
        }
        return next;
      });
      setActiveStudioTab('trim');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setBannerMsg({
        kind: 'err',
        text: extractApiError(err, 'Could not isolate selected video(s) for editing.'),
      });
    }
  };

  const handleDownloadOrSaveReady = async () => {
    if (!batch) return;
    if (batch.output_dir) {
      setExportingFolder(true);
      setBannerMsg(null);
      try {
        const ids =
          selectedQueueItems.length > 0 &&
          selectedQueueItems.length < batch.items.length
            ? selectedQueueItems.map((i) => i.id)
            : undefined;
        const resp = await videoApi.exportBatchOutputsToFolder(
          batch.id,
          batch.output_dir,
          ids
        );
        setBannerMsg({
          kind: 'ok',
          text: `Saved ${resp.exported_count} MP4(s) to ${resp.dest_dir}`,
        });
      } catch (err) {
        setBannerMsg({
          kind: 'err',
          text: extractApiError(err, 'Failed to save MP4s to output folder.'),
        });
      } finally {
        setExportingFolder(false);
      }
      return;
    }

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
      const updated = await videoApi.updateBatch(batch.id, {
        output_dir: resp.dest_dir,
      });
      setBatchCache(updated);
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

  const handlePickOutputFolderDesktop = async () => {
    if (!batch) return;
    const dir = await videoApi.pickLocalFolderPath('Choose Export Folder');
    if (!dir) return;
    setExportDestDir(dir);
    const updated = await videoApi.updateBatch(batch.id, { output_dir: dir });
    setBatchCache(updated);
  };

  const handleClearOutputFolder = async () => {
    if (!batch) return;
    setExportDestDir('');
    const updated = await videoApi.updateBatch(batch.id, {
      clear_output_dir: true,
    });
    setBatchCache(updated);
  };

  if (isLoading || !batch || !effectiveMasterSettings) {
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

  const currentStepIndex = Math.max(
    0,
    STUDIO_STEP_SEQUENCE.findIndex((s) => s.id === activeStudioTab)
  );
  const prevStep =
    currentStepIndex > 0 ? STUDIO_STEP_SEQUENCE[currentStepIndex - 1] : null;
  const nextStep =
    currentStepIndex < STUDIO_STEP_SEQUENCE.length - 1
      ? STUDIO_STEP_SEQUENCE[currentStepIndex + 1]
      : null;

  const focusedSet = focusedSubsetIds ? new Set(focusedSubsetIds) : null;
  const visibleRowsWithIndex = batch.items
    .map((row, idx) => ({ row, rowNumber: idx + 1 }))
    .filter(({ row }) => (focusedSet ? focusedSet.has(row.id) : true));

  const allVisibleCollapsed =
    visibleRowsWithIndex.length > 0 &&
    visibleRowsWithIndex.every(({ row }) => Boolean(collapsedRows[row.id]));

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

      {/* Sleek Compact Media Dock (60-30-10) */}
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
                detail="Drop or pick PNG / WebP / JPG watermark applied by default (26% at 89%, 68%)"
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
                  <span className="hidden sm:inline">Folder</span>
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

      {/* Empty Queue State */}
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
      ) : activeStudioTab === 'export' ? (
        /* ==================== DEDICATED OUTPUT TAB ==================== */
        <div className="space-y-4">
          {prevStep && (
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void handleSaveAndStepTo(prevStep.id)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to {prevStep.label}
              </Button>
              {focusedSubsetIds && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setFocusedSubsetIds(null)}
                  className="text-muted-foreground"
                >
                  Clear Subset Filter
                </Button>
              )}
            </div>
          )}

          <BatchOutputColumn
            batch={batch}
            masterSettings={effectiveMasterSettings}
            runningBatch={runningBatch}
            exportingFolder={exportingFolder}
            isDesktop={isTauriDesktop()}
            onUpdateMaster={handleUpdateMaster}
            onBatchUpdated={setBatchCache}
            onExportAllQueue={handleExportAllQueue}
            onExportSelectedQueue={handleExportSelectedQueue}
            onEditVideosSubset={handleEditVideosSubset}
            onPickOutputFolder={handlePickOutputFolderDesktop}
            onClearOutputFolder={handleClearOutputFolder}
            onDownloadOrSaveReady={handleDownloadOrSaveReady}
          />
        </div>
      ) : (
        /* ==================== EDITING TABS (STEP-BY-STEP + MASTER CONTROL) ==================== */
        <div className="space-y-4">
          {/* Sticky Row Jump + Save & Next Bar (Zero Export/Re-export Clutter) */}
          <div className="sticky top-14 z-30 rounded-xl bg-background/92 backdrop-blur-xl border border-border p-2.5 shadow-sm space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              {/* Row Jump Chips */}
              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full">
                {visibleRowsWithIndex.map(({ row, rowNumber }) => {
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
                      : 'bg-card hover:bg-muted text-foreground border-border';

                  return (
                    <HintTooltip
                      key={row.id}
                      label={`Jump to Video #${rowNumber}: ${row.title}`}
                      side="bottom"
                    >
                      <button
                        type="button"
                        onClick={() => scrollToRow(row.id)}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-mono font-semibold transition-all shrink-0 ${chipClass}`}
                      >
                        <span>#{rowNumber}</span>
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

              {/* Step Navigation Controls (Back + Save & Next) */}
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                <span className="text-[11px] font-mono text-muted-foreground hidden md:inline">
                  Step {currentStepIndex + 1}/{STUDIO_STEP_SEQUENCE.length}
                </span>

                {prevStep && (
                  <HintTooltip
                    label={`Back to ${prevStep.label}`}
                    detail="Saves edits and returns to the previous step"
                    side="bottom"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={steppingTab}
                      onClick={() => void handleSaveAndStepTo(prevStep.id)}
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{prevStep.label}</span>
                    </Button>
                  </HintTooltip>
                )}

                {focusedSubsetIds && (
                  <HintTooltip
                    label="Finish Editing Selected Video(s)"
                    detail="Saves separate edits and returns directly to Output so you can Export Selected"
                    side="bottom"
                  >
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={steppingTab}
                      onClick={() => void handleSaveAndStepTo('export')}
                    >
                      <span>
                        Output ({focusedSubsetIds.length} Selected)
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </HintTooltip>
                )}

                {nextStep && (
                  <HintTooltip
                    label={`Save & Continue to ${nextStep.label}`}
                    detail="Automatically saves Master Control & per-video edits and opens the next tool"
                    side="bottom"
                  >
                    <Button
                      type="button"
                      size="sm"
                      disabled={steppingTab}
                      onClick={() => void handleSaveAndStepTo(nextStep.id)}
                    >
                      {steppingTab ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      <span>Save & Next: {nextStep.label}</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </HintTooltip>
                )}
              </div>
            </div>

            {isQueueActive && (
              <div className="rounded-lg bg-muted/60 border border-border px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2 font-medium">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  {currentlyRenderingItem ? (
                    <span>
                      Rendering #
                      {batch.items.findIndex(
                        (i) => i.id === currentlyRenderingItem.id
                      ) + 1}{' '}
                      · {currentlyRenderingItem.title} (
                      {Math.round((currentlyRenderingItem.progress ?? 0) * 100)}
                      %)
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

          {/* Isolated Subset Editing Banner OR Master Control Panel */}
          {focusedSubsetIds ? (
            <div className="rounded-2xl border border-primary/40 bg-primary/8 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs">
                <Filter className="h-4 w-4 text-primary shrink-0" />
                <div>
                  <span className="font-semibold text-foreground">
                    Editing Selected Video
                    {focusedSubsetIds.length === 1 ? '' : 's'} Alone (
                    {visibleRowsWithIndex
                      .map((v) => `#${v.rowNumber}`)
                      .join(', ')}
                    )
                  </span>
                  <span className="text-muted-foreground ml-2">
                    Changes made below apply separately to{' '}
                    {focusedSubsetIds.length === 1
                      ? 'this video'
                      : 'these videos'}{' '}
                    without affecting other videos.
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setFocusedSubsetIds(null)}
                >
                  Show All Videos ({batch.items.length})
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => void handleSaveAndStepTo('export')}
                >
                  Go to Output & Export ({focusedSubsetIds.length})
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ) : (
            <BatchMasterControlPanel
              batch={batch}
              activeTab={activeStudioTab}
              masterSettings={effectiveMasterSettings}
              saveState={masterSaveState}
              allowedFonts={allowedFonts}
              supportedLanguages={supportedLanguages}
              singleLogoAsset={singleLogoAsset}
              singleOutroAsset={singleOutroAsset}
              uploadingSingleSlot={
                uploadingPoolKind === 'logo' || uploadingPoolKind === 'outro'
                  ? uploadingPoolKind
                  : null
              }
              onUpdateMaster={handleUpdateMaster}
              onResetAllRowsToMasterForTool={handleResetAllRowsToMasterForTool}
              onBatchUpdated={setBatchCache}
              onUploadGlobalSlot={(kind, files) => {
                if (kind === 'logo') {
                  void handleSingleLogoFiles(files);
                } else {
                  void handleSingleOutroFiles(files);
                }
              }}
              onDesktopPickGlobalSlot={(kind) => {
                if (kind === 'logo') {
                  void handleTriggerSingleLogoUpload();
                } else {
                  void handleTriggerSingleOutroUpload();
                }
              }}
              onRemoveGlobalSlot={(kind) => {
                if (kind === 'logo') {
                  void handleRemoveSingleLogo();
                } else {
                  void handleRemoveSingleOutro();
                }
              }}
              isDesktop={isTauriDesktop()}
            />
          )}

          {/* Per-Video Workbench Section Header */}
          {activeStudioTab !== 'trim' && !focusedSubsetIds && (
            <div className="flex items-center justify-between px-1 pt-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">
                  Individual Videos ({visibleRowsWithIndex.length})
                </span>
                <span>·</span>
                <span>
                  Inherits Master Control automatically — edit any video below
                  to customize it separately
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  const shouldCollapse = !allVisibleCollapsed;
                  setCollapsedRows((prev) => {
                    const next = { ...prev };
                    for (const { row } of visibleRowsWithIndex) {
                      next[row.id] = shouldCollapse;
                    }
                    return next;
                  });
                }}
              >
                {allVisibleCollapsed ? (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    Expand All
                  </>
                ) : (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    Collapse All
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Stacked Per-Video Workbenches */}
          <div className="space-y-4">
            {visibleRowsWithIndex.map(({ row, rowNumber }) => {
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
                  rowNumber={rowNumber}
                  activeTab={activeStudioTab}
                  masterSettings={effectiveMasterSettings}
                  queueWaitingPosition={queueIndex}
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
                  onEnsureMasterSubtitlesEnabled={
                    handleEnsureMasterSubtitlesEnabled
                  }
                  getLiveSettingsForRow={getLiveSettingsForRow}
                  onLiveDraftChange={handleLiveDraftChange}
                  onDeleteRow={handleDeleteRow}
                  onBatchUpdated={setBatchCache}
                />
              );
            })}
          </div>

          {/* Bottom Step Footer so user doesn't need to scroll back up */}
          <div className="rounded-xl bg-card border border-border px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              {prevStep && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={steppingTab}
                  onClick={() => void handleSaveAndStepTo(prevStep.id)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back: {prevStep.label}
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {focusedSubsetIds && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={steppingTab}
                  onClick={() => void handleSaveAndStepTo('export')}
                >
                  Save & Go to Output ({focusedSubsetIds.length})
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
              {nextStep && (
                <Button
                  type="button"
                  size="sm"
                  disabled={steppingTab}
                  onClick={() => void handleSaveAndStepTo(nextStep.id)}
                >
                  {steppingTab ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Save & Next: {nextStep.label}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
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
