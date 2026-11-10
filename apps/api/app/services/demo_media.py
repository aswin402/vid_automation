from pathlib import Path
from PIL import Image, ImageDraw
from app.media.pipeline import run_ffmpeg_command


async def generate_synthetic_video(
    output_path: Path,
    duration_sec: float = 6.0,
    width: int = 1280,
    height: int = 720,
    fps: int = 30,
    with_audio: bool = True,
    freq_hz: int = 440,
) -> Path:
    """
    Generates a synthetic MP4 (H.264 + optional speech-envelope modulated AAC audio) using FFmpeg lavfi.
    The audio uses pulsed amplitude modulation (`sin(2*PI*t*0.45)>-0.2`) so acoustic VAD algorithms
    detect natural speech bursts and pause intervals directly from the waveform.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    audio_inputs = (
        [
            "-f",
            "lavfi",
            "-i",
            (
                f"aevalsrc='0.35*sin(2*PI*{freq_hz}*t)*gt(sin(2*PI*0.42*t),-0.25)'"
                f":s=48000:d={duration_sec}"
            ),
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-b:a",
            "128k",
        ]
        if with_audio
        else []
    )

    args = [
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size={width}x{height}:rate={fps}:duration={duration_sec}",
        *audio_inputs,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ]

    await run_ffmpeg_command(
        args,
        error_code="RENDER_FAILED",
        safe_message="Failed to synthesize sample video.",
    )
    return output_path


def generate_synthetic_logo(
    output_path: Path,
    width: int = 320,
    height: int = 100,
) -> Path:
    """
    Generates a transparent RGBA PNG brand badge using Pillow.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [(4, 4), (width - 5, height - 5)],
        radius=20,
        fill=(79, 70, 229, 230),
        outline=(255, 255, 255, 240),
        width=3,
    )
    draw.polygon(
        [(28, 26), (28, 74), (68, 50)],
        fill=(255, 255, 255, 255),
    )
    draw.rounded_rectangle([(86, 30), (width - 28, 46)], radius=6, fill=(255, 255, 255, 255))
    draw.rounded_rectangle([(86, 56), (width - 68, 68)], radius=4, fill=(199, 210, 254, 240))

    img.save(output_path, format="PNG")
    return output_path
