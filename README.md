# Sanitizer

A **backend-agnostic Python anonymization engine** for data-warehouse pipelines.
Detects and irreversibly masks (blur / pixelate / blackbox):

* **Faces** in images, PDFs, and video — with **selective blur** for video
  (whitelist/blacklist specific identities via reference photos).
* **Numbers** (IDs, account numbers, dates, etc.) via OCR.
* **Named PII** (names, emails, phones, SSNs, IBANs, credit cards, URLs, IPs, …)
  via Microsoft Presidio + spaCy NER + regex fallbacks.
* **Custom regex patterns** and **literal keywords** you provide per request.

Supported inputs: `.jpg .png .tif .bmp .webp` · `.pdf` (scanned & digital) ·
`.docx` (text + embedded images) · `.mp4 .avi .mov .mkv .webm` ·
`.txt .csv .md .json`.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       sanitizer (library)                        │
│                                                                  │
│  ┌────────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ Handlers   │ → │  Detectors   │ → │  Mask engine            │ │
│  │ image/pdf/ │   │ YOLOv8-face  │   │  blur / pixelate / box  │ │
│  │ docx/video │   │ RetinaFace   │   └─────────────────────────┘ │
│  │ text       │   │ EasyOCR      │                               │
│  └────────────┘   │ PaddleOCR    │                               │
│                   │ Presidio+NER │                               │
│                   └──────────────┘                               │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │   (import as a library, OR …)
                              │
                ┌─────────────┴──────────────┐
                │  api/ (FastAPI service)    │  ← attach ANY backend here
                │  /sanitize, /sanitize/info │
                │  /sanitize/video, /health  │
                └────────────────────────────┘
```

The core library has **no API or backend dependencies**. The FastAPI app is a
thin wrapper — drop it, replace it with a Celery worker, gRPC service, AWS
Lambda, or call `SanitizerPipeline` directly from a Spark/Beam DAG.

## Pretrained models used (state-of-the-art, all free)

| Task | Model | Notes |
|---|---|---|
| Face detection (primary) | **YOLOv8-face** (Ultralytics) | Fast, strong recall |
| Face detection (high-acc + ID matching) | **RetinaFace + ArcFace** (insightface `buffalo_l`) | Used for selective video blur |
| Detection ensembling | YOLO ∪ RetinaFace with NMS | Maximizes recall (privacy-first) |
| OCR (default) | **EasyOCR** (80+ languages) | |
| OCR (alternative) | **PaddleOCR** | Better on dense documents |
| Named PII on text | **Microsoft Presidio** + **spaCy `en_core_web_lg`** | |
| Regex PII fallback | Built-in | Always on |

Set the backends via `.env` (`SANITIZER_FACE_BACKEND`, `SANITIZER_OCR_BACKEND`).

## Install

### Local (CPU)

```bash
python -m venv .venv
.venv\Scripts\activate          # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m spacy download en_core_web_lg
pip install -e .
python scripts/download_models.py   # pre-fetch all weights
```

### Local (GPU, CUDA 12)

```bash
pip install -r requirements.txt -r requirements-gpu.txt
python -m spacy download en_core_web_lg
pip install -e .
$env:SANITIZER_DEVICE = "cuda"
```

### Docker

```bash
# CPU
docker compose up --build

# GPU (uncomment the gpu service in docker-compose.yml, then)
docker build -f Dockerfile.gpu -t sanitizer:gpu .
docker run --gpus all -p 8000:8000 -v ${PWD}/models:/app/models sanitizer:gpu
```

## Use as a library

```python
from sanitizer import SanitizerPipeline, SanitizeRequest
from sanitizer.core.types import MaskMode

pipe = SanitizerPipeline()

# Image / PDF / DOCX / TXT — auto-detected by extension + magic bytes.
pipe.sanitize("invoice.pdf", "invoice.redacted.pdf")

# With custom rules
pipe.sanitize(
    "form.png", "form.redacted.png",
    SanitizeRequest(
        mask_mode=MaskMode.PIXELATE,
        keywords=["John Doe", "Acme Corp"],
        custom_patterns=[r"NID-\d{8}"],     # your national-ID format
    ),
)

# Video with SELECTIVE blur:
# blur everyone EXCEPT "alice" (alice gave consent).
pipe.sanitize(
    "clip.mp4", "clip.redacted.mp4",
    SanitizeRequest(whitelist_face_ids=["alice"]),
    reference_faces={"alice": ["refs/alice_1.jpg", "refs/alice_2.jpg"]},
)
```

`SanitizeResult.summary()` returns counts by detection kind, ready to log.

## Use as an HTTP API

```bash
uvicorn api.main:app --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000/> for the **web UI** (drag-and-drop, options panel,
and a before/after comparison viewer). Swagger docs are at `/docs`.

Then any backend (Java/Node/Go/.NET) can integrate via plain multipart POST:

### `POST /sanitize`

```bash
curl -X POST http://localhost:8000/sanitize \
    -F "file=@scan.pdf" \
    -F 'options={"mask_mode":"blur","redact_faces":true,"redact_numbers":true,"keywords":["confidential"]}' \
    --output scan.redacted.pdf
```

The response is the sanitized file. The `X-Sanitizer-Summary` header carries
the JSON detection summary.

### `POST /sanitize/info` — JSON-only audit response

Same payload, returns:

```json
{
  "output": "/tmp/sanitize_xyz/sanitized_scan.pdf",
  "media_type": "pdf",
  "total_detections": 27,
  "by_kind": {"face": 3, "number": 18, "pii": 6},
  "meta": {"pages": 4, "dpi": 200}
}
```

### `POST /sanitize/video` — selective blur

```bash
curl -X POST http://localhost:8000/sanitize/video \
    -F "file=@meeting.mp4" \
    -F "reference_faces=@alice.jpg" \
    -F "reference_faces=@bob.jpg" \
    -F 'options={"whitelist_face_ids":["alice","bob"]}' \
    --output meeting.redacted.mp4
```

Reference image filenames (stem) become the identity ids.

## Configuration

All knobs are env vars (see `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `SANITIZER_DEVICE` | `auto` | `cpu` / `cuda` / `auto` |
| `SANITIZER_FACE_BACKEND` | `ensemble` | `yolo` / `retinaface` / `ensemble` |
| `SANITIZER_OCR_BACKEND` | `easyocr` | `easyocr` / `paddleocr` |
| `SANITIZER_OCR_LANGS` | `en` | Comma-separated ISO codes |
| `SANITIZER_MASK_MODE` | `blur` | `blur` / `pixelate` / `blackbox` |
| `SANITIZER_BLUR_KERNEL` | `51` | Higher = stronger blur (must be odd) |

## Fine-tuning (optional)

See [`sanitizer/training/README.md`](sanitizer/training/README.md). Includes:

* WIDER FACE → YOLO converter (`prepare_widerface.py`).
* YOLOv8-face trainer (`train_yolo_face.py`).
* Recipe to drop new weights into `./models/yolov8n-face.pt` and have the
  pipeline pick them up with no code changes.

## Project layout

```
sanitizer/                # core library (no API deps)
  core/   types.py  blur.py  pipeline.py
  detectors/   face_*.py  ocr_*.py  pii_text.py
  handlers/    image.py  pdf.py  docx.py  video.py  text.py
  training/    prepare_widerface.py  train_yolo_face.py
  utils/       io.py  __init__.py
api/                      # optional FastAPI wrapper
scripts/                  # ops helpers (download_models.py)
tests/                    # smoke tests
Dockerfile / Dockerfile.gpu / docker-compose.yml
requirements.txt / requirements-gpu.txt / pyproject.toml
```

## Security notes

* Blur / pixelate / blackbox are applied to **rasterized** copies of PDFs and
  embedded DOCX images, so hidden text layers / metadata behind a redaction
  cannot be recovered from the output file.
* Treat `outputs/` and any uploaded files as **PII while they exist**. The
  API writes to OS temp dirs; wire it behind authenticated transport and add
  a cleanup job appropriate for your retention policy.
* Detection is **recall-biased** by design (the ensemble face detector and the
  Presidio+regex stacking favor false positives over leaks). Validate on your
  own data before relying on it for regulated workloads.
