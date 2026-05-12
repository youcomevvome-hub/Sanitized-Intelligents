"""Video handler with **selective face blur**.

How selective blur works
------------------------
We enroll one or more reference faces (by passing reference image file paths
to `enroll_identity`) and tag them as "whitelist" (do NOT blur) or
"blacklist" (ONLY blur these).

At inference time we use RetinaFace + ArcFace embeddings from `insightface`
to detect and embed every face in each frame. Each detected face is matched
against the enrolled gallery by cosine similarity; the result determines
whether that face gets blurred.

Modes
-----
* No lists provided      -> blur every face (default).
* whitelist provided     -> blur every face EXCEPT enrolled whitelist IDs.
* blacklist provided     -> blur ONLY enrolled blacklist IDs.
* both provided          -> blacklist takes priority.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from sanitizer.config import settings
from sanitizer.core.blur import mask_regions
from sanitizer.core.types import Detection, DetectionKind, MaskMode, SanitizeRequest, SanitizeResult
from sanitizer.detectors.base import TextDetector
from sanitizer.detectors.face_retinaface import RetinaFaceDetector
from sanitizer.detectors.pii_text import PIITextAnalyzer
from sanitizer.handlers.base import classify_ocr_detection
from sanitizer.utils import logger


class IdentityGallery:
    """Stores named ArcFace embeddings for selective blurring."""

    def __init__(self, threshold: float = 0.40) -> None:
        self.threshold = threshold
        self._embeddings: Dict[str, List[np.ndarray]] = {}

    def enroll(self, identity_id: str, embedding: np.ndarray) -> None:
        self._embeddings.setdefault(identity_id, []).append(embedding.astype(np.float32))

    def enroll_from_image(self, identity_id: str, image_path: str, detector: RetinaFaceDetector) -> bool:
        img = cv2.imread(image_path)
        if img is None:
            logger.warning(f"Cannot read reference image {image_path}")
            return False
        dets = detector.detect(img)
        # take the largest face
        if not dets:
            logger.warning(f"No face detected in reference image {image_path}")
            return False
        dets.sort(key=lambda d: (d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]), reverse=True)
        emb = dets[0].extra.get("embedding")
        if emb is None:
            return False
        self.enroll(identity_id, emb)
        return True

    def match(self, embedding: np.ndarray) -> Optional[Tuple[str, float]]:
        best: Optional[Tuple[str, float]] = None
        for name, embs in self._embeddings.items():
            for ref in embs:
                score = float(np.dot(embedding, ref) / (np.linalg.norm(embedding) * np.linalg.norm(ref) + 1e-8))
                if score >= self.threshold and (best is None or score > best[1]):
                    best = (name, score)
        return best

    @property
    def known(self) -> List[str]:
        return list(self._embeddings.keys())


def _should_blur(identity: Optional[str], whitelist: List[str], blacklist: List[str]) -> bool:
    if blacklist:
        return identity is not None and identity in blacklist
    if whitelist:
        return identity is None or identity not in whitelist
    return True  # default: blur everyone


def sanitize_video(
    input_path: str | Path,
    output_path: str | Path,
    face_det: RetinaFaceDetector,
    text_det: TextDetector,
    pii: PIITextAnalyzer,
    request: SanitizeRequest,
    gallery: Optional[IdentityGallery] = None,
    ocr_every_n_frames: int = 30,
) -> SanitizeResult:
    """Sanitize a video file frame-by-frame.

    * Face detection runs every frame (cheap with RetinaFace on GPU; tunable).
    * OCR runs every `ocr_every_n_frames` frames (full-frame OCR is expensive).
    * Selective blur uses `gallery` matched against `request.whitelist_face_ids`
      / `request.blacklist_face_ids`.
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))

    mode = MaskMode(request.mask_mode.value if request.mask_mode else settings.mask_mode)
    kernel = request.blur_kernel or settings.blur_kernel

    all_detections: List[Detection] = []
    cached_ocr_dets: List[Detection] = []
    frame_idx = 0

    whitelist = request.whitelist_face_ids or []
    blacklist = request.blacklist_face_ids or []
    gallery = gallery or IdentityGallery()

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        frame_dets: List[Detection] = []

        # ---- Faces (every frame) ----
        if request.redact_faces:
            try:
                face_dets = face_det.detect(frame)
            except Exception as e:
                logger.error(f"Face detection failed on frame {frame_idx}: {e}")
                face_dets = []
            for d in face_dets:
                emb = d.extra.get("embedding") if d.extra else None
                identity = None
                if emb is not None and gallery.known:
                    matched = gallery.match(emb)
                    if matched:
                        identity = matched[0]
                d.identity = identity
                d.frame = frame_idx
                if _should_blur(identity, whitelist, blacklist):
                    frame_dets.append(d)

        # ---- OCR (periodic) ----
        if request.redact_numbers or request.redact_pii or request.keywords or request.custom_patterns:
            if frame_idx % ocr_every_n_frames == 0:
                try:
                    regions = text_det.detect(frame)
                except Exception as e:
                    logger.error(f"OCR failed on frame {frame_idx}: {e}")
                    regions = []
                cached_ocr_dets = []
                for r in regions:
                    r.frame = frame_idx
                    cached_ocr_dets.extend(classify_ocr_detection(r, request, pii))
            for d in cached_ocr_dets:
                # carry forward between OCR refreshes (text in video is usually static)
                fd = Detection(
                    kind=d.kind, bbox=d.bbox, confidence=d.confidence,
                    label=d.label, frame=frame_idx,
                )
                frame_dets.append(fd)

        masked = mask_regions(frame, frame_dets, mode=mode, blur_kernel=kernel)
        writer.write(masked)
        all_detections.extend(frame_dets)
        frame_idx += 1

    cap.release()
    writer.release()

    return SanitizeResult(
        output_path=str(output_path),
        detections=all_detections,
        media_type="video",
        meta={
            "frames": frame_idx,
            "fps": fps,
            "width": width,
            "height": height,
            "known_identities": gallery.known,
        },
    )
