"""Plain text / CSV handler — PII-only (no faces, no OCR)."""
from __future__ import annotations

import re
from pathlib import Path
from typing import List

from sanitizer.core.types import Detection, DetectionKind, SanitizeRequest, SanitizeResult
from sanitizer.detectors.pii_text import PIITextAnalyzer

_NUMBER_RE = re.compile(r"\d{2,}")
REDACTION_TOKEN = "[REDACTED]"


def _apply_custom_replacements(text: str, replacements: dict[str, str]) -> str:
    out = text
    for src, dst in (replacements or {}).items():
        if not src:
            continue
        out = re.sub(re.escape(src), dst or "", out, flags=re.IGNORECASE)
    return out


def sanitize_text(
    input_path: str | Path,
    output_path: str | Path,
    pii: PIITextAnalyzer,
    request: SanitizeRequest,
) -> SanitizeResult:
    input_path = Path(input_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    text = input_path.read_text(encoding="utf-8", errors="replace")
    text = _apply_custom_replacements(text, request.custom_replacements)
    replacement_token = (request.replacement_text or REDACTION_TOKEN).strip() or REDACTION_TOKEN

    spans: List[tuple[int, int, str]] = []
    if request.redact_pii:
        for s in pii.analyze(text, request.custom_patterns, request.keywords):
            spans.append((s.start, s.end, s.label))
    if request.redact_numbers:
        for m in _NUMBER_RE.finditer(text):
            spans.append((m.start(), m.end(), "NUMBER"))

    spans.sort()
    merged: List[tuple[int, int, str]] = []
    for s, e, lbl in spans:
        if merged and s <= merged[-1][1]:
            ps, pe, plbl = merged[-1]
            merged[-1] = (ps, max(pe, e), plbl)
        else:
            merged.append((s, e, lbl))

    out_parts: List[str] = []
    detections: List[Detection] = []
    cursor = 0
    for s, e, lbl in merged:
        out_parts.append(text[cursor:s])
        out_parts.append(replacement_token)
        detections.append(
            Detection(
                kind=DetectionKind.NUMBER if lbl == "NUMBER" else DetectionKind.PII,
                bbox=(s, e, 0, 0),
                label=lbl,
            )
        )
        cursor = e
    out_parts.append(text[cursor:])

    output_path.write_text("".join(out_parts), encoding="utf-8")
    return SanitizeResult(
        output_path=str(output_path),
        detections=detections,
        media_type="text",
        meta={"chars_in": len(text), "redactions": len(detections)},
    )
