import copy
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal
from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.dependencies import get_current_user, get_db
from app.exceptions.handlers import AppError
from app.media.ass_generator import generate_srt_content, validate_subtitle_cues
from app.media.pipeline import validate_trim_range
from app.media.probe import probe_image_file, probe_video_file
from app.models.domain import (
    Asset,
    ProcessingJob,
    Project,
    SubtitleCue,
    User,
    default_edit_settings,
)
from app.schemas.api_schemas import (
    AssetResponse,
    DownloadUrlResponse,
    ExportCreateRequest,
    JobResponse,
    ProjectCreate,
    ProjectDetailResponse,
    ProjectResponse,
    ProjectUpdate,
    SubtitleCueItem,
    SubtitleVersionResponse,
    SubtitleVersionUpdateRequest,
    TranscriptionCreateRequest,
    UploadCompleteRequest,
    UploadUrlRequest,
    UploadUrlResponse,
)
from app.services.demo_media import generate_synthetic_logo, generate_synthetic_video
from app.services.storage import storage_service
from app.workers.job_runner import enqueue_job

api_router = APIRouter()
v1_router = APIRouter(prefix="/api/v1")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _serialize_asset(asset: Asset) -> AssetResponse:
    token, _ = storage_service.create_signed_token(asset.id, "download", expires_in=3600)
    stream_url = f"/api/v1/assets/{asset.id}/download?token={token}&inline=1"
    resp = AssetResponse.model_validate(asset)
    resp.stream_url = stream_url if asset.status == "ready" else None
    return resp


async def _get_owned_project(
    project_id: str,
    user: User,
    db: AsyncSession,
) -> Project:
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise AppError("NOT_FOUND", "Project not found.", status_code=404)
    if project.owner_id != user.id:
        raise AppError("FORBIDDEN", "You do not have access to this project.", status_code=403)
    return project


async def _build_project_detail(project: Project, db: AsyncSession) -> ProjectDetailResponse:
    assets_res = await db.execute(
        select(Asset)
        .where(Asset.project_id == project.id)
        .order_by(Asset.created_at.desc())
    )
    assets = [_serialize_asset(a) for a in assets_res.scalars().all()]

    jobs_res = await db.execute(
        select(ProcessingJob)
        .where(ProcessingJob.project_id == project.id)
        .order_by(ProcessingJob.created_at.desc())
    )
    jobs = [JobResponse.model_validate(j) for j in jobs_res.scalars().all()]

    cue_count = 0
    if project.active_subtitle_version > 0:
        cnt_res = await db.execute(
            select(func.count(SubtitleCue.id)).where(
                SubtitleCue.project_id == project.id,
                SubtitleCue.version == project.active_subtitle_version,
            )
        )
        cue_count = int(cnt_res.scalar() or 0)

    merged_settings = default_edit_settings()
    if project.settings_json:
        for k, v in project.settings_json.items():
            if isinstance(v, dict) and isinstance(merged_settings.get(k), dict):
                merged_settings[k] = {**merged_settings[k], **v}
            else:
                merged_settings[k] = v

    return ProjectDetailResponse(
        id=project.id,
        owner_id=project.owner_id,
        name=project.name,
        status=project.status,
        settings_json=merged_settings,
        active_subtitle_version=project.active_subtitle_version,
        detected_language=project.detected_language,
        created_at=project.created_at,
        updated_at=project.updated_at,
        assets=assets,
        jobs=jobs,
        subtitle_cue_count=cue_count,
    )


@v1_router.get("/config/capabilities")
async def get_capabilities() -> Dict[str, Any]:
    return {
        "allowed_fonts": settings.allowed_fonts,
        "supported_languages": settings.supported_languages,
        "max_upload_bytes": settings.max_upload_bytes,
        "max_source_duration_seconds": settings.max_source_duration_seconds,
        "default_settings": default_edit_settings(),
    }


# ---------------------------------------------------------------------------
# Projects CRUD
# ---------------------------------------------------------------------------


@v1_router.post(
    "/projects",
    response_model=ProjectDetailResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project(
    payload: ProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectDetailResponse:
    project = Project(
        owner_id=user.id,
        name=payload.name.strip(),
        status="draft",
        settings_json=default_edit_settings(),
        active_subtitle_version=0,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return await _build_project_detail(project, db)


@v1_router.get("/projects", response_model=List[ProjectDetailResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[ProjectDetailResponse]:
    result = await db.execute(
        select(Project)
        .where(Project.owner_id == user.id)
        .order_by(Project.updated_at.desc())
    )
    projects = result.scalars().all()
    return [await _build_project_detail(p, db) for p in projects]


@v1_router.get("/projects/{project_id}", response_model=ProjectDetailResponse)
async def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectDetailResponse:
    project = await _get_owned_project(project_id, user, db)
    return await _build_project_detail(project, db)


@v1_router.patch("/projects/{project_id}", response_model=ProjectDetailResponse)
async def update_project(
    project_id: str,
    payload: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectDetailResponse:
    project = await _get_owned_project(project_id, user, db)

    if payload.name is not None:
        project.name = payload.name.strip()

    if payload.settings is not None:
        new_settings = payload.settings.model_dump()
        # Validate font family against allowlist
        style_font = new_settings.get("subtitles", {}).get("style", {}).get("font_family")
        if style_font and style_font not in settings.allowed_fonts:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                f"Font '{style_font}' is not in the server allowlist.",
                status_code=400,
            )

        # If source asset exists, validate trim range immediately
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
        if source_asset and source_asset.duration_ms:
            trim_cfg = new_settings.get("trim") or {}
            start_ms, end_ms = validate_trim_range(
                int(trim_cfg.get("start_ms") or 0),
                trim_cfg.get("end_ms"),
                int(source_asset.duration_ms),
            )
            new_settings["trim"]["start_ms"] = start_ms
            new_settings["trim"]["end_ms"] = end_ms

        project.settings_json = new_settings

    project.updated_at = utcnow()
    await db.commit()
    await db.refresh(project)
    return await _build_project_detail(project, db)


@v1_router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    project = await _get_owned_project(project_id, user, db)
    assets_res = await db.execute(select(Asset).where(Asset.project_id == project.id))
    for asset in assets_res.scalars().all():
        storage_service.delete_key(asset.storage_key)

    await db.delete(project)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Demo / Sample Project Generator
# ---------------------------------------------------------------------------


@v1_router.post(
    "/projects/demo",
    response_model=ProjectDetailResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_demo_project(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectDetailResponse:
    """
    Creates a pre-populated sample project using the real sample files in
    `sample/` (vid.mp4, Logo _sam.png, outro.mp4) when available, or falls back
    to synthesized media assets.
    """
    sample_dir = Path(__file__).resolve().parents[4] / "sample"
    real_vid = sample_dir / "vid.mp4"
    real_logo = sample_dir / "Logo _sam.png"
    real_outro = sample_dir / "outro.mp4"
    use_real_samples = real_vid.exists() and real_logo.exists() and real_outro.exists()

    project = Project(
        owner_id=user.id,
        name="CA Builders Testimonial (Sample)" if use_real_samples else "Product Launch Promo (Sample)",
        status="draft",
        settings_json=default_edit_settings(),
        active_subtitle_version=0,
    )
    db.add(project)
    await db.flush()

    # 1. Source video
    src_filename = real_vid.name if use_real_samples else "product_demo_source.mp4"
    src_key = storage_service.generate_storage_key(project.id, "source", src_filename)
    src_path = storage_service.resolve_path(src_key)
    if use_real_samples:
        src_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(real_vid, src_path)
    else:
        await generate_synthetic_video(src_path, duration_sec=8.0, width=1280, height=720, fps=30, with_audio=True)
    src_meta = await probe_video_file(src_path, check_duration_limit=False)
    src_asset = Asset(
        project_id=project.id,
        kind="source",
        status="ready",
        storage_key=src_key,
        original_filename=src_filename,
        mime_type="video/mp4",
        size_bytes=src_meta.size_bytes,
        duration_ms=src_meta.duration_ms,
        width=src_meta.width,
        height=src_meta.height,
        video_codec=src_meta.video_codec,
        audio_codec=src_meta.audio_codec,
        frame_rate=src_meta.frame_rate,
        pixel_format=src_meta.pixel_format,
        has_audio=src_meta.has_audio,
        checksum=storage_service.compute_sha256(src_path),
    )
    db.add(src_asset)

    # 2. Brand logo
    logo_filename = real_logo.name if use_real_samples else "brand_badge.png"
    logo_key = storage_service.generate_storage_key(project.id, "logo", logo_filename)
    logo_path = storage_service.resolve_path(logo_key)
    if use_real_samples:
        logo_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(real_logo, logo_path)
    else:
        generate_synthetic_logo(logo_path)
    logo_meta = probe_image_file(logo_path)
    logo_asset = Asset(
        project_id=project.id,
        kind="logo",
        status="ready",
        storage_key=logo_key,
        original_filename=logo_filename,
        mime_type=logo_meta.mime_type,
        size_bytes=logo_meta.size_bytes,
        width=logo_meta.width,
        height=logo_meta.height,
        video_codec=logo_meta.video_codec,
        pixel_format=logo_meta.pixel_format,
        has_audio=False,
        checksum=storage_service.compute_sha256(logo_path),
    )
    db.add(logo_asset)

    # 3. Outro video
    outro_filename = real_outro.name if use_real_samples else "brand_outro.mp4"
    outro_key = storage_service.generate_storage_key(project.id, "outro", outro_filename)
    outro_path = storage_service.resolve_path(outro_key)
    if use_real_samples:
        outro_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(real_outro, outro_path)
    else:
        await generate_synthetic_video(outro_path, duration_sec=3.0, width=1280, height=720, fps=30, with_audio=True, freq_hz=587)
    outro_meta = await probe_video_file(outro_path, check_duration_limit=False)
    outro_asset = Asset(
        project_id=project.id,
        kind="outro",
        status="ready",
        storage_key=outro_key,
        original_filename=outro_filename,
        mime_type="video/mp4",
        size_bytes=outro_meta.size_bytes,
        duration_ms=outro_meta.duration_ms,
        width=outro_meta.width,
        height=outro_meta.height,
        video_codec=outro_meta.video_codec,
        audio_codec=outro_meta.audio_codec,
        frame_rate=outro_meta.frame_rate,
        pixel_format=outro_meta.pixel_format,
        has_audio=outro_meta.has_audio,
        checksum=storage_service.compute_sha256(outro_path),
    )
    db.add(outro_asset)
    await db.flush()

    cfg = default_edit_settings()
    cfg["trim"]["start_ms"] = 0 if use_real_samples else 500
    cfg["trim"]["end_ms"] = src_meta.duration_ms if use_real_samples else 6500
    cfg["logo"]["enabled"] = True
    cfg["logo"]["asset_id"] = logo_asset.id
    cfg["logo"]["position"] = "bottom-right"
    cfg["logo"]["x_ratio"] = 0.92
    cfg["logo"]["y_ratio"] = 0.72
    cfg["logo"]["width_ratio"] = 0.22
    cfg["outro"]["enabled"] = True
    cfg["outro"]["asset_id"] = outro_asset.id
    project.settings_json = cfg

    await db.commit()
    await db.refresh(project)
    return await _build_project_detail(project, db)


# ---------------------------------------------------------------------------
# Uploads and Assets
# ---------------------------------------------------------------------------


@v1_router.post(
    "/projects/{project_id}/assets/upload-url",
    response_model=UploadUrlResponse,
)
async def create_upload_url(
    project_id: str,
    payload: UploadUrlRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UploadUrlResponse:
    project = await _get_owned_project(project_id, user, db)

    if payload.size_bytes > settings.max_upload_bytes:
        raise AppError(
            "UPLOAD_TOO_LARGE",
            f"File size exceeds maximum limit of {settings.max_upload_bytes // (1024 * 1024)} MB.",
            status_code=413,
        )

    storage_key = storage_service.generate_storage_key(
        project.id, payload.kind, payload.filename
    )

    asset = Asset(
        project_id=project.id,
        kind=payload.kind,
        status="pending_upload",
        storage_key=storage_key,
        original_filename=payload.filename,
        mime_type=payload.content_type,
        size_bytes=payload.size_bytes,
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)

    token, ttl = storage_service.create_signed_token(asset.id, "upload")
    upload_url = f"/api/v1/assets/{asset.id}/upload?token={token}"

    return UploadUrlResponse(
        asset_id=asset.id,
        storage_key=storage_key,
        upload_url=upload_url,
        method="PUT",
        headers={"Content-Type": payload.content_type},
        expires_in_seconds=ttl,
    )


@v1_router.put("/assets/{asset_id}/upload")
async def upload_asset_binary(
    asset_id: str,
    request: Request,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    if not storage_service.verify_signed_token(asset_id, "upload", token):
        raise AppError("FORBIDDEN", "Upload URL is invalid or expired.", status_code=403)

    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset:
        raise AppError("NOT_FOUND", "Asset record not found.", status_code=404)

    dest_path = storage_service.resolve_path(asset.storage_key)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    total_written = 0
    with open(dest_path, "wb") as f:
        async for chunk in request.stream():
            total_written += len(chunk)
            if total_written > settings.max_upload_bytes:
                f.close()
                storage_service.delete_key(asset.storage_key)
                raise AppError(
                    "UPLOAD_TOO_LARGE",
                    f"Upload exceeds maximum allowed size of {settings.max_upload_bytes // (1024 * 1024)} MB.",
                    status_code=413,
                )
            f.write(chunk)

    return {"status": "uploaded", "asset_id": asset.id, "bytes_written": total_written}


async def _finalize_and_probe_asset(
    project: Project,
    asset: Asset,
    db: AsyncSession,
) -> AssetResponse:
    file_path = storage_service.resolve_path(asset.storage_key)
    if not file_path.exists() or file_path.stat().st_size == 0:
        asset.status = "failed"
        await db.commit()
        raise AppError(
            "MEDIA_PROBE_FAILED",
            "Uploaded file was not found in storage or is empty.",
            status_code=400,
        )

    try:
        if asset.kind == "logo":
            meta = probe_image_file(file_path)
        else:
            meta = await probe_video_file(file_path, check_duration_limit=True)
    except AppError:
        asset.status = "failed"
        storage_service.delete_key(asset.storage_key)
        await db.commit()
        raise

    # Remove older ready assets of the same singleton kind (source, logo, outro)
    if asset.kind in ("source", "logo", "outro"):
        old_res = await db.execute(
            select(Asset).where(
                Asset.project_id == project.id,
                Asset.kind == asset.kind,
                Asset.id != asset.id,
            )
        )
        for old_asset in old_res.scalars().all():
            storage_service.delete_key(old_asset.storage_key)
            await db.delete(old_asset)

    asset.status = "ready"
    asset.size_bytes = meta.size_bytes
    asset.mime_type = meta.mime_type
    asset.duration_ms = meta.duration_ms
    asset.width = meta.width
    asset.height = meta.height
    asset.video_codec = meta.video_codec
    asset.audio_codec = meta.audio_codec
    asset.frame_rate = meta.frame_rate
    asset.pixel_format = meta.pixel_format
    asset.has_audio = meta.has_audio
    asset.checksum = storage_service.compute_sha256(file_path)

    # Update project settings automatically
    cfg = copy.deepcopy(project.settings_json or default_edit_settings())
    if asset.kind == "source" and meta.duration_ms:
        cfg["trim"]["start_ms"] = 0
        cfg["trim"]["end_ms"] = meta.duration_ms
    elif asset.kind == "logo":
        cfg["logo"]["enabled"] = True
        cfg["logo"]["asset_id"] = asset.id
    elif asset.kind == "outro":
        cfg["outro"]["enabled"] = True
        cfg["outro"]["asset_id"] = asset.id

    project.settings_json = cfg
    project.updated_at = utcnow()
    await db.commit()
    await db.refresh(asset)
    return _serialize_asset(asset)


@v1_router.post(
    "/projects/{project_id}/assets/complete",
    response_model=AssetResponse,
)
async def complete_upload(
    project_id: str,
    payload: UploadCompleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    project = await _get_owned_project(project_id, user, db)
    result = await db.execute(
        select(Asset).where(Asset.id == payload.asset_id, Asset.project_id == project.id)
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise AppError("NOT_FOUND", "Asset not found for this project.", status_code=404)

    return await _finalize_and_probe_asset(project, asset, db)


@v1_router.post(
    "/projects/{project_id}/assets/direct-upload",
    response_model=AssetResponse,
)
async def direct_multipart_upload(
    project_id: str,
    kind: Literal["source", "logo", "outro"] = Query(...),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    """
    Convenience endpoint that combines signed-key allocation, streaming write, and FFprobe verification.
    """
    project = await _get_owned_project(project_id, user, db)
    filename = file.filename or f"upload.{'png' if kind == 'logo' else 'mp4'}"
    storage_key = storage_service.generate_storage_key(project.id, kind, filename)
    dest_path = storage_service.resolve_path(storage_key)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    total_written = 0
    with open(dest_path, "wb") as f:
        while True:
            chunk = await file.read(65536)
            if not chunk:
                break
            total_written += len(chunk)
            if total_written > settings.max_upload_bytes:
                f.close()
                storage_service.delete_key(storage_key)
                raise AppError(
                    "UPLOAD_TOO_LARGE",
                    f"Upload exceeds maximum allowed size of {settings.max_upload_bytes // (1024 * 1024)} MB.",
                    status_code=413,
                )
            f.write(chunk)

    asset = Asset(
        project_id=project.id,
        kind=kind,
        status="pending_upload",
        storage_key=storage_key,
        original_filename=filename,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=total_written,
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)

    return await _finalize_and_probe_asset(project, asset, db)


@v1_router.get("/assets/{asset_id}", response_model=AssetResponse)
async def get_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset:
        raise AppError("NOT_FOUND", "Asset not found.", status_code=404)
    await _get_owned_project(asset.project_id, user, db)
    return _serialize_asset(asset)


@v1_router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset:
        raise AppError("NOT_FOUND", "Asset not found.", status_code=404)
    project = await _get_owned_project(asset.project_id, user, db)

    cfg = copy.deepcopy(project.settings_json or default_edit_settings())
    if asset.kind == "logo" and cfg.get("logo", {}).get("asset_id") == asset.id:
        cfg["logo"]["enabled"] = False
        cfg["logo"]["asset_id"] = None
    elif asset.kind == "outro" and cfg.get("outro", {}).get("asset_id") == asset.id:
        cfg["outro"]["enabled"] = False
        cfg["outro"]["asset_id"] = None
    project.settings_json = cfg
    project.updated_at = utcnow()

    storage_service.delete_key(asset.storage_key)
    await db.delete(asset)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@v1_router.post("/assets/{asset_id}/download-url", response_model=DownloadUrlResponse)
async def create_download_url(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DownloadUrlResponse:
    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset or asset.status != "ready":
        raise AppError("NOT_FOUND", "Asset not found or not ready for download.", status_code=404)
    await _get_owned_project(asset.project_id, user, db)

    token, ttl = storage_service.create_signed_token(asset.id, "download")
    download_url = f"/api/v1/assets/{asset.id}/download?token={token}"
    return DownloadUrlResponse(
        asset_id=asset.id,
        filename=asset.original_filename,
        download_url=download_url,
        expires_in_seconds=ttl,
    )


@v1_router.get("/assets/{asset_id}/download")
async def download_asset_binary(
    asset_id: str,
    token: str = Query(...),
    inline: int = Query(default=0),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    if not storage_service.verify_signed_token(asset_id, "download", token):
        raise AppError("FORBIDDEN", "Download link is invalid or expired.", status_code=403)

    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset or asset.status != "ready":
        raise AppError("NOT_FOUND", "Asset file not found.", status_code=404)

    file_path = storage_service.resolve_path(asset.storage_key)
    if not file_path.exists():
        raise AppError("NOT_FOUND", "Stored media file is missing.", status_code=404)

    disposition = "inline" if inline else "attachment"
    return FileResponse(
        path=file_path,
        media_type=asset.mime_type,
        filename=asset.original_filename if not inline else None,
        headers={"Content-Disposition": f'{disposition}; filename="{asset.original_filename}"'},
    )


# ---------------------------------------------------------------------------
# Transcriptions & Subtitle Versions
# ---------------------------------------------------------------------------


@v1_router.post(
    "/projects/{project_id}/transcriptions",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_transcription(
    project_id: str,
    payload: TranscriptionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> JobResponse:
    project = await _get_owned_project(project_id, user, db)

    if project.active_subtitle_version > 0 and not payload.confirm_overwrite:
        cnt_res = await db.execute(
            select(func.count(SubtitleCue.id)).where(
                SubtitleCue.project_id == project.id,
                SubtitleCue.version == project.active_subtitle_version,
            )
        )
        if (cnt_res.scalar() or 0) > 0:
            raise AppError(
                "SUBTITLE_VALIDATION_FAILED",
                "Existing subtitle edits exist. Set confirm_overwrite=true to regenerate subtitles.",
                status_code=409,
            )

    src_res = await db.execute(
        select(Asset).where(
            Asset.project_id == project.id,
            Asset.kind == "source",
            Asset.status == "ready",
        )
    )
    if not src_res.scalars().first():
        raise AppError(
            "UNSUPPORTED_MEDIA",
            "Upload a source video before generating subtitles.",
            status_code=400,
        )

    cfg = copy.deepcopy(project.settings_json or default_edit_settings())
    if payload.language:
        cfg.setdefault("subtitles", {})["language"] = payload.language
        project.settings_json = cfg

    job = ProcessingJob(
        project_id=project.id,
        kind="transcribe",
        status="queued",
        stage="queued",
        settings_snapshot_json={"language": payload.language},
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    enqueue_job(job.id, "transcribe")
    return JobResponse.model_validate(job)


async def _get_trimmed_duration_ms(project: Project, db: AsyncSession) -> int:
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
    source_duration = int(source_asset.duration_ms) if (source_asset and source_asset.duration_ms) else 60000
    trim_cfg = (project.settings_json or {}).get("trim") or {}
    start_ms = int(trim_cfg.get("start_ms") or 0)
    end_ms = int(trim_cfg.get("end_ms") or source_duration)
    return max(200, end_ms - start_ms)


@v1_router.get(
    "/projects/{project_id}/subtitle-versions/{version}",
    response_model=SubtitleVersionResponse,
)
async def get_subtitle_version(
    project_id: str,
    version: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubtitleVersionResponse:
    project = await _get_owned_project(project_id, user, db)
    target_version = project.active_subtitle_version if version <= 0 else version
    trimmed_duration_ms = await _get_trimmed_duration_ms(project, db)

    if target_version <= 0:
        return SubtitleVersionResponse(
            project_id=project.id,
            version=0,
            language=project.detected_language or "en",
            timebase="trimmed_clip",
            duration_ms=trimmed_duration_ms,
            cues=[],
        )

    cues_res = await db.execute(
        select(SubtitleCue)
        .where(
            SubtitleCue.project_id == project.id,
            SubtitleCue.version == target_version,
        )
        .order_by(SubtitleCue.sequence.asc())
    )
    cues = [
        SubtitleCueItem(
            id=c.id,
            sequence=c.sequence,
            start_ms=c.start_ms,
            end_ms=c.end_ms,
            text=c.text,
            words_json=c.words_json,
        )
        for c in cues_res.scalars().all()
    ]

    return SubtitleVersionResponse(
        project_id=project.id,
        version=target_version,
        language=project.detected_language or "en",
        timebase="trimmed_clip",
        duration_ms=trimmed_duration_ms,
        cues=cues,
    )


@v1_router.put(
    "/projects/{project_id}/subtitle-versions/{version}",
    response_model=SubtitleVersionResponse,
)
async def save_subtitle_version(
    project_id: str,
    version: int,
    payload: SubtitleVersionUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubtitleVersionResponse:
    project = await _get_owned_project(project_id, user, db)
    trimmed_duration_ms = await _get_trimmed_duration_ms(project, db)

    raw_cues = [c.model_dump() for c in payload.cues]
    validated_cues = (
        validate_subtitle_cues(raw_cues, trimmed_duration_ms=trimmed_duration_ms, allow_overlaps=False)
        if raw_cues
        else []
    )

    max_ver_res = await db.execute(
        select(func.max(SubtitleCue.version)).where(SubtitleCue.project_id == project.id)
    )
    current_max_ver = max_ver_res.scalar() or 0
    new_version = max(current_max_ver, project.active_subtitle_version, version) + 1

    created_items: List[SubtitleCueItem] = []
    for cue_data in validated_cues:
        cue_row = SubtitleCue(
            project_id=project.id,
            version=new_version,
            sequence=cue_data["sequence"],
            start_ms=cue_data["start_ms"],
            end_ms=cue_data["end_ms"],
            text=cue_data["text"],
            words_json=cue_data.get("words_json"),
        )
        db.add(cue_row)
        await db.flush()
        created_items.append(
            SubtitleCueItem(
                id=cue_row.id,
                sequence=cue_row.sequence,
                start_ms=cue_row.start_ms,
                end_ms=cue_row.end_ms,
                text=cue_row.text,
                words_json=cue_row.words_json,
            )
        )

    project.active_subtitle_version = new_version
    if payload.language:
        project.detected_language = payload.language
    cfg = copy.deepcopy(project.settings_json or default_edit_settings())
    if created_items:
        cfg.setdefault("subtitles", {})["enabled"] = True
    project.settings_json = cfg
    project.updated_at = utcnow()
    await db.commit()

    return SubtitleVersionResponse(
        project_id=project.id,
        version=new_version,
        language=project.detected_language or "en",
        timebase="trimmed_clip",
        duration_ms=trimmed_duration_ms,
        cues=created_items,
    )


@v1_router.get(
    "/projects/{project_id}/subtitle-versions/{version}/srt",
    response_class=PlainTextResponse,
)
async def export_subtitles_srt(
    project_id: str,
    version: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlainTextResponse:
    sub_resp = await get_subtitle_version(project_id, version, user, db)
    srt_text = generate_srt_content([c.model_dump() for c in sub_resp.cues])
    return PlainTextResponse(
        content=srt_text,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="subtitles_v{sub_resp.version}.srt"'
        },
    )


# ---------------------------------------------------------------------------
# Exports & Jobs
# ---------------------------------------------------------------------------


@v1_router.post(
    "/projects/{project_id}/exports",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_export(
    project_id: str,
    payload: ExportCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> JobResponse:
    project = await _get_owned_project(project_id, user, db)

    # Check idempotency key if supplied
    if payload.idempotency_key:
        idem_res = await db.execute(
            select(ProcessingJob).where(
                ProcessingJob.project_id == project.id,
                ProcessingJob.kind == "export",
                ProcessingJob.idempotency_key == payload.idempotency_key,
            )
        )
        existing_idem = idem_res.scalars().first()
        if existing_idem:
            return JobResponse.model_validate(existing_idem)

    # Prevent duplicate active export jobs for the same project
    active_res = await db.execute(
        select(ProcessingJob).where(
            ProcessingJob.project_id == project.id,
            ProcessingJob.kind == "export",
            ProcessingJob.status.in_(
                [
                    "queued",
                    "validating",
                    "probing",
                    "trimming",
                    "rendering_main",
                    "normalizing_outro",
                    "joining_outro",
                    "validating_output",
                    "uploading_output",
                ]
            ),
        )
    )
    active_job = active_res.scalars().first()
    if active_job:
        return JobResponse.model_validate(active_job)

    # Verify source video is ready
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
            "Upload a valid source video before starting export.",
            status_code=400,
        )

    cfg = copy.deepcopy(project.settings_json or default_edit_settings())
    trim_cfg = cfg.get("trim") or {}
    validate_trim_range(
        int(trim_cfg.get("start_ms") or 0),
        trim_cfg.get("end_ms"),
        int(source_asset.duration_ms or 0),
    )

    sub_version = payload.subtitle_version or project.active_subtitle_version
    job = ProcessingJob(
        project_id=project.id,
        kind="export",
        status="queued",
        stage="queued",
        idempotency_key=payload.idempotency_key,
        settings_snapshot_json=cfg,
        subtitle_version=sub_version,
    )
    db.add(job)
    project.status = "processing"
    project.updated_at = utcnow()
    await db.commit()
    await db.refresh(job)

    enqueue_job(job.id, "export")
    return JobResponse.model_validate(job)


@v1_router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job_status(
    job_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> JobResponse:
    result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise AppError("NOT_FOUND", "Job not found.", status_code=404)
    await _get_owned_project(job.project_id, user, db)
    return JobResponse.model_validate(job)


@v1_router.post("/jobs/{job_id}/cancel", response_model=JobResponse)
async def cancel_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> JobResponse:
    result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise AppError("NOT_FOUND", "Job not found.", status_code=404)
    project = await _get_owned_project(job.project_id, user, db)

    if job.status not in ("completed", "failed", "canceled"):
        job.status = "canceled"
        job.stage = "canceled"
        job.error_code = "JOB_CANCELED"
        job.error_message_safe = "Job was canceled by the user."
        job.finished_at = utcnow()
        job.updated_at = utcnow()
        if project.status == "processing":
            project.status = "draft"
        await db.commit()
        await db.refresh(job)

    return JobResponse.model_validate(job)


@v1_router.post("/jobs/{job_id}/retry", response_model=JobResponse)
async def retry_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> JobResponse:
    result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise AppError("NOT_FOUND", "Job not found.", status_code=404)
    project = await _get_owned_project(job.project_id, user, db)

    if job.status not in ("failed", "canceled"):
        raise AppError(
            "VALIDATION_ERROR",
            "Only failed or canceled jobs can be retried.",
            status_code=400,
        )

    job.status = "queued"
    job.stage = "queued"
    job.progress = None
    job.error_code = None
    job.error_message_safe = None
    job.internal_diagnostics = None
    job.attempt_count = (job.attempt_count or 1) + 1
    job.started_at = None
    job.finished_at = None
    job.updated_at = utcnow()

    if job.kind == "export":
        project.status = "processing"
        project.updated_at = utcnow()

    await db.commit()
    await db.refresh(job)

    enqueue_job(job.id, job.kind)
    return JobResponse.model_validate(job)


@v1_router.get("/projects/{project_id}/outputs", response_model=List[AssetResponse])
async def list_project_outputs(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[AssetResponse]:
    project = await _get_owned_project(project_id, user, db)
    res = await db.execute(
        select(Asset)
        .where(
            Asset.project_id == project.id,
            Asset.kind == "output",
            Asset.status == "ready",
        )
        .order_by(Asset.created_at.desc())
    )
    return [_serialize_asset(a) for a in res.scalars().all()]


api_router.include_router(v1_router)
