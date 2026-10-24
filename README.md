# Chelate Vision

On-device recognition for the chemistry lab, built to plug into [Chelate LIMS](https://github.com/Emil9405/Chelate) later and useful on its own before that.

- **Reagent labels** (working): photo of a bottle → article with pack (`1.05426.1000`), batch, CAS, expiry, brand, name candidates. Runs in the phone's browser; photos never leave the device.
- **Glassware** (planned): type and volume, counting on a shelf photo, chip/crack flagging. See [docs/glassware.md](docs/glassware.md) for the plan and how to collect photos.

## How label reading works

```
photo ─► text detection (DBNet) ─► text lines (CRNN/SVTR + CTC) ─► field rules ─► catalog match
          two passes: find the label,     retry unsure lines           brand formats,       exact article / CAS,
          then detect inside it           stretched horizontally       CAS checksum repair   fuzzy name
```

1. **OCR**: PaddleOCR PP-OCRv3 models (Apache-2.0) in ONNX, run by onnxruntime-web (wasm). About 14 MB of models plus 11 MB of runtime, cached by the browser after the first load.
2. **Fields** (`web/src/fields.js`): no ML, plain rules that know the label conventions:
   - article formats: Merck `1.NNNNN.NNNN`, Sigma/Macklin `CAT-SIZE` (`244023-100G`, `C805172-500g`), VWR `NNNNN.NNN`;
   - batch: the value after `Lot`/`Batch`/`Charge`, or the box next to the keyword, or the Merck pattern `K47917114 622` (batch + 3-digit tail; the tail is not in the Data Matrix);
   - CAS: checksum-validated; OCR confusions (`A`→`4`, `O`→`0`…) repaired only when the checksum then passes;
   - expiry: `Exp`, `Use by`, `guaranteed until`, `Retest`… in `03.2016`, `SEP/22`, `2027-05-31` and similar forms.
   - Every field carries a confidence (`high`/`medium`/`low`) and the index of the OCR line it came from, so a UI can show the photo crop next to the value.
3. **Catalog match** (`web/src/match.js`): the host app passes its reagents (`{id, name, synonyms, cas, articles}`); exact article and CAS are strong keys, names are fuzzy (cut-off names and `(ill)` for `(III)` handled).

Terminology follows Chelate: **lot** = article number with pack, **batch** = manufacturer batch number (which most labels print under the word "Lot").

## Results so far

Six real photos (Merck ×3, Sigma, VWR, Macklin) in `fixtures/labels/`, ground truth in `truth.json`:

| field | correct |
|---|---|
| brand | 6/6 |
| article (lot) | 6/6 |
| batch | 6/6 |
| CAS (printed on 4) | 4/4 |
| expiry (printed on 1) | 1/1 |
| name in top 3 candidates | 6/6 |

The pipeline settings (two-pass detection, box threshold 0.4, stretched retry) were tuned on these same six photos, so this is not an independent accuracy estimate. Next step is a held-out set of 30–50 new label photos.

Speed in headless Chromium (wasm, 1 thread, server CPU): 2–7 s per photo, mostly recognition of the many small lines. A phone will be slower; measure on the real device with the demo.

## Layout

```
models/         PP-OCR ONNX models + dictionary (Apache-2.0, see NOTICE.md)
fixtures/       labelled test photos
web/src/        the library (ES modules, no dependencies; onnxruntime is injected)
web/test/       unit tests, field evaluation, headless-browser check
web/demo/       demo page template + build script
python/         reference OCR (RapidOCR with the same models), later: glassware training
docs/           glassware plan
```

## Use

```js
import * as ort from 'onnxruntime-web';
import { LabelOCR, readLabel, matchCatalog } from 'chelate-vision';

ort.env.wasm.wasmPaths = '/ort/';                     // where ort-wasm-simd-threaded.{mjs,wasm} are served
const ocr = await LabelOCR.create({ ort, load: (f) => fetch('/models/' + f).then((r) => r.arrayBuffer()) });

const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
const { fields, lines } = await readLabel(ocr, imageData);
// fields.article.value  -> "1.00014.2500"   fields.batch.value -> "K47917114"   fields.cas.value -> "67-64-1"
const candidates = matchCatalog(fields, reagents);    // [{ id, score, reasons }]
```

Photos taken with `<input type="file" accept="image/*" capture="environment">` work over plain HTTP; live camera (`getUserMedia`) needs HTTPS. Multi-threaded wasm needs cross-origin isolation (`COOP: same-origin`, `COEP: require-corp` headers); without them it runs on one thread.

## Development

```sh
cd web
npm install --ignore-scripts      # onnxruntime-node's postinstall is not needed
npm test                          # unit tests incl. real OCR output of the fixtures
node test/run_ocr.js ../build/js ../fixtures/labels/*.jpg   # full pipeline in Node (wasm)
node test/eval.js ../build/js     # field accuracy against truth.json
node demo/build.mjs               # -> dist/demo (open index.html over http)
node test/browser_check.cjs /tmp  # headless Chromium: loads the demo, reads all samples
```

Reference OCR in Python (for comparison and, later, data tooling):

```sh
pip install -r python/requirements.txt
PYTHONPATH=python python -m chelate_vision.ocr_ref fixtures/labels/*.jpg --out build/ref --side 960
```

## Licence

Code: PolyForm Noncommercial 1.0.0 (same as Chelate). Models: Apache-2.0, see `models/NOTICE.md`.
