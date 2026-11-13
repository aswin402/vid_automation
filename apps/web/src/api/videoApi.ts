import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import api from './axios';
import type {
  Asset,
  AutoFrameResponse,
  BackupInfo,
  BatchDetail,
  BatchExportFolderResponse,
  BatchFolderImportResponse,
  BatchItemSpec,
  BatchItemUpdatePayload,
  BatchRunResponse,
  BatchSummary,
  BatchUpdatePayload,
  CapabilitiesResponse,
  CreateBackupPayload,
  EditSettings,
  FolderImportItem,
  FolderScanResponse,
  ProcessingJob,
  ProjectDetail,
  RestoreBackupResponse,
  SubtitleCue,
  SubtitleVersionResponse,
  SystemVersionResponse,
  UpdateCheckResponse,
  UpdateProgressState,
} from '@/types/video';

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function extractApiError(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message && !obj.response) {
      return obj.message;
    }
    const resp = obj.response as Record<string, unknown> | undefined;
    const data = resp?.data as Record<string, unknown> | undefined;
    if (typeof data?.message === 'string') {
      return data.message;
    }
    if (typeof data?.detail === 'string') {
      return data.detail;
    }
  }
  return fallback;
}

export const videoApi = {
  async getCapabilities(): Promise<CapabilitiesResponse> {
    if (isTauriDesktop()) {
      return invoke<CapabilitiesResponse>('get_capabilities');
    }
    const { data } = await api.get<CapabilitiesResponse>('/api/v1/config/capabilities');
    return data;
  },

  async listProjects(): Promise<ProjectDetail[]> {
    if (isTauriDesktop()) {
      return invoke<ProjectDetail[]>('list_projects');
    }
    const { data } = await api.get<ProjectDetail[]>('/api/v1/projects');
    return data;
  },

  async createProject(name: string): Promise<ProjectDetail> {
    if (isTauriDesktop()) {
      return invoke<ProjectDetail>('create_project', { name });
    }
    const { data } = await api.post<ProjectDetail>('/api/v1/projects', { name });
    return data;
  },

  async createDemoProject(): Promise<ProjectDetail> {
    if (isTauriDesktop()) {
      return invoke<ProjectDetail>('create_demo_project');
    }
    const { data } = await api.post<ProjectDetail>('/api/v1/projects/demo');
    return data;
  },

  async getProject(projectId: string): Promise<ProjectDetail> {
    if (isTauriDesktop()) {
      return invoke<ProjectDetail>('get_project', { projectId });
    }
    const { data } = await api.get<ProjectDetail>(`/api/v1/projects/${projectId}`);
    return data;
  },

  async updateProject(
    projectId: string,
    payload: { name?: string; settings?: EditSettings }
  ): Promise<ProjectDetail> {
    if (isTauriDesktop()) {
      return invoke<ProjectDetail>('update_project', {
        projectId,
        name: payload.name ?? null,
        settings: payload.settings ?? null,
      });
    }
    const { data } = await api.patch<ProjectDetail>(`/api/v1/projects/${projectId}`, payload);
    return data;
  },

  async deleteProject(projectId: string): Promise<void> {
    if (isTauriDesktop()) {
      await invoke<void>('delete_project', { projectId });
      return;
    }
    await api.delete(`/api/v1/projects/${projectId}`);
  },

  /**
   * Native Desktop Zero-Copy File Picker (Tauri v2):
   * Opens the native OS file dialog and registers the chosen video/logo in-place
   * without copying multi-GB video files into app storage!
   */
  async pickAndImportLocalAsset(
    projectId: string,
    kind: 'source' | 'logo' | 'outro'
  ): Promise<Asset | null> {
    if (!isTauriDesktop()) return null;

    const filters =
      kind === 'logo'
        ? [{ name: 'Brand Logo Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        : [{ name: 'Video Files', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] }];

    const selected = await open({
      multiple: false,
      directory: false,
      title:
        kind === 'source'
          ? 'Select Source Video'
          : kind === 'logo'
          ? 'Select Transparent Brand Logo'
          : 'Select Brand Outro Clip',
      filters,
    });

    if (!selected || typeof selected !== 'string') {
      return null;
    }

    return invoke<Asset>('import_local_asset', {
      projectId,
      kind,
      localPath: selected,
    });
  },

  async uploadAssetWithSignedUrl(
    projectId: string,
    kind: 'source' | 'logo' | 'outro',
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<Asset> {
    if (isTauriDesktop()) {
      onProgress?.(20);
      // Tauri WebView files dropped from desktop sometimes expose native path; otherwise pass ArrayBuffer
      const maybePath = (file as File & { path?: string }).path;
      if (maybePath && typeof maybePath === 'string') {
        const imported = await invoke<Asset>('import_local_asset', {
          projectId,
          kind,
          localPath: maybePath,
        });
        onProgress?.(100);
        return imported;
      }

      const buf = await file.arrayBuffer();
      onProgress?.(60);
      const uploaded = await invoke<Asset>('upload_asset_bytes', {
        projectId,
        kind,
        filename: file.name,
        contentType: file.type || (kind === 'logo' ? 'image/png' : 'video/mp4'),
        bytes: Array.from(new Uint8Array(buf)),
      });
      onProgress?.(100);
      return uploaded;
    }

    // Browser HTTP Mode:
    // Step 1: Request signed upload URL
    const { data: urlResp } = await api.post<{
      asset_id: string;
      storage_key: string;
      upload_url: string;
      headers: Record<string, string>;
    }>(`/api/v1/projects/${projectId}/assets/upload-url`, {
      kind,
      filename: file.name,
      content_type: file.type || (kind === 'logo' ? 'image/png' : 'video/mp4'),
      size_bytes: file.size,
    });

    // Step 2: Upload binary directly to signed URL
    await api.put(urlResp.upload_url, file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
      onUploadProgress: (evt) => {
        if (onProgress && evt.total) {
          onProgress(Math.round((evt.loaded * 100) / evt.total));
        }
      },
    });

    // Step 3: Complete & run FFprobe verification
    const { data: completedAsset } = await api.post<Asset>(
      `/api/v1/projects/${projectId}/assets/complete`,
      { asset_id: urlResp.asset_id }
    );
    return completedAsset;
  },

  async deleteAsset(assetId: string): Promise<void> {
    if (isTauriDesktop()) {
      await invoke<void>('delete_asset', { assetId });
      return;
    }
    await api.delete(`/api/v1/assets/${assetId}`);
  },

  async getSignedDownloadUrl(assetId: string): Promise<{
    asset_id: string;
    filename: string;
    download_url: string;
    expires_in_seconds: number;
  }> {
    if (isTauriDesktop()) {
      return invoke('get_signed_download_url', { assetId });
    }
    const { data } = await api.post(`/api/v1/assets/${assetId}/download-url`);
    return data;
  },

  async downloadOutputAsset(assetId: string, defaultFilename = 'branded_video.mp4'): Promise<boolean> {
    if (isTauriDesktop()) {
      const destPath = await save({
        title: 'Save Exported MP4 Video',
        defaultPath: defaultFilename,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      if (!destPath) return false;
      await invoke<number>('save_asset_to_path', { assetId, destPath });
      return true;
    }

    const { download_url } = await this.getSignedDownloadUrl(assetId);
    window.open(download_url, '_blank', 'noopener,noreferrer');
    return true;
  },

  async downloadSubtitlesSrt(projectId: string, version: number): Promise<boolean> {
    if (isTauriDesktop()) {
      const destPath = await save({
        title: 'Export Subtitles (.SRT)',
        defaultPath: `subtitles_v${version}.srt`,
        filters: [{ name: 'SubRip Subtitles', extensions: ['srt'] }],
      });
      if (!destPath) return false;
      await invoke<number>('save_srt_to_path', { projectId, version, destPath });
      return true;
    }

    window.open(
      `/api/v1/projects/${projectId}/subtitle-versions/${version}/srt`,
      '_blank',
      'noopener,noreferrer'
    );
    return true;
  },

  async startTranscription(
    projectId: string,
    language: string,
    confirmOverwrite = false
  ): Promise<ProcessingJob> {
    if (isTauriDesktop()) {
      return invoke<ProcessingJob>('start_transcription', {
        projectId,
        language,
        confirmOverwrite,
      });
    }
    const { data } = await api.post<ProcessingJob>(
      `/api/v1/projects/${projectId}/transcriptions`,
      {
        language,
        confirm_overwrite: confirmOverwrite,
      }
    );
    return data;
  },

  async getSubtitleVersion(
    projectId: string,
    version = 0
  ): Promise<SubtitleVersionResponse> {
    if (isTauriDesktop()) {
      return invoke<SubtitleVersionResponse>('get_subtitle_version', {
        projectId,
        version,
      });
    }
    const { data } = await api.get<SubtitleVersionResponse>(
      `/api/v1/projects/${projectId}/subtitle-versions/${version}`
    );
    return data;
  },

  async saveSubtitleVersion(
    projectId: string,
    version: number,
    language: string,
    cues: SubtitleCue[]
  ): Promise<SubtitleVersionResponse> {
    if (isTauriDesktop()) {
      return invoke<SubtitleVersionResponse>('save_subtitle_version', {
        projectId,
        version,
        language,
        cues,
      });
    }
    const { data } = await api.put<SubtitleVersionResponse>(
      `/api/v1/projects/${projectId}/subtitle-versions/${version}`,
      { language, cues }
    );
    return data;
  },

  async startExport(
    projectId: string,
    subtitleVersion?: number | null
  ): Promise<ProcessingJob> {
    if (isTauriDesktop()) {
      return invoke<ProcessingJob>('start_export', {
        projectId,
        subtitleVersion: subtitleVersion ?? null,
        idempotencyKey: null,
      });
    }
    const { data } = await api.post<ProcessingJob>(
      `/api/v1/projects/${projectId}/exports`,
      {
        subtitle_version: subtitleVersion ?? null,
      }
    );
    return data;
  },

  async autoFrameProject(
    projectId: string,
    payload: {
      aspectRatio: string;
      dynamicTracking: boolean;
      targetZoom?: number | null;
    }
  ): Promise<AutoFrameResponse> {
    if (isTauriDesktop()) {
      return invoke<AutoFrameResponse>('auto_frame_project', {
        projectId,
        aspectRatio: payload.aspectRatio,
        dynamicTracking: payload.dynamicTracking,
        targetZoom: payload.targetZoom ?? null,
      });
    }
    const { data } = await api.post<AutoFrameResponse>(
      `/api/v1/projects/${projectId}/auto-frame`,
      {
        aspect_ratio: payload.aspectRatio,
        dynamic_tracking: payload.dynamicTracking,
        target_zoom: payload.targetZoom ?? null,
      }
    );
    return data;
  },

  async getJob(jobId: string): Promise<ProcessingJob> {
    if (isTauriDesktop()) {
      return invoke<ProcessingJob>('get_job', { jobId });
    }
    const { data } = await api.get<ProcessingJob>(`/api/v1/jobs/${jobId}`);
    return data;
  },

  async cancelJob(jobId: string): Promise<ProcessingJob> {
    if (isTauriDesktop()) {
      return invoke<ProcessingJob>('cancel_job', { jobId });
    }
    const { data } = await api.post<ProcessingJob>(`/api/v1/jobs/${jobId}/cancel`);
    return data;
  },

  async retryJob(jobId: string): Promise<ProcessingJob> {
    if (isTauriDesktop()) {
      return invoke<ProcessingJob>('retry_job', { jobId });
    }
    const { data } = await api.post<ProcessingJob>(`/api/v1/jobs/${jobId}/retry`);
    return data;
  },

  // ==================== Multi-Asset Batch Automation APIs ====================

  async listBatches(): Promise<BatchSummary[]> {
    if (isTauriDesktop()) {
      return invoke<BatchSummary[]>('list_batches');
    }
    const { data } = await api.get<BatchSummary[]>('/api/v1/batches');
    return data;
  },

  async createBatch(name: string): Promise<BatchDetail> {
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('create_batch', { name });
    }
    const { data } = await api.post<BatchDetail>('/api/v1/batches', { name });
    return data;
  },

  async createDemoBatch(): Promise<BatchDetail> {
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('create_demo_batch');
    }
    const { data } = await api.post<BatchDetail>('/api/v1/batches/demo');
    return data;
  },

  async getBatch(batchId: string): Promise<BatchDetail> {
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('get_batch', { batchId });
    }
    const { data } = await api.get<BatchDetail>(`/api/v1/batches/${batchId}`);
    return data;
  },

  async updateBatch(batchId: string, payload: BatchUpdatePayload): Promise<BatchDetail> {
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('update_batch', {
        batchId,
        req: {
          name: payload.name,
          mapping_mode: payload.mapping_mode,
          output_dir: payload.output_dir,
          clear_output_dir: payload.clear_output_dir ?? false,
          shared_settings: payload.shared_settings,
          apply_shared_to_selected: payload.apply_shared_to_selected ?? false,
        },
      });
    }
    const { data } = await api.patch<BatchDetail>(`/api/v1/batches/${batchId}`, payload);
    return data;
  },

  async deleteBatch(batchId: string): Promise<void> {
    if (isTauriDesktop()) {
      await invoke<void>('delete_batch', { batchId });
      return;
    }
    await api.delete(`/api/v1/batches/${batchId}`);
  },

  async pickLocalFolderPath(title = 'Select Media Folder'): Promise<string | null> {
    if (!isTauriDesktop()) return null;
    const selected = await open({
      multiple: false,
      directory: true,
      title,
    });
    if (!selected || typeof selected !== 'string') return null;
    return selected;
  },

  async pickAndImportBatchPoolAssets(
    batchId: string,
    kind: 'source' | 'logo' | 'outro'
  ): Promise<Asset[]> {
    if (!isTauriDesktop()) return [];
    const filters =
      kind === 'logo'
        ? [{ name: 'Brand Logo Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        : [{ name: 'Video Files', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] }];

    const selected = await open({
      multiple: kind === 'source',
      directory: false,
      title:
        kind === 'source'
          ? 'Select Source Videos'
          : kind === 'logo'
          ? 'Select Single Brand Logo'
          : 'Select Single Outro Clip',
      filters,
    });

    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected];
    const imported: Asset[] = [];
    for (const localPath of paths) {
      if (typeof localPath === 'string' && localPath.trim()) {
        const asset = await invoke<Asset>('import_local_asset_to_batch_pool', {
          batchId,
          kind,
          localPath,
        });
        imported.push(asset);
      }
    }
    return imported;
  },

  async uploadBatchPoolAsset(
    batchId: string,
    kind: 'source' | 'logo' | 'outro',
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<Asset> {
    if (isTauriDesktop()) {
      onProgress?.(20);
      const maybePath = (file as File & { path?: string }).path;
      if (maybePath && typeof maybePath === 'string') {
        const imported = await invoke<Asset>('import_local_asset_to_batch_pool', {
          batchId,
          kind,
          localPath: maybePath,
        });
        onProgress?.(100);
        return imported;
      }

      const buf = await file.arrayBuffer();
      onProgress?.(60);
      const uploaded = await invoke<Asset>('upload_batch_pool_asset_bytes', {
        batchId,
        kind,
        filename: file.name,
        contentType: file.type || (kind === 'logo' ? 'image/png' : 'video/mp4'),
        bytes: Array.from(new Uint8Array(buf)),
      });
      onProgress?.(100);
      return uploaded;
    }

    const { data: urlResp } = await api.post<{
      asset_id: string;
      storage_key: string;
      upload_url: string;
      headers: Record<string, string>;
    }>(`/api/v1/batches/${batchId}/assets/upload-url`, {
      kind,
      filename: file.name,
      content_type: file.type || (kind === 'logo' ? 'image/png' : 'video/mp4'),
      size_bytes: file.size,
    });

    await api.put(urlResp.upload_url, file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
      onUploadProgress: (evt) => {
        if (onProgress && evt.total) {
          onProgress(Math.round((evt.loaded * 100) / evt.total));
        }
      },
    });

    const { data: completedAsset } = await api.post<Asset>(
      `/api/v1/batches/${batchId}/assets/complete`,
      { asset_id: urlResp.asset_id }
    );
    return completedAsset;
  },

  async deleteBatchPoolAsset(batchId: string, assetId: string): Promise<BatchDetail> {
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('delete_batch_pool_asset', { batchId, assetId });
    }
    const { data } = await api.delete<BatchDetail>(
      `/api/v1/batches/${batchId}/assets/${assetId}`
    );
    return data;
  },

  async scanLocalFolder(
    folderPath: string,
    recursive = true,
    defaultVideoRole?: 'source' | 'outro'
  ): Promise<FolderScanResponse> {
    const req = {
      folder_path: folderPath,
      recursive,
      default_video_role: defaultVideoRole ?? null,
    };
    if (isTauriDesktop()) {
      return invoke<FolderScanResponse>('scan_local_folder', { req });
    }
    const { data } = await api.post<FolderScanResponse>('/api/v1/fs/scan-folder', req);
    return data;
  },

  async importFolderItemsToBatch(
    batchId: string,
    items: FolderImportItem[]
  ): Promise<BatchFolderImportResponse> {
    const req = { items };
    if (isTauriDesktop()) {
      return invoke<BatchFolderImportResponse>('import_folder_items_to_batch', {
        batchId,
        req,
      });
    }
    const { data } = await api.post<BatchFolderImportResponse>(
      `/api/v1/batches/${batchId}/import-folder`,
      req
    );
    return data;
  },

  async setBatchItems(
    batchId: string,
    items: BatchItemSpec[],
    mappingMode?: string
  ): Promise<BatchDetail> {
    const req = {
      mapping_mode: mappingMode ?? null,
      items,
    };
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('set_batch_items', { batchId, req });
    }
    const { data } = await api.put<BatchDetail>(`/api/v1/batches/${batchId}/items`, req);
    return data;
  },

  async updateBatchItem(
    batchId: string,
    itemId: string,
    payload: BatchItemUpdatePayload
  ): Promise<BatchDetail> {
    const req = {
      ...payload,
      clear_logo: payload.clear_logo ?? false,
      clear_outro: payload.clear_outro ?? false,
    };
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('update_batch_item', { batchId, itemId, req });
    }
    const { data } = await api.patch<BatchDetail>(
      `/api/v1/batches/${batchId}/items/${itemId}`,
      req
    );
    return data;
  },

  async applySettingsToBatchItems(
    batchId: string,
    itemIds: string[],
    settings: EditSettings,
    updateShared = false
  ): Promise<BatchDetail> {
    const req = {
      item_ids: itemIds,
      settings,
      update_shared: updateShared,
    };
    if (isTauriDesktop()) {
      return invoke<BatchDetail>('apply_settings_to_batch_items', { batchId, req });
    }
    const { data } = await api.post<BatchDetail>(
      `/api/v1/batches/${batchId}/apply-settings`,
      req
    );
    return data;
  },

  async runBatchAutomation(
    batchId: string,
    itemIds?: string[],
    forceReexport = false
  ): Promise<BatchRunResponse> {
    const req = {
      item_ids: itemIds ?? null,
      force_reexport: forceReexport,
    };
    if (isTauriDesktop()) {
      return invoke<BatchRunResponse>('run_batch_automation', { batchId, req });
    }
    const { data } = await api.post<BatchRunResponse>(
      `/api/v1/batches/${batchId}/run`,
      req
    );
    return data;
  },

  async exportBatchOutputsToFolder(
    batchId: string,
    destDir: string,
    itemIds?: string[]
  ): Promise<BatchExportFolderResponse> {
    const req = {
      dest_dir: destDir,
      item_ids: itemIds ?? null,
    };
    if (isTauriDesktop()) {
      return invoke<BatchExportFolderResponse>('export_batch_outputs_to_folder', {
        batchId,
        req,
      });
    }
    const { data } = await api.post<BatchExportFolderResponse>(
      `/api/v1/batches/${batchId}/export-folder`,
      req
    );
    return data;
  },

  // ==================== App Auto-Updater & Data Backup APIs ====================

  async getSystemVersion(): Promise<SystemVersionResponse> {
    if (isTauriDesktop()) {
      return invoke<SystemVersionResponse>('get_system_version');
    }
    const { data } = await api.get<SystemVersionResponse>('/api/v1/system/version');
    return data;
  },

  async checkForUpdates(): Promise<UpdateCheckResponse> {
    if (isTauriDesktop()) {
      return invoke<UpdateCheckResponse>('check_for_updates');
    }
    const { data } = await api.get<UpdateCheckResponse>('/api/v1/system/update-check');
    return data;
  },

  async startAppUpdate(): Promise<UpdateProgressState> {
    if (isTauriDesktop()) {
      return invoke<UpdateProgressState>('start_app_update');
    }
    const { data } = await api.post<UpdateProgressState>('/api/v1/system/update');
    return data;
  },

  async getUpdateStatus(): Promise<UpdateProgressState> {
    if (isTauriDesktop()) {
      return invoke<UpdateProgressState>('get_update_status');
    }
    const { data } = await api.get<UpdateProgressState>('/api/v1/system/update-status');
    return data;
  },

  async applyUpdateAndRestart(): Promise<void> {
    if (isTauriDesktop()) {
      await invoke<void>('apply_update_and_restart');
      return;
    }
    await api.post('/api/v1/system/restart');
    window.location.reload();
  },

  async listBackups(): Promise<BackupInfo[]> {
    if (isTauriDesktop()) {
      return invoke<BackupInfo[]>('list_backups');
    }
    const { data } = await api.get<BackupInfo[]>('/api/v1/system/backups');
    return data;
  },

  async createBackup(payload: CreateBackupPayload = {}): Promise<BackupInfo> {
    const req = {
      label: payload.label ?? null,
      include_storage: payload.include_storage ?? true,
    };
    if (isTauriDesktop()) {
      return invoke<BackupInfo>('create_backup', { req });
    }
    const { data } = await api.post<BackupInfo>('/api/v1/system/backups', req);
    return data;
  },

  async restoreBackup(backupId: string): Promise<RestoreBackupResponse> {
    if (isTauriDesktop()) {
      return invoke<RestoreBackupResponse>('restore_backup', { backupId });
    }
    const { data } = await api.post<RestoreBackupResponse>(
      `/api/v1/system/backups/${encodeURIComponent(backupId)}/restore`
    );
    return data;
  },

  async deleteBackup(backupId: string): Promise<void> {
    if (isTauriDesktop()) {
      await invoke<void>('delete_backup', { backupId });
      return;
    }
    await api.delete(`/api/v1/system/backups/${encodeURIComponent(backupId)}`);
  },
};
