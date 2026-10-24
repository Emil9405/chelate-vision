// Minimal image ops on RGBA buffers ({ data: Uint8ClampedArray|Uint8Array, width, height }).
// Pure JS so the same pipeline runs in the browser and in Node (tests).

export function makeImage(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

// Bilinear resize (same sampling grid as cv2.INTER_LINEAR: half-pixel centres, no antialias).
export function resize(src, dw, dh) {
  const { data: s, width: sw, height: sh } = src;
  const out = makeImage(dw, dh);
  const d = out.data;
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * fy - 0.5;
    if (sy < 0) sy = 0;
    let y0 = Math.floor(sy);
    if (y0 > sh - 1) y0 = sh - 1;
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * fx - 0.5;
      if (sx < 0) sx = 0;
      let x0 = Math.floor(sx);
      if (x0 > sw - 1) x0 = sw - 1;
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c] + (s[i01 + c] - s[i00 + c]) * wx;
        const bot = s[i10 + c] + (s[i11 + c] - s[i10 + c]) * wx;
        d[o + c] = top + (bot - top) * wy;
      }
      d[o + 3] = 255;
    }
  }
  return out;
}

// Solve the homography H that maps dst (rect corners) -> src quad.
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const piv = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = b[r];
    for (let k = r + 1; k < n; k++) acc -= A[r][k] * h[k];
    h[r] = acc / (A[r][r] || 1e-12);
  }
  return [...h, 1];
}

// Perspective crop of a quad [tl, tr, br, bl] to an upright w x h image
// (as PaddleOCR get_rotate_crop_image: border replicate; bilinear instead of cubic).
export function cropQuad(src, quad) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(1, Math.trunc(Math.max(d(quad[0], quad[1]), d(quad[2], quad[3]))));
  const h = Math.max(1, Math.trunc(Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]))));
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], quad);
  const out = makeImage(w, h);
  const { data: s, width: sw, height: sh } = src;
  const o = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = H[6] * x + H[7] * y + H[8];
      let u = (H[0] * x + H[1] * y + H[2]) / den;
      let v = (H[3] * x + H[4] * y + H[5]) / den;
      u = Math.min(Math.max(u, 0), sw - 1);
      v = Math.min(Math.max(v, 0), sh - 1);
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const wx = u - x0, wy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const oi = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c] + (s[i01 + c] - s[i00 + c]) * wx;
        const bot = s[i10 + c] + (s[i11 + c] - s[i10 + c]) * wx;
        o[oi + c] = top + (bot - top) * wy;
      }
      o[oi + 3] = 255;
    }
  }
  return out;
}

// np.rot90 (counter-clockwise)
export function rot90(src) {
  const { data: s, width: w, height: h } = src;
  const out = makeImage(h, w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = y, ny = w - 1 - x;
      const si = (y * w + x) * 4, di = (ny * h + nx) * 4;
      out.data[di] = s[si]; out.data[di + 1] = s[si + 1]; out.data[di + 2] = s[si + 2]; out.data[di + 3] = 255;
    }
  }
  return out;
}

export function rot180(src) {
  const { data: s, width: w, height: h } = src;
  const out = makeImage(w, h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    out.data[j * 4] = s[i * 4]; out.data[j * 4 + 1] = s[i * 4 + 1]; out.data[j * 4 + 2] = s[i * 4 + 2]; out.data[j * 4 + 3] = 255;
  }
  return out;
}

// RGBA -> CHW float32 in BGR channel order (PaddleOCR models are trained on cv2 BGR images).
// out[c] = (pixel/255 - mean[c]) / std[c]; written into `target` at channel stride `planeStride`
// and row stride `rowStride` (lets the caller pad to a wider tensor).
export function toBgrChw(img, mean, std, target, rowStride = img.width, planeStride = img.width * img.height) {
  const { data, width, height } = img;
  const out = target || new Float32Array(3 * width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = y * rowStride + x;
      out[o] = (data[i + 2] / 255 - mean[0]) / std[0];
      out[planeStride + o] = (data[i + 1] / 255 - mean[1]) / std[1];
      out[2 * planeStride + o] = (data[i] / 255 - mean[2]) / std[2];
    }
  }
  return out;
}

// Axis-aligned crop (clamped to the image).
export function cropRect(src, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(src.width, Math.ceil(x1)); y1 = Math.min(src.height, Math.ceil(y1));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const si = ((y0 + y) * src.width + x0) * 4;
    out.data.set(src.data.subarray(si, si + w * 4), y * w * 4);
  }
  return out;
}
