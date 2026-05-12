"""Masking primitives: blur / pixelate / blackbox on arbitrary regions."""
from __future__ import annotations

from typing import Iterable, Tuple

import cv2
import numpy as np

from sanitizer.core.types import Detection, MaskMode


def _clip_bbox(bbox: Tuple[int, int, int, int], w: int, h: int) -> Tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    x1 = max(0, min(int(x1), w - 1))
    y1 = max(0, min(int(y1), h - 1))
    x2 = max(0, min(int(x2), w))
    y2 = max(0, min(int(y2), h))
    if x2 <= x1:
        x2 = min(w, x1 + 1)
    if y2 <= y1:
        y2 = min(h, y1 + 1)
    return x1, y1, x2, y2


def apply_blur(image: np.ndarray, bbox: Tuple[int, int, int, int], kernel: int = 51) -> np.ndarray:
    h, w = image.shape[:2]
    x1, y1, x2, y2 = _clip_bbox(bbox, w, h)
    roi = image[y1:y2, x1:x2]
    if roi.size == 0:
        return image
    k = max(3, kernel | 1)  # force odd
    # Heavy gaussian blur — irreversible for practical purposes
    blurred = cv2.GaussianBlur(roi, (k, k), sigmaX=0)
    # Second pass to fully destroy detail in larger regions
    blurred = cv2.GaussianBlur(blurred, (k, k), sigmaX=0)
    image[y1:y2, x1:x2] = blurred
    return image


def apply_pixelate(image: np.ndarray, bbox: Tuple[int, int, int, int], blocks: int = 12) -> np.ndarray:
    h, w = image.shape[:2]
    x1, y1, x2, y2 = _clip_bbox(bbox, w, h)
    roi = image[y1:y2, x1:x2]
    if roi.size == 0:
        return image
    rh, rw = roi.shape[:2]
    bw = max(1, rw // blocks)
    bh = max(1, rh // blocks)
    small = cv2.resize(roi, (bw, bh), interpolation=cv2.INTER_LINEAR)
    image[y1:y2, x1:x2] = cv2.resize(small, (rw, rh), interpolation=cv2.INTER_NEAREST)
    return image


def apply_blackbox(image: np.ndarray, bbox: Tuple[int, int, int, int]) -> np.ndarray:
    h, w = image.shape[:2]
    x1, y1, x2, y2 = _clip_bbox(bbox, w, h)
    image[y1:y2, x1:x2] = 0
    return image


def mask_regions(
    image: np.ndarray,
    detections: Iterable[Detection],
    mode: MaskMode = MaskMode.BLUR,
    blur_kernel: int = 51,
    padding: int = 4,
) -> np.ndarray:
    """Apply the chosen mask to every detection bbox. Returns the modified image (in-place safe copy)."""
    out = image.copy()
    h, w = out.shape[:2]
    for det in detections:
        x1, y1, x2, y2 = det.bbox
        # Keep face padding, but use tight boxes for text-level masking so
        # single-character redaction does not bleed into neighboring chars.
        pad = padding if det.kind.value == "face" else 0
        bbox = (x1 - pad, y1 - pad, x2 + pad, y2 + pad)
        bbox = _clip_bbox(bbox, w, h)
        if mode == MaskMode.PIXELATE:
            out = apply_pixelate(out, bbox)
        elif mode == MaskMode.BLACKBOX:
            out = apply_blackbox(out, bbox)
        else:
            out = apply_blur(out, bbox, kernel=blur_kernel)
    return out
