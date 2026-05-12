"""Pre-fetch all model weights so the first request is fast.

Run inside the container or in your dev env:
    python scripts/download_models.py
"""
from __future__ import annotations

from sanitizer.config import settings
from sanitizer.utils import logger


def main() -> None:
    logger.info(f"Models will be stored in {settings.model_dir}")

    # YOLOv8-face
    logger.info("Fetching YOLOv8-face …")
    from sanitizer.detectors.face_yolo import YoloFaceDetector
    YoloFaceDetector()

    # RetinaFace + ArcFace
    logger.info("Fetching RetinaFace / ArcFace …")
    from sanitizer.detectors.face_retinaface import RetinaFaceDetector
    RetinaFaceDetector()

    # EasyOCR
    logger.info("Fetching EasyOCR weights …")
    from sanitizer.detectors.ocr_easyocr import EasyOCRDetector
    EasyOCRDetector()

    # spaCy / Presidio
    logger.info("Initializing Presidio …")
    from sanitizer.detectors.pii_text import PIITextAnalyzer
    PIITextAnalyzer()

    logger.info("All models ready.")


if __name__ == "__main__":
    main()
