# UX and Product Design Specification
## AI Video Automation Platform

**Version:** 1.0  
**Date:** 2026-11-03

---

## 1. Design principles

1. **Guided, not overwhelming:** Present a clear sequence of steps rather than a professional editing timeline.
2. **Preview before export:** Users should understand what will be produced.
3. **Safe defaults:** Provide attractive defaults while allowing control.
4. **Transparent AI:** Make it clear subtitles are AI-generated and may need correction.
5. **Fast recovery:** Preserve settings and show actionable errors.
6. **Responsive:** Support desktop-first editing, with upload and job monitoring usable on mobile.

## 2. Information architecture

Primary navigation:
- Dashboard
- New video
- Projects / History
- Settings (account, usage, privacy)

Project workflow:
1. Upload
2. Trim
3. Logo
4. Subtitles
5. Outro
6. Review & Export

A stepper at the top shows progress and allows returning to completed steps.

## 3. Screen specifications

### Screen A — Dashboard
**Purpose:** Start a new job and revisit prior jobs.

Components:
- Primary button: `Create video`
- Recent projects list with thumbnail, title, created date, status, and action.
- Status badges: Draft, Processing, Completed, Failed.
- Empty state with a short explanation and create button.

### Screen B — Upload
**Purpose:** Add media assets.

Components:
- Source video dropzone (required).
- Logo dropzone (optional).
- Outro dropzone (optional).
- Upload progress and cancel action.
- Media metadata after upload: filename, duration, dimensions, size.
- Supported format and maximum size guidance.

Validation:
- Source video required.
- Logo must be an allowed image format and within dimension/size limits.
- Outro must be a supported video format.
- Do not rely on file extension alone.

### Screen C — Trim
**Purpose:** Select the portion of the source video.

Components:
- Video player.
- Timeline/scrubber.
- Start time and end time inputs (HH:MM:SS.mmm or a friendlier time control).
- Selected duration display.
- Play selection button.
- Reset selection button.

Behavior:
- Start and end handles update timestamp fields.
- Timestamp fields update timeline handles.
- Block start >= end and end > source duration.
- Clearly state timestamps refer to the original uploaded video.

### Screen D — Logo
**Purpose:** Brand the main trimmed segment.

Controls:
- Enable logo toggle.
- Logo preview.
- Nine-position grid.
- Optional drag positioning.
- Width/scale slider.
- Opacity slider.
- Margin slider.
- Reset to default.

Recommended default:
- Bottom-right or top-right based on product testing.
- 10–15% of video width, preserving aspect ratio.
- Small safe-area margin.
- Full opacity.

Behavior:
- Use normalized coordinates, not fixed output pixels.
- Preview overlay should respect selected aspect ratio.
- Explain whether the logo appears on the outro. MVP default: no.

### Screen E — Subtitles: generation
**Purpose:** Generate captions from the trimmed segment.

Controls:
- Enable subtitles toggle.
- Language: Auto-detect or explicit supported language.
- Generate subtitles button.
- Status/progress and error area.
- Estimated usage/cost disclosure if relevant.

Helper text:
"AI-generated subtitles can contain mistakes. You can review and correct them before export."

Behavior:
- Do not start transcription until the trimmed media asset is ready.
- Show generated cue count and detected language.
- Preserve existing edits unless the user confirms regeneration.

### Screen F — Subtitles: review and style
**Purpose:** Edit words, timing, and appearance.

Layout:
- Left panel: video preview.
- Right panel: subtitle cue list.
- Current cue is highlighted during playback.
- Each cue row includes start, end, and editable text.
- Add cue, delete cue, and split/merge controls can be added incrementally.

Style controls:
- Position preset grid (3x3).
- Font family allowlist.
- Font size.
- Text color.
- Background/box toggle, color, opacity, and padding.
- Outline toggle and thickness.
- Shadow toggle.
- Alignment.
- Safe-area margin.
- Preview reset.

Position behavior:
- Nine presets are the primary interaction.
- Dragging in preview updates normalized anchor/position values.
- Keep subtitles within safe areas by default.
- Preview should account for portrait and landscape dimensions.

### Screen G — Outro
**Purpose:** Confirm outro behavior.

Components:
- Outro preview/player.
- Enable/disable toggle.
- Display outro duration and dimensions.
- Audio behavior note.
- Optional output normalization notice.

MVP behavior:
- Outro is appended after the trimmed, branded, subtitled main segment.
- Logo and subtitles are not applied to the outro unless later explicitly supported.
- No crossfade in MVP.

### Screen H — Review & Export
**Purpose:** Confirm settings and submit final render.

Summary cards:
- Source and selected time range.
- Logo status and position.
- Subtitle status, language, and cue count.
- Outro status and duration.
- Output format/resolution.

Actions:
- Back to edit.
- Start export.

After submission:
- Show stage status and progress only when backed by actual stage data.
- Allow navigation away without losing job status.
- Show download action only after output validation and upload complete.

## 4. Visual design guidance

- Use a neutral, low-distraction workspace.
- Reserve strong emphasis for primary action buttons and job status.
- Use consistent spacing and typography.
- Use clear focus states and keyboard-accessible controls.
- Ensure color is not the only way status is communicated.
- Avoid tiny timestamp controls; allow keyboard entry and stepping.
- Video preview should be responsive and maintain aspect ratio.

## 5. Component inventory

Reusable frontend components:
- `AppShell`
- `ProjectCard`
- `WorkflowStepper`
- `FileDropzone`
- `UploadProgress`
- `MediaMetadata`
- `VideoPlayer`
- `TrimTimeline`
- `TimestampInput`
- `LogoPositionPicker`
- `LogoOverlayPreview`
- `SubtitleCueList`
- `SubtitleCueEditor`
- `SubtitleStylePanel`
- `SubtitlePositionPicker`
- `OutroPreview`
- `ExportSummary`
- `JobStatusPanel`
- `ErrorNotice`
- `ConfirmDialog`

## 6. Interaction and accessibility

- All inputs have visible labels.
- All icon-only actions have accessible names.
- Keyboard users can operate upload, trim inputs, cue editor, and position presets.
- Provide sufficient text/background contrast.
- Announce job status changes to assistive technology.
- Do not rely only on drag-and-drop; provide file-picker buttons.
- Use confirmation for destructive actions such as deleting a cue or regenerating edited subtitles.

## 7. Preview fidelity

The browser preview may be an approximation. The rendered export is authoritative because font rendering, codec behavior, and FFmpeg filters may differ from browser rendering.

Recommended approach:
- Use CSS overlays for fast interactive logo/subtitle positioning.
- Use the same normalized position/style model in frontend and backend.
- Generate a low-resolution server preview when exact FFmpeg rendering is necessary.
- Clearly label preview as approximate if it is not rendered by the final pipeline.

## 8. Default presets

### Subtitle default
- Position: bottom-center.
- Font: bundled sans-serif font.
- Color: white.
- Outline: dark outline enabled.
- Background box: off by default; optional semi-transparent dark box.
- Alignment: center.
- Safe-area margin: approximately 5% of frame height.

### Logo default
- Position: top-right or bottom-right (choose through user testing).
- Preserve original aspect ratio.
- Width: approximately 10–15% of frame width.
- Opacity: 100%.
- Margin: approximately 3% of frame width.

## 9. Error and empty states

Examples:
- "This file format isn't supported. Upload an MP4 or MOV video."
- "The end time must be later than the start time."
- "The selected end time is longer than the uploaded video."
- "We couldn't generate subtitles. Your video is safe; try again or continue without subtitles."
- "The outro could not be normalized. Try another video or export without the outro."
- "Rendering failed. Reference: [job ID]."

Avoid exposing raw FFmpeg command lines, filesystem paths, stack traces, or provider credentials.
