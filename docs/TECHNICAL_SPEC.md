# Technical Specification
## AI Video Automation Platform

**Version:** 1.0  
**Date:** 2026-11-03  
**Status:** Proposed MVP design

---

## 1. System overview

The system consists of a browser client (`react-vite-gsap` stack), REST API (`fastapi` stack), SQL database (PostgreSQL in production / async SQLite fallback in local dev), object storage (S3/R2 or local signed-URL storage), asynchronous background worker system (Celery/Redis + async local task runner), FFmpeg/FFprobe, and a pluggable speech-to-text provider.

### Selected `onpkg` Stack
- **Frontend (`apps/web` — `onpkg` stack: `react-vite-gsap`):**
  - React 19 + TypeScript + Vite 8
  - Tailwind CSS v4 + shadcn/ui + Radix UI + Lucide Icons
  - TanStack Query v5 (server state, project/asset queries, real-time job polling)
  - Zustand v5 (guided workflow state, interactive preview state)
  - React Router v7 + Axios + Framer Motion
- **Backend (`apps/api` — `onpkg` stack: `fastapi`):**
  - Python 3.12+ + FastAPI + Pydantic v2 + `pydantic-settings`
  - SQLAlchemy 2.0 (Async) + Alembic migrations (`asyncpg` for PostgreSQL, `aiosqlite` for zero-config local dev)
  - `structlog` structured JSON logging + request tracing middleware
  - Asynchronous job execution (Celery + Redis queue with built-in async worker pool fallback)
  - Media engine: FFmpeg 8 + FFprobe (`libx264`, `aac`, `libass` subtitle filter, `overlay`, `scale`, `pad`, `concat`)

### Responsibilities
- **Frontend:** Project workflow, upload, trim controls, subtitle review, style controls, status, download.
- **API:** Authentication/owner-scoping, validation, project/job management, signed URLs, subtitle CRUD.
- **Database:** User, project, asset, job, subtitle cue, and style metadata.
- **Object storage:** Source media, logo, outro, intermediate artifacts where needed, and final outputs.
- **Worker:** Media probing, trimming, transcription, rendering, normalization, concatenation, validation.
- **AI provider:** Audio transcription and timestamps (OpenAI Whisper API adapter + local speech-energy/whisper fallback).

## 2. Repository layout

```text
vid_automation/
  apps/
    web/                  # onpkg stack: react-vite-gsap (React 19 + Vite 8 + Tailwind 4 + Zustand + TanStack Query)
      src/
        api/
        components/
        features/
        hooks/
        layouts/
        lib/
        pages/
        providers/
        store/
        types/
      onpkg.json
      onpkg_docs/
      package.json
      vite.config.ts
    api/                  # onpkg stack: fastapi (FastAPI + SQLAlchemy Async + Alembic + Pydantic v2 + structlog)
      app/
        main.py
        core/
        db/
        exceptions/
        middleware/
        models/
        schemas/
        routes/
        services/
        workers/
        media/
        providers/
      alembic/
      tests/
      onpkg.json
      onpkg_docs/
      pyproject.toml
      justfile
  docker-compose.yml
  PRD.md
  IMPLEMENTATION_PLAN.md
  TODO.md
  DESIGN.md
  TECHNICAL_SPEC.md
```

## 3. Core data model

### User
- `id` UUID primary key
- `email` unique
- `password_hash` or external identity reference
- `created_at`, `updated_at`

### Project
- `id` UUID primary key
- `owner_id` UUID foreign key
- `name` text
- `status` text: `draft`, `processing`, `completed`, `failed`
- `created_at`, `updated_at`

### Asset
- `id` UUID primary key
- `project_id` UUID foreign key
- `kind` enum: `source`, `logo`, `outro`, `trimmed`, `main_render`, `output`, `transcript_audio`
- `storage_key` text
- `original_filename` text (display only; never used as path)
- `mime_type` text
- `size_bytes` bigint
- `duration_ms` bigint nullable
- `width`, `height` integer nullable
- `video_codec`, `audio_codec`, `frame_rate` text nullable
- `checksum` text nullable
- `created_at`

### ProcessingJob
- `id` UUID primary key
- `project_id` UUID foreign key
- `kind` enum: `transcribe`, `export`
- `status` enum: `queued`, `validating`, `probing`, `trimming`, `transcribing`, `rendering_main`, `normalizing_outro`, `joining_outro`, `validating_output`, `uploading_output`, `completed`, `failed`, `canceled`
- `stage` text
- `progress` numeric nullable (only when meaningful)
- `error_code` text nullable
- `error_message_safe` text nullable
- `attempt_count` integer
- `idempotency_key` text nullable
- `started_at`, `finished_at`, `created_at`, `updated_at`

### EditSettings (JSON or normalized tables)
Recommended versioned JSON document:
- `schema_version`
- `trim.start_ms`
- `trim.end_ms`
- `output.width`
- `output.height`
- `output.fps`
- `output.video_codec`
- `output.audio_codec`
- `logo.enabled`
- `logo.asset_id`
- `logo.position` (preset or normalized coordinates)
- `logo.width_ratio`
- `logo.opacity`
- `logo.margin_ratio`
- `subtitles.enabled`
- `subtitles.language`
- `subtitles.style`
- `outro.enabled`
- `outro.asset_id`
- `audio_policy`

### SubtitleCue
- `id` UUID primary key
- `project_id` UUID foreign key
- `version` integer
- `sequence` integer
- `start_ms` integer
- `end_ms` integer
- `text` text
- `words_json` JSON nullable
- `created_at`, `updated_at`

Use cue versioning so the export job references an immutable approved subtitle version.

## 4. API outline

All routes should be authenticated and owner-scoped.

### Projects
- `POST /api/v1/projects` — create project.
- `GET /api/v1/projects` — list current user's projects.
- `GET /api/v1/projects/{project_id}` — project details.
- `PATCH /api/v1/projects/{project_id}` — update name/settings.
- `DELETE /api/v1/projects/{project_id}` — request project and asset deletion.

### Uploads and assets
- `POST /api/v1/projects/{project_id}/assets/upload-url` — create signed upload URL.
- `POST /api/v1/projects/{project_id}/assets/complete` — verify upload and probe media.
- `GET /api/v1/assets/{asset_id}` — asset metadata.
- `DELETE /api/v1/assets/{asset_id}` — delete eligible asset.

Suggested upload request:
```json
{
  "kind": "source",
  "filename": "recording.mp4",
  "content_type": "video/mp4",
  "size_bytes": 12345678
}
```

The server returns an asset ID, storage key, signed upload URL, and required headers. The client uploads directly to storage, then calls completion. The API must verify that the object exists and matches expected size before marking it ready.

### Transcription and subtitles
- `POST /api/v1/projects/{project_id}/transcriptions` — enqueue transcription for current trim settings.
- `GET /api/v1/jobs/{job_id}` — status.
- `GET /api/v1/projects/{project_id}/subtitle-versions/{version}` — retrieve cues.
- `PUT /api/v1/projects/{project_id}/subtitle-versions/{version}` — save edited cue set as a new version.
- `POST /api/v1/projects/{project_id}/subtitle-versions` — create/import cue version if supported.

### Export
- `POST /api/v1/projects/{project_id}/exports` — submit export using a settings snapshot and approved subtitle version.
- `GET /api/v1/jobs/{job_id}` — status and safe error.
- `GET /api/v1/projects/{project_id}/outputs` — list completed outputs.
- `POST /api/v1/assets/{asset_id}/download-url` — create short-lived signed download URL.

### Job status response
```json
{
  "id": "uuid",
  "kind": "export",
  "status": "rendering_main",
  "stage": "rendering_main",
  "progress": null,
  "error": null,
  "created_at": "2026-11-03T10:00:00Z",
  "updated_at": "2026-11-03T10:01:00Z"
}
```

Do not report an arbitrary percentage if the worker cannot measure progress reliably. Stage-based progress is acceptable.

## 5. Internal subtitle cue contract

All timestamps are integer milliseconds relative to the beginning of the trimmed clip.

```json
{
  "language": "en",
  "timebase": "trimmed_clip",
  "duration_ms": 254000,
  "cues": [
    {
      "sequence": 1,
      "start_ms": 1000,
      "end_ms": 2800,
      "text": "Hello everyone."
    }
  ]
}
```

Validation:
- `start_ms >= 0`
- `end_ms > start_ms`
- `end_ms <= trimmed_duration_ms`
- Sequence is chronological.
- Maximum cue text length and line count are bounded.
- Normalize whitespace and control characters.
- Escape text safely when generating subtitle formats.

If the transcription provider returns timestamps relative to the full source, convert them to trimmed-clip time by subtracting the trim start. Prefer transcribing the extracted trimmed clip so provider timestamps already begin near zero.

## 6. Media pipeline specification

### Step 1: Probe
Use FFprobe to obtain:
- Duration
- Video stream count
- Audio stream count
- Width/height
- Average and nominal frame rate
- Codec and pixel format
- Sample rate and channel layout

Reject or explicitly handle media outside the supported profile.

### Step 2: Trim
Render the requested source interval to an intermediate main clip. For frame-accurate results, re-encode rather than relying on stream-copy seeking. Use a consistent output profile.

Conceptual command:
```bash
ffmpeg -i source.mp4 -ss 12.500 -t 180.000 \
  -map 0:v:0 -map 0:a? \
  -c:v libx264 -preset medium -crf 20 \
  -c:a aac -b:a 192k \
  -movflags +faststart trimmed.mp4
```

Implementation notes:
- Use subprocess argument arrays, not shell interpolation.
- Calculate duration as `end_ms - start_ms`.
- Validate output duration and stream presence.
- Decide how rotation metadata is applied; normalize orientation before overlay.
- Handle files without audio using optional audio mapping.

### Step 3: Transcribe
- Extract or submit audio from the trimmed clip.
- Call the provider adapter.
- Normalize segments into internal cue contract.
- Store cue version.
- Keep provider raw output only if needed for debugging and within retention/privacy rules.

Provider interface example:
```python
class TranscriptionProvider:
    def transcribe(self, audio_path: str, language: str | None) -> "Transcript":
        ...
```

### Step 4: Generate ASS subtitles
Generate ASS from the approved cue version and style configuration. ASS provides alignment, margins, font styling, outline, shadow, and positioning.

Use a server-installed font allowlist. Do not permit arbitrary filesystem paths from the user.

Position presets map to ASS alignment values:
- Top-left: 7
- Top-center: 8
- Top-right: 9
- Middle-left: 4
- Center: 5
- Middle-right: 6
- Bottom-left: 1
- Bottom-center: 2
- Bottom-right: 3

For arbitrary drag placement, use ASS `\pos(x,y)` or equivalent style/event positioning. Convert normalized browser coordinates into final output pixel coordinates. Test with the chosen libass/FFmpeg build.

### Step 5: Logo overlay and main render
Apply logo to the trimmed main segment. Scale while preserving aspect ratio and position using output dimensions. Apply subtitle burn-in to the main segment only.

Conceptual filter graph:
```text
[1:v]scale=logo_width:-1,format=rgba,colorchannelmixer=aa=opacity[logo];
[0:v][logo]overlay=x:y[branded];
[branded]ass=subtitles.ass[main]
```

Exact filter graph must be built with validated numeric parameters and escaped file paths. In production, use generated temporary paths and robust filter-script handling.

### Step 6: Normalize outro
Normalize outro to match the main segment:
- Width and height
- Frame rate
- Pixel format
- Video codec/profile
- Audio sample rate and channel layout
- Time base / stream parameters

Define whether to letterbox, crop, or scale-to-fit. Recommended default: scale-to-fit with padding to avoid cropping important content.

### Step 7: Concatenate
Concatenate normalized main render and normalized outro. If audio stream presence differs, create compatible audio streams (e.g., silence where necessary) before concat, or use a filter-based concat with explicit audio/video handling.

MVP audio policy:
- Main clip audio plays first.
- Outro audio plays after it.
- No crossfade.
- If either segment has no audio, preserve valid output by adding silence as needed.

### Step 8: Validate and publish
- Run FFprobe on final output.
- Verify video stream exists and duration is plausible.
- Verify audio stream according to policy.
- Optionally decode the entire output to detect corruption.
- Upload final output to private object storage.
- Mark job completed only after upload and validation.
- Generate download URL on demand.

## 7. Output profile

Recommended initial default (confirm during discovery):
- Container: MP4
- Video: H.264
- Audio: AAC
- Pixel format: yuv420p
- Fast-start metadata: enabled
- Resolution: preserve source dimensions up to configured maximum, or user-selected preset
- Frame rate: preserve source frame rate or normalize to a selected standard
- Quality: CRF-based encoding with a preset selected for worker capacity

Avoid promising a fixed output size because content, resolution, frame rate, and encoding settings affect it.

## 8. Error taxonomy

Suggested safe error codes:
- `UPLOAD_TOO_LARGE`
- `UNSUPPORTED_MEDIA`
- `MEDIA_PROBE_FAILED`
- `INVALID_TRIM_RANGE`
- `TRANSCRIPTION_PROVIDER_ERROR`
- `TRANSCRIPTION_LIMIT_EXCEEDED`
- `SUBTITLE_VALIDATION_FAILED`
- `RENDER_FAILED`
- `OUTRO_NORMALIZATION_FAILED`
- `CONCAT_FAILED`
- `OUTPUT_VALIDATION_FAILED`
- `STORAGE_UPLOAD_FAILED`
- `JOB_CANCELED`

Store detailed internal diagnostics separately from user-facing messages.

## 9. Testing strategy

### Unit tests
- Trim range validation.
- Millisecond/timecode conversion.
- Subtitle cue ordering and bounds.
- ASS escaping and style generation.
- Normalized coordinate conversion.
- Job state transitions.
- Storage key generation and ownership checks.

### Integration tests
- Upload → probe.
- Trim → output validation.
- Logo overlay → pixel/position sanity check.
- Subtitle burn-in → expected subtitle visible at cue time.
- Outro normalize → concat → duration and stream validation.
- No-audio and mismatched-audio cases.
- Transcription adapter with mocked provider responses.

### End-to-end tests
- Create project.
- Upload assets.
- Configure trim/logo/subtitles/outro.
- Generate and edit subtitles.
- Export.
- Download and verify output.

Use synthetic or licensed test media. Avoid committing user-uploaded media to the repository.

## 10. Configuration

Example environment variables (names only; values belong in secrets):
```env
DATABASE_URL=
REDIS_URL=
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ACCESS_KEY_ID=
OBJECT_STORAGE_SECRET_ACCESS_KEY=
OBJECT_STORAGE_REGION=
AI_TRANSCRIPTION_API_KEY=
SIGNED_URL_TTL_SECONDS=900
MAX_UPLOAD_BYTES=
MAX_SOURCE_DURATION_SECONDS=
WORKER_TEMP_DIR=
```

## 11. Security requirements

- Never construct shell commands by concatenating user-provided strings.
- Use subprocess argument lists and controlled filter scripts.
- Restrict FFmpeg protocol access where possible.
- Run as non-root in an isolated worker.
- Apply CPU, memory, disk, process, and wall-clock limits.
- Keep object storage private.
- Authorize every project, asset, job, and download by owner.
- Use short-lived signed URLs.
- Scan or validate uploads according to the threat model.
- Keep dependencies patched.
- Apply per-user quotas and rate limits.
- Do not expose raw provider errors or internal paths.
- Define deletion and retention behavior for all media and transcript data.

## 12. Open technical decisions

Resolve these before production:
1. Exact upload size and duration limits.
2. Supported input containers/codecs.
3. Output resolution and frame-rate policy.
4. Whether subtitle word-level timing is required for MVP.
5. Transcription provider and supported language list.
6. Whether the provider retains submitted audio and under what terms.
7. Logo behavior on outro.
8. Audio normalization/loudness policy.
9. Whether users can download SRT files.
10. Retention period and user deletion guarantees.
