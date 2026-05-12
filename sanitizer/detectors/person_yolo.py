"""YOLOv8 person detector (Ultralytics, COCO class 0)."""
from __future__ import annotations

from typing import List, Optional

import numpy as np

from sanitizer.config import settings
from sanitizer.core.types import Detection, DetectionKind
from sanitizer.detectors.base import PersonDetector


class YoloPersonDetector(PersonDetector):
    def __init__(self, conf: Optional[float] = None) -> None:
        from ultralytics import YOLO  # heavy import deferred

        self.conf = conf if conf is not None else settings.person_conf
        self.model = YOLO("yolov8n.pt")
        self.device = settings.device

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
                cls = int(b.cls[0]) if b.cls is not None else -1
                if cls != 0:  # COCO person class
                    continue
                xyxy = b.xyxy[0].cpu().numpy().astype(int).tolist()
                conf = float(b.conf[0]) if b.conf is not None else 1.0
                out.append(
                    Detection(
                        kind=DetectionKind.CUSTOM,
                        bbox=tuple(xyxy),  # type: ignore[arg-type]
                        confidence=conf,
                        label="person",
                    )
                )
        return out
