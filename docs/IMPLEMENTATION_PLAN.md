# Implementation Plan
## AI Video Automation Platform

**Version:** 1.0  
**Date:** 2026-11-03

---

## 1. Recommended architecture

Use a modular monolith for the first release, with asynchronous media workers. Avoid microservices until real scaling needs justify the operational complexity.

```text
Browser (Next.js)
   | HTTPS / JSON
   v
FastAPI API ---------------- PostgreSQL
   |                            |
   | signed upload URLs         | projects, jobs, cues
   v                            |
Object Storage (R2/S3)          |
   ^                            |
   |                            |
   +---- Celery Worker <--- Redis Queue
              |
              +---- FFprobe (inspect media)
              +---- Speech-to-text provider
              +---- FFmpeg (trim, overlay, subtitles, concat)
              |
              +---- Object Storage (output)
```

### Main components (`onpkg` stack selection)
- **Frontend (`apps/web` — `react-vite-gsap`):** React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand, TanStack Query v5, React Router v7, shadcn/ui, Framer Motion, Lucide React.
- **API (`apps/api` — `fastapi`):** Python 3.12+, FastAPI, Pydantic v2, SQLAlchemy 2.0 (Async), Alembic, structlog, managed with `uv`.
- **Database:** PostgreSQL (`asyncpg`) with automatic async SQLite (`aiosqlite`) support for zero-dependency local runs and tests.
- **Queue / Workers:** Redis + Celery worker support, paired with an in-process async job runner (`asyncio` worker pool) so local development and automated E2E tests work seamlessly without external daemon setup.
- **Media:** FFmpeg and FFprobe (`libx264`, `aac`, `libass`).
- **Transcription:** Provider interface (`TranscriptionProvider`) with OpenAI Whisper API adapter and local audio-segment speech detector / deterministic fallback.
- **Storage:** Private S3/R2 adapter + local HMAC-signed URL object storage adapter.
- **Deployment:** Docker Compose for full stack (Postgres, Redis, API, Worker, Web) + direct `uv` / `bun` local workflow.

## 2. Key engineering decisions

1. **Trim before transcription.** Extract the requested clip, then transcribe its audio to reduce processing and provider costs.
2. **Use one canonical timeline.** All subtitle cue timestamps are relative to the trimmed clip, beginning at 0 ms.
3. **Render the main segment and outro separately.** Normalize the outro to a common output profile, then concatenate. This makes it possible to apply subtitles/logo only to the main segment.
4. **Use ASS for burned-in styled subtitles.** Keep subtitle cue data in the database as structured records; generate ASS at render time.
5. **Use a provider abstraction.** Do not couple the application to one transcription vendor's response format.
6. **Use background jobs.** API requests create jobs and return immediately.
7. **Persist job stage and progress.** Do not infer completion from the existence of a partially written file.

## 3. Phased delivery plan

The estimates below are planning ranges for a small experienced team, not commitments. They exclude extended procurement, legal review, and unforeseen provider limitations.

### Phase 0 — Discovery and technical spike (3–5 working days)
- Confirm target user, supported formats, maximum file size/duration, output resolution and frame rate.
- Test FFmpeg trim, overlay, ASS subtitles, audio handling, and concat using representative media.
- Compare transcription API output formats, timestamp granularity, language coverage, limits, and cost.
- Decide retention policy and privacy wording.
- Produce a sample end-to-end render.

**Exit criteria:** A local script successfully trims a sample, overlays a logo, burns styled subtitles, appends an outro, and validates the result.

### Phase 1 — Project foundation (4–6 working days)
- Create monorepo or coordinated frontend/backend repositories.
- Configure linting, formatting, type checks, environment configuration, Docker Compose.
- Create PostgreSQL schema and migrations.
- Implement authentication or a clearly isolated temporary development identity.
- Implement project CRUD and ownership checks.
- Create private object storage bucket and signed upload/download flow.
- Add media upload validation and FFprobe metadata extraction.

**Exit criteria:** An authenticated user can create a project and upload source, logo, and outro files securely.

### Phase 2 — Core media pipeline (5–8 working days)
- Implement a media probe service.
- Implement trim validation and timeline conversion.
- Implement main-segment rendering.
- Implement logo overlay with normalized position, size, margin, and opacity.
- Implement outro normalization and concat.
- Add output FFprobe validation.
- Add integration tests with known sample videos.

**Exit criteria:** A job can produce a trimmed, logo-branded video with an outro without AI subtitles.

### Phase 3 — AI subtitle pipeline (5–8 working days)
- Extract audio from the trimmed segment.
- Implement speech-to-text provider interface.
- Integrate chosen transcription provider.
- Normalize provider output into internal subtitle cues.
- Store raw provider response only where necessary and with retention controls.
- Implement cue validation and timeline conversion.
- Add retry and rate-limit handling.

**Exit criteria:** A user can generate editable timestamped subtitle cues for a trimmed clip.

### Phase 4 — Subtitle editor and styling (6–10 working days)
- Build cue list editor.
- Add add/delete/edit cue operations.
- Add timestamp validation and optional preview playback synchronization.
- Add nine-position presets and drag-to-position preview.
- Add typography, color, background, outline, shadow, and safe-area controls.
- Generate ASS file from normalized style and cue data.
- Burn subtitles into main segment only.
- Test long lines, Unicode, punctuation, and supported languages.

**Exit criteria:** Edited subtitle cues and styling appear correctly in exported main segment.

### Phase 5 — Workflow UX and job orchestration (5–8 working days)
- Build guided wizard.
- Add upload progress, trim preview, settings persistence, review page.
- Add job submission and status polling or WebSocket/SSE updates.
- Add cancel/retry behavior where safe.
- Add error messages and job history.
- Add final download and expiry messaging.

**Exit criteria:** A user can complete the workflow end-to-end without using internal tools.

### Phase 6 — Hardening and beta (5–10 working days)
- Security review of uploads and worker isolation.
- Load test worker concurrency and queue behavior.
- Test different codecs, aspect ratios, frame rates, audio layouts, and no-audio cases.
- Add metrics, structured logs, alerts, and cost tracking.
- Add retention cleanup task.
- Run beta with real users and tune defaults.

**Exit criteria:** Release checklist passes and operational ownership is defined.

## 4. Suggested sprint breakdown

| Sprint | Focus | Demonstrable outcome |
|---|---|---|
| 1 | Foundation, auth, database, storage | Secure upload and project record |
| 2 | FFmpeg trim, logo, outro | Branded output without subtitles |
| 3 | Transcription and cue model | Timestamped editable transcript |
| 4 | Subtitle editor and ASS rendering | Styled subtitles in output |
| 5 | Wizard, jobs, status, download | Complete user workflow |
| 6 | Hardening, tests, beta | Release candidate |

## 5. Backend processing sequence

Recommended job stages:

1. `queued`
2. `validating`
3. `probing`
4. `trimming`
5. `transcribing` (if enabled)
6. `awaiting_subtitle_review` (optional interactive workflow before export)
7. `rendering_main`
8. `normalizing_outro` (if enabled)
9. `joining_outro` (if enabled)
10. `validating_output`
11. `uploading_output`
12. `completed`

For a two-step UX, separate **subtitle generation** from **final export**:
- Generate transcript job.
- User edits/approves cues.
- Submit export job using approved cue version.

This prevents the export worker from waiting for a user.

## 6. Environments and deployment

### Local
- Docker Compose: API, frontend, PostgreSQL, Redis, worker.
- FFmpeg installed in worker image.
- Local filesystem storage adapter for development only, or a development object-storage bucket.

### Staging
- Separate database, Redis, storage bucket, and AI credentials.
- Short retention and test-only data.
- Feature flags for provider and rendering changes.

### Production
- HTTPS ingress.
- Private object storage.
- Managed PostgreSQL and Redis where practical.
- Worker containers with CPU/memory/temp-disk limits.
- Autoscale workers based on queue depth and resource use.
- Secrets manager for provider keys.
- Backups and tested restore process.

## 7. Operational considerations

- Use unique work directories per job.
- Use generated filenames and never interpolate user input into shell commands.
- Prefer subprocess argument arrays over shell strings.
- Set process timeouts and resource limits.
- Capture FFmpeg stderr with size limits and redact sensitive paths.
- Make stages idempotent using deterministic artifact keys or stage records.
- Clean temporary artifacts after success/failure.
- Use retry with exponential backoff only for transient errors.
- Do not retry invalid input or deterministic rendering errors endlessly.
- Track AI transcription duration and estimated cost per project.

## 8. Delivery definition of done

A feature is done only when:
- API and UI behavior are implemented.
- Authorization and validation are implemented.
- Unit and integration tests are added.
- Failure states are handled.
- Logs/metrics are sufficient to debug it.
- User-facing copy is clear.
- Documentation and environment variables are updated.
- No secrets or user media are committed to source control.
