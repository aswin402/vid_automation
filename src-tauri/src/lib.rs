use celestiavid_core::{
    http_server::spawn_ephemeral_media_server,
    models::{
        AssetRecord, CapabilitiesResponse, DownloadUrlResponse, EditSettings, ExportCreateRequest,
        ProcessingJobRecord, ProjectDetailResponse, ProjectUpdateRequest, SubtitleCueItem,
        SubtitleVersionResponse, SubtitleVersionUpdateRequest, TranscriptionCreateRequest,
        UploadUrlRequest,
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
            get_job,
            cancel_job,
            retry_job,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CelestiaVid Tauri desktop application");
}
