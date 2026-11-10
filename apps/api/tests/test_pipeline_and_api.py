import asyncio
from pathlib import Path
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app, lifespan
from app.exceptions.handlers import AppError
from app.media.ass_generator import (
    escape_ass_text,
    generate_ass_content,
    generate_srt_content,
    hex_to_ass_color,
    ms_to_ass_timestamp,
    ms_to_srt_timestamp,
    validate_subtitle_cues,
)
from app.media.geometry import (
    ANCHOR_VECTORS,
    affine_overlay_expressions,
    anchor_to_ass_alignment,
)
from app.media.pipeline import (
    build_color_correction_filter,
    compute_color_channel_gains,
    compute_logo_overlay_expressions,
    validate_trim_range,
)
from app.media.probe import probe_video_file
from app.providers.transcription import detect_speech_intervals_from_wav
from app.services.demo_media import generate_synthetic_logo, generate_synthetic_video
from app.services.storage import storage_service


def test_trim_validation():
    assert validate_trim_range(0, 5000, 10000) == (0, 5000)
    assert validate_trim_range(1000, None, 8000) == (1000, 8000)

    with pytest.raises(AppError) as exc_neg:
        validate_trim_range(-10, 5000, 10000)
    assert exc_neg.value.error_code == "INVALID_TRIM_RANGE"

    with pytest.raises(AppError) as exc_order:
        validate_trim_range(5000, 4000, 10000)
    assert exc_order.value.error_code == "INVALID_TRIM_RANGE"

    with pytest.raises(AppError) as exc_bounds:
        validate_trim_range(0, 12000, 10000)
    assert exc_bounds.value.error_code == "INVALID_TRIM_RANGE"


def test_ass_and_srt_formatting():
    assert ms_to_ass_timestamp(0) == "0:00:00.00"
    assert ms_to_ass_timestamp(1250) == "0:00:01.25"
    assert ms_to_srt_timestamp(62345) == "00:01:02,345"

    # Opaque white (#FFFFFF, opacity 1.0) -> &H00FFFFFF
    assert hex_to_ass_color("#FFFFFF", 1.0) == "&H00FFFFFF"
    # Red (#FF0000, opacity 1.0) -> BGR order &H000000FF
    assert hex_to_ass_color("#FF0000", 1.0) == "&H000000FF"

    escaped = escape_ass_text("Hello {world}\\test\nSecond line")
    assert r"\{world\}" in escaped
    assert r"\N" in escaped

    cues = validate_subtitle_cues(
        [
            {"sequence": 1, "start_ms": 200, "end_ms": 1500, "text": "First subtitle cue"},
            {"sequence": 2, "start_ms": 1600, "end_ms": 3000, "text": "Second {styled} cue"},
        ],
        trimmed_duration_ms=4000,
    )
    assert len(cues) == 2

    # Overlap should raise SUBTITLE_VALIDATION_FAILED when allow_overlaps=False
    with pytest.raises(AppError) as exc_overlap:
        validate_subtitle_cues(
            [
                {"sequence": 1, "start_ms": 200, "end_ms": 2000, "text": "One"},
                {"sequence": 2, "start_ms": 1500, "end_ms": 3000, "text": "Two"},
            ],
            trimmed_duration_ms=4000,
            allow_overlaps=False,
        )
    assert exc_overlap.value.error_code == "SUBTITLE_VALIDATION_FAILED"

    ass_content = generate_ass_content(
        cues=cues,
        style_cfg={
            "position": "top-center",
            "font_family": "/etc/passwd",  # Should fall back to allowlisted DejaVu Sans
            "font_size": 44,
            "text_color": "#FFFF00",
        },
        play_res_x=1280,
        play_res_y=720,
    )
    assert "DejaVu Sans" in ass_content
    assert "/etc/passwd" not in ass_content
    assert "Dialogue: 0,0:00:00.20,0:00:01.50" in ass_content

    srt_content = generate_srt_content(cues)
    assert "00:00:00,200 --> 00:00:01,500" in srt_content


def test_logo_overlay_coordinates():
    # Verify 2D affine interpolation formula x(a_x) = M_x + a_x*(W - w - 2*M_x)
    x_expr, y_expr = compute_logo_overlay_expressions({"position": "bottom-right", "margin_ratio": 0.04})
    assert "1.0000*(W-w-2*(W*0.0400))" in x_expr
    assert "1.0000*(H-h-2*(H*0.0400))" in y_expr

    # Verify ASS numpad alignment 3*row + col + 1 for all 9 presets
    expected_numpad = {
        "bottom-left": 1,
        "bottom-center": 2,
        "bottom-right": 3,
        "middle-left": 4,
        "center": 5,
        "middle-right": 6,
        "top-left": 7,
        "top-center": 8,
        "top-right": 9,
    }
    for name, (ax, ay) in ANCHOR_VECTORS.items():
        assert anchor_to_ass_alignment(ax, ay) == expected_numpad[name]

    cx_expr, cy_expr = compute_logo_overlay_expressions({"x_ratio": 0.25, "y_ratio": 0.75})
    assert "0.2500" in cx_expr
    assert "0.7500" in cy_expr


def test_storage_keys_and_signed_tokens():
    key = storage_service.generate_storage_key("proj-123", "source", "../../evil_name.mp4")
    assert key.startswith("projects/proj-123/source/")
    assert "evil_name" not in key
    assert ".." not in key

    token, _ = storage_service.create_signed_token("asset-1", "download", expires_in=60)
    assert storage_service.verify_signed_token("asset-1", "download", token) is True
    assert storage_service.verify_signed_token("asset-1", "upload", token) is False
    assert storage_service.verify_signed_token("asset-2", "download", token) is False


@pytest.mark.asyncio
async def test_acoustic_vad_segmentation(tmp_path: Path):
    """
    Synthesizes a 6-second video with pulsed speech-envelope audio (aevalsrc),
    extracts the 16kHz PCM WAV, and verifies that the Acoustic VAD algorithm
    detects distinct speech burst intervals and computes valid dBFS levels.
    """
    from app.media.pipeline import extract_audio_for_transcription

    vid_path = await generate_synthetic_video(
        tmp_path / "pulsed_speech.mp4",
        duration_sec=6.0,
        width=640,
        height=360,
        fps=24,
        with_audio=True,
        freq_hz=440,
    )
    wav_path = tmp_path / "pulsed_speech.wav"
    await extract_audio_for_transcription(vid_path, wav_path)

    intervals = detect_speech_intervals_from_wav(wav_path, duration_ms=6000)
    assert len(intervals) >= 2
    for start_ms, end_ms, rms_db in intervals:
        assert 0 <= start_ms < end_ms <= 6000
        assert -60.0 <= rms_db <= 0.0


@pytest.mark.asyncio
async def test_end_to_end_workflow_and_pipeline(tmp_path: Path):
    # Generate synthetic test assets (no-audio source + RGBA logo + audio outro)
    src_file = await generate_synthetic_video(
        tmp_path / "source_silent.mp4", duration_sec=4.0, width=640, height=360, fps=24, with_audio=False
    )
    logo_file = generate_synthetic_logo(tmp_path / "logo.png", width=160, height=60)
    outro_file = await generate_synthetic_video(
        tmp_path / "outro_audio.mp4", duration_sec=2.0, width=640, height=360, fps=30, with_audio=True
    )

    async with lifespan(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            # 1. Create project
            create_resp = await client.post("/api/v1/projects", json={"name": "E2E Test Campaign"})
            assert create_resp.status_code == 201
            project = create_resp.json()
            project_id = project["id"]

            # 2. Verify another user cannot access this project
            forbidden_resp = await client.get(
                f"/api/v1/projects/{project_id}",
                headers={"X-User-Id": "other-user-999"},
            )
            assert forbidden_resp.status_code == 403

            # 3. Signed upload flow for source video
            up_url_resp = await client.post(
                f"/api/v1/projects/{project_id}/assets/upload-url",
                json={
                    "kind": "source",
                    "filename": "source_silent.mp4",
                    "content_type": "video/mp4",
                    "size_bytes": src_file.stat().st_size,
                },
            )
            assert up_url_resp.status_code == 200
            up_data = up_url_resp.json()

            put_resp = await client.put(
                up_data["upload_url"],
                content=src_file.read_bytes(),
                headers={"Content-Type": "video/mp4"},
            )
            assert put_resp.status_code == 200

            comp_resp = await client.post(
                f"/api/v1/projects/{project_id}/assets/complete",
                json={"asset_id": up_data["asset_id"]},
            )
            assert comp_resp.status_code == 200
            src_asset = comp_resp.json()
            assert src_asset["status"] == "ready"
            assert src_asset["width"] == 640
            assert src_asset["height"] == 360
            assert src_asset["has_audio"] is False

            # 4. Upload logo & outro
            for kind, fpath, mime in [
                ("logo", logo_file, "image/png"),
                ("outro", outro_file, "video/mp4"),
            ]:
                u_resp = await client.post(
                    f"/api/v1/projects/{project_id}/assets/upload-url",
                    json={
                        "kind": kind,
                        "filename": fpath.name,
                        "content_type": mime,
                        "size_bytes": fpath.stat().st_size,
                    },
                )
                u_info = u_resp.json()
                await client.put(u_info["upload_url"], content=fpath.read_bytes())
                c_resp = await client.post(
                    f"/api/v1/projects/{project_id}/assets/complete",
                    json={"asset_id": u_info["asset_id"]},
                )
                assert c_resp.status_code == 200

            # 5. Update project trim (500ms -> 3500ms = 3.0s trimmed clip), logo, subtitles, outro
            proj_detail = (await client.get(f"/api/v1/projects/{project_id}")).json()
            settings_payload = proj_detail["settings_json"]
            settings_payload["trim"] = {"start_ms": 500, "end_ms": 3500}
            settings_payload["logo"]["enabled"] = True
            settings_payload["logo"]["position"] = "bottom-right"
            settings_payload["logo"]["opacity"] = 0.9
            settings_payload["outro"]["enabled"] = True
            settings_payload["color_correction"] = {
                "enabled": True,
                "preset": "warm_cinema",
                "brightness": 0.02,
                "contrast": 1.12,
                "saturation": 1.08,
                "gamma": 0.96,
                "temperature": 0.25,
                "tint": -0.05,
                "sharpen": 0.15,
                "apply_to_outro": False,
            }

            patch_resp = await client.patch(
                f"/api/v1/projects/{project_id}",
                json={"settings": settings_payload},
            )
            assert patch_resp.status_code == 200

            # 6. Trigger AI transcription job & wait for completion
            trans_resp = await client.post(
                f"/api/v1/projects/{project_id}/transcriptions",
                json={"language": "en", "confirm_overwrite": True},
            )
            assert trans_resp.status_code == 202
            trans_job_id = trans_resp.json()["id"]

            for _ in range(50):
                j_resp = (await client.get(f"/api/v1/jobs/{trans_job_id}")).json()
                if j_resp["status"] in ("completed", "failed"):
                    break
                await asyncio.sleep(0.2)
            assert j_resp["status"] == "completed"

            # 7. Fetch & edit subtitles
            subs_resp = await client.get(f"/api/v1/projects/{project_id}/subtitle-versions/0")
            assert subs_resp.status_code == 200
            subs_data = subs_resp.json()
            assert len(subs_data["cues"]) >= 1

            edited_cues = [
                {
                    "sequence": 1,
                    "start_ms": 200,
                    "end_ms": 1400,
                    "text": "Custom edited brand caption #1",
                },
                {
                    "sequence": 2,
                    "start_ms": 1500,
                    "end_ms": 2800,
                    "text": "Automated workflow verified!",
                },
            ]
            put_subs = await client.put(
                f"/api/v1/projects/{project_id}/subtitle-versions/{subs_data['version']}",
                json={"language": "en", "cues": edited_cues},
            )
            assert put_subs.status_code == 200
            new_sub_ver = put_subs.json()["version"]

            # Verify SRT export
            srt_resp = await client.get(
                f"/api/v1/projects/{project_id}/subtitle-versions/{new_sub_ver}/srt"
            )
            assert srt_resp.status_code == 200
            assert "Custom edited brand caption #1" in srt_resp.text

            # 8. Submit final Export job (Trims 3s silent clip + burns logo + burns ASS subtitles + joins 2s audio outro = ~5s output)
            exp_resp = await client.post(
                f"/api/v1/projects/{project_id}/exports",
                json={"subtitle_version": new_sub_ver, "idempotency_key": "test-export-1"},
            )
            assert exp_resp.status_code == 202
            exp_job_id = exp_resp.json()["id"]

            for _ in range(80):
                ej = (await client.get(f"/api/v1/jobs/{exp_job_id}")).json()
                if ej["status"] in ("completed", "failed"):
                    break
                await asyncio.sleep(0.25)

            assert ej["status"] == "completed", f"Export failed: {ej}"
            output_asset_id = ej["output_asset_id"]
            assert output_asset_id is not None

            # 9. Download and probe final output
            dl_url_resp = await client.post(f"/api/v1/assets/{output_asset_id}/download-url")
            assert dl_url_resp.status_code == 200
            dl_url = dl_url_resp.json()["download_url"]

            dl_resp = await client.get(dl_url)
            assert dl_resp.status_code == 200
            out_mp4 = tmp_path / "downloaded_output.mp4"
            out_mp4.write_bytes(dl_resp.content)

            final_meta = await probe_video_file(out_mp4, check_duration_limit=False)
            assert final_meta.width == 640
            assert final_meta.height == 360
            assert final_meta.has_audio is True
            # 3.0s main + 2.0s outro = ~5.0s (4500ms - 5500ms)
            assert 4500 <= (final_meta.duration_ms or 0) <= 5500


def test_color_correction_filter_chain():
    # Bypassed when disabled or neutral
    assert build_color_correction_filter(None) is None
    assert build_color_correction_filter({"enabled": False, "contrast": 1.5}) is None
    assert (
        build_color_correction_filter(
            {
                "enabled": True,
                "brightness": 0.0,
                "contrast": 1.0,
                "saturation": 1.0,
                "gamma": 1.0,
                "temperature": 0.0,
                "tint": 0.0,
                "sharpen": 0.0,
            }
        )
        is None
    )

    # Warm cinema + sharpness builds eq, colorchannelmixer, and unsharp stages
    flt = build_color_correction_filter(
        {
            "enabled": True,
            "brightness": 0.05,
            "contrast": 1.15,
            "saturation": 1.2,
            "gamma": 0.95,
            "temperature": 0.3,
            "tint": -0.1,
            "sharpen": 0.4,
        }
    )
    assert "eq=brightness=0.0500:contrast=1.1500:saturation=1.2000:gamma=0.9500" in flt
    assert "colorchannelmixer=" in flt
    assert "unsharp=5:5:0.400:5:5:0.0" in flt

    r_gain, g_gain, b_gain = compute_color_channel_gains(0.5, 0.0)
    assert r_gain > 1.0
    assert b_gain < 1.0
    assert 0.5 <= g_gain <= 1.6
