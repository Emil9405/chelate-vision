// DBNet text detection (PP-OCR det model): pre- and post-processing, mirroring
// PaddleOCR/RapidOCR DetResizeForTest + DBPostProcess without OpenCV.
import { resize, toBgrChw } from './image.js';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const pyRound = (x) => {
  // Python 3 round(): half to even
  const f = Math.floor(x), diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
};

export function detInputSize(w, h, limit = 960, type = 'max') {
  let ratio = 1;
  if (type === 'max') { if (Math.max(h, w) > limit) ratio = limit / Math.max(h, w); }
  else if (Math.min(h, w) < limit) ratio = limit / Math.min(h, w);
  const rh = Math.max(32, pyRound(Math.trunc(h * ratio) / 32) * 32);
  const rw = Math.max(32, pyRound(Math.trunc(w * ratio) / 32) * 32);
  return { rw, rh };
}

export function detPreprocess(img, limit, type) {
  const { rw, rh } = detInputSize(img.width, img.height, limit, type);
  const small = resize(img, rw, rh);
  return { tensor: toBgrChw(small, MEAN, STD), width: rw, height: rh };
}

// ---- geometry

function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

// Minimum-area bounding rectangle (rotating calipers over hull edges).
export function minAreaRect(points) {
  const hull = convexHull(points.map((p) => [p[0], p[1]]));
  if (hull.length === 1) return { corners: [hull[0], hull[0], hull[0], hull[0]], w: 0, h: 0 };
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len; // edge direction
    const vx = -uy, vy = ux; // normal
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = p[0] * vx + p[1] * vy;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
  }
  const { ux, uy, vx, vy, minU, maxU, minV, maxV } = best;
  const pt = (u, v) => [u * ux + v * vx, u * uy + v * vy];
  return {
    corners: [pt(minU, minV), pt(maxU, minV), pt(maxU, maxV), pt(minU, maxV)],
    w: maxU - minU, h: maxV - minV,
  };
}

// get_mini_boxes ordering: [tl, tr, br, bl]
function orderBox(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const [l0, l1] = p[1][1] > p[0][1] ? [p[0], p[1]] : [p[1], p[0]];
  const [r0, r1] = p[3][1] > p[2][1] ? [p[2], p[3]] : [p[3], p[2]];
  return [l0, r0, r1, l1];
}

function expandRect(rect, ratio) {
  const { corners, w, h } = rect;
  const area = w * h, perim = 2 * (w + h);
  if (!perim) return rect;
  const d = (area * ratio) / perim;
  const cx = corners.reduce((s, c) => s + c[0], 0) / 4, cy = corners.reduce((s, c) => s + c[1], 0) / 4;
  // unit vectors along the rect sides
  const ex = [(corners[1][0] - corners[0][0]) / (w || 1), (corners[1][1] - corners[0][1]) / (w || 1)];
  const ey = [(corners[3][0] - corners[0][0]) / (h || 1), (corners[3][1] - corners[0][1]) / (h || 1)];
  const W = w + 2 * d, H = h + 2 * d;
  const pt = (sx, sy) => [cx + sx * W / 2 * ex[0] + sy * H / 2 * ey[0], cy + sx * W / 2 * ex[1] + sy * H / 2 * ey[1]];
  return { corners: [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)], w: W, h: H };
}

function insideConvex(quad, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}

function boxScoreFast(pred, W, H, quad) {
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x0 = Math.min(Math.max(Math.floor(Math.min(...xs)), 0), W - 1);
  const x1 = Math.min(Math.max(Math.ceil(Math.max(...xs)), 0), W - 1);
  const y0 = Math.min(Math.max(Math.floor(Math.min(...ys)), 0), H - 1);
  const y1 = Math.min(Math.max(Math.ceil(Math.max(...ys)), 0), H - 1);
  const q = quad.map((p) => [Math.trunc(p[0]), Math.trunc(p[1])]);
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (insideConvex(q, x, y)) { sum += pred[y * W + x]; n++; }
  }
  return n ? sum / n : 0;
}

// ---- post-processing

export function detPostprocess(pred, W, H, srcW, srcH, opt = {}) {
  const thresh = opt.thresh ?? 0.3, boxThresh = opt.boxThresh ?? 0.5;
  const unclipRatio = opt.unclipRatio ?? 1.6, maxCandidates = opt.maxCandidates ?? 1000;
  const minSize = 3;
  // binarize + 2x2 dilation (cv2 anchor (1,1): out(x,y) = max over x-1..x, y-1..y)
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = pred[i] > thresh ? 1 : 0;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    mask[i] = bin[i] | (x > 0 ? bin[i - 1] : 0) | (y > 0 ? bin[i - W] : 0) | (x > 0 && y > 0 ? bin[i - W - 1] : 0);
  }
  // 8-connected components, keeping per-row extremes as hull candidates
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const boxes = [];
  let comp = 0;
  for (let start = 0; start < W * H && comp < maxCandidates; start++) {
    if (!mask[start] || label[start]) continue;
    comp++;
    const rowMin = new Map(), rowMax = new Map();
    let sp = 0; stack[sp++] = start; label[start] = comp;
    while (sp) {
      const i = stack[--sp];
      const x = i % W, y = (i - x) / W;
      if (!rowMin.has(y) || x < rowMin.get(y)) rowMin.set(y, x);
      if (!rowMax.has(y) || x > rowMax.get(y)) rowMax.set(y, x);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if ((!dx && !dy) || nx < 0 || nx >= W) continue;
          const j = ny * W + nx;
          if (mask[j] && !label[j]) { label[j] = comp; stack[sp++] = j; }
        }
      }
    }
    const pts = [];
    for (const [y, x] of rowMin) { pts.push([x, y]); const xm = rowMax.get(y); if (xm !== x) pts.push([xm, y]); }
    const r = minAreaRect(pts);
    if (Math.min(r.w, r.h) < minSize) continue;
    const quad = orderBox(r.corners);
    const score = boxScoreFast(pred, W, H, quad);
    if (score < boxThresh) continue;
    const ex = expandRect(r, unclipRatio);
    if (Math.min(ex.w, ex.h) < minSize + 2) continue;
    let box = orderBox(ex.corners).map(([x, y]) => [
      Math.min(Math.max(Math.round((x / W) * srcW), 0), srcW),
      Math.min(Math.max(Math.round((y / H) * srcH), 0), srcH),
    ]);
    // order_points_clockwise + clip_det_res + size filter (as RapidOCR filter_tag_det_res)
    box = orderBox(box).map(([x, y]) => [Math.min(Math.max(x, 0), srcW - 1), Math.min(Math.max(y, 0), srcH - 1)]);
    const bw = Math.trunc(Math.hypot(box[0][0] - box[1][0], box[0][1] - box[1][1]));
    const bh = Math.trunc(Math.hypot(box[0][0] - box[3][0], box[0][1] - box[3][1]));
    if (bw <= 3 || bh <= 3) continue;
    boxes.push({ box, score });
  }
  return sortBoxes(boxes);
}

// top-to-bottom, left-to-right (RapidOCR sorted_boxes)
export function sortBoxes(boxes) {
  const b = [...boxes].sort((p, q) => p.box[0][1] - q.box[0][1] || p.box[0][0] - q.box[0][0]);
  for (let i = 0; i < b.length - 1; i++) {
    if (Math.abs(b[i + 1].box[0][1] - b[i].box[0][1]) < 10 && b[i + 1].box[0][0] < b[i].box[0][0]) {
      [b[i], b[i + 1]] = [b[i + 1], b[i]];
    }
  }
  return b;
}
