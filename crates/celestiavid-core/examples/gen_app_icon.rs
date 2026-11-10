use image::{ImageFormat, Rgba, RgbaImage};
use std::path::Path;

fn sd_rounded_rect(px: f32, py: f32, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> f32 {
    let cx = (x0 + x1) * 0.5;
    let cy = (y0 + y1) * 0.5;
    let hx = (x1 - x0) * 0.5 - r;
    let hy = (y1 - y0) * 0.5 - r;
    let dx = ((px - cx).abs() - hx).max(0.0);
    let dy = ((py - cy).abs() - hy).max(0.0);
    (dx * dx + dy * dy).sqrt() - r
}

fn in_triangle(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32, cx: f32, cy: f32) -> bool {
    let d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    let d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    let d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    let has_neg = (d1 < 0.0) || (d2 < 0.0) || (d3 < 0.0);
    let has_pos = (d1 > 0.0) || (d2 > 0.0) || (d3 > 0.0);
    !(has_neg && has_pos)
}

fn main() {
    let size = 1024u32;
    let mut img = RgbaImage::from_pixel(size, size, Rgba([0, 0, 0, 0]));
    let s = size as f32;

    for y in 0..size {
        for x in 0..size {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let sd = sd_rounded_rect(px, py, 56.0, 56.0, s - 56.0, s - 56.0, 210.0);
            if sd <= 1.0 {
                let u = px / s;
                let v = py / s;
                let r = (52.0 + 58.0 * (1.0 - v) + 28.0 * u).clamp(0.0, 255.0) as u8;
                let g = (44.0 + 38.0 * (1.0 - v)).clamp(0.0, 255.0) as u8;
                let b = (188.0 + 55.0 * (1.0 - 0.5 * v)).clamp(0.0, 255.0) as u8;
                let alpha = ((1.0 - sd).clamp(0.0, 1.0) * 255.0) as u8;
                let mut color = Rgba([r, g, b, alpha]);

                // Inner subtle glowing border
                if sd > -14.0 && sd <= -2.0 {
                    color = Rgba([165, 180, 252, alpha]);
                }

                // Center play emblem
                if in_triangle(px, py, 390.0, 300.0, 390.0, 724.0, 728.0, 512.0) {
                    color = Rgba([255, 255, 255, 255]);
                }

                // Bottom subtitle accent bar
                if sd_rounded_rect(px, py, 290.0, 780.0, 734.0, 822.0, 21.0) <= 0.0 {
                    color = Rgba([199, 210, 254, 240]);
                }

                img.put_pixel(x, y, color);
            }
        }
    }

    let out = Path::new("src-tauri/icons/app-icon-source.png");
    if let Some(p) = out.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    img.save_with_format(out, ImageFormat::Png).unwrap();
    println!("Generated {}", out.display());
}
