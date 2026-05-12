"""High-level entry point: `SanitizerPipeline`.

Usage
-----
    from sanitizer import SanitizerPipeline, SanitizeRequest

    pipe = SanitizerPipeline()
    result = pipe.sanitize("input.pdf", "output.pdf")
    print(result.summary())

The pipeline lazily initializes detectors so importing is cheap.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from sanitizer.config import settings
from sanitizer.core.types import SanitizeRequest, SanitizeResult
from sanitizer.detectors.base import FaceDetector, PersonDetector, TextDetector
from sanitizer.detectors.face_ensemble import build_face_detector
from sanitizer.detectors.ocr_paddle import build_ocr_detector
from sanitizer.detectors.pii_text import PIITextAnalyzer
from sanitizer.utils import logger
from sanitizer.utils.io import detect_category


class SanitizerPipeline:
    def __init__(
        self,
        face_backend: Optional[str] = None,
        ocr_backend: Optional[str] = None,
        ocr_langs: Optional[list[str]] = None,
    ) -> None:
        self.face_backend = face_backend or settings.face_backend
        self.ocr_backend = ocr_backend or settings.ocr_backend
        self.ocr_langs = ocr_langs or settings.ocr_langs
        self._face_det: Optional[FaceDetector] = None
        self._text_det: Optional[TextDetector] = None
        self._person_det: Optional[PersonDetector] = None
        self._pii: Optional[PIITextAnalyzer] = None
        self._retinaface = None  # cached for video (needs embeddings)
        self._person_det_failed = False

    # ---- lazy detector accessors ----
    @property
    def face_det(self) -> FaceDetector:
        if self._face_det is None:
            logger.info(f"Loading face detector ({self.face_backend})…")
            self._face_det = build_face_detector(self.face_backend)
        return self._face_det

    @property
    def text_det(self) -> TextDetector:
        if self._text_det is None:
            logger.info(f"Loading OCR detector ({self.ocr_backend}, langs={self.ocr_langs})…")
            self._text_det = build_ocr_detector(self.ocr_backend, self.ocr_langs)
        return self._text_det

    @property
    def pii(self) -> PIITextAnalyzer:
        if self._pii is None:
            self._pii = PIITextAnalyzer(self.ocr_langs)
        return self._pii

    @property
    def person_det(self) -> Optional[PersonDetector]:
        if self._person_det is None and not self._person_det_failed:
            try:
                from sanitizer.detectors.person_yolo import YoloPersonDetector

                logger.info("Loading person detector (yolo person)\u2026")
                self._person_det = YoloPersonDetector()
            except Exception as e:
                self._person_det_failed = True
                logger.warning(f"Person detector unavailable; using face-to-body fallback: {e}")
        return self._person_det

    @property
    def retinaface(self):
        if self._retinaface is None:
            from sanitizer.detectors.face_retinaface import RetinaFaceDetector
            self._retinaface = RetinaFaceDetector()
        return self._retinaface

    # ---- main entry ----
    def sanitize(
        self,
        input_path: str | Path,
        output_path: str | Path,
        request: Optional[SanitizeRequest] = None,
        *,
        reference_faces: Optional[dict[str, list[str]]] = None,
    ) -> SanitizeResult:
        """Sanitize a file, auto-routing by detected type.

        Parameters
        ----------
        input_path / output_path : paths
        request : optional knobs (mask mode, what to redact, keywords, etc.)
        reference_faces : { identity_id: [ref_image_path, ...] }
            Used only for video selective blur. The identities used in
            `request.whitelist_face_ids` / `blacklist_face_ids` must be enrolled
            here.
        """
        request = request or SanitizeRequest()
        category = detect_category(input_path)
        logger.info(f"Sanitizing {input_path} (category={category}) -> {output_path}")

        if category == "image":
            from sanitizer.handlers.image import sanitize_image
            return sanitize_image(input_path, output_path, self.face_det, self.text_det, self.pii, request)

        if category == "pdf":
            from sanitizer.handlers.pdf import sanitize_pdf
            return sanitize_pdf(input_path, output_path, self.face_det, self.text_det, self.pii, request)

        if category == "docx":
            from sanitizer.handlers.docx import sanitize_docx
            return sanitize_docx(input_path, output_path, self.face_det, self.text_det, self.pii, request)

        if category == "text":
            from sanitizer.handlers.text import sanitize_text
            return sanitize_text(input_path, output_path, self.pii, request)

        if category == "video":
            from sanitizer.handlers.video import IdentityGallery, sanitize_video
            gallery = IdentityGallery()
            face_detector_for_video = self.face_det
            if reference_faces:
                # Reference-based identity matching needs embeddings from RetinaFace.
                face_detector_for_video = self.retinaface
                for ident_id, img_paths in reference_faces.items():
                    for ipath in img_paths:
                        ok = gallery.enroll_from_image(ident_id, ipath, face_detector_for_video)
                        if not ok:
                            logger.warning(f"Skipped enrollment for {ident_id} from {ipath}")
            return sanitize_video(
                input_path, output_path,
                face_detector_for_video, self.text_det, self.pii,
                request, gallery=gallery, person_det=self.person_det,
            )

        raise ValueError(f"Unsupported file type for {input_path} (detected={category})")
