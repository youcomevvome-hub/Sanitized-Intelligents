# Fine-tuning

You only need to fine-tune when:

* You have a **custom face domain** (masks, low-light CCTV, drone footage,
  cartoon avatars, etc.) where the pretrained YOLOv8-face misses faces.
* You have a **custom ID document layout** (e.g. a national ID with a
  specific format) and want a dedicated YOLO detector for the ID region
  *instead of* relying on OCR + regex.

For everything else, the pretrained stack
(YOLOv8-face + RetinaFace + EasyOCR + Presidio) is already state of the art.

## 1. Fine-tune YOLOv8-face on a custom face dataset

### Datasets you can use

| Dataset | What it gives you | License |
|---|---|---|
| **WIDER FACE** | 32k images, 393k faces, hard real-world conditions | Research-only (free) |
| **FDDB** | 5k images, 2.8k faces | Free for research |
| **MAFA** | Masked face benchmark | Free for research |
| **Open Images V7 (Human face class)** | Large-scale, CC-BY | Commercial-friendly |

Download WIDER FACE: <http://shuoyang1213.me/WIDERFACE/>

### Convert to YOLO format

```bash
python -m sanitizer.training.prepare_widerface \
    --raw /data/wider \
    --out /data/wider_yolo
```

### Train

```bash
python -m sanitizer.training.train_yolo_face \
    --data /data/wider_yolo/data.yaml \
    --weights yolov8n-face.pt \
    --epochs 50 \
    --imgsz 640
```

The resulting `runs/detect/train/weights/best.pt` can be dropped into
`./models/yolov8n-face.pt` and the pipeline will pick it up automatically.

## 2. Fine-tune for custom ID documents

Label your IDs with a tool like [LabelImg](https://github.com/HumanSignal/labelImg)
or CVAT, export YOLO format, then run the same `train_yolo_face.py` with a
fresh class list (edit `data.yaml`).
