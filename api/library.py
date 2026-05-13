"""Alfresco-style persistent document library.

Files live under ``data/library/<folder>/`` with a sibling ``_meta.json``
holding per-file metadata. The router below exposes folder + item CRUD,
sorting and multi-modal search (text / word / character / id / image /
signature).
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

router = APIRouter(prefix="/library", tags=["library"])

LIBRARY_ROOT = Path(__file__).resolve().parent.parent / "data" / "library"
LIBRARY_ROOT.mkdir(parents=True, exist_ok=True)

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_SIGNATURE_TERMS = (
    "signature", "signed", "signatory", "authorised sign",
    "authorized sign", "/s/", "sig.",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe(name: str, fallback: str = "item") -> str:
    name = (name or "").strip()
    name = _SAFE_NAME.sub("_", name)
    name = name.strip("._-") or fallback
    return name[:120]


def _folder_path(folder: str) -> Path:
    f = _safe(folder, "default")
    p = LIBRARY_ROOT / f
    # Defense-in-depth: never escape root.
    try:
        p.resolve().relative_to(LIBRARY_ROOT.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid folder name")
    return p


def _meta_path(folder: str) -> Path:
    return _folder_path(folder) / "_meta.json"


def _load_meta(folder: str) -> Dict[str, Any]:
    mp = _meta_path(folder)
    if not mp.exists():
        return {"folder": folder, "items": {}}
    try:
        return json.loads(mp.read_text(encoding="utf-8"))
    except Exception:
        return {"folder": folder, "items": {}}


def _save_meta(folder: str, meta: Dict[str, Any]) -> None:
    _meta_path(folder).write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _ext_kind(name: str) -> str:
    ext = Path(name).suffix.lower().lstrip(".")
    if ext in {"jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp", "gif"}:
        return "image"
    if ext == "pdf":
        return "pdf"
    if ext in {"doc", "docx"}:
        return "doc"
    if ext in {"txt", "md", "csv", "json", "log"}:
        return "text"
    if ext in {"mp4", "mov", "avi", "mkv", "webm"}:
        return "video"
    return "other"


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _read_image_bgr(path: Path) -> Optional[np.ndarray]:
    img = cv2.imread(str(path))
    if img is not None:
        return img
    try:
        from PIL import Image
        pil = Image.open(path).convert("RGB")
        return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _phash(path: Path) -> Optional[str]:
    """Tiny dHash for image similarity (16 hex chars)."""
    img = _read_image_bgr(path)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    diff = small[:, 1:] > small[:, :-1]
    bits = 0
    for b in diff.flatten():
        bits = (bits << 1) | int(b)
    return f"{bits:016x}"


def _hamming(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except Exception:
        return 64


def _extract_text(path: Path) -> str:
    kind = _ext_kind(path.name)
    try:
        if kind == "text":
            return path.read_text(encoding="utf-8", errors="ignore")
        if kind == "doc":
            from docx import Document
            return "\n".join(p.text for p in Document(str(path)).paragraphs if p.text)
        if kind == "pdf":
            # Light text extraction; falls back to empty if pdfplumber missing.
            try:
                import pdfplumber  # type: ignore
                pages = []
                with pdfplumber.open(str(path)) as pdf:
                    for p in pdf.pages:
                        t = p.extract_text() or ""
                        if t:
                            pages.append(t)
                return "\n".join(pages)
            except Exception:
                return ""
        if kind == "image":
            # Lightweight: defer to pipeline.text_det via lazy import to avoid heavy load
            from api.main import get_pipeline  # type: ignore
            img = _read_image_bgr(path)
            if img is None:
                return ""
            return " ".join(d.label for d in get_pipeline().text_det.detect(img) if d.label)
    except Exception:
        return ""
    return ""


def _detect_signature(path: Path) -> bool:
    """Heuristic signature detection.

    - For text-bearing files: look for signature keywords in extracted text.
    - For images: detect a thin dark scribble region in the lower half via
      adaptive threshold + contour aspect ratio.
    """
    kind = _ext_kind(path.name)
    if kind in {"text", "doc", "pdf"}:
        text = _extract_text(path).lower()
        return any(term in text for term in _SIGNATURE_TERMS)
    if kind == "image":
        img = _read_image_bgr(path)
        if img is None:
            return False
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]
        roi = gray[int(h * 0.55):, :]
        if roi.size == 0:
            return False
        _, th = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
        contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            x, y, cw, ch = cv2.boundingRect(c)
            if cw < w * 0.15 or ch < 8:
                continue
            ar = cw / max(1, ch)
            density = cv2.countNonZero(th[y:y + ch, x:x + cw]) / max(1, cw * ch)
            if 2.5 < ar < 18 and 0.08 < density < 0.55:
                return True
    return False


def _index_item(folder: str, stored_name: str, original_name: str,
                display_name: str, tags: List[str]) -> Dict[str, Any]:
    fp = _folder_path(folder) / stored_name
    meta = _load_meta(folder)
    kind = _ext_kind(stored_name)
    item: Dict[str, Any] = {
        "stored_name": stored_name,
        "original_name": original_name,
        "display_name": display_name or original_name,
        "kind": kind,
        "size": fp.stat().st_size,
        "created": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "tags": tags,
        "sha256_prefix": _file_hash(fp),
    }
    if kind == "image":
        ph = _phash(fp)
        if ph:
            item["phash"] = ph
    # Text snippet for fast search.
    text = _extract_text(fp)
    if text:
        item["text_excerpt"] = text[:2000]
        item["has_signature_term"] = any(t in text.lower() for t in _SIGNATURE_TERMS)
    item["has_signature"] = _detect_signature(fp)
    meta.setdefault("items", {})[stored_name] = item
    meta["folder"] = folder
    _save_meta(folder, meta)
    return item


def _unique_target(folder: str, desired_name: str) -> Path:
    fp = _folder_path(folder)
    fp.mkdir(parents=True, exist_ok=True)
    ext = Path(desired_name).suffix
    stem = Path(desired_name).stem
    safe_name = _safe(stem, "item") + ext
    target = fp / safe_name
    if target.exists():
        target = fp / f"{_safe(stem, 'item')}_{int(time.time() * 1000)}{ext}"
    return target


def _save_and_index_file(folder: str, original_name: str, raw_bytes: bytes,
                         tags: List[str], display_name: str = "") -> Dict[str, Any]:
    ext = Path(original_name).suffix or ""
    base = Path(original_name).stem or f"upload_{uuid.uuid4().hex}"
    desired = f"{_safe(base, 'item')}{ext}"
    target = _unique_target(folder, desired)
    target.write_bytes(raw_bytes)
    return _index_item(
        folder,
        target.name,
        original_name,
        display_name or Path(original_name).stem,
        tags,
    )


def _extract_zip_to_library(folder: str, zip_upload: UploadFile, tags: List[str]) -> List[Dict[str, Any]]:
    payload = zip_upload.file.read()
    if not payload:
        return []

    zip_name = Path(zip_upload.filename or f"archive_{uuid.uuid4().hex}.zip").stem
    zip_folder = _safe(f"{folder}_{zip_name}", "default_zip")

    try:
        zf = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise HTTPException(400, f"Invalid ZIP file: {zip_upload.filename or 'upload.zip'}")

    indexed: List[Dict[str, Any]] = []
    max_entries = 1000
    max_uncompressed = 512 * 1024 * 1024
    total_uncompressed = 0

    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > max_entries:
            raise HTTPException(400, "ZIP contains too many files")

        for info in infos:
            total_uncompressed += int(info.file_size or 0)
            if total_uncompressed > max_uncompressed:
                raise HTTPException(400, "ZIP is too large when extracted")

            original_leaf = Path(info.filename).name
            if not original_leaf or original_leaf == "_meta.json":
                continue

            data = zf.read(info)
            item = _save_and_index_file(zip_folder, original_leaf, data, tags)
            indexed.append(item)

    return indexed


# ---------------------------------------------------------------------------
# Folder endpoints
# ---------------------------------------------------------------------------
@router.get("")
def list_folders() -> JSONResponse:
    folders = []
    for d in sorted(LIBRARY_ROOT.iterdir()) if LIBRARY_ROOT.exists() else []:
        if not d.is_dir():
            continue
        meta = _load_meta(d.name)
        items = meta.get("items", {})
        folders.append({
            "folder": d.name,
            "item_count": len(items),
            "total_size": sum(i.get("size", 0) for i in items.values()),
            "kinds": sorted({i.get("kind", "other") for i in items.values()}),
        })
    return JSONResponse({"folders": folders, "root": str(LIBRARY_ROOT)})


@router.post("/folder")
def create_folder(name: str = Form(...)) -> JSONResponse:
    folder = _safe(name, "folder")
    fp = _folder_path(folder)
    fp.mkdir(parents=True, exist_ok=True)
    if not _meta_path(folder).exists():
        _save_meta(folder, {"folder": folder, "items": {}})
    return JSONResponse({"folder": folder, "created": True})


@router.delete("/folder/{folder}")
def delete_folder(folder: str) -> JSONResponse:
    fp = _folder_path(folder)
    if fp.exists():
        shutil.rmtree(fp)
    return JSONResponse({"folder": folder, "deleted": True})


# ---------------------------------------------------------------------------
# Item endpoints
# ---------------------------------------------------------------------------
@router.post("/save")
async def save_item(
    file: UploadFile = File(...),
    folder: str = Form("default"),
    name: str = Form("", description="Optional display/storage name"),
    tags: str = Form("", description="Comma-separated tags"),
) -> JSONResponse:
    fp = _folder_path(folder)
    fp.mkdir(parents=True, exist_ok=True)

    original = file.filename or f"upload_{uuid.uuid4().hex}"
    ext = Path(original).suffix or ""
    desired = _safe(name or Path(original).stem, "item") + ext
    target = fp / desired
    # Avoid overwrite by suffixing.
    if target.exists():
        target = fp / f"{Path(desired).stem}_{int(time.time())}{ext}"

    with target.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
    item = _index_item(folder, target.name, original, name or Path(original).stem, tag_list)
    return JSONResponse({"folder": folder, "item": item})


@router.post("/save-bulk")
async def save_bulk_items(
    files: Optional[List[UploadFile]] = File(None),
    zip_files: Optional[List[UploadFile]] = File(None),
    folder: str = Form("default"),
    tags: str = Form("", description="Comma-separated tags"),
) -> JSONResponse:
    files = files or []
    zip_files = zip_files or []
    if not files and not zip_files:
        raise HTTPException(400, "Provide at least one file or zip file")

    base_folder = _safe(folder or "default", "default")
    tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]

    saved_items: List[Dict[str, Any]] = []
    zip_folder_counts: Dict[str, int] = {}

    for up in files:
        original = up.filename or f"upload_{uuid.uuid4().hex}"
        raw = await up.read()
        item = _save_and_index_file(base_folder, original, raw, tag_list)
        saved_items.append(item)

    for zup in zip_files:
        extracted = _extract_zip_to_library(base_folder, zup, tag_list)
        saved_items.extend(extracted)
        zname = Path(zup.filename or "archive.zip").stem
        zfolder = _safe(f"{base_folder}_{zname}", "default_zip")
        zip_folder_counts[zfolder] = zip_folder_counts.get(zfolder, 0) + len(extracted)

    return JSONResponse(
        {
            "base_folder": base_folder,
            "saved_count": len(saved_items),
            "zip_folders": zip_folder_counts,
            "items": saved_items,
        }
    )


@router.get("/{folder}")
def list_items(
    folder: str,
    sort: str = Query("created", description="name | created | size | kind"),
    order: str = Query("desc", description="asc | desc"),
    kind: str = Query("", description="Filter by kind (image, pdf, doc, text, video)"),
) -> JSONResponse:
    fp = _folder_path(folder)
    if not fp.exists():
        raise HTTPException(404, f"Folder not found: {folder}")
    meta = _load_meta(folder)
    items = list(meta.get("items", {}).values())
    if kind:
        items = [i for i in items if i.get("kind") == kind]
    key = sort if sort in {"name", "created", "size", "kind"} else "created"
    rev = order != "asc"
    items.sort(key=lambda i: i.get("display_name" if key == "name" else key, ""), reverse=rev)
    return JSONResponse({"folder": folder, "total": len(items), "items": items})


@router.get("/{folder}/file/{stored_name}")
def download_item(folder: str, stored_name: str) -> FileResponse:
    stored_name = _safe(stored_name, "item")
    fp = _folder_path(folder) / stored_name
    if not fp.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(path=fp, filename=stored_name)


@router.delete("/{folder}/file/{stored_name}")
def delete_item(folder: str, stored_name: str) -> JSONResponse:
    stored_name = _safe(stored_name, "item")
    fp = _folder_path(folder) / stored_name
    if fp.exists():
        fp.unlink()
    meta = _load_meta(folder)
    meta.get("items", {}).pop(stored_name, None)
    _save_meta(folder, meta)
    return JSONResponse({"folder": folder, "stored_name": stored_name, "deleted": True})


@router.post("/{folder}/rename")
def rename_item(
    folder: str,
    stored_name: str = Form(...),
    display_name: str = Form(...),
) -> JSONResponse:
    meta = _load_meta(folder)
    item = meta.get("items", {}).get(_safe(stored_name, "item"))
    if not item:
        raise HTTPException(404, "Item not found")
    item["display_name"] = display_name.strip() or item["display_name"]
    _save_meta(folder, meta)
    return JSONResponse({"folder": folder, "item": item})


# ---------------------------------------------------------------------------
# Multi-modal search
# ---------------------------------------------------------------------------
@router.post("/search")
async def search_library(
    folder: str = Form("", description="Folder to search; empty searches all"),
    mode: str = Form("text", description="text | word | character | id | image | signature"),
    query: str = Form(""),
    query_image: Optional[UploadFile] = File(None),
) -> JSONResponse:
    mode = (mode or "text").strip().lower()
    valid = {"text", "word", "character", "id", "image", "signature"}
    if mode not in valid:
        raise HTTPException(400, f"mode must be one of: {sorted(valid)}")

    q = (query or "").strip()
    if mode in {"text", "word", "character", "id"} and not q:
        raise HTTPException(400, "query is required for this mode")

    query_phash: Optional[str] = None
    if mode == "image" and query_image is not None:
        tmp = LIBRARY_ROOT / f".tmp_query_{uuid.uuid4().hex}"
        with tmp.open("wb") as f:
            shutil.copyfileobj(query_image.file, f)
        try:
            query_phash = _phash(tmp)
        finally:
            tmp.unlink(missing_ok=True)

    folders = [folder] if folder else [d.name for d in LIBRARY_ROOT.iterdir() if d.is_dir()]
    digits = re.sub(r"\D+", "", q)
    q_lower = q.lower()
    matches: List[Dict[str, Any]] = []

    for fld in folders:
        meta = _load_meta(fld)
        for item in meta.get("items", {}).values():
            text = (item.get("text_excerpt") or "").lower()
            score = 0.0
            hit = False
            evidence = ""

            if mode == "text":
                if q_lower and q_lower in text:
                    hit = True
                    score = 0.6 + min(0.3, len(q_lower) / max(1, len(text)))
                    idx = text.find(q_lower)
                    evidence = text[max(0, idx - 60):idx + len(q_lower) + 60]
            elif mode == "word":
                tokens = set(re.findall(r"[a-z0-9]+", text))
                if q_lower in tokens:
                    hit = True
                    score = 0.8
                    evidence = q_lower
            elif mode == "character":
                if q_lower and q_lower in text:
                    hit = True
                    score = 0.55
                    evidence = text[: text.find(q_lower) + len(q_lower) + 40] if text else ""
            elif mode == "id":
                if digits:
                    doc_digits = re.sub(r"\D+", "", item.get("text_excerpt") or "")
                    if digits in doc_digits:
                        hit = True
                        score = 0.9
                        evidence = digits
            elif mode == "image":
                if query_phash and item.get("phash"):
                    dist = _hamming(query_phash, item["phash"])
                    if dist <= 16:
                        hit = True
                        score = max(0.3, 1.0 - dist / 64.0)
                        evidence = f"hamming={dist}"
            elif mode == "signature":
                if item.get("has_signature") or item.get("has_signature_term"):
                    hit = True
                    score = 0.85
                    evidence = "signature region/term"

            if hit:
                matches.append({
                    "folder": fld,
                    "stored_name": item["stored_name"],
                    "display_name": item.get("display_name", item["stored_name"]),
                    "kind": item.get("kind"),
                    "score": round(score, 3),
                    "evidence": evidence[:240],
                    "tags": item.get("tags", []),
                })

    matches.sort(key=lambda m: m["score"], reverse=True)
    return JSONResponse({
        "mode": mode,
        "query": q,
        "folders_searched": folders,
        "total_matches": len(matches),
        "matches": matches,
    })


@router.post("/{folder}/export")
def export_folder(folder: str) -> FileResponse:
    fp = _folder_path(folder)
    if not fp.exists():
        raise HTTPException(404, "Folder not found")
    zip_path = LIBRARY_ROOT / f".{folder}_{uuid.uuid4().hex}.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in fp.glob("*"):
            if f.is_file():
                zf.write(f, arcname=f"{folder}/{f.name}")
    return FileResponse(path=zip_path, filename=f"{folder}.zip")
