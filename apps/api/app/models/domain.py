import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from sqlalchemy import (
    String,
    Integer,
    BigInteger,
    Float,
    Boolean,
    Text,
    DateTime,
    ForeignKey,
    JSON,
    Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


def default_edit_settings() -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "trim": {
            "start_ms": 0,
            "end_ms": None,
        },
        "output": {
            "width": None,
            "height": None,
            "fps": None,
            "video_codec": "libx264",
            "audio_codec": "aac",
            "preset": "fast",
            "crf": 20,
        },
        "color_correction": {
            "enabled": False,
            "preset": "custom",
            "brightness": 0.0,
            "contrast": 1.0,
            "saturation": 1.0,
            "gamma": 1.0,
            "temperature": 0.0,
            "tint": 0.0,
            "sharpen": 0.0,
            "apply_to_outro": False,
        },
        "logo": {
            "enabled": False,
            "asset_id": None,
            "position": "top-right",
            "x_ratio": None,
            "y_ratio": None,
            "width_ratio": 0.14,
            "opacity": 1.0,
            "margin_ratio": 0.03,
            "apply_to_outro": False,
        },
        "subtitles": {
            "enabled": False,
            "language": "auto",
            "style": {
                "position": "bottom-center",
                "x_ratio": None,
                "y_ratio": None,
                "font_family": "DejaVu Sans",
                "font_size": 42,
                "text_color": "#FFFFFF",
                "background_enabled": False,
                "background_color": "#000000",
                "background_opacity": 0.65,
                "outline_enabled": True,
                "outline_color": "#000000",
                "outline_thickness": 3,
                "shadow_enabled": True,
                "shadow_depth": 2,
                "alignment": "center",
                "margin_v_ratio": 0.06,
                "margin_h_ratio": 0.05,
            },
        },
        "outro": {
            "enabled": False,
            "asset_id": None,
            "normalization_mode": "pad",
        },
        "audio_policy": "sequential_preserve",
    }


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="Creator")
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    projects: Mapped[List["Project"]] = relationship(
        "Project", back_populates="owner", cascade="all, delete-orphan"
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="Untitled Video Project")
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="draft", index=True)
    settings_json: Mapped[Dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=default_edit_settings
    )
    active_subtitle_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    detected_language: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    owner: Mapped["User"] = relationship("User", back_populates="projects")
    assets: Mapped[List["Asset"]] = relationship(
        "Asset", back_populates="project", cascade="all, delete-orphan"
    )
    jobs: Mapped[List["ProcessingJob"]] = relationship(
        "ProcessingJob", back_populates="project", cascade="all, delete-orphan"
    )
    subtitle_cues: Mapped[List["SubtitleCue"]] = relationship(
        "SubtitleCue", back_populates="project", cascade="all, delete-orphan"
    )


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(
        String(50), nullable=False, index=True
    )  # source, logo, outro, trimmed, main_render, output, transcript_audio
    status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="pending_upload"
    )  # pending_upload, ready, failed
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    duration_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    video_codec: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    audio_codec: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    frame_rate: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    pixel_format: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    has_audio: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    checksum: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped["Project"] = relationship("Project", back_populates="assets")


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(50), nullable=False)  # transcribe, export
    status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="queued", index=True
    )
    stage: Mapped[str] = mapped_column(String(64), nullable=False, default="queued")
    progress: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    error_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    error_message_safe: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    internal_diagnostics: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    settings_snapshot_json: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    subtitle_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    output_asset_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped["Project"] = relationship("Project", back_populates="jobs")


class SubtitleCue(Base):
    __tablename__ = "subtitle_cues"
    __table_args__ = (
        Index("ix_subtitle_cues_project_version_seq", "project_id", "version", "sequence"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    words_json: Mapped[Optional[List[Dict[str, Any]]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped["Project"] = relationship("Project", back_populates="subtitle_cues")
