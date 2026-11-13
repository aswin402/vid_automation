use celestiavid_core::{
    http_server::spawn_ephemeral_media_server,
    media::{
        ass_generator::{
            generate_ass_content, generate_srt_content, hex_to_ass_color, validate_subtitle_cues,
        },
        crop::{
            build_crop_and_scale_video_filter, build_piecewise_linear_ffmpeg_expr,
            compute_aspect_crop_size, resolve_target_output_dimensions,
        },
        demo::{generate_synthetic_logo, generate_synthetic_video},
        geometry::{affine_overlay_expressions, anchor_to_ass_alignment, resolve_anchor_vector},
        pipeline::{build_audio_enhancement_filter, build_color_correction_filter},
    },
    models::{
        AudioEnhancementSettings, AutoFrameRequest, BatchApplySettingsRequest,
        BatchExportFolderRequest, BatchFolderImportRequest, BatchItemSpec, BatchItemUpdateRequest,
        BatchRunRequest, BatchSetItemsRequest, ColorCorrectionSettings, CropKeyframe, CropSettings,
        ExportCreateRequest, FolderImportItem, FolderScanRequest, ProjectUpdateRequest,
        SubtitleCueItem, SubtitleStyleSettings, TranscriptionCreateRequest,
    },
    storage::StorageService,
    CelestiaEngine,
};
use std::time::Duration;
use tempfile::TempDir;

#[test]
fn test_geometry_and_ass_generation() {
    let (ax, ay) = resolve_anchor_vector("bottom-right", (0.0, 0.0));
    assert_eq!((ax, ay), (1.0, 1.0));
    assert_eq!(anchor_to_ass_alignment(ax, ay), 3);

    let (x_expr, y_expr) = affine_overlay_expressions(0.84, 0.72, 0.0, 0.0);
    assert!(x_expr.contains("0.8400"));
    assert!(y_expr.contains("0.7200"));

    // #FF8800 opaque -> R=FF, G=88, B=00, Alpha=00 -> &H000088FF
    assert_eq!(hex_to_ass_color("#FF8800", 1.0), "&H000088FF");

    let cues = vec![
        SubtitleCueItem {
            id: None,
            sequence: 1,
            start_ms: 200,
            end_ms: 1500,
            text: "Pure Rust Desktop Pipeline".into(),
            words_json: None,
        },
        SubtitleCueItem {
            id: None,
            sequence: 2,
            start_ms: 1600,
            end_ms: 2900,
            text: "Frame-accurate ASS burn-in".into(),
            words_json: None,
        },
    ];
    let validated = validate_subtitle_cues(&cues, 3000, false).expect("valid cues");
    assert_eq!(validated.len(), 2);

    let mut style = SubtitleStyleSettings::default();
    style.x_ratio = Some(0.5);
    style.y_ratio = Some(0.85);
    let ass = generate_ass_content(&validated, &style, 1920, 1080);
    assert!(ass.contains("PlayResX: 1920"));
    assert!(ass.contains("{\\an5\\pos(960,918)}Pure Rust Desktop Pipeline"));

    let srt = generate_srt_content(&validated);
    assert!(srt.contains("00:00:00,200 --> 00:00:01,500"));
}

#[test]
fn test_color_and_audio_filter_builders() {
    assert_eq!(build_color_correction_filter(None), None);
    let mut color = ColorCorrectionSettings::default();
    assert_eq!(build_color_correction_filter(Some(&color)), None);

    color.enabled = true;
    color.brightness = 0.04;
    color.contrast = 1.12;
    color.saturation = 1.18;
    color.temperature = 0.35;
    color.sharpen = 0.4;
    let cf = build_color_correction_filter(Some(&color)).expect("color filter enabled");
    assert!(cf.contains("eq=brightness=0.0400:contrast=1.1200:saturation=1.1800:gamma=1.0000"));
    assert!(cf.contains("colorchannelmixer="));
    assert!(cf.contains("unsharp=5:5:0.400:5:5:0.0"));

    assert_eq!(build_audio_enhancement_filter(None), None);
    let mut audio = AudioEnhancementSettings::default();
    assert!(audio.enabled, "Clean Voice audio must be enabled by default");
    assert_eq!(audio.preset, "clean_voice");
    let default_af =
        build_audio_enhancement_filter(Some(&audio)).expect("default clean_voice audio filter");
    assert!(default_af.contains("highpass=f=95"));
    assert!(default_af.contains("lowpass=f=14000"));
    assert!(default_af.contains("afftdn="));

    audio.enabled = false;
    assert_eq!(build_audio_enhancement_filter(Some(&audio)), None);

    audio.enabled = true;
    audio.noise_reduction = 0.65;
    audio.voice_clarity = 0.45;
    audio.highpass_hz = 100;
    audio.lowpass_hz = 13000;
    audio.normalize_loudness = true;
    audio.volume_db = 2.0;
    let af = build_audio_enhancement_filter(Some(&audio)).expect("audio filter enabled");
    assert!(af.contains("highpass=f=100"));
    assert!(af.contains("lowpass=f=13000"));
    assert!(af.contains("afftdn="));
    assert!(af.contains("tn=0"));
    assert!(af.contains("agate="));
    assert!(af.contains("equalizer=f=3000"));
    assert!(af.contains("acompressor="));
    assert!(af.contains("volume=2.00dB"));

    let logo_def = celestiavid_core::models::LogoSettings::default();
    assert!(logo_def.enabled);
    assert_eq!(logo_def.x_ratio, Some(0.89));
    assert_eq!(logo_def.y_ratio, Some(0.68));
    assert!((logo_def.width_ratio - 0.26).abs() < 1e-6);
    assert!((logo_def.opacity - 1.0).abs() < 1e-6);
    assert!((logo_def.margin_ratio - 0.03).abs() < 1e-6);
    assert!(!logo_def.apply_to_outro);
}

#[test]
fn test_zero_copy_external_storage_never_deletes_user_file() {
    let tmp = TempDir::new().unwrap();
    let user_file = tmp.path().join("my_precious_recording.mp4");
    std::fs::write(&user_file, b"synthetic-bytes").unwrap();

    let storage = StorageService::new(tmp.path().join("managed"), b"secret".to_vec(), 3600);
    let ext_key = StorageService::make_external_file_key(&user_file).unwrap();
    assert!(StorageService::is_external_key(&ext_key));
    storage.delete_key(&ext_key);
    assert!(
        user_file.is_file(),
        "External zero-copy user file must never be deleted on asset/project cleanup"
    );
}

#[tokio::test]
async fn test_end_to_end_rust_pipeline_and_range_streaming() {
    std::env::set_var("CELESTIAVID_OFFLINE_TESTS", "1");

    let tmp = TempDir::new().unwrap();
    let media_dir = tmp.path().join("raw_inputs");
    std::fs::create_dir_all(&media_dir).unwrap();

    let src_video = media_dir.join("source.mp4");
    let logo_png = media_dir.join("logo.png");
    let outro_video = media_dir.join("outro.mp4");

    generate_synthetic_video(&src_video, 4.0, 640, 360, 24, true, 240)
        .await
        .expect("generate source video");
    generate_synthetic_logo(&logo_png, 200, 64).expect("generate rgba logo");
    generate_synthetic_video(&outro_video, 1.5, 640, 360, 24, true, 360)
        .await
        .expect("generate outro video");

    let engine = CelestiaEngine::open(&tmp.path().join("app_data"), None).expect("open engine");
    let addr = spawn_ephemeral_media_server(engine.clone())
        .await
        .expect("spawn loopback media range server");

    let proj = engine.create_project("Rust E2E Suite").unwrap();
    let src_asset = engine
        .import_local_asset(&proj.id, "source", &src_video)
        .await
        .expect("import zero-copy source");
    let logo_asset = engine
        .import_local_asset(&proj.id, "logo", &logo_png)
        .await
        .expect("import zero-copy logo");
    let outro_asset = engine
        .import_local_asset(&proj.id, "outro", &outro_video)
        .await
        .expect("import zero-copy outro");

    // Verify HTTP 206 Partial Content byte-range streaming on loopback media server!
    let stream_url = src_asset.stream_url.clone().expect("stream_url populated");
    assert!(stream_url.starts_with(&format!("http://127.0.0.1:{}", addr.port())));

    let client = reqwest::Client::new();
    let range_resp = client
        .get(&stream_url)
        .header("Range", "bytes=0-127")
        .send()
        .await
        .expect("range GET");
    assert_eq!(range_resp.status().as_u16(), 206);
    let body_slice = range_resp.bytes().await.unwrap();
    assert_eq!(body_slice.len(), 128);

    // Configure trim + color correction + audio denoise + custom logo coordinates + outro
    let mut settings = engine.get_project_detail(&proj.id).unwrap().settings_json;
    settings.trim.start_ms = 500;
    settings.trim.end_ms = Some(3500);
    settings.color_correction.enabled = true;
    settings.color_correction.contrast = 1.08;
    settings.color_correction.saturation = 1.12;
    settings.color_correction.temperature = 0.20;
    settings.audio_enhancement.enabled = true;
    settings.audio_enhancement.noise_reduction = 0.55;
    settings.audio_enhancement.voice_clarity = 0.40;
    settings.logo.enabled = true;
    settings.logo.asset_id = Some(logo_asset.id);
    settings.logo.x_ratio = Some(0.82);
    settings.logo.y_ratio = Some(0.76);
    settings.outro.enabled = true;
    settings.outro.asset_id = Some(outro_asset.id);
    settings.subtitles.enabled = true;

    engine
        .update_project(
            &proj.id,
            ProjectUpdateRequest {
                name: None,
                settings: Some(settings),
            },
        )
        .unwrap();

    // Run async transcription job
    let stt_job = engine
        .start_transcription(
            &proj.id,
            TranscriptionCreateRequest {
                language: "en".into(),
                confirm_overwrite: true,
            },
        )
        .expect("start transcription");

    for _ in 0..80 {
        let j = engine.get_job(&stt_job.id).unwrap();
        if j.status == "completed" {
            break;
        }
        assert_ne!(j.status, "failed", "STT job failed: {:?}", j.error_message_safe);
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert_eq!(engine.get_job(&stt_job.id).unwrap().status, "completed");

    let subs = engine.get_subtitle_version(&proj.id, 0).unwrap();
    assert!(!subs.cues.is_empty(), "Expected generated subtitle cues");
    let (_, srt_text) = engine.export_subtitles_srt(&proj.id, subs.version).unwrap();
    assert!(srt_text.contains("-->"));

    // Run async export job (trim 3.0s + color + audio denoise + logo + ASS subtitles + 1.5s outro = ~4.5s)
    let exp_job = engine
        .start_export(
            &proj.id,
            ExportCreateRequest {
                subtitle_version: Some(subs.version),
                idempotency_key: Some("e2e-export-1".into()),
            },
        )
        .expect("start export");

    for _ in 0..160 {
        let j = engine.get_job(&exp_job.id).unwrap();
        if j.status == "completed" {
            break;
        }
        assert_ne!(
            j.status, "failed",
            "Export job failed: {:?}",
            j.error_message_safe
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let completed_exp = engine.get_job(&exp_job.id).unwrap();
    assert_eq!(completed_exp.status, "completed");
    let out_id = completed_exp.output_asset_id.expect("output_asset_id set");

    let detail = engine.get_project_detail(&proj.id).unwrap();
    let out_asset = detail
        .assets
        .iter()
        .find(|a| a.id == out_id)
        .expect("output asset in project");
    assert_eq!(out_asset.width, Some(640));
    assert_eq!(out_asset.height, Some(360));
    let out_dur = out_asset.duration_ms.unwrap_or(0);
    assert!(
        (4200..=4800).contains(&out_dur),
        "Expected ~4500ms output duration, got {out_dur}ms"
    );

    // Verify native save_asset_to_path
    let exported_dest = tmp.path().join("saved_desktop_export.mp4");
    let copied = engine
        .save_asset_to_path(&out_id, &exported_dest)
        .await
        .expect("save_asset_to_path");
    assert!(copied > 1024);
    assert!(exported_dest.is_file());
}

fn measure_wav_window_rms_db(wav_path: &std::path::Path, start_sec: f64, end_sec: f64) -> f64 {
    let mut reader = hound::WavReader::open(wav_path).expect("open wav");
    let sr = reader.spec().sample_rate as f64;
    let start_idx = (start_sec * sr) as usize;
    let end_idx = (end_sec * sr) as usize;
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap_or(0)).collect();
    let slice = &samples[start_idx.min(samples.len())..end_idx.min(samples.len())];
    assert!(!slice.is_empty());
    let sum_sq: f64 = slice
        .iter()
        .map(|&s| {
            let norm = (s as f64) / 32768.0;
            norm * norm
        })
        .sum();
    let rms = (sum_sq / (slice.len() as f64)).sqrt();
    if rms <= 1e-9 {
        -180.0
    } else {
        20.0 * rms.log10()
    }
}

#[tokio::test]
async fn test_audio_noise_reduction_measurably_lowers_noise_floor() {
    use celestiavid_core::media::pipeline::run_ffmpeg_command;

    let tmp = TempDir::new().unwrap();
    let noisy_video = tmp.path().join("noisy_input.mp4");

    // Generate 3.0s video: [0.3..1.4s] speech-band 440Hz tone (-16dB) + continuous white noise (-42dB),
    // [1.7..2.8s] pure background white noise (-42dB)
    let gen_args: Vec<String> = vec![
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "color=c=navy:s=320x240:r=24:d=3.0".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "aevalsrc='0.008*(random(0)*2-1) + if(between(t,0.3,1.4),0.15*sin(2*PI*440*t),0)':s=48000:d=3.0".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        noisy_video.to_string_lossy().into_owned(),
    ];
    run_ffmpeg_command(&gen_args, "TEST_GEN", "Failed to generate noisy test clip", 60)
        .await
        .expect("generate noisy clip");

    let engine = CelestiaEngine::open(&tmp.path().join("app_data"), None).unwrap();
    let proj = engine.create_project("Denoise Acoustic Verification").unwrap();
    engine
        .import_local_asset(&proj.id, "source", &noisy_video)
        .await
        .unwrap();

    // Enable Clean Voice + Color Correction so render_main_segment exercises the full filter_complex path!
    let mut settings = engine.get_project_detail(&proj.id).unwrap().settings_json;
    settings.color_correction.enabled = true;
    settings.color_correction.brightness = 0.05;
    settings.audio_enhancement.enabled = true;
    settings.audio_enhancement.preset = "clean_voice".into();
    settings.audio_enhancement.noise_reduction = 0.50;
    settings.audio_enhancement.voice_clarity = 0.35;
    settings.audio_enhancement.highpass_hz = 95;
    settings.audio_enhancement.lowpass_hz = 14000;
    settings.audio_enhancement.normalize_loudness = true;
    settings.audio_enhancement.volume_db = 1.5;

    engine
        .update_project(
            &proj.id,
            ProjectUpdateRequest {
                name: None,
                settings: Some(settings),
            },
        )
        .unwrap();

    let exp_job = engine
        .start_export(
            &proj.id,
            ExportCreateRequest {
                subtitle_version: None,
                idempotency_key: None,
            },
        )
        .unwrap();

    for _ in 0..100 {
        let j = engine.get_job(&exp_job.id).unwrap();
        if j.status == "completed" {
            break;
        }
        assert_ne!(j.status, "failed", "Export failed: {:?}", j.error_message_safe);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let out_id = engine
        .get_job(&exp_job.id)
        .unwrap()
        .output_asset_id
        .expect("output asset");
    let exported_mp4 = tmp.path().join("cleaned_output.mp4");
    engine
        .save_asset_to_path(&out_id, &exported_mp4)
        .await
        .unwrap();

    let raw_wav = tmp.path().join("raw.wav");
    let cleaned_wav = tmp.path().join("cleaned.wav");
    for (src, dst) in [(&noisy_video, &raw_wav), (&exported_mp4, &cleaned_wav)] {
        let args = vec![
            "-i".into(),
            src.to_string_lossy().into_owned(),
            "-vn".into(),
            "-acodec".into(),
            "pcm_s16le".into(),
            "-ar".into(),
            "16000".into(),
            "-ac".into(),
            "1".into(),
            dst.to_string_lossy().into_owned(),
        ];
        run_ffmpeg_command(&args, "WAV_EXTRACT", "Extract PCM", 60)
            .await
            .unwrap();
    }

    let raw_noise_db = measure_wav_window_rms_db(&raw_wav, 1.8, 2.7);
    let cleaned_noise_db = measure_wav_window_rms_db(&cleaned_wav, 1.8, 2.7);
    let cleaned_speech_db = measure_wav_window_rms_db(&cleaned_wav, 0.5, 1.2);

    let reduction_db = raw_noise_db - cleaned_noise_db;
    assert!(
        reduction_db >= 20.0,
        "Expected >= 20 dB background noise reduction in pause window, got {reduction_db:.2} dB (raw={raw_noise_db:.2} dB, cleaned={cleaned_noise_db:.2} dB)"
    );
    assert!(
        cleaned_speech_db > -22.0,
        "Expected active voice tone to remain strong (> -22 dB), got {cleaned_speech_db:.2} dB"
    );
}

#[test]
fn test_crop_math_and_zero_comma_dynamic_filter_builder() {
    let mut crop = CropSettings {
        enabled: true,
        aspect_ratio: "9:16".into(),
        ..CropSettings::default()
    };
    assert_eq!(
        resolve_target_output_dimensions(Some(&crop), 1920, 1080, None, None),
        (1080, 1920)
    );
    crop.aspect_ratio = "1:1".into();
    assert_eq!(
        resolve_target_output_dimensions(Some(&crop), 1080, 1920, None, None),
        (1080, 1080)
    );
    crop.aspect_ratio = "4:5".into();
    assert_eq!(
        resolve_target_output_dimensions(Some(&crop), 1920, 1080, None, None),
        (1080, 1350)
    );
    crop.aspect_ratio = "16:9".into();
    assert_eq!(
        resolve_target_output_dimensions(Some(&crop), 1080, 1920, None, None),
        (1920, 1080)
    );
    crop.aspect_ratio = "21:9".into();
    assert_eq!(
        resolve_target_output_dimensions(Some(&crop), 1920, 1080, None, None),
        (1920, 822)
    );
    crop.aspect_ratio = "custom".into();
    crop.width = 0.5;
    crop.height = 0.5;
    assert_eq!(
        resolve_target_output_dimensions(Some(&crop), 1920, 1080, None, None),
        (960, 540)
    );

    let (w_9_16, h_9_16) = compute_aspect_crop_size("9:16", 1920, 1080, 1.0);
    assert!((w_9_16 - (9.0 / 16.0) / (16.0 / 9.0)).abs() < 1e-4);
    assert!((h_9_16 - 1.0).abs() < 1e-4);

    // Piecewise-linear dynamic FFmpeg expression must have zero commas, colons, or quotes
    let expr = build_piecewise_linear_ffmpeg_expr(&[(0.0, 100.0), (1.0, 300.0), (2.5, 180.0)], 600);
    assert!(!expr.contains(','));
    assert!(!expr.contains(':'));
    assert!(!expr.contains('\''));
    assert!(expr.contains("abs(t-"));

    crop.aspect_ratio = "9:16".into();
    crop.fit_mode = "crop".into();
    crop.width = w_9_16;
    crop.height = 1.0;
    crop.dynamic_tracking = true;
    crop.keyframes = vec![
        CropKeyframe {
            time_ms: 0,
            x: 0.20,
            y: 0.0,
        },
        CropKeyframe {
            time_ms: 1500,
            x: 0.45,
            y: 0.0,
        },
    ];
    let vf = build_crop_and_scale_video_filter(Some(&crop), 1920, 1080, 1080, 1920);
    assert!(vf.starts_with("crop=608:1080:("));
    assert!(vf.ends_with(",scale=1080:1920:flags=lanczos"));
}

#[tokio::test]
async fn test_auto_face_framing_and_aspect_ratio_export_e2e() {
    let tmp = TempDir::new().unwrap();
    let engine = CelestiaEngine::open(&tmp.path().join("app_data"), None).unwrap();

    // 1. Verify Pure-Rust UltraFace ONNX speaker framing on real sample video when available
    let sample_vid = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample/vid.mp4");
    if sample_vid.is_file() {
        let face_proj = engine.create_project("AI Speaker Framing Test").unwrap();
        engine
            .import_local_asset(&face_proj.id, "source", &sample_vid)
            .await
            .expect("import sample/vid.mp4");

        // Set a short 3s trim window so multi-frame neural sampling runs super fast
        let mut s = engine.get_project_detail(&face_proj.id).unwrap().settings_json;
        s.trim.start_ms = 0;
        s.trim.end_ms = Some(3000);
        engine
            .update_project(
                &face_proj.id,
                ProjectUpdateRequest {
                    name: None,
                    settings: Some(s),
                },
            )
            .unwrap();

        let resp = engine
            .auto_frame_project(
                &face_proj.id,
                AutoFrameRequest {
                    aspect_ratio: "1:1".into(),
                    target_zoom: Some(1.0),
                    dynamic_tracking: true,
                },
            )
            .await
            .expect("auto_frame_project on sample/vid.mp4");

        assert!(
            resp.face_detected,
            "UltraFace ONNX should detect the speaker in sample/vid.mp4"
        );
        let face = resp.primary_face.expect("primary_face populated");
        assert!(
            face.confidence > 0.70,
            "Expected high-confidence foreground face, got {}",
            face.confidence
        );
        // Speaker's head is near the top of the 1080x1920 frame; naive center crop (y=0.219) chops his crown!
        assert!(
            resp.crop.y < 0.18,
            "Expected smart headroom crop near top of frame (<0.18), got {}",
            resp.crop.y
        );
        assert!(
            !resp.crop.keyframes.is_empty(),
            "Expected dynamic tracking keyframes"
        );
    }

    // 2. Verify full end-to-end FFmpeg MP4 export reframing 640x360 -> 9:16 (360x640) with dynamic tracking + logo + outro
    let media_dir = tmp.path().join("crop_inputs");
    std::fs::create_dir_all(&media_dir).unwrap();
    let src_video = media_dir.join("landscape_src.mp4");
    let logo_png = media_dir.join("brand.png");
    let outro_video = media_dir.join("outro_landscape.mp4");

    generate_synthetic_video(&src_video, 2.5, 640, 360, 24, true, 300)
        .await
        .unwrap();
    generate_synthetic_logo(&logo_png, 160, 48).unwrap();
    generate_synthetic_video(&outro_video, 1.0, 640, 360, 24, true, 440)
        .await
        .unwrap();

    let proj = engine.create_project("Vertical 9:16 Dynamic Export").unwrap();
    engine
        .import_local_asset(&proj.id, "source", &src_video)
        .await
        .unwrap();
    let logo_asset = engine
        .import_local_asset(&proj.id, "logo", &logo_png)
        .await
        .unwrap();
    let outro_asset = engine
        .import_local_asset(&proj.id, "outro", &outro_video)
        .await
        .unwrap();

    let (cw, ch) = compute_aspect_crop_size("9:16", 640, 360, 1.15);
    let mut settings = engine.get_project_detail(&proj.id).unwrap().settings_json;
    settings.crop = CropSettings {
        enabled: true,
        aspect_ratio: "9:16".into(),
        fit_mode: "crop".into(),
        x: 0.25,
        y: 0.05,
        width: cw,
        height: ch,
        zoom: 1.15,
        auto_face_framing: true,
        dynamic_tracking: true,
        detected_face: None,
        keyframes: vec![
            CropKeyframe {
                time_ms: 0,
                x: 0.18,
                y: 0.04,
            },
            CropKeyframe {
                time_ms: 1200,
                x: 0.36,
                y: 0.06,
            },
            CropKeyframe {
                time_ms: 2500,
                x: 0.24,
                y: 0.05,
            },
        ],
    };
    settings.logo.enabled = true;
    settings.logo.asset_id = Some(logo_asset.id);
    settings.outro.enabled = true;
    settings.outro.asset_id = Some(outro_asset.id);

    engine
        .update_project(
            &proj.id,
            ProjectUpdateRequest {
                name: None,
                settings: Some(settings),
            },
        )
        .unwrap();

    let exp_job = engine
        .start_export(
            &proj.id,
            ExportCreateRequest {
                subtitle_version: None,
                idempotency_key: Some("crop-9-16-e2e".into()),
            },
        )
        .unwrap();

    for _ in 0..120 {
        let j = engine.get_job(&exp_job.id).unwrap();
        if j.status == "completed" {
            break;
        }
        assert_ne!(
            j.status, "failed",
            "Vertical 9:16 export failed: {:?}",
            j.error_message_safe
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let completed = engine.get_job(&exp_job.id).unwrap();
    assert_eq!(completed.status, "completed");
    let out_id = completed.output_asset_id.expect("output_asset_id");
    let detail = engine.get_project_detail(&proj.id).unwrap();
    let out_asset = detail
        .assets
        .iter()
        .find(|a| a.id == out_id)
        .expect("output asset");

    assert_eq!(
        (out_asset.width, out_asset.height),
        (Some(360), Some(640)),
        "Expected 640x360 landscape + outro to export cleanly as 360x640 vertical 9:16"
    );
    assert_eq!(out_asset.has_audio, true);
}

#[tokio::test]
async fn test_batch_folder_import_pairing_and_selective_automation_e2e() {
    let tmp = TempDir::new().unwrap();
    let engine = CelestiaEngine::open(&tmp.path().join("app_data"), None).unwrap();

    // 1. Build realistic campaign folder tree: videos/, logos/, outros/
    let campaign_dir = tmp.path().join("campaign_assets");
    let vids_dir = campaign_dir.join("videos");
    let logos_dir = campaign_dir.join("logos");
    let outros_dir = campaign_dir.join("outros");
    std::fs::create_dir_all(&vids_dir).unwrap();
    std::fs::create_dir_all(&logos_dir).unwrap();
    std::fs::create_dir_all(&outros_dir).unwrap();

    // Intentionally include vid_1, vid_2, vid_10 to verify natural alphanumeric sorting!
    generate_synthetic_video(&vids_dir.join("vid_10.mp4"), 1.6, 480, 270, 24, true, 350)
        .await
        .unwrap();
    generate_synthetic_video(&vids_dir.join("vid_2.mp4"), 2.2, 480, 270, 24, true, 420)
        .await
        .unwrap();
    generate_synthetic_video(&vids_dir.join("vid_1.mp4"), 1.8, 480, 270, 24, true, 280)
        .await
        .unwrap();

    generate_synthetic_logo(&logos_dir.join("logo_1.png"), 120, 40).unwrap();
    generate_synthetic_logo(&logos_dir.join("logo_2.png"), 120, 40).unwrap();
    generate_synthetic_video(&outros_dir.join("outro_1.mp4"), 1.0, 480, 270, 24, true, 520)
        .await
        .unwrap();

    // 2. Scan folder and assert smart role classification + natural sorting
    let scanned = engine
        .scan_local_folder(FolderScanRequest {
            folder_path: campaign_dir.to_string_lossy().into_owned(),
            recursive: true,
            default_video_role: None,
        })
        .expect("scan_local_folder");
    assert_eq!(scanned.items.len(), 6);

    let scanned_videos: Vec<&str> = scanned
        .items
        .iter()
        .filter(|i| i.suggested_kind == "source")
        .map(|i| i.filename.as_str())
        .collect();
    assert_eq!(
        scanned_videos,
        vec!["vid_1.mp4", "vid_2.mp4", "vid_10.mp4"],
        "Expected natural alphanumeric sort order so vid_2 precedes vid_10"
    );
    assert_eq!(
        scanned
            .items
            .iter()
            .filter(|i| i.suggested_kind == "logo")
            .count(),
        2
    );
    assert_eq!(
        scanned
            .items
            .iter()
            .filter(|i| i.suggested_kind == "outro")
            .count(),
        1
    );

    // 3. Create batch and zero-copy import scanned items
    let batch = engine.create_batch("Multi-Brand Folder Campaign").unwrap();
    // Batch internal backing projects must NOT pollute single-project dashboard list
    assert!(engine.list_projects().unwrap().is_empty());

    let import_resp = engine
        .import_folder_items_to_batch(
            &batch.id,
            BatchFolderImportRequest {
                items: scanned
                    .items
                    .iter()
                    .map(|i| FolderImportItem {
                        path: i.path.clone(),
                        kind: i.suggested_kind.clone(),
                    })
                    .collect(),
            },
        )
        .await
        .expect("import_folder_items_to_batch");
    assert_eq!(import_resp.imported_count, 6);
    assert!(import_resp.skipped_errors.is_empty());

    let detail = import_resp.batch;
    assert_eq!(detail.videos.len(), 3);
    assert_eq!(detail.logos.len(), 2);
    assert_eq!(detail.outros.len(), 1);

    let v1 = &detail.videos[0].id;
    let v2 = &detail.videos[1].id;
    let l1 = &detail.logos[0].id;
    let l2 = &detail.logos[1].id;
    let o1 = &detail.outros[0].id;

    // 4. Configure 3 mapped rows mixing 1:1 and vice-versa (V1 -> L1 -> O1, V1 -> L2 -> O1, V2 -> L1 -> None)
    // Select ONLY rows #1 and #2 as the Required Set; leave row #3 unselected (`selected: false`)
    let with_items = engine
        .set_batch_items(
            &batch.id,
            BatchSetItemsRequest {
                mapping_mode: Some("manual".into()),
                items: vec![
                    BatchItemSpec {
                        id: None,
                        selected: true,
                        title: Some("V1_BrandA".into()),
                        source_asset_id: Some(v1.clone()),
                        logo_asset_id: Some(l1.clone()),
                        outro_asset_id: Some(o1.clone()),
                        use_custom_settings: None,
                    },
                    BatchItemSpec {
                        id: None,
                        selected: true,
                        title: Some("V1_BrandB_ViceVersa".into()),
                        source_asset_id: Some(v1.clone()),
                        logo_asset_id: Some(l2.clone()),
                        outro_asset_id: Some(o1.clone()),
                        use_custom_settings: None,
                    },
                    BatchItemSpec {
                        id: None,
                        selected: false,
                        title: Some("V2_Unselected_Draft".into()),
                        source_asset_id: Some(v2.clone()),
                        logo_asset_id: Some(l1.clone()),
                        outro_asset_id: None,
                        use_custom_settings: None,
                    },
                ],
            },
        )
        .expect("set_batch_items");
    assert_eq!(with_items.items.len(), 3);

    // Manually tweak row #2 title via update_batch_item
    let row1_id = with_items.items[0].id.clone();
    let row2_id = with_items.items[1].id.clone();
    let row3_id = with_items.items[2].id.clone();
    engine
        .update_batch_item(
            &batch.id,
            &row2_id,
            BatchItemUpdateRequest {
                title: Some("V1_BrandB_Custom".into()),
                selected: None,
                source_asset_id: None,
                logo_asset_id: None,
                clear_logo: false,
                outro_asset_id: None,
                clear_outro: false,
                use_custom_settings: None,
                settings: None,
            },
        )
        .unwrap();

    // 5. Apply custom dragged logo position + color grading across the Required Set (rows #1 & #2)
    let mut custom_settings = with_items.shared_settings.clone();
    custom_settings.logo.enabled = true;
    custom_settings.logo.x_ratio = Some(0.82);
    custom_settings.logo.y_ratio = Some(0.08);
    custom_settings.logo.width_ratio = 0.18;
    custom_settings.color_correction.enabled = true;
    custom_settings.color_correction.contrast = 1.12;
    custom_settings.outro.enabled = true;

    let applied = engine
        .apply_settings_to_batch_items(
            &batch.id,
            BatchApplySettingsRequest {
                item_ids: vec![row1_id.clone(), row2_id.clone()],
                settings: custom_settings,
                update_shared: true,
            },
        )
        .expect("apply_settings_to_batch_items");
    assert_eq!(applied.items[0].settings.logo.x_ratio, Some(0.82));
    assert_eq!(applied.items[1].settings.logo.x_ratio, Some(0.82));
    // Verify each row preserved its own distinct logo_asset_id!
    assert_eq!(
        applied.items[0].settings.logo.asset_id.is_some(),
        true
    );
    assert_ne!(
        applied.items[0].settings.logo.asset_id,
        applied.items[1].settings.logo.asset_id
    );

    // 5b. Verify per-tool Separate Video Override vs Master Control inheritance!
    let mut row2_sep = applied.items[1].settings.clone();
    row2_sep.overridden_tools = vec!["color".into()];
    row2_sep.color_correction.saturation = 1.45;
    let after_sep = engine
        .update_batch_item(
            &batch.id,
            &row2_id,
            BatchItemUpdateRequest {
                title: None,
                selected: None,
                source_asset_id: None,
                logo_asset_id: None,
                clear_logo: false,
                outro_asset_id: None,
                clear_outro: false,
                use_custom_settings: None,
                settings: Some(row2_sep),
            },
        )
        .expect("set row2 separate color override");
    assert!(after_sep.items[1].use_custom_settings);

    // Update Master Control logo width -> BOTH row #1 and row #2 must inherit new Master logo width (0.24),
    // while row #2 keeps its separate color saturation (1.45) and row #1 gets Master saturation (1.05)!
    let mut master_next = after_sep.shared_settings.clone();
    master_next.logo.width_ratio = 0.24;
    master_next.color_correction.saturation = 1.05;
    let after_master = engine
        .update_batch(
            &batch.id,
            celestiavid_core::models::BatchUpdateRequest {
                name: None,
                mapping_mode: None,
                output_dir: None,
                clear_output_dir: false,
                shared_settings: Some(master_next),
                apply_shared_to_selected: false,
            },
        )
        .expect("update master shared_settings");
    assert!((after_master.items[0].settings.logo.width_ratio - 0.24).abs() < 1e-6);
    assert!((after_master.items[1].settings.logo.width_ratio - 0.24).abs() < 1e-6);
    assert!((after_master.items[0].settings.color_correction.saturation - 1.05).abs() < 1e-6);
    assert!((after_master.items[1].settings.color_correction.saturation - 1.45).abs() < 1e-6);

    // 6. Run batch automation on selected set (`item_ids: None` defaults to `selected == true`)
    let run_resp = engine
        .run_batch_automation(
            &batch.id,
            BatchRunRequest {
                item_ids: None,
                force_reexport: false,
            },
        )
        .expect("run_batch_automation");
    assert_eq!(
        run_resp.launched_count, 2,
        "Only the 2 selected rows in the required set should launch"
    );

    for _ in 0..160 {
        let cur = engine.get_batch_detail(&batch.id).unwrap();
        let r1 = cur.items.iter().find(|i| i.id == row1_id).unwrap();
        let r2 = cur.items.iter().find(|i| i.id == row2_id).unwrap();
        assert_ne!(
            r1.status, "failed",
            "Batch row 1 failed: {:?}",
            r1.error_message_safe
        );
        assert_ne!(
            r2.status, "failed",
            "Batch row 2 failed: {:?}",
            r2.error_message_safe
        );
        // Sequential queue invariant: row #1 and row #2 must never be in `"processing"` simultaneously!
        assert!(
            !(r1.status == "processing" && r2.status == "processing"),
            "Bulk queue must process one by one, never both processing simultaneously"
        );
        if r1.status == "completed" && r2.status == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let final_batch = engine.get_batch_detail(&batch.id).unwrap();
    let r1 = final_batch.items.iter().find(|i| i.id == row1_id).unwrap();
    let r2 = final_batch.items.iter().find(|i| i.id == row2_id).unwrap();
    let r3 = final_batch.items.iter().find(|i| i.id == row3_id).unwrap();

    assert_eq!(r1.status, "completed");
    assert_eq!(r2.status, "completed");
    assert!(
        r1.active_job_id.is_none(),
        "Completed row must clear active_job_id"
    );
    assert!(
        r2.active_job_id.is_none(),
        "Completed row must clear active_job_id"
    );
    assert!(r1.output_asset.is_some());
    assert!(r2.output_asset.is_some());
    assert_eq!(
        r3.status, "draft",
        "Unselected row #3 must remain untouched in draft state"
    );
    assert!(r3.output_asset.is_none());

    // 7. Export completed selected MP4s to local destination folder
    let export_dir = tmp.path().join("batch_exported_mp4s");
    let export_resp = engine
        .export_batch_outputs_to_folder(
            &batch.id,
            BatchExportFolderRequest {
                dest_dir: export_dir.to_string_lossy().into_owned(),
                item_ids: None,
            },
        )
        .await
        .expect("export_batch_outputs_to_folder");
    assert_eq!(export_resp.exported_count, 2);
    assert_eq!(export_resp.files.len(), 2);
    for path_str in &export_resp.files {
        let meta = std::fs::metadata(path_str).expect("exported file exists");
        assert!(meta.len() > 1024);
    }

    // 7b. Single-row export (`item_ids: Some(vec![row3_id])`) exports row #3 individually even when unselected
    let single_run = engine
        .run_batch_automation(
            &batch.id,
            BatchRunRequest {
                item_ids: Some(vec![row3_id.clone()]),
                force_reexport: true,
            },
        )
        .expect("single-row run_batch_automation");
    assert_eq!(single_run.launched_count, 1);

    for _ in 0..120 {
        let cur = engine.get_batch_detail(&batch.id).unwrap();
        let r3_cur = cur.items.iter().find(|i| i.id == row3_id).unwrap();
        assert_ne!(
            r3_cur.status, "failed",
            "Single row #3 export failed: {:?}",
            r3_cur.error_message_safe
        );
        if r3_cur.status == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let after_single = engine.get_batch_detail(&batch.id).unwrap();
    let r3_done = after_single.items.iter().find(|i| i.id == row3_id).unwrap();
    assert_eq!(r3_done.status, "completed");
    assert!(r3_done.output_asset.is_some());
    assert!(r3_done.active_job_id.is_none());

    // 8. Delete batch and confirm clean removal
    engine.delete_batch(&batch.id).expect("delete_batch");
    assert!(engine.list_batches().unwrap().is_empty());
}

#[tokio::test]
async fn test_app_data_backup_restore_and_auto_update_pipeline() {
    use axum::{routing::get, Json, Router};
    use celestiavid_core::models::CreateBackupRequest;
    use serde_json::json;

    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().join("app_data_updater");
    let engine = CelestiaEngine::open(&data_dir, None).unwrap();

    // 1. Seed user project, batch campaign, and managed storage file
    let proj = engine.create_project("Important Client Video").unwrap();
    let batch = engine.create_batch("Q4 Brand Campaign").unwrap();
    let managed_marker = data_dir.join("storage").join("brand_marker.txt");
    std::fs::create_dir_all(managed_marker.parent().unwrap()).unwrap();
    std::fs::write(&managed_marker, b"preserved-brand-asset").unwrap();

    // 2. Create manual backup snapshot
    let manual_snap = engine
        .create_backup(CreateBackupRequest {
            label: Some("Before Experiment".into()),
            include_storage: Some(true),
        })
        .expect("create_backup");
    assert_eq!(manual_snap.project_count, 1);
    assert_eq!(manual_snap.batch_count, 1);
    assert!(manual_snap.includes_storage);
    assert!(manual_snap.size_bytes > 0);

    // 3. Mutate/delete live state and managed file, then restore from backup online
    engine.delete_project(&proj.id).unwrap();
    engine.delete_batch(&batch.id).unwrap();
    std::fs::remove_file(&managed_marker).unwrap();
    assert!(engine.list_projects().unwrap().is_empty());
    assert!(engine.list_batches().unwrap().is_empty());

    let restore_resp = engine
        .restore_backup(&manual_snap.id)
        .expect("restore_backup");
    assert_eq!(restore_resp.restored_projects, 1);
    assert_eq!(restore_resp.restored_batches, 1);
    assert!(!restore_resp.safety_backup_id.is_empty());
    assert_eq!(engine.list_projects().unwrap().len(), 1);
    assert_eq!(engine.list_batches().unwrap().len(), 1);
    assert_eq!(
        std::fs::read_to_string(&managed_marker).unwrap(),
        "preserved-brand-asset"
    );

    // 4. Spin up local mock GitHub Release HTTP feed serving v9.9.9 + binary installer payload
    let fake_payload: Vec<u8> = (0..131_072).map(|i| (i % 251) as u8).collect();
    let payload_len = fake_payload.len() as u64;
    let payload_for_route = fake_payload.clone();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let download_url = format!("http://{addr}/download/CelestiaVid_9.9.9_amd64.AppImage");

    let mock_router = Router::new()
        .route(
            "/releases/latest",
            get(move || {
                let dl = download_url.clone();
                async move {
                    Json(json!({
                        "tag_name": "v9.9.9",
                        "name": "CelestiaVid v9.9.9 Studio Update",
                        "body": "- Clean minimal TUI installer\n- Automatic app data backup & 1-click self-update",
                        "published_at": "2026-11-12T08:00:00Z",
                        "html_url": "https://github.com/aswin402/vid_automation/releases/tag/v9.9.9",
                        "assets": [
                            {
                                "name": "CelestiaVid_9.9.9_amd64.AppImage",
                                "browser_download_url": dl,
                                "size": payload_len
                            }
                        ]
                    }))
                }
            }),
        )
        .route(
            "/download/CelestiaVid_9.9.9_amd64.AppImage",
            get(move || {
                let bytes = payload_for_route.clone();
                async move {
                    (
                        [(axum::http::header::CONTENT_LENGTH, bytes.len().to_string())],
                        bytes,
                    )
                }
            }),
        );

    let server_handle = tokio::spawn(async move {
        let _ = axum::serve(listener, mock_router).await;
    });

    std::env::set_var(
        "CELESTIAVID_UPDATE_MANIFEST_URL",
        format!("http://{addr}/releases/latest"),
    );
    std::env::set_var("CELESTIAVID_UPDATER_STAGE_ONLY", "1");

    let check = engine.check_for_updates().await.expect("check_for_updates");
    assert!(check.update_available);
    assert_eq!(check.latest_version, "9.9.9");
    assert_eq!(check.asset_size_bytes, Some(payload_len));

    let started = engine.start_app_update().expect("start_app_update");
    assert!(matches!(
        started.status.as_str(),
        "checking" | "backing_up" | "downloading" | "ready_to_restart"
    ));

    for _ in 0..80 {
        let st = engine.get_update_status();
        assert_ne!(
            st.status, "failed",
            "Auto-update pipeline failed: {:?}",
            st.error_message_safe
        );
        if st.status == "ready_to_restart" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let final_st = engine.get_update_status();
    assert_eq!(final_st.status, "ready_to_restart");
    assert_eq!(final_st.progress, 1.0);
    assert_eq!(final_st.downloaded_bytes, payload_len);
    let pre_update_snap = final_st
        .backup_info
        .expect("Automatic pre-update backup must be attached");
    assert_eq!(pre_update_snap.reason, "pre-update");
    assert_eq!(pre_update_snap.project_count, 1);
    assert_eq!(pre_update_snap.batch_count, 1);

    let staged_file = std::path::PathBuf::from(
        final_st
            .installer_path
            .expect("staged installer_path set"),
    );
    assert!(staged_file.is_file());
    assert_eq!(std::fs::metadata(&staged_file).unwrap().len(), payload_len);

    std::env::remove_var("CELESTIAVID_UPDATE_MANIFEST_URL");
    std::env::remove_var("CELESTIAVID_UPDATER_STAGE_ONLY");
    server_handle.abort();
}

#[tokio::test]
async fn test_default_clean_voice_and_logo_placement_across_new_and_legacy_records() {
    use celestiavid_core::models::{BatchItemSpec, BatchSetItemsRequest, EditSettings};

    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().join("app_data");
    let engine = CelestiaEngine::open(&data_dir, None).unwrap();

    // 1. Verify brand-new project defaults
    let proj = engine.create_project("Fresh Default Check").unwrap();
    assert!(proj.settings_json.audio_enhancement.enabled);
    assert_eq!(proj.settings_json.audio_enhancement.preset, "clean_voice");
    assert!((proj.settings_json.audio_enhancement.noise_reduction - 0.45).abs() < 1e-6);
    assert!((proj.settings_json.audio_enhancement.voice_clarity - 0.35).abs() < 1e-6);
    assert_eq!(proj.settings_json.audio_enhancement.highpass_hz, 95);
    assert_eq!(proj.settings_json.audio_enhancement.lowpass_hz, 14000);
    assert!((proj.settings_json.audio_enhancement.volume_db - 1.5).abs() < 1e-6);
    assert!(proj.settings_json.audio_enhancement.normalize_loudness);
    assert!(proj.settings_json.audio_enhancement.apply_to_transcription);

    assert!(proj.settings_json.logo.enabled);
    assert_eq!(proj.settings_json.logo.position, "bottom-right");
    assert_eq!(proj.settings_json.logo.x_ratio, Some(0.89));
    assert_eq!(proj.settings_json.logo.y_ratio, Some(0.68));
    assert!((proj.settings_json.logo.width_ratio - 0.26).abs() < 1e-6);
    assert!((proj.settings_json.logo.opacity - 1.0).abs() < 1e-6);
    assert!((proj.settings_json.logo.margin_ratio - 0.03).abs() < 1e-6);
    assert!(!proj.settings_json.logo.apply_to_outro);

    // 2. Verify batch + batch items keep logo.enabled = true & Clean Voice even before a logo is uploaded
    let batch = engine.create_batch("Campaign Default Check").unwrap();
    let updated_batch = engine
        .set_batch_items(
            &batch.id,
            BatchSetItemsRequest {
                mapping_mode: Some("many_videos_one_brand".into()),
                items: vec![BatchItemSpec {
                    id: None,
                    selected: true,
                    title: Some("Clip 1".into()),
                    source_asset_id: None,
                    logo_asset_id: None,
                    outro_asset_id: None,
                    use_custom_settings: Some(false),
                }],
            },
        )
        .unwrap();
    let row = &updated_batch.items[0];
    assert!(row.settings.audio_enhancement.enabled);
    assert_eq!(row.settings.audio_enhancement.preset, "clean_voice");
    assert!(row.settings.logo.enabled);
    assert_eq!(row.settings.logo.x_ratio, Some(0.89));
    assert_eq!(row.settings.logo.y_ratio, Some(0.68));
    assert!((row.settings.logo.width_ratio - 0.26).abs() < 1e-6);
    assert!(!row.settings.logo.apply_to_outro);

    // 3. Verify legacy v1 JSON records upgrade cleanly on Database::open
    let mut legacy_v1 = EditSettings::default();
    legacy_v1.schema_version = 1;
    legacy_v1.audio_enhancement.enabled = false;
    legacy_v1.audio_enhancement.preset = "none".into();
    legacy_v1.audio_enhancement.noise_reduction = 0.0;
    legacy_v1.logo.enabled = false;
    legacy_v1.logo.x_ratio = None;
    legacy_v1.logo.y_ratio = None;
    legacy_v1.logo.width_ratio = 0.14;
    engine
        .db
        .update_project(&proj.id, None, None, Some(&legacy_v1), None, None)
        .unwrap();
    drop(engine);

    let reopened = CelestiaEngine::open(&data_dir, None).unwrap();
    let upgraded = reopened.get_project_detail(&proj.id).unwrap();
    assert_eq!(upgraded.settings_json.schema_version, 2);
    assert!(upgraded.settings_json.audio_enhancement.enabled);
    assert_eq!(upgraded.settings_json.audio_enhancement.preset, "clean_voice");
    assert!(upgraded.settings_json.logo.enabled);
    assert_eq!(upgraded.settings_json.logo.x_ratio, Some(0.89));
    assert_eq!(upgraded.settings_json.logo.y_ratio, Some(0.68));
    assert!((upgraded.settings_json.logo.width_ratio - 0.26).abs() < 1e-6);
}
