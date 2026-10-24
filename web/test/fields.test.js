import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLabelFields, casCheckOk, parseDate } from '../src/fields.js';

const here = dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(readFileSync(join(here, '../../fixtures/labels/truth.json'), 'utf8'));
const L = (...texts) => texts.map((t, i) => (typeof t === 'string' ? { text: t, score: 0.95, box: [[0, i * 40], [400, i * 40], [400, i * 40 + 30], [0, i * 40 + 30]] } : t));
const box = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

test('CAS checksum', () => {
  for (const c of ['67-64-1', '95-57-8', '120-12-7', '110-54-3', '7732-18-5', '14371-10-9']) assert.ok(casCheckOk(c), c);
  for (const c of ['67-64-2', '110-5A-3', '12-1-1']) assert.ok(!casCheckOk(c), c);
});

test('dates', () => {
  assert.equal(parseDate('03.2016'), '2016-03');
  assert.equal(parseDate('SEP/22'), '2022-09');
  assert.equal(parseDate('2027-05-31'), '2027-05-31');
  assert.equal(parseDate('31.05.2027'), '2027-05-31');
  assert.equal(parseDate('OKT 2026'), '2026-10');
  assert.equal(parseDate('13.2016'), null);
});

test('real OCR output of the six fixtures', () => {
  const dir = join(here, 'vectors');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const name = f.replace('.json', '');
    const t = truth[name];
    const r = extractLabelFields(JSON.parse(readFileSync(join(dir, f), 'utf8')).lines);
    assert.equal(r.brand?.value, t.brand, `${name} brand`);
    assert.equal(r.article?.value?.toUpperCase(), t.article.toUpperCase(), `${name} article`);
    assert.equal(r.batch?.value, t.batch, `${name} batch`);
    if (t.batch_suffix) assert.equal(r.batch?.suffix, t.batch_suffix, `${name} batch suffix`);
    assert.equal(r.cas?.value ?? null, t.cas, `${name} cas`);
    if (t.expiry) assert.equal(r.expiry?.value, t.expiry, `${name} expiry`);
    if (t.pcode) assert.equal(r.pcode?.value, t.pcode, `${name} pcode`);
  }
});

test('Merck article: catalog and pack code', () => {
  const r = extractLabelFields(L('K47917114 622', '1.00014.2500', 'EMSURE', 'Merck KGaA, 64271 Darmstadt'));
  assert.deepEqual([r.article.value, r.article.catalog, r.article.pack_code], ['1.00014.2500', '100014', '2500']);
  assert.deepEqual([r.batch.value, r.batch.suffix], ['K47917114', '622']);
});

test('Merck article with the second dot read as a space', () => {
  const r = extractLabelFields(L('K48907426 711 1.05426 1000', 'EMPLURA', 'Merck KGaA'));
  assert.equal(r.article.value, '1.05426.1000');
  assert.deepEqual([r.batch.value, r.batch.suffix], ['K48907426', '711']);
});

test('Sigma/Macklin CAT-SIZE article gives pack', () => {
  let r = extractLabelFields(L('SIGMA-ALDRICH', 'W228605-1KG-K', 'Lot # MKCH5601'));
  assert.equal(r.article.value, 'W228605-1KG-K');
  assert.deepEqual(r.pack && [r.pack.value, r.pack.unit], [1, 'kg']);
  assert.equal(r.article.grade_suffix, 'K');
  assert.equal(r.batch.value, 'MKCH5601');
  r = extractLabelFields(L('MACKLIN', 'C805172-500g', 'LOT#:C804135'));
  assert.deepEqual([r.pack.value, r.pack.unit], [500, 'g']);
  assert.equal(r.batch.value, 'C804135');
});

test('keyword alone: value taken from the box to the right', () => {
  const lines = [
    { text: 'Batch :', score: 0.9, box: box(380, 1480, 100, 40) },
    { text: '11C230505', score: 0.9, box: box(530, 1470, 260, 55) },
    { text: '2.51', score: 0.9, box: box(150, 1490, 140, 70) },
  ];
  assert.equal(extractLabelFields(lines).batch.value, '11C230505');
});

test('"Lot" means batch, never the article', () => {
  const r = extractLabelFields(L('Lot: 1.05426.1000'));
  assert.equal(r.article.value, '1.05426.1000');
  assert.equal(r.batch, null);
});

test('CAS repaired by the checksum, unrepairable kept as invalid', () => {
  let r = extractLabelFields(L('CAS 110-5A-3'));
  assert.equal(r.cas.value, '110-54-3');
  assert.equal(r.cas.repaired, true);
  r = extractLabelFields(L('CAS-No: 67-64-2'));
  assert.equal(r.cas.value, null);
  assert.equal(r.cas.invalid, true);
});

test('phone numbers are not CAS', () => {
  const r = extractLabelFields(L('USA, Tel. +1-978-715-4321', 'Germany, Tel. +49(0)6151 72-2440'));
  assert.equal(r.cas, null);
});

test('name candidates prefer large repeated lines, skip grades and addresses', () => {
  const lines = [
    { text: 'EMSURE', box: box(0, 0, 300, 60) },
    { text: 'Acetone', box: box(0, 80, 300, 55) },
    { text: 'for analysis', box: box(0, 140, 250, 40) },
    { text: 'Aceton', box: box(0, 190, 250, 45) },
    { text: 'Acetona', box: box(0, 240, 250, 45) },
    { text: 'Made in Germany', box: box(0, 300, 200, 20) },
  ];
  const r = extractLabelFields(lines);
  assert.equal(r.names[0].value, 'Acetone');
  assert.ok(!r.names.some((n) => /EMSURE|Made in/.test(n.value)));
  assert.match(r.grade.value, /EMSURE/);
});
