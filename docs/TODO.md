# Product Development TODO
## AI Video Automation Platform

Use this as the implementation checklist. Mark items complete only after tests pass.

---

## 0. Product decisions
- [x] Confirm primary target user and first use case.
- [x] Decide whether login is required for MVP (isolated per-user header identity + owner-scoped DB queries).
- [x] Set source video maximum size (500 MB) and duration (30 minutes).
- [x] Set supported source/outro formats and codecs (MP4, MOV, WebM; PNG, JPEG, WebP logos).
- [x] Set output resolution, frame rate, codec, and container defaults (MP4 H.264 / AAC / yuv420p + faststart).
- [x] Decide whether logo is applied to the outro (default: main segment only, explicitly disclosed in UI).
- [x] Decide audio behavior for main clip and outro (sequential preserve; automatic silent stereo stream synthesis when missing).
- [x] Choose transcription provider and supported languages (`TranscriptionProvider` interface with OpenAI Whisper API + local adaptive fallback).
- [x] Define data retention and deletion policy (project/asset deletion removes underlying storage files; per-job temp directories auto-cleaned).
- [x] Define whether subtitles are reviewed before export (two-step generate → review/edit → export workflow).

## 1. Repository and developer setup
- [x] Create repository and monorepo layout (`apps/web` + `apps/api`).
- [x] Create frontend app with `onpkg` stack `react-vite-gsap` (React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand, TanStack Query).
- [x] Create backend app with `onpkg` stack `fastapi` (FastAPI, SQLAlchemy Async, Alembic, Pydantic v2, structlog).
- [x] Add Python dependency management and lockfile (`pyproject.toml` + `uv.lock`).
- [x] Add Dockerfile for API/worker with FFmpeg and allowlisted fonts.
- [x] Add Docker Compose for local development (`docker-compose.yml`).
- [x] Add `.env.example` with placeholder values only.
- [x] Document local setup (`README.md`).

## 2. Database and domain models
- [x] Create User model (`app/models/domain.py`).
- [x] Create Project model (`app/models/domain.py`).
- [x] Create Asset model (source, logo, outro, output, temporary).
- [x] Create ProcessingJob model and stage/status fields.
- [x] Create SubtitleCue model with versioned immutable cue sets.
- [x] Create versioned `EditSettings` JSON schema (`app/schemas/api_schemas.py`).
- [x] Create migration tooling with Alembic (`alembic/`).
- [x] Add owner-scoped queries and authorization tests.
- [x] Add created/updated timestamps and deletion workflow.

## 3. Storage and uploads
- [x] Configure private object storage directory & key generator (`app/services/storage.py`).
- [x] Implement signed upload URL endpoint (`POST /api/v1/projects/{id}/assets/upload-url` & `PUT /api/v1/assets/{id}/upload`).
- [x] Implement upload completion endpoint (`POST /api/v1/projects/{id}/assets/complete`).
- [x] Validate actual media using FFprobe (`app/media/probe.py`).
- [x] Validate file size, duration, stream count, and allowed formats.
- [x] Validate logo dimensions and image format with Pillow.
- [x] Generate server-side storage keys (never using user filenames as paths).
- [x] Store file metadata and SHA-256 checksum.
- [x] Implement signed download URL endpoint (`POST /api/v1/assets/{id}/download-url`).
- [x] Add upload progress UI (`UploadStep.tsx`).

## 4. Video processing foundation
- [x] Build FFprobe wrapper using safe subprocess argument arrays (`app/media/probe.py`).
- [x] Parse duration, dimensions, frame rate, codec, pixel format, audio streams, and rotation metadata.
- [x] Build unique per-job temporary workspace (`app/workers/job_runner.py`).
- [x] Add worker concurrency limits and subprocess timeouts.
- [x] Implement accurate trim render (`trim_video_segment`).
- [x] Implement output resolution and aspect-ratio policy.
- [x] Implement logo scaling and overlay (`render_main_segment`).
- [x] Implement normalized logo coordinates and nine anchor presets (`compute_logo_overlay_expressions`).
- [x] Implement opacity and margin settings (`colorchannelmixer`).
- [x] Implement outro normalization (`normalize_and_concat_outro`).
- [x] Implement concat with consistent stream parameters.
- [x] Handle source without audio (auto-synthesized stereo silence).
- [x] Handle outro without audio (auto-synthesized stereo silence).
- [x] Validate final output with FFprobe before marking job completed.
- [x] Add synthetic fixture videos for integration tests (`tests/test_pipeline_and_api.py`).

## 5. AI subtitle generation
- [x] Define `TranscriptionProvider` interface (`app/providers/transcription.py`).
- [x] Implement provider adapter for OpenAI Whisper API (`OpenAIWhisperProvider`) + local fallback (`LocalAdaptiveTranscriptionProvider`).
- [x] Extract 16kHz mono WAV audio from trimmed segment (`extract_audio_for_transcription`).
- [x] Normalize provider response into internal millisecond cue schema.
- [x] Store detected language and versioned cues.
- [x] Add user-selectable language/auto-detect behavior.
- [x] Add transcript generation status and errors.
- [x] Add transcript regeneration confirmation dialog.

## 6. Subtitle editing and styling
- [x] Build chronological cue list (`SubtitlesStep.tsx`).
- [x] Allow cue text editing.
- [x] Allow cue start/end time editing.
- [x] Allow adding and deleting cues.
- [x] Validate cue bounds against trimmed duration (`validate_subtitle_cues`).
- [x] Detect overlaps and invalid ordering.
- [x] Add subtitle preview synchronized to playback (`InteractiveVideoPreview.tsx`).
- [x] Add nine-position presets (`PositionGridPicker.tsx`).
- [x] Add drag-to-position control on video preview canvas.
- [x] Add server-installed font allowlist.
- [x] Add font size and text color controls.
- [x] Add background color and opacity (`BorderStyle=3`).
- [x] Add outline and shadow controls.
- [x] Add text alignment and safe-area margins.
- [x] Generate ASS file from cue and style models (`generate_ass_content`).
- [x] Add subtitle export as SRT (`GET /api/v1/projects/{id}/subtitle-versions/{ver}/srt`).

## 7. Frontend workflow
- [x] Build project dashboard (`HomePage.tsx`) + 1-click Sample Project generator.
- [x] Build create-project flow.
- [x] Build upload screen (`UploadStep.tsx`).
- [x] Build trim screen with timestamp inputs and scrubber (`TrimStep.tsx`).
- [x] Build logo placement screen (`LogoStep.tsx`).
- [x] Build subtitle generation, review/editor, and styling screen (`SubtitlesStep.tsx`).
- [x] Build outro configuration screen (`OutroStep.tsx`).
- [x] Build review and export screen (`ReviewExportStep.tsx`).
- [x] Preserve settings when navigating between steps (`useWorkflowStore.ts`).
- [x] Add inline validation and accessible labels.
- [x] Add loading, empty, error, and success states.

## 8. Job orchestration
- [x] Implement job creation endpoints (`/transcriptions` and `/exports`).
- [x] Implement stage progress updates (`queued` → `validating` → `probing` → `trimming` → `rendering_main` → `normalizing_outro` → `joining_outro` → `validating_output` → `uploading_output` → `completed`).
- [x] Implement idempotency protection and duplicate export prevention.
- [x] Implement cancellation (`POST /api/v1/jobs/{id}/cancel`) and retry (`POST /api/v1/jobs/{id}/retry`).
- [x] Implement real-time status polling via TanStack Query.
- [x] Ensure completion only follows output validation and upload.
