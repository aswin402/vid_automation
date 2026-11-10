use crate::error::{AppError, AppResult};
use crate::media::ffmpeg_bin::{configure_tokio_background_cmd, resolve_ffmpeg_paths};
use image::{GenericImageView, ImageFormat, ImageReader};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

pub const MAX_UPLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GB local desktop media support
pub const MAX_SOURCE_DURATION_SECS: f64 = 3600.0; // 60 minutes

#[derive(Debug, Clone)]
pub struct MediaMetadata {
    pub duration_ms: Option<i64>,
    pub width: u32,
    pub height: u32,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub frame_rate: Option<String>,
    pub fps_float: f64,
    pub pixel_format: Option<String>,
    pub has_audio: bool,
    pub size_bytes: u64,
    pub mime_type: String,
}

fn parse_frame_rate(rate_str: Option<&str>) -> f64 {
    let Some(raw) = rate_str else {
        return 30.0;
    };
    if raw.is_empty() || raw == "0/0" {
        return 30.0;
    }
    if let Some((num_s, den_s)) = raw.split_once('/') {
        if let (Ok(num), Ok(den)) = (num_s.parse::<f64>(), den_s.parse::<f64>()) {
            if num > 0.0 && den > 0.0 {
                let fps = (num / den).clamp(10.0, 120.0);
                return (fps * 1000.0).round() / 1000.0;
            }
        }
        return 30.0;
    }
    raw.parse::<f64>()
        .map(|f| ((f.clamp(10.0, 120.0)) * 1000.0).round() / 1000.0)
        .unwrap_or(30.0)
}

fn format_fps_display(fps: f64) -> String {
    let s = format!("{fps:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn probe_image_file(file_path: &Path) -> AppResult<MediaMetadata> {
    let meta = std::fs::metadata(file_path).map_err(|_| {
        AppError::validation("UNSUPPORTED_MEDIA", "Uploaded image file is empty or missing.")
    })?;
    if meta.len() == 0 {
        return Err(AppError::validation(
            "UNSUPPORTED_MEDIA",
            "Uploaded image file is empty.",
        ));
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::new(
            "UPLOAD_TOO_LARGE",
            "Image exceeds maximum allowed size.",
            413,
        ));
    }

    let reader = ImageReader::open(file_path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| {
            AppError::validation(
                "UNSUPPORTED_MEDIA",
                "This image format isn't supported or the file is corrupted. Upload a PNG, JPEG, or WebP logo.",
            )
            .with_detail(e.to_string())
        })?;

    let fmt = reader.format().ok_or_else(|| {
        AppError::validation(
            "UNSUPPORTED_MEDIA",
            "Image format could not be recognized. Upload a PNG, JPEG, or WebP image.",
        )
    })?;

    let (codec_name, mime_type) = match fmt {
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::Jpeg => ("jpeg", "image/jpeg"),
        ImageFormat::WebP => ("webp", "image/webp"),
        _ => {
            return Err(AppError::validation(
                "UNSUPPORTED_MEDIA",
                "Image format is not supported. Upload a PNG, JPEG, or WebP image.",
            ))
        }
    };

    let decoded = reader.decode().map_err(|e| {
        AppError::validation(
            "UNSUPPORTED_MEDIA",
            "Corrupted image data detected while decoding logo.",
        )
        .with_detail(e.to_string())
    })?;

    let (width, height) = decoded.dimensions();
    if !(16..=4096).contains(&width) || !(16..=4096).contains(&height) {
        return Err(AppError::validation(
            "UNSUPPORTED_MEDIA",
            "Logo dimensions must be between 16x16 and 4096x4096 pixels.",
        ));
    }

    Ok(MediaMetadata {
        duration_ms: None,
        width,
        height,
        video_codec: Some(codec_name.to_string()),
        audio_codec: None,
        frame_rate: None,
        fps_float: 0.0,
        pixel_format: Some("rgba".to_string()),
        has_audio: false,
        size_bytes: meta.len(),
        mime_type: mime_type.to_string(),
    })
}

pub async fn probe_video_file(file_path: &Path, check_duration_limit: bool) -> AppResult<MediaMetadata> {
    let meta = std::fs::metadata(file_path).map_err(|_| {
        AppError::validation("MEDIA_PROBE_FAILED", "Media file is missing or empty.")
    })?;
    if meta.len() == 0 {
        return Err(AppError::validation(
            "MEDIA_PROBE_FAILED",
            "Media file is empty.",
        ));
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::new(
            "UPLOAD_TOO_LARGE",
            "Video file exceeds maximum allowed size.",
            413,
        ));
    }

    let bins = resolve_ffmpeg_paths()?;
    let mut probe_cmd = Command::new(&bins.ffprobe);
    configure_tokio_background_cmd(&mut probe_cmd);
    let fut = probe_cmd
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(file_path)
        .output();

    let output = tokio::time::timeout(Duration::from_secs(30), fut)
        .await
        .map_err(|_| {
            AppError::validation(
                "MEDIA_PROBE_FAILED",
                "Timed out while inspecting the video file.",
            )
        })?
        .map_err(|e| {
            AppError::internal(
                "MEDIA_PROBE_FAILED",
                "Could not execute FFprobe media inspection.",
                e.to_string(),
            )
        })?;

    if !output.status.success() {
        return Err(AppError::validation(
            "UNSUPPORTED_MEDIA",
            "This file format isn't supported or the video is corrupted. Upload an MP4, MOV, or WebM video.",
        )
        .with_detail(String::from_utf8_lossy(&output.stderr).to_string()));
    }

    let data: Value = serde_json::from_slice(&output.stdout).map_err(|e| {
        AppError::validation("MEDIA_PROBE_FAILED", "Failed to parse FFprobe metadata.")
            .with_detail(e.to_string())
    })?;

    let streams = data
        .get("streams")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let fmt_info = data.get("format");

    let v_stream = streams
        .iter()
        .find(|s| {
            s.get("codec_type").and_then(|c| c.as_str()) == Some("video")
                && s.get("disposition")
                    .and_then(|d| d.get("attached_pic"))
                    .and_then(|ap| ap.as_i64())
                    .unwrap_or(0)
                    == 0
        })
        .ok_or_else(|| {
            AppError::validation(
                "UNSUPPORTED_MEDIA",
                "The selected file does not contain a valid video stream.",
            )
        })?;

    let a_stream = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));

    let mut width = v_stream.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let mut height = v_stream.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    let mut rotation: i32 = 0;
    if let Some(rot_str) = v_stream
        .get("tags")
        .and_then(|t| t.get("rotate"))
        .and_then(|r| r.as_str())
    {
        rotation = rot_str.parse::<i32>().unwrap_or(0).abs();
    }
    if let Some(sd_list) = v_stream.get("side_data_list").and_then(|v| v.as_array()) {
        for sd in sd_list {
            if let Some(rot_num) = sd.get("rotation").and_then(|r| r.as_f64()) {
                rotation = (rot_num as i32).abs();
            }
        }
    }
    if rotation == 90 || rotation == 270 {
        std::mem::swap(&mut width, &mut height);
    }

    if width == 0 || height == 0 {
        return Err(AppError::validation(
            "UNSUPPORTED_MEDIA",
            "Video dimensions could not be determined.",
        ));
    }

    let duration_sec = fmt_info
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&d| d > 0.0)
        .or_else(|| {
            v_stream
                .get("duration")
                .and_then(|d| d.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|&d| d > 0.0)
        })
        .ok_or_else(|| {
            AppError::validation(
                "UNSUPPORTED_MEDIA",
                "Video duration could not be determined or is zero.",
            )
        })?;

    if check_duration_limit && duration_sec > MAX_SOURCE_DURATION_SECS {
        return Err(AppError::validation(
            "UNSUPPORTED_MEDIA",
            format!(
                "Video duration ({}s) exceeds the maximum allowed limit of {}s.",
                duration_sec as u64, MAX_SOURCE_DURATION_SECS as u64
            ),
        ));
    }

    let duration_ms = ((duration_sec * 1000.0).round() as i64).max(1);
    let raw_fps = v_stream
        .get("avg_frame_rate")
        .and_then(|v| v.as_str())
        .filter(|s| *s != "0/0")
        .or_else(|| v_stream.get("r_frame_rate").and_then(|v| v.as_str()));
    let fps_float = parse_frame_rate(raw_fps);

    Ok(MediaMetadata {
        duration_ms: Some(duration_ms),
        width,
        height,
        video_codec: v_stream
            .get("codec_name")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        audio_codec: a_stream
            .and_then(|a| a.get("codec_name"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        frame_rate: Some(format_fps_display(fps_float)),
        fps_float,
        pixel_format: v_stream
            .get("pix_fmt")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        has_audio: a_stream.is_some(),
        size_bytes: meta.len(),
        mime_type: "video/mp4".to_string(),
    })
}
