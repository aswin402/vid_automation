/// Returns normalized 2D anchor vector `(a_x, a_y)` in `[0.0, 1.0]^2` for 9-grid anchor presets.
pub fn resolve_anchor_vector(position: &str, default: (f64, f64)) -> (f64, f64) {
    match position {
        "top-left" => (0.0, 0.0),
        "top-center" => (0.5, 0.0),
        "top-right" => (1.0, 0.0),
        "middle-left" => (0.0, 0.5),
        "center" => (0.5, 0.5),
        "middle-right" => (1.0, 0.5),
        "bottom-left" => (0.0, 1.0),
        "bottom-center" => (0.5, 1.0),
        "bottom-right" => (1.0, 1.0),
        _ => default,
    }
}

/// Computes ASS numpad alignment code (`1..=9`) directly from normalized 2D coordinates
/// `(a_x, a_y)` in `[0, 1]^2` using row-major index arithmetic:
///   `col = round(2 * a_x)` in `{0, 1, 2}`
///   `row = round(2 * (1 - a_y))` in `{0, 1, 2}` (`0=bottom`, `1=middle`, `2=top`)
///   `alignment = 3 * row + col + 1`
pub fn anchor_to_ass_alignment(a_x: f64, a_y: f64) -> u8 {
    let clamped_x = a_x.clamp(0.0, 1.0);
    let clamped_y = a_y.clamp(0.0, 1.0);
    let col = (2.0 * clamped_x).round() as u8;
    let row = (2.0 * (1.0 - clamped_y)).round() as u8;
    3 * row + col + 1
}

/// Computes comma-free FFmpeg overlay `(x_expr, y_expr)` using continuous affine interpolation:
///   `x(a_x) = M_x + a_x * (W - w - 2 * M_x)`
///   `y(a_y) = M_y + a_y * (H - h - 2 * M_y)`
/// where `M_x = W * m_x` and `M_y = H * m_y`.
pub fn affine_overlay_expressions(
    a_x: f64,
    a_y: f64,
    margin_x_ratio: f64,
    margin_y_ratio: f64,
) -> (String, String) {
    let ax = a_x.clamp(0.0, 1.0);
    let ay = a_y.clamp(0.0, 1.0);
    let mx = margin_x_ratio.clamp(0.0, 0.25);
    let my = margin_y_ratio.clamp(0.0, 0.25);

    let x_expr = format!("((W*{mx:.4})+{ax:.4}*(W-w-2*(W*{mx:.4})))");
    let y_expr = format!("((H*{my:.4})+{ay:.4}*(H-h-2*(H*{my:.4})))");
    (x_expr, y_expr)
}
