export type AnchorPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type WorkflowStepId =
  | 'upload'
  | 'trim'
  | 'crop'
  | 'color'
  | 'audio'
  | 'logo'
  | 'subtitles'
  | 'outro'
  | 'export';

export type AspectRatioPreset =
  | 'original'
  | '9:16'
  | '1:1'
  | '4:5'
  | '16:9'
  | '4:3'
  | '21:9'
  | 'custom';

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface CropKeyframe {
  time_ms: number;
  x: number;
  y: number;
}

export interface CropSettings {
  enabled: boolean;
  aspect_ratio: AspectRatioPreset | string;
  fit_mode: 'crop' | 'pad';
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
  auto_face_framing: boolean;
  dynamic_tracking: boolean;
  detected_face: FaceBox | null;
  keyframes: CropKeyframe[];
}

export interface AutoFrameResponse {
  face_detected: boolean;
  sampled_frames: number;
  faces_found_frames: number;
  primary_face: FaceBox | null;
  crop: CropSettings;
  message: string;
}

export interface TrimSettings {
  start_ms: number;
  end_ms: number | null;
}

export interface OutputSettings {
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string;
  audio_codec: string;
  preset: string;
  crf: number;
}

export interface ColorCorrectionSettings {
  enabled: boolean;
  preset: string;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  temperature: number;
  tint: number;
  sharpen: number;
  apply_to_outro: boolean;
}

export interface AudioEnhancementSettings {
  enabled: boolean;
  preset: string;
  noise_reduction: number;
  voice_clarity: number;
  highpass_hz: number;
  lowpass_hz: number;
  volume_db: number;
  normalize_loudness: boolean;
  apply_to_transcription: boolean;
}

export interface LogoSettings {
  enabled: boolean;
  asset_id: string | null;
  position: AnchorPosition;
  x_ratio: number | null;
  y_ratio: number | null;
  width_ratio: number;
  opacity: number;
  margin_ratio: number;
  apply_to_outro: boolean;
}

export interface SubtitleStyleSettings {
  position: AnchorPosition;
  x_ratio: number | null;
  y_ratio: number | null;
  font_family: string;
  font_size: number;
  text_color: string;
  background_enabled: boolean;
  background_color: string;
  background_opacity: number;
  outline_enabled: boolean;
  outline_color: string;
  outline_thickness: number;
  shadow_enabled: boolean;
  shadow_depth: number;
  alignment: 'left' | 'center' | 'right';
  margin_v_ratio: number;
  margin_h_ratio: number;
}

export interface SubtitlesSettings {
  enabled: boolean;
  language: string;
  style: SubtitleStyleSettings;
}

export interface OutroSettings {
  enabled: boolean;
  asset_id: string | null;
  normalization_mode: 'pad' | 'crop' | 'stretch';
}

export type OverridableToolId =
  | 'crop'
  | 'subtitles'
  | 'color'
  | 'audio'
  | 'logo'
  | 'outro'
  | 'output';

export interface EditSettings {
  schema_version: number;
  trim: TrimSettings;
  crop: CropSettings;
  output: OutputSettings;
  color_correction: ColorCorrectionSettings;
  audio_enhancement: AudioEnhancementSettings;
  logo: LogoSettings;
  subtitles: SubtitlesSettings;
  outro: OutroSettings;
  audio_policy: string;
  overridden_tools?: string[];
}

export interface Asset {
  id: string;
  project_id: string;
  kind: 'source' | 'logo' | 'outro' | 'trimmed' | 'main_render' | 'output' | 'transcript_audio';
  status: 'pending_upload' | 'ready' | 'failed';
  storage_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  frame_rate: string | null;
  pixel_format: string | null;
  has_audio: boolean;
  checksum: string | null;
  stream_url: string | null;
  created_at: string;
}

export interface ProcessingJob {
  id: string;
  project_id: string;
  kind: 'transcribe' | 'export' | 'batch_export';
  status:
    | 'queued'
    | 'validating'
    | 'probing'
    | 'trimming'
    | 'auto_framing'
    | 'transcribing'
    | 'rendering_main'
    | 'normalizing_outro'
    | 'joining_outro'
    | 'validating_output'
    | 'uploading_output'
    | 'completed'
    | 'failed'
    | 'canceled';
  stage: string;
  progress: number | null;
  error_code: string | null;
  error_message_safe: string | null;
  attempt_count: number;
  subtitle_version: number | null;
  output_asset_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type BatchMappingMode =
  | 'one_to_one'
  | 'many_videos_one_brand'
  | 'one_video_many_brands'
  | 'matrix'
  | 'manual';

export interface BatchSummary {
  id: string;
  name: string;
  mapping_mode: BatchMappingMode | string;
  output_dir: string | null;
  video_count: number;
  logo_count: number;
  outro_count: number;
  item_count: number;
  selected_count: number;
  completed_count: number;
  processing_count: number;
  created_at: string;
  updated_at: string;
}

export interface BatchItemDetail {
  id: string;
  batch_id: string;
  sort_order: number;
  selected: boolean;
  title: string;
  project_id: string;
  source_asset_id: string | null;
  logo_asset_id: string | null;
  outro_asset_id: string | null;
  use_custom_settings: boolean;
  settings: EditSettings;
  status: string;
  stage: string;
  progress: number | null;
  error_message_safe: string | null;
  active_job_id: string | null;
  subtitle_cue_count: number;
  output_asset: Asset | null;
  created_at: string;
  updated_at: string;
}

export interface BatchDetail {
  id: string;
  name: string;
  library_project_id: string;
  mapping_mode: BatchMappingMode | string;
  output_dir: string | null;
  shared_settings: EditSettings;
  videos: Asset[];
  logos: Asset[];
  outros: Asset[];
  items: BatchItemDetail[];
  created_at: string;
  updated_at: string;
}

export interface BatchItemSpec {
  id?: string;
  selected: boolean;
  title?: string;
  source_asset_id: string | null;
  logo_asset_id: string | null;
  outro_asset_id: string | null;
  use_custom_settings?: boolean;
}

export interface BatchUpdatePayload {
  name?: string;
  mapping_mode?: string;
  output_dir?: string;
  clear_output_dir?: boolean;
  shared_settings?: EditSettings;
  apply_shared_to_selected?: boolean;
}

export interface BatchItemUpdatePayload {
  title?: string;
  selected?: boolean;
  source_asset_id?: string;
  logo_asset_id?: string;
  clear_logo?: boolean;
  outro_asset_id?: string;
  clear_outro?: boolean;
  use_custom_settings?: boolean;
  settings?: EditSettings;
}

export interface ScannedFolderItem {
  path: string;
  relative_path: string;
  filename: string;
  size_bytes: number;
  suggested_kind: 'source' | 'logo' | 'outro';
}

export interface FolderScanResponse {
  folder_path: string;
  items: ScannedFolderItem[];
}

export interface FolderImportItem {
  path: string;
  kind: 'source' | 'logo' | 'outro';
}

export interface BatchFolderImportResponse {
  imported_count: number;
  skipped_errors: string[];
  batch: BatchDetail;
}

export interface BatchRunResponse {
  batch_id: string;
  launched_count: number;
  job_ids: string[];
  batch: BatchDetail;
}

export interface BatchExportFolderResponse {
  exported_count: number;
  dest_dir: string;
  files: string[];
}

export interface SubtitleCue {
  id?: string;
  sequence: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface SubtitleVersionResponse {
  project_id: string;
  version: number;
  language: string;
  timebase: string;
  duration_ms: number;
  cues: SubtitleCue[];
}

export interface ProjectDetail {
  id: string;
  owner_id: string;
  name: string;
  status: 'draft' | 'processing' | 'completed' | 'failed';
  settings_json: EditSettings;
  active_subtitle_version: number;
  detected_language: string | null;
  created_at: string;
  updated_at: string;
  assets: Asset[];
  jobs: ProcessingJob[];
  subtitle_cue_count: number;
}

export interface CapabilitiesResponse {
  allowed_fonts: string[];
  supported_languages: Array<{ code: string; name: string }>;
  max_upload_bytes: number;
  max_source_duration_seconds: number;
  default_settings: EditSettings;
}

export interface BackupInfo {
  id: string;
  label: string;
  reason: 'manual' | 'pre-update' | 'pre-restore' | 'cli' | string;
  app_version: string;
  created_at: string;
  path: string;
  size_bytes: number;
  project_count: number;
  batch_count: number;
  asset_count: number;
  includes_storage: boolean;
}

export interface CreateBackupPayload {
  label?: string;
  include_storage?: boolean;
}

export interface RestoreBackupResponse {
  restored_backup_id: string;
  safety_backup_id: string;
  restored_projects: number;
  restored_batches: number;
  message: string;
}

export interface SystemVersionResponse {
  current_version: string;
  os: string;
  arch: string;
  data_dir: string;
  backups_dir: string;
}

export interface UpdateCheckResponse {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_name: string;
  release_notes: string;
  published_at: string | null;
  html_url: string;
  asset_name: string | null;
  asset_download_url: string | null;
  asset_size_bytes: number | null;
  install_strategy: string;
  checked_at: string;
}

export type UpdateStatusKind =
  | 'idle'
  | 'checking'
  | 'backing_up'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready_to_restart'
  | 'completed'
  | 'failed';

export interface UpdateProgressState {
  status: UpdateStatusKind | string;
  stage: string;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number | null;
  current_version: string;
  target_version: string | null;
  backup_info: BackupInfo | null;
  installer_path: string | null;
  install_strategy: string | null;
  can_auto_restart: boolean;
  message: string;
  error_message_safe: string | null;
  started_at: string | null;
  updated_at: string;
}
