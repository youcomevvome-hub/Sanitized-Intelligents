"""Pydantic schemas for the API surface."""
from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class SanitizeOptions(BaseModel):
    mask_mode: str = Field("blur", description="blur | pixelate | blackbox")
    blur_kernel: Optional[int] = Field(None, ge=3, le=301)
    redact_faces: bool = True
    redact_numbers: bool = True
    redact_pii: bool = True
    custom_patterns: List[str] = Field(default_factory=list)
    keywords: List[str] = Field(default_factory=list)
    whitelist_face_ids: List[str] = Field(default_factory=list)
    blacklist_face_ids: List[str] = Field(default_factory=list)
    ocr_langs: Optional[List[str]] = None
    blur_scope: str = Field("exact", description="exact | word | sentence")


class SanitizeResponse(BaseModel):
    output: str
    media_type: str
    total_detections: int
    by_kind: Dict[str, int]
    meta: dict


class HealthResponse(BaseModel):
    status: str
    version: str
    face_backend: str
    ocr_backend: str
