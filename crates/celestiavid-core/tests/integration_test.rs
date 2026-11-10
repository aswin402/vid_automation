use celestiavid_core::{
    http_server::spawn_ephemeral_media_server,
    media::{
        ass_generator::{
            generate_ass_content, generate_srt_content, hex_to_ass_color, validate_subtitle_cues,
        },
        demo::{generate_synthetic_logo, generate_synthetic_video},
        geometry::{affine_overlay_expressions, anchor_to_ass_alignment, resolve_anchor_vector},
        pipeline::{build_audio_enhancement_filter, build_color_correction_filter},
    },
    models::{
        AudioEnhancementSettings, ColorCorrectionSettings, ExportCreateRequest,
        ProjectUpdateRequest, SubtitleCueItem, SubtitleStyleSettings, TranscriptionCreateRequest,
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
    assert!(af.contains("equalizer=f=3000"));
    assert!(af.contains("acompressor="));
    assert!(af.contains("volume=2.00dB"));
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
