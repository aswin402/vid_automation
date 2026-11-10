from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator


AnchorPosition = Literal[
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]

AssetKind = Literal[
    "source",
    "logo",
    "outro",
    "trimmed",
    "main_render",
    "output",
    "transcript_audio",
]


class TrimSettings(BaseModel):
    start_ms: int = Field(default=0, ge=0)
    end_ms: Optional[int] = Field(default=None, gt=0)


class OutputSettings(BaseModel):
    width: Optional[int] = Field(default=None, ge=120, le=3840)
    height: Optional[int] = Field(default=None, ge=120, le=3840)
    fps: Optional[float] = Field(default=None, ge=10.0, le=120.0)
    video_codec: str = "libx264"
    audio_codec: str = "aac"
    preset: str = "fast"
    crf: int = Field(default=20, ge=14, le=35)


class ColorCorrectionSettings(BaseModel):
    enabled: bool = False
    preset: str = "custom"
    brightness: float = Field(default=0.0, ge=-0.5, le=0.5)
    contrast: float = Field(default=1.0, ge=0.5, le=2.0)
    saturation: float = Field(default=1.0, ge=0.0, le=2.5)
    gamma: float = Field(default=1.0, ge=0.5, le=2.0)
    temperature: float = Field(default=0.0, ge=-1.0, le=1.0)
    tint: float = Field(default=0.0, ge=-1.0, le=1.0)
    sharpen: float = Field(default=0.0, ge=0.0, le=1.5)
    apply_to_outro: bool = False


class LogoSettings(BaseModel):
    enabled: bool = False
    asset_id: Optional[str] = None
    position: AnchorPosition = "top-right"
    x_ratio: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    y_ratio: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    width_ratio: float = Field(default=0.14, ge=0.03, le=0.50)
    opacity: float = Field(default=1.0, ge=0.05, le=1.0)
    margin_ratio: float = Field(default=0.03, ge=0.0, le=0.20)
    apply_to_outro: bool = False


class SubtitleStyleSettings(BaseModel):
    position: AnchorPosition = "bottom-center"
    x_ratio: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    y_ratio: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    font_family: str = "DejaVu Sans"
    font_size: int = Field(default=42, ge=12, le=120)
    text_color: str = "#FFFFFF"
    background_enabled: bool = False
    background_color: str = "#000000"
    background_opacity: float = Field(default=0.65, ge=0.0, le=1.0)
    outline_enabled: bool = True
    outline_color: str = "#000000"
    outline_thickness: int = Field(default=3, ge=0, le=10)
    shadow_enabled: bool = True
    shadow_depth: int = Field(default=2, ge=0, le=10)
    alignment: Literal["left", "center", "right"] = "center"
    margin_v_ratio: float = Field(default=0.06, ge=0.0, le=0.30)
    margin_h_ratio: float = Field(default=0.05, ge=0.0, le=0.30)


class SubtitlesSettings(BaseModel):
    enabled: bool = False
    language: str = "auto"
    style: SubtitleStyleSettings = Field(default_factory=SubtitleStyleSettings)


class OutroSettings(BaseModel):
    enabled: bool = False
    asset_id: Optional[str] = None
    normalization_mode: Literal["pad", "crop", "stretch"] = "pad"


class EditSettingsSchema(BaseModel):
    schema_version: int = 1
    trim: TrimSettings = Field(default_factory=TrimSettings)
    output: OutputSettings = Field(default_factory=OutputSettings)
    color_correction: ColorCorrectionSettings = Field(default_factory=ColorCorrectionSettings)
    logo: LogoSettings = Field(default_factory=LogoSettings)
    subtitles: SubtitlesSettings = Field(default_factory=SubtitlesSettings)
    outro: OutroSettings = Field(default_factory=OutroSettings)
    audio_policy: str = "sequential_preserve"


class AssetResponse(BaseModel):
    id: str
    project_id: str
    kind: str
    status: str
    storage_key: str
    original_filename: str
    mime_type: str
    size_bytes: int
    duration_ms: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    frame_rate: Optional[str] = None
    pixel_format: Optional[str] = None
    has_audio: bool = False
    checksum: Optional[str] = None
    stream_url: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class JobResponse(BaseModel):
    id: str
    project_id: str
    kind: str
    status: str
    stage: str
    progress: Optional[float] = None
    error_code: Optional[str] = None
    error_message_safe: Optional[str] = None
    attempt_count: int = 1
    subtitle_version: Optional[int] = None
    output_asset_id: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SubtitleCueItem(BaseModel):
    id: Optional[str] = None
    sequence: int = Field(ge=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=500)
    words_json: Optional[List[Dict[str, Any]]] = None

    @field_validator("text")
    @classmethod
    def normalize_cue_text(cls, v: str) -> str:
        # Strip control characters except newline
        cleaned = "".join(ch for ch in v if ch == "\n" or (ord(ch) >= 32 and ord(ch) != 127))
        lines = [" ".join(line.split()) for line in cleaned.splitlines()]
        cleaned = "\n".join(line for line in lines if line).strip()
        if not cleaned:
            raise ValueError("Subtitle cue text cannot be empty.")
        if len(cleaned.splitlines()) > 4:
            raise ValueError("Subtitle cue cannot exceed 4 lines.")
        return cleaned


class SubtitleVersionResponse(BaseModel):
    project_id: str
    version: int
    language: str
    timebase: str = "trimmed_clip"
    duration_ms: int
    cues: List[SubtitleCueItem]


class SubtitleVersionUpdateRequest(BaseModel):
    language: Optional[str] = "en"
    cues: List[SubtitleCueItem]


class ProjectCreate(BaseModel):
    name: str = Field(default="Untitled Video Project", min_length=1, max_length=255)


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    settings: Optional[EditSettingsSchema] = None


class ProjectResponse(BaseModel):
    id: str
    owner_id: str
    name: str
    status: str
    settings_json: Dict[str, Any]
    active_subtitle_version: int
    detected_language: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProjectDetailResponse(ProjectResponse):
    assets: List[AssetResponse] = Field(default_factory=list)
    jobs: List[JobResponse] = Field(default_factory=list)
    subtitle_cue_count: int = 0


class UploadUrlRequest(BaseModel):
    kind: Literal["source", "logo", "outro"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=3, max_length=128)
    size_bytes: int = Field(gt=0)


class UploadUrlResponse(BaseModel):
    asset_id: str
    storage_key: str
    upload_url: str
    method: str = "PUT"
    headers: Dict[str, str] = Field(default_factory=dict)
    expires_in_seconds: int


class UploadCompleteRequest(BaseModel):
    asset_id: str


class DownloadUrlResponse(BaseModel):
    asset_id: str
    filename: str
    download_url: str
    expires_in_seconds: int


class TranscriptionCreateRequest(BaseModel):
    language: str = "auto"
    confirm_overwrite: bool = False


class ExportCreateRequest(BaseModel):
    subtitle_version: Optional[int] = None
    idempotency_key: Optional[str] = None
