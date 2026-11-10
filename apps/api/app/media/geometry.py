from typing import Dict, Tuple

# 2D Normalized Anchor Vector Map: (a_x, a_y) in {0.0, 0.5, 1.0}^2
ANCHOR_VECTORS: Dict[str, Tuple[float, float]] = {
    "top-left": (0.0, 0.0),
    "top-center": (0.5, 0.0),
    "top-right": (1.0, 0.0),
    "middle-left": (0.0, 0.5),
    "center": (0.5, 0.5),
    "middle-right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0),
    "bottom-center": (0.5, 1.0),
    "bottom-right": (1.0, 1.0),
}


def resolve_anchor_vector(position: str, default: Tuple[float, float] = (0.5, 1.0)) -> Tuple[float, float]:
    """Returns normalized 2D anchor vector (a_x, a_y) in [0.0, 1.0]^2."""
    return ANCHOR_VECTORS.get(position, default)


def anchor_to_ass_alignment(a_x: float, a_y: float) -> int:
    """
    Computes ASS numpad alignment code (1..9) directly from normalized 2D coordinates
    (a_x, a_y) in [0, 1]^2 using row-major index arithmetic:
      col = round(2 * a_x) in {0, 1, 2}
      row = round(2 * (1 - a_y)) in {0, 1, 2}  (0=bottom, 1=middle, 2=top)
      alignment = 3 * row + col + 1
    """
    clamped_x = min(max(float(a_x), 0.0), 1.0)
    clamped_y = min(max(float(a_y), 0.0), 1.0)
    col = int(round(2.0 * clamped_x))
    row = int(round(2.0 * (1.0 - clamped_y)))
    return 3 * row + col + 1


def affine_overlay_expressions(
    a_x: float,
    a_y: float,
    margin_x_ratio: float,
    margin_y_ratio: float,
) -> Tuple[str, str]:
    """
    Computes comma-free FFmpeg overlay (x_expr, y_expr) using continuous affine interpolation:
      x(a_x) = M_x + a_x * (W - w - 2 * M_x)
      y(a_y) = M_y + a_y * (H - h - 2 * M_y)
    where M_x = W * m_x and M_y = H * m_y.
    Because a_x, a_y in [0, 1] is a convex combination of [M_x, W - w - M_x],
    the result is intrinsically bounded within the frame without requiring max()/min() commas.
    """
    ax = min(max(float(a_x), 0.0), 1.0)
    ay = min(max(float(a_y), 0.0), 1.0)
    mx = min(max(float(margin_x_ratio), 0.0), 0.25)
    my = min(max(float(margin_y_ratio), 0.0), 0.25)

    x_expr = f"((W*{mx:.4f})+{ax:.4f}*(W-w-2*(W*{mx:.4f})))"
    y_expr = f"((H*{my:.4f})+{ay:.4f}*(H-h-2*(H*{my:.4f})))"
    return x_expr, y_expr
