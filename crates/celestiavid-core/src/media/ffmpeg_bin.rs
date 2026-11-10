use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct FfmpegPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

static RESOLVED_PATHS: OnceLock<FfmpegPaths> = OnceLock::new();

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

/// Prevents black `cmd.exe` console windows from flashing on Windows when spawning `ffmpeg.exe` / `ffprobe.exe`.
pub fn configure_std_background_cmd(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW_FLAG);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Prevents black `cmd.exe` console windows from flashing on Windows for async `tokio::process::Command`.
pub fn configure_tokio_background_cmd(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW_FLAG);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Strips Windows `\\?\` extended-length verbatim path prefix returned by `std::fs::canonicalize`
/// because `ffmpeg.exe`, `ffprobe.exe`, and `libass` expect standard `C:\...` Win32 paths.
pub fn normalize_platform_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn executable_works(bin: &Path) -> bool {
    let mut cmd = Command::new(bin);
    configure_std_background_cmd(&mut cmd);
    cmd.arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Resolves `ffmpeg` and `ffprobe` binaries in priority order:
/// 1. Sidecar binary bundled beside the running executable (`<exe_dir>/ffmpeg[.exe]` or `<exe_dir>/resources/ffmpeg[.exe]`)
/// 2. User app-data directory (`%LOCALAPPDATA%\celestiavid\bin\` on Windows, `~/.local/share/celestiavid/bin/` on Linux)
/// 3. System `PATH` (`ffmpeg`, `ffprobe`)
/// 4. Automatic static download via `ffmpeg-sidecar` directly into writable user `app_bin_dir`
pub fn resolve_ffmpeg_paths() -> AppResult<FfmpegPaths> {
    if let Some(cached) = RESOLVED_PATHS.get() {
        return Ok(cached.clone());
    }

    #[cfg(target_os = "windows")]
    let (ffmpeg_name, ffprobe_name) = ("ffmpeg.exe", "ffprobe.exe");
    #[cfg(not(target_os = "windows"))]
    let (ffmpeg_name, ffprobe_name) = ("ffmpeg", "ffprobe");

    // 1. Check alongside current executable & Tauri resources folder (Windows NSIS/MSI, macOS .app, Linux AppImage/deb)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for candidate_dir in [
                exe_dir.to_path_buf(),
                exe_dir.join("resources"),
                exe_dir.join("bin"),
                exe_dir.join("../Resources/resources"),
                exe_dir.join("../lib/CelestiaVid/resources"),
            ] {
                let sidecar_ffmpeg = candidate_dir.join(ffmpeg_name);
                let sidecar_ffprobe = candidate_dir.join(ffprobe_name);
                if executable_works(&sidecar_ffmpeg) && executable_works(&sidecar_ffprobe) {
                    let paths = FfmpegPaths {
                        ffmpeg: normalize_platform_path(sidecar_ffmpeg),
                        ffprobe: normalize_platform_path(sidecar_ffprobe),
                    };
                    let _ = RESOLVED_PATHS.set(paths.clone());
                    return Ok(paths);
                }
            }
        }
    }

    // 2. Check writable user app-data bin directory
    let app_bin_dir = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("celestiavid")
        .join("bin");
    let local_ffmpeg = app_bin_dir.join(ffmpeg_name);
    let local_ffprobe = app_bin_dir.join(ffprobe_name);
    if executable_works(&local_ffmpeg) && executable_works(&local_ffprobe) {
        let paths = FfmpegPaths {
            ffmpeg: local_ffmpeg,
            ffprobe: local_ffprobe,
        };
        let _ = RESOLVED_PATHS.set(paths.clone());
        return Ok(paths);
    }

    // 3. Check system PATH
    let sys_ffmpeg = PathBuf::from(ffmpeg_name);
    let sys_ffprobe = PathBuf::from(ffprobe_name);
    if executable_works(&sys_ffmpeg) && executable_works(&sys_ffprobe) {
        let paths = FfmpegPaths {
            ffmpeg: sys_ffmpeg,
            ffprobe: sys_ffprobe,
        };
        let _ = RESOLVED_PATHS.set(paths.clone());
        return Ok(paths);
    }

    // 4. Fallback: auto-download FFmpeg + FFprobe into writable user app_bin_dir (safe on Windows C:\Program Files!)
    let _ = std::fs::create_dir_all(&app_bin_dir);
    if let Ok(url) = ffmpeg_sidecar::download::ffmpeg_download_url() {
        if let Ok(archive) = ffmpeg_sidecar::download::download_ffmpeg_package(url, &app_bin_dir) {
            let _ = ffmpeg_sidecar::download::unpack_ffmpeg(&archive, &app_bin_dir);
            if executable_works(&local_ffmpeg) && executable_works(&local_ffprobe) {
                let paths = FfmpegPaths {
                    ffmpeg: local_ffmpeg,
                    ffprobe: local_ffprobe,
                };
                let _ = RESOLVED_PATHS.set(paths.clone());
                return Ok(paths);
            }
        }
    }

    Err(AppError::internal(
        "FFMPEG_MISSING",
        "FFmpeg and FFprobe were not found and could not be auto-downloaded.",
        "Check internet connection for automatic first-run FFmpeg setup or install FFmpeg.",
    ))
}
