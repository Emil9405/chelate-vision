import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCatalog } from '../src/match.js';

const catalog = [
  { id: 1, name: 'Acetone', cas: '67-64-1', articles: ['1.00014.2500'] },
  { id: 2, name: 'Ammonia solution 32%', cas: '1336-21-6', articles: ['1.05426.1000'] },
  { id: 3, name: 'Ammonium chloride', cas: '12125-02-9', articles: ['1.01145.0500'] },
  { id: 4, name: 'Potassium hexacyanoferrate(III)', synonyms: ['Potassium ferricyanide'], cas: '13746-66-2', articles: ['244023-100G'] },
];
const F = (o) => ({ article: null, cas: null, names: [], ...o });

test('exact article wins', () => {
  const r = matchCatalog(F({ article: { value: '1.00014.2500' } }), catalog);
  assert.equal(r[0].id, 1);
  assert.equal(r[0].score, 1);
});

test('OCR-confused article (O for 0) still matches, weaker', () => {
  const r = matchCatalog(F({ article: { value: '1.O5426.1OOO' } }), catalog);
  assert.equal(r[0].id, 2);
  assert.ok(r[0].score < 1 && r[0].score >= 0.85);
});

test('one wrong digit is only a hint', () => {
  const r = matchCatalog(F({ article: { value: '1.05406.1000' } }), catalog);
  assert.equal(r[0].id, 2);
  assert.equal(r[0].score, 0.6);
});

test('cut-off name matches by prefix; roman numerals misread as ill', () => {
  let r = matchCatalog(F({ names: [{ value: 'Ammonia sol' }] }), catalog);
  assert.equal(r[0].id, 2);
  r = matchCatalog(F({ names: [{ value: 'Ammonia soll' }] }), catalog); // last char misread at the edge
  assert.equal(r[0].id, 2);
  r = matchCatalog(F({ names: [{ value: 'Potassium hexacyanoferrate(ill)' }] }), catalog);
  assert.equal(r[0].id, 4);
});

test('two keys agreeing raise the score', () => {
  const r = matchCatalog(F({ cas: { value: '67-64-1' }, names: [{ value: 'Acetone' }] }), catalog);
  assert.equal(r[0].id, 1);
  assert.ok(r[0].score >= 0.99);
});

test('nothing similar -> empty', () => {
  assert.deepEqual(matchCatalog(F({ names: [{ value: 'Toluene' }] }), catalog), []);
});
