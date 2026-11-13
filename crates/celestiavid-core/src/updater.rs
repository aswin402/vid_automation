use crate::db::now_iso;
use crate::engine::CelestiaEngine;
use crate::error::{AppError, AppResult};
use crate::models::{
    BackupInfo, CreateBackupRequest, RestoreBackupResponse, SystemVersionResponse,
    UpdateCheckResponse, UpdateProgressState,
};
use chrono::Utc;
use futures_util::StreamExt;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};
use uuid::Uuid;

const DEFAULT_GITHUB_REPO: &str = "aswin402/vid_automation";
const MAX_AUTO_PRE_UPDATE_BACKUPS: usize = 8;

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GithubReleasePayload {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

pub fn normalize_version(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .trim()
        .to_string()
}

fn parse_semver_tuple(raw: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let cleaned = normalize_version(raw);
    if cleaned.is_empty() {
        return None;
    }
    let without_build = cleaned.split('+').next().unwrap_or(&cleaned);
    let (core, prerelease) = match without_build.split_once('-') {
        Some((c, pre)) => (c, Some(pre.to_string())),
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let patch: u64 = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch, prerelease))
}

pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    let Some((c_maj, c_min, c_pat, c_pre)) = parse_semver_tuple(current) else {
        return false;
    };
    let Some((n_maj, n_min, n_pat, n_pre)) = parse_semver_tuple(candidate) else {
        return false;
    };

    match (n_maj, n_min, n_pat).cmp(&(c_maj, c_min, c_pat)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => match (&c_pre, &n_pre) {
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (Some(cp), Some(np)) => np > cp,
            (None, None) => false,
        },
    }
}

fn is_safe_backup_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn compute_dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                total = total.saturating_add(compute_dir_size(&path));
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str.ends_with(".tmp") || name_str.ends_with(".part") || name_str == "scratch" {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn select_platform_asset<'a>(
    assets: &'a [GithubReleaseAsset],
    target_os: &str,
    custom_manifest: bool,
) -> (Option<&'a GithubReleaseAsset>, String) {
    match target_os {
        "windows" => {
            if let Some(exe) = assets.iter().find(|a| {
                let lower = a.name.to_ascii_lowercase();
                lower.ends_with("setup.exe") || lower.ends_with(".exe")
            }) {
                return (Some(exe), "windows_nsis".into());
            }
            if let Some(msi) = assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with(".msi"))
            {
                return (Some(msi), "windows_msi".into());
            }
        }
        "macos" => {
            if let Some(dmg) = assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with(".dmg"))
            {
                return (Some(dmg), "macos_dmg".into());
            }
        }
        "linux" => {
            let running_appimage = std::env::var_os("APPIMAGE").is_some();
            let deb_installed = Path::new("/usr/bin/celestiavid-desktop").exists();
            let pkexec_available = Path::new("/usr/bin/pkexec").exists();

            if !running_appimage && deb_installed && pkexec_available {
                if let Some(deb) = assets
                    .iter()
                    .find(|a| a.name.to_ascii_lowercase().ends_with(".deb"))
                {
                    return (Some(deb), "linux_deb".into());
                }
            }

            if let Some(appimage) = assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with(".appimage"))
            {
                return (Some(appimage), "linux_appimage".into());
            }

            if let Some(deb) = assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with(".deb"))
            {
                return (Some(deb), "linux_deb".into());
            }
        }
        _ => {}
    }

    if custom_manifest {
        if let Some(first) = assets.first() {
            return (Some(first), "staged_package".into());
        }
    }

    (None, "manual_download".into())
}

impl CelestiaEngine {
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    pub fn updates_dir(&self) -> PathBuf {
        self.data_dir.join("updates")
    }

    pub fn get_system_version(&self) -> SystemVersionResponse {
        SystemVersionResponse {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            data_dir: self.data_dir.to_string_lossy().to_string(),
            backups_dir: self.backups_dir().to_string_lossy().to_string(),
        }
    }

    pub fn list_backups(&self) -> AppResult<Vec<BackupInfo>> {
        let dir = self.backups_dir();
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut list = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("backup_manifest.json");
            if manifest_path.is_file() {
                if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
                    if let Ok(mut info) = serde_json::from_str::<BackupInfo>(&raw) {
                        info.path = path.to_string_lossy().to_string();
                        if info.size_bytes == 0 {
                            info.size_bytes = compute_dir_size(&path);
                        }
                        list.push(info);
                        continue;
                    }
                }
            }

            // Also surface CLI-created backup directories that have celestiavid.db even without manifest
            let db_file = path.join("celestiavid.db");
            if db_file.is_file() {
                let folder_name = entry.file_name().to_string_lossy().to_string();
                let created_at = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
                    .unwrap_or_else(|_| now_iso());
                list.push(BackupInfo {
                    id: folder_name.clone(),
                    label: format!("CLI Backup ({folder_name})"),
                    reason: "cli".into(),
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                    created_at,
                    path: path.to_string_lossy().to_string(),
                    size_bytes: compute_dir_size(&path),
                    project_count: 0,
                    batch_count: 0,
                    asset_count: 0,
                    includes_storage: path.join("storage").is_dir(),
                });
            }
        }

        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    pub fn create_backup(&self, req: CreateBackupRequest) -> AppResult<BackupInfo> {
        let include_storage = req.include_storage.unwrap_or(true);
        let default_label = format!(
            "Manual Snapshot · v{}",
            env!("CARGO_PKG_VERSION")
        );
        let label = req
            .label
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&default_label);
        self.create_backup_internal(label, "manual", include_storage)
    }

    pub(crate) fn create_backup_internal(
        &self,
        label: &str,
        reason: &str,
        include_storage: bool,
    ) -> AppResult<BackupInfo> {
        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let now = Utc::now();
        let stamp = now.format("%Y%m%d-%H%M%S").to_string();
        let short_suffix = &Uuid::new_v4().simple().to_string()[..6];
        let backup_id = format!("backup-v{app_version}-{stamp}-{short_suffix}");

        let backup_dir = self.backups_dir().join(&backup_id);
        std::fs::create_dir_all(&backup_dir)?;

        // 1. Online atomic SQLite snapshot via VACUUM INTO
        let backup_db_path = backup_dir.join("celestiavid.db");
        self.db.backup_to_file(&backup_db_path)?;

        let (project_count, batch_count, asset_count) =
            self.db.count_user_entities().unwrap_or((0, 0, 0));

        // 2. Copy managed storage assets (logos, outros, subtitles, rendered media)
        let storage_src = self.data_dir.join("storage");
        let copied_storage = if include_storage && storage_src.is_dir() {
            copy_dir_recursive(&storage_src, &backup_dir.join("storage"))?;
            true
        } else {
            false
        };

        let size_bytes = compute_dir_size(&backup_dir);
        let info = BackupInfo {
            id: backup_id.clone(),
            label: label.to_string(),
            reason: reason.to_string(),
            app_version,
            created_at: now.to_rfc3339(),
            path: backup_dir.to_string_lossy().to_string(),
            size_bytes,
            project_count,
            batch_count,
            asset_count,
            includes_storage: copied_storage,
        };

        let manifest_tmp = backup_dir.join("backup_manifest.json.tmp");
        let manifest_final = backup_dir.join("backup_manifest.json");
        let json_bytes = serde_json::to_vec_pretty(&info)?;
        std::fs::write(&manifest_tmp, json_bytes)?;
        std::fs::rename(&manifest_tmp, &manifest_final)?;

        let final_size = compute_dir_size(&backup_dir);
        let mut final_info = info;
        final_info.size_bytes = final_size;

        if reason == "pre-update" {
            self.prune_old_pre_update_backups();
        }

        info!(
            backup_id = %final_info.id,
            reason = %reason,
            size_bytes = final_info.size_bytes,
            projects = project_count,
            batches = batch_count,
            "created_app_data_backup"
        );

        Ok(final_info)
    }

    fn prune_old_pre_update_backups(&self) {
        let Ok(backups) = self.list_backups() else {
            return;
        };
        let pre_updates: Vec<_> = backups
            .into_iter()
            .filter(|b| b.reason == "pre-update")
            .collect();
        if pre_updates.len() <= MAX_AUTO_PRE_UPDATE_BACKUPS {
            return;
        }
        for stale in pre_updates.into_iter().skip(MAX_AUTO_PRE_UPDATE_BACKUPS) {
            let p = PathBuf::from(&stale.path);
            if p.starts_with(self.backups_dir()) {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }

    pub fn restore_backup(&self, backup_id: &str) -> AppResult<RestoreBackupResponse> {
        if !is_safe_backup_id(backup_id) {
            return Err(AppError::bad_request("Invalid backup identifier."));
        }
        let backup_dir = self.backups_dir().join(backup_id);
        let backup_db = backup_dir.join("celestiavid.db");
        if !backup_db.is_file() {
            return Err(AppError::not_found(format!(
                "Backup '{}' was not found or is missing celestiavid.db.",
                backup_id
            )));
        }

        // Take an automatic pre-restore safety snapshot first
        let safety = self.create_backup_internal(
            &format!("Safety snapshot before restoring {backup_id}"),
            "pre-restore",
            true,
        )?;

        let (restored_projects, restored_batches) = self.db.restore_from_file(&backup_db)?;

        let backup_storage = backup_dir.join("storage");
        if backup_storage.is_dir() {
            let live_storage = self.data_dir.join("storage");
            copy_dir_recursive(&backup_storage, &live_storage)?;
        }

        info!(
            restored_backup_id = %backup_id,
            safety_backup_id = %safety.id,
            restored_projects,
            restored_batches,
            "restored_app_data_backup"
        );

        Ok(RestoreBackupResponse {
            restored_backup_id: backup_id.to_string(),
            safety_backup_id: safety.id,
            restored_projects,
            restored_batches,
            message: format!(
                "Restored {} project(s) and {} batch campaign(s) from {}.",
                restored_projects, restored_batches, backup_id
            ),
        })
    }

    pub fn delete_backup(&self, backup_id: &str) -> AppResult<()> {
        if !is_safe_backup_id(backup_id) {
            return Err(AppError::bad_request("Invalid backup identifier."));
        }
        let backup_dir = self.backups_dir().join(backup_id);
        if !backup_dir.is_dir() || !backup_dir.starts_with(self.backups_dir()) {
            return Err(AppError::not_found("Backup snapshot not found."));
        }
        std::fs::remove_dir_all(&backup_dir)?;
        Ok(())
    }

    pub async fn check_for_updates(&self) -> AppResult<UpdateCheckResponse> {
        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let repo = std::env::var("CELESTIAVID_REPO")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_GITHUB_REPO.to_string());

        let custom_manifest_url = std::env::var("CELESTIAVID_UPDATE_MANIFEST_URL")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let is_custom_manifest = custom_manifest_url.is_some();

        let api_url = custom_manifest_url.unwrap_or_else(|| {
            format!("https://api.github.com/repos/{repo}/releases/latest")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent(format!("CelestiaVid-Studio/{current_version}"))
            .build()
            .map_err(|e| {
                AppError::internal(
                    "HTTP_CLIENT_ERROR",
                    "Failed to build HTTP client.",
                    e.to_string(),
                )
            })?;

        let resp = match client
            .get(&api_url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
        {
            Ok(r) => r,
            Err(err) => {
                warn!(error = %err, url = %api_url, "update_check_network_unreachable");
                return Err(AppError::bad_request(format!(
                    "Unable to reach update server: {err}"
                )));
            }
        };

        // If the repository has not published a GitHub Release yet (404), report up-to-date cleanly
        if resp.status() == reqwest::StatusCode::NOT_FOUND && !is_custom_manifest {
            return Ok(UpdateCheckResponse {
                current_version: current_version.clone(),
                latest_version: current_version.clone(),
                update_available: false,
                release_name: format!("CelestiaVid v{current_version}"),
                release_notes: "You are running the latest version of CelestiaVid Studio.".into(),
                published_at: None,
                html_url: format!("https://github.com/{repo}/releases"),
                asset_name: None,
                asset_download_url: None,
                asset_size_bytes: None,
                install_strategy: "up_to_date".into(),
                checked_at: now_iso(),
            });
        }

        if !resp.status().is_success() {
            return Err(AppError::bad_request(format!(
                "Update feed returned HTTP {}.",
                resp.status()
            )));
        }

        let payload: GithubReleasePayload = resp.json().await.map_err(|e| {
            AppError::internal(
                "RELEASE_PARSE_ERROR",
                "Invalid release metadata JSON.",
                e.to_string(),
            )
        })?;

        let latest_version = normalize_version(&payload.tag_name);
        let update_available = is_newer_version(&current_version, &latest_version);

        let target_os = std::env::var("CELESTIAVID_TARGET_OS")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| std::env::consts::OS.to_string());

        let (matched_asset, install_strategy) =
            select_platform_asset(&payload.assets, &target_os, is_custom_manifest);

        let html_url = payload
            .html_url
            .unwrap_or_else(|| format!("https://github.com/{repo}/releases/tag/{}", payload.tag_name));
        let release_name = payload
            .name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("CelestiaVid v{latest_version}"));
        let release_notes = payload
            .body
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Performance improvements, studio enhancements, and stability fixes.".into());

        Ok(UpdateCheckResponse {
            current_version,
            latest_version,
            update_available,
            release_name,
            release_notes,
            published_at: payload.published_at,
            html_url,
            asset_name: matched_asset.map(|a| a.name.clone()),
            asset_download_url: matched_asset.map(|a| a.browser_download_url.clone()),
            asset_size_bytes: matched_asset.map(|a| a.size).filter(|&s| s > 0),
            install_strategy,
            checked_at: now_iso(),
        })
    }

    pub fn get_update_status(&self) -> UpdateProgressState {
        self.update_state.read().clone()
    }

    fn mutate_update_state<F>(&self, f: F) -> UpdateProgressState
    where
        F: FnOnce(&mut UpdateProgressState),
    {
        let mut guard = self.update_state.write();
        f(&mut guard);
        guard.updated_at = now_iso();
        guard.clone()
    }

    pub fn start_app_update(self: &Arc<Self>) -> AppResult<UpdateProgressState> {
        {
            let current = self.update_state.read();
            if matches!(
                current.status.as_str(),
                "checking" | "backing_up" | "downloading" | "verifying" | "installing"
            ) {
                return Ok(current.clone());
            }
        }

        let now = now_iso();
        let initial = self.mutate_update_state(|st| {
            *st = UpdateProgressState {
                status: "checking".into(),
                stage: "checking_release".into(),
                progress: 0.04,
                downloaded_bytes: 0,
                total_bytes: None,
                current_version: env!("CARGO_PKG_VERSION").to_string(),
                target_version: None,
                backup_info: None,
                installer_path: None,
                install_strategy: None,
                can_auto_restart: false,
                message: "Checking GitHub Releases for new version...".into(),
                error_message_safe: None,
                started_at: Some(now.clone()),
                updated_at: now,
            };
        });

        let engine = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(err) = engine.execute_update_pipeline().await {
                error!(error = %err, "app_update_pipeline_failed");
                engine.mutate_update_state(|st| {
                    st.status = "failed".into();
                    st.stage = "failed".into();
                    st.error_message_safe = Some(err.message.clone());
                    st.message = err.message;
                });
            }
        });

        Ok(initial)
    }

    async fn execute_update_pipeline(self: &Arc<Self>) -> AppResult<()> {
        let check = self.check_for_updates().await?;

        if !check.update_available {
            self.mutate_update_state(|st| {
                st.status = "completed".into();
                st.stage = "up_to_date".into();
                st.progress = 1.0;
                st.target_version = Some(check.latest_version.clone());
                st.message = format!(
                    "CelestiaVid v{} is already the latest version.",
                    check.current_version
                );
            });
            return Ok(());
        }

        let download_url = check.asset_download_url.clone().ok_or_else(|| {
            AppError::bad_request(format!(
                "Release v{} was found, but no prebuilt installer asset matched {} ({}). Use the release page link to download manually.",
                check.latest_version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ))
        })?;
        let asset_name = check
            .asset_name
            .clone()
            .unwrap_or_else(|| format!("celestiavid-update-{}", check.latest_version));

        // ==================== Stage 1: Automatic App Data Backup ====================
        self.mutate_update_state(|st| {
            st.status = "backing_up".into();
            st.stage = "backing_up_data".into();
            st.progress = 0.10;
            st.target_version = Some(check.latest_version.clone());
            st.total_bytes = check.asset_size_bytes;
            st.install_strategy = Some(check.install_strategy.clone());
            st.message = format!(
                "Backing up projects, SQLite database & brand assets before updating to v{}...",
                check.latest_version
            );
        });

        let engine_for_backup = Arc::clone(self);
        let backup_label = format!(
            "Auto Pre-Update Backup (v{} → v{})",
            check.current_version, check.latest_version
        );
        let backup_info = tokio::task::spawn_blocking(move || {
            engine_for_backup.create_backup_internal(&backup_label, "pre-update", true)
        })
        .await
        .map_err(|e| {
            AppError::internal(
                "BACKUP_WORKER_ERROR",
                "Pre-update backup worker failed.",
                e.to_string(),
            )
        })??;

        self.mutate_update_state(|st| {
            st.backup_info = Some(backup_info.clone());
            st.progress = 0.22;
            st.message = format!(
                "Backup saved ({:.1} MB). Starting v{} package download...",
                backup_info.size_bytes as f64 / (1024.0 * 1024.0),
                check.latest_version
            );
        });

        // ==================== Stage 2: Streamed Release Download ====================
        let version_dir = self
            .updates_dir()
            .join(format!("v{}", check.latest_version));
        tokio::fs::create_dir_all(&version_dir).await?;

        let safe_asset_filename: String = asset_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let part_path = version_dir.join(format!("{safe_asset_filename}.part"));
        let final_installer_path = version_dir.join(&safe_asset_filename);

        if part_path.exists() {
            let _ = tokio::fs::remove_file(&part_path).await;
        }

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(format!("CelestiaVid-Updater/{}", check.current_version))
            .build()
            .map_err(|e| {
                AppError::internal(
                    "HTTP_CLIENT_ERROR",
                    "Failed to initialize downloader.",
                    e.to_string(),
                )
            })?;

        let resp = client
            .get(&download_url)
            .send()
            .await
            .map_err(|e| AppError::bad_request(format!("Failed to download update asset: {e}")))?;

        if !resp.status().is_success() {
            return Err(AppError::bad_request(format!(
                "Asset download returned HTTP {}.",
                resp.status()
            )));
        }

        let total_bytes = resp.content_length().or(check.asset_size_bytes);
        self.mutate_update_state(|st| {
            st.status = "downloading".into();
            st.stage = "downloading_package".into();
            st.progress = 0.24;
            st.downloaded_bytes = 0;
            st.total_bytes = total_bytes;
            st.message = format!("Downloading {}...", safe_asset_filename);
        });

        let mut file = tokio::fs::File::create(&part_path).await?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_tick = Instant::now();

        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| {
                AppError::bad_request(format!("Network stream interrupted during download: {e}"))
            })?;
            file.write_all(&chunk).await?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);

            if last_tick.elapsed() >= Duration::from_millis(45) {
                last_tick = Instant::now();
                let frac = match total_bytes {
                    Some(t) if t > 0 => (downloaded as f64 / t as f64).clamp(0.0, 1.0),
                    _ => 0.5,
                };
                let pct = (frac * 100.0).round() as u64;
                self.mutate_update_state(|st| {
                    st.downloaded_bytes = downloaded;
                    st.progress = 0.24 + (frac * 0.61);
                    st.message = match total_bytes {
                        Some(t) if t > 0 => format!(
                            "Downloading v{} ({:.1} / {:.1} MB · {}%)...",
                            check.latest_version,
                            downloaded as f64 / (1024.0 * 1024.0),
                            t as f64 / (1024.0 * 1024.0),
                            pct
                        ),
                        _ => format!(
                            "Downloading v{} ({:.1} MB)...",
                            check.latest_version,
                            downloaded as f64 / (1024.0 * 1024.0)
                        ),
                    };
                });
            }
        }
        file.flush().await?;
        drop(file);

        // ==================== Stage 3: Package Verification ====================
        self.mutate_update_state(|st| {
            st.status = "verifying".into();
            st.stage = "verifying_package".into();
            st.downloaded_bytes = downloaded;
            st.progress = 0.88;
            st.message = "Verifying downloaded update package integrity...".into();
        });

        if downloaded == 0 {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(AppError::internal(
                "EMPTY_UPDATE_PACKAGE",
                "Downloaded update package was empty (0 bytes).",
                "0 bytes received from release URL",
            ));
        }
        if let Some(expected) = check.asset_size_bytes {
            if expected > 0 && downloaded != expected {
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(AppError::internal(
                    "UPDATE_SIZE_MISMATCH",
                    format!(
                        "Downloaded package size mismatch (expected {expected} bytes, received {downloaded} bytes)."
                    ),
                    format!("expected={expected}, actual={downloaded}"),
                ));
            }
        }

        if final_installer_path.exists() {
            let _ = tokio::fs::remove_file(&final_installer_path).await;
        }
        tokio::fs::rename(&part_path, &final_installer_path).await?;

        // ==================== Stage 4: Apply / Stage Installer ====================
        self.mutate_update_state(|st| {
            st.status = "installing".into();
            st.stage = "installing_update".into();
            st.progress = 0.93;
            st.installer_path = Some(final_installer_path.to_string_lossy().to_string());
            st.message = format!("Applying CelestiaVid v{} update...", check.latest_version);
        });

        let stage_only = std::env::var("CELESTIAVID_UPDATER_STAGE_ONLY")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let (applied_path, can_auto_restart, done_msg) = if stage_only
            || check.install_strategy == "staged_package"
        {
            (
                final_installer_path.clone(),
                true,
                format!(
                    "CelestiaVid v{} downloaded & backed up! Ready to restart.",
                    check.latest_version
                ),
            )
        } else {
            let strategy = check.install_strategy.clone();
            let installer_clone = final_installer_path.clone();
            let target_ver = check.latest_version.clone();
            tokio::task::spawn_blocking(move || {
                apply_platform_installer(&strategy, &installer_clone, &target_ver)
            })
            .await
            .map_err(|e| {
                AppError::internal(
                    "INSTALLER_WORKER_ERROR",
                    "Installer worker failed.",
                    e.to_string(),
                )
            })??
        };

        self.mutate_update_state(|st| {
            st.status = "ready_to_restart".into();
            st.stage = "ready_to_restart".into();
            st.progress = 1.0;
            st.installer_path = Some(applied_path.to_string_lossy().to_string());
            st.can_auto_restart = can_auto_restart;
            st.message = done_msg;
        });

        Ok(())
    }

    /// Spawns any OS-level post-exit installer helper (such as Windows NSIS silent per-user setup)
    /// right before the Tauri process exits or restarts.
    pub fn trigger_post_update_helper(&self) -> AppResult<()> {
        let state = self.update_state.read().clone();
        let Some(installer_str) = state.installer_path.as_deref() else {
            return Ok(());
        };
        let installer_path = PathBuf::from(installer_str);

        #[cfg(target_os = "windows")]
        {
            if matches!(
                state.install_strategy.as_deref(),
                Some("windows_nsis") | Some("windows_msi")
            ) && installer_path.is_file()
            {
                let pid = std::process::id();
                let current_exe = std::env::current_exe().ok();
                let script_path = self.updates_dir().join("apply-windows-update.ps1");
                let exe_relaunch = current_exe
                    .as_ref()
                    .map(|p| p.to_string_lossy().replace('\'', "''"))
                    .unwrap_or_default();
                let installer_escaped = installer_path.to_string_lossy().replace('\'', "''");
                let is_msi = state.install_strategy.as_deref() == Some("windows_msi");

                let ps_script = if is_msi {
                    format!(
                        "$ErrorActionPreference = 'SilentlyContinue'\n\
                         Wait-Process -Id {pid} -Timeout 15\n\
                         Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i \"{installer_escaped}\" /passive /norestart' -Wait\n\
                         if ('{exe_relaunch}' -ne '' -and (Test-Path '{exe_relaunch}')) {{ Start-Process -FilePath '{exe_relaunch}' }}\n"
                    )
                } else {
                    format!(
                        "$ErrorActionPreference = 'SilentlyContinue'\n\
                         Wait-Process -Id {pid} -Timeout 15\n\
                         Start-Process -FilePath '{installer_escaped}' -ArgumentList '/S' -Wait\n\
                         if ('{exe_relaunch}' -ne '' -and (Test-Path '{exe_relaunch}')) {{ Start-Process -FilePath '{exe_relaunch}' }}\n"
                    )
                };

                std::fs::write(&script_path, ps_script)?;
                std::process::Command::new("powershell.exe")
                    .args([
                        "-NoProfile",
                        "-WindowStyle",
                        "Hidden",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ])
                    .arg(&script_path)
                    .spawn()
                    .map_err(|e| {
                        AppError::internal(
                            "WINDOWS_UPDATER_ERROR",
                            "Failed to launch Windows updater helper.",
                            e.to_string(),
                        )
                    })?;
            }
        }

        #[cfg(target_os = "linux")]
        {
            if state.install_strategy.as_deref() == Some("linux_appimage")
                && installer_path.is_file()
            {
                let _ = std::process::Command::new(&installer_path).spawn();
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = installer_path;
        }

        Ok(())
    }
}

fn apply_platform_installer(
    strategy: &str,
    downloaded_file: &Path,
    target_version: &str,
) -> AppResult<(PathBuf, bool, String)> {
    match strategy {
        "linux_appimage" => {
            let target_bin = if let Some(appimage_env) = std::env::var_os("APPIMAGE") {
                PathBuf::from(appimage_env)
            } else {
                let home = dirs::home_dir().ok_or_else(|| {
                    AppError::internal(
                        "HOME_DIR_ERROR",
                        "Could not resolve HOME directory for AppImage update.",
                        "dirs::home_dir() returned None",
                    )
                })?;
                home.join(".local").join("bin").join("celestiavid")
            };

            if let Some(parent) = target_bin.parent() {
                std::fs::create_dir_all(parent)?;
            }

            let staged_new = target_bin.with_extension("appimage.new");
            std::fs::copy(downloaded_file, &staged_new)?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perms = std::fs::Permissions::from_mode(0o755);
                std::fs::set_permissions(&staged_new, perms)?;
            }

            std::fs::rename(&staged_new, &target_bin)?;

            if let Some(home) = dirs::home_dir() {
                let apps_dir = home.join(".local").join("share").join("applications");
                let _ = std::fs::create_dir_all(&apps_dir);
                let desktop_entry = format!(
                    "[Desktop Entry]\nName=CelestiaVid\nComment=AI Branded Video Automation Studio\nExec={}\nTerminal=false\nType=Application\nCategories=AudioVideo;Video;AudioVideoEditing;\n",
                    target_bin.display()
                );
                let _ = std::fs::write(apps_dir.join("celestiavid.desktop"), desktop_entry);
            }

            Ok((
                target_bin.clone(),
                true,
                format!(
                    "CelestiaVid v{target_version} installed to {}. Click Restart App to launch!",
                    target_bin.display()
                ),
            ))
        }
        "linux_deb" => {
            if Path::new("/usr/bin/pkexec").exists() {
                let status = std::process::Command::new("pkexec")
                    .args(["apt-get", "install", "-y"])
                    .arg(downloaded_file)
                    .status();
                if let Ok(st) = status {
                    if st.success() {
                        return Ok((
                            downloaded_file.to_path_buf(),
                            true,
                            format!(
                                "CelestiaVid v{target_version} (.deb) installed! Click Restart App to launch."
                            ),
                        ));
                    }
                }
            }
            Ok((
                downloaded_file.to_path_buf(),
                false,
                format!(
                    "Downloaded v{target_version} package to {}. Run `sudo apt install \"{}\"` to complete system-wide upgrade.",
                    downloaded_file.display(),
                    downloaded_file.display()
                ),
            ))
        }
        "macos_dmg" => {
            let attach = std::process::Command::new("hdiutil")
                .args(["attach", "-nobrowse", "-readonly"])
                .arg(downloaded_file)
                .output()
                .map_err(|e| {
                    AppError::internal(
                        "MACOS_DMG_ERROR",
                        "Failed to mount macOS DMG.",
                        e.to_string(),
                    )
                })?;

            if !attach.status.success() {
                return Err(AppError::internal(
                    "MACOS_DMG_ERROR",
                    "macOS hdiutil failed to mount downloaded DMG.",
                    String::from_utf8_lossy(&attach.stderr).to_string(),
                ));
            }
            let stdout = String::from_utf8_lossy(&attach.stdout);
            let mount_point = stdout
                .lines()
                .find_map(|line| line.find("/Volumes/").map(|idx| line[idx..].trim().to_string()))
                .ok_or_else(|| {
                    AppError::internal(
                        "MACOS_DMG_ERROR",
                        "Could not locate mounted /Volumes path.",
                        stdout.to_string(),
                    )
                })?;

            let src_app = PathBuf::from(&mount_point).join("CelestiaVid.app");
            if !src_app.is_dir() {
                let _ = std::process::Command::new("hdiutil")
                    .args(["detach", &mount_point, "-quiet"])
                    .status();
                return Err(AppError::internal(
                    "MACOS_DMG_ERROR",
                    "CelestiaVid.app was not found inside the DMG.",
                    mount_point,
                ));
            }

            let global_apps = PathBuf::from("/Applications");
            let dest_root = if global_apps.exists()
                && std::fs::metadata(&global_apps)
                    .map(|m| !m.permissions().readonly())
                    .unwrap_or(false)
            {
                global_apps
            } else {
                let user_apps = dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("/tmp"))
                    .join("Applications");
                std::fs::create_dir_all(&user_apps)?;
                user_apps
            };
            let dest_app = dest_root.join("CelestiaVid.app");
            if dest_app.exists() {
                let _ = std::fs::remove_dir_all(&dest_app);
            }
            let cp_status = std::process::Command::new("cp")
                .arg("-R")
                .arg(&src_app)
                .arg(&dest_app)
                .status();
            let _ = std::process::Command::new("hdiutil")
                .args(["detach", &mount_point, "-quiet"])
                .status();

            if cp_status.map(|s| !s.success()).unwrap_or(true) {
                return Err(AppError::internal(
                    "MACOS_INSTALL_ERROR",
                    "Failed to copy CelestiaVid.app into Applications.",
                    dest_app.display().to_string(),
                ));
            }
            let _ = std::process::Command::new("xattr")
                .args(["-cr"])
                .arg(&dest_app)
                .status();

            Ok((
                dest_app.clone(),
                true,
                format!(
                    "CelestiaVid v{target_version} installed to {}. Click Restart App to launch!",
                    dest_app.display()
                ),
            ))
        }
        "windows_nsis" | "windows_msi" => {
            // Staged & verified; clicking Restart & Apply runs silent per-user installer after app closes
            Ok((
                downloaded_file.to_path_buf(),
                true,
                format!(
                    "Backup complete & CelestiaVid v{target_version} installer verified! Click 'Install & Restart' to finish updating."
                ),
            ))
        }
        _ => Ok((
            downloaded_file.to_path_buf(),
            false,
            format!(
                "Update package v{target_version} saved to {}.",
                downloaded_file.display()
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_newer_version, normalize_version};

    #[test]
    fn test_semver_comparison() {
        assert_eq!(normalize_version("v0.2.2"), "0.2.2");
        assert!(is_newer_version("0.2.1", "v0.2.2"));
        assert!(is_newer_version("0.2.1", "0.3.0"));
        assert!(is_newer_version("0.2.1", "1.0.0"));
        assert!(!is_newer_version("0.2.1", "0.2.1"));
        assert!(!is_newer_version("0.2.1", "v0.2.0"));
        assert!(is_newer_version("0.2.2-rc.1", "0.2.2"));
        assert!(!is_newer_version("0.2.2", "0.2.2-beta.1"));
    }
}
