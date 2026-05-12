"""Convert the WIDER FACE dataset into YOLO format.

Expects this directory layout::

    raw/
      WIDER_train/images/<event>/*.jpg
      WIDER_val/images/<event>/*.jpg
      wider_face_split/wider_face_train_bbx_gt.txt
      wider_face_split/wider_face_val_bbx_gt.txt

Produces::

    out/
      images/train/*.jpg
      images/val/*.jpg
      labels/train/*.txt
      labels/val/*.txt
      data.yaml
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import cv2


def _parse_gt(gt_file: Path):
    """Yield (image_relpath, [(x, y, w, h), ...]) tuples."""
    with gt_file.open() as f:
        lines = [ln.strip() for ln in f]
    i = 0
    while i < len(lines):
        if not lines[i]:
            i += 1
            continue
        relpath = lines[i]
        i += 1
        n = int(lines[i]) if lines[i].isdigit() else 0
        i += 1
        boxes = []
        # WIDER puts 0 faces images with one dummy "0 0 0 0 ..." line
        count = max(n, 1)
        for _ in range(count):
            if i >= len(lines):
                break
            parts = lines[i].split()
            i += 1
            if len(parts) < 4:
                continue
            x, y, w, h = (int(parts[k]) for k in range(4))
            if w > 0 and h > 0:
                boxes.append((x, y, w, h))
        yield relpath, boxes


def _convert(split: str, raw: Path, out: Path) -> int:
    gt = raw / "wider_face_split" / f"wider_face_{split}_bbx_gt.txt"
    img_root = raw / f"WIDER_{split}" / "images"
    img_out = out / "images" / split
    lbl_out = out / "labels" / split
    img_out.mkdir(parents=True, exist_ok=True)
    lbl_out.mkdir(parents=True, exist_ok=True)

    count = 0
    for relpath, boxes in _parse_gt(gt):
        src_img = img_root / relpath
        if not src_img.exists():
            continue
        img = cv2.imread(str(src_img))
        if img is None:
            continue
        h, w = img.shape[:2]
        flat_name = relpath.replace("/", "_").replace("\\", "_")
        dst_img = img_out / flat_name
        shutil.copy2(src_img, dst_img)
        with (lbl_out / flat_name.rsplit(".", 1)[0]).with_suffix(".txt").open("w") as lf:
            for bx, by, bw, bh in boxes:
                cx = (bx + bw / 2) / w
                cy = (by + bh / 2) / h
                lf.write(f"0 {cx:.6f} {cy:.6f} {bw / w:.6f} {bh / h:.6f}\n")
        count += 1
    return count


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, required=True, help="Root of unzipped WIDER FACE")
    ap.add_argument("--out", type=Path, required=True, help="YOLO-format output dir")
    args = ap.parse_args()

    n_train = _convert("train", args.raw, args.out)
    n_val = _convert("val", args.raw, args.out)

    data_yaml = args.out / "data.yaml"
    data_yaml.write_text(
        f"path: {args.out.resolve()}\n"
        "train: images/train\n"
        "val: images/val\n"
        "names:\n"
        "  0: face\n",
        encoding="utf-8",
    )
    print(f"Converted {n_train} train + {n_val} val images. Manifest: {data_yaml}")


if __name__ == "__main__":
    main()
