use crate::error::{AppError, AppResult};
use crate::media::pipeline::run_ffmpeg_command;
use image::{ImageFormat, Rgba, RgbaImage};
use std::path::Path;

/// Generates a synthetic MP4 (H.264 + speech-envelope modulated AAC audio) using FFmpeg `lavfi`.
pub async fn generate_synthetic_video(
    output_path: &Path,
    duration_sec: f64,
    width: u32,
    height: u32,
    fps: u32,
    with_audio: bool,
    freq_hz: u32,
) -> AppResult<()> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut args = vec![
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        format!("testsrc2=size={width}x{height}:rate={fps}:duration={duration_sec}"),
    ];

    if with_audio {
        args.extend([
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            format!(
                "aevalsrc='0.35*sin(2*PI*{freq_hz}*t)*gt(sin(2*PI*0.42*t),-0.25)':s=48000:d={duration_sec}"
            ),
            "-c:a".to_string(),
            "aac".to_string(),
            "-ar".to_string(),
            "48000".to_string(),
            "-ac".to_string(),
            "2".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
        ]);
    }

    args.extend([
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "ultrafast".to_string(),
        "-crf".to_string(),
        "22".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().into_owned(),
    ]);

    run_ffmpeg_command(
        &args,
        "RENDER_FAILED",
        "Failed to synthesize sample video.",
        120,
    )
    .await
}

fn signed_distance_rounded_rect(px: f32, py: f32, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> f32 {
    let cx = (x0 + x1) * 0.5;
    let cy = (y0 + y1) * 0.5;
    let hx = (x1 - x0) * 0.5 - r;
    let hy = (y1 - y0) * 0.5 - r;
    let dx = ((px - cx).abs() - hx).max(0.0);
    let dy = ((py - cy).abs() - hy).max(0.0);
    (dx * dx + dy * dy).sqrt() - r
}

fn point_in_triangle(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32, cx: f32, cy: f32) -> bool {
    let d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    let d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    let d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    let has_neg = (d1 < 0.0) || (d2 < 0.0) || (d3 < 0.0);
    let has_pos = (d1 > 0.0) || (d2 > 0.0) || (d3 > 0.0);
    !(has_neg && has_pos)
}

/// Generates a crisp transparent RGBA PNG brand badge in pure Rust using signed-distance-field geometry.
pub fn generate_synthetic_logo(output_path: &Path, width: u32, height: u32) -> AppResult<()> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut img = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    let w = width as f32;
    let h = height as f32;

    for y in 0..height {
        for x in 0..width {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;

            let sd_outer = signed_distance_rounded_rect(px, py, 4.0, 4.0, w - 4.0, h - 4.0, 18.0);
            if sd_outer <= 0.5 {
                let mut color = if sd_outer > -2.5 {
                    Rgba([255, 255, 255, 240])
                } else {
                    Rgba([79, 70, 229, 232])
                };

                // Play icon triangle
                if point_in_triangle(px, py, 28.0, 26.0, 28.0, h - 26.0, 68.0, h * 0.5) {
                    color = Rgba([255, 255, 255, 255]);
                }
                // Primary title bar
                if signed_distance_rounded_rect(px, py, 86.0, 30.0, w - 28.0, 46.0, 6.0) <= 0.0 {
                    color = Rgba([255, 255, 255, 255]);
                }
                // Subtitle accent bar
                if signed_distance_rounded_rect(px, py, 86.0, 56.0, w - 68.0, 68.0, 4.0) <= 0.0 {
                    color = Rgba([199, 210, 254, 245]);
                }

                img.put_pixel(x, y, color);
            }
        }
    }

    img.save_with_format(output_path, ImageFormat::Png)
        .map_err(|e| AppError::internal("LOGO_GEN_FAILED", "Failed to write PNG logo.", e.to_string()))?;
    Ok(())
}
