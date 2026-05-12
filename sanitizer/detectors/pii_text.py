"""Text-level PII detection: Microsoft Presidio (primary) + spaCy NER (fallback).

Operates on already-extracted strings (from OCR or document text).
Returns (start, end, label) spans over the input string so handlers can map
those offsets back to bboxes / character positions.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from sanitizer.utils import logger


@dataclass
class TextSpan:
    start: int
    end: int
    label: str
    score: float = 1.0


# Built-in regex fallbacks (always active, even if Presidio fails to load)
_BUILTIN_PATTERNS = [
    ("EMAIL_ADDRESS", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+", re.IGNORECASE)),
    ("PHONE_NUMBER", re.compile(r"\+?\d[\d\s().-]{7,}\d")),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]*?){13,19}\b")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("URL", re.compile(r"https?://\S+", re.IGNORECASE)),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b")),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("ID_NUMBER", re.compile(r"\b[A-Z0-9]{6,}\b")),  # generic alphanumeric IDs
]

_NUMBER_PATTERN = re.compile(r"\d{2,}")


def _normalize_for_match(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _normalized_map(text: str) -> Tuple[str, List[int]]:
    chars: List[str] = []
    mapping: List[int] = []
    for idx, ch in enumerate(text):
        if ch.isalnum():
            chars.append(ch.lower())
            mapping.append(idx)
    return "".join(chars), mapping


def _build_loose_keyword_pattern(keyword: str) -> Optional[re.Pattern[str]]:
    chars = [re.escape(ch) for ch in keyword.strip() if ch.strip()]
    if not chars:
        return None
    # Allow OCR-inserted separators between characters, e.g. "A C-C_1 2".
    return re.compile(r"[\W_]*".join(chars), re.IGNORECASE)


class PIITextAnalyzer:
    def __init__(self, langs: Optional[List[str]] = None) -> None:
        self.langs = langs or ["en"]
        self._presidio = None
        try:
            from presidio_analyzer import AnalyzerEngine
            self._presidio = AnalyzerEngine()
            logger.info("Presidio analyzer ready")
        except Exception as e:
            logger.warning(f"Presidio unavailable, using regex fallback only: {e}")

    def analyze(
        self,
        text: str,
        custom_patterns: Optional[List[str]] = None,
        keywords: Optional[List[str]] = None,
    ) -> List[TextSpan]:
        spans: List[TextSpan] = []

        if self._presidio is not None:
            try:
                results = self._presidio.analyze(text=text, language=self.langs[0])
                for r in results:
                    spans.append(TextSpan(r.start, r.end, r.entity_type, float(r.score)))
            except Exception as e:
                logger.warning(f"Presidio analyze failed, falling back to regex: {e}")

        # Always add regex-based PII (covers cases Presidio is conservative on)
        for label, pat in _BUILTIN_PATTERNS:
            for m in pat.finditer(text):
                spans.append(TextSpan(m.start(), m.end(), label, 0.9))

        # Custom user-provided regex
        for pat_str in custom_patterns or []:
            try:
                pat = re.compile(pat_str, re.IGNORECASE)
                for m in pat.finditer(text):
                    spans.append(TextSpan(m.start(), m.end(), "CUSTOM", 1.0))
            except re.error:
                logger.warning(f"Invalid custom pattern: {pat_str}")

        # Literal keyword matches
        for kw in keywords or []:
            if not kw or not kw.strip():
                continue

            # Exact/substring match first.
            for m in re.finditer(re.escape(kw.strip()), text, flags=re.IGNORECASE):
                spans.append(TextSpan(m.start(), m.end(), "KEYWORD", 1.0))

            # Loose OCR-tolerant match with separators.
            loose_pat = _build_loose_keyword_pattern(kw)
            if loose_pat is not None:
                for m in loose_pat.finditer(text):
                    spans.append(TextSpan(m.start(), m.end(), "KEYWORD", 1.0))

            # Normalized fallback (ignore punctuation/spaces entirely).
            normalized_text, idx_map = _normalized_map(text)
            normalized_kw = _normalize_for_match(kw)
            if normalized_kw:
                start = 0
                while True:
                    pos = normalized_text.find(normalized_kw, start)
                    if pos < 0:
                        break
                    orig_start = idx_map[pos]
                    orig_end = idx_map[pos + len(normalized_kw) - 1] + 1
                    spans.append(TextSpan(orig_start, orig_end, "KEYWORD", 0.95))
                    start = pos + 1

        return _merge_spans(spans)

    def find_numbers(self, text: str) -> List[TextSpan]:
        return [TextSpan(m.start(), m.end(), "NUMBER", 1.0) for m in _NUMBER_PATTERN.finditer(text)]


def _merge_spans(spans: List[TextSpan]) -> List[TextSpan]:
    if not spans:
        return spans
    spans = sorted(spans, key=lambda s: (s.start, s.end))
    merged: List[TextSpan] = [spans[0]]
    for s in spans[1:]:
        last = merged[-1]
        if s.start <= last.end:
            merged[-1] = TextSpan(last.start, max(last.end, s.end), last.label, max(last.score, s.score))
        else:
            merged.append(s)
    return merged
