use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const ALLOWED_FONTS: &[&str] = &[
    "Segoe UI",
    "Arial",
    "Verdana",
    "Tahoma",
    "DejaVu Sans",
    "DejaVu Sans Bold",
    "Liberation Sans",
    "Ubuntu",
    "Noto Sans",
    "FreeSans",
    "Sans",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanguageOption {
    pub code: String,
    pub name: String,
}

pub fn supported_languages() -> Vec<LanguageOption> {
    vec![
        LanguageOption { code: "auto".into(), name: "Auto-detect".into() },
        LanguageOption { code: "en".into(), name: "English".into() },
        LanguageOption { code: "es".into(), name: "Spanish".into() },
        LanguageOption { code: "fr".into(), name: "French".into() },
        LanguageOption { code: "de".into(), name: "German".into() },
        LanguageOption { code: "pt".into(), name: "Portuguese".into() },
        LanguageOption { code: "hi".into(), name: "Hindi".into() },
        LanguageOption { code: "ja".into(), name: "Japanese".into() },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrimSettings {
    #[serde(default)]
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: Option<i64>,
}

impl Default for TrimSettings {
    fn default() -> Self {
        Self {
            start_ms: 0,
            end_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CropKeyframe {
    pub time_ms: i64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CropSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_original_aspect")]
    pub aspect_ratio: String,
    #[serde(default = "default_crop_fit_mode")]
    pub fit_mode: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "default_one")]
    pub width: f64,
    #[serde(default = "default_one")]
    pub height: f64,
    #[serde(default = "default_one")]
    pub zoom: f64,
    #[serde(default)]
    pub auto_face_framing: bool,
    #[serde(default)]
    pub dynamic_tracking: bool,
    #[serde(default)]
    pub detected_face: Option<FaceBox>,
    #[serde(default)]
    pub keyframes: Vec<CropKeyframe>,
}

fn default_original_aspect() -> String {
    "original".into()
}
fn default_crop_fit_mode() -> String {
    "crop".into()
}

impl Default for CropSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            aspect_ratio: "original".into(),
            fit_mode: "crop".into(),
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            zoom: 1.0,
            auto_face_framing: false,
            dynamic_tracking: false,
            detected_face: None,
            keyframes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputSettings {
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default = "default_video_codec")]
    pub video_codec: String,
    #[serde(default = "default_audio_codec")]
    pub audio_codec: String,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "default_crf")]
    pub crf: u32,
}

fn default_video_codec() -> String { "libx264".into() }
fn default_audio_codec() -> String { "aac".into() }
fn default_preset() -> String { "fast".into() }
fn default_crf() -> u32 { 20 }

impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            fps: None,
            video_codec: default_video_codec(),
            audio_codec: default_audio_codec(),
            preset: default_preset(),
            crf: default_crf(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorCorrectionSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_custom_preset")]
    pub preset: String,
    #[serde(default)]
    pub brightness: f64,
    #[serde(default = "default_one")]
    pub contrast: f64,
    #[serde(default = "default_one")]
    pub saturation: f64,
    #[serde(default = "default_one")]
    pub gamma: f64,
    #[serde(default)]
    pub temperature: f64,
    #[serde(default)]
    pub tint: f64,
    #[serde(default)]
    pub sharpen: f64,
    #[serde(default)]
    pub apply_to_outro: bool,
}

fn default_custom_preset() -> String { "custom".into() }
fn default_one() -> f64 { 1.0 }
fn default_true() -> bool { true }

impl Default for ColorCorrectionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: "custom".into(),
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            gamma: 1.0,
            temperature: 0.0,
            tint: 0.0,
            sharpen: 0.0,
            apply_to_outro: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioEnhancementSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_custom_preset")]
    pub preset: String,
    #[serde(default)]
    pub noise_reduction: f64,
    #[serde(default)]
    pub voice_clarity: f64,
    #[serde(default = "default_highpass")]
    pub highpass_hz: u32,
    #[serde(default = "default_lowpass")]
    pub lowpass_hz: u32,
    #[serde(default)]
    pub volume_db: f64,
    #[serde(default)]
    pub normalize_loudness: bool,
    #[serde(default = "default_true")]
    pub apply_to_transcription: bool,
}

fn default_highpass() -> u32 { 80 }
fn default_lowpass() -> u32 { 16000 }

impl Default for AudioEnhancementSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: "custom".into(),
            noise_reduction: 0.0,
            voice_clarity: 0.0,
            highpass_hz: 80,
            lowpass_hz: 16000,
            volume_db: 0.0,
            normalize_loudness: false,
            apply_to_transcription: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default = "default_top_right")]
    pub position: String,
    #[serde(default)]
    pub x_ratio: Option<f64>,
    #[serde(default)]
    pub y_ratio: Option<f64>,
    #[serde(default = "default_logo_width_ratio")]
    pub width_ratio: f64,
    #[serde(default = "default_one")]
    pub opacity: f64,
    #[serde(default = "default_logo_margin")]
    pub margin_ratio: f64,
    #[serde(default)]
    pub apply_to_outro: bool,
}

fn default_top_right() -> String { "top-right".into() }
fn default_logo_width_ratio() -> f64 { 0.14 }
fn default_logo_margin() -> f64 { 0.03 }

impl Default for LogoSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            asset_id: None,
            position: "top-right".into(),
            x_ratio: None,
            y_ratio: None,
            width_ratio: 0.14,
            opacity: 1.0,
            margin_ratio: 0.03,
            apply_to_outro: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleStyleSettings {
    #[serde(default = "default_bottom_center")]
    pub position: String,
    #[serde(default)]
    pub x_ratio: Option<f64>,
    #[serde(default)]
    pub y_ratio: Option<f64>,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_white_hex")]
    pub text_color: String,
    #[serde(default)]
    pub background_enabled: bool,
    #[serde(default = "default_black_hex")]
    pub background_color: String,
    #[serde(default = "default_bg_opacity")]
    pub background_opacity: f64,
    #[serde(default = "default_true")]
    pub outline_enabled: bool,
    #[serde(default = "default_black_hex")]
    pub outline_color: String,
    #[serde(default = "default_outline_thickness")]
    pub outline_thickness: u32,
    #[serde(default = "default_true")]
    pub shadow_enabled: bool,
    #[serde(default = "default_shadow_depth")]
    pub shadow_depth: u32,
    #[serde(default = "default_center_align")]
    pub alignment: String,
    #[serde(default = "default_margin_v")]
    pub margin_v_ratio: f64,
    #[serde(default = "default_margin_h")]
    pub margin_h_ratio: f64,
}

fn default_bottom_center() -> String { "bottom-center".into() }
fn default_font_family() -> String {
    #[cfg(target_os = "windows")]
    {
        "Segoe UI".into()
    }
    #[cfg(target_os = "macos")]
    {
        "Arial".into()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "DejaVu Sans".into()
    }
}
fn default_font_size() -> u32 { 42 }
fn default_white_hex() -> String { "#FFFFFF".into() }
fn default_black_hex() -> String { "#000000".into() }
fn default_bg_opacity() -> f64 { 0.65 }
fn default_outline_thickness() -> u32 { 3 }
fn default_shadow_depth() -> u32 { 2 }
fn default_center_align() -> String { "center".into() }
fn default_margin_v() -> f64 { 0.06 }
fn default_margin_h() -> f64 { 0.05 }

impl Default for SubtitleStyleSettings {
    fn default() -> Self {
        Self {
            position: "bottom-center".into(),
            x_ratio: None,
            y_ratio: None,
            font_family: default_font_family(),
            font_size: 42,
            text_color: "#FFFFFF".into(),
            background_enabled: false,
            background_color: "#000000".into(),
            background_opacity: 0.65,
            outline_enabled: true,
            outline_color: "#000000".into(),
            outline_thickness: 3,
            shadow_enabled: true,
            shadow_depth: 2,
            alignment: "center".into(),
            margin_v_ratio: 0.06,
            margin_h_ratio: 0.05,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitlesSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_auto_lang")]
    pub language: String,
    #[serde(default)]
    pub style: SubtitleStyleSettings,
}

fn default_auto_lang() -> String { "auto".into() }

impl Default for SubtitlesSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            language: "auto".into(),
            style: SubtitleStyleSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutroSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default = "default_pad_mode")]
    pub normalization_mode: String,
}

fn default_pad_mode() -> String { "pad".into() }

impl Default for OutroSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            asset_id: None,
            normalization_mode: "pad".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditSettings {
    #[serde(default = "default_schema_ver")]
    pub schema_version: u32,
    #[serde(default)]
    pub trim: TrimSettings,
    #[serde(default)]
    pub crop: CropSettings,
    #[serde(default)]
    pub output: OutputSettings,
    #[serde(default)]
    pub color_correction: ColorCorrectionSettings,
    #[serde(default)]
    pub audio_enhancement: AudioEnhancementSettings,
    #[serde(default)]
    pub logo: LogoSettings,
    #[serde(default)]
    pub subtitles: SubtitlesSettings,
    #[serde(default)]
    pub outro: OutroSettings,
    #[serde(default = "default_audio_policy")]
    pub audio_policy: String,
}

fn default_schema_ver() -> u32 { 1 }
fn default_audio_policy() -> String { "sequential_preserve".into() }

impl Default for EditSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            trim: TrimSettings::default(),
            crop: CropSettings::default(),
            output: OutputSettings::default(),
            color_correction: ColorCorrectionSettings::default(),
            audio_enhancement: AudioEnhancementSettings::default(),
            logo: LogoSettings::default(),
            subtitles: SubtitlesSettings::default(),
            outro: OutroSettings::default(),
            audio_policy: "sequential_preserve".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRecord {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub status: String,
    pub storage_key: String,
    pub original_filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub duration_ms: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub frame_rate: Option<String>,
    pub pixel_format: Option<String>,
    pub has_audio: bool,
    pub checksum: Option<String>,
    pub stream_url: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingJobRecord {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub status: String,
    pub stage: String,
    pub progress: Option<f64>,
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing)]
    pub settings_snapshot_json: Option<Value>,
    pub subtitle_version: Option<i64>,
    pub output_asset_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message_safe: Option<String>,
    #[serde(skip_serializing)]
    pub internal_diagnostics: Option<String>,
    pub attempt_count: i64,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub status: String,
    pub settings_json: EditSettings,
    pub active_subtitle_version: i64,
    pub detected_language: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDetailResponse {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub status: String,
    pub settings_json: EditSettings,
    pub active_subtitle_version: i64,
    pub detected_language: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub assets: Vec<AssetRecord>,
    pub jobs: Vec<ProcessingJobRecord>,
    pub subtitle_cue_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleCueItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub sequence: usize,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    #[serde(default)]
    pub words_json: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleVersionResponse {
    pub project_id: String,
    pub version: i64,
    pub language: String,
    pub timebase: String,
    pub duration_ms: i64,
    pub cues: Vec<SubtitleCueItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitiesResponse {
    pub allowed_fonts: Vec<String>,
    pub supported_languages: Vec<LanguageOption>,
    pub max_upload_bytes: u64,
    pub max_source_duration_seconds: u64,
    pub default_settings: EditSettings,
    pub runtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadUrlRequest {
    pub kind: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadUrlResponse {
    pub asset_id: String,
    pub storage_key: String,
    pub upload_url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadUrlResponse {
    pub asset_id: String,
    pub filename: String,
    pub download_url: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCreateRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectUpdateRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub settings: Option<EditSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadCompleteRequest {
    pub asset_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionCreateRequest {
    #[serde(default = "default_auto_lang")]
    pub language: String,
    #[serde(default)]
    pub confirm_overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleVersionUpdateRequest {
    #[serde(default = "default_en_lang")]
    pub language: String,
    pub cues: Vec<SubtitleCueItem>,
}

fn default_en_lang() -> String { "en".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportCreateRequest {
    #[serde(default)]
    pub subtitle_version: Option<i64>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoFrameRequest {
    #[serde(default = "default_original_aspect")]
    pub aspect_ratio: String,
    #[serde(default)]
    pub dynamic_tracking: bool,
    #[serde(default)]
    pub target_zoom: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoFrameResponse {
    pub face_detected: bool,
    pub sampled_frames: usize,
    pub faces_found_frames: usize,
    pub primary_face: Option<FaceBox>,
    pub crop: CropSettings,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRecord {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub library_project_id: String,
    pub shared_settings_json: EditSettings,
    pub mapping_mode: String,
    pub output_dir: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItemRecord {
    pub id: String,
    pub batch_id: String,
    pub sort_order: usize,
    pub selected: bool,
    pub title: String,
    pub project_id: String,
    pub source_asset_id: Option<String>,
    pub logo_asset_id: Option<String>,
    pub outro_asset_id: Option<String>,
    pub use_custom_settings: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSummaryResponse {
    pub id: String,
    pub name: String,
    pub mapping_mode: String,
    pub output_dir: Option<String>,
    pub video_count: usize,
    pub logo_count: usize,
    pub outro_count: usize,
    pub item_count: usize,
    pub selected_count: usize,
    pub completed_count: usize,
    pub processing_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItemDetail {
    pub id: String,
    pub batch_id: String,
    pub sort_order: usize,
    pub selected: bool,
    pub title: String,
    pub project_id: String,
    pub source_asset_id: Option<String>,
    pub logo_asset_id: Option<String>,
    pub outro_asset_id: Option<String>,
    pub use_custom_settings: bool,
    pub settings: EditSettings,
    pub status: String,
    pub stage: String,
    pub progress: Option<f64>,
    pub error_message_safe: Option<String>,
    pub active_job_id: Option<String>,
    pub subtitle_cue_count: usize,
    pub output_asset: Option<AssetRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchDetailResponse {
    pub id: String,
    pub name: String,
    pub library_project_id: String,
    pub mapping_mode: String,
    pub output_dir: Option<String>,
    pub shared_settings: EditSettings,
    pub videos: Vec<AssetRecord>,
    pub logos: Vec<AssetRecord>,
    pub outros: Vec<AssetRecord>,
    pub items: Vec<BatchItemDetail>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchCreateRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchUpdateRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mapping_mode: Option<String>,
    #[serde(default)]
    pub output_dir: Option<String>,
    #[serde(default)]
    pub clear_output_dir: bool,
    #[serde(default)]
    pub shared_settings: Option<EditSettings>,
    #[serde(default)]
    pub apply_shared_to_selected: bool,
}

fn default_true_bool() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItemSpec {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default = "default_true_bool")]
    pub selected: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub source_asset_id: Option<String>,
    #[serde(default)]
    pub logo_asset_id: Option<String>,
    #[serde(default)]
    pub outro_asset_id: Option<String>,
    #[serde(default)]
    pub use_custom_settings: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSetItemsRequest {
    #[serde(default)]
    pub mapping_mode: Option<String>,
    pub items: Vec<BatchItemSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItemUpdateRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub source_asset_id: Option<String>,
    #[serde(default)]
    pub logo_asset_id: Option<String>,
    #[serde(default)]
    pub clear_logo: bool,
    #[serde(default)]
    pub outro_asset_id: Option<String>,
    #[serde(default)]
    pub clear_outro: bool,
    #[serde(default)]
    pub use_custom_settings: Option<bool>,
    #[serde(default)]
    pub settings: Option<EditSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchApplySettingsRequest {
    pub item_ids: Vec<String>,
    pub settings: EditSettings,
    #[serde(default)]
    pub update_shared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRunRequest {
    #[serde(default)]
    pub item_ids: Option<Vec<String>>,
    #[serde(default)]
    pub force_reexport: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRunResponse {
    pub batch_id: String,
    pub launched_count: usize,
    pub job_ids: Vec<String>,
    pub batch: BatchDetailResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderScanRequest {
    pub folder_path: String,
    #[serde(default = "default_true_bool")]
    pub recursive: bool,
    #[serde(default)]
    pub default_video_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedFolderItem {
    pub path: String,
    pub relative_path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub suggested_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderScanResponse {
    pub folder_path: String,
    pub items: Vec<ScannedFolderItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderImportItem {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchFolderImportRequest {
    pub items: Vec<FolderImportItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchFolderImportResponse {
    pub imported_count: usize,
    pub skipped_errors: Vec<String>,
    pub batch: BatchDetailResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchExportFolderRequest {
    pub dest_dir: String,
    #[serde(default)]
    pub item_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchExportFolderResponse {
    pub exported_count: usize,
    pub dest_dir: String,
    pub files: Vec<String>,
}

// ==================== App Data Backup & Self-Updater Models ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    pub id: String,
    pub label: String,
    pub reason: String,
    pub app_version: String,
    pub created_at: String,
    pub path: String,
    pub size_bytes: u64,
    pub project_count: usize,
    pub batch_count: usize,
    pub asset_count: usize,
    pub includes_storage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CreateBackupRequest {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub include_storage: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreBackupResponse {
    pub restored_backup_id: String,
    pub safety_backup_id: String,
    pub restored_projects: usize,
    pub restored_batches: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemVersionResponse {
    pub current_version: String,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
    pub backups_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResponse {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub asset_name: Option<String>,
    pub asset_download_url: Option<String>,
    pub asset_size_bytes: Option<u64>,
    pub install_strategy: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProgressState {
    pub status: String,
    pub stage: String,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub current_version: String,
    pub target_version: Option<String>,
    pub backup_info: Option<BackupInfo>,
    pub installer_path: Option<String>,
    pub install_strategy: Option<String>,
    pub can_auto_restart: bool,
    pub message: String,
    pub error_message_safe: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: String,
}

impl Default for UpdateProgressState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            stage: "idle".into(),
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: None,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            target_version: None,
            backup_info: None,
            installer_path: None,
            install_strategy: None,
            can_auto_restart: false,
            message: "Ready to check for updates.".into(),
            error_message_safe: None,
            started_at: None,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
