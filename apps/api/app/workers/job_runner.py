import asyncio
import copy
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.core.config import settings
from app.db.session import SessionLocal
from app.exceptions.handlers import AppError
from app.media.ass_generator import generate_ass_content, validate_subtitle_cues
from app.media.pipeline import (
    extract_audio_for_transcription,
    normalize_and_concat_outro,
    render_main_segment,
    trim_video_segment,
    validate_trim_range,
)
from app.media.probe import probe_video_file
from app.models.domain import Asset, ProcessingJob, Project, SubtitleCue
from app.providers.transcription import get_transcription_provider
from app.services.storage import storage_service

logger = structlog.get_logger(__name__)

_job_semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)
_active_tasks: Dict[str, asyncio.Task] = {}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def _update_job_stage(
    db: AsyncSession,
    job: ProcessingJob,
    status: str,
    stage: str,
    progress: Optional[float] = None,
) -> None:
    await db.refresh(job)
    if job.status == "canceled":
        raise AppError("JOB_CANCELED", "This processing job was canceled by the user.", status_code=400)
    job.status = status
    job.stage = stage
    job.progress = progress
    job.updated_at = utcnow()
    if job.started_at is None and status not in ("queued",):
        job.started_at = utcnow()
    await db.commit()


async def execute_transcription_job(job_id: str) -> None:
    work_dir = Path(settings.worker_temp_dir) / f"transcribe_{job_id}"
    work_dir.mkdir(parents=True, exist_ok=True)

    async with _job_semaphore:
        async with SessionLocal() as db:
            result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
            job = result.scalar_one_or_none()
            if not job or job.status == "canceled":
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            proj_res = await db.execute(select(Project).where(Project.id == job.project_id))
            project = proj_res.scalar_one_or_none()
            if not project:
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            try:
                await _update_job_stage(db, job, "validating", "validating")

                asset_res = await db.execute(
                    select(Asset)
                    .where(
                        Asset.project_id == project.id,
                        Asset.kind == "source",
                        Asset.status == "ready",
                    )
                    .order_by(Asset.created_at.desc())
                )
                source_asset = asset_res.scalars().first()
                if not source_asset:
                    raise AppError(
                        "UNSUPPORTED_MEDIA",
                        "Upload a valid source video before generating subtitles.",
                        status_code=400,
                    )

                source_path = storage_service.resolve_path(source_asset.storage_key)
                await _update_job_stage(db, job, "probing", "probing")
                source_meta = await probe_video_file(source_path, check_duration_limit=True)

                cfg = copy.deepcopy(project.settings_json or {})
                trim_cfg = cfg.get("trim") or {}
                start_ms, end_ms = validate_trim_range(
                    int(trim_cfg.get("start_ms") or 0),
                    trim_cfg.get("end_ms"),
                    source_meta.duration_ms or 0,
                )
                trimmed_duration_ms = end_ms - start_ms

                await _update_job_stage(db, job, "trimming", "trimming")
                trimmed_path = work_dir / "trimmed.mp4"
                await trim_video_segment(
                    source_path=source_path,
                    output_path=trimmed_path,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    source_meta=source_meta,
                )

                await _update_job_stage(db, job, "transcribing", "transcribing")
                wav_path = work_dir / "speech.wav"
                await extract_audio_for_transcription(trimmed_path, wav_path)

                snapshot = job.settings_snapshot_json or {}
                requested_lang = snapshot.get("language") or cfg.get("subtitles", {}).get("language", "auto")

                provider = get_transcription_provider()
                transcript = await provider.transcribe(
                    audio_path=wav_path,
                    duration_ms=trimmed_duration_ms,
                    language=requested_lang,
                )

                validated_cues = validate_subtitle_cues(
                    transcript.cues,
                    trimmed_duration_ms=trimmed_duration_ms,
                    allow_overlaps=False,
                )

                # Determine next subtitle version
                max_ver_res = await db.execute(
                    select(func.max(SubtitleCue.version)).where(SubtitleCue.project_id == project.id)
                )
                current_max_ver = max_ver_res.scalar() or 0
                new_version = max(current_max_ver, project.active_subtitle_version) + 1

                for cue_data in validated_cues:
                    db.add(
                        SubtitleCue(
                            project_id=project.id,
                            version=new_version,
                            sequence=cue_data["sequence"],
                            start_ms=cue_data["start_ms"],
                            end_ms=cue_data["end_ms"],
                            text=cue_data["text"],
                            words_json=cue_data.get("words_json"),
                        )
                    )

                project.active_subtitle_version = new_version
                project.detected_language = transcript.language
                if "subtitles" not in cfg:
                    cfg["subtitles"] = {}
                cfg["subtitles"]["enabled"] = True
                project.settings_json = cfg
                project.updated_at = utcnow()

                job.subtitle_version = new_version
                job.status = "completed"
                job.stage = "completed"
                job.progress = 100.0
                job.finished_at = utcnow()
                job.updated_at = utcnow()
                await db.commit()
                logger.info(
                    "transcription_job_completed",
                    job_id=job.id,
                    project_id=project.id,
                    version=new_version,
                    cue_count=len(validated_cues),
                )

            except AppError as exc:
                logger.warning(
                    "transcription_job_failed",
                    job_id=job.id,
                    error_code=exc.error_code,
                    message=exc.message,
                )
                job.status = "canceled" if exc.error_code == "JOB_CANCELED" else "failed"
                job.stage = job.status
                job.error_code = exc.error_code
                job.error_message_safe = exc.message
                job.internal_diagnostics = exc.internal_detail
                job.finished_at = utcnow()
                job.updated_at = utcnow()
                await db.commit()
            except Exception as exc:
                logger.error("transcription_job_unhandled_error", job_id=job.id, error=str(exc))
                job.status = "failed"
                job.stage = "failed"
                job.error_code = "TRANSCRIPTION_PROVIDER_ERROR"
                job.error_message_safe = (
                    "We couldn't generate subtitles. Your video is safe; try again or continue without subtitles."
                )
                job.internal_diagnostics = str(exc)
                job.finished_at = utcnow()
                job.updated_at = utcnow()
                await db.commit()
            finally:
                shutil.rmtree(work_dir, ignore_errors=True)
                _active_tasks.pop(job_id, None)


async def execute_export_job(job_id: str) -> None:
    work_dir = Path(settings.worker_temp_dir) / f"export_{job_id}"
    work_dir.mkdir(parents=True, exist_ok=True)

    async with _job_semaphore:
        async with SessionLocal() as db:
            result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
            job = result.scalar_one_or_none()
            if not job or job.status == "canceled":
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            proj_res = await db.execute(select(Project).where(Project.id == job.project_id))
            project = proj_res.scalar_one_or_none()
            if not project:
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            try:
                project.status = "processing"
                await _update_job_stage(db, job, "validating", "validating")

                cfg = copy.deepcopy(job.settings_snapshot_json or project.settings_json or {})

                # Locate source asset
                src_res = await db.execute(
                    select(Asset)
                    .where(
                        Asset.project_id == project.id,
                        Asset.kind == "source",
                        Asset.status == "ready",
                    )
                    .order_by(Asset.created_at.desc())
                )
                source_asset = src_res.scalars().first()
                if not source_asset:
                    raise AppError(
                        "UNSUPPORTED_MEDIA",
                        "No valid source video found for this project.",
                        status_code=400,
                    )

                source_path = storage_service.resolve_path(source_asset.storage_key)
                await _update_job_stage(db, job, "probing", "probing")
                source_meta = await probe_video_file(source_path, check_duration_limit=True)

                trim_cfg = cfg.get("trim") or {}
                start_ms, end_ms = validate_trim_range(
                    int(trim_cfg.get("start_ms") or 0),
                    trim_cfg.get("end_ms"),
                    source_meta.duration_ms or 0,
                )
                trimmed_duration_ms = end_ms - start_ms

                output_cfg = cfg.get("output") or {}
                target_w = output_cfg.get("width")
                target_h = output_cfg.get("height")
                target_fps = output_cfg.get("fps")

                await _update_job_stage(db, job, "trimming", "trimming")
                trimmed_path = work_dir / "trimmed.mp4"
                trimmed_meta = await trim_video_segment(
                    source_path=source_path,
                    output_path=trimmed_path,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    source_meta=source_meta,
                    target_width=int(target_w) if target_w else None,
                    target_height=int(target_h) if target_h else None,
                    target_fps=float(target_fps) if target_fps else None,
                    output_cfg=output_cfg,
                )

                # Resolve optional logo
                logo_cfg = cfg.get("logo") or {}
                logo_path: Optional[Path] = None
                if logo_cfg.get("enabled"):
                    logo_asset_id = logo_cfg.get("asset_id")
                    logo_query = select(Asset).where(
                        Asset.project_id == project.id,
                        Asset.kind == "logo",
                        Asset.status == "ready",
                    )
                    if logo_asset_id:
                        logo_query = logo_query.where(Asset.id == logo_asset_id)
                    logo_res = await db.execute(logo_query.order_by(Asset.created_at.desc()))
                    logo_asset = logo_res.scalars().first()
                    if logo_asset:
                        logo_path = storage_service.resolve_path(logo_asset.storage_key)

                # Resolve optional subtitles & generate ASS
                sub_cfg = cfg.get("subtitles") or {}
                ass_path: Optional[Path] = None
                sub_version = job.subtitle_version or project.active_subtitle_version
                if sub_cfg.get("enabled") and sub_version and sub_version > 0:
                    cues_res = await db.execute(
                        select(SubtitleCue)
                        .where(
                            SubtitleCue.project_id == project.id,
                            SubtitleCue.version == sub_version,
                        )
                        .order_by(SubtitleCue.sequence.asc())
                    )
                    cue_rows = cues_res.scalars().all()
                    if cue_rows:
                        cue_dicts = [
                            {
                                "sequence": c.sequence,
                                "start_ms": c.start_ms,
                                "end_ms": min(c.end_ms, trimmed_duration_ms),
                                "text": c.text,
                            }
                            for c in cue_rows
                            if c.start_ms < trimmed_duration_ms and c.end_ms > c.start_ms
                        ]
                        if cue_dicts:
                            validated_cues = validate_subtitle_cues(
                                cue_dicts,
                                trimmed_duration_ms=trimmed_duration_ms,
                                allow_overlaps=True,
                            )
                            style_cfg = sub_cfg.get("style") or {}
                            ass_text = generate_ass_content(
                                cues=validated_cues,
                                style_cfg=style_cfg,
                                play_res_x=trimmed_meta.width,
                                play_res_y=trimmed_meta.height,
                            )
                            ass_path = work_dir / "subtitles.ass"
                            ass_path.write_text(ass_text, encoding="utf-8")

                color_cfg = cfg.get("color_correction") or {}

                await _update_job_stage(db, job, "rendering_main", "rendering_main")
                main_render_path = work_dir / "main_render.mp4"
                main_meta = await render_main_segment(
                    trimmed_video_path=trimmed_path,
                    output_path=main_render_path,
                    trimmed_meta=trimmed_meta,
                    logo_path=logo_path,
                    logo_cfg=logo_cfg,
                    ass_path=ass_path,
                    output_cfg=output_cfg,
                    color_cfg=color_cfg,
                )

                # Resolve optional outro
                outro_cfg = cfg.get("outro") or {}
                final_local_path = main_render_path
                if outro_cfg.get("enabled"):
                    outro_asset_id = outro_cfg.get("asset_id")
                    outro_query = select(Asset).where(
                        Asset.project_id == project.id,
                        Asset.kind == "outro",
                        Asset.status == "ready",
                    )
                    if outro_asset_id:
                        outro_query = outro_query.where(Asset.id == outro_asset_id)
                    outro_res = await db.execute(outro_query.order_by(Asset.created_at.desc()))
                    outro_asset = outro_res.scalars().first()
                    if outro_asset:
                        outro_source_path = storage_service.resolve_path(outro_asset.storage_key)
                        await _update_job_stage(db, job, "normalizing_outro", "normalizing_outro")
                        norm_outro_path = work_dir / "outro_normalized.mp4"
                        joined_path = work_dir / "final_joined.mp4"
                        await _update_job_stage(db, job, "joining_outro", "joining_outro")
                        await normalize_and_concat_outro(
                            main_render_path=main_render_path,
                            outro_source_path=outro_source_path,
                            normalized_outro_path=norm_outro_path,
                            final_output_path=joined_path,
                            main_meta=main_meta,
                            normalization_mode=str(outro_cfg.get("normalization_mode") or "pad"),
                            output_cfg=output_cfg,
                            color_cfg=color_cfg,
                        )
                        final_local_path = joined_path

                # Validate final output with FFprobe before publishing
                await _update_job_stage(db, job, "validating_output", "validating_output")
                output_meta = await probe_video_file(final_local_path, check_duration_limit=False)
                if not output_meta.duration_ms or output_meta.duration_ms < 100:
                    raise AppError(
                        "OUTPUT_VALIDATION_FAILED",
                        "Rendered output video failed media validation.",
                        status_code=500,
                    )

                await _update_job_stage(db, job, "uploading_output", "uploading_output")
                safe_project_slug = "".join(
                    ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in project.name
                ).strip("_") or "video"
                output_filename = f"{safe_project_slug}_export.mp4"
                storage_key = storage_service.generate_storage_key(
                    project.id, "output", output_filename
                )
                dest_path = storage_service.resolve_path(storage_key)
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(final_local_path, dest_path)

                checksum = storage_service.compute_sha256(dest_path)
                output_asset = Asset(
                    project_id=project.id,
                    kind="output",
                    status="ready",
                    storage_key=storage_key,
                    original_filename=output_filename,
                    mime_type="video/mp4",
                    size_bytes=output_meta.size_bytes,
                    duration_ms=output_meta.duration_ms,
                    width=output_meta.width,
                    height=output_meta.height,
                    video_codec=output_meta.video_codec,
                    audio_codec=output_meta.audio_codec,
                    frame_rate=output_meta.frame_rate,
                    pixel_format=output_meta.pixel_format,
                    has_audio=output_meta.has_audio,
                    checksum=checksum,
                )
                db.add(output_asset)
                await db.flush()

                job.output_asset_id = output_asset.id
                job.status = "completed"
                job.stage = "completed"
                job.progress = 100.0
                job.finished_at = utcnow()
                job.updated_at = utcnow()

                project.status = "completed"
                project.updated_at = utcnow()
                await db.commit()
                logger.info(
                    "export_job_completed",
                    job_id=job.id,
                    project_id=project.id,
                    output_asset_id=output_asset.id,
                    duration_ms=output_meta.duration_ms,
                )

            except AppError as exc:
                logger.warning(
                    "export_job_failed",
                    job_id=job.id,
                    error_code=exc.error_code,
                    message=exc.message,
                )
                job.status = "canceled" if exc.error_code == "JOB_CANCELED" else "failed"
                job.stage = job.status
                job.error_code = exc.error_code
                job.error_message_safe = exc.message
                job.internal_diagnostics = exc.internal_detail
                job.finished_at = utcnow()
                job.updated_at = utcnow()
                project.status = "failed" if job.status == "failed" else "draft"
                project.updated_at = utcnow()
                await db.commit()
            except Exception as exc:
                logger.error("export_job_unhandled_error", job_id=job.id, error=str(exc))
                job.status = "failed"
                job.stage = "failed"
                job.error_code = "RENDER_FAILED"
                job.error_message_safe = f"Rendering failed. Reference: {job.id}."
                job.internal_diagnostics = str(exc)
                job.finished_at = utcnow()
                job.updated_at = utcnow()
                project.status = "failed"
                project.updated_at = utcnow()
                await db.commit()
            finally:
                shutil.rmtree(work_dir, ignore_errors=True)
                _active_tasks.pop(job_id, None)


def enqueue_job(job_id: str, kind: str) -> asyncio.Task:
    if kind == "transcribe":
        task = asyncio.create_task(execute_transcription_job(job_id))
    else:
        task = asyncio.create_task(execute_export_job(job_id))
    _active_tasks[job_id] = task
    return task
