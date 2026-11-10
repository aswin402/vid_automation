use crate::db::{now_iso, Database};
use crate::error::{AppError, AppResult};
use crate::media::ass_generator::{
    generate_ass_content, generate_srt_content, validate_subtitle_cues,
};
use crate::media::demo::{generate_synthetic_logo, generate_synthetic_video};
use crate::media::pipeline::{
    extract_audio_for_transcription, normalize_and_concat_outro, render_main_segment,
    trim_video_segment, validate_trim_range,
};
use crate::media::probe::{
    probe_image_file, probe_video_file, MediaMetadata, MAX_SOURCE_DURATION_SECS, MAX_UPLOAD_BYTES,
};
use crate::models::{
    supported_languages, AssetRecord, CapabilitiesResponse, DownloadUrlResponse, EditSettings,
    ExportCreateRequest, ProcessingJobRecord, ProjectDetailResponse, ProjectRecord,
    ProjectUpdateRequest, SubtitleVersionResponse, SubtitleVersionUpdateRequest,
    TranscriptionCreateRequest, UploadUrlRequest, UploadUrlResponse, ALLOWED_FONTS,
};
use crate::storage::StorageService;
use crate::transcription::transcribe_audio_wav;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::{error, info};
use uuid::Uuid;

pub struct CelestiaEngine {
    pub db: Database,
    pub storage: StorageService,
    pub data_dir: PathBuf,
    media_base_url: RwLock<String>,
    job_semaphore: Arc<Semaphore>,
    sample_dir: Option<PathBuf>,
}

impl CelestiaEngine {
    pub fn default_app_data_dir() -> PathBuf {
        if let Ok(custom) = std::env::var("CELESTIAVID_DATA_DIR") {
            if !custom.trim().is_empty() {
                return PathBuf::from(custom);
            }
        }
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("celestiavid")
    }

    pub fn open_default(sample_dir: Option<PathBuf>) -> AppResult<Arc<Self>> {
        let data_dir = Self::default_app_data_dir();
        Self::open(&data_dir, sample_dir)
    }

    pub fn open(data_dir: &Path, sample_dir: Option<PathBuf>) -> AppResult<Arc<Self>> {
        std::fs::create_dir_all(data_dir)?;
        let db_path = data_dir.join("celestiavid.db");
        let storage_dir = data_dir.join("storage");
        let secret = std::env::var("CELESTIAVID_SECRET_KEY")
            .unwrap_or_else(|_| "celestiavid-local-desktop-hmac-key-v2".to_string());

        let db = Database::open(&db_path)?;
        let storage = StorageService::new(storage_dir, secret.into_bytes(), 7200);

        Ok(Arc::new(Self {
            db,
            storage,
            data_dir: data_dir.to_path_buf(),
            media_base_url: RwLock::new(String::new()),
            job_semaphore: Arc::new(Semaphore::new(2)),
            sample_dir,
        }))
    }

    pub fn set_media_base_url(&self, base_url: impl Into<String>) {
        let cleaned = base_url.into().trim_end_matches('/').to_string();
        *self.media_base_url.write() = cleaned;
    }

    pub fn media_base_url(&self) -> String {
        self.media_base_url.read().clone()
    }

    fn decorate_asset(&self, mut asset: AssetRecord) -> AssetRecord {
        if asset.status == "ready" {
            let (token, _) = self
                .storage
                .create_signed_token(&asset.id, "download", Some(7200));
            let base = self.media_base_url();
            asset.stream_url = Some(format!(
                "{base}/api/v1/assets/{}/download?token={token}",
                asset.id
            ));
        }
        asset
    }

    fn build_project_detail(&self, proj: ProjectRecord) -> AppResult<ProjectDetailResponse> {
        let raw_assets = self.db.list_project_assets(&proj.id)?;
        let assets = raw_assets
            .into_iter()
            .map(|a| self.decorate_asset(a))
            .collect();
        let jobs = self.db.list_project_jobs(&proj.id)?;
        let subtitle_cue_count = self
            .db
            .count_subtitle_cues(&proj.id, proj.active_subtitle_version)?;

        Ok(ProjectDetailResponse {
            id: proj.id,
            owner_id: proj.owner_id,
            name: proj.name,
            status: proj.status,
            settings_json: proj.settings_json,
            active_subtitle_version: proj.active_subtitle_version,
            detected_language: proj.detected_language,
            created_at: proj.created_at,
            updated_at: proj.updated_at,
            assets,
            jobs,
            subtitle_cue_count,
        })
    }

    pub fn get_capabilities(&self) -> CapabilitiesResponse {
        CapabilitiesResponse {
            allowed_fonts: ALLOWED_FONTS.iter().map(|s| (*s).to_string()).collect(),
            supported_languages: supported_languages(),
            max_upload_bytes: MAX_UPLOAD_BYTES,
            max_source_duration_seconds: MAX_SOURCE_DURATION_SECS as u64,
            default_settings: EditSettings::default(),
            runtime: "rust-tauri-v2".to_string(),
        }
    }

    pub fn create_project(&self, name: &str) -> AppResult<ProjectDetailResponse> {
        let trimmed = name.trim();
        let final_name = if trimmed.is_empty() {
            "Untitled Video Project"
        } else {
            trimmed
        };
        let proj = self.db.create_project(final_name, &EditSettings::default())?;
        self.build_project_detail(proj)
    }

    pub fn list_projects(&self) -> AppResult<Vec<ProjectDetailResponse>> {
        let projects = self.db.list_projects()?;
        let mut out = Vec::with_capacity(projects.len());
        for p in projects {
            out.push(self.build_project_detail(p)?);
        }
        Ok(out)
    }

    pub fn get_project_detail(&self, project_id: &str) -> AppResult<ProjectDetailResponse> {
        let proj = self.db.get_project(project_id)?;
        self.build_project_detail(proj)
    }

    pub fn update_project(
        &self,
        project_id: &str,
        req: ProjectUpdateRequest,
    ) -> AppResult<ProjectDetailResponse> {
        let proj = self.db.update_project(
            project_id,
            req.name.as_deref(),
            None,
            req.settings.as_ref(),
            None,
            None,
        )?;
        self.build_project_detail(proj)
    }

    pub fn delete_project(&self, project_id: &str) -> AppResult<()> {
        let assets = self.db.list_project_assets(project_id)?;
        for a in assets {
            self.storage.delete_key(&a.storage_key);
        }
        self.db.delete_project(project_id)
    }

    fn validate_asset_kind(kind: &str) -> AppResult<()> {
        match kind {
            "source" | "logo" | "outro" => Ok(()),
            _ => Err(AppError::validation(
                "INVALID_ASSET_KIND",
                format!("Unsupported upload asset kind '{kind}'."),
            )),
        }
    }

    fn apply_ready_asset_to_project(
        &self,
        project_id: &str,
        new_asset: &AssetRecord,
    ) -> AppResult<()> {
        // Remove previous user-uploaded assets of the same slot (source/logo/outro)
        let existing = self.db.list_project_assets(project_id)?;
        for old in existing {
            if old.id != new_asset.id && old.kind == new_asset.kind {
                self.storage.delete_key(&old.storage_key);
                let _ = self.db.delete_asset_row(&old.id);
            }
        }

        let proj = self.db.get_project(project_id)?;
        let mut settings = proj.settings_json;
        match new_asset.kind.as_str() {
            "source" => {
                settings.trim.start_ms = 0;
                settings.trim.end_ms = new_asset.duration_ms;
            }
            "logo" => {
                settings.logo.enabled = true;
                settings.logo.asset_id = Some(new_asset.id.clone());
            }
            "outro" => {
                settings.outro.enabled = true;
                settings.outro.asset_id = Some(new_asset.id.clone());
            }
            _ => {}
        }
        self.db
            .update_project(project_id, None, None, Some(&settings), None, None)?;
        Ok(())
    }

    pub fn create_upload_url(
        &self,
        project_id: &str,
        req: UploadUrlRequest,
    ) -> AppResult<UploadUrlResponse> {
        Self::validate_asset_kind(&req.kind)?;
        let _ = self.db.get_project(project_id)?;
        if req.size_bytes > MAX_UPLOAD_BYTES {
            return Err(AppError::new(
                "UPLOAD_TOO_LARGE",
                "Selected file exceeds the maximum supported size.",
                413,
            ));
        }

        let asset_id = Uuid::new_v4().to_string();
        let storage_key = self
            .storage
            .generate_storage_key(project_id, &req.kind, &req.filename);
        let asset = AssetRecord {
            id: asset_id.clone(),
            project_id: project_id.to_string(),
            kind: req.kind,
            status: "pending_upload".to_string(),
            storage_key: storage_key.clone(),
            original_filename: req.filename,
            mime_type: req.content_type.clone(),
            size_bytes: req.size_bytes,
            duration_ms: None,
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
            frame_rate: None,
            pixel_format: None,
            has_audio: false,
            checksum: None,
            stream_url: None,
            created_at: now_iso(),
        };
        self.db.insert_asset(&asset)?;

        let (token, ttl) = self.storage.create_signed_token(&asset_id, "upload", Some(3600));
        let base = self.media_base_url();
        let upload_url = format!("{base}/api/v1/assets/{asset_id}/upload?token={token}");
        let mut headers = HashMap::new();
        headers.insert("Content-Type".to_string(), req.content_type);

        Ok(UploadUrlResponse {
            asset_id,
            storage_key,
            upload_url,
            method: "PUT".to_string(),
            headers,
            expires_in_seconds: ttl,
        })
    }

    pub async fn write_upload_bytes(
        &self,
        asset_id: &str,
        token: Option<&str>,
        require_token: bool,
        bytes: &[u8],
    ) -> AppResult<()> {
        if require_token {
            let tok = token.unwrap_or_default();
            if !self.storage.verify_signed_token(asset_id, "upload", tok) {
                return Err(AppError::forbidden("Invalid or expired upload token."));
            }
        }
        if bytes.is_empty() {
            return Err(AppError::validation(
                "EMPTY_UPLOAD",
                "Uploaded payload cannot be empty.",
            ));
        }
        if (bytes.len() as u64) > MAX_UPLOAD_BYTES {
            return Err(AppError::new(
                "UPLOAD_TOO_LARGE",
                "Uploaded payload exceeds maximum allowed size.",
                413,
            ));
        }

        let asset = self.db.get_asset(asset_id)?;
        let dest = self.storage.resolve_path(&asset.storage_key)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&dest, bytes).await?;
        Ok(())
    }

    async fn probe_for_kind(kind: &str, path: &Path) -> AppResult<MediaMetadata> {
        if kind == "logo" {
            let p = path.to_path_buf();
            tokio::task::spawn_blocking(move || probe_image_file(&p))
                .await
                .map_err(|e| {
                    AppError::internal("MEDIA_PROBE_FAILED", "Image probe task failed.", e.to_string())
                })?
        } else {
            probe_video_file(path, true).await
        }
    }

    pub async fn complete_upload(
        &self,
        project_id: &str,
        asset_id: &str,
    ) -> AppResult<AssetRecord> {
        let mut asset = self.db.get_asset(asset_id)?;
        if asset.project_id != project_id {
            return Err(AppError::forbidden("Asset does not belong to this project."));
        }
        let path = self.storage.resolve_path(&asset.storage_key)?;
        if !path.is_file() {
            return Err(AppError::validation(
                "UPLOAD_MISSING",
                "Uploaded file was not found in local storage.",
            ));
        }

        match Self::probe_for_kind(&asset.kind, &path).await {
            Ok(meta) => {
                let p_clone = path.clone();
                let checksum = tokio::task::spawn_blocking(move || {
                    StorageService::compute_sha256_prefix(&p_clone)
                })
                .await
                .ok()
                .flatten();

                asset.status = "ready".to_string();
                asset.mime_type = meta.mime_type;
                asset.size_bytes = meta.size_bytes;
                asset.duration_ms = meta.duration_ms;
                asset.width = Some(meta.width);
                asset.height = Some(meta.height);
                asset.video_codec = meta.video_codec;
                asset.audio_codec = meta.audio_codec;
                asset.frame_rate = meta.frame_rate;
                asset.pixel_format = meta.pixel_format;
                asset.has_audio = meta.has_audio;
                asset.checksum = checksum;

                self.db.update_asset(&asset)?;
                self.apply_ready_asset_to_project(project_id, &asset)?;
                Ok(self.decorate_asset(asset))
            }
            Err(err) => {
                asset.status = "failed".to_string();
                let _ = self.db.update_asset(&asset);
                self.storage.delete_key(&asset.storage_key);
                Err(err)
            }
        }
    }

    /// Zero-copy desktop import: links an existing local file on disk (`file:///abs/path`),
    /// runs native FFprobe / Rust `image` verification in-place without copying multi-GB video files,
    /// and registers it as a `ready` asset on the project.
    pub async fn import_local_asset(
        &self,
        project_id: &str,
        kind: &str,
        local_path: &Path,
    ) -> AppResult<AssetRecord> {
        Self::validate_asset_kind(kind)?;
        let _ = self.db.get_project(project_id)?;
        let storage_key = StorageService::make_external_file_key(local_path)?;
        let resolved = self.storage.resolve_path(&storage_key)?;
        let meta = Self::probe_for_kind(kind, &resolved).await?;

        let p_clone = resolved.clone();
        let checksum =
            tokio::task::spawn_blocking(move || StorageService::compute_sha256_prefix(&p_clone))
                .await
                .ok()
                .flatten();

        let filename = resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("local_media")
            .to_string();

        let asset = AssetRecord {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            kind: kind.to_string(),
            status: "ready".to_string(),
            storage_key,
            original_filename: filename,
            mime_type: meta.mime_type,
            size_bytes: meta.size_bytes,
            duration_ms: meta.duration_ms,
            width: Some(meta.width),
            height: Some(meta.height),
            video_codec: meta.video_codec,
            audio_codec: meta.audio_codec,
            frame_rate: meta.frame_rate,
            pixel_format: meta.pixel_format,
            has_audio: meta.has_audio,
            checksum,
            stream_url: None,
            created_at: now_iso(),
        };

        self.db.insert_asset(&asset)?;
        self.apply_ready_asset_to_project(project_id, &asset)?;
        Ok(self.decorate_asset(asset))
    }

    pub fn delete_asset(&self, asset_id: &str) -> AppResult<()> {
        let asset = self.db.get_asset(asset_id)?;
        self.storage.delete_key(&asset.storage_key);
        self.db.delete_asset_row(asset_id)?;

        if let Ok(proj) = self.db.get_project(&asset.project_id) {
            let mut settings = proj.settings_json;
            let mut changed = false;
            if asset.kind == "logo" && settings.logo.asset_id.as_deref() == Some(asset_id) {
                settings.logo.enabled = false;
                settings.logo.asset_id = None;
                changed = true;
            }
            if asset.kind == "outro" && settings.outro.asset_id.as_deref() == Some(asset_id) {
                settings.outro.enabled = false;
                settings.outro.asset_id = None;
                changed = true;
            }
            if changed {
                let _ = self.db.update_project(
                    &asset.project_id,
                    None,
                    None,
                    Some(&settings),
                    None,
                    None,
                );
            }
        }
        Ok(())
    }

    pub fn create_download_url(&self, asset_id: &str) -> AppResult<DownloadUrlResponse> {
        let asset = self.db.get_asset(asset_id)?;
        if asset.status != "ready" {
            return Err(AppError::validation(
                "ASSET_NOT_READY",
                "Requested asset is not ready for download.",
            ));
        }
        let (token, ttl) = self
            .storage
            .create_signed_token(&asset.id, "download", Some(7200));
        let base = self.media_base_url();
        let download_url = format!(
            "{base}/api/v1/assets/{}/download?token={token}&download=1",
            asset.id
        );
        Ok(DownloadUrlResponse {
            asset_id: asset.id,
            filename: asset.original_filename,
            download_url,
            expires_in_seconds: ttl,
        })
    }

    pub fn resolve_asset_download(
        &self,
        asset_id: &str,
        token: &str,
    ) -> AppResult<(AssetRecord, PathBuf)> {
        if !self.storage.verify_signed_token(asset_id, "download", token) {
            return Err(AppError::forbidden("Invalid or expired media stream token."));
        }
        let asset = self.db.get_asset(asset_id)?;
        let path = self.storage.resolve_path(&asset.storage_key)?;
        if !path.is_file() {
            return Err(AppError::not_found("Media file is missing on disk."));
        }
        Ok((asset, path))
    }

    pub async fn save_asset_to_path(&self, asset_id: &str, dest_path: &Path) -> AppResult<u64> {
        let asset = self.db.get_asset(asset_id)?;
        let src_path = self.storage.resolve_path(&asset.storage_key)?;
        if !src_path.is_file() {
            return Err(AppError::not_found("Rendered media file not found on disk."));
        }
        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let copied = tokio::fs::copy(&src_path, dest_path).await?;
        Ok(copied)
    }

    pub async fn create_demo_project(&self) -> AppResult<ProjectDetailResponse> {
        let proj = self
            .db
            .create_project("Sample Branded Showcase", &EditSettings::default())?;

        // Check if workspace `sample/` directory has real demo assets (`vid.mp4`, `Logo _sam.png`, `outro.mp4`)
        let sample_candidates = self.sample_dir.clone().or_else(|| {
            let cwd_sample = PathBuf::from("sample");
            if cwd_sample.is_dir() {
                Some(cwd_sample)
            } else {
                None
            }
        });

        let mut used_real_samples = false;
        if let Some(sdir) = sample_candidates {
            let vid = sdir.join("vid.mp4");
            let logo = sdir.join("Logo _sam.png");
            let outro = sdir.join("outro.mp4");
            if vid.is_file() && logo.is_file() && outro.is_file() {
                let _ = self.import_local_asset(&proj.id, "source", &vid).await?;
                let _ = self.import_local_asset(&proj.id, "logo", &logo).await?;
                let _ = self.import_local_asset(&proj.id, "outro", &outro).await?;
                used_real_samples = true;
            }
        }

        if !used_real_samples {
            let src_key = self
                .storage
                .generate_storage_key(&proj.id, "source", "sample_clip.mp4");
            let src_path = self.storage.resolve_path(&src_key)?;
            generate_synthetic_video(&src_path, 6.0, 1280, 720, 30, true, 220).await?;
            let _ = self.import_managed_generated(&proj.id, "source", src_key, "sample_clip.mp4").await?;

            let logo_key = self
                .storage
                .generate_storage_key(&proj.id, "logo", "brand_badge.png");
            let logo_path = self.storage.resolve_path(&logo_key)?;
            tokio::task::spawn_blocking(move || generate_synthetic_logo(&logo_path, 320, 96))
                .await
                .map_err(|e| AppError::internal("LOGO_GEN_FAILED", "Logo task failed.", e.to_string()))??;
            let _ = self.import_managed_generated(&proj.id, "logo", logo_key, "brand_badge.png").await?;

            let outro_key = self
                .storage
                .generate_storage_key(&proj.id, "outro", "sample_outro.mp4");
            let outro_path = self.storage.resolve_path(&outro_key)?;
            generate_synthetic_video(&outro_path, 2.5, 1280, 720, 30, true, 330).await?;
            let _ = self.import_managed_generated(&proj.id, "outro", outro_key, "sample_outro.mp4").await?;
        }

        // Configure attractive default branding (bottom-right logo + subtitles enabled)
        let refreshed = self.db.get_project(&proj.id)?;
        let mut settings = refreshed.settings_json;
        settings.logo.position = "bottom-right".to_string();
        settings.logo.width_ratio = 0.15;
        settings.subtitles.enabled = true;
        let updated = self
            .db
            .update_project(&proj.id, None, None, Some(&settings), None, None)?;

        self.build_project_detail(updated)
    }

    async fn import_managed_generated(
        &self,
        project_id: &str,
        kind: &str,
        storage_key: String,
        filename: &str,
    ) -> AppResult<AssetRecord> {
        let path = self.storage.resolve_path(&storage_key)?;
        let meta = Self::probe_for_kind(kind, &path).await?;
        let p_clone = path.clone();
        let checksum =
            tokio::task::spawn_blocking(move || StorageService::compute_sha256_prefix(&p_clone))
                .await
                .ok()
                .flatten();

        let asset = AssetRecord {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            kind: kind.to_string(),
            status: "ready".to_string(),
            storage_key,
            original_filename: filename.to_string(),
            mime_type: meta.mime_type,
            size_bytes: meta.size_bytes,
            duration_ms: meta.duration_ms,
            width: Some(meta.width),
            height: Some(meta.height),
            video_codec: meta.video_codec,
            audio_codec: meta.audio_codec,
            frame_rate: meta.frame_rate,
            pixel_format: meta.pixel_format,
            has_audio: meta.has_audio,
            checksum,
            stream_url: None,
            created_at: now_iso(),
        };
        self.db.insert_asset(&asset)?;
        self.apply_ready_asset_to_project(project_id, &asset)?;
        Ok(self.decorate_asset(asset))
    }

    fn compute_trimmed_duration_ms(&self, project: &ProjectRecord) -> AppResult<i64> {
        let src = self
            .db
            .find_ready_asset(&project.id, "source", None)?
            .ok_or_else(|| {
                AppError::validation(
                    "MISSING_SOURCE_ASSET",
                    "Upload or select a source video before running this step.",
                )
            })?;
        let src_dur = src.duration_ms.unwrap_or(0);
        let (s_ms, e_ms) = validate_trim_range(
            project.settings_json.trim.start_ms,
            project.settings_json.trim.end_ms,
            src_dur,
        )?;
        Ok((e_ms - s_ms).max(200))
    }

    pub fn get_subtitle_version(
        &self,
        project_id: &str,
        version: i64,
    ) -> AppResult<SubtitleVersionResponse> {
        let proj = self.db.get_project(project_id)?;
        let resolved_ver = if version <= 0 {
            proj.active_subtitle_version
        } else {
            version
        };

        let duration_ms = self.compute_trimmed_duration_ms(&proj).unwrap_or(10_000);
        let cues = if resolved_ver > 0 {
            self.db.get_subtitle_cues(project_id, resolved_ver)?
        } else {
            Vec::new()
        };

        Ok(SubtitleVersionResponse {
            project_id: project_id.to_string(),
            version: resolved_ver,
            language: proj
                .detected_language
                .unwrap_or_else(|| proj.settings_json.subtitles.language.clone()),
            timebase: "trimmed_clip_ms".to_string(),
            duration_ms,
            cues,
        })
    }

    pub fn save_subtitle_version(
        &self,
        project_id: &str,
        _version: i64,
        req: SubtitleVersionUpdateRequest,
    ) -> AppResult<SubtitleVersionResponse> {
        let proj = self.db.get_project(project_id)?;
        let duration_ms = self.compute_trimmed_duration_ms(&proj)?;
        let validated = validate_subtitle_cues(&req.cues, duration_ms, false)?;

        let next_ver = self.db.max_subtitle_version(project_id)? + 1;
        let saved_cues = self
            .db
            .insert_subtitle_version(project_id, next_ver, &validated)?;

        let lang = if req.language.trim().is_empty() || req.language == "auto" {
            proj.detected_language.as_deref().unwrap_or("en")
        } else {
            req.language.trim()
        };

        self.db.update_project(
            project_id,
            None,
            None,
            None,
            Some(next_ver),
            Some(lang),
        )?;

        Ok(SubtitleVersionResponse {
            project_id: project_id.to_string(),
            version: next_ver,
            language: lang.to_string(),
            timebase: "trimmed_clip_ms".to_string(),
            duration_ms,
            cues: saved_cues,
        })
    }

    pub fn export_subtitles_srt(
        &self,
        project_id: &str,
        version: i64,
    ) -> AppResult<(String, String)> {
        let sub_resp = self.get_subtitle_version(project_id, version)?;
        if sub_resp.cues.is_empty() {
            return Err(AppError::not_found(
                "No subtitle cues exist for this version.",
            ));
        }
        let srt = generate_srt_content(&sub_resp.cues);
        let filename = format!("subtitles_v{}.srt", sub_resp.version);
        Ok((filename, srt))
    }

    pub async fn save_srt_to_path(
        &self,
        project_id: &str,
        version: i64,
        dest_path: &Path,
    ) -> AppResult<u64> {
        let (_, srt) = self.export_subtitles_srt(project_id, version)?;
        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = srt.as_bytes();
        tokio::fs::write(dest_path, bytes).await?;
        Ok(bytes.len() as u64)
    }

    pub fn start_transcription(
        self: &Arc<Self>,
        project_id: &str,
        req: TranscriptionCreateRequest,
    ) -> AppResult<ProcessingJobRecord> {
        let proj = self.db.get_project(project_id)?;
        let src = self
            .db
            .find_ready_asset(project_id, "source", None)?
            .ok_or_else(|| {
                AppError::validation(
                    "MISSING_SOURCE_ASSET",
                    "Upload or select a source video before generating subtitles.",
                )
            })?;

        if !src.has_audio {
            return Err(AppError::validation(
                "NO_AUDIO_STREAM",
                "This source video does not contain an audio track to transcribe.",
            ));
        }

        if proj.active_subtitle_version > 0 && !req.confirm_overwrite {
            let count = self
                .db
                .count_subtitle_cues(project_id, proj.active_subtitle_version)?;
            if count > 0 {
                return Err(AppError::validation(
                    "CONFIRM_OVERWRITE_REQUIRED",
                    "Existing subtitle cues are present. Confirm overwrite to regenerate.",
                ));
            }
        }

        let mut settings_snap = proj.settings_json.clone();
        if !req.language.trim().is_empty() {
            settings_snap.subtitles.language = req.language.trim().to_string();
        }

        let now = now_iso();
        let job = ProcessingJobRecord {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            kind: "transcribe".to_string(),
            status: "queued".to_string(),
            stage: "queued".to_string(),
            progress: Some(0.05),
            idempotency_key: None,
            settings_snapshot_json: serde_json::to_value(&settings_snap).ok(),
            subtitle_version: None,
            output_asset_id: None,
            error_code: None,
            error_message_safe: None,
            internal_diagnostics: None,
            attempt_count: 1,
            started_at: None,
            finished_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.insert_job(&job)?;
        self.db
            .update_project(project_id, None, Some("processing"), Some(&settings_snap), None, None)?;

        let engine_clone = Arc::clone(self);
        let job_id = job.id.clone();
        tokio::spawn(async move {
            engine_clone.execute_transcription_job(&job_id).await;
        });

        Ok(job)
    }

    pub fn start_export(
        self: &Arc<Self>,
        project_id: &str,
        req: ExportCreateRequest,
    ) -> AppResult<ProcessingJobRecord> {
        let proj = self.db.get_project(project_id)?;
        let src = self
            .db
            .find_ready_asset(project_id, "source", None)?
            .ok_or_else(|| {
                AppError::validation(
                    "MISSING_SOURCE_ASSET",
                    "Upload or select a source video before exporting.",
                )
            })?;

        let _ = validate_trim_range(
            proj.settings_json.trim.start_ms,
            proj.settings_json.trim.end_ms,
            src.duration_ms.unwrap_or(0),
        )?;

        if let Some(ref idem_key) = req.idempotency_key {
            if !idem_key.trim().is_empty() {
                let jobs = self.db.list_project_jobs(project_id)?;
                if let Some(existing) = jobs.into_iter().find(|j| {
                    j.kind == "export"
                        && j.idempotency_key.as_deref() == Some(idem_key.as_str())
                        && j.status != "failed"
                        && j.status != "canceled"
                }) {
                    return Ok(existing);
                }
            }
        }

        let sub_ver = req
            .subtitle_version
            .filter(|&v| v > 0)
            .or(if proj.active_subtitle_version > 0 {
                Some(proj.active_subtitle_version)
            } else {
                None
            });

        let now = now_iso();
        let job = ProcessingJobRecord {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            kind: "export".to_string(),
            status: "queued".to_string(),
            stage: "queued".to_string(),
            progress: Some(0.04),
            idempotency_key: req.idempotency_key,
            settings_snapshot_json: serde_json::to_value(&proj.settings_json).ok(),
            subtitle_version: sub_ver,
            output_asset_id: None,
            error_code: None,
            error_message_safe: None,
            internal_diagnostics: None,
            attempt_count: 1,
            started_at: None,
            finished_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.insert_job(&job)?;
        self.db
            .update_project(project_id, None, Some("processing"), None, None, None)?;

        let engine_clone = Arc::clone(self);
        let job_id = job.id.clone();
        tokio::spawn(async move {
            engine_clone.execute_export_job(&job_id).await;
        });

        Ok(job)
    }

    pub fn get_job(&self, job_id: &str) -> AppResult<ProcessingJobRecord> {
        self.db.get_job(job_id)
    }

    pub fn cancel_job(&self, job_id: &str) -> AppResult<ProcessingJobRecord> {
        let mut job = self.db.get_job(job_id)?;
        if matches!(job.status.as_str(), "completed" | "failed" | "canceled") {
            return Ok(job);
        }
        job.status = "canceled".to_string();
        job.stage = "canceled".to_string();
        job.finished_at = Some(now_iso());
        job.updated_at = now_iso();
        self.db.update_job(&job)?;
        let _ = self
            .db
            .update_project(&job.project_id, None, Some("draft"), None, None, None);
        Ok(job)
    }

    pub fn retry_job(self: &Arc<Self>, job_id: &str) -> AppResult<ProcessingJobRecord> {
        let mut job = self.db.get_job(job_id)?;
        if !matches!(job.status.as_str(), "failed" | "canceled") {
            return Err(AppError::validation(
                "INVALID_JOB_STATE",
                "Only failed or canceled jobs can be retried.",
            ));
        }

        job.status = "queued".to_string();
        job.stage = "queued".to_string();
        job.progress = Some(0.05);
        job.error_code = None;
        job.error_message_safe = None;
        job.internal_diagnostics = None;
        job.attempt_count += 1;
        job.started_at = None;
        job.finished_at = None;
        job.updated_at = now_iso();
        self.db.update_job(&job)?;
        let _ = self
            .db
            .update_project(&job.project_id, None, Some("processing"), None, None, None);

        let engine_clone = Arc::clone(self);
        let jid = job.id.clone();
        let kind = job.kind.clone();
        tokio::spawn(async move {
            if kind == "transcribe" {
                engine_clone.execute_transcription_job(&jid).await;
            } else {
                engine_clone.execute_export_job(&jid).await;
            }
        });

        Ok(job)
    }

    fn is_job_canceled(&self, job_id: &str) -> bool {
        self.db
            .get_job(job_id)
            .map(|j| j.status == "canceled")
            .unwrap_or(true)
    }

    fn set_job_stage(&self, job_id: &str, stage: &str, progress: f64) -> AppResult<bool> {
        let mut job = self.db.get_job(job_id)?;
        if job.status == "canceled" {
            return Ok(false);
        }
        if job.started_at.is_none() {
            job.started_at = Some(now_iso());
        }
        job.status = stage.to_string();
        job.stage = stage.to_string();
        job.progress = Some(progress);
        job.updated_at = now_iso();
        self.db.update_job(&job)?;
        Ok(true)
    }

    fn fail_job(&self, job_id: &str, project_id: &str, err: AppError) {
        error!(
            job_id = job_id,
            code = %err.error_code,
            msg = %err.message,
            detail = ?err.internal_detail,
            "pipeline_job_failed"
        );
        if let Ok(mut job) = self.db.get_job(job_id) {
            if job.status != "canceled" {
                job.status = "failed".to_string();
                job.error_code = Some(err.error_code);
                job.error_message_safe = Some(err.message);
                job.internal_diagnostics = err.internal_detail;
                job.finished_at = Some(now_iso());
                job.updated_at = now_iso();
                let _ = self.db.update_job(&job);
            }
        }
        let _ = self
            .db
            .update_project(project_id, None, Some("failed"), None, None, None);
    }

    async fn execute_transcription_job(&self, job_id: &str) {
        let _permit = self.job_semaphore.acquire().await;
        let Ok(job) = self.db.get_job(job_id) else {
            return;
        };
        let project_id = job.project_id.clone();

        let scratch_dir = self.data_dir.join("scratch").join(job_id);
        let _ = tokio::fs::create_dir_all(&scratch_dir).await;

        let res: AppResult<()> = async {
            if !self.set_job_stage(job_id, "probing", 0.15)? {
                return Ok(());
            }
            let proj = self.db.get_project(&project_id)?;
            let settings: EditSettings = job
                .settings_snapshot_json
                .clone()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(proj.settings_json);

            let src_asset = self
                .db
                .find_ready_asset(&project_id, "source", None)?
                .ok_or_else(|| {
                    AppError::validation("MISSING_SOURCE_ASSET", "Source video asset is missing.")
                })?;
            let src_path = self.storage.resolve_path(&src_asset.storage_key)?;
            let src_meta = probe_video_file(&src_path, true).await?;

            if !self.set_job_stage(job_id, "trimming", 0.35)? {
                return Ok(());
            }
            let (s_ms, e_ms) = validate_trim_range(
                settings.trim.start_ms,
                settings.trim.end_ms,
                src_meta.duration_ms.unwrap_or(0),
            )?;
            let trimmed_path = scratch_dir.join("trimmed_for_stt.mp4");
            let trimmed_meta = trim_video_segment(
                &src_path,
                &trimmed_path,
                s_ms,
                e_ms,
                &src_meta,
                Some(&settings.output),
            )
            .await?;

            if !self.set_job_stage(job_id, "transcribing", 0.65)? {
                return Ok(());
            }
            let wav_path = scratch_dir.join("speech_16k.wav");
            extract_audio_for_transcription(
                &trimmed_path,
                &wav_path,
                Some(&settings.audio_enhancement),
            )
            .await?;

            let trimmed_dur = trimmed_meta.duration_ms.unwrap_or(e_ms - s_ms);
            let transcript = transcribe_audio_wav(
                &wav_path,
                trimmed_dur,
                Some(&settings.subtitles.language),
            )
            .await?;

            if self.is_job_canceled(job_id) {
                return Ok(());
            }

            let next_ver = self.db.max_subtitle_version(&project_id)? + 1;
            let _ = self
                .db
                .insert_subtitle_version(&project_id, next_ver, &transcript.cues)?;

            let mut updated_proj = self.db.get_project(&project_id)?;
            updated_proj.settings_json.subtitles.enabled = true;
            self.db.update_project(
                &project_id,
                None,
                Some("draft"),
                Some(&updated_proj.settings_json),
                Some(next_ver),
                Some(&transcript.language),
            )?;

            let mut final_job = self.db.get_job(job_id)?;
            final_job.status = "completed".to_string();
            final_job.stage = "completed".to_string();
            final_job.progress = Some(1.0);
            final_job.subtitle_version = Some(next_ver);
            final_job.finished_at = Some(now_iso());
            final_job.updated_at = now_iso();
            self.db.update_job(&final_job)?;

            info!(
                job_id = job_id,
                provider = %transcript.provider_name,
                cues = transcript.cues.len(),
                version = next_ver,
                "transcription_job_completed"
            );
            Ok(())
        }
        .await;

        let _ = tokio::fs::remove_dir_all(&scratch_dir).await;
        if let Err(err) = res {
            self.fail_job(job_id, &project_id, err);
        }
    }

    async fn execute_export_job(&self, job_id: &str) {
        let _permit = self.job_semaphore.acquire().await;
        let Ok(job) = self.db.get_job(job_id) else {
            return;
        };
        let project_id = job.project_id.clone();

        let scratch_dir = self.data_dir.join("scratch").join(job_id);
        let _ = tokio::fs::create_dir_all(&scratch_dir).await;

        let res: AppResult<()> = async {
            if !self.set_job_stage(job_id, "validating", 0.08)? {
                return Ok(());
            }
            let proj = self.db.get_project(&project_id)?;
            let settings: EditSettings = job
                .settings_snapshot_json
                .clone()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(proj.settings_json);

            if !self.set_job_stage(job_id, "probing", 0.16)? {
                return Ok(());
            }
            let src_asset = self
                .db
                .find_ready_asset(&project_id, "source", None)?
                .ok_or_else(|| {
                    AppError::validation("MISSING_SOURCE_ASSET", "Source video asset is missing.")
                })?;
            let src_path = self.storage.resolve_path(&src_asset.storage_key)?;
            let src_meta = probe_video_file(&src_path, true).await?;

            let (s_ms, e_ms) = validate_trim_range(
                settings.trim.start_ms,
                settings.trim.end_ms,
                src_meta.duration_ms.unwrap_or(0),
            )?;

            if !self.set_job_stage(job_id, "trimming", 0.32)? {
                return Ok(());
            }
            let trimmed_path = scratch_dir.join("01_trimmed.mp4");
            let trimmed_meta = trim_video_segment(
                &src_path,
                &trimmed_path,
                s_ms,
                e_ms,
                &src_meta,
                Some(&settings.output),
            )
            .await?;

            if !self.set_job_stage(job_id, "rendering_main", 0.56)? {
                return Ok(());
            }

            let logo_path_opt = if settings.logo.enabled {
                if let Some(logo_asset) = self.db.find_ready_asset(
                    &project_id,
                    "logo",
                    settings.logo.asset_id.as_deref(),
                )? {
                    let p = self.storage.resolve_path(&logo_asset.storage_key)?;
                    if p.is_file() {
                        Some(p)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let ass_path_opt = if settings.subtitles.enabled {
                let sub_ver = job.subtitle_version.unwrap_or(proj.active_subtitle_version);
                if sub_ver > 0 {
                    let cues = self.db.get_subtitle_cues(&project_id, sub_ver)?;
                    if !cues.is_empty() {
                        let ass_content = generate_ass_content(
                            &cues,
                            &settings.subtitles.style,
                            trimmed_meta.width,
                            trimmed_meta.height,
                        );
                        let ass_file = scratch_dir.join("captions.ass");
                        tokio::fs::write(&ass_file, ass_content).await?;
                        Some(ass_file)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let main_render_path = scratch_dir.join("02_main_rendered.mp4");
            let main_meta = render_main_segment(
                &trimmed_path,
                &main_render_path,
                &trimmed_meta,
                logo_path_opt.as_deref(),
                Some(&settings.logo),
                ass_path_opt.as_deref(),
                Some(&settings.output),
                Some(&settings.color_correction),
                Some(&settings.audio_enhancement),
            )
            .await?;

            let outro_asset_opt = if settings.outro.enabled {
                self.db.find_ready_asset(
                    &project_id,
                    "outro",
                    settings.outro.asset_id.as_deref(),
                )?
            } else {
                None
            };

            let final_stage_file = if let Some(outro_asset) = outro_asset_opt {
                if !self.set_job_stage(job_id, "normalizing_outro", 0.74)? {
                    return Ok(());
                }
                let outro_src_path = self.storage.resolve_path(&outro_asset.storage_key)?;
                let norm_outro_path = scratch_dir.join("03_outro_norm.mp4");
                let joined_path = scratch_dir.join("04_joined_final.mp4");

                let _ = self.set_job_stage(job_id, "joining_outro", 0.84)?;
                normalize_and_concat_outro(
                    &main_render_path,
                    &outro_src_path,
                    &norm_outro_path,
                    &joined_path,
                    &main_meta,
                    &settings.outro.normalization_mode,
                    Some(&settings.output),
                    Some(&settings.color_correction),
                )
                .await?;
                joined_path
            } else {
                main_render_path
            };

            if !self.set_job_stage(job_id, "validating_output", 0.92)? {
                return Ok(());
            }
            let out_meta = probe_video_file(&final_stage_file, false).await?;

            if !self.set_job_stage(job_id, "uploading_output", 0.96)? {
                return Ok(());
            }
            let safe_proj_slug = StorageService::sanitize_filename(&proj.name);
            let out_filename = format!("{safe_proj_slug}_branded.mp4");
            let out_key = self
                .storage
                .generate_storage_key(&project_id, "output", &out_filename);
            let managed_out_path = self.storage.resolve_path(&out_key)?;
            if let Some(parent) = managed_out_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::copy(&final_stage_file, &managed_out_path).await?;

            let p_clone = managed_out_path.clone();
            let checksum = tokio::task::spawn_blocking(move || {
                StorageService::compute_sha256_prefix(&p_clone)
            })
            .await
            .ok()
            .flatten();

            // Replace previous output assets for this project so latest export is unambiguous
            let prev_assets = self.db.list_project_assets(&project_id)?;
            for old in prev_assets {
                if old.kind == "output" {
                    self.storage.delete_key(&old.storage_key);
                    let _ = self.db.delete_asset_row(&old.id);
                }
            }

            let out_asset_id = Uuid::new_v4().to_string();
            let out_asset = AssetRecord {
                id: out_asset_id.clone(),
                project_id: project_id.to_string(),
                kind: "output".to_string(),
                status: "ready".to_string(),
                storage_key: out_key,
                original_filename: out_filename,
                mime_type: "video/mp4".to_string(),
                size_bytes: out_meta.size_bytes,
                duration_ms: out_meta.duration_ms,
                width: Some(out_meta.width),
                height: Some(out_meta.height),
                video_codec: out_meta.video_codec,
                audio_codec: out_meta.audio_codec,
                frame_rate: out_meta.frame_rate,
                pixel_format: out_meta.pixel_format,
                has_audio: out_meta.has_audio,
                checksum,
                stream_url: None,
                created_at: now_iso(),
            };
            self.db.insert_asset(&out_asset)?;
            self.db
                .update_project(&project_id, None, Some("completed"), None, None, None)?;

            let mut final_job = self.db.get_job(job_id)?;
            final_job.status = "completed".to_string();
            final_job.stage = "completed".to_string();
            final_job.progress = Some(1.0);
            final_job.output_asset_id = Some(out_asset_id.clone());
            final_job.finished_at = Some(now_iso());
            final_job.updated_at = now_iso();
            self.db.update_job(&final_job)?;

            info!(
                job_id = job_id,
                output_asset_id = %out_asset_id,
                duration_ms = ?out_meta.duration_ms,
                "export_job_completed"
            );
            Ok(())
        }
        .await;

        let _ = tokio::fs::remove_dir_all(&scratch_dir).await;
        if let Err(err) = res {
            self.fail_job(job_id, &project_id, err);
        }
    }
}
