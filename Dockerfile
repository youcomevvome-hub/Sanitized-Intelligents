FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SANITIZER_MODEL_DIR=/app/models

# System deps for OpenCV / PaddleOCR / pypdfium2
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
        ffmpeg \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# Pre-fetch the spaCy English model used by Presidio
RUN python -m spacy download en_core_web_lg

COPY sanitizer ./sanitizer
COPY api ./api
COPY frontend ./frontend
COPY pyproject.toml ./
RUN pip install -e .

RUN mkdir -p /app/models /app/outputs

EXPOSE 8000
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
