// Run the JS pipeline (onnxruntime-web, wasm, same as the phone) over images; dump OCR lines.
// usage: node test/run_ocr.js <outDir> [--limit 960] img1.jpg img2.jpg ...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import * as ort from 'onnxruntime-web';
import { LabelOCR } from '../src/ocr.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODELS = join(here, '../../models');
const args = process.argv.slice(2);
const out = args.shift();
let limit = 960;
const li = args.indexOf('--limit');
if (li >= 0) { limit = Number(args[li + 1]); args.splice(li, 2); }
let boxThresh = 0.4;
const bi = args.indexOf('--box');
if (bi >= 0) { boxThresh = Number(args[bi + 1]); args.splice(bi, 2); }
const zoom = !args.includes('--no-zoom');
if (!zoom) args.splice(args.indexOf('--no-zoom'), 1);
ort.env.wasm.numThreads = 1;
mkdirSync(out, { recursive: true });

const ocr = await LabelOCR.create({ ort, detLimit: limit, zoom, load: async (f) => readFileSync(join(MODELS, f)) });
for (const p of args) {
  const img = jpeg.decode(readFileSync(p), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  const { lines, timings } = await ocr.recognize({ data: img.data, width: img.width, height: img.height }, { boxThresh });
  writeFileSync(join(out, basename(p).replace(/\.\w+$/, '.json')), JSON.stringify({ image: basename(p), timings, lines }, null, 1));
  console.log(basename(p).padEnd(28), JSON.stringify(timings), lines.length, 'lines');
}
