// Field-level evaluation against fixtures/labels/truth.json.
// usage: node test/eval.js <dir with <name>.json OCR dumps> [--verbose]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLabelFields, similarity } from '../src/fields.js';

const here = dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(readFileSync(join(here, '../../fixtures/labels/truth.json'), 'utf8'));
const dir = process.argv[2];
const verbose = process.argv.includes('--verbose');
const FIELDS = ['brand', 'article', 'batch', 'cas', 'expiry', 'pcode', 'name'];
const tot = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, wrong: 0, miss: 0, n: 0 }]));

export function scoreOne(t, f) {
  const res = {};
  const cmp = (key, got) => {
    const want = t[key];
    if (want == null) return got == null ? null : 'extra';
    if (got == null) return 'miss';
    return String(got).toUpperCase() === String(want).toUpperCase() ? 'ok' : `wrong(${got})`;
  };
  res.brand = cmp('brand', f.brand?.value);
  res.article = cmp('article', f.article?.value);
  res.batch = cmp('batch', f.batch?.value);
  res.cas = cmp('cas', f.cas?.value);
  res.expiry = cmp('expiry', f.expiry?.value);
  res.pcode = cmp('pcode', f.pcode?.value);
  const top = f.names?.[0]?.value;
  // a name cut off by the label edge counts if it is a clean prefix of the true name
  const prefixOk = (v) => { const a = v.toLowerCase().replace(/[^a-z]/g, ''); return a.length >= 6 && t.name.toLowerCase().replace(/[^a-z]/g, '').startsWith(a); };
  const inTop3 = (f.names || []).slice(0, 3).some((n) => similarity(n.value, t.name) >= 0.8 || prefixOk(n.value));
  res.name = inTop3 ? 'ok' : top ? `wrong(${top})` : 'miss';
  return res;
}

for (const file of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  const t = truth[name];
  if (!t) continue;
  const dump = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const f = extractLabelFields(dump.lines);
  const r = scoreOne(t, f);
  for (const k of FIELDS) {
    if (r[k] == null) continue;
    tot[k].n++;
    if (r[k] === 'ok') tot[k].ok++; else if (r[k] === 'miss') tot[k].miss++; else tot[k].wrong++;
  }
  console.log(name.padEnd(22), FIELDS.map((k) => `${k}:${r[k] ?? '-'}`).join('  '));
  if (verbose) console.log(JSON.stringify(f, null, 1));
}
console.log('\nfield      ok/n  wrong miss');
for (const k of FIELDS) console.log(k.padEnd(9), `${tot[k].ok}/${tot[k].n}`.padStart(6), String(tot[k].wrong).padStart(5), String(tot[k].miss).padStart(4));
