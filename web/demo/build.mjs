// Builds dist/demo: one HTML page (library bundled inline) + models, ORT wasm and sample photos.
// usage: node demo/build.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(root, 'dist/demo');
for (const d of ['', 'models', 'ort', 'samples']) mkdirSync(join(out, d), { recursive: true });

const bundle = await build({
  entryPoints: [join(here, '../src/index.js')], bundle: true, format: 'iife', globalName: 'ChelateVision',
  minify: true, write: false, target: 'es2020', charset: 'ascii',
});
const lib = bundle.outputFiles[0].text + '\nconst { LabelOCR, MODEL_FILES, extractLabelFields, matchCatalog } = ChelateVision;';

const TITLES = {
  merck_acetone: 'Ацетон, Merck EMSURE', merck_ammonia: 'Аммиак, Merck EMPLURA', merck_anthracene: 'Антрацен, Merck',
  vwr_hexane: 'н-Гексан, VWR', macklin_chlorophenol: 'о-Хлорфенол, Macklin', sigma_ferricyanide: 'Феррицианид калия, Sigma',
};
const order = ['merck_acetone', 'sigma_ferricyanide', 'vwr_hexane', 'macklin_chlorophenol', 'merck_anthracene', 'merck_ammonia'];
const samples = order.map((name) => {
  const v = JSON.parse(readFileSync(join(here, '../test/vectors', name + '.json'), 'utf8'));
  return { name, title: TITLES[name], lines: v.lines.map(({ text, score, box }) => ({ text, score, box })) };
});

let html = readFileSync(join(here, 'template.html'), 'utf8');
html = html.replace('/*CV_BUNDLE*/', () => lib).replace('/*CV_SAMPLES*/', () => `const SAMPLES = ${JSON.stringify(samples)};`);
// artifact.html: page body only (claude.ai artifact wraps it; models as base64 text because .onnx is not served there)
// index.html: standalone page for self-hosting (plain .onnx)
writeFileSync(join(out, 'artifact.html'), html.replace('/*CV_MODEL_MODE*/', 'const MODELS_AS_BASE64 = true;'));
const standalone = html.replace('/*CV_MODEL_MODE*/', 'const MODELS_AS_BASE64 = false;');
writeFileSync(join(out, 'index.html'), `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${standalone}\n</body>\n</html>\n`);

for (const f of readdirSync(join(root, 'models'))) {
  if (!/\.(onnx|txt)$/.test(f)) continue;
  copyFileSync(join(root, 'models', f), join(out, 'models', f));
  if (f.endsWith('.onnx')) writeFileSync(join(out, 'models', f + '.b64.txt'), readFileSync(join(root, 'models', f)).toString('base64'));
}
copyFileSync(join(here, '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'), join(out, 'ort/ort-wasm-simd-threaded.wasm'));
for (const name of order) {
  copyFileSync(join(root, 'fixtures/labels', name + '.jpg'), join(out, 'samples', name + '.jpg'));
  copyFileSync(join(here, 'samples', name + '_thumb.jpg'), join(out, 'samples', name + '_thumb.jpg'));
}
console.log('built', out, (html.length / 1024).toFixed(0) + ' KB html');
