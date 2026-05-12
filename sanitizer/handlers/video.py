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
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from sanitizer.config import settings
from sanitizer.core.blur import mask_regions
from sanitizer.core.types import Detection, DetectionKind, MaskMode, SanitizeRequest, SanitizeResult
from sanitizer.detectors.base import FaceDetector, TextDetector
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

    def enroll_from_image(self, identity_id: str, image_path: str, detector: FaceDetector) -> bool:
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


def _bbox_center(bbox: tuple[int, int, int, int]) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def _clip_bbox(bbox: tuple[int, int, int, int], w: int, h: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    x1 = max(0, min(int(x1), w - 1))
    y1 = max(0, min(int(y1), h - 1))
    x2 = max(x1 + 1, min(int(x2), w))
    y2 = max(y1 + 1, min(int(y2), h))
    return x1, y1, x2, y2


def _face_to_body_bbox(face_bbox: tuple[int, int, int, int], frame_w: int, frame_h: int) -> tuple[int, int, int, int]:
    """Approximate a body box around a face detection.

    This is intentionally conservative and works as a fallback when no dedicated
    person detector is available.
    """
    x1, y1, x2, y2 = face_bbox
    fw = max(1, x2 - x1)
    fh = max(1, y2 - y1)
    cx = (x1 + x2) / 2.0

    body_w = int(fw * 3.4)
    top = int(y1 - fh * 0.15)
    bottom = int(y2 + fh * 5.2)
    left = int(cx - body_w / 2)
    right = int(cx + body_w / 2)
    return _clip_bbox((left, top, right, bottom), frame_w, frame_h)


def _bbox_iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = float(iw * ih)
    if inter <= 0:
        return 0.0
    a_area = float(max(1, (ax2 - ax1) * (ay2 - ay1)))
    b_area = float(max(1, (bx2 - bx1) * (by2 - by1)))
    return inter / (a_area + b_area - inter + 1e-8)


def _pick_person_box_for_face(
    face_bbox: tuple[int, int, int, int],
    person_boxes: list[tuple[int, int, int, int]],
) -> Optional[tuple[int, int, int, int]]:
    if not person_boxes:
        return None

    fx1, fy1, fx2, fy2 = face_bbox
    fcx, fcy = _bbox_center(face_bbox)
    best_box: Optional[tuple[int, int, int, int]] = None
    best_score = -1.0

    for pb in person_boxes:
        px1, py1, px2, py2 = pb
        contains_face_center = px1 <= fcx <= px2 and py1 <= fcy <= py2
        iou = _bbox_iou(face_bbox, pb)
        score = iou + (1.0 if contains_face_center else 0.0)
        if score > best_score:
            best_score = score
            best_box = pb

    if best_box is None:
        return None
    if best_score <= 0.0:
        return None
    return best_box


def sanitize_video(
    input_path: str | Path,
    output_path: str | Path,
    face_det: FaceDetector,
    text_det: TextDetector,
    pii: PIITextAnalyzer,
    request: SanitizeRequest,
    gallery: Optional[IdentityGallery] = None,
    person_det: Optional[Any] = None,
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
    video_region_mode = (request.video_redaction_region or "face_only").lower()
    if video_region_mode not in {"face_only", "whole_body", "body_no_face"}:
        video_region_mode = "face_only"

    all_detections: List[Detection] = []
    cached_ocr_dets: List[Detection] = []
    frame_idx = 0

    whitelist = request.whitelist_face_ids or []
    blacklist = request.blacklist_face_ids or []
    gallery = gallery or IdentityGallery()
    tracks: Dict[str, tuple[float, float]] = {}
    next_track_id = 1

    def assign_track_id(d: Detection) -> str:
        nonlocal next_track_id
        cx, cy = _bbox_center(d.bbox)
        best: Optional[tuple[str, float]] = None
        for tid, (tx, ty) in tracks.items():
            dist = ((cx - tx) ** 2 + (cy - ty) ** 2) ** 0.5
            if best is None or dist < best[1]:
                best = (tid, dist)

        # Tight-ish gate; if no close track, create a new deterministic id.
        if best is None or best[1] > 90:
            tid = f"face_{next_track_id}"
            next_track_id += 1
        else:
            tid = best[0]
        tracks[tid] = (cx, cy)
        return tid

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        frame_dets: List[Detection] = []
        face_restore_boxes: List[tuple[int, int, int, int]] = []

        # ---- Faces (every frame) ----
        if request.redact_faces:
            try:
                face_dets = face_det.detect(frame)
            except Exception as e:
                logger.error(f"Face detection failed on frame {frame_idx}: {e}")
                face_dets = []
            # Stable ordering helps deterministic IDs across frames.
            face_dets.sort(key=lambda det: (det.bbox[0], det.bbox[1]))
            person_boxes: list[tuple[int, int, int, int]] = []
            if video_region_mode != "face_only" and face_dets and person_det is not None:
                try:
                    person_dets = person_det.detect(frame)
                    person_boxes = [tuple(map(int, d.bbox)) for d in person_dets if d.label == "person"]
                except Exception as e:
                    logger.warning(f"Person detection failed on frame {frame_idx}; using fallback body boxes: {e}")

            for d in face_dets:
                emb = d.extra.get("embedding") if d.extra else None
                identity = None
                if emb is not None and gallery.known:
                    matched = gallery.match(emb)
                    if matched:
                        identity = matched[0]
                if identity is None:
                    identity = assign_track_id(d)
                d.identity = identity
                d.frame = frame_idx
                if _should_blur(identity, whitelist, blacklist):
                    if video_region_mode == "face_only":
                        frame_dets.append(d)
                    else:
                        matched_person = _pick_person_box_for_face(d.bbox, person_boxes)
                        body_bbox = matched_person or _face_to_body_bbox(d.bbox, width, height)
                        frame_dets.append(
                            Detection(
                                kind=DetectionKind.CUSTOM,
                                bbox=body_bbox,
                                confidence=d.confidence,
                                label="BODY",
                                frame=frame_idx,
                                identity=d.identity,
                            )
                        )
                        if video_region_mode == "body_no_face":
                            face_restore_boxes.append(_clip_bbox(d.bbox, width, height))

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
        if face_restore_boxes:
            for x1, y1, x2, y2 in face_restore_boxes:
                masked[y1:y2, x1:x2] = frame[y1:y2, x1:x2]
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
            "person_detector": "yolo" if person_det is not None else "fallback",
        },
    )
