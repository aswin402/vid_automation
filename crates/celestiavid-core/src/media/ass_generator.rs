use crate::error::{AppError, AppResult};
use crate::media::geometry::{anchor_to_ass_alignment, resolve_anchor_vector};
use crate::models::{SubtitleCueItem, SubtitleStyleSettings, ALLOWED_FONTS};

/// Converts a `#RRGGBB` hex string + opacity (`0.0`=transparent, `1.0`=opaque)
/// into ASS `&HAABBGGRR` format using bitwise RGB channel unpacking and 32-bit BGR packing.
pub fn hex_to_ass_color(hex_color: &str, opacity: f64) -> String {
    let cleaned = hex_color.trim().trim_start_matches('#');
    let rgb = if cleaned.len() == 6 {
        u32::from_str_radix(cleaned, 16).unwrap_or(0xFF_FF_FF)
    } else {
        0xFF_FF_FF
    };

    let r = (rgb >> 16) & 0xFF;
    let g = (rgb >> 8) & 0xFF;
    let b = rgb & 0xFF;

    let clamped_opacity = opacity.clamp(0.0, 1.0);
    let alpha_byte = ((1.0 - clamped_opacity) * 255.0).round() as u32 & 0xFF;
    let aabgr = (alpha_byte << 24) | (b << 16) | (g << 8) | r;
    format!("&H{aabgr:08X}")
}

fn decompose_time_units(total_units: i64, subsecond_radix: i64) -> (i64, i64, i64, i64) {
    let clamped = total_units.max(0);
    let total_sec = clamped / subsecond_radix;
    let sub = clamped % subsecond_radix;
    let total_min = total_sec / 60;
    let sec = total_sec % 60;
    let hours = total_min / 60;
    let mins = total_min % 60;
    (hours, mins, sec, sub)
}

/// Formats integer milliseconds as `H:MM:SS.cc` (centiseconds) for ASS subtitles.
pub fn ms_to_ass_timestamp(ms: i64) -> String {
    let total_cs = ((ms.max(0) as f64) / 10.0).round() as i64;
    let (h, m, s, cs) = decompose_time_units(total_cs, 100);
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

/// Formats integer milliseconds as `HH:MM:SS,mmm` for SRT subtitles.
pub fn ms_to_srt_timestamp(ms: i64) -> String {
    let (h, m, s, millis) = decompose_time_units(ms, 1000);
    format!("{h:02}:{m:02}:{s:02},{millis:03}")
}

/// Safely escapes user subtitle text for ASS dialogue lines.
pub fn escape_ass_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(normalized.len() + 8);
    for ch in normalized.chars() {
        match ch {
            '\\' => out.push_str(r"\\"),
            '{' => out.push_str(r"\{"),
            '}' => out.push_str(r"\}"),
            '\n' => out.push_str(r"\N"),
            other => out.push(other),
        }
    }
    out
}

/// Validates cue bounds, monotonic ordering, and non-overlap against `trimmed_duration_ms`.
pub fn validate_subtitle_cues(
    cues: &[SubtitleCueItem],
    trimmed_duration_ms: i64,
    allow_overlaps: bool,
) -> AppResult<Vec<SubtitleCueItem>> {
    if trimmed_duration_ms <= 0 {
        return Err(AppError::validation(
            "SUBTITLE_VALIDATION_FAILED",
            "Trimmed clip duration must be greater than 0 ms.",
        ));
    }

    let mut normalized = Vec::with_capacity(cues.len());
    let mut prev_start: i64 = -1;
    let mut prev_end: i64 = -1;

    for (i, cue) in cues.iter().enumerate() {
        let idx = i + 1;
        let start_ms = cue.start_ms;
        let end_ms = cue.end_ms;
        let raw_text = cue.text.trim().to_string();

        if raw_text.is_empty() {
            return Err(AppError::validation(
                "SUBTITLE_VALIDATION_FAILED",
                format!("Cue #{idx} has empty text."),
            ));
        }
        if start_ms < 0 {
            return Err(AppError::validation(
                "SUBTITLE_VALIDATION_FAILED",
                format!("Cue #{idx} start time ({start_ms} ms) cannot be negative."),
            ));
        }
        if end_ms <= start_ms {
            return Err(AppError::validation(
                "SUBTITLE_VALIDATION_FAILED",
                format!("Cue #{idx} end time ({end_ms} ms) must be greater than start time ({start_ms} ms)."),
            ));
        }
        if end_ms > trimmed_duration_ms {
            return Err(AppError::validation(
                "SUBTITLE_VALIDATION_FAILED",
                format!("Cue #{idx} end time ({end_ms} ms) exceeds trimmed clip duration ({trimmed_duration_ms} ms)."),
            ));
        }
        if start_ms < prev_start {
            return Err(AppError::validation(
                "SUBTITLE_VALIDATION_FAILED",
                format!("Subtitle cues must be in chronological order (Cue #{idx} starts before Cue #{}).", idx - 1),
            ));
        }
        if !allow_overlaps && start_ms < prev_end {
            return Err(AppError::validation(
                "SUBTITLE_VALIDATION_FAILED",
                format!("Cue #{idx} overlaps with Cue #{} ({start_ms} ms < {prev_end} ms).", idx - 1),
            ));
        }

        prev_start = start_ms;
        prev_end = end_ms;
        normalized.push(SubtitleCueItem {
            id: cue.id.clone(),
            sequence: idx,
            start_ms,
            end_ms,
            text: raw_text,
            words_json: cue.words_json.clone(),
        });
    }

    Ok(normalized)
}

/// Generates an ASS (Advanced SubStation Alpha) subtitle document from validated cues and style settings.
pub fn generate_ass_content(
    cues: &[SubtitleCueItem],
    style: &SubtitleStyleSettings,
    play_res_x: u32,
    play_res_y: u32,
) -> String {
    let requested_font = style.font_family.trim();
    let font_family = if ALLOWED_FONTS.contains(&requested_font) {
        requested_font
    } else {
        ALLOWED_FONTS[0]
    };

    let ref_dim = play_res_x.min(play_res_y) as f64;
    let scale_ratio = ref_dim / 1080.0;
    let scaled_font_size = ((style.font_size as f64) * scale_ratio).round().max(14.0) as u32;

    let primary_color = hex_to_ass_color(&style.text_color, 1.0);
    let outline_color = hex_to_ass_color(&style.outline_color, 1.0);

    let bg_enabled = style.background_enabled;
    let bg_color = hex_to_ass_color(
        &style.background_color,
        if bg_enabled { style.background_opacity } else { 0.0 },
    );

    let outline_thickness = if style.outline_enabled && style.outline_thickness > 0 {
        ((style.outline_thickness as f64) * scale_ratio).round().max(1.0) as u32
    } else {
        0
    };
    let shadow_depth = if style.shadow_enabled && style.shadow_depth > 0 {
        ((style.shadow_depth as f64) * scale_ratio).round().max(1.0) as u32
    } else {
        0
    };

    let border_style = if bg_enabled { 3 } else { 1 };
    let ass_outline_color = if bg_enabled { &bg_color } else { &outline_color };
    let default_shadow_hex = hex_to_ass_color("#000000", 0.7);
    let ass_back_color = if bg_enabled { &bg_color } else { &default_shadow_hex };
    let ass_outline_width = if bg_enabled {
        (8.0 * scale_ratio).round().max(6.0) as u32
    } else {
        outline_thickness
    };
    let ass_shadow_depth = if bg_enabled { 0 } else { shadow_depth };

    let (anchor_x, anchor_y) = resolve_anchor_vector(&style.position, (0.5, 1.0));
    let alignment = anchor_to_ass_alignment(anchor_x, anchor_y);

    let margin_v = ((play_res_y as f64) * style.margin_v_ratio).round().max(16.0) as u32;
    let margin_h = ((play_res_x as f64) * style.margin_h_ratio).round().max(16.0) as u32;

    let pos_override = match (style.x_ratio, style.y_ratio) {
        (Some(xr), Some(yr)) => {
            let px = (xr.clamp(0.05, 0.95) * (play_res_x as f64)).round() as i32;
            let py = (yr.clamp(0.05, 0.95) * (play_res_y as f64)).round() as i32;
            format!("{{\\an5\\pos({px},{py})}}")
        }
        _ => String::new(),
    };

    let mut lines = Vec::with_capacity(cues.len() + 16);
    lines.push("[Script Info]".to_string());
    lines.push("ScriptType: v4.00+".to_string());
    lines.push(format!("PlayResX: {play_res_x}"));
    lines.push(format!("PlayResY: {play_res_y}"));
    lines.push("WrapStyle: 0".to_string());
    lines.push("ScaledBorderAndShadow: yes".to_string());
    lines.push(String::new());
    lines.push("[V4+ Styles]".to_string());
    lines.push("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding".to_string());
    lines.push(format!(
        "Style: Default,{font_family},{scaled_font_size},{primary_color},{primary_color},{ass_outline_color},{ass_back_color},-1,0,0,0,100,100,0,0,{border_style},{ass_outline_width},{ass_shadow_depth},{alignment},{margin_h},{margin_h},{margin_v},1"
    ));
    lines.push(String::new());
    lines.push("[Events]".to_string());
    lines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text".to_string());

    for cue in cues {
        let start_str = ms_to_ass_timestamp(cue.start_ms);
        let end_str = ms_to_ass_timestamp(cue.end_ms);
        let safe_text = escape_ass_text(&cue.text);
        lines.push(format!(
            "Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{pos_override}{safe_text}"
        ));
    }

    lines.join("\n") + "\n"
}

/// Generates standard SubRip (`.srt`) content.
pub fn generate_srt_content(cues: &[SubtitleCueItem]) -> String {
    if cues.is_empty() {
        return String::new();
    }
    let blocks: Vec<String> = cues
        .iter()
        .enumerate()
        .map(|(i, cue)| {
            format!(
                "{}\n{} --> {}\n{}",
                i + 1,
                ms_to_srt_timestamp(cue.start_ms),
                ms_to_srt_timestamp(cue.end_ms),
                cue.text.trim()
            )
        })
        .collect();
    blocks.join("\n\n") + "\n"
}
