from typing import Any, Dict, List
from app.core.config import settings
from app.exceptions.handlers import AppError
from app.media.geometry import (
    ANCHOR_VECTORS,
    anchor_to_ass_alignment,
    resolve_anchor_vector,
)

ASS_ALIGNMENT_MAP: Dict[str, int] = {
    name: anchor_to_ass_alignment(vec[0], vec[1])
    for name, vec in ANCHOR_VECTORS.items()
}


def hex_to_ass_color(hex_color: str, opacity: float = 1.0) -> str:
    """
    Converts a #RRGGBB hex string + opacity (0.0=transparent, 1.0=opaque)
    into ASS &HAABBGGRR format using bitwise RGB channel unpacking and 32-bit BGR packing.
    """
    cleaned = hex_color.strip().lstrip("#")
    try:
        rgb = int(cleaned, 16) if len(cleaned) == 6 else 0xFFFFFF
        if not (0 <= rgb <= 0xFFFFFF):
            rgb = 0xFFFFFF
    except ValueError:
        rgb = 0xFFFFFF

    r = (rgb >> 16) & 0xFF
    g = (rgb >> 8) & 0xFF
    b = rgb & 0xFF

    clamped_opacity = min(max(float(opacity), 0.0), 1.0)
    alpha_byte = int(round((1.0 - clamped_opacity) * 255)) & 0xFF
    aabgr = (alpha_byte << 24) | (b << 16) | (g << 8) | r
    return f"&H{aabgr:08X}"


def _decompose_time_units(total_units: int, subsecond_radix: int) -> tuple[int, int, int, int]:
    """
    Decomposes integer subsecond units (e.g. centiseconds or milliseconds)
    into (hours, minutes, seconds, subseconds) via Euclidean divmod arithmetic.
    """
    clamped = max(0, int(total_units))
    total_sec, sub = divmod(clamped, subsecond_radix)
    total_min, sec = divmod(total_sec, 60)
    hours, mins = divmod(total_min, 60)
    return hours, mins, sec, sub


def ms_to_ass_timestamp(ms: int) -> str:
    """Formats integer milliseconds as H:MM:SS.cc (centiseconds) for ASS subtitles."""
    total_cs = int(round(max(0, int(ms)) / 10.0))
    h, m, s, cs = _decompose_time_units(total_cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ms_to_srt_timestamp(ms: int) -> str:
    """Formats integer milliseconds as HH:MM:SS,mmm for SRT subtitles."""
    h, m, s, millis = _decompose_time_units(int(ms), 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{millis:03d}"


_ASS_ESCAPE_TABLE = str.maketrans(
    {
        "\\": r"\\",
        "{": r"\{",
        "}": r"\}",
    }
)


def escape_ass_text(text: str) -> str:
    """
    Safely escapes user subtitle text for ASS dialogue lines using a character translation table.
    """
    normalized_newlines = text.replace("\r\n", "\n").replace("\r", "\n")
    return normalized_newlines.translate(_ASS_ESCAPE_TABLE).replace("\n", r"\N")


def validate_subtitle_cues(
    cues: List[Dict[str, Any]],
    trimmed_duration_ms: int,
    allow_overlaps: bool = False,
) -> List[Dict[str, Any]]:
    """
    Validates cue bounds, monotonic ordering, and non-overlap against trimmed_duration_ms.
    Returns normalized cues indexed 1..N.
    """
    if trimmed_duration_ms <= 0:
        raise AppError(
            "SUBTITLE_VALIDATION_FAILED",
            "Trimmed clip duration must be greater than 0 ms.",
            status_code=400,
        )

    normalized: List[Dict[str, Any]] = []
    prev_start = -1
    prev_end = -1

    for idx, cue in enumerate(cues, start=1):
        start_ms = int(cue.get("start_ms", 0))
        end_ms = int(cue.get("end_ms", 0))
        raw_text = str(cue.get("text", "")).strip()

        if not raw_text:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Cue #{idx} has empty text.",
                status_code=400,
            )
        if start_ms < 0:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Cue #{idx} start time ({start_ms} ms) cannot be negative.",
                status_code=400,
            )
        if end_ms <= start_ms:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Cue #{idx} end time ({end_ms} ms) must be greater than start time ({start_ms} ms).",
                status_code=400,
            )
        if end_ms > trimmed_duration_ms:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Cue #{idx} end time ({end_ms} ms) exceeds trimmed clip duration ({trimmed_duration_ms} ms).",
                status_code=400,
            )
        if start_ms < prev_start:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Subtitle cues must be in chronological order (Cue #{idx} starts before Cue #{idx - 1}).",
                status_code=400,
            )
        if not allow_overlaps and start_ms < prev_end:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Cue #{idx} overlaps with Cue #{idx - 1} ({start_ms} ms < {prev_end} ms).",
                status_code=400,
            )

        prev_start = start_ms
        prev_end = end_ms
        normalized.append(
            {
                "sequence": idx,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": raw_text,
                "words_json": cue.get("words_json"),
            }
        )

    return normalized


def generate_ass_content(
    cues: List[Dict[str, Any]],
    style_cfg: Dict[str, Any],
    play_res_x: int = 1920,
    play_res_y: int = 1080,
) -> str:
    """
    Generates an ASS (Advanced SubStation Alpha) subtitle file from validated cues and style settings.
    """
    requested_font = str(style_cfg.get("font_family", settings.allowed_fonts[0])).strip()
    font_family = (
        requested_font
        if requested_font in settings.allowed_fonts
        else settings.allowed_fonts[0]
    )

    font_size = int(style_cfg.get("font_size", 42))
    ref_dim = min(play_res_x, play_res_y)
    scale_ratio = ref_dim / 1080.0
    scaled_font_size = max(14, int(round(font_size * scale_ratio)))

    primary_color = hex_to_ass_color(style_cfg.get("text_color", "#FFFFFF"), 1.0)
    outline_color = hex_to_ass_color(style_cfg.get("outline_color", "#000000"), 1.0)

    bg_enabled = bool(style_cfg.get("background_enabled", False))
    bg_opacity = float(style_cfg.get("background_opacity", 0.65))
    bg_color = hex_to_ass_color(
        style_cfg.get("background_color", "#000000"),
        bg_opacity if bg_enabled else 0.0,
    )

    outline_enabled = bool(style_cfg.get("outline_enabled", True))
    raw_outline = int(style_cfg.get("outline_thickness", 3))
    outline_thickness = max(1, int(round(raw_outline * scale_ratio))) if outline_enabled and raw_outline > 0 else 0
    shadow_enabled = bool(style_cfg.get("shadow_enabled", True))
    raw_shadow = int(style_cfg.get("shadow_depth", 2))
    shadow_depth = max(1, int(round(raw_shadow * scale_ratio))) if shadow_enabled and raw_shadow > 0 else 0

    # BorderStyle: 3 = opaque/semi-transparent box, 1 = outline + drop shadow
    border_style = 3 if bg_enabled else 1
    ass_outline_color = bg_color if bg_enabled else outline_color
    ass_back_color = bg_color if bg_enabled else hex_to_ass_color("#000000", 0.7)
    ass_outline_width = max(6, int(round(8 * scale_ratio))) if bg_enabled else outline_thickness
    ass_shadow_depth = 0 if bg_enabled else shadow_depth

    position_key = str(style_cfg.get("position", "bottom-center"))
    anchor_x, anchor_y = resolve_anchor_vector(position_key, default=(0.5, 1.0))
    alignment = anchor_to_ass_alignment(anchor_x, anchor_y)

    margin_v_ratio = float(style_cfg.get("margin_v_ratio", 0.06))
    margin_h_ratio = float(style_cfg.get("margin_h_ratio", 0.05))
    margin_v = max(16, int(round(play_res_y * margin_v_ratio)))
    margin_h = max(16, int(round(play_res_x * margin_h_ratio)))

    x_ratio = style_cfg.get("x_ratio")
    y_ratio = style_cfg.get("y_ratio")
    pos_override = ""
    if x_ratio is not None and y_ratio is not None:
        px = int(round(min(max(float(x_ratio), 0.05), 0.95) * play_res_x))
        py = int(round(min(max(float(y_ratio), 0.05), 0.95) * play_res_y))
        pos_override = f"{{\\an5\\pos({px},{py})}}"

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{font_family},{scaled_font_size},{primary_color},{primary_color},{ass_outline_color},{ass_back_color},-1,0,0,0,100,100,0,0,{border_style},{ass_outline_width},{ass_shadow_depth},{alignment},{margin_h},{margin_h},{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for cue in cues:
        start_str = ms_to_ass_timestamp(int(cue["start_ms"]))
        end_str = ms_to_ass_timestamp(int(cue["end_ms"]))
        safe_text = escape_ass_text(str(cue["text"]))
        lines.append(f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{pos_override}{safe_text}")

    return "\n".join(lines) + "\n"


def generate_srt_content(cues: List[Dict[str, Any]]) -> str:
    """Generates standard SRT subtitle file content."""
    blocks = [
        f"{idx}\n{ms_to_srt_timestamp(int(cue['start_ms']))} --> {ms_to_srt_timestamp(int(cue['end_ms']))}\n{str(cue['text']).strip()}"
        for idx, cue in enumerate(cues, start=1)
    ]
    return "\n\n".join(blocks) + ("\n" if blocks else "")
