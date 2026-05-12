"""OCR detector backed by EasyOCR.

Returns one Detection per recognized text region. Downstream code can filter
to digit-only regions (numbers), keyword matches, or run PII NER on the strings.
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np

from sanitizer.config import settings
from sanitizer.core.types import Detection, DetectionKind
from sanitizer.detectors.base import TextDetector
from sanitizer.utils import logger


class EasyOCRDetector(TextDetector):
    def __init__(self, langs: Optional[List[str]] = None) -> None:
        import easyocr

        self.langs = langs or settings.ocr_langs
        gpu = settings.device == "cuda"
        self.reader = easyocr.Reader(self.langs, gpu=gpu, model_storage_directory=str(settings.model_dir))
        logger.info(f"EasyOCR ready (langs={self.langs}, gpu={gpu})")

    def detect(self, image: np.ndarray) -> List[Detection]:
        # easyocr accepts BGR ndarray
        results = self.reader.readtext(image, detail=1, paragraph=False)
        out: List[Detection] = []
        for bbox_pts, text, conf in results:
            if conf < settings.ocr_conf:
                continue
            xs = [int(p[0]) for p in bbox_pts]
            ys = [int(p[1]) for p in bbox_pts]
            bbox = (min(xs), min(ys), max(xs), max(ys))
            out.append(
                Detection(
                    kind=DetectionKind.TEXT,
                    bbox=bbox,
                    confidence=float(conf),
                    label=text,
                )
            )
        return out
