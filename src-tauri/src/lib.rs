use celestiavid_core::{
    http_server::spawn_ephemeral_media_server,
    models::{
        AssetRecord, AutoFrameRequest, AutoFrameResponse, BackupInfo, BatchApplySettingsRequest,
        BatchDetailResponse, BatchExportFolderRequest, BatchExportFolderResponse,
        BatchFolderImportRequest, BatchFolderImportResponse, BatchItemUpdateRequest,
        BatchRunRequest, BatchRunResponse, BatchSetItemsRequest, BatchSummaryResponse,
        BatchUpdateRequest, CapabilitiesResponse, CreateBackupRequest, DownloadUrlResponse,
        EditSettings, ExportCreateRequest, FolderScanRequest, FolderScanResponse,
        ProcessingJobRecord, ProjectDetailResponse, ProjectUpdateRequest, RestoreBackupResponse,
        SubtitleCueItem, SubtitleVersionResponse, SubtitleVersionUpdateRequest,
        SystemVersionResponse, TranscriptionCreateRequest, UpdateCheckResponse,
        UpdateProgressState, UploadUrlRequest,
    },
    AppError, CelestiaEngine,
};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tracing_subscriber::EnvFilter;

#[tauri::command]
fn get_capabilities(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<CapabilitiesResponse, AppError> {
    Ok(engine.get_capabilities())
}

#[tauri::command]
fn list_projects(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<Vec<ProjectDetailResponse>, AppError> {
    engine.list_projects()
}

#[tauri::command]
fn create_project(
    engine: State<'_, Arc<CelestiaEngine>>,
    name: String,
) -> Result<ProjectDetailResponse, AppError> {
    engine.create_project(&name)
}

#[tauri::command]
async fn create_demo_project(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<ProjectDetailResponse, AppError> {
    engine.create_demo_project().await
}

#[tauri::command]
fn get_project(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
) -> Result<ProjectDetailResponse, AppError> {
    engine.get_project_detail(&project_id)
}

#[tauri::command]
fn update_project(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    name: Option<String>,
    settings: Option<EditSettings>,
) -> Result<ProjectDetailResponse, AppError> {
    engine.update_project(&project_id, ProjectUpdateRequest { name, settings })
}

#[tauri::command]
fn delete_project(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
) -> Result<(), AppError> {
    engine.delete_project(&project_id)
}

#[tauri::command]
async fn import_local_asset(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    kind: String,
    local_path: String,
) -> Result<AssetRecord, AppError> {
    engine
        .import_local_asset(&project_id, &kind, &PathBuf::from(local_path))
        .await
}

#[tauri::command]
async fn upload_asset_bytes(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    kind: String,
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
) -> Result<AssetRecord, AppError> {
    let url_resp = engine.create_upload_url(
        &project_id,
        UploadUrlRequest {
            kind,
            filename,
            content_type,
            size_bytes: bytes.len() as u64,
        },
    )?;
    engine
        .write_upload_bytes(&url_resp.asset_id, None, false, &bytes)
        .await?;
    engine.complete_upload(&project_id, &url_resp.asset_id).await
}

#[tauri::command]
fn delete_asset(
    engine: State<'_, Arc<CelestiaEngine>>,
    asset_id: String,
) -> Result<(), AppError> {
    engine.delete_asset(&asset_id)
}

#[tauri::command]
fn get_signed_download_url(
    engine: State<'_, Arc<CelestiaEngine>>,
    asset_id: String,
) -> Result<DownloadUrlResponse, AppError> {
    engine.create_download_url(&asset_id)
}

#[tauri::command]
async fn save_asset_to_path(
    engine: State<'_, Arc<CelestiaEngine>>,
    asset_id: String,
    dest_path: String,
) -> Result<u64, AppError> {
    engine
        .save_asset_to_path(&asset_id, &PathBuf::from(dest_path))
        .await
}

#[tauri::command]
async fn start_transcription(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    language: String,
    confirm_overwrite: bool,
) -> Result<ProcessingJobRecord, AppError> {
    engine.start_transcription(
        &project_id,
        TranscriptionCreateRequest {
            language,
            confirm_overwrite,
        },
    )
}

#[tauri::command]
fn get_subtitle_version(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    version: i64,
) -> Result<SubtitleVersionResponse, AppError> {
    engine.get_subtitle_version(&project_id, version)
}

#[tauri::command]
fn save_subtitle_version(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    version: i64,
    language: String,
    cues: Vec<SubtitleCueItem>,
) -> Result<SubtitleVersionResponse, AppError> {
    engine.save_subtitle_version(
        &project_id,
        version,
        SubtitleVersionUpdateRequest { language, cues },
    )
}

#[tauri::command]
async fn save_srt_to_path(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    version: i64,
    dest_path: String,
) -> Result<u64, AppError> {
    engine
        .save_srt_to_path(&project_id, version, &PathBuf::from(dest_path))
        .await
}

#[tauri::command]
async fn start_export(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    subtitle_version: Option<i64>,
    idempotency_key: Option<String>,
) -> Result<ProcessingJobRecord, AppError> {
    engine.start_export(
        &project_id,
        ExportCreateRequest {
            subtitle_version,
            idempotency_key,
        },
    )
}

#[tauri::command]
async fn auto_frame_project(
    engine: State<'_, Arc<CelestiaEngine>>,
    project_id: String,
    aspect_ratio: String,
    dynamic_tracking: bool,
    target_zoom: Option<f64>,
) -> Result<AutoFrameResponse, AppError> {
    engine
        .auto_frame_project(
            &project_id,
            AutoFrameRequest {
                aspect_ratio,
                dynamic_tracking,
                target_zoom,
            },
        )
        .await
}

#[tauri::command]
fn get_job(
    engine: State<'_, Arc<CelestiaEngine>>,
    job_id: String,
) -> Result<ProcessingJobRecord, AppError> {
    engine.get_job(&job_id)
}

#[tauri::command]
fn cancel_job(
    engine: State<'_, Arc<CelestiaEngine>>,
    job_id: String,
) -> Result<ProcessingJobRecord, AppError> {
    engine.cancel_job(&job_id)
}

#[tauri::command]
async fn retry_job(
    engine: State<'_, Arc<CelestiaEngine>>,
    job_id: String,
) -> Result<ProcessingJobRecord, AppError> {
    engine.retry_job(&job_id)
}

#[tauri::command]
fn list_batches(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<Vec<BatchSummaryResponse>, AppError> {
    engine.list_batches()
}

#[tauri::command]
fn create_batch(
    engine: State<'_, Arc<CelestiaEngine>>,
    name: String,
) -> Result<BatchDetailResponse, AppError> {
    engine.create_batch(&name)
}

#[tauri::command]
async fn create_demo_batch(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<BatchDetailResponse, AppError> {
    engine.create_demo_batch().await
}

#[tauri::command]
fn get_batch(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
) -> Result<BatchDetailResponse, AppError> {
    engine.get_batch_detail(&batch_id)
}

#[tauri::command]
fn update_batch(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    req: BatchUpdateRequest,
) -> Result<BatchDetailResponse, AppError> {
    engine.update_batch(&batch_id, req)
}

#[tauri::command]
fn delete_batch(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
) -> Result<(), AppError> {
    engine.delete_batch(&batch_id)
}

#[tauri::command]
async fn import_local_asset_to_batch_pool(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    kind: String,
    local_path: String,
) -> Result<AssetRecord, AppError> {
    engine
        .import_local_asset_to_batch_pool(&batch_id, &kind, &PathBuf::from(local_path))
        .await
}

#[tauri::command]
async fn upload_batch_pool_asset_bytes(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    kind: String,
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
) -> Result<AssetRecord, AppError> {
    let url_resp = engine.create_batch_pool_upload_url(
        &batch_id,
        UploadUrlRequest {
            kind,
            filename,
            content_type,
            size_bytes: bytes.len() as u64,
        },
    )?;
    engine
        .write_upload_bytes(&url_resp.asset_id, None, false, &bytes)
        .await?;
    engine
        .complete_batch_pool_upload(&batch_id, &url_resp.asset_id)
        .await
}

#[tauri::command]
fn delete_batch_pool_asset(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    asset_id: String,
) -> Result<BatchDetailResponse, AppError> {
    engine.delete_batch_pool_asset(&batch_id, &asset_id)
}

#[tauri::command]
fn scan_local_folder(
    engine: State<'_, Arc<CelestiaEngine>>,
    req: FolderScanRequest,
) -> Result<FolderScanResponse, AppError> {
    engine.scan_local_folder(req)
}

#[tauri::command]
async fn import_folder_items_to_batch(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    req: BatchFolderImportRequest,
) -> Result<BatchFolderImportResponse, AppError> {
    engine.import_folder_items_to_batch(&batch_id, req).await
}

#[tauri::command]
fn set_batch_items(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    req: BatchSetItemsRequest,
) -> Result<BatchDetailResponse, AppError> {
    engine.set_batch_items(&batch_id, req)
}

#[tauri::command]
fn update_batch_item(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    item_id: String,
    req: BatchItemUpdateRequest,
) -> Result<BatchDetailResponse, AppError> {
    engine.update_batch_item(&batch_id, &item_id, req)
}

#[tauri::command]
fn apply_settings_to_batch_items(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    req: BatchApplySettingsRequest,
) -> Result<BatchDetailResponse, AppError> {
    engine.apply_settings_to_batch_items(&batch_id, req)
}

#[tauri::command]
fn run_batch_automation(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    req: BatchRunRequest,
) -> Result<BatchRunResponse, AppError> {
    engine.run_batch_automation(&batch_id, req)
}

#[tauri::command]
async fn export_batch_outputs_to_folder(
    engine: State<'_, Arc<CelestiaEngine>>,
    batch_id: String,
    req: BatchExportFolderRequest,
) -> Result<BatchExportFolderResponse, AppError> {
    engine.export_batch_outputs_to_folder(&batch_id, req).await
}

#[tauri::command]
fn get_system_version(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<SystemVersionResponse, AppError> {
    Ok(engine.get_system_version())
}

#[tauri::command]
async fn check_for_updates(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<UpdateCheckResponse, AppError> {
    engine.check_for_updates().await
}

#[tauri::command]
fn start_app_update(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<UpdateProgressState, AppError> {
    engine.start_app_update()
}

#[tauri::command]
fn get_update_status(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<UpdateProgressState, AppError> {
    Ok(engine.get_update_status())
}

#[tauri::command]
fn apply_update_and_restart(
    app_handle: tauri::AppHandle,
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<(), AppError> {
    engine.trigger_post_update_helper()?;
    let st = engine.get_update_status();
    if cfg!(target_os = "windows")
        && matches!(
            st.install_strategy.as_deref(),
            Some("windows_nsis") | Some("windows_msi")
        )
    {
        app_handle.exit(0);
    } else if cfg!(target_os = "linux")
        && st.install_strategy.as_deref() == Some("linux_appimage")
    {
        app_handle.exit(0);
    } else {
        app_handle.restart();
    }
    Ok(())
}

#[tauri::command]
fn list_backups(
    engine: State<'_, Arc<CelestiaEngine>>,
) -> Result<Vec<BackupInfo>, AppError> {
    engine.list_backups()
}

#[tauri::command]
async fn create_backup(
    engine: State<'_, Arc<CelestiaEngine>>,
    req: CreateBackupRequest,
) -> Result<BackupInfo, AppError> {
    let eng = Arc::clone(&engine);
    tokio::task::spawn_blocking(move || eng.create_backup(req))
        .await
        .map_err(|e| {
            AppError::internal(
                "BACKUP_WORKER_ERROR",
                "Backup worker failed.",
                e.to_string(),
            )
        })?
}

#[tauri::command]
async fn restore_backup(
    engine: State<'_, Arc<CelestiaEngine>>,
    backup_id: String,
) -> Result<RestoreBackupResponse, AppError> {
    let eng = Arc::clone(&engine);
    tokio::task::spawn_blocking(move || eng.restore_backup(&backup_id))
        .await
        .map_err(|e| {
            AppError::internal(
                "RESTORE_WORKER_ERROR",
                "Restore worker failed.",
                e.to_string(),
            )
        })?
}

#[tauri::command]
fn delete_backup(
    engine: State<'_, Arc<CelestiaEngine>>,
    backup_id: String,
) -> Result<(), AppError> {
    engine.delete_backup(&backup_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,celestiavid_core=info")),
        )
        .try_init();

    let sample_dir = {
        let cwd_sample = PathBuf::from("sample");
        let parent_sample = PathBuf::from("../sample");
        if cwd_sample.is_dir() {
            Some(cwd_sample)
        } else if parent_sample.is_dir() {
            Some(parent_sample)
        } else {
            None
        }
    };

    let engine = CelestiaEngine::open_default(sample_dir)
        .expect("Failed to initialize CelestiaVid local Rust engine");

    let engine_for_server = Arc::clone(&engine);
    tauri::async_runtime::block_on(async move {
        spawn_ephemeral_media_server(engine_for_server)
            .await
            .expect("Failed to bind CelestiaVid loopback media range server");
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine)
        .invoke_handler(tauri::generate_handler![
            get_capabilities,
            list_projects,
            create_project,
            create_demo_project,
            get_project,
            update_project,
            delete_project,
            import_local_asset,
            upload_asset_bytes,
            delete_asset,
            get_signed_download_url,
            save_asset_to_path,
            start_transcription,
            get_subtitle_version,
            save_subtitle_version,
            save_srt_to_path,
            start_export,
            auto_frame_project,
            get_job,
            cancel_job,
            retry_job,
            list_batches,
            create_batch,
            create_demo_batch,
            get_batch,
            update_batch,
            delete_batch,
            import_local_asset_to_batch_pool,
            upload_batch_pool_asset_bytes,
            delete_batch_pool_asset,
            scan_local_folder,
            import_folder_items_to_batch,
            set_batch_items,
            update_batch_item,
            apply_settings_to_batch_items,
            run_batch_automation,
            export_batch_outputs_to_folder,
            get_system_version,
            check_for_updates,
            start_app_update,
            get_update_status,
            apply_update_and_restart,
            list_backups,
            create_backup,
            restore_backup,
            delete_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CelestiaVid Tauri desktop application");
}
