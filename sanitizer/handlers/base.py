"""Shared helpers used by visual handlers (image / pdf / video)."""
from __future__ import annotations

import math
import re
from typing import List

from sanitizer.core.types import Detection, DetectionKind, SanitizeRequest
from sanitizer.detectors.pii_text import PIITextAnalyzer


_DIGIT_RE = re.compile(r"\d")


def _normalized(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _span_bbox(text: str, bbox: tuple[int, int, int, int], start: int, end: int) -> tuple[int, int, int, int]:
    """Exact character span bbox within an OCR box.

    OCR boxes typically wrap the visible glyphs tightly but may include leading
    or trailing whitespace in the recognized ``text``. We strip those
    whitespace runs first, then map each remaining character to an equal slice
    of the bbox width. This keeps the redaction rectangle sitting directly on
    top of the targeted glyph instead of drifting toward neighbouring chars.
    """
    x1, y1, x2, y2 = bbox
    if not text:
        return bbox

    # Map original-text positions to whitespace-stripped positions.
    lead = len(text) - len(text.lstrip())
    trail_full = len(text)
    trail = trail_full - len(text.rstrip())
    inner_len = max(1, trail_full - lead - trail)

    # Shift start/end into the visible-glyph range.
    s = max(0, start - lead)
    e = max(s + 1, end - lead)
    s = min(s, inner_len)
    e = min(e, inner_len)
    if e <= s:
        e = min(inner_len, s + 1)

    w = max(1, x2 - x1)
    cell = w / inner_len
    sx = x1 + int(round(s * cell))
    ex = x1 + int(round(e * cell))
    if ex <= sx:
        ex = min(x2, sx + max(1, int(round(cell))))

    # Proportional fonts mean equal-cell estimates drift (typically leftward
    # when earlier glyphs are wider than average). Inflate horizontally by a
    # generous fraction of a cell so the mask fully covers the targeted
    # glyph, then clamp inside the OCR bbox. Also pad vertically a touch so
    # tall ascenders/descenders are not clipped.
    pad_x = max(3, int(round(cell * 0.6)))
    pad_y = max(2, int(round((y2 - y1) * 0.12)))
    sx = max(x1, sx - pad_x)
    ex = min(x2, ex + pad_x)
    ny1 = max(0, y1 - pad_y)
    ny2 = y2 + pad_y
    if ex <= sx:
        ex = min(x2, sx + max(1, int(round(cell))))
    return sx, ny1, ex, ny2


def _word_span(text: str, start: int, end: int) -> tuple[int, int]:
    """Expand a character span to the surrounding whitespace-delimited word."""
    if not text:
        return start, end
    n = len(text)
    ws = start
    while ws > 0 and not text[ws - 1].isspace():
        ws -= 1
    we = end
    while we < n and not text[we].isspace():
        we += 1
    return ws, we


def _scoped_bbox(
    text: str,
    bbox: tuple[int, int, int, int],
    start: int,
    end: int,
    scope: str,
) -> tuple[int, int, int, int]:
    """Return a bbox for the matched span according to the requested scope."""
    scope = (scope or "exact").lower()
    if scope == "sentence":
        return bbox
    if scope == "word":
        ws, we = _word_span(text, start, end)
        return _span_bbox(text, bbox, ws, we)
    return _span_bbox(text, bbox, start, end)


def _keyword_spans(text: str, keyword: str) -> List[tuple[int, int]]:
    """Return direct keyword span matches in original text (case-insensitive)."""
    kw = (keyword or "").strip()
    if not kw:
        return []
    out: List[tuple[int, int]] = []
    for m in re.finditer(re.escape(kw.lower()), text.lower()):
        out.append((m.start(), m.end()))
    return out


def classify_ocr_detection(
    det: Detection,
    request: SanitizeRequest,
    pii: PIITextAnalyzer,
) -> List[Detection]:
    """Given an OCR detection (label=recognized text), return zero or more
    Detections re-typed as NUMBER / PII / CUSTOM if they should be redacted.

    If nothing about the text warrants redaction, returns []."""
    text = det.label or ""
    if not text:
        return []

    out: List[Detection] = []

    # 1. Number redaction — any token containing 2+ digits in a row
    if request.redact_numbers and _DIGIT_RE.search(text):
        # Heuristic: if it's mostly digits or contains a long digit run, redact whole box.
        digit_chars = sum(c.isdigit() for c in text)
        if digit_chars >= 2:
            out.append(
                Detection(
                    kind=DetectionKind.NUMBER,
                    bbox=det.bbox,
                    confidence=det.confidence,
                    label=text,
                    page=det.page,
                    frame=det.frame,
                )
            )
            return out  # whole box already redacted, no need to also tag as PII

    # 2. PII analysis on the recognized string
    if request.redact_pii:
        spans = pii.analyze(text, request.custom_patterns, request.keywords)
        if spans:
            for s in spans:
                out.append(
                    Detection(
                        kind=DetectionKind.CUSTOM if s.label == "KEYWORD" else DetectionKind.PII,
                        bbox=_scoped_bbox(text, det.bbox, s.start, s.end, request.blur_scope),
                        confidence=det.confidence,
                        label=f"{text} [{s.label}]",
                        page=det.page,
                        frame=det.frame,
                    )
                )
            return out

    # 3. Keyword-only match (case-insensitive substring)
    lowered = text.lower()
    normalized_text = _normalized(text)
    for kw in request.keywords or []:
        if not kw:
            continue
        kw_l = kw.lower()
        kw_norm = _normalized(kw)

        spans = _keyword_spans(text, kw_l)
        if not spans and kw_norm and kw_norm in normalized_text:
            # Fallback for punctuation/spacing variants: allow flexible separators,
            # still producing tight spans around matched characters.
            patt = r"".join(re.escape(ch) + r"[^a-z0-9]*" for ch in kw_l if ch.isalnum())
            if patt:
                spans = [(m.start(), m.end()) for m in re.finditer(patt, lowered)]

        for s_start, s_end in spans:
            out.append(
                Detection(
                    kind=DetectionKind.CUSTOM,
                    bbox=_scoped_bbox(text, det.bbox, s_start, s_end, request.blur_scope),
                    confidence=det.confidence,
                    label=text,
                    page=det.page,
                    frame=det.frame,
                )
            )
        if spans:
            break

    return out
