// Match extracted label fields against the host app's catalog (e.g. Chelate reagents).
//
// catalog: [{ id, name, synonyms?: string[], cas?: string, articles?: string[] }]
// returns: [{ id, score (0..1), reasons: string[], entry }] best first.
//
// Article and CAS are exact keys; names are fuzzy. An article that differs from a
// catalog article only by OCR-confusable characters is reported as a weaker match.
import { similarity } from './fields.js';

const normArt = (s) => (s || '').toUpperCase().replace(/[\s.,\-]/g, '');
const CONFUSE = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', T: '7' };
const loose = (s) => normArt(s).replace(/[ODQILZSBGT]/g, (c) => CONFUSE[c]);

function oneEdit(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
}

const normName = (s) => (s || '').normalize('NFKC').toLowerCase()
  .replace(/\(([il1|!]{1,3})\)/g, (m, g) => `(${'i'.repeat(g.length)})`)
  .replace(/\s+/g, ' ').trim();

export function matchCatalog(fields, catalog, { limit = 5 } = {}) {
  const art = fields?.article?.value ? normArt(fields.article.value) : null;
  const artLoose = art ? loose(art) : null;
  const cas = fields?.cas?.value || null;
  const names = (fields?.names || []).map((n) => normName(n.value)).filter(Boolean);
  const out = [];
  for (const e of catalog || []) {
    const reasons = [];
    let score = 0;
    const arts = (e.articles || []).map(normArt);
    if (art && arts.includes(art)) { score = Math.max(score, 1); reasons.push('article'); }
    else if (art && arts.some((a) => loose(a) === artLoose)) { score = Math.max(score, 0.85); reasons.push('article~ocr'); }
    else if (art && arts.some((a) => oneEdit(a, art))) { score = Math.max(score, 0.6); reasons.push('article~1'); }
    if (cas && e.cas && e.cas === cas) { score = Math.max(score, 0.9); reasons.push('cas'); }
    if (names.length) {
      const labels = [e.name, ...(e.synonyms || [])].map(normName).filter(Boolean);
      let best = 0;
      for (const n of names) for (const l of labels) {
        let s = similarity(n, l);
        // label text cut off at the edge: "Ammonia sol" vs "Ammonia solution 25%"
        const nl = n.replace(/[^a-z]/g, ''), ll = l.replace(/[^a-z]/g, '');
        if (nl.length >= 6 && (ll.startsWith(nl) || (nl.length >= 8 && ll.startsWith(nl.slice(0, -1))))) s = Math.max(s, 0.85);
        best = Math.max(best, s);
      }
      if (best >= 0.75) { score = Math.max(score, 0.7 * best); reasons.push(`name ${best.toFixed(2)}`); }
    }
    // agreement bonus: two independent keys pointing to the same entry
    if (reasons.length >= 2) score = Math.min(1, score + 0.1);
    if (score > 0) out.push({ id: e.id, score: Number(score.toFixed(3)), reasons, entry: e });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
