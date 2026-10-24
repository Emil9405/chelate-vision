// LabelOCR: text detection + angle classification + recognition with PP-OCR ONNX
// models, run through onnxruntime (web in the browser, node in tests).
//
//   import * as ort from 'onnxruntime-web';
//   const ocr = await LabelOCR.create({ ort, load: (f) => fetch('/models/' + f).then(r => r.arrayBuffer()) });
//   const { lines } = await ocr.recognize(imageData);   // ImageData or {data, width, height}
import { detPreprocess, detPostprocess } from './det.js';
import { makeRecBatch, makeClsBatch, ctcDecode } from './rec.js';
import { cropQuad, cropRect, resize, rot90, rot180 } from './image.js';

export const MODEL_FILES = {
  det: 'ppocr_v3_det.onnx',
  rec: 'ppocr_v3_rec.onnx',
  cls: 'ppocr_mobile_v2_cls.onnx',
  keys: 'ppocr_v3_keys.txt',
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LabelOCR {
  constructor(ort, sessions, charset, options) {
    this.ort = ort;
    this.s = sessions;
    this.charset = charset;
    this.opt = options;
  }

  /**
   * @param {object} p
   * @param {object} p.ort            onnxruntime module (onnxruntime-web or onnxruntime-node)
   * @param {(file:string)=>Promise<ArrayBuffer|Uint8Array|string>} p.load  model/keys loader
   * @param {object} [p.sessionOptions]  passed to InferenceSession.create
   * @param {number} [p.detLimit=960]    detector input: longest side limit
   * @param {boolean} [p.useCls=true]    0/180 classifier
   * @param {boolean} [p.zoom=true]      two-stage detection (find label, then detect inside it)
   */
  static async create({ ort, load, sessionOptions = {}, detLimit = 960, detLimitType = 'max', useCls = true, textScore = 0.5, recBatch = 6, zoom = true, boxThresh = 0.4 }) {
    const buf = async (f) => {
      const b = await load(f);
      return b instanceof Uint8Array ? b : new Uint8Array(b);
    };
    const [det, rec, cls, keys] = await Promise.all([
      buf(MODEL_FILES.det).then((b) => ort.InferenceSession.create(b, sessionOptions)),
      buf(MODEL_FILES.rec).then((b) => ort.InferenceSession.create(b, sessionOptions)),
      useCls ? buf(MODEL_FILES.cls).then((b) => ort.InferenceSession.create(b, sessionOptions)) : null,
      load(MODEL_FILES.keys).then((k) => (typeof k === 'string' ? k : new TextDecoder().decode(k))),
    ]);
    const charset = ['blank', ...keys.replace(/\n$/, '').split('\n'), ' '];
    return new LabelOCR(ort, { det, rec, cls }, charset, { detLimit, detLimitType, useCls, textScore, recBatch, zoom, boxThresh });
  }

  async run(session, data, dims) {
    const feeds = { [session.inputNames[0]]: new this.ort.Tensor('float32', data, dims) };
    const out = await session.run(feeds);
    const t = out[session.outputNames[0]];
    return { data: t.data, dims: t.dims };
  }

  /** Detect text boxes. Returns [{box, score}] in original image coordinates. */
  async detect(img, opt = {}) {
    const limit = opt.detLimit ?? this.opt.detLimit;
    const { tensor, width, height } = detPreprocess(img, limit, opt.detLimitType ?? this.opt.detLimitType);
    const { data } = await this.run(this.s.det, tensor, [1, 3, height, width]);
    return detPostprocess(data, width, height, img.width, img.height, { boxThresh: this.opt.boxThresh, ...opt });
  }

  /**
   * Two-stage detection: a cheap low-res pass finds where the text is (the label),
   * then the detector runs again on that region only, so small print (CAS, dates)
   * gets more pixels at the same cost.
   */
  async detectZoom(img, opt = {}) {
    const coarse = await this.detect(img, { ...opt, detLimit: opt.zoomProbe ?? 640 });
    if (!coarse.length) return this.detect(img, opt);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const hs = [];
    for (const { box } of coarse) {
      for (const [x, y] of box) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      hs.push(Math.hypot(box[0][0] - box[3][0], box[0][1] - box[3][1]));
    }
    hs.sort((a, b) => a - b);
    const pad = 2 * (hs[hs.length >> 1] || 0) + 0.03 * Math.max(img.width, img.height);
    const roi = { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(img.width, x1 + pad), y1: Math.min(img.height, y1 + pad) };
    if ((roi.x1 - roi.x0) * (roi.y1 - roi.y0) > 0.85 * img.width * img.height) return this.detect(img, opt);
    const sub = cropRect(img, roi.x0, roi.y0, roi.x1, roi.y1);
    const ox = Math.max(0, Math.floor(roi.x0)), oy = Math.max(0, Math.floor(roi.y0));
    const boxes = await this.detect(sub, opt);
    return boxes.map((b) => ({ ...b, box: b.box.map(([x, y]) => [x + ox, y + oy]) }));
  }

  /**
   * Full OCR. Returns { lines: [{text, score, box}], timings }.
   * opt.textScore: drop lines below this recognition confidence (default 0.5);
   * opt.keepLow: keep low-confidence lines (flagged low:true) for the field extractor.
   */
  async recognize(img, opt = {}) {
    const t0 = now();
    const boxes = (opt.zoom ?? this.opt.zoom) ? await this.detectZoom(img, opt) : await this.detect(img, opt);
    const t1 = now();
    let crops = boxes.map(({ box }) => {
      const c = cropQuad(img, box);
      return c.height / c.width >= 1.5 ? rot90(c) : c;
    });
    // angle classification, batched like PaddleOCR (sorted by aspect ratio)
    const order = crops.map((c, i) => [c.width / c.height, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const B = this.opt.recBatch;
    if (this.opt.useCls && this.s.cls) {
      for (let b = 0; b < order.length; b += B) {
        const idx = order.slice(b, b + B);
        const { data, dims } = makeClsBatch(idx.map((i) => crops[i]));
        const out = await this.run(this.s.cls, data, dims);
        idx.forEach((i, k) => {
          const p0 = out.data[k * 2], p180 = out.data[k * 2 + 1];
          if (p180 > p0 && p180 > 0.9) crops[i] = rot180(crops[i]);
        });
      }
    }
    const t2 = now();
    const results = new Array(crops.length);
    for (let b = 0; b < order.length; b += B) {
      const idx = order.slice(b, b + B);
      const { data, dims } = makeRecBatch(idx.map((i) => crops[i]));
      const out = await this.run(this.s.rec, data, dims);
      ctcDecode(out.data, out.dims, this.charset).forEach((r, k) => { results[idx[k]] = r; });
    }
    // Condensed or tall fonts (e.g. Merck's batch/article line) get squeezed at height 48
    // and CTC runs out of time steps. Retry unsure lines stretched horizontally, keep the better.
    const stretch = opt.stretch ?? 1.6;
    if (stretch > 1) {
      // only lines that can hold a key (article, batch, CAS, date all contain digits)
      const retry = order.filter((i) => results[i].score < 0.85 && (results[i].text.match(/\d/g) || []).length >= 3);
      for (let b = 0; b < retry.length; b += B) {
        const idx = retry.slice(b, b + B);
        const wide = idx.map((i) => resize(crops[i], Math.round(crops[i].width * stretch), crops[i].height));
        const { data, dims } = makeRecBatch(wide);
        const out = await this.run(this.s.rec, data, dims);
        ctcDecode(out.data, out.dims, this.charset).forEach((r, k) => {
          const i = idx[k];
          if (r.text && r.score > results[i].score + 0.02) results[i] = { ...r, stretched: true };
        });
      }
    }
    const t3 = now();
    const minScore = opt.textScore ?? this.opt.textScore;
    const lines = [];
    boxes.forEach(({ box }, i) => {
      const r = results[i];
      if (!r.text) return;
      const low = r.score < minScore;
      if (low && !opt.keepLow) return;
      lines.push({ text: r.text, score: Number(r.score.toFixed(4)), box, ...(low ? { low: true } : {}) });
    });
    return { lines, timings: { det: Math.round(t1 - t0), cls: Math.round(t2 - t1), rec: Math.round(t3 - t2), total: Math.round(t3 - t0) } };
  }
}
