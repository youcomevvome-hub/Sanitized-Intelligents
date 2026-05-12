"""PDF handler: rasterize each page, sanitize like an image, re-bundle to PDF.

This approach (rasterize + redact + re-emit) is the safest for both digital
and scanned PDFs because it guarantees that hidden text layers / metadata
behind redacted boxes are gone in the output."""
from __future__ import annotations

from pathlib import Path
from typing import List

import cv2
import numpy as np

from sanitizer.config import settings
from sanitizer.core.blur import mask_regions
from sanitizer.core.types import Detection, MaskMode, SanitizeRequest, SanitizeResult
from sanitizer.detectors.base import FaceDetector, TextDetector
from sanitizer.detectors.pii_text import PIITextAnalyzer
from sanitizer.handlers.base import classify_ocr_detection
from sanitizer.utils import logger


def _render_pdf_pages(pdf_path: Path, dpi: int = 200) -> List[np.ndarray]:
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(str(pdf_path))
    pages: List[np.ndarray] = []
    scale = dpi / 72.0
    for page in pdf:
        pil_image = page.render(scale=scale).to_pil().convert("RGB")
        pages.append(cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR))
    pdf.close()
    return pages


def _pages_to_pdf(pages: List[np.ndarray], out_path: Path) -> None:
    from PIL import Image
    if not pages:
        raise ValueError("No pages to write.")
    pil_pages = [Image.fromarray(cv2.cvtColor(p, cv2.COLOR_BGR2RGB)) for p in pages]
    pil_pages[0].save(
        out_path,
        save_all=True,
        append_images=pil_pages[1:],
        format="PDF",
        resolution=200.0,
    )


def sanitize_pdf(
    input_path: str | Path,
    output_path: str | Path,
    face_det: FaceDetector,
    text_det: TextDetector,
    pii: PIITextAnalyzer,
    request: SanitizeRequest,
    dpi: int = 200,
) -> SanitizeResult:
    input_path = Path(input_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    pages = _render_pdf_pages(input_path, dpi=dpi)
    all_detections: List[Detection] = []
    redacted_pages: List[np.ndarray] = []

    mode = MaskMode(request.mask_mode.value if request.mask_mode else settings.mask_mode)
    kernel = request.blur_kernel or settings.blur_kernel

    for idx, page in enumerate(pages):
        dets: List[Detection] = []
        if request.redact_faces:
            try:
                for d in face_det.detect(page):
                    d.page = idx
                    dets.append(d)
            except Exception as e:
                logger.error(f"Face detection failed on page {idx}: {e}")

        if request.redact_numbers or request.redact_pii or request.keywords or request.custom_patterns:
            try:
                regions = text_det.detect(page)
            except Exception as e:
                logger.error(f"OCR failed on page {idx}: {e}")
                regions = []
            for r in regions:
                r.page = idx
                dets.extend(classify_ocr_detection(r, request, pii))

        redacted_pages.append(mask_regions(page, dets, mode=mode, blur_kernel=kernel))
        all_detections.extend(dets)

    _pages_to_pdf(redacted_pages, output_path)

    return SanitizeResult(
        output_path=str(output_path),
        detections=all_detections,
        media_type="pdf",
        meta={"pages": len(pages), "dpi": dpi},
    )
