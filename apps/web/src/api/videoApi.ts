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

export const videoApi = {
  async getCapabilities(): Promise<CapabilitiesResponse> {
    const { data } = await api.get<CapabilitiesResponse>('/api/v1/config/capabilities');
    return data;
  },

  async listProjects(): Promise<ProjectDetail[]> {
    const { data } = await api.get<ProjectDetail[]>('/api/v1/projects');
    return data;
  },

  async createProject(name: string): Promise<ProjectDetail> {
    const { data } = await api.post<ProjectDetail>('/api/v1/projects', { name });
    return data;
  },

  async createDemoProject(): Promise<ProjectDetail> {
    const { data } = await api.post<ProjectDetail>('/api/v1/projects/demo');
    return data;
  },

  async getProject(projectId: string): Promise<ProjectDetail> {
    const { data } = await api.get<ProjectDetail>(`/api/v1/projects/${projectId}`);
    return data;
  },

  async updateProject(
    projectId: string,
    payload: { name?: string; settings?: EditSettings }
  ): Promise<ProjectDetail> {
    const { data } = await api.patch<ProjectDetail>(`/api/v1/projects/${projectId}`, payload);
    return data;
  },

  async deleteProject(projectId: string): Promise<void> {
    await api.delete(`/api/v1/projects/${projectId}`);
  },

  async uploadAssetWithSignedUrl(
    projectId: string,
    kind: 'source' | 'logo' | 'outro',
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<Asset> {
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
    await api.delete(`/api/v1/assets/${assetId}`);
  },

  async getSignedDownloadUrl(assetId: string): Promise<{
    asset_id: string;
    filename: string;
    download_url: string;
    expires_in_seconds: number;
  }> {
    const { data } = await api.post(`/api/v1/assets/${assetId}/download-url`);
    return data;
  },

  async startTranscription(
    projectId: string,
    language: string,
    confirmOverwrite = false
  ): Promise<ProcessingJob> {
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
    const { data } = await api.post<ProcessingJob>(
      `/api/v1/projects/${projectId}/exports`,
      {
        subtitle_version: subtitleVersion ?? null,
      }
    );
    return data;
  },

  async getJob(jobId: string): Promise<ProcessingJob> {
    const { data } = await api.get<ProcessingJob>(`/api/v1/jobs/${jobId}`);
    return data;
  },

  async cancelJob(jobId: string): Promise<ProcessingJob> {
    const { data } = await api.post<ProcessingJob>(`/api/v1/jobs/${jobId}/cancel`);
    return data;
  },

  async retryJob(jobId: string): Promise<ProcessingJob> {
    const { data } = await api.post<ProcessingJob>(`/api/v1/jobs/${jobId}/retry`);
    return data;
  },
};
