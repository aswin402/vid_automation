use crate::error::{AppError, AppResult};
use crate::media::pipeline::{run_ffmpeg_command, validate_trim_range};
use crate::media::probe::MediaMetadata;
use crate::models::{AutoFrameRequest, AutoFrameResponse, CropKeyframe, CropSettings, FaceBox};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgb, RgbImage};
use std::io::Cursor;
use std::path::Path;
use std::sync::OnceLock;
use tracing::info;
use tract_onnx::prelude::*;

const ULTRAFACE_W: u32 = 320;
const ULTRAFACE_H: u32 = 240;

type UltraFacePlan = std::sync::Arc<TypedRunnableModel>;

static ULTRAFACE_MODEL: OnceLock<Result<UltraFacePlan, String>> = OnceLock::new();

fn get_ultraface_plan() -> Result<&'static UltraFacePlan, String> {
    ULTRAFACE_MODEL
        .get_or_init(|| {
            let bytes = include_bytes!("../../assets/version-RFB-320.onnx");
            let mut cursor = Cursor::new(bytes);
            tract_onnx::onnx()
                .model_for_read(&mut cursor)
                .and_then(|m| m.with_input_fact(0, f32::fact([1, 3, 240, 320]).into()))
                .and_then(|m| m.into_optimized())
                .and_then(|m| m.into_runnable())
                .map_err(|e| format!("Failed to initialize UltraFace ONNX model: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn round_even_u32(val: f64, min_even: u32) -> u32 {
    let half = (val / 2.0).round().max(1.0) as u32;
    (half * 2).max(min_even)
}

/// Returns numeric target aspect ratio `width / height` for known presets,
/// or `None` for `"custom"` freeform crops.
pub fn parse_aspect_ratio(preset: &str, src_w: u32, src_h: u32) -> Option<f64> {
    let sw = src_w.max(2) as f64;
    let sh = src_h.max(2) as f64;
    match preset.trim() {
        "9:16" => Some(9.0 / 16.0),
        "1:1" => Some(1.0),
        "4:5" => Some(4.0 / 5.0),
        "16:9" => Some(16.0 / 9.0),
        "4:3" => Some(4.0 / 3.0),
        "21:9" => Some(21.0 / 9.0),
        "custom" => None,
        _ => Some(sw / sh),
    }
}

/// Computes normalized `(width, height)` in `(0.05..=1.0]` for a locked aspect ratio and zoom `[1.0, 3.0]`.
pub fn compute_aspect_crop_size(
    aspect_ratio: &str,
    src_w: u32,
    src_h: u32,
    zoom: f64,
) -> (f64, f64) {
    let z = zoom.clamp(1.0, 3.0);
    let sw = src_w.max(2) as f64;
    let sh = src_h.max(2) as f64;
    let src_aspect = sw / sh;

    let Some(target_aspect) = parse_aspect_ratio(aspect_ratio, src_w, src_h) else {
        return ((1.0 / z).clamp(0.05, 1.0), (1.0 / z).clamp(0.05, 1.0));
    };

    let (max_w, max_h) = if target_aspect <= src_aspect {
        ((target_aspect / src_aspect).clamp(0.05, 1.0), 1.0)
    } else {
        (1.0, (src_aspect / target_aspect).clamp(0.05, 1.0))
    };

    ((max_w / z).clamp(0.05, 1.0), (max_h / z).clamp(0.05, 1.0))
}

/// Computes target output pixel dimensions `(out_w, out_h)` (always even integers `>= 2`),
/// matching frontend `resolveTargetOutputDimensions` 1:1.
pub fn resolve_target_output_dimensions(
    crop_cfg: Option<&CropSettings>,
    src_w: u32,
    src_h: u32,
    explicit_w: Option<u32>,
    explicit_h: Option<u32>,
) -> (u32, u32) {
    if let (Some(ew), Some(eh)) = (explicit_w, explicit_h) {
        return (((ew / 2) * 2).max(2), ((eh / 2) * 2).max(2));
    }

    let sw = ((src_w / 2) * 2).max(2);
    let sh = ((src_h / 2) * 2).max(2);

    let Some(crop) = crop_cfg else {
        return (sw, sh);
    };
    if !crop.enabled {
        return (sw, sh);
    }

    if crop.aspect_ratio == "custom" {
        let cw = round_even_u32(sw as f64 * crop.width.clamp(0.05, 1.0), 2);
        let ch = round_even_u32(sh as f64 * crop.height.clamp(0.05, 1.0), 2);
        return (cw, ch);
    }

    if crop.aspect_ratio == "original" || crop.aspect_ratio.trim().is_empty() {
        return (sw, sh);
    }

    let Some(target_aspect) = parse_aspect_ratio(&crop.aspect_ratio, sw, sh) else {
        return (sw, sh);
    };

    let base_dim = sw.min(sh).max(2) as f64;
    let max_long = sw.max(sh).max(2) as f64;

    let (mut w_f, mut h_f) = if target_aspect < 1.0 - 1e-4 {
        (base_dim, base_dim / target_aspect)
    } else if (target_aspect - 1.0).abs() <= 1e-4 {
        (base_dim, base_dim)
    } else {
        (base_dim * target_aspect, base_dim)
    };

    let longest = w_f.max(h_f);
    if longest > max_long * 1.02 {
        let scale_down = max_long / longest;
        w_f *= scale_down;
        h_f *= scale_down;
    }

    (round_even_u32(w_f, 2), round_even_u32(h_f, 2))
}

/// Builds a comma-free, colon-free, quote-free FFmpeg `libavutil/eval` expression
/// for exact $C^0$ piecewise-linear interpolation over `(time_sec, pixel_coord)` keyframes:
///   `v(t) = v_0 + sum_i ((v_{i+1} - v_i) / (2 * dt_i)) * (abs(t - t_i) - abs(t - t_{i+1}) + dt_i)`
pub fn build_piecewise_linear_ffmpeg_expr(points: &[(f64, f64)], max_px: u32) -> String {
    if points.is_empty() || max_px == 0 {
        return "0".to_string();
    }
    let clamped_first = points[0].1.clamp(0.0, max_px as f64);
    if points.len() == 1 {
        return format!("{:.2}", clamped_first);
    }

    let mut expr = format!("{:.3}", clamped_first);
    for pair in points.windows(2) {
        let (t0, v0_raw) = pair[0];
        let (t1, v1_raw) = pair[1];
        let dt = t1 - t0;
        if dt <= 1e-3 {
            continue;
        }
        let v0 = v0_raw.clamp(0.0, max_px as f64);
        let v1 = v1_raw.clamp(0.0, max_px as f64);
        let dv = v1 - v0;
        if dv.abs() < 0.05 {
            continue;
        }
        let half_slope = dv / (2.0 * dt);
        let sign = if half_slope >= 0.0 { "+" } else { "-" };
        let abs_slope = half_slope.abs();
        expr.push_str(&format!(
            "{sign}{abs_slope:.5}*(abs(t-{t0:.3})-abs(t-{t1:.3})+{dt:.3})"
        ));
    }

    if expr == format!("{:.3}", clamped_first) {
        format!("{}", clamped_first.round() as u32)
    } else {
        format!("({expr})")
    }
}

/// Builds the FFmpeg video spatial filter (`crop` + `scale` / `pad`) for `trim_video_segment`.
pub fn build_crop_and_scale_video_filter(
    crop_cfg: Option<&CropSettings>,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
) -> String {
    let sw = src_w.max(2);
    let sh = src_h.max(2);

    let Some(crop) = crop_cfg.filter(|c| c.enabled) else {
        return format!(
            "scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black"
        );
    };

    let w_norm = crop.width.clamp(0.05, 1.0);
    let h_norm = crop.height.clamp(0.05, 1.0);
    let x_norm = crop.x.clamp(0.0, (1.0 - w_norm).max(0.0));
    let y_norm = crop.y.clamp(0.0, (1.0 - h_norm).max(0.0));

    let max_even_w = ((sw / 2) * 2).max(2);
    let max_even_h = ((sh / 2) * 2).max(2);
    let cw_px = round_even_u32(sw as f64 * w_norm, 2).min(max_even_w);
    let ch_px = round_even_u32(sh as f64 * h_norm, 2).min(max_even_h);
    let max_x_px = sw.saturating_sub(cw_px);
    let max_y_px = sh.saturating_sub(ch_px);

    if crop.fit_mode == "pad" {
        let mut stages = Vec::new();
        if cw_px < max_even_w || ch_px < max_even_h {
            let cx_px = ((sw as f64 * x_norm).round() as u32).min(max_x_px);
            let cy_px = ((sh as f64 * y_norm).round() as u32).min(max_y_px);
            stages.push(format!("crop={cw_px}:{ch_px}:{cx_px}:{cy_px}"));
        }
        stages.push(format!(
            "scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black"
        ));
        return stages.join(",");
    }

    let (x_expr, y_expr) = if crop.dynamic_tracking && crop.keyframes.len() >= 2 {
        let x_pts: Vec<(f64, f64)> = crop
            .keyframes
            .iter()
            .map(|kf| {
                let t_sec = (kf.time_ms.max(0) as f64) / 1000.0;
                let px = (sw as f64 * kf.x.clamp(0.0, (1.0 - w_norm).max(0.0)))
                    .clamp(0.0, max_x_px as f64);
                (t_sec, px)
            })
            .collect();
        let y_pts: Vec<(f64, f64)> = crop
            .keyframes
            .iter()
            .map(|kf| {
                let t_sec = (kf.time_ms.max(0) as f64) / 1000.0;
                let py = (sh as f64 * kf.y.clamp(0.0, (1.0 - h_norm).max(0.0)))
                    .clamp(0.0, max_y_px as f64);
                (t_sec, py)
            })
            .collect();
        (
            build_piecewise_linear_ffmpeg_expr(&x_pts, max_x_px),
            build_piecewise_linear_ffmpeg_expr(&y_pts, max_y_px),
        )
    } else {
        let cx_px = ((sw as f64 * x_norm).round() as u32).min(max_x_px);
        let cy_px = ((sh as f64 * y_norm).round() as u32).min(max_y_px);
        (cx_px.to_string(), cy_px.to_string())
    };

    if cw_px == out_w && ch_px == out_h {
        format!("crop={cw_px}:{ch_px}:{x_expr}:{y_expr}")
    } else {
        format!("crop={cw_px}:{ch_px}:{x_expr}:{y_expr},scale={out_w}:{out_h}:flags=lanczos")
    }
}

fn iou(a: &FaceBox, b: &FaceBox) -> f64 {
    let ax2 = a.x + a.width;
    let ay2 = a.y + a.height;
    let bx2 = b.x + b.width;
    let by2 = b.y + b.height;

    let ix1 = a.x.max(b.x);
    let iy1 = a.y.max(b.y);
    let ix2 = ax2.min(bx2);
    let iy2 = ay2.min(by2);

    let iw = (ix2 - ix1).max(0.0);
    let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    if inter <= 0.0 {
        return 0.0;
    }
    let union = (a.width * a.height) + (b.width * b.height) - inter;
    if union <= 1e-9 {
        0.0
    } else {
        inter / union
    }
}

fn non_max_suppression(mut candidates: Vec<FaceBox>, iou_threshold: f64) -> Vec<FaceBox> {
    candidates.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<FaceBox> = Vec::new();
    for cand in candidates {
        if kept.iter().all(|existing| iou(existing, &cand) < iou_threshold) {
            kept.push(cand);
        }
    }
    kept
}

/// Runs pure-Rust UltraFace RFB-320 ONNX inference on any `DynamicImage`, letterboxing
/// onto `320×240` so portrait (`9:16`) and widescreen (`16:9`/`21:9`) faces retain 1:1 natural
/// proportions, then unmaps normalized `[0, 1]` coordinates back to the original frame.
pub fn detect_faces_in_image(img: &DynamicImage) -> Result<Vec<FaceBox>, String> {
    let plan = get_ultraface_plan()?;
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Ok(Vec::new());
    }

    let scale = (ULTRAFACE_W as f64 / orig_w as f64).min(ULTRAFACE_H as f64 / orig_h as f64);
    let scaled_w = ((orig_w as f64 * scale).round() as u32).clamp(1, ULTRAFACE_W);
    let scaled_h = ((orig_h as f64 * scale).round() as u32).clamp(1, ULTRAFACE_H);
    let pad_x = (ULTRAFACE_W - scaled_w) / 2;
    let pad_y = (ULTRAFACE_H - scaled_h) / 2;

    let resized = img
        .resize_exact(scaled_w, scaled_h, FilterType::Triangle)
        .to_rgb8();

    let mut canvas = RgbImage::from_pixel(ULTRAFACE_W, ULTRAFACE_H, Rgb([0, 0, 0]));
    for y in 0..scaled_h {
        for x in 0..scaled_w {
            canvas.put_pixel(x + pad_x, y + pad_y, *resized.get_pixel(x, y));
        }
    }

    let hw = (ULTRAFACE_H * ULTRAFACE_W) as usize;
    let mut tensor_data = vec![0.0f32; 3 * hw];
    for y in 0..ULTRAFACE_H {
        for x in 0..ULTRAFACE_W {
            let px = canvas.get_pixel(x, y);
            let idx = (y * ULTRAFACE_W + x) as usize;
            tensor_data[idx] = (px[0] as f32 - 127.0) / 128.0;
            tensor_data[hw + idx] = (px[1] as f32 - 127.0) / 128.0;
            tensor_data[2 * hw + idx] = (px[2] as f32 - 127.0) / 128.0;
        }
    }

    let input_tensor = tract_ndarray::Array4::from_shape_vec(
        (1, 3, ULTRAFACE_H as usize, ULTRAFACE_W as usize),
        tensor_data,
    )
    .map_err(|e| format!("Tensor shape error: {e}"))?
    .into_tensor();

    let outputs = plan
        .run(tvec!(input_tensor.into()))
        .map_err(|e| format!("UltraFace inference failed: {e}"))?;

    let mut scores_tensor = None;
    let mut boxes_tensor = None;
    for out in &outputs {
        let shape = out.shape();
        if shape.last() == Some(&2) {
            scores_tensor = Some(out);
        } else if shape.last() == Some(&4) {
            boxes_tensor = Some(out);
        }
    }

    let (Some(scores_t), Some(boxes_t)) = (scores_tensor, boxes_tensor) else {
        return Err("Unexpected UltraFace output tensor shapes.".into());
    };

    let scores_vec: Vec<f32> = scores_t
        .to_plain_array_view::<f32>()
        .map_err(|e| format!("Failed reading scores tensor: {e}"))?
        .iter()
        .copied()
        .collect();
    let boxes_vec: Vec<f32> = boxes_t
        .to_plain_array_view::<f32>()
        .map_err(|e| format!("Failed reading boxes tensor: {e}"))?
        .iter()
        .copied()
        .collect();
    let scores_slice = scores_vec.as_slice();
    let boxes_slice = boxes_vec.as_slice();

    let num_anchors = scores_slice.len() / 2;
    let pad_x_f = pad_x as f64;
    let pad_y_f = pad_y as f64;
    let sw_f = scaled_w as f64;
    let sh_f = scaled_h as f64;

    let mut raw_candidates = Vec::new();
    for i in 0..num_anchors {
        let face_prob = scores_slice[i * 2 + 1] as f64;
        if face_prob < 0.52 {
            continue;
        }
        let bx1 = boxes_slice[i * 4] as f64;
        let by1 = boxes_slice[i * 4 + 1] as f64;
        let bx2 = boxes_slice[i * 4 + 2] as f64;
        let by2 = boxes_slice[i * 4 + 3] as f64;

        let x1 = ((bx1 * ULTRAFACE_W as f64 - pad_x_f) / sw_f).clamp(0.0, 1.0);
        let y1 = ((by1 * ULTRAFACE_H as f64 - pad_y_f) / sh_f).clamp(0.0, 1.0);
        let x2 = ((bx2 * ULTRAFACE_W as f64 - pad_x_f) / sw_f).clamp(0.0, 1.0);
        let y2 = ((by2 * ULTRAFACE_H as f64 - pad_y_f) / sh_f).clamp(0.0, 1.0);

        let w = x2 - x1;
        let h = y2 - y1;
        if w > 0.025 && h > 0.025 {
            raw_candidates.push(FaceBox {
                x: (x1 * 10000.0).round() / 10000.0,
                y: (y1 * 10000.0).round() / 10000.0,
                width: (w * 10000.0).round() / 10000.0,
                height: (h * 10000.0).round() / 10000.0,
                confidence: (face_prob * 1000.0).round() / 1000.0,
            });
        }
    }

    Ok(non_max_suppression(raw_candidates, 0.35))
}

/// Selects the primary foreground speaker face from a frame's detected faces,
/// weighting face area + confidence + proximity to horizontal center so tiny
/// background picture frames never steal focus from the main speaker.
fn pick_primary_speaker(faces: &[FaceBox]) -> Option<FaceBox> {
    faces
        .iter()
        .max_by(|a, b| {
            let score_a = foreground_speaker_score(a);
            let score_b = foreground_speaker_score(b);
            score_a
                .partial_cmp(&score_b)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned()
}

fn foreground_speaker_score(f: &FaceBox) -> f64 {
    let area = (f.width * f.height).max(1e-6);
    let cx = f.x + f.width * 0.5;
    let center_bias = 1.0 - 0.22 * (cx - 0.5).abs();
    f.confidence * area.sqrt() * center_bias
}

/// Computes optimal top-left `(crop_x, crop_y)` given a face bounding box and normalized crop `(crop_w, crop_h)`,
/// placing the speaker's face center on the horizontal midline and upper-third rule-of-thirds headroom line (`0.36 * crop_h`),
/// while guarding against clipping the crown of the head.
pub fn compute_face_framed_crop_origin(
    face: &FaceBox,
    crop_w: f64,
    crop_h: f64,
) -> (f64, f64) {
    let fcx = face.x + face.width * 0.5;
    let fcy = face.y + face.height * 0.5;

    let ideal_x = fcx - 0.50 * crop_w;
    let mut ideal_y = fcy - 0.36 * crop_h;

    // Headroom guard: keep at least 35% of face height above `face.y` whenever crop_h allows it
    let crown_guard_y = face.y - 0.35 * face.height;
    if ideal_y > crown_guard_y && (face.height * 1.65) < crop_h {
        ideal_y = crown_guard_y;
    }

    let max_x = (1.0 - crop_w).max(0.0);
    let max_y = (1.0 - crop_h).max(0.0);
    (ideal_x.clamp(0.0, max_x), ideal_y.clamp(0.0, max_y))
}

fn median_f64(mut vals: Vec<f64>) -> f64 {
    if vals.is_empty() {
        return 0.5;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = vals.len() / 2;
    if vals.len() % 2 == 1 {
        vals[mid]
    } else {
        0.5 * (vals[mid - 1] + vals[mid])
    }
}

/// Samples frames across the trimmed video segment, runs UltraFace ONNX detection,
/// computes optimal zoom + rule-of-thirds face framing, and builds optional smoothed
/// speaker-tracking keyframes.
pub async fn analyze_video_auto_frame(
    source_path: &Path,
    source_meta: &MediaMetadata,
    start_ms: i64,
    end_ms: Option<i64>,
    req: &AutoFrameRequest,
    scratch_dir: &Path,
) -> AppResult<AutoFrameResponse> {
    let (s_ms, e_ms) = validate_trim_range(
        start_ms,
        end_ms,
        source_meta.duration_ms.unwrap_or(0),
    )?;
    let trimmed_dur_ms = (e_ms - s_ms).max(200);
    let duration_sec = trimmed_dur_ms as f64 / 1000.0;
    let start_sec = s_ms as f64 / 1000.0;

    let num_samples = ((duration_sec / 2.0).ceil() as usize).clamp(3, 10);
    let sample_fps = (num_samples as f64 / duration_sec).max(0.15);

    tokio::fs::create_dir_all(scratch_dir).await?;

    // Decode sampled frames at max 640px long-edge in a single fast FFmpeg pass
    let frame_pattern = scratch_dir.join("face_sample_%03d.jpg");
    let extract_args = vec![
        "-ss".to_string(),
        format!("{start_sec:.3}"),
        "-t".to_string(),
        format!("{duration_sec:.3}"),
        "-i".to_string(),
        source_path.to_string_lossy().into_owned(),
        "-vf".to_string(),
        format!("fps={sample_fps:.4},scale=640:640:force_original_aspect_ratio=decrease"),
        "-frames:v".to_string(),
        (num_samples + 2).to_string(),
        "-q:v".to_string(),
        "3".to_string(),
        frame_pattern.to_string_lossy().into_owned(),
    ];

    run_ffmpeg_command(
        &extract_args,
        "AUTO_FRAME_EXTRACT_FAILED",
        "Failed to sample video frames for AI face detection.",
        120,
    )
    .await?;

    let scratch_owned = scratch_dir.to_path_buf();
    let detections: Vec<(i64, Option<FaceBox>)> = tokio::task::spawn_blocking(move || {
        let mut frame_files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&scratch_owned) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("jpg") {
                    frame_files.push(p);
                }
            }
        }
        frame_files.sort();

        let total = frame_files.len();
        let mut results = Vec::with_capacity(total);
        for (idx, path) in frame_files.into_iter().enumerate() {
            let rel_ms = if total <= 1 {
                0
            } else {
                ((idx as f64 / (total - 1) as f64) * trimmed_dur_ms as f64).round() as i64
            };
            let primary = image::open(&path)
                .ok()
                .and_then(|img| detect_faces_in_image(&img).ok())
                .and_then(|faces| pick_primary_speaker(&faces));
            results.push((rel_ms, primary));
        }
        results
    })
    .await
    .map_err(|e| AppError::internal("AUTO_FRAME_FAILED", "Face detection worker failed.", e.to_string()))?;

    let sampled_frames = detections.len();
    let found_faces: Vec<(i64, FaceBox)> = detections
        .iter()
        .filter_map(|(t, f)| f.as_ref().map(|fb| (*t, fb.clone())))
        .collect();
    let faces_found_frames = found_faces.len();

    let aspect_preset = if req.aspect_ratio.trim().is_empty() {
        "original".to_string()
    } else {
        req.aspect_ratio.trim().to_string()
    };

    let src_w = source_meta.width.max(2);
    let src_h = source_meta.height.max(2);

    if found_faces.is_empty() {
        let zoom = req.target_zoom.unwrap_or(1.0).clamp(1.0, 3.0);
        let (cw, ch) = compute_aspect_crop_size(&aspect_preset, src_w, src_h, zoom);
        let cx = ((1.0 - cw) * 0.5 * 10000.0).round() / 10000.0;
        let cy = ((1.0 - ch) * 0.35 * 10000.0).round() / 10000.0;

        let crop = CropSettings {
            enabled: aspect_preset != "original" || zoom > 1.01,
            aspect_ratio: aspect_preset,
            fit_mode: "crop".into(),
            x: cx,
            y: cy,
            width: (cw * 10000.0).round() / 10000.0,
            height: (ch * 10000.0).round() / 10000.0,
            zoom,
            auto_face_framing: false,
            dynamic_tracking: false,
            detected_face: None,
            keyframes: Vec::new(),
        };

        return Ok(AutoFrameResponse {
            face_detected: false,
            sampled_frames,
            faces_found_frames: 0,
            primary_face: None,
            crop,
            message: "No clear frontal face detected in sampled frames — applied upper-third studio center framing.".into(),
        });
    }

    // Aggregate canonical median speaker face across all detected frames (robust against transient turns/blinks)
    let med_x = median_f64(found_faces.iter().map(|(_, f)| f.x).collect());
    let med_y = median_f64(found_faces.iter().map(|(_, f)| f.y).collect());
    let med_w = median_f64(found_faces.iter().map(|(_, f)| f.width).collect());
    let med_h = median_f64(found_faces.iter().map(|(_, f)| f.height).collect());
    let avg_conf = found_faces.iter().map(|(_, f)| f.confidence).sum::<f64>()
        / (faces_found_frames as f64);

    let canonical_face = FaceBox {
        x: (med_x * 10000.0).round() / 10000.0,
        y: (med_y * 10000.0).round() / 10000.0,
        width: (med_w * 10000.0).round() / 10000.0,
        height: (med_h * 10000.0).round() / 10000.0,
        confidence: (avg_conf * 1000.0).round() / 1000.0,
    };

    // Determine smart zoom:
    // If user requested explicit target_zoom, honor it; otherwise if base crop is full-frame (1.0 x 1.0)
    // or leaves the face very small (< 20% of crop height), apply gentle smart zoom so auto-framing visibly reframes the speaker!
    let (base_cw, base_ch) = compute_aspect_crop_size(&aspect_preset, src_w, src_h, 1.0);
    let smart_zoom = if let Some(user_z) = req.target_zoom {
        user_z.clamp(1.0, 3.0)
    } else {
        let face_to_crop_h = canonical_face.height / base_ch.max(0.05);
        if base_cw >= 0.99 && base_ch >= 0.99 {
            // Same aspect ratio as source (e.g. 9:16 -> 9:16 / Original): zoom in to medium bust shot (~27% face-to-frame height)
            (0.27 / face_to_crop_h.max(0.08)).clamp(1.22, 1.85)
        } else if face_to_crop_h < 0.17 {
            (0.22 / face_to_crop_h.max(0.06)).clamp(1.0, 1.65)
        } else {
            1.0
        }
    };
    let rounded_zoom = (smart_zoom * 100.0).round() / 100.0;

    let (crop_w, crop_h) = compute_aspect_crop_size(&aspect_preset, src_w, src_h, rounded_zoom);
    let (static_x, static_y) = compute_face_framed_crop_origin(&canonical_face, crop_w, crop_h);

    // Build smoothed dynamic speaker-tracking keyframes when `dynamic_tracking` is requested
    let mut keyframes = Vec::new();
    if req.dynamic_tracking && detections.len() >= 2 {
        // Fill missing frames by nearest detected face, then apply bidirectional EMA + deadband hysteresis
        let mut raw_origins: Vec<(i64, f64, f64)> = Vec::with_capacity(detections.len());
        let mut last_face = canonical_face.clone();
        for (t_ms, face_opt) in &detections {
            if let Some(f) = face_opt {
                last_face = f.clone();
            }
            let (ox, oy) = compute_face_framed_crop_origin(&last_face, crop_w, crop_h);
            raw_origins.push((*t_ms, ox, oy));
        }

        // Forward + backward EMA smoothing (`alpha = 0.4`) for zero phase lag fluid tripod motion
        let alpha = 0.40;
        let mut fwd = raw_origins.clone();
        for i in 1..fwd.len() {
            fwd[i].1 = alpha * raw_origins[i].1 + (1.0 - alpha) * fwd[i - 1].1;
            fwd[i].2 = alpha * raw_origins[i].2 + (1.0 - alpha) * fwd[i - 1].2;
        }
        let mut smooth = fwd.clone();
        for i in (0..smooth.len() - 1).rev() {
            smooth[i].1 = alpha * fwd[i].1 + (1.0 - alpha) * smooth[i + 1].1;
            smooth[i].2 = alpha * fwd[i].2 + (1.0 - alpha) * smooth[i + 1].2;
        }

        // Deadband filter (1.2% of frame) so micro head nods stay rock-steady
        let mut anchor_x = smooth[0].1;
        let mut anchor_y = smooth[0].2;
        for (idx, (t_ms, sx, sy)) in smooth.iter().enumerate() {
            if idx == 0 || (*sx - anchor_x).abs() > 0.012 {
                anchor_x = *sx;
            }
            if idx == 0 || (*sy - anchor_y).abs() > 0.012 {
                anchor_y = *sy;
            }
            keyframes.push(CropKeyframe {
                time_ms: *t_ms,
                x: (anchor_x * 10000.0).round() / 10000.0,
                y: (anchor_y * 10000.0).round() / 10000.0,
            });
        }

        // Ensure final keyframe spans to `trimmed_dur_ms`
        if let Some(last) = keyframes.last_mut() {
            last.time_ms = trimmed_dur_ms;
        }
    }

    let final_x = keyframes
        .first()
        .map(|k| k.x)
        .unwrap_or_else(|| (static_x * 10000.0).round() / 10000.0);
    let final_y = keyframes
        .first()
        .map(|k| k.y)
        .unwrap_or_else(|| (static_y * 10000.0).round() / 10000.0);

    let crop = CropSettings {
        enabled: true,
        aspect_ratio: aspect_preset.clone(),
        fit_mode: "crop".into(),
        x: final_x,
        y: final_y,
        width: (crop_w * 10000.0).round() / 10000.0,
        height: (crop_h * 10000.0).round() / 10000.0,
        zoom: rounded_zoom,
        auto_face_framing: true,
        dynamic_tracking: req.dynamic_tracking && keyframes.len() >= 2,
        detected_face: Some(canonical_face.clone()),
        keyframes,
    };

    info!(
        sampled_frames = sampled_frames,
        faces_found_frames = faces_found_frames,
        confidence = canonical_face.confidence,
        aspect_ratio = %aspect_preset,
        crop_x = crop.x,
        crop_y = crop.y,
        crop_w = crop.width,
        crop_h = crop.height,
        zoom = crop.zoom,
        dynamic_tracking = crop.dynamic_tracking,
        "auto_face_frame_completed"
    );

    Ok(AutoFrameResponse {
        face_detected: true,
        sampled_frames,
        faces_found_frames,
        primary_face: Some(canonical_face.clone()),
        crop,
        message: format!(
            "AI Face Framing locked onto speaker across {faces_found_frames}/{sampled_frames} sampled frames ({:.0}% confidence).",
            canonical_face.confidence * 100.0
        ),
    })
}
