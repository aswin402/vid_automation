# Changelog

All notable changes to **CelestiaVid — AI Video Automation Studio** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.3] - 2026-11-13

### Added — Master Control Inheritance, Step-by-Step Batch Workflow & Scrollable Output Queue
- **Master Control Studio Panel & Per-Tool Inheritance (`BatchMasterControlPanel.tsx`, `batchSettingsMerge.ts`, `crates/celestiavid-core/src/batch.rs`, `crates/celestiavid-core/src/models.rs`)**:
  - Added shared **Master Control** editing across `Ratio & Face`, `Subtitles`, `Color`, `Audio`, `Logo`, and `Outro` so edits automatically inherit to all linked videos while preserving per-video `Trim` ranges.
  - Added per-tool `overridden_tools` tracking so any individual video can detach into a **Separate Edit** or re-link (`Link to Master` / `Sync All to Master`) without losing edits on other tools.
  - Completed **Master Control Subtitles** with immediate live WYSIWYG subtitle preview & drag-on-frame on Master Control's canvas, `Style | Cues (N)` sub-tabs, live bulk Whisper AI job polling (`Transcribing X/N...`) with two-way cue cache synchronization across Master Control and row cards, `Shadow Depth`, `Snap to Anchor`, and custom `X / Y` placement sliders.
- **Guided `Save & Next` Progression & Dedicated Scrollable Output Column (`BatchStudioPage.tsx`, `BatchOutputColumn.tsx`)**:
  - Replaced top export/re-export menu clutter on editing tabs with a streamlined `Back` and `Save & Next` step bar (`Trim` -> `Ratio & Face` -> `Subtitles` -> `Color` -> `Audio` -> `Logo` -> `Outro` -> `Output`) that auto-flushes Master Control and per-video drafts.
  - Added a dedicated **Output** view (`BatchOutputColumn.tsx`) with sequential **Export All** / **Export Selected** queue rendering, a vertical scrollable column of finished videos with inline playback, and 1-click **Edit Alone** / **Edit Selected** subset re-editing and re-exporting.

### Changed — Default `Clean Voice` Audio & Brand Logo Placement (`schema_version = 2`)
- **Out-of-the-Box Studio & Batch Defaults (`models.rs`, `db.rs`, `batch.rs`, `engine.rs`, `AudioEnhancementStep.tsx`, `LogoStep.tsx`)**:
  - Enabled **Clean Voice** audio enhancement (`noise_reduction: 0.45`, `voice_clarity: 0.35`, `highpass_hz: 95`, `lowpass_hz: 14000`, `volume_db: +1.5`, `-16 LUFS` loudness normalization) and custom **Brand Logo** placement (`Width 26%`, `X 89%`, `Y 68%`, `Opacity 100%`, `Margin 3%`, `Show logo during Outro: Off`) by default across all new single projects, batch Master Controls, and per-video rows.
  - Added automatic SQLite `schema_version = 2` settings migration (`migrate_v2_settings_defaults`) on startup and backup restore so existing untouched v1 records upgrade cleanly.

---

## [0.2.2] - 2026-11-13

### Added — Multi-Video Batch Automation, AI Face Framing, Auto-Updater & Full Screen Floating Studio
- **Batch Campaign Automation Studio (`BatchStudioPage.tsx`, `BatchItemEditorPanel.tsx`, `FolderImportModal.tsx`, `crates/celestiavid-core/src/batch.rs`)**:
  - Multi-video upload and local folder import with single global brand logo & outro binding, flexible row pairing (`N:1:1`, `1:1:1` index-matched, or Cartesian matrix), scrollable stacked row cards (`Row #1`, `Row #2`, ...), 1-click **Inherit Edits** from any row or copy-to-all-selected, and sequential bulk queue or single-row MP4 rendering.
- **Aspect Ratio, Interactive Crop & Local AI Face Framing (`CropFrameStep.tsx`, `cropMath.ts`, `crates/celestiavid-core/src/media/crop.rs`)**:
  - Target aspect-ratio presets (`9:16` Shorts/Reels, `1:1` Square, `4:5` Portrait, `16:9` Widescreen, `4:3`, `21:9`, and Custom) with `crop` (fill frame) and `pad` (letterbox) fit modes, camera zoom, and pan controls.
  - Embedded **UltraFace RFB-320 ONNX (`tract-onnx`)** neural face detector for 100% offline primary-speaker framing with rule-of-thirds headroom and smooth dynamic speaker-tracking keyframes.
- **Full Screen Floating Edit Studio & Clean Player Transport (`InteractiveVideoPreview.tsx`, `popover.tsx`, `tooltip.tsx`)**:
  - Added **Side / Wide View** and **Full Screen (`F`)** controls directly after the Volume button and blocked browser-injected Picture-in-Picture overlays (`disablePictureInPicture`, `disableRemotePlayback`, `pointer-events-none`) across all `<video>` players.
  - Added a glassmorphic **Full Screen Floating Edit HUD** featuring a top 8-tool switcher pill bar (`Trim`, `Ratio & Face`, `Subtitles`, `Color`, `Audio`, `Logo`, `Outro`, `Output`), A/B original compare, and a draggable, Left/Right-dockable, collapsible `Floating Editor` inspector panel with fullscreen-aware Radix tooltips and popovers.
- **In-App Auto-Updater, Data Backup Snapshots & Minimal Terminal TUI Installers (`UpdateModal.tsx`, `crates/celestiavid-core/src/updater.rs`, `install.sh`, `install.ps1`, `install.cmd`)**:
  - Live GitHub Releases version check in the navbar, 1-click animated in-app update pipeline, automatic pre-update SQLite + project metadata backup snapshots, and 1-click backup creation/restore.
  - Redesigned minimal cross-platform TUI installers (`install.sh`, `install.ps1`, `install.cmd`) with clean step indicators, smooth Braille spinners, transfer progress bars, and seamless upgrade detection.

### Changed — Minimal 60–30–10 shadcn/ui Design System
- **Studio UI & Custom Controls (`index.css`, `Navbar.tsx`, `number-input.tsx`, `slider.tsx`, `switch.tsx`, `badge.tsx`)**:
  - Refactored workspace and studio editors to a strict **60% dark canvas / 30% elevated slate surfaces / 10% electric indigo accent** palette with contextual `HintTooltip` hover hints, top navbar studio tool tabs, and custom themed `NumberInput` up/down steppers replacing native browser spinbuttons.

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
