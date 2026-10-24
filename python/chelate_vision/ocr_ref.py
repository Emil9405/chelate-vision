"""Reference OCR: runs the same PP-OCR ONNX models through RapidOCR and dumps
lines as JSON ({text, score, box}). The browser pipeline in web/src is checked
against this output.

    python -m chelate_vision.ocr_ref fixtures/labels/*.jpg --out build/ref --side 960
"""
import argparse
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "models"


def make_engine(side: int | None, side_type: str = "max"):
    from rapidocr_onnxruntime import RapidOCR

    kw = dict(
        det_model_path=str(MODELS / "ppocr_v3_det.onnx"),
        rec_model_path=str(MODELS / "ppocr_v3_rec.onnx"),
        cls_model_path=str(MODELS / "ppocr_mobile_v2_cls.onnx"),
    )
    if side:
        kw.update(det_limit_side_len=side, det_limit_type=side_type)
    return RapidOCR(**kw)


def run(engine, path: Path) -> dict:
    t = time.time()
    res, _ = engine(str(path))
    lines = [
        {"text": text, "score": round(float(score), 4), "box": [[round(float(x)), round(float(y))] for x, y in box]}
        for box, text, score in (res or [])
    ]
    return {"image": path.name, "ms": round((time.time() - t) * 1000), "lines": lines}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--side", type=int, default=None, help="detector resize limit (px)")
    ap.add_argument("--side-type", default="max", choices=["max", "min"])
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    eng = make_engine(a.side, a.side_type)
    for p in a.images:
        r = run(eng, p)
        (a.out / (p.stem + ".json")).write_text(json.dumps(r, ensure_ascii=False, indent=1))
        print(f"{p.stem:24} {r['ms']:6} ms  {len(r['lines'])} lines")


if __name__ == "__main__":
    main()
