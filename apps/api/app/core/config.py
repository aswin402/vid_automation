from typing import List, Dict
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "AI Video Automation Platform"
    environment: str = "development"
    log_level: str = "INFO"
    database_url: str = "sqlite+aiosqlite:///./vid_automation.db"
    secret_key: str = "dev-secret-key-change-in-production-9f8e7d6c5b4a"
    signed_url_ttl_seconds: int = 900
    max_upload_bytes: int = 524_288_000  # 500 MB
    max_source_duration_seconds: int = 1800  # 30 minutes
    storage_dir: str = "./uploads"
    worker_temp_dir: str = "/tmp/vid_automation_work"
    ai_transcription_api_key: str = ""
    ai_transcription_model: str = "whisper-1"
    max_concurrent_jobs: int = 2

    allowed_fonts: List[str] = [
        "DejaVu Sans",
        "DejaVu Sans Bold",
        "Liberation Sans",
        "Ubuntu",
        "Noto Sans",
        "FreeSans",
        "Sans",
    ]

    supported_languages: List[Dict[str, str]] = [
        {"code": "auto", "name": "Auto-detect"},
        {"code": "en", "name": "English"},
        {"code": "es", "name": "Spanish"},
        {"code": "fr", "name": "French"},
        {"code": "de", "name": "German"},
        {"code": "pt", "name": "Portuguese"},
        {"code": "hi", "name": "Hindi"},
        {"code": "ja", "name": "Japanese"},
    ]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
