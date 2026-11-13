use crate::db::{now_iso, BATCH_ITEM_OWNER_ID, BATCH_LIBRARY_OWNER_ID};
use crate::engine::CelestiaEngine;
use crate::error::{AppError, AppResult};
use crate::media::ass_generator::generate_ass_content;
use crate::media::crop::{analyze_video_auto_frame, compute_aspect_crop_size};
use crate::media::demo::{generate_synthetic_logo, generate_synthetic_video};
use crate::media::pipeline::{
    extract_audio_for_transcription, normalize_and_concat_outro, render_main_segment,
    trim_video_segment, validate_trim_range,
};
use crate::media::probe::{probe_video_file, MAX_UPLOAD_BYTES};
use crate::models::{
    AssetRecord, AutoFrameRequest, BatchApplySettingsRequest, BatchDetailResponse,
    BatchExportFolderRequest, BatchExportFolderResponse, BatchFolderImportRequest,
    BatchFolderImportResponse, BatchItemDetail, BatchItemRecord, BatchItemUpdateRequest,
    BatchRecord, BatchRunRequest, BatchRunResponse, BatchSetItemsRequest, BatchSummaryResponse,
    BatchUpdateRequest, EditSettings, FolderScanRequest, FolderScanResponse, ProcessingJobRecord,
    ScannedFolderItem, UploadUrlRequest, UploadUrlResponse,
};
use crate::storage::StorageService;
use crate::transcription::transcribe_audio_wav;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::info;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum NatChunk {
    Num(u64),
    Text(String),
}

/// Natural human-friendly alphanumeric sort key so `video_2.mp4` comes before `video_10.mp4`.
pub fn natural_sort_key(s: &str) -> Vec<NatChunk> {
    let mut chunks = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(&ch) = chars.peek() {
        if ch.is_ascii_digit() {
            let mut num_str = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    num_str.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            let val = num_str.parse::<u64>().unwrap_or(0);
            chunks.push(NatChunk::Num(val));
        } else {
            let mut text = String::new();
            while let Some(&c) = chars.peek() {
                if !c.is_ascii_digit() {
                    text.extend(c.to_lowercase());
                    chars.next();
                } else {
                    break;
                }
            }
            chunks.push(NatChunk::Text(text));
        }
    }
    chunks
}

pub fn classify_media_file(rel_path: &str, default_video_role: Option<&str>) -> Option<&'static str> {
    let lower = rel_path.to_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();

    let is_image = matches!(ext, "png" | "jpg" | "jpeg" | "webp");
    if is_image {
        return Some("logo");
    }

    let is_video = matches!(ext, "mp4" | "mov" | "webm" | "mkv" | "m4v");
    if !is_video {
        return None;
    }

    if let Some(role) = default_video_role {
        let r = role.trim().to_lowercase();
        if r == "outro" {
            return Some("outro");
        }
        if r == "source" || r == "video" {
            return Some("source");
        }
    }

    let norm = lower.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').collect();
    let in_outro_folder = parts.iter().take(parts.len().saturating_sub(1)).any(|seg| {
        seg.contains("outro") || seg.contains("endscreen") || seg.contains("ending")
    });
    let filename = parts.last().copied().unwrap_or_default();
    let looks_like_outro = in_outro_folder
        || filename.contains("outro")
        || filename.contains("endscreen")
        || filename.contains("ending")
        || filename.starts_with("tail_")
        || filename.contains("_outro");

    if looks_like_outro {
        Some("outro")
    } else {
        Some("source")
    }
}

fn stem_without_ext(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename)
        .trim()
        .to_string()
}

fn collect_folder_files_recursive(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    default_video_role: Option<&str>,
    out: &mut Vec<ScannedFolderItem>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name_str) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name_str.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            if matches!(name_str, "node_modules" | "target" | "dist" | "__pycache__") {
                continue;
            }
            collect_folder_files_recursive(
                root,
                &path,
                depth + 1,
                max_depth,
                default_video_role,
                out,
            );
        } else if meta.is_file() && meta.len() > 0 && meta.len() <= MAX_UPLOAD_BYTES {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if let Some(kind) = classify_media_file(&rel, default_video_role) {
                out.push(ScannedFolderItem {
                    path: path.to_string_lossy().into_owned(),
                    relative_path: rel,
                    filename: name_str.to_string(),
                    size_bytes: meta.len(),
                    suggested_kind: kind.to_string(),
                });
            }
        }
    }
}

impl CelestiaEngine {
    fn default_batch_shared_settings() -> EditSettings {
        let mut s = EditSettings::default();
        // When a user maps a logo or outro to a batch item, enable them automatically!
        s.logo.enabled = true;
        s.outro.enabled = true;
        s
    }

    pub fn create_batch(&self, name: &str) -> AppResult<BatchDetailResponse> {
        let trimmed = name.trim();
        let final_name = if trimmed.is_empty() {
            "Untitled Batch Automation"
        } else {
            trimmed
        };
        let shared = Self::default_batch_shared_settings();
        let lib_proj = self.db.create_project_with_owner(
            BATCH_LIBRARY_OWNER_ID,
            &format!("[Batch Pool] {final_name}"),
            &shared,
        )?;
        let batch = self.db.create_batch(final_name, &lib_proj.id, &shared)?;
        self.build_batch_detail(batch)
    }

    pub fn list_batches(&self) -> AppResult<Vec<BatchSummaryResponse>> {
        let batches = self.db.list_batches()?;
        let mut out = Vec::with_capacity(batches.len());
        for b in batches {
            let pool_assets = self.db.list_project_assets_asc(&b.library_project_id)?;
            let video_count = pool_assets
                .iter()
                .filter(|a| a.kind == "source" && a.status == "ready")
                .count();
            let logo_count = pool_assets
                .iter()
                .filter(|a| a.kind == "logo" && a.status == "ready")
                .count();
            let outro_count = pool_assets
                .iter()
                .filter(|a| a.kind == "outro" && a.status == "ready")
                .count();

            let items = self.db.list_batch_items(&b.id)?;
            let item_count = items.len();
            let selected_count = items.iter().filter(|i| i.selected).count();
            let mut completed_count = 0usize;
            let mut processing_count = 0usize;
            for item in &items {
                if let Ok(proj) = self.db.get_project(&item.project_id) {
                    if proj.status == "completed" {
                        completed_count += 1;
                    } else if proj.status == "processing" {
                        processing_count += 1;
                    }
                }
            }

            out.push(BatchSummaryResponse {
                id: b.id,
                name: b.name,
                mapping_mode: b.mapping_mode,
                output_dir: b.output_dir,
                video_count,
                logo_count,
                outro_count,
                item_count,
                selected_count,
                completed_count,
                processing_count,
                created_at: b.created_at,
                updated_at: b.updated_at,
            });
        }
        Ok(out)
    }

    pub fn get_batch_detail(&self, batch_id: &str) -> AppResult<BatchDetailResponse> {
        let batch = self.db.get_batch(batch_id)?;
        self.build_batch_detail(batch)
    }

    fn build_batch_detail(&self, batch: BatchRecord) -> AppResult<BatchDetailResponse> {
        let raw_pool = self.db.list_project_assets_asc(&batch.library_project_id)?;
        let mut videos = Vec::new();
        let mut logos = Vec::new();
        let mut outros = Vec::new();

        for asset in raw_pool {
            if asset.status != "ready" {
                continue;
            }
            let decorated = self.decorate_asset(asset);
            match decorated.kind.as_str() {
                "source" => videos.push(decorated),
                "logo" => logos.push(decorated),
                "outro" => outros.push(decorated),
                _ => {}
            }
        }

        let raw_items = self.db.list_batch_items(&batch.id)?;
        let mut items = Vec::with_capacity(raw_items.len());
        for item in raw_items {
            let proj = self.db.get_project(&item.project_id)?;
            let jobs = self.db.list_project_jobs(&item.project_id)?;
            let latest_job = jobs.first();
            let proj_assets = self.db.list_project_assets(&item.project_id)?;
            let output_asset = proj_assets
                .into_iter()
                .find(|a| a.kind == "output" && a.status == "ready")
                .map(|a| self.decorate_asset(a));

            let subtitle_cue_count = self
                .db
                .count_subtitle_cues(&item.project_id, proj.active_subtitle_version)?;

            let (status, stage, progress, error_message_safe, active_job_id) =
                if let Some(j) = latest_job {
                    let is_running = !matches!(j.status.as_str(), "completed" | "failed" | "canceled");
                    let ui_status = if j.status == "queued" {
                        "queued".to_string()
                    } else if is_running {
                        "processing".to_string()
                    } else if j.status == "completed" && output_asset.is_some() {
                        "completed".to_string()
                    } else if j.status == "failed" {
                        "failed".to_string()
                    } else if j.status == "canceled" {
                        "canceled".to_string()
                    } else {
                        proj.status.clone()
                    };
                    let job_ref = if is_running || j.status == "failed" {
                        Some(j.id.clone())
                    } else {
                        None
                    };
                    (
                        ui_status,
                        j.stage.clone(),
                        j.progress,
                        j.error_message_safe.clone(),
                        job_ref,
                    )
                } else {
                    (proj.status.clone(), "draft".to_string(), None, None, None)
                };

            items.push(BatchItemDetail {
                id: item.id,
                batch_id: item.batch_id,
                sort_order: item.sort_order,
                selected: item.selected,
                title: item.title,
                project_id: item.project_id,
                source_asset_id: item.source_asset_id,
                logo_asset_id: item.logo_asset_id,
                outro_asset_id: item.outro_asset_id,
                use_custom_settings: item.use_custom_settings,
                settings: proj.settings_json,
                status,
                stage,
                progress,
                error_message_safe,
                active_job_id,
                subtitle_cue_count,
                output_asset,
                created_at: item.created_at,
                updated_at: item.updated_at,
            });
        }

        Ok(BatchDetailResponse {
            id: batch.id,
            name: batch.name,
            library_project_id: batch.library_project_id,
            mapping_mode: batch.mapping_mode,
            output_dir: batch.output_dir,
            shared_settings: batch.shared_settings_json,
            videos,
            logos,
            outros,
            items,
            created_at: batch.created_at,
            updated_at: batch.updated_at,
        })
    }

    pub fn delete_batch(&self, batch_id: &str) -> AppResult<()> {
        let batch = self.db.get_batch(batch_id)?;
        let items = self.db.list_batch_items(batch_id)?;

        // Delete item backing projects first (refcounted storage delete)
        for item in items {
            let _ = self.delete_project(&item.project_id);
        }
        // Delete batch row & library project (refcounted storage delete cleans up remaining 0-ref files)
        let _ = self.db.delete_batch(batch_id);
        let _ = self.delete_project(&batch.library_project_id);
        Ok(())
    }

    /// Creates a signed upload URL in the Batch Pool (`library_project_id`) without replacing existing pool assets.
    pub fn create_batch_pool_upload_url(
        &self,
        batch_id: &str,
        req: UploadUrlRequest,
    ) -> AppResult<UploadUrlResponse> {
        let batch = self.db.get_batch(batch_id)?;
        self.create_upload_url(&batch.library_project_id, req)
    }

    /// Completes an upload into the Batch Pool (`library_project_id`), probing media without deleting sibling pool assets!
    pub async fn complete_batch_pool_upload(
        &self,
        batch_id: &str,
        asset_id: &str,
    ) -> AppResult<AssetRecord> {
        let batch = self.db.get_batch(batch_id)?;
        let mut asset = self.db.get_asset(asset_id)?;
        if asset.project_id != batch.library_project_id {
            return Err(AppError::forbidden(
                "Asset does not belong to this batch pool.",
            ));
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
                let _ = self.db.touch_batch(batch_id);
                Ok(self.decorate_asset(asset))
            }
            Err(err) => {
                asset.status = "failed".to_string();
                let _ = self.db.update_asset(&asset);
                self.remove_asset_row_and_unref_storage(&asset);
                Err(err)
            }
        }
    }

    /// Zero-copy imports a local file into the Batch Pool (`library_project_id`) without replacing sibling pool assets.
    pub async fn import_local_asset_to_batch_pool(
        &self,
        batch_id: &str,
        kind: &str,
        local_path: &Path,
    ) -> AppResult<AssetRecord> {
        Self::validate_asset_kind(kind)?;
        let batch = self.db.get_batch(batch_id)?;
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
            project_id: batch.library_project_id,
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
        let _ = self.db.touch_batch(batch_id);
        Ok(self.decorate_asset(asset))
    }

    pub fn delete_batch_pool_asset(
        &self,
        batch_id: &str,
        asset_id: &str,
    ) -> AppResult<BatchDetailResponse> {
        let batch = self.db.get_batch(batch_id)?;
        let asset = self.db.get_asset(asset_id)?;
        if asset.project_id != batch.library_project_id {
            return Err(AppError::forbidden(
                "Asset does not belong to this batch pool.",
            ));
        }

        // Unlink any batch_items referencing this pool asset
        let items = self.db.list_batch_items(batch_id)?;
        for mut item in items {
            let mut changed = false;
            if item.source_asset_id.as_deref() == Some(asset_id) {
                item.source_asset_id = None;
                changed = true;
            }
            if item.logo_asset_id.as_deref() == Some(asset_id) {
                item.logo_asset_id = None;
                changed = true;
            }
            if item.outro_asset_id.as_deref() == Some(asset_id) {
                item.outro_asset_id = None;
                changed = true;
            }
            if changed {
                item.updated_at = now_iso();
                self.db.update_batch_item(&item)?;
                let _ = self.sync_batch_item_project(&batch, &item, None);
            }
        }

        self.remove_asset_row_and_unref_storage(&asset);
        let _ = self.db.touch_batch(batch_id);
        self.get_batch_detail(batch_id)
    }

    /// Scans a local folder for supported videos and brand logos, returning natural-sorted candidates.
    pub fn scan_local_folder(&self, req: FolderScanRequest) -> AppResult<FolderScanResponse> {
        let raw_dir = req.folder_path.trim();
        if raw_dir.is_empty() {
            return Err(AppError::validation(
                "INVALID_FOLDER_PATH",
                "Please provide a valid local folder path.",
            ));
        }
        let dir_path = PathBuf::from(raw_dir);
        if !dir_path.is_dir() {
            return Err(AppError::not_found(format!(
                "Folder '{}' does not exist or is not a directory.",
                raw_dir
            )));
        }
        let canonical = std::fs::canonicalize(&dir_path).unwrap_or(dir_path);
        let max_depth = if req.recursive { 3 } else { 0 };
        let mut items = Vec::new();
        collect_folder_files_recursive(
            &canonical,
            &canonical,
            0,
            max_depth,
            req.default_video_role.as_deref(),
            &mut items,
        );

        items.sort_by(|a, b| {
            natural_sort_key(&a.relative_path).cmp(&natural_sort_key(&b.relative_path))
        });

        Ok(FolderScanResponse {
            folder_path: canonical.to_string_lossy().into_owned(),
            items,
        })
    }

    /// Imports selected files from a scanned folder into the Batch Pool in natural order.
    pub async fn import_folder_items_to_batch(
        &self,
        batch_id: &str,
        req: BatchFolderImportRequest,
    ) -> AppResult<BatchFolderImportResponse> {
        let _ = self.db.get_batch(batch_id)?;
        let mut sorted_items = req.items;
        sorted_items.sort_by(|a, b| natural_sort_key(&a.path).cmp(&natural_sort_key(&b.path)));

        let mut imported_count = 0usize;
        let mut skipped_errors = Vec::new();

        for item in sorted_items {
            let p = PathBuf::from(item.path.trim());
            match self
                .import_local_asset_to_batch_pool(batch_id, item.kind.trim(), &p)
                .await
            {
                Ok(_) => imported_count += 1,
                Err(err) => skipped_errors.push(format!("{}: {}", item.path, err.message)),
            }
        }

        let batch = self.get_batch_detail(batch_id)?;
        Ok(BatchFolderImportResponse {
            imported_count,
            skipped_errors,
            batch,
        })
    }

    /// Merges Batch Master Control (`shared_settings_json`) into a specific item's `EditSettings`,
    /// inheriting every tool NOT listed in `item_base.overridden_tools` while always keeping `trim` per-video.
    fn merge_master_into_item_settings(
        master: &EditSettings,
        item_base: &EditSettings,
        src_dims: Option<(u32, u32)>,
    ) -> EditSettings {
        let has_override = |tool: &str| item_base.overridden_tools.iter().any(|t| t == tool);

        let crop = if has_override("crop") {
            item_base.crop.clone()
        } else {
            let mut c = master.crop.clone();
            if c.enabled && c.aspect_ratio != "original" && c.aspect_ratio != "custom" {
                let (sw, sh) = src_dims.unwrap_or((1920, 1080));
                let (bw, bh) =
                    compute_aspect_crop_size(&c.aspect_ratio, sw, sh, c.zoom.max(1.0));
                c.width = bw;
                c.height = bh;
                c.x = ((1.0 - bw) / 2.0).clamp(0.0, (1.0 - bw).max(0.0));
                c.y = ((1.0 - bh) / 2.0).clamp(0.0, (1.0 - bh).max(0.0));
            }
            if item_base.crop.aspect_ratio == c.aspect_ratio
                && (item_base.crop.zoom - c.zoom).abs() < 1e-4
                && item_base.crop.auto_face_framing == c.auto_face_framing
            {
                if let Some(face) = item_base.crop.detected_face.clone() {
                    c.detected_face = Some(face);
                    c.x = item_base.crop.x;
                    c.y = item_base.crop.y;
                    c.keyframes = item_base.crop.keyframes.clone();
                } else {
                    c.detected_face = None;
                    c.keyframes = Vec::new();
                }
            } else {
                c.detected_face = None;
                c.keyframes = Vec::new();
            }
            c
        };

        EditSettings {
            schema_version: master.schema_version.max(item_base.schema_version),
            trim: item_base.trim.clone(),
            crop,
            output: if has_override("output") {
                item_base.output.clone()
            } else {
                master.output.clone()
            },
            color_correction: if has_override("color") {
                item_base.color_correction.clone()
            } else {
                master.color_correction.clone()
            },
            audio_enhancement: if has_override("audio") {
                item_base.audio_enhancement.clone()
            } else {
                master.audio_enhancement.clone()
            },
            logo: if has_override("logo") {
                item_base.logo.clone()
            } else {
                master.logo.clone()
            },
            subtitles: if has_override("subtitles") {
                item_base.subtitles.clone()
            } else {
                master.subtitles.clone()
            },
            outro: if has_override("outro") {
                item_base.outro.clone()
            } else {
                master.outro.clone()
            },
            audio_policy: master.audio_policy.clone(),
            overridden_tools: item_base.overridden_tools.clone(),
        }
    }

    /// Synchronizes a Batch Item's backing `Project` (`source`, `logo`, `outro` zero-copy asset links + `EditSettings`).
    fn sync_batch_item_project(
        &self,
        batch: &BatchRecord,
        item: &BatchItemRecord,
        explicit_settings_override: Option<&EditSettings>,
    ) -> AppResult<()> {
        let proj = self.db.get_project(&item.project_id)?;
        let existing_proj_assets = self.db.list_project_assets(&item.project_id)?;

        // Sync each of ("source", "logo", "outro")
        let mut resolved_slot_ids: HashMap<&'static str, Option<String>> = HashMap::new();
        let mut resolved_source_duration: Option<i64> = None;
        let mut resolved_source_dims: Option<(u32, u32)> = None;

        for (kind, pool_id_opt) in [
            ("source", item.source_asset_id.as_deref()),
            ("logo", item.logo_asset_id.as_deref()),
            ("outro", item.outro_asset_id.as_deref()),
        ] {
            let current_slot_assets: Vec<&AssetRecord> = existing_proj_assets
                .iter()
                .filter(|a| a.kind == kind)
                .collect();

            if let Some(pool_id) = pool_id_opt {
                if let Ok(pool_asset) = self.db.get_asset(pool_id) {
                    if kind == "source" {
                        resolved_source_duration = pool_asset.duration_ms;
                        resolved_source_dims = pool_asset.width.zip(pool_asset.height);
                    }
                    // Check if backing project already has a ready asset with the exact same storage_key
                    if let Some(matching) = current_slot_assets
                        .iter()
                        .find(|a| a.storage_key == pool_asset.storage_key && a.status == "ready")
                    {
                        resolved_slot_ids.insert(kind, Some(matching.id.clone()));
                        for extra in &current_slot_assets {
                            if extra.id != matching.id {
                                self.remove_asset_row_and_unref_storage(extra);
                            }
                        }
                        continue;
                    }

                    // Otherwise remove old slot assets and insert a zero-copy linked AssetRecord
                    for old in &current_slot_assets {
                        self.remove_asset_row_and_unref_storage(old);
                    }
                    let cloned = AssetRecord {
                        id: Uuid::new_v4().to_string(),
                        project_id: item.project_id.clone(),
                        kind: kind.to_string(),
                        status: "ready".to_string(),
                        storage_key: pool_asset.storage_key,
                        original_filename: pool_asset.original_filename,
                        mime_type: pool_asset.mime_type,
                        size_bytes: pool_asset.size_bytes,
                        duration_ms: pool_asset.duration_ms,
                        width: pool_asset.width,
                        height: pool_asset.height,
                        video_codec: pool_asset.video_codec,
                        audio_codec: pool_asset.audio_codec,
                        frame_rate: pool_asset.frame_rate,
                        pixel_format: pool_asset.pixel_format,
                        has_audio: pool_asset.has_audio,
                        checksum: pool_asset.checksum,
                        stream_url: None,
                        created_at: now_iso(),
                    };
                    self.db.insert_asset(&cloned)?;
                    resolved_slot_ids.insert(kind, Some(cloned.id));
                    continue;
                }
            }

            // Pool asset is None -> clear slot on backing project
            for old in &current_slot_assets {
                self.remove_asset_row_and_unref_storage(old);
            }
            resolved_slot_ids.insert(kind, None);
        }

        // Compute effective EditSettings by merging Master Control (`batch.shared_settings_json`)
        // with per-video `trim` and any explicitly overridden tools in `overridden_tools`
        let mut item_base = if let Some(explicit) = explicit_settings_override {
            explicit.clone()
        } else {
            proj.settings_json.clone()
        };
        if explicit_settings_override.is_none() && !item.use_custom_settings {
            item_base.overridden_tools.clear();
        }

        let mut merged = Self::merge_master_into_item_settings(
            &batch.shared_settings_json,
            &item_base,
            resolved_source_dims,
        );

        // Safely adapt trim range to this specific video's duration so different-length clips never fail!
        if let Some(dur_ms) = resolved_source_duration.filter(|&d| d >= 200) {
            if merged.trim.start_ms < 0 || merged.trim.start_ms > dur_ms - 200 {
                merged.trim.start_ms = 0;
            }
            if let Some(end_ms) = merged.trim.end_ms {
                if end_ms <= merged.trim.start_ms + 200 || end_ms > dur_ms {
                    merged.trim.end_ms = Some(dur_ms);
                }
            }
        }

        // Bind mapped logo & outro asset IDs (keep `logo.enabled` defaulting to Master/Row preference
        // even before a logo image is uploaded; FFmpeg export only overlays when a ready logo asset exists)
        let proj_logo_id = resolved_slot_ids.get("logo").cloned().flatten();
        merged.logo.asset_id = proj_logo_id;

        let proj_outro_id = resolved_slot_ids.get("outro").cloned().flatten();
        if let Some(oid) = proj_outro_id {
            merged.outro.asset_id = Some(oid);
        } else {
            merged.outro.asset_id = None;
            merged.outro.enabled = false;
        }

        self.db.update_project(
            &item.project_id,
            Some(&item.title),
            None,
            Some(&merged),
            None,
            None,
        )?;
        Ok(())
    }

    pub fn update_batch(
        &self,
        batch_id: &str,
        req: BatchUpdateRequest,
    ) -> AppResult<BatchDetailResponse> {
        let out_dir_update: Option<Option<&str>> = if req.clear_output_dir {
            Some(None)
        } else {
            req.output_dir.as_deref().map(Some)
        };

        let updated_batch = self.db.update_batch(
            batch_id,
            req.name.as_deref(),
            req.mapping_mode.as_deref(),
            out_dir_update,
            req.shared_settings.as_ref(),
        )?;

        if req.shared_settings.is_some() {
            let items = self.db.list_batch_items(batch_id)?;
            for mut item in items {
                if req.apply_shared_to_selected && item.selected {
                    item.use_custom_settings = false;
                    item.updated_at = now_iso();
                    self.db.update_batch_item(&item)?;
                    if let Ok(p) = self.db.get_project(&item.project_id) {
                        let mut cleared = p.settings_json;
                        cleared.overridden_tools.clear();
                        let _ = self.db.update_project(
                            &item.project_id,
                            None,
                            None,
                            Some(&cleared),
                            None,
                            None,
                        );
                    }
                }
                self.sync_batch_item_project(&updated_batch, &item, None)?;
            }
        }

        self.build_batch_detail(updated_batch)
    }

    pub fn set_batch_items(
        &self,
        batch_id: &str,
        req: BatchSetItemsRequest,
    ) -> AppResult<BatchDetailResponse> {
        let mut batch = self.db.get_batch(batch_id)?;
        if let Some(ref mode) = req.mapping_mode {
            batch = self
                .db
                .update_batch(batch_id, None, Some(mode), None, None)?;
        }

        let existing = self.db.list_batch_items(batch_id)?;
        let existing_map: HashMap<String, BatchItemRecord> =
            existing.into_iter().map(|i| (i.id.clone(), i)).collect();

        // Build lookup of pool filenames for clean default item titles
        let pool_assets = self.db.list_project_assets_asc(&batch.library_project_id)?;
        let pool_name_map: HashMap<String, String> = pool_assets
            .into_iter()
            .map(|a| (a.id, stem_without_ext(&a.original_filename)))
            .collect();

        let mut kept_ids = HashSet::new();

        for (idx, spec) in req.items.into_iter().enumerate() {
            let auto_title = {
                let v_stem = spec
                    .source_asset_id
                    .as_ref()
                    .and_then(|id| pool_name_map.get(id))
                    .cloned()
                    .unwrap_or_else(|| format!("video_{}", idx + 1));
                let l_suffix = spec
                    .logo_asset_id
                    .as_ref()
                    .and_then(|id| pool_name_map.get(id))
                    .map(|s| format!("_{s}"))
                    .unwrap_or_default();
                format!("{v_stem}{l_suffix}")
            };

            let resolved_title = spec
                .title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .unwrap_or(auto_title);

            if let Some(existing_id) = spec.id.as_ref().filter(|id| existing_map.contains_key(*id))
            {
                kept_ids.insert(existing_id.clone());
                let mut item = existing_map.get(existing_id).unwrap().clone();
                let source_changed = item.source_asset_id != spec.source_asset_id;
                let logo_newly_added =
                    item.logo_asset_id.is_none() && spec.logo_asset_id.is_some();
                let outro_newly_added =
                    item.outro_asset_id.is_none() && spec.outro_asset_id.is_some();
                item.sort_order = idx;
                item.selected = spec.selected;
                item.title = resolved_title;
                item.source_asset_id = spec.source_asset_id;
                item.logo_asset_id = spec.logo_asset_id;
                item.outro_asset_id = spec.outro_asset_id;
                if let Some(ucs) = spec.use_custom_settings {
                    item.use_custom_settings = ucs;
                }
                item.updated_at = now_iso();
                self.db.update_batch_item(&item)?;
                self.sync_batch_item_project(&batch, &item, None)?;
                if source_changed || logo_newly_added || outro_newly_added {
                    if let Ok(p) = self.db.get_project(&item.project_id) {
                        let mut s = p.settings_json;
                        if source_changed {
                            // Reset detected face on source video swap so auto-face-framing re-runs cleanly
                            s.crop.detected_face = None;
                            s.crop.keyframes.clear();
                        }
                        if logo_newly_added && s.logo.asset_id.is_some() {
                            s.logo.enabled = true;
                        }
                        if outro_newly_added && s.outro.asset_id.is_some() {
                            s.outro.enabled = true;
                        }
                        let next_status = if source_changed { Some("draft") } else { None };
                        let _ = self.db.update_project(
                            &item.project_id,
                            None,
                            next_status,
                            Some(&s),
                            None,
                            None,
                        );
                    }
                }
            } else {
                let proj = self.db.create_project_with_owner(
                    BATCH_ITEM_OWNER_ID,
                    &resolved_title,
                    &batch.shared_settings_json,
                )?;
                let now = now_iso();
                let item = BatchItemRecord {
                    id: Uuid::new_v4().to_string(),
                    batch_id: batch_id.to_string(),
                    sort_order: idx,
                    selected: spec.selected,
                    title: resolved_title,
                    project_id: proj.id,
                    source_asset_id: spec.source_asset_id,
                    logo_asset_id: spec.logo_asset_id,
                    outro_asset_id: spec.outro_asset_id,
                    use_custom_settings: spec.use_custom_settings.unwrap_or(false),
                    created_at: now.clone(),
                    updated_at: now,
                };
                self.db.insert_batch_item(&item)?;
                self.sync_batch_item_project(&batch, &item, None)?;
            }
        }

        // Remove items no longer in the batch list
        for (old_id, old_item) in existing_map {
            if !kept_ids.contains(&old_id) {
                let _ = self.db.delete_batch_item_row(&old_id);
                let _ = self.delete_project(&old_item.project_id);
            }
        }

        let _ = self.db.touch_batch(batch_id);
        self.get_batch_detail(batch_id)
    }

    pub fn update_batch_item(
        &self,
        batch_id: &str,
        item_id: &str,
        req: BatchItemUpdateRequest,
    ) -> AppResult<BatchDetailResponse> {
        let batch = self.db.get_batch(batch_id)?;
        let mut item = self.db.get_batch_item(item_id)?;
        if item.batch_id != batch_id {
            return Err(AppError::forbidden(
                "Batch item does not belong to this batch.",
            ));
        }

        let mut source_changed = false;
        if let Some(t) = req.title {
            if !t.trim().is_empty() {
                item.title = t.trim().to_string();
            }
        }
        if let Some(sel) = req.selected {
            item.selected = sel;
        }
        if let Some(src_id) = req.source_asset_id {
            let norm = if src_id.trim().is_empty() {
                None
            } else {
                Some(src_id)
            };
            if item.source_asset_id != norm {
                source_changed = true;
                item.source_asset_id = norm;
            }
        }
        if req.clear_logo {
            item.logo_asset_id = None;
        } else if let Some(lid) = req.logo_asset_id {
            item.logo_asset_id = if lid.trim().is_empty() {
                None
            } else {
                Some(lid)
            };
        }
        if req.clear_outro {
            item.outro_asset_id = None;
        } else if let Some(oid) = req.outro_asset_id {
            item.outro_asset_id = if oid.trim().is_empty() {
                None
            } else {
                Some(oid)
            };
        }
        if let Some(ref explicit_s) = req.settings {
            item.use_custom_settings = req
                .use_custom_settings
                .unwrap_or(!explicit_s.overridden_tools.is_empty());
        } else if let Some(ucs) = req.use_custom_settings {
            item.use_custom_settings = ucs;
            if !ucs {
                if let Ok(p) = self.db.get_project(&item.project_id) {
                    let mut cleared = p.settings_json;
                    cleared.overridden_tools.clear();
                    let _ = self.db.update_project(
                        &item.project_id,
                        None,
                        None,
                        Some(&cleared),
                        None,
                        None,
                    );
                }
            }
        }

        item.updated_at = now_iso();
        self.db.update_batch_item(&item)?;
        self.sync_batch_item_project(&batch, &item, req.settings.as_ref())?;

        if source_changed && req.settings.is_none() {
            if let Ok(p) = self.db.get_project(&item.project_id) {
                let mut s = p.settings_json;
                s.crop.detected_face = None;
                s.crop.keyframes.clear();
                let _ =
                    self.db
                        .update_project(&item.project_id, None, Some("draft"), Some(&s), None, None);
            }
        }

        let _ = self.db.touch_batch(batch_id);
        self.get_batch_detail(batch_id)
    }

    pub fn apply_settings_to_batch_items(
        &self,
        batch_id: &str,
        req: BatchApplySettingsRequest,
    ) -> AppResult<BatchDetailResponse> {
        let mut batch = self.db.get_batch(batch_id)?;
        if req.update_shared {
            let mut master_clean = req.settings.clone();
            master_clean.overridden_tools.clear();
            batch = self
                .db
                .update_batch(batch_id, None, None, None, Some(&master_clean))?;
        }

        let target_set: HashSet<String> = req.item_ids.into_iter().collect();
        let items = self.db.list_batch_items(batch_id)?;

        for mut item in items {
            if target_set.contains(&item.id) {
                let mut adapted = req.settings.clone();
                // Reset per-video face detection cache so each video detects its own speaker during run!
                adapted.crop.detected_face = None;
                adapted.crop.keyframes.clear();
                if req.update_shared {
                    adapted.overridden_tools.clear();
                    item.use_custom_settings = false;
                } else {
                    if adapted.overridden_tools.is_empty() {
                        adapted.overridden_tools = vec![
                            "crop".into(),
                            "subtitles".into(),
                            "color".into(),
                            "audio".into(),
                            "logo".into(),
                            "outro".into(),
                            "output".into(),
                        ];
                    }
                    item.use_custom_settings = true;
                }
                item.updated_at = now_iso();
                self.db.update_batch_item(&item)?;
                self.sync_batch_item_project(&batch, &item, Some(&adapted))?;
            } else if req.update_shared {
                // Propagate updated Master Control to all non-overridden sibling items too!
                self.sync_batch_item_project(&batch, &item, None)?;
            }
        }

        let _ = self.db.touch_batch(batch_id);
        self.get_batch_detail(batch_id)
    }

    /// Launches automated processing for the selected ("required set") batch items!
    pub fn run_batch_automation(
        self: &Arc<Self>,
        batch_id: &str,
        req: BatchRunRequest,
    ) -> AppResult<BatchRunResponse> {
        let batch = self.db.get_batch(batch_id)?;
        let all_items = self.db.list_batch_items(batch_id)?;
        let filter_ids: Option<HashSet<String>> =
            req.item_ids.map(|v| v.into_iter().collect());

        let target_items: Vec<BatchItemRecord> = all_items
            .into_iter()
            .filter(|item| {
                if let Some(ref set) = filter_ids {
                    set.contains(&item.id)
                } else {
                    item.selected
                }
            })
            .collect();

        if target_items.is_empty() {
            return Err(AppError::validation(
                "EMPTY_BATCH_SELECTION",
                "Select at least one batch item in the required set before starting automation.",
            ));
        }

        // Validate every selected item has a source video
        for item in &target_items {
            if item.source_asset_id.is_none() {
                return Err(AppError::validation(
                    "MISSING_SOURCE_ASSET",
                    format!(
                        "Selected batch item '{}' does not have a source video assigned.",
                        item.title
                    ),
                ));
            }
        }

        let mut job_ids = Vec::new();
        let mut newly_queued_job_ids = Vec::new();
        let output_dir_path = batch.output_dir.as_ref().map(PathBuf::from);

        for item in target_items {
            self.sync_batch_item_project(&batch, &item, None)?;
            let proj = self.db.get_project(&item.project_id)?;

            // Skip already-completed items unless force_reexport is true or no output exists yet
            if !req.force_reexport && proj.status == "completed" {
                let has_out = self
                    .db
                    .find_ready_asset(&item.project_id, "output", None)?
                    .is_some();
                if has_out {
                    continue;
                }
            }

            // Skip if an active job is already queued or running on this item
            let existing_jobs = self.db.list_project_jobs(&item.project_id)?;
            if let Some(running) = existing_jobs
                .iter()
                .find(|j| !matches!(j.status.as_str(), "completed" | "failed" | "canceled"))
            {
                job_ids.push(running.id.clone());
                continue;
            }

            let now = now_iso();
            let job = ProcessingJobRecord {
                id: Uuid::new_v4().to_string(),
                project_id: item.project_id.clone(),
                kind: "batch_export".to_string(),
                status: "queued".to_string(),
                stage: "queued".to_string(),
                progress: Some(0.0),
                idempotency_key: None,
                settings_snapshot_json: serde_json::to_value(&proj.settings_json).ok(),
                subtitle_version: if proj.active_subtitle_version > 0 {
                    Some(proj.active_subtitle_version)
                } else {
                    None
                },
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
            self.db.update_project(
                &item.project_id,
                None,
                Some("processing"),
                None,
                None,
                None,
            )?;

            job_ids.push(job.id.clone());
            newly_queued_job_ids.push(job.id);
        }

        // Process queued batch exports strictly ONE BY ONE in exact row order (#1 -> #2 -> #3...)
        // so each finished MP4 becomes available immediately while subsequent rows wait cleanly in queue.
        if !newly_queued_job_ids.is_empty() {
            let engine_clone = Arc::clone(self);
            let out_dir_clone = output_dir_path.clone();
            tokio::spawn(async move {
                for jid in newly_queued_job_ids {
                    engine_clone
                        .execute_batch_export_job(&jid, out_dir_clone.clone())
                        .await;
                }
            });
        }

        let updated_detail = self.get_batch_detail(batch_id)?;
        Ok(BatchRunResponse {
            batch_id: batch_id.to_string(),
            launched_count: job_ids.len(),
            job_ids,
            batch: updated_detail,
        })
    }

    /// Executes an end-to-end automated batch item job strictly one-at-a-time via FIFO mutex:
    /// Optional Neural Auto Face Framing -> Optional Whisper AI Subtitles -> Trim/Crop/Color/Audio/Logo/ASS/Outro MP4 Export!
    pub(crate) async fn execute_batch_export_job(
        &self,
        job_id: &str,
        auto_copy_dir: Option<PathBuf>,
    ) {
        if self.is_job_canceled(job_id) {
            return;
        }
        let _fifo_guard = self.batch_export_mutex.lock().await;
        if self.is_job_canceled(job_id) {
            return;
        }
        let _permit = self.job_semaphore.acquire().await;
        if self.is_job_canceled(job_id) {
            return;
        }
        let Ok(job) = self.db.get_job(job_id) else {
            return;
        };
        let project_id = job.project_id.clone();

        let scratch_dir = self.data_dir.join("scratch").join(job_id);
        let _ = tokio::fs::create_dir_all(&scratch_dir).await;

        let res: AppResult<()> = async {
            if !self.set_job_stage(job_id, "validating", 0.06)? {
                return Ok(());
            }
            let mut proj = self.db.get_project(&project_id)?;
            let mut settings: EditSettings = job
                .settings_snapshot_json
                .clone()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_else(|| proj.settings_json.clone());

            if !self.set_job_stage(job_id, "probing", 0.12)? {
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

            let src_dur = src_meta.duration_ms.unwrap_or(0);
            // Clamp trim safely if needed
            let safe_start = settings.trim.start_ms.clamp(0, (src_dur - 200).max(0));
            let safe_end = settings
                .trim
                .end_ms
                .map(|e| e.clamp(safe_start + 200, src_dur));
            let (s_ms, e_ms) = validate_trim_range(safe_start, safe_end, src_dur)?;

            // Stage A: Automated Neural Speaker Face Framing per Video (if enabled)
            if settings.crop.enabled
                && settings.crop.auto_face_framing
                && settings.crop.detected_face.is_none()
            {
                if !self.set_job_stage(job_id, "auto_framing", 0.20)? {
                    return Ok(());
                }
                let af_scratch = scratch_dir.join("autoframe");
                let af_req = AutoFrameRequest {
                    aspect_ratio: settings.crop.aspect_ratio.clone(),
                    dynamic_tracking: settings.crop.dynamic_tracking,
                    target_zoom: Some(settings.crop.zoom),
                };
                if let Ok(af_resp) = analyze_video_auto_frame(
                    &src_path,
                    &src_meta,
                    s_ms,
                    Some(e_ms),
                    &af_req,
                    &af_scratch,
                )
                .await
                {
                    let prev_fit = settings.crop.fit_mode.clone();
                    settings.crop = af_resp.crop;
                    settings.crop.fit_mode = prev_fit;
                    proj = self.db.update_project(
                        &project_id,
                        None,
                        None,
                        Some(&settings),
                        None,
                        None,
                    )?;
                }
            }

            // Stage B: Automated Whisper AI Subtitle Generation per Video (if enabled & no cues yet)
            let mut active_sub_ver = job.subtitle_version.unwrap_or(proj.active_subtitle_version);
            if settings.subtitles.enabled {
                let existing_cues = self.db.count_subtitle_cues(&project_id, active_sub_ver)?;
                if existing_cues == 0 && src_meta.has_audio {
                    if !self.set_job_stage(job_id, "transcribing", 0.30)? {
                        return Ok(());
                    }
                    let stt_trim_path = scratch_dir.join("00_stt_trimmed.mp4");
                    let stt_meta = trim_video_segment(
                        &src_path,
                        &stt_trim_path,
                        s_ms,
                        e_ms,
                        &src_meta,
                        None,
                        Some(&settings.output),
                    )
                    .await?;
                    let wav_path = scratch_dir.join("00_speech_16k.wav");
                    extract_audio_for_transcription(
                        &stt_trim_path,
                        &wav_path,
                        Some(&settings.audio_enhancement),
                    )
                    .await?;
                    let stt_dur = stt_meta.duration_ms.unwrap_or(e_ms - s_ms);
                    let transcript = transcribe_audio_wav(
                        &wav_path,
                        stt_dur,
                        Some(&settings.subtitles.language),
                    )
                    .await?;

                    if self.is_job_canceled(job_id) {
                        return Ok(());
                    }

                    let next_ver = self.db.max_subtitle_version(&project_id)? + 1;
                    self.db
                        .insert_subtitle_version(&project_id, next_ver, &transcript.cues)?;
                    active_sub_ver = next_ver;
                    proj = self.db.update_project(
                        &project_id,
                        None,
                        None,
                        Some(&settings),
                        Some(next_ver),
                        Some(&transcript.language),
                    )?;
                }
            }

            // Stage C: Frame-Accurate Trim + Crop/Reframe
            if !self.set_job_stage(job_id, "trimming", 0.48)? {
                return Ok(());
            }
            let trimmed_path = scratch_dir.join("01_trimmed.mp4");
            let trimmed_meta = trim_video_segment(
                &src_path,
                &trimmed_path,
                s_ms,
                e_ms,
                &src_meta,
                Some(&settings.crop),
                Some(&settings.output),
            )
            .await?;

            // Stage D: Color Grade + Audio Clean + Brand Logo + ASS Subtitles
            if !self.set_job_stage(job_id, "rendering_main", 0.68)? {
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

            let ass_path_opt = if settings.subtitles.enabled && active_sub_ver > 0 {
                let cues = self.db.get_subtitle_cues(&project_id, active_sub_ver)?;
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

            // Stage E: Outro Normalization & Concatenation
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
                if !self.set_job_stage(job_id, "normalizing_outro", 0.80)? {
                    return Ok(());
                }
                let outro_src_path = self.storage.resolve_path(&outro_asset.storage_key)?;
                let norm_outro_path = scratch_dir.join("03_outro_norm.mp4");
                let joined_path = scratch_dir.join("04_joined_final.mp4");

                let _ = self.set_job_stage(job_id, "joining_outro", 0.88)?;
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

            if !self.set_job_stage(job_id, "validating_output", 0.94)? {
                return Ok(());
            }
            let out_meta = probe_video_file(&final_stage_file, false).await?;

            if !self.set_job_stage(job_id, "uploading_output", 0.98)? {
                return Ok(());
            }
            let safe_slug = StorageService::sanitize_filename(&proj.name);
            let out_filename = if safe_slug.to_lowercase().ends_with(".mp4") {
                safe_slug
            } else {
                format!("{safe_slug}.mp4")
            };
            let out_key = self
                .storage
                .generate_storage_key(&project_id, "output", &out_filename);
            let managed_out_path = self.storage.resolve_path(&out_key)?;
            if let Some(parent) = managed_out_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::copy(&final_stage_file, &managed_out_path).await?;

            if let Some(ref target_dir) = auto_copy_dir {
                if tokio::fs::create_dir_all(target_dir).await.is_ok() {
                    let dest = target_dir.join(&out_filename);
                    let _ = tokio::fs::copy(&managed_out_path, &dest).await;
                }
            }

            let p_clone = managed_out_path.clone();
            let checksum = tokio::task::spawn_blocking(move || {
                StorageService::compute_sha256_prefix(&p_clone)
            })
            .await
            .ok()
            .flatten();

            let prev_assets = self.db.list_project_assets(&project_id)?;
            for old in prev_assets {
                if old.kind == "output" {
                    self.remove_asset_row_and_unref_storage(&old);
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
            final_job.subtitle_version = if active_sub_ver > 0 {
                Some(active_sub_ver)
            } else {
                None
            };
            final_job.output_asset_id = Some(out_asset_id.clone());
            final_job.finished_at = Some(now_iso());
            final_job.updated_at = now_iso();
            self.db.update_job(&final_job)?;

            info!(
                job_id = job_id,
                output_asset_id = %out_asset_id,
                "batch_export_job_completed"
            );
            Ok(())
        }
        .await;

        let _ = tokio::fs::remove_dir_all(&scratch_dir).await;
        if let Err(err) = res {
            self.fail_job(job_id, &project_id, err);
        }
    }

    /// Copies rendered MP4 outputs for completed selected batch items into a local destination folder.
    pub async fn export_batch_outputs_to_folder(
        &self,
        batch_id: &str,
        req: BatchExportFolderRequest,
    ) -> AppResult<BatchExportFolderResponse> {
        let _ = self.db.get_batch(batch_id)?;
        let raw_dest = req.dest_dir.trim();
        if raw_dest.is_empty() {
            return Err(AppError::validation(
                "INVALID_DEST_DIR",
                "Please specify a valid destination folder.",
            ));
        }
        let dest_dir = PathBuf::from(raw_dest);
        tokio::fs::create_dir_all(&dest_dir).await?;

        let items = self.db.list_batch_items(batch_id)?;
        let filter_set: Option<HashSet<String>> = req.item_ids.map(|v| v.into_iter().collect());

        let mut used_names: HashSet<String> = HashSet::new();
        let mut exported_files = Vec::new();

        for item in items {
            let include = if let Some(ref set) = filter_set {
                set.contains(&item.id)
            } else {
                item.selected
            };
            if !include {
                continue;
            }

            if let Some(out_asset) = self.db.find_ready_asset(&item.project_id, "output", None)? {
                let src_path = self.storage.resolve_path(&out_asset.storage_key)?;
                if !src_path.is_file() {
                    continue;
                }
                let base_stem = StorageService::sanitize_filename(&item.title);
                let stem = base_stem.trim_end_matches(".mp4");
                let mut candidate = format!("{stem}.mp4");
                let mut suffix = 2usize;
                while used_names.contains(&candidate.to_lowercase()) {
                    candidate = format!("{stem}_{suffix}.mp4");
                    suffix += 1;
                }
                used_names.insert(candidate.to_lowercase());

                let target_path = dest_dir.join(&candidate);
                tokio::fs::copy(&src_path, &target_path).await?;
                exported_files.push(target_path.to_string_lossy().into_owned());
            }
        }

        if exported_files.is_empty() {
            return Err(AppError::validation(
                "NO_COMPLETED_OUTPUTS",
                "None of the selected batch items have completed MP4 outputs yet.",
            ));
        }

        Ok(BatchExportFolderResponse {
            exported_count: exported_files.len(),
            dest_dir: dest_dir.to_string_lossy().into_owned(),
            files: exported_files,
        })
    }

    /// Generates an instant multi-asset sample Batch Automation workspace (3 Videos, 2 Logos, 2 Outros)
    /// pre-mapped 1-to-1 so users can test multi-video / multi-logo / multi-outro pairing immediately.
    pub async fn create_demo_batch(&self) -> AppResult<BatchDetailResponse> {
        let batch_detail = self.create_batch("Sample Multi-Brand Automation")?;
        let batch_id = batch_detail.id.clone();
        let lib_proj_id = batch_detail.library_project_id.clone();

        let sample_candidates = self.sample_dir.clone().or_else(|| {
            let cwd_sample = PathBuf::from("sample");
            if cwd_sample.is_dir() {
                Some(cwd_sample)
            } else {
                None
            }
        });

        let mut video_ids = Vec::new();
        let mut logo_ids = Vec::new();
        let mut outro_ids = Vec::new();

        if let Some(ref sdir) = sample_candidates {
            let vid = sdir.join("vid.mp4");
            let logo = sdir.join("Logo _sam.png");
            let outro = sdir.join("outro.mp4");
            if vid.is_file() {
                if let Ok(a) = self
                    .import_local_asset_to_batch_pool(&batch_id, "source", &vid)
                    .await
                {
                    video_ids.push(a.id);
                }
            }
            if logo.is_file() {
                if let Ok(a) = self
                    .import_local_asset_to_batch_pool(&batch_id, "logo", &logo)
                    .await
                {
                    logo_ids.push(a.id);
                }
            }
            if outro.is_file() {
                if let Ok(a) = self
                    .import_local_asset_to_batch_pool(&batch_id, "outro", &outro)
                    .await
                {
                    outro_ids.push(a.id);
                }
            }
        }

        // Top up pool to 3 Videos, 2 Logos, 2 Outros with fast synthetic HD clips
        while video_ids.len() < 3 {
            let idx = video_ids.len() + 1;
            let fname = format!("episode_clip_{idx}.mp4");
            let key = self
                .storage
                .generate_storage_key(&lib_proj_id, "source", &fname);
            let path = self.storage.resolve_path(&key)?;
            generate_synthetic_video(&path, 3.5, 1280, 720, 30, true, 200 + (idx as u32) * 55)
                .await?;
            let asset = self
                .insert_generated_pool_asset(&lib_proj_id, "source", key, &fname)
                .await?;
            video_ids.push(asset.id);
        }

        if logo_ids.is_empty() {
            let fname = "brand_logo.png".to_string();
            let key = self
                .storage
                .generate_storage_key(&lib_proj_id, "logo", &fname);
            let path = self.storage.resolve_path(&key)?;
            tokio::task::spawn_blocking(move || generate_synthetic_logo(&path, 320, 96))
                .await
                .map_err(|e| {
                    AppError::internal("LOGO_GEN_FAILED", "Logo task failed.", e.to_string())
                })??;
            let asset = self
                .insert_generated_pool_asset(&lib_proj_id, "logo", key, &fname)
                .await?;
            logo_ids.push(asset.id);
        }

        if outro_ids.is_empty() {
            let fname = "brand_outro.mp4".to_string();
            let key = self
                .storage
                .generate_storage_key(&lib_proj_id, "outro", &fname);
            let path = self.storage.resolve_path(&key)?;
            generate_synthetic_video(&path, 1.8, 1280, 720, 30, true, 380).await?;
            let asset = self
                .insert_generated_pool_asset(&lib_proj_id, "outro", key, &fname)
                .await?;
            outro_ids.push(asset.id);
        }

        let single_logo_id = logo_ids.first().cloned();
        let single_outro_id = outro_ids.first().cloned();

        let specs = video_ids
            .iter()
            .enumerate()
            .map(|(i, vid_id)| crate::models::BatchItemSpec {
                id: None,
                selected: true,
                title: Some(format!("Episode Clip {}", i + 1)),
                source_asset_id: Some(vid_id.clone()),
                logo_asset_id: single_logo_id.clone(),
                outro_asset_id: single_outro_id.clone(),
                use_custom_settings: Some(false),
            })
            .collect();

        self.set_batch_items(
            &batch_id,
            BatchSetItemsRequest {
                mapping_mode: Some("many_videos_one_brand".to_string()),
                items: specs,
            },
        )
    }

    async fn insert_generated_pool_asset(
        &self,
        lib_proj_id: &str,
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
            project_id: lib_proj_id.to_string(),
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
        Ok(self.decorate_asset(asset))
    }
}
