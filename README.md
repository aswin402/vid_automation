# CelestiaVid — AI Video Automation Platform (`v0.0.1`)

Guided Studio web application and asynchronous FFmpeg media pipeline that transforms raw source videos into finished, color-graded, branded, AI-subtitled MP4 videos with an optional normalized outro.

---

## ✨ Key Features

1. **7-Step Guided Studio Workflow**
   - **1. Upload Assets**: Upload source video (`MP4`, `MOV`, `WebM`, `M4V`), transparent brand logo (`PNG`, `WebP`, `SVG`), and brand outro clip with instant `FFprobe` stream inspection.
   - **2. Trim Clip**: Frame-accurate start/end range trimming (`MM:SS.mmm`) with interactive timeline handles and `-0.5s / +0.5s` nudge controls.
   - **3. Color Grade (Optional)**: Real-time color correction & grading with 7 look presets (*Neutral*, *Natural Boost*, *Warm Cinema*, *Cool Studio*, *Punchy Pop*, *Vintage Matte*, *B&W Noir*), 7 fine-tune sliders (*Brightness*, *Contrast*, *Saturation*, *Gamma*, *Temperature*, *Tint*, *Sharpness*), **Hold to Compare**, and **Apply to Outro**.
   - **4. Brand Logo (Optional)**: 9-point anchor grid or freeform drag-and-drop placement on the video canvas with normalized width and opacity controls.
   - **5. AI Subtitles (Optional)**: Automatic speech-to-text transcription (`Faster-Whisper` local neural ASR or OpenAI Whisper API), interactive cue editor with overlap validation, `.srt` download, and rich ASS styling.
   - **6. Outro Clip (Optional)**: Automatically normalizes resolution, FPS, pixel aspect ratio, pixel format (`yuv420p`), and stereo audio (`48 kHz`) before seamless concatenation.
   - **7. Review & Export**: Asynchronous FFmpeg rendering with live 10-stage job progress, cancel/retry support, and post-render `FFprobe` verification.

2. **1:1 WYSIWYG Preview-to-Export Parity**
   - Shared 2D affine coordinate math and RGB channel-gain equations between the React Studio canvas (`ResizeObserver` + inline SVG `<feColorMatrix>` / `<feComponentTransfer>` / `<feConvolveMatrix>` filters) and the backend FFmpeg filtergraph (`eq`, `colorchannelmixer`, `unsharp`, `overlay`, `ass`).
   - Color grading is applied strictly to the video stream `[0:v]` *before* overlaying `[logo]` and burning in `ass` subtitles so your brand logo and captions never shift color.

---

## 🏗️ Architecture & Stack

- **Frontend (`apps/web` — `onpkg` stack: `react-vite-gsap`)**
  - React 19, Vite 8, TypeScript, Tailwind CSS v4, Radix UI, Lucide Icons
  - Zustand (`useWorkflowStore`) for dirty-tracked studio state & 450ms auto-save
  - TanStack Query v5 for server synchronization & real-time job stage polling
- **Backend (`apps/api` — `onpkg` stack: `fastapi`)**
  - FastAPI, Pydantic v2, SQLAlchemy 2.0 (Async SQLite / PostgreSQL), Alembic, `structlog`, managed via `uv`
  - FFprobe inspection (`app/media/probe.py`) & FFmpeg execution (`app/media/pipeline.py`)
  - 2D Affine Geometry Engine (`app/media/geometry.py`) & ASS Subtitle Compiler (`app/media/ass_generator.py`)
  - Pluggable `TranscriptionProvider` (`OpenAIWhisperProvider` + local neural `Faster-Whisper` + RMS energy fallback)

---

## 📂 Documentation (`docs/`)

All architectural and product specifications are organized in [`docs/`](docs/):

- [`docs/PRD.md`](docs/PRD.md) — Product Requirements Document & user stories
- [`docs/DESIGN.md`](docs/DESIGN.md) — UI/UX design system & studio layout specification
- [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md) — Backend architecture, FFmpeg filtergraphs, and API specification
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — Phased engineering implementation plan
- [`docs/TODO.md`](docs/TODO.md) — Completed engineering checklist
- [`CHANGELOG.md`](CHANGELOG.md) — Release history (`v0.0.1`)

---

## 🚀 Quick Start (Single Command)

Ensure `ffmpeg`, `ffprobe`, [`uv`](https://docs.astral.sh/uv/), and [`bun`](https://bun.sh/) are installed on your system.

Run both the FastAPI backend (`http://localhost:8000`) and React + Vite Studio UI (`http://localhost:5173`) together with a single command:

```bash
just dev
# or directly:
./dev.sh
```

Press `Ctrl+C` to stop both servers cleanly.

### Available `just` Commands

| Command | Description |
| :--- | :--- |
| `just setup` | Install/sync both Python (`uv`) and Frontend (`bun`) dependencies |
| `just dev` | Start both FastAPI (`:8000`) and Vite Studio UI (`:5173`) together |
| `just dev-api` | Run only the FastAPI backend server |
| `just dev-web` | Run only the React + Vite frontend server |
| `just test` | Run backend unit/E2E FFmpeg pipeline tests and frontend TypeScript checks |

---

## 🧪 Running Automated Tests

```bash
# Run backend unit & end-to-end FFmpeg media pipeline tests
uv run --directory apps/api pytest -v

# Run frontend TypeScript compiler verification
./apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.app.json --noEmit
```
