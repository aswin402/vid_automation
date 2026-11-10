# Changelog

All notable changes to **CelestiaVid — AI Video Automation Platform** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.0.1] - 2026-11-10

### Added

#### 1. Guided 7-Step Studio Web Application (`apps/web`)
- **Step 1 — Upload Assets**: Drag-and-drop upload for source videos (`MP4`, `MOV`, `WebM`, `M4V`), transparent brand logos (`PNG`, `WebP`, `SVG`), and brand outro clips with instant `FFprobe` stream metadata inspection.
- **Step 2 — Frame-Accurate Trim**: Dual-handle timeline range selector (`MM:SS.mmm`), fine `-0.5s / +0.5s` nudge buttons, live clip duration readout, and canonical `00:00.000` trimmed timeline normalization.
- **Step 3 — Optional Color Correction & Grading**:
  - 7 one-click look presets: *Neutral*, *Natural Boost*, *Warm Cinema*, *Cool Studio*, *Punchy Pop*, *Vintage Matte*, and *B&W Noir*.
  - 7 fine-tune sliders: *Brightness*, *Contrast*, *Saturation*, *Gamma*, *White Balance Temperature*, *Green/Magenta Tint*, and *Luma Sharpness*.
  - Live **Hold to Compare** original vs. graded toggle and **Apply to Outro** option.
- **Step 4 — Brand Logo Overlay**:
  - 9-point anchor grid (*Top-Left*, *Center*, *Bottom-Right*, etc.) plus freeform drag-and-drop placement on the video canvas.
  - Normalized width scale (`5%`–`50%`), opacity (`10%`–`100%`), and margin ratio controls.
- **Step 5 — AI Subtitles, Review & Styling**:
  - One-click AI speech-to-text transcription with language selection (`auto`, `en`, `es`, `fr`, `de`, `pt`, `hi`, `ja`).
  - Interactive cue table editor with timestamp validation, overlap detection, cue split/merge/add/delete, and `.srt` download.
  - Full ASS subtitle styling: font family, pixel size, primary text color, outline color & thickness, shadow depth, opaque background box (`BorderStyle=3`), 9-point anchor grid, and freeform canvas dragging.
- **Step 6 — Outro Attachment**: Optional brand outro video preview and attachment with automatic resolution, frame rate, SAR, pixel format (`yuv420p`), and stereo audio (`48 kHz`) normalization.
- **Step 7 — Review & Export MP4**:
  - 5-card configuration summary, live 10-stage job progress tracker, cancel/retry controls, in-browser output player, and `FFprobe` verification badge.

#### 2. Asynchronous FastAPI Backend & FFmpeg Media Pipeline (`apps/api`)
- **Pure Mathematical & Algorithmic Media Engine**:
  - **2D Affine Anchor Basis (`app/media/geometry.py`)**: Unified `AnchorVector(ax, ay)` coordinate solver generating both FFmpeg overlay expressions (`W`, `H`, `w`, `h`) and ASS `\an1`–`\an9` + `\pos(X,Y)` tags without conditional branches.
  - **1:1 Preview-to-Export WYSIWYG Parity**: Exact fitted video frame (`ResizeObserver` + aspect ratio scaling) ensuring custom dragged logo coordinates, subtitle positions, and font sizes match the burned-in FFmpeg output pixel-for-pixel across both landscape (`16:9`) and portrait (`9:16`) videos.
  - **Color Grading Filter Chain (`app/media/pipeline.py`)**: Shared channel-gain equations (`compute_color_channel_gains`) and FFmpeg `eq` + `colorchannelmixer` + `unsharp` filter chain applied to `[0:v]` prior to `[logo]overlay` and `ass` burn-in so brand logos and captions retain their exact colors.
  - **Dynamic Programming Text Wrapping (`app/media/ass_generator.py`)**: Knuth-Plass minimumraggedness DP line breaker (`wrap_caption_balanced_dp`) and `IntervalIndex` (`bisect` $O(\log N)$) subtitle cue overlap detector.
- **Multi-Tier AI Transcription (`app/providers/transcription.py`)**:
  - Tier 1: OpenAI Whisper API (`whisper-1` verbose JSON).
  - Tier 2: Local `Faster-Whisper` neural speech recognition (`WhisperModel` with Silero VAD word timestamps) decoding 16 kHz mono PCM directly via NumPy.
  - Tier 3: Cumulative-sum (`O(N)`) RMS energy envelope detector with dynamic noise-floor hysteresis when offline.
- **Security & Storage (`app/services/storage.py`)**:
  - HMAC-SHA256 signed upload/download tokens, path traversal protection, and explicit `subprocess_exec` argument arrays (`shell=False`).

#### 3. Developer Tooling & Real-World Sample Verification
- Added `justfile` and `./dev.sh` to launch both backend (`:8000`) and frontend (`:5173`) in a single command (`just dev`).
- Verified end-to-end with real portrait (`1080×1920`) sample footage, brand logo, Faster-Whisper transcription (`sample/output_subtitles.srt`), and outro concatenation.
