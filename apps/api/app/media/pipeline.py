import asyncio
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
import structlog
from app.exceptions.handlers import AppError
from app.media.geometry import affine_overlay_expressions, resolve_anchor_vector
from app.media.probe import MediaMetadata, probe_video_file

logger = structlog.get_logger(__name__)

# Strategy table for video spatial normalization modes (pad, crop, stretch)
NORMALIZATION_SCALE_FILTERS: Dict[str, Callable[[int, int], str]] = {
    "pad": lambda w, h: (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"
    ),
    "crop": lambda w, h: (
        f"scale={w}:{h}:force_original_aspect_ratio=increase,"
        f"crop={w}:{h}"
    ),
    "stretch": lambda w, h: f"scale={w}:{h}",
}

ALLOWED_VIDEO_CODECS = {"libx264", "libx265"}
ALLOWED_AUDIO_CODECS = {"aac", "libmp3lame"}
ALLOWED_PRESETS = {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium"}


def _resolve_encoding_profile(output_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    cfg = output_cfg or {}
    v_codec = str(cfg.get("video_codec") or "libx264")
    a_codec = str(cfg.get("audio_codec") or "aac")
    preset = str(cfg.get("preset") or "fast")
    crf = min(max(int(cfg.get("crf") or 20), 14), 35)

    return {
        "video_codec": v_codec if v_codec in ALLOWED_VIDEO_CODECS else "libx264",
        "audio_codec": a_codec if a_codec in ALLOWED_AUDIO_CODECS else "aac",
        "preset": preset if preset in ALLOWED_PRESETS else "fast",
        "crf": str(crf),
    }


def compute_logo_overlay_expressions(
    logo_cfg: Dict[str, Any],
) -> Tuple[str, str]:
    """
    Computes FFmpeg overlay (x_expr, y_expr) using unified 2D affine interpolation:
      x(a_x, m) = M_x + a_x * (W - w - 2*M_x)
      y(a_y, m) = M_y + a_y * (H - h - 2*M_y)
    For preset anchors, uses ANCHOR_VECTORS[position] and margin_ratio.
    For custom drag coordinates (x_ratio, y_ratio), uses (x_ratio, y_ratio) with margin=0.
    """
    x_ratio = logo_cfg.get("x_ratio")
    y_ratio = logo_cfg.get("y_ratio")
    has_custom = x_ratio is not None and y_ratio is not None

    pos = str(logo_cfg.get("position", "top-right"))
    preset_ax, preset_ay = resolve_anchor_vector(pos, default=(1.0, 0.0))

    ax = float(x_ratio) if has_custom else preset_ax
    ay = float(y_ratio) if has_custom else preset_ay
    margin = 0.0 if has_custom else float(logo_cfg.get("margin_ratio", 0.03))

    return affine_overlay_expressions(ax, ay, margin, margin)


async def run_ffmpeg_command(
    args: List[str],
    error_code: str,
    safe_message: str,
    timeout_sec: float = 300.0,
) -> None:
    """
    Executes FFmpeg safely using subprocess argument arrays (no shell interpolation).
    Captures stderr for internal diagnostics while returning safe user-facing errors.
    """
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostdin", *args]
    logger.info("ffmpeg_exec_start", error_code_context=error_code, arg_count=len(cmd))
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        raise AppError(
            error_code,
            f"{safe_message} (Operation timed out).",
            status_code=500,
        )
    except Exception as exc:
        raise AppError(
            error_code,
            safe_message,
            status_code=500,
            internal_detail=str(exc),
        )

    if proc.returncode != 0:
        stderr_str = stderr.decode("utf-8", errors="replace")[-2000:]
        raise AppError(
            error_code,
            safe_message,
            status_code=500,
            internal_detail=f"exit={proc.returncode} stderr={stderr_str}",
        )


def validate_trim_range(
    start_ms: int,
    end_ms: Optional[int],
    source_duration_ms: int,
) -> Tuple[int, int]:
    """
    Validates 0 <= start_ms < end_ms <= source_duration_ms.
    Returns (start_ms, resolved_end_ms).
    """
    resolved_end = source_duration_ms if end_ms is None else int(end_ms)
    start = int(start_ms)

    if start < 0:
        raise AppError(
            "INVALID_TRIM_RANGE",
            "The start time cannot be negative.",
            status_code=400,
        )
    if resolved_end <= start:
        raise AppError(
            "INVALID_TRIM_RANGE",
            "The end time must be later than the start time.",
            status_code=400,
        )
    if resolved_end > source_duration_ms:
        raise AppError(
            "INVALID_TRIM_RANGE",
            f"The selected end time ({resolved_end} ms) is longer than the uploaded video ({source_duration_ms} ms).",
            status_code=400,
        )
    if resolved_end - start < 200:
        raise AppError(
            "INVALID_TRIM_RANGE",
            "The selected clip must be at least 0.2 seconds (200 ms) long.",
            status_code=400,
        )
    return start, resolved_end


def _build_audio_input_and_map(
    has_audio: bool,
    duration_sec: float,
) -> Tuple[List[str], List[str]]:
    """
    Returns (extra_inputs, stream_maps) so clips with or without an audio stream
    both produce a normalized stereo track without duplicating FFmpeg command lists.
    """
    if has_audio:
        return [], ["-map", "0:v:0", "-map", "0:a:0"]
    return (
        [
            "-f",
            "lavfi",
            "-t",
            f"{duration_sec:.3f}",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
        ],
        ["-map", "0:v:0", "-map", "1:a:0", "-shortest"],
    )


async def trim_video_segment(
    source_path: Path,
    output_path: Path,
    start_ms: int,
    end_ms: int,
    source_meta: MediaMetadata,
    target_width: Optional[int] = None,
    target_height: Optional[int] = None,
    target_fps: Optional[float] = None,
    output_cfg: Optional[Dict[str, Any]] = None,
) -> MediaMetadata:
    """
    Frame-accurately trims the source video between start_ms and end_ms,
    normalizing video (even dimensions, yuv420p) and audio (48kHz stereo).
    """
    start_, end_ = validate_trim_range(start_ms, end_ms, source_meta.duration_ms or 0)
    duration_sec = (end_ - start_) / 1000.0
    start_sec = start_ / 1000.0

    out_w = max(2, (int(target_width or source_meta.width) // 2) * 2)
    out_h = max(2, (int(target_height or source_meta.height) // 2) * 2)
    out_fps = float(target_fps or source_meta.fps_float or 30.0)
    enc = _resolve_encoding_profile(output_cfg)

    scale_filter = NORMALIZATION_SCALE_FILTERS["pad"](out_w, out_h)
    vf_chain = f"{scale_filter},setsar=1,fps={out_fps:.3f},format=yuv420p"

    extra_inputs, map_args = _build_audio_input_and_map(source_meta.has_audio, duration_sec)

    args = [
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        str(source_path),
        *extra_inputs,
        *map_args,
        "-vf",
        vf_chain,
        "-c:v",
        enc["video_codec"],
        "-preset",
        enc["preset"],
        "-crf",
        enc["crf"],
        "-c:a",
        enc["audio_codec"],
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]

    await run_ffmpeg_command(
        args,
        error_code="RENDER_FAILED",
        safe_message="Failed to trim the selected video segment.",
    )
    return await probe_video_file(output_path, check_duration_limit=False)


async def extract_audio_for_transcription(
    trimmed_video_path: Path,
    audio_output_path: Path,
) -> Path:
    """
    Extracts mono 16kHz PCM WAV audio from the trimmed clip for acoustic VAD and speech-to-text.
    """
    args = [
        "-i",
        str(trimmed_video_path),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        str(audio_output_path),
    ]
    await run_ffmpeg_command(
        args,
        error_code="TRANSCRIPTION_PROVIDER_ERROR",
        safe_message="Could not extract audio from the trimmed video clip.",
    )
    return audio_output_path


def compute_color_channel_gains(
    temperature: float,
    tint: float,
) -> Tuple[float, float, float]:
    """
    Computes linear RGB channel gain multipliers (r_gain, g_gain, b_gain) from
    normalized color temperature t in [-1, 1] (cool <-> warm) and tint m in [-1, 1] (green <-> magenta).
    Identical equations are used by the frontend SVG <feColorMatrix> for 1:1 preview parity.
    """
    t = min(max(float(temperature), -1.0), 1.0)
    m = min(max(float(tint), -1.0), 1.0)
    r_gain = min(max(1.0 + 0.18 * t + 0.08 * m, 0.5), 1.6)
    g_gain = min(max(1.0 + 0.03 * t - 0.14 * m, 0.5), 1.6)
    b_gain = min(max(1.0 - 0.18 * t + 0.08 * m, 0.5), 1.6)
    return r_gain, g_gain, b_gain


def build_color_correction_filter(
    color_cfg: Optional[Dict[str, Any]],
) -> Optional[str]:
    """
    Constructs an FFmpeg video filter chain for color correction & grading (`eq`, `colorchannelmixer`, `unsharp`)
    when `color_cfg.enabled` is True and at least one parameter deviates from identity.
    """
    if not color_cfg or not color_cfg.get("enabled", False):
        return None

    brightness = min(max(float(color_cfg.get("brightness", 0.0)), -0.5), 0.5)
    contrast = min(max(float(color_cfg.get("contrast", 1.0)), 0.5), 2.0)
    saturation = min(max(float(color_cfg.get("saturation", 1.0)), 0.0), 2.5)
    gamma = min(max(float(color_cfg.get("gamma", 1.0)), 0.5), 2.0)
    temperature = min(max(float(color_cfg.get("temperature", 0.0)), -1.0), 1.0)
    tint = min(max(float(color_cfg.get("tint", 0.0)), -1.0), 1.0)
    sharpen = min(max(float(color_cfg.get("sharpen", 0.0)), 0.0), 1.5)

    stages: List[str] = []

    if (
        abs(brightness) > 1e-4
        or abs(contrast - 1.0) > 1e-4
        or abs(saturation - 1.0) > 1e-4
        or abs(gamma - 1.0) > 1e-4
    ):
        stages.append(
            f"eq=brightness={brightness:.4f}:contrast={contrast:.4f}:"
            f"saturation={saturation:.4f}:gamma={gamma:.4f}"
        )

    if abs(temperature) > 1e-4 or abs(tint) > 1e-4:
        r_g, g_g, b_g = compute_color_channel_gains(temperature, tint)
        stages.append(
            f"colorchannelmixer=rr={r_g:.4f}:gg={g_g:.4f}:bb={b_g:.4f}"
        )

    if sharpen > 0.01:
        stages.append(f"unsharp=5:5:{sharpen:.3f}:5:5:0.0")

    return ",".join(stages) if stages else None


async def render_main_segment(
    trimmed_video_path: Path,
    output_path: Path,
    trimmed_meta: MediaMetadata,
    logo_path: Optional[Path] = None,
    logo_cfg: Optional[Dict[str, Any]] = None,
    ass_path: Optional[Path] = None,
    output_cfg: Optional[Dict[str, Any]] = None,
    color_cfg: Optional[Dict[str, Any]] = None,
) -> MediaMetadata:
    """
    Applies optional color correction, optional logo overlay, and optional burned-in ASS subtitles
    onto the trimmed main segment.
    """
    color_filter = build_color_correction_filter(color_cfg)
    use_color = bool(color_filter)
    use_logo = bool(
        logo_path
        and logo_path.exists()
        and logo_cfg
        and logo_cfg.get("enabled", False)
    )
    use_subs = bool(ass_path and ass_path.exists())

    if not use_color and not use_logo and not use_subs:
        args = [
            "-i",
            str(trimmed_video_path),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        await run_ffmpeg_command(
            args,
            error_code="RENDER_FAILED",
            safe_message="Failed to prepare the main video segment.",
        )
        return await probe_video_file(output_path, check_duration_limit=False)

    enc = _resolve_encoding_profile(output_cfg)
    filter_parts: List[str] = []
    inputs: List[str] = ["-i", str(trimmed_video_path)]
    current_v = "[0:v]"

    if use_color and color_filter:
        filter_parts.append(f"{current_v}{color_filter}[graded]")
        current_v = "[graded]"

    if use_logo and logo_path and logo_cfg:
        inputs.extend(["-i", str(logo_path)])
        width_ratio = min(max(float(logo_cfg.get("width_ratio", 0.14)), 0.03), 0.50)
        opacity = min(max(float(logo_cfg.get("opacity", 1.0)), 0.05), 1.0)
        logo_w = max(24, int(round(trimmed_meta.width * width_ratio)))
        x_expr, y_expr = compute_logo_overlay_expressions(logo_cfg)

        filter_parts.append(
            f"[1:v]scale={logo_w}:-1,format=rgba,colorchannelmixer=aa={opacity:.3f}[logo]"
        )
        filter_parts.append(
            f"{current_v}[logo]overlay=x={x_expr}:y={y_expr}:format=auto[branded]"
        )
        current_v = "[branded]"

    if use_subs and ass_path:
        escaped_ass = (
            str(ass_path.resolve())
            .replace("\\", "/")
            .replace(":", r"\:")
            .replace("'", r"\'")
        )
        filter_parts.append(f"{current_v}ass=filename='{escaped_ass}'[subbed]")
        current_v = "[subbed]"

    filter_parts.append(f"{current_v}format=yuv420p[vout]")
    filter_complex = ";".join(filter_parts)

    args = [
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-map",
        "0:a:0",
        "-c:v",
        enc["video_codec"],
        "-preset",
        enc["preset"],
        "-crf",
        enc["crf"],
        "-c:a",
        enc["audio_codec"],
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]

    await run_ffmpeg_command(
        args,
        error_code="RENDER_FAILED",
        safe_message="Failed while rendering logo overlay and subtitles onto the main video.",
    )
    return await probe_video_file(output_path, check_duration_limit=False)


async def normalize_and_concat_outro(
    main_render_path: Path,
    outro_source_path: Path,
    normalized_outro_path: Path,
    final_output_path: Path,
    main_meta: MediaMetadata,
    normalization_mode: str = "pad",
    output_cfg: Optional[Dict[str, Any]] = None,
    color_cfg: Optional[Dict[str, Any]] = None,
) -> MediaMetadata:
    """
    Normalizes the outro video using the selected spatial normalization mode ('pad', 'crop', or 'stretch')
    to match main_meta dimensions, frame rate, pixel format, and 48kHz stereo audio, then concatenates.
    """
    outro_meta = await probe_video_file(outro_source_path, check_duration_limit=True)
    outro_duration_sec = (outro_meta.duration_ms or 1000) / 1000.0
    enc = _resolve_encoding_profile(output_cfg)

    w = max(2, (main_meta.width // 2) * 2)
    h = max(2, (main_meta.height // 2) * 2)
    fps = main_meta.fps_float or 30.0

    scale_builder = NORMALIZATION_SCALE_FILTERS.get(
        normalization_mode, NORMALIZATION_SCALE_FILTERS["pad"]
    )
    outro_color_filter = (
        build_color_correction_filter(color_cfg)
        if (color_cfg and color_cfg.get("apply_to_outro", False))
        else None
    )
    color_stage = f",{outro_color_filter}" if outro_color_filter else ""
    vf_chain = f"{scale_builder(w, h)},setsar=1,fps={fps:.3f}{color_stage},format=yuv420p"
    extra_inputs, map_args = _build_audio_input_and_map(outro_meta.has_audio, outro_duration_sec)

    norm_args = [
        "-i",
        str(outro_source_path),
        *extra_inputs,
        *map_args,
        "-vf",
        vf_chain,
        "-c:v",
        enc["video_codec"],
        "-preset",
        enc["preset"],
        "-crf",
        enc["crf"],
        "-c:a",
        enc["audio_codec"],
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(normalized_outro_path),
    ]

    await run_ffmpeg_command(
        norm_args,
        error_code="OUTRO_NORMALIZATION_FAILED",
        safe_message="The outro could not be normalized. Try another video or export without the outro.",
    )

    concat_args = [
        "-i",
        str(main_render_path),
        "-i",
        str(normalized_outro_path),
        "-filter_complex",
        "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        enc["video_codec"],
        "-preset",
        enc["preset"],
        "-crf",
        enc["crf"],
        "-c:a",
        enc["audio_codec"],
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(final_output_path),
    ]

    await run_ffmpeg_command(
        concat_args,
        error_code="CONCAT_FAILED",
        safe_message="Failed to join the outro video with the main clip.",
    )

    return await probe_video_file(final_output_path, check_duration_limit=False)
