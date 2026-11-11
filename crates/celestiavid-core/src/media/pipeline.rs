use crate::error::{AppError, AppResult};
use crate::media::ffmpeg_bin::{
    configure_tokio_background_cmd, normalize_platform_path, resolve_ffmpeg_paths,
};
use crate::media::geometry::{affine_overlay_expressions, resolve_anchor_vector};
use crate::media::probe::{probe_video_file, MediaMetadata};
use crate::models::{
    AudioEnhancementSettings, ColorCorrectionSettings, LogoSettings, OutputSettings,
};
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tracing::info;

pub async fn run_ffmpeg_command(
    args: &[String],
    error_code: &str,
    safe_message: &str,
    timeout_secs: u64,
) -> AppResult<()> {
    let bins = resolve_ffmpeg_paths()?;
    info!(arg_count = args.len(), "ffmpeg_exec_start");

    let mut cmd = Command::new(&bins.ffmpeg);
    configure_tokio_background_cmd(&mut cmd);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"]);
    cmd.args(args);

    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| AppError::internal(error_code, format!("{safe_message} (Timed out)"), "timeout"))?
        .map_err(|e| AppError::internal(error_code, safe_message, e.to_string()))?;

    if !output.status.success() {
        let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AppError::internal(error_code, safe_message, stderr_str));
    }

    Ok(())
}

pub fn validate_trim_range(
    start_ms: i64,
    end_ms: Option<i64>,
    source_duration_ms: i64,
) -> AppResult<(i64, i64)> {
    let resolved_end = end_ms.unwrap_or(source_duration_ms);
    if start_ms < 0 {
        return Err(AppError::validation(
            "INVALID_TRIM_RANGE",
            "Start timestamp cannot be negative.",
        ));
    }
    if resolved_end <= start_ms {
        return Err(AppError::validation(
            "INVALID_TRIM_RANGE",
            "The end time must be later than the start time.",
        ));
    }
    if resolved_end - start_ms < 200 {
        return Err(AppError::validation(
            "INVALID_TRIM_RANGE",
            "Trimmed clip duration must be at least 0.2 seconds (200 ms).",
        ));
    }
    if resolved_end > source_duration_ms + 50 {
        return Err(AppError::validation(
            "INVALID_TRIM_RANGE",
            format!("The selected end time is longer than the source video ({source_duration_ms} ms)."),
        ));
    }
    Ok((start_ms, resolved_end.min(source_duration_ms)))
}

pub fn compute_logo_overlay_expressions(logo_cfg: &LogoSettings) -> (String, String) {
    let margin = logo_cfg.margin_ratio.clamp(0.0, 0.25);
    if let (Some(xr), Some(yr)) = (logo_cfg.x_ratio, logo_cfg.y_ratio) {
        return affine_overlay_expressions(xr, yr, 0.0, 0.0);
    }
    let (ax, ay) = resolve_anchor_vector(&logo_cfg.position, (1.0, 0.0));
    affine_overlay_expressions(ax, ay, margin, margin)
}

fn normalization_scale_filter(mode: &str, out_w: u32, out_h: u32) -> String {
    match mode {
        "crop" => format!(
            "scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h}"
        ),
        "stretch" => format!("scale={out_w}:{out_h}"),
        _ => format!(
            "scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black"
        ),
    }
}

fn resolve_encoding_profile(cfg: Option<&OutputSettings>) -> (String, String, String, String) {
    let Some(c) = cfg else {
        return ("libx264".into(), "fast".into(), "20".into(), "aac".into());
    };
    (
        c.video_codec.clone(),
        c.preset.clone(),
        c.crf.to_string(),
        c.audio_codec.clone(),
    )
}

pub async fn trim_video_segment(
    source_path: &Path,
    output_path: &Path,
    start_ms: i64,
    end_ms: i64,
    source_meta: &MediaMetadata,
    output_cfg: Option<&OutputSettings>,
) -> AppResult<MediaMetadata> {
    let (s_ms, e_ms) = validate_trim_range(
        start_ms,
        Some(end_ms),
        source_meta.duration_ms.unwrap_or(0),
    )?;
    let duration_sec = (e_ms - s_ms) as f64 / 1000.0;
    let start_sec = s_ms as f64 / 1000.0;

    let raw_w = output_cfg.and_then(|c| c.width).unwrap_or(source_meta.width);
    let raw_h = output_cfg.and_then(|c| c.height).unwrap_or(source_meta.height);
    let out_w = ((raw_w / 2) * 2).max(2);
    let out_h = ((raw_h / 2) * 2).max(2);
    let out_fps = output_cfg
        .and_then(|c| c.fps)
        .unwrap_or_else(|| if source_meta.fps_float > 0.0 { source_meta.fps_float } else { 30.0 });

    let (v_codec, preset, crf, a_codec) = resolve_encoding_profile(output_cfg);
    let scale_f = normalization_scale_filter("pad", out_w, out_h);
    let vf_chain = format!("{scale_f},setsar=1,fps={out_fps:.3},format=yuv420p");

    let mut args: Vec<String> = vec![
        "-ss".into(),
        format!("{start_sec:.3}"),
        "-t".into(),
        format!("{duration_sec:.3}"),
        "-i".into(),
        source_path.to_string_lossy().into_owned(),
    ];

    if source_meta.has_audio {
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into()]);
    } else {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            format!("{duration_sec:.3}"),
            "-i".into(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
        ]);
    }

    args.extend([
        "-vf".into(),
        vf_chain,
        "-c:v".into(),
        v_codec,
        "-preset".into(),
        preset,
        "-crf".into(),
        crf,
        "-c:a".into(),
        a_codec,
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        output_path.to_string_lossy().into_owned(),
    ]);

    run_ffmpeg_command(
        &args,
        "RENDER_FAILED",
        "Failed to trim the selected video segment.",
        600,
    )
    .await?;
    probe_video_file(output_path, false).await
}

/// Computes linear RGB channel gain multipliers `(r_gain, g_gain, b_gain)` from
/// normalized color temperature `t` in `[-1, 1]` and tint `m` in `[-1, 1]`.
/// Matches frontend SVG `<feColorMatrix>` equations 1:1.
pub fn compute_color_channel_gains(temperature: f64, tint: f64) -> (f64, f64, f64) {
    let t = temperature.clamp(-1.0, 1.0);
    let m = tint.clamp(-1.0, 1.0);
    let r_gain = (1.0 + 0.18 * t + 0.08 * m).clamp(0.5, 1.6);
    let g_gain = (1.0 + 0.03 * t - 0.14 * m).clamp(0.5, 1.6);
    let b_gain = (1.0 - 0.18 * t + 0.08 * m).clamp(0.5, 1.6);
    (r_gain, g_gain, b_gain)
}

pub fn build_color_correction_filter(color_cfg: Option<&ColorCorrectionSettings>) -> Option<String> {
    let c = color_cfg?;
    if !c.enabled {
        return None;
    }

    let brightness = c.brightness.clamp(-0.5, 0.5);
    let contrast = c.contrast.clamp(0.5, 2.0);
    let saturation = c.saturation.clamp(0.0, 2.5);
    let gamma = c.gamma.clamp(0.5, 2.0);
    let temperature = c.temperature.clamp(-1.0, 1.0);
    let tint = c.tint.clamp(-1.0, 1.0);
    let sharpen = c.sharpen.clamp(0.0, 1.5);

    let mut stages = Vec::new();
    if brightness.abs() > 1e-4
        || (contrast - 1.0).abs() > 1e-4
        || (saturation - 1.0).abs() > 1e-4
        || (gamma - 1.0).abs() > 1e-4
    {
        stages.push(format!(
            "eq=brightness={brightness:.4}:contrast={contrast:.4}:saturation={saturation:.4}:gamma={gamma:.4}"
        ));
    }

    if temperature.abs() > 1e-4 || tint.abs() > 1e-4 {
        let (r_g, g_g, b_g) = compute_color_channel_gains(temperature, tint);
        stages.push(format!("colorchannelmixer=rr={r_g:.4}:gg={g_g:.4}:bb={b_g:.4}"));
    }

    if sharpen > 0.01 {
        stages.push(format!("unsharp=5:5:{sharpen:.3}:5:5:0.0"));
    }

    if stages.is_empty() {
        None
    } else {
        Some(stages.join(","))
    }
}

pub fn build_audio_enhancement_filter(audio_cfg: Option<&AudioEnhancementSettings>) -> Option<String> {
    let a = audio_cfg?;
    if !a.enabled {
        return None;
    }

    let nr = a.noise_reduction.clamp(0.0, 1.0);
    let clarity = a.voice_clarity.clamp(0.0, 1.0);
    let hp_hz = a.highpass_hz.clamp(20, 300);
    let lp_hz = a.lowpass_hz.clamp(4000, 20000);
    let vol_db = a.volume_db.clamp(-12.0, 12.0);

    let mut stages = Vec::new();
    if hp_hz > 25 {
        stages.push(format!("highpass=f={hp_hz}"));
    }
    if lp_hz < 19500 {
        stages.push(format!("lowpass=f={lp_hz}"));
    }
    if nr > 0.01 {
        let nr_db = 10.0 + nr * 38.0;
        let nf_db = (-34.0 + nr * 14.0).clamp(-80.0, -20.0);
        let rf_db = (-50.0 - nr * 24.0).clamp(-80.0, -20.0);
        stages.push(format!(
            "afftdn=nr={nr_db:.1}:nf={nf_db:.1}:rf={rf_db:.1}:nt=w:tn=0"
        ));

        // Soft-knee downward RMS expander (`agate`) placed BEFORE vocal EQ and compressor
        // so residual room hiss during pauses is attenuated instead of boosted by makeup gain.
        let gate_thresh = (0.008 + nr * 0.016).clamp(0.002, 0.05);
        let gate_ratio = 2.0 + nr * 3.5;
        let gate_range = (0.18 - nr * 0.16).clamp(0.015, 0.25);
        stages.push(format!(
            "agate=threshold={gate_thresh:.4}:ratio={gate_ratio:.2}:range={gate_range:.4}:knee=4:attack=8:release=240"
        ));
    }
    if clarity > 0.01 {
        let gain = clarity * 6.5;
        stages.push(format!("equalizer=f=3000:t=q:w=1.2:g={gain:.2}"));
    }
    if a.normalize_loudness {
        stages.push(
            "acompressor=threshold=0.125:ratio=2.2:knee=4:attack=15:release=200:makeup=1.22"
                .into(),
        );
    }
    if vol_db.abs() > 0.05 {
        stages.push(format!("volume={vol_db:.2}dB"));
    }

    if stages.is_empty() {
        None
    } else {
        Some(stages.join(","))
    }
}

pub async fn extract_audio_for_transcription(
    trimmed_video_path: &Path,
    audio_output_path: &Path,
    audio_cfg: Option<&AudioEnhancementSettings>,
) -> AppResult<()> {
    let mut args = vec![
        "-i".to_string(),
        trimmed_video_path.to_string_lossy().into_owned(),
        "-vn".to_string(),
    ];

    if let Some(cfg) = audio_cfg {
        if cfg.enabled && cfg.apply_to_transcription {
            if let Some(af) = build_audio_enhancement_filter(Some(cfg)) {
                args.extend(["-af".to_string(), af]);
            }
        }
    }

    args.extend([
        "-acodec".to_string(),
        "pcm_s16le".to_string(),
        "-ar".to_string(),
        "16000".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        audio_output_path.to_string_lossy().into_owned(),
    ]);

    run_ffmpeg_command(
        &args,
        "TRANSCRIPTION_PROVIDER_ERROR",
        "Could not extract 16kHz PCM audio from trimmed video clip.",
        300,
    )
    .await
}

pub async fn render_main_segment(
    trimmed_video_path: &Path,
    output_path: &Path,
    trimmed_meta: &MediaMetadata,
    logo_path: Option<&Path>,
    logo_cfg: Option<&LogoSettings>,
    ass_path: Option<&Path>,
    output_cfg: Option<&OutputSettings>,
    color_cfg: Option<&ColorCorrectionSettings>,
    audio_cfg: Option<&AudioEnhancementSettings>,
) -> AppResult<MediaMetadata> {
    let color_filter = build_color_correction_filter(color_cfg);
    let audio_filter = build_audio_enhancement_filter(audio_cfg);
    let use_color = color_filter.is_some();
    let use_audio = audio_filter.is_some();
    let use_logo = logo_path.map_or(false, |p| p.exists())
        && logo_cfg.map_or(false, |l| l.enabled);
    let use_subs = ass_path.map_or(false, |p| p.exists());

    info!(
        use_color = use_color,
        use_audio = use_audio,
        use_logo = use_logo,
        use_subs = use_subs,
        audio_filter = ?audio_filter,
        "render_main_segment_config"
    );

    if !use_color && !use_audio && !use_logo && !use_subs {
        let args = vec![
            "-i".into(),
            trimmed_video_path.to_string_lossy().into_owned(),
            "-c".into(),
            "copy".into(),
            "-movflags".into(),
            "+faststart".into(),
            output_path.to_string_lossy().into_owned(),
        ];
        run_ffmpeg_command(
            &args,
            "RENDER_FAILED",
            "Failed to copy trimmed video segment.",
            300,
        )
        .await?;
        return probe_video_file(output_path, false).await;
    }

    let (v_codec, preset, crf, a_codec) = resolve_encoding_profile(output_cfg);

    if use_audio && !use_color && !use_logo && !use_subs {
        let af = audio_filter.unwrap_or_default();
        let args = vec![
            "-i".into(),
            trimmed_video_path.to_string_lossy().into_owned(),
            "-c:v".into(),
            "copy".into(),
            "-af".into(),
            af,
            "-c:a".into(),
            a_codec,
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
            output_path.to_string_lossy().into_owned(),
        ];
        run_ffmpeg_command(
            &args,
            "RENDER_FAILED",
            "Failed to apply audio noise reduction.",
            300,
        )
        .await?;
        return probe_video_file(output_path, false).await;
    }

    let mut inputs = vec!["-i".to_string(), trimmed_video_path.to_string_lossy().into_owned()];
    let mut filter_parts = Vec::new();
    let mut current_v = "[0:v]".to_string();

    if let Some(cf) = color_filter {
        filter_parts.push(format!("{current_v}{cf}[graded]"));
        current_v = "[graded]".into();
    }

    if use_logo {
        if let (Some(lp), Some(lc)) = (logo_path, logo_cfg) {
            inputs.extend(["-i".to_string(), lp.to_string_lossy().into_owned()]);
            let width_ratio = lc.width_ratio.clamp(0.03, 0.50);
            let opacity = lc.opacity.clamp(0.05, 1.0);
            let logo_w = ((trimmed_meta.width as f64) * width_ratio).round().max(24.0) as u32;
            let (x_expr, y_expr) = compute_logo_overlay_expressions(lc);

            filter_parts.push(format!(
                "[1:v]scale={logo_w}:-1,format=rgba,colorchannelmixer=aa={opacity:.3}[logo]"
            ));
            filter_parts.push(format!(
                "{current_v}[logo]overlay=x={x_expr}:y={y_expr}:format=auto[branded]"
            ));
            current_v = "[branded]".into();
        }
    }

    if use_subs {
        if let Some(ap) = ass_path {
            let abs = ap
                .canonicalize()
                .map(normalize_platform_path)
                .unwrap_or_else(|_| ap.to_path_buf());
            let escaped = abs
                .to_string_lossy()
                .replace('\\', "/")
                .replace(':', r"\:")
                .replace('\'', r"\'");
            filter_parts.push(format!("{current_v}ass=filename='{escaped}'[subbed]"));
            current_v = "[subbed]".into();
        }
    }

    filter_parts.push(format!("{current_v}format=yuv420p[vout]"));
    let audio_map = if let Some(af) = audio_filter {
        filter_parts.push(format!("[0:a:0]{af}[aout]"));
        "[aout]".to_string()
    } else {
        "0:a:0".to_string()
    };
    let filter_complex = filter_parts.join(";");

    let mut args = inputs;
    args.extend([
        "-filter_complex".into(),
        filter_complex,
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        audio_map,
    ]);
    args.extend([
        "-c:v".into(),
        v_codec,
        "-preset".into(),
        preset,
        "-crf".into(),
        crf,
        "-c:a".into(),
        a_codec,
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        output_path.to_string_lossy().into_owned(),
    ]);

    run_ffmpeg_command(
        &args,
        "RENDER_FAILED",
        "Failed while rendering color, audio, logo, and subtitles onto main video.",
        900,
    )
    .await?;
    probe_video_file(output_path, false).await
}

pub async fn normalize_and_concat_outro(
    main_render_path: &Path,
    outro_source_path: &Path,
    normalized_outro_path: &Path,
    final_output_path: &Path,
    main_meta: &MediaMetadata,
    normalization_mode: &str,
    output_cfg: Option<&OutputSettings>,
    color_cfg: Option<&ColorCorrectionSettings>,
) -> AppResult<MediaMetadata> {
    let outro_meta = probe_video_file(outro_source_path, true).await?;
    let outro_dur_sec = (outro_meta.duration_ms.unwrap_or(1000) as f64) / 1000.0;
    let target_w = ((main_meta.width / 2) * 2).max(2);
    let target_h = ((main_meta.height / 2) * 2).max(2);
    let target_fps = if main_meta.fps_float > 0.0 {
        main_meta.fps_float
    } else {
        30.0
    };

    let (v_codec, preset, crf, a_codec) = resolve_encoding_profile(output_cfg);
    let scale_f = normalization_scale_filter(normalization_mode, target_w, target_h);

    let outro_color = color_cfg.and_then(|c| {
        if c.apply_to_outro {
            build_color_correction_filter(Some(c))
        } else {
            None
        }
    });

    let vf_chain = match outro_color {
        Some(cf) => format!("{scale_f},setsar=1,fps={target_fps:.3},{cf},format=yuv420p"),
        None => format!("{scale_f},setsar=1,fps={target_fps:.3},format=yuv420p"),
    };

    let mut norm_args = vec![
        "-i".to_string(),
        outro_source_path.to_string_lossy().into_owned(),
    ];
    if outro_meta.has_audio {
        norm_args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into()]);
    } else {
        norm_args.extend([
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            format!("{outro_dur_sec:.3}"),
            "-i".into(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
        ]);
    }
    norm_args.extend([
        "-vf".into(),
        vf_chain,
        "-c:v".into(),
        v_codec.clone(),
        "-preset".into(),
        preset.clone(),
        "-crf".into(),
        crf.clone(),
        "-c:a".into(),
        a_codec.clone(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        normalized_outro_path.to_string_lossy().into_owned(),
    ]);

    run_ffmpeg_command(
        &norm_args,
        "OUTRO_NORMALIZATION_FAILED",
        "Failed to normalize the outro video clip.",
        600,
    )
    .await?;

    let concat_args = vec![
        "-i".into(),
        main_render_path.to_string_lossy().into_owned(),
        "-i".into(),
        normalized_outro_path.to_string_lossy().into_owned(),
        "-filter_complex".into(),
        "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[outv][outa]".into(),
        "-map".into(),
        "[outv]".into(),
        "-map".into(),
        "[outa]".into(),
        "-c:v".into(),
        v_codec,
        "-preset".into(),
        preset,
        "-crf".into(),
        crf,
        "-c:a".into(),
        a_codec,
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        final_output_path.to_string_lossy().into_owned(),
    ];

    run_ffmpeg_command(
        &concat_args,
        "RENDER_FAILED",
        "Failed while joining the main video and outro clip.",
        600,
    )
    .await?;

    probe_video_file(final_output_path, false).await
}
