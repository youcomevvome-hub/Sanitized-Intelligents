"""YOLOv8-face detector (Ultralytics).

Uses the open-source `yolov8n-face` / `yolov8m-face` weights. We auto-download
on first use into `settings.model_dir`. Falls back to the generic `yolov8n.pt`
person-detector if face weights are unavailable (still useful, but coarser).
"""
from __future__ import annotations

import os
import urllib.request
from pathlib import Path
from typing import List, Optional

import numpy as np

from sanitizer.config import settings
from sanitizer.core.types import Detection, DetectionKind
from sanitizer.detectors.base import FaceDetector
from sanitizer.utils import logger

# Community-maintained YOLOv8-face weights
_YOLO_FACE_URL = (
    "https://github.com/akanametov/yolov8-face/releases/download/v0.0.0/yolov8n-face.pt"
)
_YOLO_FACE_FILE = "yolov8n-face.pt"


def _ensure_weights(model_dir: Path) -> Path:
    target = model_dir / _YOLO_FACE_FILE
    if target.exists():
        return target
    model_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"Downloading YOLOv8-face weights -> {target}")
    try:
        urllib.request.urlretrieve(_YOLO_FACE_URL, target)
    except Exception as e:
        logger.warning(f"Failed to fetch yolov8-face weights ({e}); will fall back to yolov8n.pt at runtime.")
    return target


class YoloFaceDetector(FaceDetector):
    def __init__(self, conf: Optional[float] = None) -> None:
        from ultralytics import YOLO  # heavy import deferred

        self.conf = conf if conf is not None else settings.face_conf
        weights = _ensure_weights(settings.model_dir)
        if not weights.exists():
            # Ultralytics will auto-download the generic yolov8n on first use.
            weights = "yolov8n.pt"
        self.model = YOLO(str(weights))
        self.device = settings.device
        # face class index — for yolov8-face it's 0; for yolov8n it's "person" (0)
        self._face_only = str(weights).endswith(_YOLO_FACE_FILE)

    def detect(self, image: np.ndarray) -> List[Detection]:
        results = self.model.predict(
            image,
            conf=self.conf,
            device=self.device if self.device != "auto" else None,
            verbose=False,
        )
        out: List[Detection] = []
        for r in results:
            if r.boxes is None:
                continue
            for b in r.boxes:
                cls = int(b.cls[0]) if b.cls is not None else 0
                if not self._face_only and cls != 0:
                    continue
                xyxy = b.xyxy[0].cpu().numpy().astype(int).tolist()
                conf = float(b.conf[0]) if b.conf is not None else 1.0
                out.append(
                    Detection(
                        kind=DetectionKind.FACE,
                        bbox=tuple(xyxy),  # type: ignore[arg-type]
                        confidence=conf,
                        label="face",
                    )
                )
        return out
