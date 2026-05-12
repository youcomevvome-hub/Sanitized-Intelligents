"""OCR detector backed by PaddleOCR. Higher accuracy on dense documents."""
from __future__ import annotations

from typing import List, Optional

import numpy as np

from sanitizer.config import settings
from sanitizer.core.types import Detection, DetectionKind
from sanitizer.detectors.base import TextDetector
from sanitizer.utils import logger


_LANG_MAP = {"en": "en", "fr": "french", "de": "german", "es": "spanish", "zh": "ch", "ar": "arabic"}


class PaddleOCRDetector(TextDetector):
    def __init__(self, langs: Optional[List[str]] = None) -> None:
        from paddleocr import PaddleOCR

        langs = langs or settings.ocr_langs
        # PaddleOCR is single-lang per instance; pick the first.
        lang = _LANG_MAP.get(langs[0], "en")
        use_gpu = settings.device == "cuda"
        self.ocr = PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=use_gpu, show_log=False)
        logger.info(f"PaddleOCR ready (lang={lang}, gpu={use_gpu})")

    def detect(self, image: np.ndarray) -> List[Detection]:
        result = self.ocr.ocr(image, cls=True)
        out: List[Detection] = []
        if not result:
            return out
        # PaddleOCR returns [[ [poly, (text, conf)], ... ]] for a single image
        page = result[0] if isinstance(result[0], list) else result
        for entry in page or []:
            poly, (text, conf) = entry
            if conf < settings.ocr_conf:
                continue
            xs = [int(p[0]) for p in poly]
            ys = [int(p[1]) for p in poly]
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


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    a_area = max(1, (ax2 - ax1) * (ay2 - ay1))
    b_area = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / float(a_area + b_area - inter)


class EnsembleOCRDetector(TextDetector):
    """Merge EasyOCR and PaddleOCR to improve OCR recall on mixed layouts."""

    def __init__(self, langs: Optional[List[str]] = None) -> None:
        from sanitizer.detectors.ocr_easyocr import EasyOCRDetector

        self.easy = EasyOCRDetector(langs)
        self.paddle = PaddleOCRDetector(langs)

    def detect(self, image: np.ndarray) -> List[Detection]:
        dets: List[Detection] = []
        for det_fn in (self.easy.detect, self.paddle.detect):
            try:
                dets.extend(det_fn(image))
            except Exception as e:
                logger.warning(f"OCR backend failed in ensemble: {e}")

        # Keep higher confidence when two models overlap the same region.
        dets = sorted(dets, key=lambda d: d.confidence, reverse=True)
        kept: List[Detection] = []
        for d in dets:
            if any(_iou(d.bbox, k.bbox) > 0.55 for k in kept):
                continue
            kept.append(d)
        return kept


def build_ocr_detector(backend: str, langs: Optional[List[str]] = None) -> TextDetector:
    backend = backend.lower()
    if backend == "paddleocr":
        return PaddleOCRDetector(langs)
    if backend == "ensemble":
        return EnsembleOCRDetector(langs)
    from sanitizer.detectors.ocr_easyocr import EasyOCRDetector
    return EasyOCRDetector(langs)
