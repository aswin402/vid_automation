import hashlib
import hmac
import os
import time
import uuid
from pathlib import Path
from typing import Tuple
from app.core.config import settings
from app.exceptions.handlers import AppError


SAFE_EXTENSIONS = {
    "source": {".mp4": ".mp4", ".mov": ".mov", ".m4v": ".m4v", ".webm": ".webm"},
    "outro": {".mp4": ".mp4", ".mov": ".mov", ".m4v": ".m4v", ".webm": ".webm"},
    "logo": {".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpeg", ".webp": ".webp"},
    "output": {".mp4": ".mp4"},
}


class StorageService:
    """
    Manages private object storage keys, HMAC-signed upload/download tokens,
    and local/object-storage file persistence without ever using user filenames as filesystem paths.
    """

    def __init__(self, base_dir: str | None = None):
        self.base_path = Path(base_dir or settings.storage_dir).resolve()
        self.base_path.mkdir(parents=True, exist_ok=True)

    def generate_storage_key(self, project_id: str, kind: str, original_filename: str) -> str:
        ext = Path(original_filename).suffix.lower()
        allowed_map = SAFE_EXTENSIONS.get(kind, {".mp4": ".mp4"})
        if ext not in allowed_map:
            if kind == "logo":
                raise AppError(
                    "UNSUPPORTED_MEDIA",
                    "This logo format isn't supported. Upload a PNG, JPEG, or WebP image.",
                    status_code=400,
                )
            raise AppError(
                "UNSUPPORTED_MEDIA",
                "This file format isn't supported. Upload an MP4 or MOV video.",
                status_code=400,
            )
        safe_ext = allowed_map[ext]
        object_uuid = uuid.uuid4().hex
        return f"projects/{project_id}/{kind}/{object_uuid}{safe_ext}"

    def resolve_path(self, storage_key: str) -> Path:
        # Prevent path traversal
        candidate = (self.base_path / storage_key).resolve()
        if not str(candidate).startswith(str(self.base_path)):
            raise AppError("FORBIDDEN", "Invalid storage key.", status_code=403)
        return candidate

    def create_signed_token(
        self, asset_id: str, action: str, expires_in: int | None = None
    ) -> Tuple[str, int]:
        ttl = expires_in or settings.signed_url_ttl_seconds
        exp = int(time.time()) + ttl
        payload = f"{asset_id}:{action}:{exp}"
        sig = hmac.new(
            settings.secret_key.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"{exp}.{sig}", ttl

    def verify_signed_token(self, asset_id: str, action: str, token: str) -> bool:
        try:
            exp_str, sig = token.split(".", 1)
            exp = int(exp_str)
        except Exception:
            return False
        if int(time.time()) > exp:
            return False
        payload = f"{asset_id}:{action}:{exp}"
        expected_sig = hmac.new(
            settings.secret_key.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(sig, expected_sig)

    @staticmethod
    def compute_sha256(file_path: Path) -> str:
        digest = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def delete_key(self, storage_key: str) -> None:
        try:
            target = self.resolve_path(storage_key)
            if target.exists():
                os.remove(target)
        except Exception:
            pass


storage_service = StorageService()
