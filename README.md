# CelestiaVid — Native Desktop AI Video Studio (`v0.2.2`)

Single-binary **Tauri v2 + Pure Native Rust** desktop studio and asynchronous FFmpeg media pipeline that transforms raw local videos into finished, color-graded, noise-cleaned, logo-branded, AI-subtitled MP4 videos — with **zero Python runtime dependencies**.

---

## ✨ Key Features

1. **8-Step Guided Studio Workflow**
   - **1. Import / Upload Assets**: Zero-copy native OS file picker (`file://` in-place inspection without copying multi-GB 4K clips) or drag-and-drop for source videos (`MP4`, `MOV`, `WebM`, `MKV`, `M4V`), transparent brand logos (`PNG`, `WebP`, `JPEG`), and brand outro clips with instant `FFprobe` / Rust `image` stream verification.
   - **2. Trim Clip**: Frame-accurate start/end range trimming (`MM:SS.mmm`) with interactive timeline handles and `-0.5s / +0.5s` nudge controls.
   - **3. Color Grade (Optional)**: Real-time color correction & grading with 7 look presets (*Neutral*, *Natural Boost*, *Warm Cinema*, *Cool Studio*, *Punchy Pop*, *Vintage Matte*, *B&W Noir*), 7 fine-tune sliders (*Brightness*, *Contrast*, *Saturation*, *Gamma*, *Temperature*, *Tint*, *Sharpness*), **Hold to Compare**, and **Apply to Outro**.
   - **4. Audio Clean & Noise Reduction (Optional)**: Calibrated spectral FFT background noise reduction (`afftdn`) + soft-knee downward RMS noise-floor expander (`agate`), low-cut rumble filter (`highpass`), hiss roll-off (`lowpass`), 3 kHz vocal presence boost (`equalizer`), dynamic speech leveling (`acompressor`), output gain (`volume`), **Hold to Compare Original**, and **Pre-clean Audio Before AI Transcription**.
   - **5. Brand Logo (Optional)**: 9-point anchor grid or freeform drag-and-drop placement on the video canvas with normalized width and opacity controls.
   - **6. AI Subtitles (Optional)**: Native Rust 3-tier transcription (`whisper-rs` / `whisper.cpp` local GGML neural inference, OpenAI Whisper API, or pure Rust `hound` PCM Acoustic RMS VAD), interactive cue editor with overlap validation, native `.srt` Save dialog, and rich ASS styling.
   - **7. Outro Clip (Optional)**: Automatically normalizes resolution, FPS, pixel aspect ratio, pixel format (`yuv420p`), and stereo audio (`48 kHz`) before seamless concatenation.
   - **8. Review & Export**: Asynchronous Rust + FFmpeg rendering with live 10-stage job progress, cancel/retry support, native OS Save dialog, and post-render `FFprobe` verification.

2. **1:1 WYSIWYG Preview-to-Export Parity**
   - Shared 2D affine coordinate math, RGB channel-gain matrices, and Web Audio API biquad/compressor live preview matching the Rust FFmpeg filtergraph (`eq`, `colorchannelmixer`, `unsharp`, `highpass`, `lowpass`, `afftdn`, `equalizer`, `acompressor`, `overlay`, `ass`).
   - Ephemeral loopback HTTP `206 Partial Content` byte-range streamer (`axum`) inside Tauri Desktop so `<video crossOrigin="anonymous">` scrubbing and Web Audio API work seamlessly across Linux WebKitGTK, macOS WKWebView, and Windows WebView2.

---

## 🏗️ Pure Rust + Tauri v2 Architecture

- **Core Media & Persistence Crate (`crates/celestiavid-core`)**
  - **Persistence**: Embedded `rusqlite` (`bundled` SQLite in `WAL` mode) — zero external database server.
  - **AI Speech-to-Text**: `whisper-rs` (`whisper.cpp` C++/GGML bindings) + `hound` 16-bit PCM WAV Acoustic VAD + optional `reqwest` (`rustls-tls`) OpenAI Whisper API.
  - **Media & Image Inspection**: Native Rust `image` crate (PNG/JPEG/WebP header & dimension validation) + async `tokio::process::Command` (`ffmpeg` / `ffprobe` + automatic `ffmpeg-sidecar` fallback).
  - **Streaming Server**: `axum` 0.8 with RFC 7233 `Range: bytes=start-end` (`206 Partial Content`) 64 KB chunk streaming and HMAC-SHA256 signed URLs.
- **Native Desktop Shell (`src-tauri`)**
  - **Tauri v2** (`tauri`, `tauri-plugin-dialog`) embedding `celestiavid-core` directly in-process via `#[tauri::command]` IPC + native OS Open/Save file dialogs.
  - Produces single installable native packages: `.AppImage` / `.deb` / `.rpm` (Linux), `.msi` / `.exe` (Windows), and `.dmg` / `.app` (macOS).
- **Studio Frontend (`apps/web` — `onpkg` stack: `react-vite-gsap`)**
  - React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand, TanStack Query v5, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`.

---

## 🚀 Quick Start

### 1. Single-Command Terminal / CMD Install (Recommended)

- **Linux & macOS Terminal (`bash` / `zsh`)**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/aswin402/vid_automation/main/install.sh | bash
  ```
  *(Automatically installs `.deb` on Ubuntu/Debian, `.AppImage` to `~/.local/bin/celestiavid` on other Linux distros, or `.dmg` to `/Applications/CelestiaVid.app` on macOS.)*

- **Windows PowerShell**:
  ```powershell
  irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex
  ```

- **Windows Command Prompt (`cmd.exe`)**:
  ```cmd
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
  ```
  *(Silently downloads & installs the per-user NSIS setup with `ffmpeg.exe` & `ffprobe.exe` pre-bundled — no Admin prompt required — and registers `CelestiaVid` in your Start Menu and User `PATH`.)*

### 2. Direct Download — Prebuilt Desktop Installers (Windows, Linux, macOS)
Every tagged release (`v0.2.0+`) automatically builds standalone desktop installers via [`.github/workflows/release-desktop.yml`](.github/workflows/release-desktop.yml) and publishes them on [**GitHub Releases**](https://github.com/aswin402/vid_automation/releases):
- **Windows 10 / 11 (x64)**: `CelestiaVid_0.2.2_x64-setup.exe` (NSIS per-user installer — no Admin required) & `CelestiaVid_0.2.2_x64_en-US.msi` — **includes `ffmpeg.exe` & `ffprobe.exe` pre-bundled out of the box!**
- **Linux (x64)**: `CelestiaVid_0.2.2_amd64.deb` & `CelestiaVid_0.2.2_amd64.AppImage` (with static `ffmpeg` & `ffprobe` bundled)
- **macOS (Apple Silicon)**: `CelestiaVid_0.2.2_aarch64.dmg`

### Build From Source — Prerequisites
- **Rust** (`rustup`, `cargo` 1.80+), **CMake**, **Clang** (`libclang` for `whisper-rs`)
- **Bun** (`bun` 1.1+)
- **FFmpeg & FFprobe** (auto-detected from system `PATH`, bundled sidecar, or auto-downloaded via `ffmpeg-sidecar`)
- *(Linux Desktop Window / Installer build only)* WebKit2GTK dev headers:
  ```bash
  just install-linux-deps
  # Equivalent to:
  # sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```

### Option A: Launch Native Desktop App (Tauri v2 Window)
```bash
just desktop
# or:
./dev.sh --desktop
```

### Option B: Build Single-File Desktop Installer (`.deb`, `.AppImage`, `.msi`, `.dmg`)
```bash
just build-desktop
```

### Option C: Launch Local Browser Studio (Pure Rust Engine `:8000` + Vite `:5173`)
Works out-of-the-box even on headless Linux machines without GTK headers:
```bash
just dev
# or:
./dev.sh
```

---

## 🧪 Automated Verification

```bash
# Run Pure Rust unit + end-to-end FFmpeg/STT/Range-Streaming integration tests & TypeScript checks
just test
```

---

## 📂 Documentation (`docs/`)

- [`docs/PRD.md`](docs/PRD.md) — Product Requirements Document
- [`docs/DESIGN.md`](docs/DESIGN.md) — UI/UX design system & studio layout specification
- [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md) — Media filtergraphs & architecture specification
- [`CHANGELOG.md`](CHANGELOG.md) — Release history (`v0.2.2`, `v0.2.1`, `v0.2.0`, `v0.0.1`)
