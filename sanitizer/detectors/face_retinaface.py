"""RetinaFace detector (via insightface) + ArcFace embeddings for identity matching.

This is the high-accuracy backend and also powers selective face blurring
(whitelist / blacklist identities) for video.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np

from sanitizer.config import settings
from sanitizer.core.types import Detection, DetectionKind
from sanitizer.detectors.base import FaceDetector
from sanitizer.utils import logger


class RetinaFaceDetector(FaceDetector):
    """Wraps insightface's `FaceAnalysis` (RetinaFace detector + ArcFace recognizer)."""

    def __init__(self, det_size: Tuple[int, int] = (640, 640)) -> None:
        from insightface.app import FaceAnalysis

        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if settings.device == "cuda" else ["CPUExecutionProvider"]
        self.app = FaceAnalysis(name="buffalo_l", root=str(settings.model_dir), providers=providers)
        self.app.prepare(ctx_id=0 if settings.device == "cuda" else -1, det_size=det_size)
        logger.info(f"RetinaFace ready (providers={providers})")

    def detect(self, image: np.ndarray) -> List[Detection]:
        # insightface expects BGR uint8
        faces = self.app.get(image)
        out: List[Detection] = []
        for f in faces:
            x1, y1, x2, y2 = [int(v) for v in f.bbox.tolist()]
            det = Detection(
                kind=DetectionKind.FACE,
                bbox=(x1, y1, x2, y2),
                confidence=float(f.det_score),
                label="face",
            )
            # ArcFace embedding for identity matching (selective blur)
            if getattr(f, "normed_embedding", None) is not None:
                det.extra["embedding"] = f.normed_embedding.astype(np.float32)
            out.append(det)
        return out

    @staticmethod
    def cosine(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))
