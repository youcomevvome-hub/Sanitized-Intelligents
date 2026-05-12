"""Quick smoke test: builds the pipeline lazily and sanitizes a tiny generated image.
Run with: pytest tests/ -q
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest


@pytest.fixture(scope="module")
def tmp_img(tmp_path_factory) -> Path:
    img = np.full((200, 400, 3), 240, dtype=np.uint8)
    cv2.putText(img, "ID: 1234567890", (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    p = tmp_path_factory.mktemp("data") / "card.png"
    cv2.imwrite(str(p), img)
    return p


def test_pipeline_image(tmp_img: Path, tmp_path: Path) -> None:
    pytest.importorskip("easyocr")
    pytest.importorskip("ultralytics")

    from sanitizer import SanitizerPipeline, SanitizeRequest

    out = tmp_path / "out.png"
    pipe = SanitizerPipeline(face_backend="yolo", ocr_backend="easyocr")
    result = pipe.sanitize(tmp_img, out, SanitizeRequest(redact_faces=False))
    assert out.exists()
    assert result.media_type == "image"
    # We injected a long digit run -> at least one NUMBER detection
    assert any(d.kind.value == "number" for d in result.detections)
