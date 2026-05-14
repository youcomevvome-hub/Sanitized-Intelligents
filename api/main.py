"""FastAPI service exposing the sanitizer.

Endpoints
---------
GET  /health             -> liveness + config
POST /sanitize           -> multipart upload, returns sanitized file
POST /sanitize/info      -> same but returns detection JSON only (no file)
POST /sanitize/video     -> sanitize video with optional reference face uploads
                            for selective blur
"""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import uuid
import zipfile
import base64
from pathlib import Path
from typing import Any, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from api.schemas import HealthResponse, SanitizeOptions, SanitizeResponse
from sanitizer.config import settings
from sanitizer.core.types import MaskMode, SanitizeRequest
from sanitizer.utils import logger
from sanitizer.utils.io import detect_category

try:
    from sanitizer import __version__
except Exception:
    __version__ = "0.1.0"

app = FastAPI(
    title="Sanitizer API",
    description="Anonymize faces, IDs, numbers, and PII in images, PDFs, DOCX, video and text.",
    version=__version__,
)

# Allow any backend (Node, Java, Go, .NET, etc.) to call the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Sanitizer-Summary", "Content-Disposition"],
)

# Persistent document library (Alfresco-style).
try:
    from api.library import router as library_router  # noqa: E402

    app.include_router(library_router)
except Exception as e:
    logger.warning(f"Library routes disabled at startup: {e}")

# Mount the static frontend if present.
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if _FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_FRONTEND_DIR)), name="static")

    @app.get("/", include_in_schema=False)
    def _index(page: str = Query("landing")) -> FileResponse:
        page_map = {
            "landing": "landing.html",
            "dashboard": "dashboard.html",
            "intelligence": "intelligence.html",
            "how-it-works": "how-it-works.html",
            "api-docs": "api-docs.html",
        }
        page_file = page_map.get(page, "landing.html")
        return FileResponse(_FRONTEND_DIR / page_file)

# Singleton pipeline (loaded lazily on first request)
_pipeline: Optional[Any] = None


def get_pipeline() -> Any:
    global _pipeline
    if _pipeline is None:
        # Delay heavy ML imports until needed so serverless startup stays healthy.
        from sanitizer.core.pipeline import SanitizerPipeline

        _pipeline = SanitizerPipeline()
    return _pipeline


def _options_to_request(opts: SanitizeOptions) -> SanitizeRequest:
    try:
        mode = MaskMode(opts.mask_mode)
    except ValueError:
        raise HTTPException(400, f"Invalid mask_mode: {opts.mask_mode}")
    return SanitizeRequest(
        mask_mode=mode,
        blur_kernel=opts.blur_kernel,
        redact_faces=opts.redact_faces,
        redact_numbers=opts.redact_numbers,
        redact_pii=opts.redact_pii,
        custom_patterns=opts.custom_patterns,
        keywords=opts.keywords,
        replacement_text=opts.replacement_text,
        custom_replacements=opts.custom_replacements,
        whitelist_face_ids=opts.whitelist_face_ids,
        blacklist_face_ids=opts.blacklist_face_ids,
        ocr_langs=opts.ocr_langs,
        blur_scope=(opts.blur_scope or "exact").lower(),
        video_redaction_region=(opts.video_redaction_region or "face_only").lower(),
    )


def _check_size(upload: UploadFile) -> None:
    # FastAPI streams to disk; we rely on the reverse proxy / settings for hard limits.
    # The check below is informational.
    if upload.size is not None and upload.size > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File too large (>{settings.max_upload_mb}MB)")


def _save_upload(upload: UploadFile, dest: Path) -> None:
    with dest.open("wb") as f:
        shutil.copyfileobj(upload.file, f)


def _read_image(path: Path) -> Any:
    import cv2
    import numpy as np

    image = cv2.imread(str(path))
    if image is not None:
        return image
    from PIL import Image

    pil = Image.open(path).convert("RGB")
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _extract_search_text(path: Path, category: str, pipe: SanitizerPipeline) -> str:
    if category == "text":
        return path.read_text(encoding="utf-8", errors="ignore")

    if category == "docx":
        from docx import Document

        doc = Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs if p.text)

    if category == "image":
        image = _read_image(path)
        return " ".join(d.label for d in pipe.text_det.detect(image) if d.label)

    if category == "pdf":
        from sanitizer.handlers.pdf import _render_pdf_pages

        pages = _render_pdf_pages(path, dpi=220)
        chunks: List[str] = []
        for page in pages:
            chunks.extend(d.label for d in pipe.text_det.detect(page) if d.label)
        return " ".join(chunks)

    return ""


def _tokenize(text: str) -> List[str]:
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


def _parse_options_json(options: str) -> SanitizeOptions:
    try:
        return SanitizeOptions.model_validate_json(options)
    except Exception as e:
        raise HTTPException(400, f"Invalid options JSON: {e}")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=__version__,
        face_backend=settings.face_backend,
        ocr_backend=settings.ocr_backend,
    )


@app.post("/sanitize", response_class=FileResponse)
async def sanitize_file(
    file: UploadFile = File(...),
    options: str = Form("{}", description="JSON-encoded SanitizeOptions"),
):
    """Sanitize a single file and return the redacted file."""
    _check_size(file)
    try:
        opts = SanitizeOptions.model_validate_json(options)
    except Exception as e:
        raise HTTPException(400, f"Invalid options JSON: {e}")
    request = _options_to_request(opts)

    workdir = Path(tempfile.mkdtemp(prefix="sanitize_"))
    src = workdir / (file.filename or f"input_{uuid.uuid4().hex}")
    _save_upload(file, src)

    category = detect_category(src)
    if category == "unknown":
        raise HTTPException(415, f"Unsupported file type for {file.filename}")
    if category == "video":
        raise HTTPException(400, "Use /sanitize/video for video files (supports reference faces).")

    suffix = {
        "image": ".png",
        "pdf": ".pdf",
        "docx": ".docx",
        "text": src.suffix or ".txt",
    }[category]
    out = workdir / f"sanitized_{uuid.uuid4().hex}{suffix}"

    try:
        result = get_pipeline().sanitize(src, out, request)
    except Exception as e:
        logger.exception("Sanitize failed")
        raise HTTPException(500, f"Sanitize failed: {e}")

    return FileResponse(
        path=result.output_path,
        filename=f"sanitized_{file.filename}",
        headers={"X-Sanitizer-Summary": json.dumps(result.summary())},
    )


@app.post("/sanitize/info", response_model=SanitizeResponse)
async def sanitize_info(
    file: UploadFile = File(...),
    options: str = Form("{}"),
):
    """Sanitize and return only the JSON detection summary (file written to a temp path)."""
    _check_size(file)
    opts = _parse_options_json(options)
    request = _options_to_request(opts)

    workdir = Path(tempfile.mkdtemp(prefix="sanitize_"))
    src = workdir / (file.filename or f"input_{uuid.uuid4().hex}")
    _save_upload(file, src)
    out = workdir / f"sanitized_{src.name}"

    try:
        result = get_pipeline().sanitize(src, out, request)
    except Exception as e:
        logger.exception("Sanitize failed")
        raise HTTPException(500, f"Sanitize failed: {e}")

    return SanitizeResponse(
        output=result.output_path,
        media_type=result.media_type,
        total_detections=len(result.detections),
        by_kind=result.summary()["by_kind"],
        meta=result.meta,
    )


@app.post("/sanitize/video", response_class=FileResponse)
async def sanitize_video_endpoint(
    file: UploadFile = File(..., description="Video file"),
    options: str = Form("{}"),
    reference_faces: Optional[List[UploadFile]] = File(
        None, description="Reference face images named like <identity_id>.jpg",
    ),
):
    """Sanitize a video. Upload reference face images for selective blur.

    The filename (without extension) of each reference image is taken as the
    identity_id. Use those ids in `options.whitelist_face_ids` /
    `options.blacklist_face_ids`."""
    _check_size(file)
    opts = _parse_options_json(options)
    request = _options_to_request(opts)

    workdir = Path(tempfile.mkdtemp(prefix="sanitize_video_"))
    src = workdir / (file.filename or "video.mp4")
    _save_upload(file, src)

    ref_map: dict[str, list[str]] = {}
    for ref in reference_faces or []:
        if not ref.filename:
            continue
        ident_id = Path(ref.filename).stem
        ref_path = workdir / ref.filename
        _save_upload(ref, ref_path)
        ref_map.setdefault(ident_id, []).append(str(ref_path))

    out = workdir / f"sanitized_{uuid.uuid4().hex}.mp4"
    try:
        result = get_pipeline().sanitize(src, out, request, reference_faces=ref_map)
    except Exception as e:
        logger.exception("Video sanitize failed")
        raise HTTPException(500, f"Sanitize failed: {e}")

    return FileResponse(
        path=result.output_path,
        filename=f"sanitized_{file.filename}",
        headers={"X-Sanitizer-Summary": json.dumps(result.summary())},
    )


@app.post("/sanitize/video/faces", response_class=JSONResponse)
async def preview_video_faces(
    file: UploadFile = File(..., description="Video file for face preview"),
):
    """Detect candidate faces from the first frames and return thumbnail previews.

    IDs (`face_1`, `face_2`, ...) are deterministic for the preview ordering and
    can be used with `whitelist_face_ids` / `blacklist_face_ids` in `/sanitize/video`.
    """
    _check_size(file)
    workdir = Path(tempfile.mkdtemp(prefix="sanitize_video_preview_"))
    src = workdir / (file.filename or f"video_{uuid.uuid4().hex}.mp4")
    _save_upload(file, src)

    import cv2

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise HTTPException(400, "Cannot open video")

    detector = get_pipeline().face_det
    faces_payload: list[dict[str, Any]] = []
    from sanitizer.handlers.video import _detect_faces_robust

    try:
        # Scan early sampled frames until we find faces; this is more robust
        # than relying on a single frame and still keeps deterministic IDs.
        for frame_idx in range(45):
            ok, frame = cap.read()
            if not ok:
                break
            detections = _detect_faces_robust(
                detector,
                frame,
                frame_idx=frame_idx,
                orientation_retry_every=1,
            )
            detections.sort(key=lambda d: (d.bbox[0], d.bbox[1]))
            if not detections:
                continue

            for idx, d in enumerate(detections, start=1):
                x1, y1, x2, y2 = d.bbox
                x1 = max(0, min(frame.shape[1] - 1, x1))
                y1 = max(0, min(frame.shape[0] - 1, y1))
                x2 = max(x1 + 1, min(frame.shape[1], x2))
                y2 = max(y1 + 1, min(frame.shape[0], y2))
                crop = frame[y1:y2, x1:x2]
                ok_enc, buf = cv2.imencode(".jpg", crop)
                thumb = base64.b64encode(buf.tobytes()).decode("ascii") if ok_enc else ""
                faces_payload.append(
                    {
                        "id": f"face_{idx}",
                        "bbox": [int(x1), int(y1), int(x2), int(y2)],
                        "thumbnail": thumb,
                    }
                )
            break
    finally:
        cap.release()

    return JSONResponse({"faces": faces_payload})


@app.post("/sanitize/search", response_class=JSONResponse)
async def search_documents(
    files: List[UploadFile] = File(..., description="Multiple files to index for search"),
    query: str = Form(..., description="Text, number, or signature query"),
    mode: str = Form("text", description="text | number | image | signature"),
    query_image: Optional[UploadFile] = File(None, description="Optional query image for image mode"),
):
    """Search across uploaded files using OCR + text extraction.

    - text: case-insensitive text lookup
    - number: digit-sequence lookup
    - image: OCR query image then semantic token overlap
    - signature: looks for signature-related terms in extracted text
    """
    mode = mode.strip().lower()
    if mode not in {"text", "number", "image", "signature"}:
        raise HTTPException(400, "mode must be one of: text, number, image, signature")

    q = (query or "").strip()
    if not q and mode != "signature":
        raise HTTPException(400, "query is required for this mode")

    workdir = Path(tempfile.mkdtemp(prefix="sanitize_search_"))
    pipe = get_pipeline()

    image_query_tokens: List[str] = []
    if mode == "image" and query_image is not None:
        qpath = workdir / (query_image.filename or f"query_{uuid.uuid4().hex}.png")
        _save_upload(query_image, qpath)
        qimg = _read_image(qpath)
        image_query_tokens = _tokenize(" ".join(d.label for d in pipe.text_det.detect(qimg) if d.label))

    query_tokens = set(_tokenize(q))
    query_digits = re.sub(r"\D+", "", q)
    signature_terms = {"signature", "signed", "signatory", "authorized sign"}

    results = []
    for upload in files:
        src = workdir / (upload.filename or f"file_{uuid.uuid4().hex}")
        _save_upload(upload, src)
        category = detect_category(src)
        if category == "unknown" or category == "video":
            continue

        try:
            text_blob = _extract_search_text(src, category, pipe)
        except Exception as e:
            logger.warning(f"Search extraction failed for {src.name}: {e}")
            continue

        lowered = text_blob.lower()
        matched = False
        score = 0.0

        if mode == "text":
            matched = q.lower() in lowered
            if matched:
                score = min(1.0, len(q) / max(1, len(text_blob))) + 0.5
        elif mode == "number":
            doc_digits = re.sub(r"\D+", "", text_blob)
            matched = bool(query_digits) and query_digits in doc_digits
            if matched:
                score = 0.85
        elif mode == "signature":
            matched = any(term in lowered for term in signature_terms)
            if matched:
                score = 0.75
        else:  # image mode
            doc_tokens = set(_tokenize(text_blob))
            token_basis = set(image_query_tokens) if image_query_tokens else query_tokens
            overlap = token_basis.intersection(doc_tokens)
            matched = bool(overlap)
            if matched:
                score = min(0.95, 0.4 + 0.08 * len(overlap))

        if not matched:
            continue

        preview = text_blob[:220].replace("\n", " ").strip()
        results.append(
            {
                "filename": upload.filename,
                "category": category,
                "score": round(score, 3),
                "preview": preview,
            }
        )

    results.sort(key=lambda x: x["score"], reverse=True)
    return JSONResponse(
        {
            "query": q,
            "mode": mode,
            "total_matches": len(results),
            "matches": results,
        }
    )


@app.post("/sanitize/bulk", response_class=FileResponse)
async def sanitize_bulk(
    files: List[UploadFile] = File(..., description="Multiple files to sanitize"),
    options: str = Form("{}", description="JSON-encoded SanitizeOptions"),
    group_name: str = Form("bulk", description="Folder/group name for this batch"),
):
    """Sanitize many files and return a ZIP archive of transformed outputs."""
    try:
        opts = SanitizeOptions.model_validate_json(options)
    except Exception as e:
        raise HTTPException(400, f"Invalid options JSON: {e}")
    request = _options_to_request(opts)

    workdir = Path(tempfile.mkdtemp(prefix="sanitize_bulk_"))
    outdir = workdir / "outputs"
    outdir.mkdir(parents=True, exist_ok=True)

    safe_group = re.sub(r"[^a-zA-Z0-9_-]+", "_", (group_name or "bulk").strip()) or "bulk"
    summary: List[dict] = []

    pipe = get_pipeline()
    max_zip_entries = 1000
    max_zip_uncompressed = 512 * 1024 * 1024

    def _sanitize_one(src: Path, display_name: str) -> None:
        category = detect_category(src)
        if category in {"unknown", "video"}:
            summary.append({"filename": display_name, "status": "skipped", "reason": f"unsupported category: {category}"})
            return

        suffix = {
            "image": ".png",
            "pdf": ".pdf",
            "docx": ".docx",
            "text": src.suffix or ".txt",
        }[category]
        out = outdir / f"sanitized_{Path(src.name).stem}_{uuid.uuid4().hex[:8]}{suffix}"

        try:
            result = pipe.sanitize(src, out, request)
            summary.append({"filename": display_name, "status": "ok", "media_type": result.media_type})
        except Exception as e:
            summary.append({"filename": display_name, "status": "error", "reason": str(e)[:220]})

    for upload in files:
        filename = upload.filename or f"input_{uuid.uuid4().hex}"
        src = workdir / filename
        _save_upload(upload, src)

        if src.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(src, "r") as zf:
                    infos = [i for i in zf.infolist() if not i.is_dir()]
                    if len(infos) > max_zip_entries:
                        summary.append({"filename": filename, "status": "error", "reason": "zip has too many files"})
                        continue

                    total_uncompressed = 0
                    for info in infos:
                        total_uncompressed += int(info.file_size or 0)
                        if total_uncompressed > max_zip_uncompressed:
                            summary.append({"filename": filename, "status": "error", "reason": "zip is too large when extracted"})
                            break

                        leaf = Path(info.filename).name
                        if not leaf:
                            continue
                        extracted = workdir / f"zip_{uuid.uuid4().hex[:8]}_{leaf}"
                        with zf.open(info, "r") as zsrc, extracted.open("wb") as dst:
                            shutil.copyfileobj(zsrc, dst)
                        _sanitize_one(extracted, f"{filename}:{leaf}")
            except zipfile.BadZipFile:
                summary.append({"filename": filename, "status": "error", "reason": "invalid zip archive"})
            continue

        _sanitize_one(src, filename)

    zip_path = workdir / f"{safe_group}_sanitized.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Keep a folder entry so empty result sets can still be downloaded as a ZIP.
        zf.writestr(f"{safe_group}/", "")
        for fp in outdir.glob("*"):
            zf.write(fp, arcname=f"{safe_group}/{fp.name}")

    return FileResponse(
        path=zip_path,
        filename=zip_path.name,
        headers={"X-Sanitizer-Summary": json.dumps({"group": safe_group, "count": len(summary)})},
    )
