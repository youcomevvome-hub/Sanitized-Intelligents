"""Image handler: detect faces + OCR text, classify, mask, write output."""
from __future__ import annotations

from pathlib import Path
from typing import List

import cv2
import numpy as np

from sanitizer.config import settings
from sanitizer.core.blur import mask_regions
from sanitizer.core.types import Detection, MaskMode, SanitizeRequest, SanitizeResult
from sanitizer.detectors.base import FaceDetector, TextDetector
from sanitizer.detectors.pii_text import PIITextAnalyzer
from sanitizer.handlers.base import classify_ocr_detection
from sanitizer.utils import logger


def sanitize_image(
    input_path: str | Path,
    output_path: str | Path,
    face_det: FaceDetector,
    text_det: TextDetector,
    pii: PIITextAnalyzer,
    request: SanitizeRequest,
) -> SanitizeResult:
    input_path = Path(input_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    image = cv2.imread(str(input_path))
    if image is None:
        # OpenCV can't read some formats — fall back to PIL
        from PIL import Image
        pil = Image.open(input_path).convert("RGB")
        image = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

    detections: List[Detection] = []

    # Faces
    if request.redact_faces:
        try:
            detections.extend(face_det.detect(image))
        except Exception as e:
            logger.error(f"Face detection failed: {e}")

    # OCR + per-region classification (numbers / PII / keywords)
    if request.redact_numbers or request.redact_pii or request.keywords or request.custom_patterns:
        try:
            ocr_regions = text_det.detect(image)
        except Exception as e:
            logger.error(f"OCR failed: {e}")
            ocr_regions = []
        for r in ocr_regions:
            detections.extend(classify_ocr_detection(r, request, pii))

    mode = MaskMode(request.mask_mode.value if request.mask_mode else settings.mask_mode)
    kernel = request.blur_kernel or settings.blur_kernel
    masked = mask_regions(image, detections, mode=mode, blur_kernel=kernel)

    cv2.imwrite(str(output_path), masked)
    return SanitizeResult(
        output_path=str(output_path),
        detections=detections,
        media_type="image",
        meta={"width": image.shape[1], "height": image.shape[0]},
    )
