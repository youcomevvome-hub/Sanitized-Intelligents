"""Ensemble face detector: union of YOLOv8-face and RetinaFace boxes (NMS-merged).

This catches faces that either model misses individually — maximizing recall,
which is what we want for anonymization (false negatives = privacy leaks).
"""
from __future__ import annotations

from typing import List

import numpy as np

from sanitizer.core.types import Detection, DetectionKind
from sanitizer.detectors.base import FaceDetector
from sanitizer.utils import logger


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union


def _nms(dets: List[Detection], iou_thresh: float = 0.45) -> List[Detection]:
    dets = sorted(dets, key=lambda d: d.confidence, reverse=True)
    kept: List[Detection] = []
    for d in dets:
        if all(_iou(d.bbox, k.bbox) < iou_thresh for k in kept):
            kept.append(d)
    return kept


class EnsembleFaceDetector(FaceDetector):
    def __init__(self) -> None:
        from sanitizer.detectors.face_yolo import YoloFaceDetector
        from sanitizer.detectors.face_retinaface import RetinaFaceDetector

        self.detectors: List[FaceDetector] = []
        try:
            self.detectors.append(YoloFaceDetector())
        except Exception as e:
            logger.warning(f"YOLO face detector unavailable: {e}")
        try:
            self.detectors.append(RetinaFaceDetector())
        except Exception as e:
            logger.warning(f"RetinaFace detector unavailable: {e}")
        if not self.detectors:
            raise RuntimeError("No face detectors could be initialized.")

    def detect(self, image: np.ndarray) -> List[Detection]:
        all_dets: List[Detection] = []
        for d in self.detectors:
            try:
                all_dets.extend(d.detect(image))
            except Exception as e:
                logger.warning(f"Detector {type(d).__name__} failed: {e}")
        return _nms(all_dets)


def build_face_detector(backend: str) -> FaceDetector:
    backend = backend.lower()
    if backend == "yolo":
        from sanitizer.detectors.face_yolo import YoloFaceDetector
        return YoloFaceDetector()
    if backend == "retinaface":
        from sanitizer.detectors.face_retinaface import RetinaFaceDetector
        return RetinaFaceDetector()
    return EnsembleFaceDetector()
