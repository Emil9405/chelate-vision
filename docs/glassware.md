# Glassware: plan and data collection

Three tasks, in the order they will be built. Each one runs on the phone, like label reading.

| Task | What the model does | Model type | Difficulty |
|---|---|---|---|
| 1. Type and volume | finds each item and names it: `volumetric_flask_100`, `beaker_250`… | object detector | medium |
| 2. Counting | counts items per class on a shelf photo | same detector, no extra model | follows from 1 |
| 3. Chips and cracks | marks items to inspect | classifier on each found item | hard |

## Why volume is not guessed from size

A 100 mL and a 250 mL beaker look alike in a photo when the distance is unknown. Volume comes
from two sources instead:

1. the class itself, when the shape is unique to a size (a 1000 mL volumetric flask is not a 100 mL one scaled up, the neck-to-bulb ratio differs), and
2. the printed marking on the glass (`100 mL`, `A`, `±0.10`, `20 °C`) read by the label OCR that already exists.

When the two disagree, the marking wins and the UI asks to check.

## Classes, first version

Only the items the lab really has. Start with these and extend:

- beaker: 50, 100, 250, 400, 600, 1000 mL
- Erlenmeyer flask: 100, 250, 500 mL
- volumetric flask: 25, 50, 100, 250, 500, 1000 mL
- graduated cylinder: 10, 25, 50, 100, 250, 500, 1000 mL
- round-bottom flask: 50, 100, 250, 500 mL
- pipette (volumetric / graduated), burette, funnel, Petri dish, watch glass, vial

If a size is rare, it is merged into a coarser class (`beaker_large`) rather than dropped.

## How to take the photos

Quality of the data decides quality of the model; the model choice matters much less.

1. **Background.** Shoot on the real shelves and benches, not on a white sheet. The model has to work where it will be used.
2. **Variety per class.** At least **60–100 photos where the class appears**, taken on different days, under different light, at different angles (front, 45°, from above), clean and with liquid, alone and in a crowd.
3. **Crowded scenes.** For counting, 50+ photos of full shelves and drying racks, with items overlapping.
4. **Defects.** Every chipped or cracked item you find: 5–10 photos of it from different sides, and one of the same item with the defect out of view. Keep a list of which item is which. Defects are rare, so collect them over months; this is the slowest part.
5. **Phone.** Normal photo mode, no zoom, no filters. Several phones are better than one.

A rough budget for the first version: 1500–2500 photos, 2–3 hours of shooting per week for a month.

## Labelling

Boxes are drawn in [Label Studio](https://labelstud.io) or [CVAT](https://www.cvat.ai) (both open source, run locally).
To save time, the first boxes are proposed by an open-vocabulary detector (OWLv2, Apache-2.0) from text
prompts like "beaker", "volumetric flask"; a person corrects the class and size. After the first
500 photos the trained model itself proposes boxes for the rest.

Export format: COCO JSON. Images and labels go to `data/glassware/` (not to git; too large).
Split by **day of shooting**, not randomly, so test photos are really new scenes.

## Model and licences

Ultralytics YOLO (v5/v8/v11) is AGPL-3.0, which is not compatible with Chelate's PolyForm
Noncommercial licence for a closed deployment. Candidates with permissive licences:

| Model | Licence | Size (ONNX) | Note |
|---|---|---|---|
| PP-PicoDet S/M | Apache-2.0 | 1–5 MB | made for phones, fast on CPU/wasm |
| YOLOX-Nano/Tiny | Apache-2.0 | 4–20 MB | simple to train, good baseline |
| RT-DETR-R18 / D-FINE-N | Apache-2.0 | 15–40 MB | more accurate, slower in the browser |

Plan: train PicoDet and YOLOX-Nano on the same data on the institute's workstations (CPU training
is slow; a cheap rented GPU for a few hours is the alternative), compare on the test split, export
the winner to ONNX and run it with the same onnxruntime-web as the OCR.

## Defects

Transparent glass, glare and the rarity of defects make this the hardest task. The realistic goal:
the model flags "inspect this one" with high recall, a person decides. Two approaches will be tried:

1. a classifier on the detector's crops (`ok` / `chip` / `crack`), trained with heavy augmentation;
2. anomaly detection (PatchCore-style), trained only on intact items, when defect photos are too few.

Success criterion for a first version: finds 8 of 10 defective items in the test set; false alarms
are acceptable as long as fewer than 1 in 5 intact items is flagged.

## Metrics we will report

- type: mAP@0.5 per class and a confusion matrix (which sizes are confused);
- counting: mean absolute error per shelf photo;
- defects: recall and false-alarm rate on intact items.
