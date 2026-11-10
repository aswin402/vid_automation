# Product Requirements Document (PRD)
## AI Video Automation Platform

**Document status:** Draft v1.0  
**Date:** 2026-11-03  
**Product type:** Web application / SaaS-ready platform

---

## 1. Product summary

Build a web application that turns a user-uploaded source video into a finished, branded video through a guided workflow. A user selects a time range, adds a logo, optionally generates AI subtitles, configures subtitle appearance and position, appends an outro, previews the result, and exports the final video.

The product is an automated editing tool, not a full nonlinear editor. The first release prioritizes a reliable, repeatable workflow over a large set of advanced editing features.

## 2. Problem statement

Many creators and small businesses repeatedly perform the same editing tasks:
- Trim a video to a known start and end time.
- Add a brand logo in a consistent position.
- Generate and style subtitles.
- Append a standard outro.
- Export the result in a usable format.

Doing these steps manually in a desktop editor is repetitive, takes time, and can lead to inconsistent branding. The product automates this repeatable workflow.

## 3. Goals

### MVP goals
1. Allow a user to upload one source video, one optional logo image, and one optional outro video.
2. Allow precise start/end trimming.
3. Allow logo placement, size, and opacity configuration.
4. Generate subtitles from the trimmed video's audio using a speech-to-text service.
5. Allow users to review and edit subtitle text and timing.
6. Allow subtitle style and position configuration.
7. Append the outro to the edited main segment.
8. Process asynchronously and show job status.
9. Provide a downloadable MP4 output.
10. Preserve user settings as an editable project/job record.

### Success measures
- At least 95% of valid MVP jobs complete without an internal processing error.
- Users can complete a standard job without developer assistance.
- The user can preview and correct generated subtitles before export.
- Job status is visible and understandable.
- Output video passes automated media validation.

These are initial product targets, not guaranteed performance claims. Establish baselines during beta.

## 4. Non-goals for MVP

- Full multitrack timeline editor.
- Complex transitions, keyframes, color grading, or effects.
- AI-generated video or avatar creation.
- Automatic highlight selection as a required workflow.
- Real-time collaborative editing.
- Mobile-native applications.
- Guaranteed transcription accuracy for every language, accent, or noisy recording.
- Large-scale batch processing in the first public release.

## 5. Target users and use cases

### Primary personas
**Creator:** Publishes recurring videos and needs consistent captions and branding.  
**Small business marketer:** Produces product, training, or promotional videos with a standard logo and outro.  
**Agency operator:** Processes multiple client videos using repeatable settings.

### Core user stories
- As a user, I can upload a video and specify a start and end time so I can select only the section I need.
- As a user, I can upload a transparent PNG logo and choose its position, size, and opacity.
- As a user, I can generate subtitles from the selected clip's speech.
- As a user, I can choose the subtitle language when supported.
- As a user, I can correct transcription mistakes and adjust subtitle timing.
- As a user, I can choose subtitle position, font, size, color, background, outline, and shadow.
- As a user, I can append an outro video after the edited main segment.
- As a user, I can preview the configured result before export.
- As a user, I can see whether processing is queued, running, complete, or failed.
- As a user, I can download the final MP4.

## 6. Scope and functional requirements

### FR-01: Project creation and upload
- User can create a project/job.
- User can upload one source video.
- User can optionally upload one logo image and one outro video.
- Supported initial formats should be explicitly configured and validated. Recommended MVP: MP4/MOV video; PNG/JPEG/WebP logo; MP4 outro.
- Show upload progress and file metadata after upload.
- Reject unsupported, corrupted, oversized, or duration-exceeding files with actionable errors.

### FR-02: Trim selection
- User specifies start and end timestamps.
- Validate `0 <= start < end <= source duration`.
- UI displays duration and allows preview/scrubbing.
- Backend stores times in milliseconds to avoid floating-point ambiguity.
- Define trim semantics precisely: timestamps refer to the original source timeline; the resulting clip begins at source start time and ends at source end time.
- Use accurate re-encoding for frame-accurate cuts in MVP. Fast stream-copy trimming can be a later optimization with keyframe limitations explained.

### FR-03: Logo overlay
- User can enable/disable logo overlay.
- User can choose one of nine anchor positions or drag the logo in a preview.
- User can configure width or scale, margin, and opacity.
- Preserve transparent pixels.
- Position and size are normalized relative to output dimensions so settings work across resolutions.
- Logo is applied to the main trimmed segment. By default, it is not applied to the outro; make this behavior explicit in UI.

### FR-04: AI subtitle generation
- User can enable/disable subtitles.
- Generate transcription from the trimmed clip's audio, not the full source, unless a future workflow requires otherwise.
- Support a configured list of languages and expose the provider's actual capabilities.
- Return segment-level timestamps at minimum.
- Word-level timing may be supported by the selected provider/model or an alignment stage; do not promise word-level accuracy unless available.
- Store raw transcription and normalized editable subtitle cues.
- Show generation status and meaningful errors.
- Allow the user to regenerate subtitles, understanding that manual edits may be overwritten; warn and confirm.

### FR-05: Subtitle review and editing
- Display subtitle cues in chronological order.
- User can edit text, start time, and end time.
- Validate that each cue has `start < end`, lies within the trimmed clip duration, and is ordered.
- Overlaps may be allowed only if intentionally supported; MVP should prevent accidental overlaps or warn.
- User can add/delete cues.
- Changes are saved before export.

### FR-06: Subtitle styling and placement
- User can select preset positions: top-left, top-center, top-right, middle-left, center, middle-right, bottom-left, bottom-center, bottom-right.
- User can optionally drag subtitle placement in preview.
- User can configure font family from a server-installed allowlist, font size, text color, background/box color and opacity, outline, shadow, alignment, and safe-area margins.
- Provide readable defaults: bottom-center, high-contrast text, outline or semi-transparent box.
- Use ASS subtitles for advanced styling and positioning.
- Avoid accepting arbitrary font paths or user-supplied font files in MVP.

### FR-07: Outro attachment
- User can enable/disable outro.
- Append outro after the main edited segment.
- Normalize video dimensions, frame rate, pixel format, video codec, audio sample rate, and channel layout before concatenation.
- Define audio behavior: MVP default is preserve main clip audio and outro audio in sequence; no crossfade.
- If the outro has no audio, output should remain valid.
- If the source clip has no audio, the pipeline should still work.

### FR-08: Preview
- Show source video preview with trim controls.
- Show a representative preview with logo and subtitle styling.
- Provide a low-resolution preview render or client-side approximation; clearly distinguish preview from final output.
- Final export is the source of truth for exact rendering.
- Include the outro in the final preview where feasible.

### FR-09: Export and job status
- Submit export as an asynchronous job.
- Status values: `queued`, `validating`, `transcribing`, `rendering_main`, `joining_outro`, `validating_output`, `completed`, `failed`, `canceled`.
- Show progress where measurable; otherwise show stage labels rather than fake percentage.
- Provide output metadata and a secure download link when complete.
- Support retry for recoverable failures.
- Clean up temporary files according to retention policy.

## 7. UX requirements

- Use a guided, step-by-step editor: Upload → Trim → Branding → Subtitles → Outro → Review & Export.
- Preserve settings when navigating backward.
- Make optional steps clearly optional.
- Display source duration, selected duration, output aspect ratio, and estimated output settings.
- Show validation inline before job submission.
- Provide accessible controls, keyboard labels, and sufficient contrast.
- Explain that AI-generated subtitles may need review.

## 8. Non-functional requirements

### Reliability
- Processing must run outside the web request lifecycle.
- Jobs must be idempotent or protected against duplicate execution.
- Record stage-level errors and safe diagnostic identifiers.
- Never mark a job completed until output validation succeeds.

### Performance
- Upload directly to object storage using signed URLs.
- Use a worker queue for processing.
- Limit concurrent jobs per worker based on CPU/GPU and memory.
- Initial target: support common creator videos; establish exact file size/duration limits during deployment testing.

### Security and privacy
- Validate file signatures and media metadata; do not trust file extensions or client MIME types.
- Run FFmpeg in a restricted container with resource limits and no unnecessary network access.
- Use generated storage keys; never use user filenames as filesystem paths.
- Use private object storage and short-lived signed download URLs.
- Apply authentication and per-user authorization to projects and files.
- Encrypt traffic in transit and use provider encryption at rest.
- Define retention and deletion policies for source media, generated media, transcripts, and logs.
- Obtain user consent and disclose third-party AI transcription processing.
- Do not send media to an AI provider unless the user has enabled the relevant feature and the privacy notice explains it.

### Observability
- Track job counts, duration by stage, failure rate, queue depth, storage use, AI usage/cost, and FFmpeg exit codes.
- Use structured logs with job IDs; avoid logging media contents or sensitive transcript text by default.

## 9. Assumptions and dependencies

- The initial application is a web app.
- FFmpeg is the media-processing engine.
- A speech-to-text provider is available through an API or self-hosted model.
- PostgreSQL stores project and job metadata.
- Object storage holds uploaded and generated files.
- Redis plus Celery (or an equivalent queue/worker system) handles asynchronous jobs.
- Exact provider, region, pricing, and supported language decisions will be validated before production.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Source/outro incompatibility | Probe media and normalize both before concat |
| Transcription errors | Editable transcript and clear AI disclaimer |
| Large files/timeouts | Direct-to-storage uploads and background jobs |
| FFmpeg resource exhaustion | Container limits, duration/size limits, worker concurrency controls |
| Font differences across environments | Bundle and allowlist known fonts |
| Provider outage or rate limit | Retries with backoff, failure states, optional alternate provider |
| Unexpected cost | Usage metering, quotas, maximum duration, provider cost monitoring |
| Subtitle timing drift | Work in trimmed-clip timebase; test audio/video sync |
| Malicious media files | Isolated processing, patched FFmpeg, strict validation |

## 11. Release plan

**MVP:** Single-video workflow, trimming, logo overlay, AI subtitles, subtitle editor/style, outro append, MP4 export.  
**V1:** Reusable templates, saved brand kits, batch jobs, multiple subtitle languages, SRT download, improved preview.  
**V2:** AI highlight suggestions, silence removal, translations, animated subtitle presets, team workspaces, billing and usage plans.

## 12. Acceptance criteria

A release candidate is acceptable when:
1. A valid source video can be uploaded and probed.
2. Invalid trim ranges are blocked.
3. The rendered main segment matches the selected source interval within the chosen frame-accuracy behavior.
4. Logo position and opacity match saved settings.
5. AI transcription produces editable cues with timestamps.
6. User edits persist and appear in the rendered output.
7. Subtitle position and styling render consistently in the output.
8. Outro follows the main segment and output plays through.
9. Audio remains synchronized and valid.
10. Failed jobs show actionable errors and do not expose internal server paths.
11. Completed output passes FFprobe validation and can be downloaded by its owner.
12. Automated tests cover validation, timeline conversion, and pipeline stage behavior.
