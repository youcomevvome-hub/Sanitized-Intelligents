"""sanitizer — backend-agnostic PII anonymization engine."""
from sanitizer.core.pipeline import SanitizerPipeline
from sanitizer.core.types import (
    Detection,
    DetectionKind,
    SanitizeRequest,
    SanitizeResult,
    MaskMode,
)

__all__ = [
    "SanitizerPipeline",
    "Detection",
    "DetectionKind",
    "SanitizeRequest",
    "SanitizeResult",
    "MaskMode",
]
__version__ = "0.1.0"
