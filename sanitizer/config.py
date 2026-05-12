"""Central configuration. Reads env vars with sane defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List
import tempfile


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _resolve_device(value: str) -> str:
    if value != "auto":
        return value
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


@dataclass
class Settings:
    device: str = field(default_factory=lambda: _resolve_device(_env("SANITIZER_DEVICE", "auto")))
    model_dir: Path = field(default_factory=lambda: Path(_env("SANITIZER_MODEL_DIR", "./models")).resolve())

    # Detection backends
    face_backend: str = field(default_factory=lambda: _env("SANITIZER_FACE_BACKEND", "ensemble"))
    ocr_backend: str = field(default_factory=lambda: _env("SANITIZER_OCR_BACKEND", "easyocr"))
    ocr_langs: List[str] = field(
        default_factory=lambda: [s.strip() for s in _env("SANITIZER_OCR_LANGS", "en").split(",") if s.strip()]
    )

    # Masking
    blur_kernel: int = field(default_factory=lambda: int(_env("SANITIZER_BLUR_KERNEL", "51")))
    mask_mode: str = field(default_factory=lambda: _env("SANITIZER_MASK_MODE", "blur"))

    # Thresholds
    face_conf: float = 0.35
    person_conf: float = field(default_factory=lambda: float(_env("SANITIZER_PERSON_CONF", "0.25")))
    ocr_conf: float = 0.30

    # API
    api_host: str = field(default_factory=lambda: _env("SANITIZER_API_HOST", "0.0.0.0"))
    api_port: int = field(default_factory=lambda: int(_env("SANITIZER_API_PORT", "8000")))
    max_upload_mb: int = field(default_factory=lambda: int(_env("SANITIZER_MAX_UPLOAD_MB", "200")))

    def __post_init__(self) -> None:
        try:
            self.model_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Serverless platforms often mount app code as read-only.
            self.model_dir = Path(tempfile.gettempdir()) / "sanitize-models"
            self.model_dir.mkdir(parents=True, exist_ok=True)
        if self.blur_kernel % 2 == 0:
            self.blur_kernel += 1


settings = Settings()
