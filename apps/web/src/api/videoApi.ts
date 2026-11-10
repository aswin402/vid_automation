import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import api from './axios';
import type {
  Asset,
  CapabilitiesResponse,
  EditSettings,
  ProcessingJob,
  ProjectDetail,
  SubtitleCue,
  SubtitleVersionResponse,
} from '@/types/video';

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function extractApiError(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const anyErr = err as Record<string, any>;
    if (typeof anyErr.message === 'string' && anyErr.message && !anyErr.response) {
      return anyErr.message;
    }
    if (typeof anyErr.response?.data?.message === 'string') {
      return anyErr.response.data.message;
    }
    if (typeof anyErr.response?.data?.detail === 'string') {
      return anyErr.response.data.detail;
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
};
