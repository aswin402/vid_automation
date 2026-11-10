import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from PIL import Image
from app.core.config import settings
from app.exceptions.handlers import AppError


ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm"}
ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


@dataclass
class MediaMetadata:
    duration_ms: Optional[int]
    width: int
    height: int
    video_codec: Optional[str]
    audio_codec: Optional[str]
    frame_rate: Optional[str]
    fps_float: float
    pixel_format: Optional[str]
    has_audio: bool
    size_bytes: int
    mime_type: str


def _parse_frame_rate(rate_str: Optional[str]) -> float:
    if not rate_str or rate_str == "0/0":
        return 30.0
    if "/" in rate_str:
        parts = rate_str.split("/")
        try:
            num = float(parts[0])
            den = float(parts[1])
            if den > 0 and num > 0:
                fps = num / den
                return round(min(max(fps, 10.0), 120.0), 3)
        except (ValueError, ZeroDivisionError):
            return 30.0
    try:
        return round(float(rate_str), 3)
    except ValueError:
        return 30.0


def probe_image_file(file_path: Path) -> MediaMetadata:
    if not file_path.exists() or file_path.stat().st_size == 0:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "Uploaded image file is empty or missing.",
            status_code=400,
        )
    size_bytes = file_path.stat().st_size
    if size_bytes > settings.max_upload_bytes:
        raise AppError(
            "UPLOAD_TOO_LARGE",
            f"Image exceeds maximum allowed upload size of {settings.max_upload_bytes // (1024 * 1024)} MB.",
            status_code=413,
        )
    try:
        with Image.open(file_path) as img:
            img.verify()
        with Image.open(file_path) as img:
            width, height = img.size
            fmt = (img.format or "").upper()
    except Exception as exc:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "This image format isn't supported or the file is corrupted. Upload a PNG, JPEG, or WebP logo.",
            status_code=400,
            internal_detail=str(exc),
        )

    if fmt not in {"PNG", "JPEG", "WEBP"}:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            f"Image format '{fmt}' is not supported. Upload a PNG, JPEG, or WebP image.",
            status_code=400,
        )
    if width < 16 or height < 16 or width > 4096 or height > 4096:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "Logo dimensions must be between 16x16 and 4096x4096 pixels.",
            status_code=400,
        )

    mime_map = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
    return MediaMetadata(
        duration_ms=None,
        width=width,
        height=height,
        video_codec=fmt.lower(),
        audio_codec=None,
        frame_rate=None,
        fps_float=0.0,
        pixel_format="rgba",
        has_audio=False,
        size_bytes=size_bytes,
        mime_type=mime_map.get(fmt, "image/png"),
    )


async def probe_video_file(file_path: Path, check_duration_limit: bool = True) -> MediaMetadata:
    if not file_path.exists() or file_path.stat().st_size == 0:
        raise AppError(
            "MEDIA_PROBE_FAILED",
            "Media file is missing or empty.",
            status_code=400,
        )

    size_bytes = file_path.stat().st_size
    if size_bytes > settings.max_upload_bytes:
        raise AppError(
            "UPLOAD_TOO_LARGE",
            f"Video file exceeds maximum allowed upload size of {settings.max_upload_bytes // (1024 * 1024)} MB.",
            status_code=413,
        )

    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30.0)
    except asyncio.TimeoutError:
        raise AppError(
            "MEDIA_PROBE_FAILED",
            "Timed out while inspecting the uploaded video file.",
            status_code=400,
        )
    except Exception as exc:
        raise AppError(
            "MEDIA_PROBE_FAILED",
            "Could not run media inspection on the uploaded file.",
            status_code=500,
            internal_detail=str(exc),
        )

    if proc.returncode != 0:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "This file format isn't supported or the video is corrupted. Upload an MP4 or MOV video.",
            status_code=400,
            internal_detail=stderr.decode("utf-8", errors="replace"),
        )

    try:
        data = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AppError(
            "MEDIA_PROBE_FAILED",
            "Failed to parse media metadata.",
            status_code=400,
            internal_detail=str(exc),
        )

    streams = data.get("streams", [])
    fmt_info = data.get("format", {})

    video_streams = [s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic", 0) == 0]
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]

    if not video_streams:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "The uploaded file does not contain a valid video stream.",
            status_code=400,
        )

    v_stream = video_streams[0]
    a_stream = audio_streams[0] if audio_streams else None

    width = int(v_stream.get("width") or 0)
    height = int(v_stream.get("height") or 0)

    # Check rotation in side_data_list or tags
    rotation = 0
    tags = v_stream.get("tags", {}) or {}
    if "rotate" in tags:
        try:
            rotation = abs(int(tags["rotate"]))
        except ValueError:
            rotation = 0
    for sd in v_stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            try:
                rotation = abs(int(float(sd["rotation"])))
            except ValueError:
                pass
    if rotation in (90, 270):
        width, height = height, width

    if width <= 0 or height <= 0:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "Video dimensions could not be determined.",
            status_code=400,
        )

    # Extract duration from format or video stream
    duration_sec: Optional[float] = None
    for candidate in (fmt_info.get("duration"), v_stream.get("duration")):
        if candidate is not None:
            try:
                duration_sec = float(candidate)
                if duration_sec > 0:
                    break
            except ValueError:
                continue

    if duration_sec is None or duration_sec <= 0:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "Video duration could not be determined or is zero.",
            status_code=400,
        )

    if check_duration_limit and duration_sec > settings.max_source_duration_seconds:
        raise AppError(
            "UNSUPPORTED_MEDIA",
            f"Video duration ({int(duration_sec)}s) exceeds the maximum allowed limit of {settings.max_source_duration_seconds}s.",
            status_code=400,
        )

    duration_ms = max(1, int(round(duration_sec * 1000)))
    raw_fps = v_stream.get("avg_frame_rate") or v_stream.get("r_frame_rate") or "30/1"
    fps_float = _parse_frame_rate(raw_fps)

    return MediaMetadata(
        duration_ms=duration_ms,
        width=width,
        height=height,
        video_codec=v_stream.get("codec_name"),
        audio_codec=a_stream.get("codec_name") if a_stream else None,
        frame_rate=f"{fps_float:.2f}".rstrip("0").rstrip("."),
        fps_float=fps_float,
        pixel_format=v_stream.get("pix_fmt"),
        has_audio=a_stream is not None,
        size_bytes=size_bytes,
        mime_type="video/mp4",
    )
