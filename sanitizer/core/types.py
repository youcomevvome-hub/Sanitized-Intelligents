"""Core data types used across detectors and handlers."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, List, Optional, Tuple


class DetectionKind(str, Enum):
    FACE = "face"
    TEXT = "text"             # any OCR'd text region (filtered later)
    NUMBER = "number"         # digit sequences
    PII = "pii"               # named PII (names, emails, SSN, etc.)
    CUSTOM = "custom"


class MaskMode(str, Enum):
    BLUR = "blur"
    PIXELATE = "pixelate"
    BLACKBOX = "blackbox"


@dataclass
class Detection:
    """A region to redact. bbox is (x1, y1, x2, y2) in pixel coords for visual media,
    or (start, end, 0, 0) char offsets for plain text."""
    kind: DetectionKind
    bbox: Tuple[int, int, int, int]
    confidence: float = 1.0
    label: str = ""           # e.g. "PERSON", "EMAIL_ADDRESS", "ID_NUMBER", or recognized text
    page: int = 0             # for PDFs/DOCX
    frame: int = 0            # for video
    identity: Optional[str] = None  # for selective face blur (matched person id)
    extra: dict = field(default_factory=dict)


@dataclass
class SanitizeRequest:
    """Optional knobs passed per-call to override settings."""
    mask_mode: Optional[MaskMode] = None
    blur_kernel: Optional[int] = None
    redact_faces: bool = True
    redact_numbers: bool = True
    redact_pii: bool = True
    # Text patterns to ALSO redact (regex, case-insensitive)
    custom_patterns: List[str] = field(default_factory=list)
    # Specific OCR strings to redact (exact, case-insensitive)
    keywords: List[str] = field(default_factory=list)
    # Selective face blur for video:
    #   whitelist_face_ids -> these identities are NOT blurred (e.g. consenting subjects)
    #   blacklist_face_ids -> ONLY these identities get blurred
    whitelist_face_ids: List[str] = field(default_factory=list)
    blacklist_face_ids: List[str] = field(default_factory=list)
    # OCR languages override
    ocr_langs: Optional[List[str]] = None
    # Keyword/character mask scope: "exact" | "word" | "sentence"
    # exact    -> mask only the matched characters
    # word     -> mask the whole word containing the match
    # sentence -> mask the whole OCR text region ("sentence" / line)
    blur_scope: str = "exact"


@dataclass
class SanitizeResult:
    output_path: str
    detections: List[Detection]
    media_type: str          # "image" | "pdf" | "docx" | "video" | "text"
    meta: dict = field(default_factory=dict)

    def summary(self) -> dict:
        counts: dict[str, int] = {}
        for d in self.detections:
            counts[d.kind.value] = counts.get(d.kind.value, 0) + 1
        return {
            "output": self.output_path,
            "media_type": self.media_type,
            "total_detections": len(self.detections),
            "by_kind": counts,
            **self.meta,
        }
