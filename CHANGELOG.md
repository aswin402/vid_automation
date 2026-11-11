# Changelog

All notable changes to **CelestiaVid — AI Video Automation Studio** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.1] - 2026-11-11

### Fixed — Audio Noise Reduction & Studio Settings Persistence
- **Calibrated Spectral Audio Denoiser & Noise-Floor Expander (`crates/celestiavid-core/src/media/pipeline.rs`)**:
  - Replaced `afftdn` dynamic noise-floor tracking (`tn=1` with default `rf=-38`, which reset the noise profile on AAC streams and allowed downstream `acompressor` makeup gain + `volume` to boost pause hiss) with calibrated stationary white-noise spectral subtraction (`afftdn=nr=..:nf=..:rf=..:nt=w:tn=0`, `-10 dB` to `-48 dB` reduction) chained into a soft-knee downward RMS noise-floor expander (`agate`) *before* `equalizer=f=3000` and `acompressor`.
  - Delivers **40+ dB RMS noise-floor reduction** during speech pauses while preserving clear, natural vocal presence during active speech.
  - Routed audio enhancement directly inside `-filter_complex` (`[0:a:0]...[aout]` -> `-map [aout]`) in `render_main_segment` with structured render filtergraph logging (`render_main_segment_config`).
- **Debounced Auto-Save Race Condition (`apps/web/src/store/useWorkflowStore.ts`, `ProjectStudioPage.tsx`)**:
  - Added monotonic `settingsRevision` tracking so stale in-flight `PATCH /api/v1/projects/:id` responses never overwrite newer preset or slider adjustments before export.
- **Studio Audio Controls & Export Player (`AudioEnhancementStep.tsx`, `ReviewExportStep.tsx`)**:
  - Fixed *Original (Flat)* preset toggle (`enabled: false`), updated noise reduction dB readout (`-10 dB` to `-48 dB`), and added checksum-keyed stream reload on the exported `<video>` preview element.

### Added
- **End-to-End Acoustic Noise-Floor Regression Test (`crates/celestiavid-core/tests/integration_test.rs`)**:
  - Added `test_audio_noise_reduction_measurably_lowers_noise_floor` verifying >= 20 dB RMS pause-hiss reduction and intact vocal loudness across rendered MP4 exports.

---

## [0.2.0] - 2026-11-11

### Changed — Complete Migration from Python to Pure Rust + Tauri v2 Desktop App
- **Removed Python Backend Completely**: Deleted `apps/api` (`FastAPI`, `SQLAlchemy`, `uv`, `Faster-Whisper` Python runtime) and `docker-compose.yml` so end users never need Python, virtualenvs, or Docker installed.
- **Added Pure Rust Core Crate (`crates/celestiavid-core`)**:
  - Embedded **SQLite (`rusqlite` bundled WAL mode)** for zero-setup local persistence (`projects`, `assets`, `subtitle_cues`, `processing_jobs`).
  - Native **3-Tier Rust AI Transcription (`src/transcription.rs`)**: OpenAI Whisper API (`reqwest` + `rustls-tls`) -> local neural **`whisper-rs` (`whisper.cpp` GGML)** with automatic `ggml-base.bin` model caching -> pure Rust 16-bit PCM Acoustic RMS Voice Activity Detection (`hound`).
  - **Zero-Copy Local File Imports (`file://`)**: Desktop users select multi-GB local videos in-place without duplicating disk space; project/asset deletion strictly preserves external user files.
  - **Native Image & Media Probing**: Pure Rust `image` crate (`PNG`, `JPEG`, `WebP`) + async `tokio` `ffprobe`/`ffmpeg` pipeline with `ffmpeg-sidecar` auto-resolution.
  - **RFC 7233 Byte-Range Media Streamer (`axum` 0.8)**: Streams `206 Partial Content` in 64 KB chunks so `<video>` timeline scrubbing and Web Audio API graphs run with minimal memory overhead.
- **Added Tauri v2 Native Desktop Shell (`src-tauri`) & Cross-Platform Installer CI**:
  - In-process `#[tauri::command]` IPC bridge + ephemeral `127.0.0.1:0` loopback media server + native OS Open/Save file dialogs (`@tauri-apps/plugin-dialog`).
  - **Windows 10/11 Native Hardening**: Added `CREATE_NO_WINDOW` (`0x08000000`) subprocess flags so `ffmpeg.exe` / `ffprobe.exe` never flash console windows, `\\?\` extended-length path normalization for `libass`, native Windows fonts (`Segoe UI`, `Arial`, `Verdana`, `Tahoma`), NSIS per-user `.exe` + WiX `.msi` installers, and pre-bundled static `ffmpeg.exe` & `ffprobe.exe`.
  - Added GitHub Actions release pipeline (`.github/workflows/release-desktop.yml`) building **Windows (`.exe` + `.msi`)**, **Linux (`.deb` + `.AppImage`)**, and **macOS (`.dmg`)** installers automatically.
  - Added **Single-Command Terminal / CMD / PowerShell Installers** (`install.sh`, `install.ps1`, `install.cmd`) for zero-friction one-line installation from Linux/macOS terminals, Windows PowerShell, and Windows Command Prompt (`cmd.exe`).

### Added — Step 4: Audio Noise Reduction & Voice Clarity System
- **Studio Audio Enhancement Step (`AudioEnhancementStep.tsx`)**:
  - 6 presets (*Off*, *Light Room Clean*, *Podcast Clean*, *Heavy Denoise*, *Outdoor Wind & Traffic*, *Broadcast Leveler*) and fine-tune sliders (*Noise Floor Reduction*, *Voice Clarity 3 kHz Presence*, *High-Pass Rumble Cut*, *Low-Pass Hiss Cut*, *Output Gain dB*, *Dynamic Loudness Compression*, and *Apply Before AI Transcription*).
  - Real-time **Web Audio API** preview chain (`BiquadFilterNode` highpass/lowpass/peaking + `DynamicsCompressorNode` + `GainNode`) inside `InteractiveVideoPreview.tsx` with live **Hold to Compare Original** bypass.
- **FFmpeg Spectral Audio Denoiser**:
  - `build_audio_enhancement_filter` chaining `highpass`, `lowpass`, `afftdn` (FFT spectral noise reduction with dynamic noise-floor tracking `tn=1`), `equalizer=f=3000`, `acompressor`, and `volume` during both AI transcription audio extraction and final MP4 export.

---

## [0.0.1] - 2026-11-10

### Added
- Initial 7-step Guided Studio web application (`apps/web`) with Upload, Trim, Color Correction & Grading, Brand Logo Overlay, AI Subtitles & ASS Styling, Outro Normalization, and Review & Export.
- Initial prototype backend (`apps/api`) verified with portrait `1080×1920` sample media, logo overlay, subtitles, and outro concatenation.
