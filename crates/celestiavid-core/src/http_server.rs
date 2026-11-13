use crate::engine::CelestiaEngine;
use crate::error::{AppError, AppResult};
use crate::media::probe::MAX_UPLOAD_BYTES;
use crate::models::{
    AutoFrameRequest, AutoFrameResponse, BackupInfo, BatchApplySettingsRequest, BatchCreateRequest,
    BatchDetailResponse, BatchExportFolderRequest, BatchExportFolderResponse,
    BatchFolderImportRequest, BatchFolderImportResponse, BatchItemUpdateRequest, BatchRunRequest,
    BatchRunResponse, BatchSetItemsRequest, BatchSummaryResponse, BatchUpdateRequest,
    CapabilitiesResponse, CreateBackupRequest, DownloadUrlResponse, ExportCreateRequest,
    FolderScanRequest, FolderScanResponse, ProcessingJobRecord, ProjectCreateRequest,
    ProjectDetailResponse, ProjectUpdateRequest, RestoreBackupResponse, SubtitleVersionResponse,
    SubtitleVersionUpdateRequest, SystemVersionResponse, TranscriptionCreateRequest,
    UpdateCheckResponse, UpdateProgressState, UploadCompleteRequest, UploadUrlRequest,
    UploadUrlResponse,
};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[derive(Debug, Deserialize)]
pub struct TokenQuery {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub download: Option<String>,
}

pub fn build_router(engine: Arc<CelestiaEngine>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_DISPOSITION,
        ]);

    Router::new()
        .route("/health", get(health_handler))
        .route("/api/v1/config/capabilities", get(get_capabilities_handler))
        .route(
            "/api/v1/projects",
            get(list_projects_handler).post(create_project_handler),
        )
        .route("/api/v1/projects/demo", post(create_demo_project_handler))
        .route(
            "/api/v1/projects/{project_id}",
            get(get_project_handler)
                .patch(update_project_handler)
                .delete(delete_project_handler),
        )
        .route(
            "/api/v1/projects/{project_id}/assets/upload-url",
            post(create_upload_url_handler),
        )
        .route(
            "/api/v1/assets/{asset_id}/upload",
            put(upload_binary_handler).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES as usize)),
        )
        .route(
            "/api/v1/projects/{project_id}/assets/complete",
            post(complete_upload_handler),
        )
        .route("/api/v1/assets/{asset_id}", delete(delete_asset_handler))
        .route(
            "/api/v1/assets/{asset_id}/download-url",
            post(create_download_url_handler),
        )
        .route(
            "/api/v1/assets/{asset_id}/download",
            get(stream_asset_download_handler),
        )
        .route(
            "/api/v1/projects/{project_id}/transcriptions",
            post(start_transcription_handler),
        )
        .route(
            "/api/v1/projects/{project_id}/auto-frame",
            post(auto_frame_project_handler),
        )
        .route(
            "/api/v1/projects/{project_id}/subtitle-versions/{version}",
            get(get_subtitle_version_handler).put(save_subtitle_version_handler),
        )
        .route(
            "/api/v1/projects/{project_id}/subtitle-versions/{version}/srt",
            get(export_srt_handler),
        )
        .route(
            "/api/v1/projects/{project_id}/exports",
            post(start_export_handler),
        )
        .route("/api/v1/jobs/{job_id}", get(get_job_handler))
        .route("/api/v1/jobs/{job_id}/cancel", post(cancel_job_handler))
        .route("/api/v1/jobs/{job_id}/retry", post(retry_job_handler))
        .route("/api/v1/fs/scan-folder", post(scan_folder_handler))
        .route(
            "/api/v1/batches",
            get(list_batches_handler).post(create_batch_handler),
        )
        .route("/api/v1/batches/demo", post(create_demo_batch_handler))
        .route(
            "/api/v1/batches/{batch_id}",
            get(get_batch_handler)
                .patch(update_batch_handler)
                .delete(delete_batch_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/assets/upload-url",
            post(create_batch_pool_upload_url_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/assets/complete",
            post(complete_batch_pool_upload_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/assets/{asset_id}",
            delete(delete_batch_pool_asset_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/import-folder",
            post(import_folder_to_batch_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/items",
            put(set_batch_items_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/items/{item_id}",
            patch_only_item_route(),
        )
        .route(
            "/api/v1/batches/{batch_id}/apply-settings",
            post(apply_settings_to_batch_items_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/run",
            post(run_batch_automation_handler),
        )
        .route(
            "/api/v1/batches/{batch_id}/export-folder",
            post(export_batch_outputs_to_folder_handler),
        )
        .route("/api/v1/system/version", get(get_system_version_handler))
        .route("/api/v1/system/update-check", get(check_for_updates_handler))
        .route("/api/v1/system/update", post(start_app_update_handler))
        .route("/api/v1/system/update-status", get(get_update_status_handler))
        .route("/api/v1/system/restart", post(apply_update_restart_handler))
        .route(
            "/api/v1/system/backups",
            get(list_backups_handler).post(create_backup_handler),
        )
        .route(
            "/api/v1/system/backups/{backup_id}",
            delete(delete_backup_handler),
        )
        .route(
            "/api/v1/system/backups/{backup_id}/restore",
            post(restore_backup_handler),
        )
        .layer(cors)
        .with_state(engine)
}

fn patch_only_item_route() -> axum::routing::MethodRouter<Arc<CelestiaEngine>> {
    axum::routing::patch(update_batch_item_handler)
}

/// Spawns an ephemeral loopback HTTP range server (`127.0.0.1:0`) for Tauri Desktop
/// so `<video crossOrigin="anonymous">` seeking (`206 Partial Content`) and Web Audio API
/// work identically across Linux WebKitGTK, macOS WKWebView, and Windows WebView2.
pub async fn spawn_ephemeral_media_server(engine: Arc<CelestiaEngine>) -> AppResult<SocketAddr> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    engine.set_media_base_url(format!("http://127.0.0.1:{}", addr.port()));
    let router = build_router(engine);

    info!(port = addr.port(), "spawned_tauri_loopback_media_range_server");
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            tracing::error!(error = %err, "loopback_media_server_stopped");
        }
    });

    Ok(addr)
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "celestiavid-rust-core",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn get_capabilities_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> Json<CapabilitiesResponse> {
    Json(engine.get_capabilities())
}

async fn list_projects_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<Json<Vec<ProjectDetailResponse>>> {
    Ok(Json(engine.list_projects()?))
}

async fn create_project_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Json(req): Json<ProjectCreateRequest>,
) -> AppResult<(StatusCode, Json<ProjectDetailResponse>)> {
    let proj = engine.create_project(&req.name)?;
    Ok((StatusCode::CREATED, Json(proj)))
}

async fn create_demo_project_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<(StatusCode, Json<ProjectDetailResponse>)> {
    let proj = engine.create_demo_project().await?;
    Ok((StatusCode::CREATED, Json(proj)))
}

async fn get_project_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
) -> AppResult<Json<ProjectDetailResponse>> {
    Ok(Json(engine.get_project_detail(&project_id)?))
}

async fn update_project_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
    Json(req): Json<ProjectUpdateRequest>,
) -> AppResult<Json<ProjectDetailResponse>> {
    Ok(Json(engine.update_project(&project_id, req)?))
}

async fn delete_project_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
) -> AppResult<StatusCode> {
    engine.delete_project(&project_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_upload_url_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
    Json(req): Json<UploadUrlRequest>,
) -> AppResult<Json<UploadUrlResponse>> {
    Ok(Json(engine.create_upload_url(&project_id, req)?))
}

async fn upload_binary_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(asset_id): Path<String>,
    Query(query): Query<TokenQuery>,
    body: Bytes,
) -> AppResult<Json<serde_json::Value>> {
    engine
        .write_upload_bytes(&asset_id, query.token.as_deref(), true, &body)
        .await?;
    Ok(Json(json!({ "uploaded": true, "bytes": body.len() })))
}

async fn complete_upload_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
    Json(req): Json<UploadCompleteRequest>,
) -> AppResult<Json<crate::models::AssetRecord>> {
    let asset = engine.complete_upload(&project_id, &req.asset_id).await?;
    Ok(Json(asset))
}

async fn delete_asset_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(asset_id): Path<String>,
) -> AppResult<StatusCode> {
    engine.delete_asset(&asset_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_download_url_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(asset_id): Path<String>,
) -> AppResult<Json<DownloadUrlResponse>> {
    Ok(Json(engine.create_download_url(&asset_id)?))
}

fn parse_byte_range(range_header: &str, total_len: u64) -> Option<(u64, u64)> {
    let spec = range_header.strip_prefix("bytes=")?;
    let first_range = spec.split(',').next()?.trim();
    let (start_s, end_s) = first_range.split_once('-')?;

    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 || total_len == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        Some((start, total_len - 1))
    } else {
        let start: u64 = start_s.parse().ok()?;
        if start >= total_len {
            return None;
        }
        let end = if end_s.is_empty() {
            total_len - 1
        } else {
            end_s.parse::<u64>().ok()?.min(total_len - 1)
        };
        if end < start {
            return None;
        }
        Some((start, end))
    }
}

async fn stream_asset_download_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(asset_id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let token = query.token.as_deref().unwrap_or_default();
    let (asset, path) = engine.resolve_asset_download(&asset_id, token)?;
    let meta = tokio::fs::metadata(&path).await?;
    let total_len = meta.len();

    if total_len == 0 {
        return Err(AppError::not_found("Asset file is empty."));
    }

    let disposition_type = if query.download.as_deref() == Some("1") {
        "attachment"
    } else {
        "inline"
    };
    let safe_name = crate::storage::StorageService::sanitize_filename(&asset.original_filename);
    let content_disp = format!("{disposition_type}; filename=\"{safe_name}\"");

    let range_hdr = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());

    let (status, start, end) = if let Some(raw_range) = range_hdr {
        match parse_byte_range(raw_range, total_len) {
            Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
            None => {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [(header::CONTENT_RANGE, format!("bytes */{total_len}"))],
                    Body::empty(),
                )
                    .into_response());
            }
        }
    } else {
        (StatusCode::OK, 0, total_len - 1)
    };

    let chunk_len = end - start + 1;
    let mut file = tokio::fs::File::open(&path).await?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }

    let limited_reader = file.take(chunk_len);
    let stream = futures_util::stream::unfold(limited_reader, |mut reader| async move {
        let mut buf = vec![0u8; 65536];
        match reader.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<Bytes, std::io::Error>(Bytes::from(buf)), reader))
            }
            Err(e) => Some((Err(e), reader)),
        }
    });

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, asset.mime_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, chunk_len.to_string())
        .header(header::CONTENT_DISPOSITION, content_disp);

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total_len}"),
        );
    }

    builder.body(Body::from_stream(stream)).map_err(|e| {
        AppError::internal(
            "STREAM_BUILD_ERROR",
            "Failed to build HTTP stream response.",
            e.to_string(),
        )
    })
}

async fn start_transcription_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
    Json(req): Json<TranscriptionCreateRequest>,
) -> AppResult<(StatusCode, Json<ProcessingJobRecord>)> {
    let job = engine.start_transcription(&project_id, req)?;
    Ok((StatusCode::ACCEPTED, Json(job)))
}

async fn get_subtitle_version_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path((project_id, version)): Path<(String, i64)>,
) -> AppResult<Json<SubtitleVersionResponse>> {
    Ok(Json(engine.get_subtitle_version(&project_id, version)?))
}

async fn save_subtitle_version_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path((project_id, version)): Path<(String, i64)>,
    Json(req): Json<SubtitleVersionUpdateRequest>,
) -> AppResult<Json<SubtitleVersionResponse>> {
    Ok(Json(engine.save_subtitle_version(&project_id, version, req)?))
}

async fn export_srt_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path((project_id, version)): Path<(String, i64)>,
) -> AppResult<Response> {
    let (filename, srt) = engine.export_subtitles_srt(&project_id, version)?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-subrip; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from(srt))
        .map_err(|e| {
            AppError::internal("SRT_EXPORT_ERROR", "Failed to build SRT response.", e.to_string())
        })
}

async fn start_export_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
    Json(req): Json<ExportCreateRequest>,
) -> AppResult<(StatusCode, Json<ProcessingJobRecord>)> {
    let job = engine.start_export(&project_id, req)?;
    Ok((StatusCode::ACCEPTED, Json(job)))
}

async fn auto_frame_project_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(project_id): Path<String>,
    Json(req): Json<AutoFrameRequest>,
) -> AppResult<Json<AutoFrameResponse>> {
    let resp = engine.auto_frame_project(&project_id, req).await?;
    Ok(Json(resp))
}

async fn get_job_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(job_id): Path<String>,
) -> AppResult<Json<ProcessingJobRecord>> {
    Ok(Json(engine.get_job(&job_id)?))
}

async fn cancel_job_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(job_id): Path<String>,
) -> AppResult<Json<ProcessingJobRecord>> {
    Ok(Json(engine.cancel_job(&job_id)?))
}

async fn retry_job_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(job_id): Path<String>,
) -> AppResult<Json<ProcessingJobRecord>> {
    Ok(Json(engine.retry_job(&job_id)?))
}

async fn scan_folder_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Json(req): Json<FolderScanRequest>,
) -> AppResult<Json<FolderScanResponse>> {
    Ok(Json(engine.scan_local_folder(req)?))
}

async fn list_batches_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<Json<Vec<BatchSummaryResponse>>> {
    Ok(Json(engine.list_batches()?))
}

async fn create_batch_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Json(req): Json<BatchCreateRequest>,
) -> AppResult<(StatusCode, Json<BatchDetailResponse>)> {
    let batch = engine.create_batch(&req.name)?;
    Ok((StatusCode::CREATED, Json(batch)))
}

async fn create_demo_batch_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<(StatusCode, Json<BatchDetailResponse>)> {
    let batch = engine.create_demo_batch().await?;
    Ok((StatusCode::CREATED, Json(batch)))
}

async fn get_batch_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
) -> AppResult<Json<BatchDetailResponse>> {
    Ok(Json(engine.get_batch_detail(&batch_id)?))
}

async fn update_batch_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<BatchUpdateRequest>,
) -> AppResult<Json<BatchDetailResponse>> {
    Ok(Json(engine.update_batch(&batch_id, req)?))
}

async fn delete_batch_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
) -> AppResult<StatusCode> {
    engine.delete_batch(&batch_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_batch_pool_upload_url_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<UploadUrlRequest>,
) -> AppResult<Json<UploadUrlResponse>> {
    Ok(Json(engine.create_batch_pool_upload_url(&batch_id, req)?))
}

async fn complete_batch_pool_upload_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<UploadCompleteRequest>,
) -> AppResult<Json<crate::models::AssetRecord>> {
    let asset = engine
        .complete_batch_pool_upload(&batch_id, &req.asset_id)
        .await?;
    Ok(Json(asset))
}

async fn delete_batch_pool_asset_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path((batch_id, asset_id)): Path<(String, String)>,
) -> AppResult<Json<BatchDetailResponse>> {
    Ok(Json(engine.delete_batch_pool_asset(&batch_id, &asset_id)?))
}

async fn import_folder_to_batch_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<BatchFolderImportRequest>,
) -> AppResult<Json<BatchFolderImportResponse>> {
    Ok(Json(engine.import_folder_items_to_batch(&batch_id, req).await?))
}

async fn set_batch_items_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<BatchSetItemsRequest>,
) -> AppResult<Json<BatchDetailResponse>> {
    Ok(Json(engine.set_batch_items(&batch_id, req)?))
}

async fn update_batch_item_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path((batch_id, item_id)): Path<(String, String)>,
    Json(req): Json<BatchItemUpdateRequest>,
) -> AppResult<Json<BatchDetailResponse>> {
    Ok(Json(engine.update_batch_item(&batch_id, &item_id, req)?))
}

async fn apply_settings_to_batch_items_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<BatchApplySettingsRequest>,
) -> AppResult<Json<BatchDetailResponse>> {
    Ok(Json(engine.apply_settings_to_batch_items(&batch_id, req)?))
}

async fn run_batch_automation_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<BatchRunRequest>,
) -> AppResult<(StatusCode, Json<BatchRunResponse>)> {
    let resp = engine.run_batch_automation(&batch_id, req)?;
    Ok((StatusCode::ACCEPTED, Json(resp)))
}

async fn export_batch_outputs_to_folder_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(batch_id): Path<String>,
    Json(req): Json<BatchExportFolderRequest>,
) -> AppResult<Json<BatchExportFolderResponse>> {
    Ok(Json(engine.export_batch_outputs_to_folder(&batch_id, req).await?))
}

async fn get_system_version_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> Json<SystemVersionResponse> {
    Json(engine.get_system_version())
}

async fn check_for_updates_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<Json<UpdateCheckResponse>> {
    Ok(Json(engine.check_for_updates().await?))
}

async fn start_app_update_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<(StatusCode, Json<UpdateProgressState>)> {
    let state = engine.start_app_update()?;
    Ok((StatusCode::ACCEPTED, Json(state)))
}

async fn get_update_status_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> Json<UpdateProgressState> {
    Json(engine.get_update_status())
}

async fn apply_update_restart_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<Json<serde_json::Value>> {
    engine.trigger_post_update_helper()?;
    Ok(Json(json!({ "restarting": true, "mode": "http" })))
}

async fn list_backups_handler(
    State(engine): State<Arc<CelestiaEngine>>,
) -> AppResult<Json<Vec<BackupInfo>>> {
    Ok(Json(engine.list_backups()?))
}

async fn create_backup_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Json(req): Json<CreateBackupRequest>,
) -> AppResult<(StatusCode, Json<BackupInfo>)> {
    let info = tokio::task::spawn_blocking(move || engine.create_backup(req))
        .await
        .map_err(|e| {
            AppError::internal(
                "BACKUP_WORKER_ERROR",
                "Backup worker failed.",
                e.to_string(),
            )
        })??;
    Ok((StatusCode::CREATED, Json(info)))
}

async fn restore_backup_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(backup_id): Path<String>,
) -> AppResult<Json<RestoreBackupResponse>> {
    let resp = tokio::task::spawn_blocking(move || engine.restore_backup(&backup_id))
        .await
        .map_err(|e| {
            AppError::internal(
                "RESTORE_WORKER_ERROR",
                "Restore worker failed.",
                e.to_string(),
            )
        })??;
    Ok(Json(resp))
}

async fn delete_backup_handler(
    State(engine): State<Arc<CelestiaEngine>>,
    Path(backup_id): Path<String>,
) -> AppResult<StatusCode> {
    engine.delete_backup(&backup_id)?;
    Ok(StatusCode::NO_CONTENT)
}
