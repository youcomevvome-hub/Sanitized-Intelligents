"""Fine-tune YOLOv8-face on a YOLO-formatted dataset (e.g. WIDER FACE).

Usage::

    python -m sanitizer.training.train_yolo_face \
        --data /data/wider_yolo/data.yaml \
        --weights yolov8n-face.pt \
        --epochs 50 --imgsz 640 --batch 16
"""
from __future__ import annotations

import argparse
from pathlib import Path

from sanitizer.config import settings


def main() -> None:
    from ultralytics import YOLO  # heavy import

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="YOLO data.yaml")
    ap.add_argument("--weights", type=str, default="yolov8n-face.pt")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--project", type=str, default="runs/face")
    ap.add_argument("--name", type=str, default="train")
    args = ap.parse_args()

    weights_path = Path(args.weights)
    if not weights_path.is_absolute() and not weights_path.exists():
        # try the cache dir
        cached = settings.model_dir / weights_path.name
        if cached.exists():
            weights_path = cached

    model = YOLO(str(weights_path))
    model.train(
        data=str(args.data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=settings.device if settings.device != "auto" else None,
        project=args.project,
        name=args.name,
        exist_ok=True,
    )
    print("Training done. Copy best.pt to ./models/yolov8n-face.pt to deploy.")


if __name__ == "__main__":
    main()
