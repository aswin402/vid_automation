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
  | 'color'
  | 'logo'
  | 'subtitles'
  | 'outro'
  | 'export';

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

export interface EditSettings {
  schema_version: number;
  trim: TrimSettings;
  output: OutputSettings;
  color_correction: ColorCorrectionSettings;
  logo: LogoSettings;
  subtitles: SubtitlesSettings;
  outro: OutroSettings;
  audio_policy: string;
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
  kind: 'transcribe' | 'export';
  status:
    | 'queued'
    | 'validating'
    | 'probing'
    | 'trimming'
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
