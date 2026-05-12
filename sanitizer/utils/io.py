"""I/O helpers — file-type sniffing and safe path handling."""
from __future__ import annotations

from pathlib import Path
from typing import Literal

import filetype

FileCategory = Literal["image", "pdf", "docx", "video", "text", "unknown"]

_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp"}
_VIDEO_EXT = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
_TEXT_EXT = {".txt", ".csv", ".md", ".log", ".json"}


def detect_category(path: str | Path) -> FileCategory:
    p = Path(path)
    ext = p.suffix.lower()

    # Fast path via extension
    if ext in _IMAGE_EXT:
        return "image"
    if ext == ".pdf":
        return "pdf"
    if ext == ".docx":
        return "docx"
    if ext in _VIDEO_EXT:
        return "video"
    if ext in _TEXT_EXT:
        return "text"

    # Magic-byte fallback
    kind = filetype.guess(str(p))
    if kind is None:
        # last resort: try reading as text
        try:
            p.read_text(encoding="utf-8")
            return "text"
        except Exception:
            return "unknown"
    mime = kind.mime
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("video/"):
        return "video"
    if "wordprocessingml" in mime:
        return "docx"
    return "unknown"
