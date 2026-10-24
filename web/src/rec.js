// Text line recognition (PP-OCR rec, CTC) and 0/180 angle classification.
import { resize, toBgrChw } from './image.js';

const HALF = [0.5, 0.5, 0.5];

// Resize a crop to height H keeping aspect, pad right with zeros to width W
// (zeros are in normalized space, as in PaddleOCR resize_norm_img).
function normPadded(img, H, W, target, offset) {
  const ratio = img.width / img.height;
  const rw = Math.ceil(H * ratio) > W ? W : Math.ceil(H * ratio);
  const small = resize(img, Math.max(1, rw), H);
  toBgrChw(small, HALF, HALF, target.subarray(offset), W, H * W);
}

export function makeRecBatch(crops, H = 48) {
  let maxRatio = 0;
  for (const c of crops) maxRatio = Math.max(maxRatio, c.width / c.height);
  const W = Math.trunc(H * maxRatio);
  const data = new Float32Array(crops.length * 3 * H * W);
  crops.forEach((c, i) => normPadded(c, H, W, data, i * 3 * H * W));
  return { data, dims: [crops.length, 3, H, W] };
}

export function ctcDecode(probs, dims, charset) {
  // probs: [N, T, C]; charset: ['blank', ...keys, ' ']
  const [N, T, C] = dims;
  const out = [];
  for (let n = 0; n < N; n++) {
    let text = '', conf = 0, k = 0, prev = -1;
    for (let t = 0; t < T; t++) {
      const base = (n * T + t) * C;
      let best = 0, bp = probs[base];
      for (let c = 1; c < C; c++) if (probs[base + c] > bp) { bp = probs[base + c]; best = c; }
      if (best !== 0 && best !== prev) { text += charset[best] ?? ''; conf += bp; k++; }
      prev = best;
    }
    out.push({ text, score: k ? conf / k : 0 });
  }
  return out;
}

export function makeClsBatch(crops, H = 48, W = 192) {
  const data = new Float32Array(crops.length * 3 * H * W);
  crops.forEach((c, i) => normPadded(c, H, W, data, i * 3 * H * W));
  return { data, dims: [crops.length, 3, H, W] };
}
