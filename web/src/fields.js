// Field extraction from OCR lines of a reagent bottle label.
//
// Input: lines = [{ text, score, box: [[x,y] x4] }] in reading order (any order works).
// Output: { brand, article, batch, cas, expiry, pcode, pack, grade, purity, formula, mw, names }
// Every field is either null or { value, confidence: 'high'|'medium'|'low', line, ...details }.
// `line` is the index into `lines`, so a UI can show the photo crop next to the value.
//
// Terminology (Chelate): "article" = article number with pack, printed form
// (лот, e.g. 1.05426.1000); "batch" = manufacturer batch/lot number (батч).
// Note: most labels print the batch under the word "Lot".

// ---------------------------------------------------------------- helpers

const nfkc = (s) => (s || '').normalize('NFKC');

export function boxGeom(box) {
  if (!box || box.length < 4) return { x0: 0, x1: 0, y0: 0, y1: 0, cx: 0, cy: 0, h: 0, w: 0 };
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const h = (d(box[0], box[3]) + d(box[1], box[2])) / 2;
  const w = (d(box[0], box[1]) + d(box[3], box[2])) / 2;
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h, w };
}

// OCR confusions towards digits, used only where a digit is expected.
const TO_DIGIT = { O: '0', o: '0', D: '0', Q: '0', U: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', L: '1', Z: '2', z: '2', A: '4', S: '5', s: '5', G: '6', b: '6', T: '7', B: '8', g: '9', q: '9' };
const digitize = (s) => s.replace(/[^0-9]/g, (c) => TO_DIGIT[c] ?? c);

export function casCheckOk(cas) {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas || '');
  if (!m) return false;
  const body = (m[1] + m[2]).split('').reverse();
  const sum = body.reduce((acc, ch, i) => acc + Number(ch) * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, 'MÄR': 3, MRZ: 3, APR: 4, MAY: 5, MAI: 5, JUN: 6, JUL: 7, AUG: 8,
  SEP: 9, SEPT: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DEZ: 12,
};
const pad2 = (n) => String(n).padStart(2, '0');
const year4 = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
const okMonth = (m) => m >= 1 && m <= 12;

export function parseDate(raw) {
  const s = nfkc(raw).toUpperCase().replace(/\s+/g, ' ').trim();
  let m;
  if ((m = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s)) && okMonth(+m[2])) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  if ((m = /(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/.exec(s)) && okMonth(+m[2])) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  if ((m = /(?<!\d)(\d{1,2})\s?[./-]\s?(20\d{2})(?!\d)/.exec(s)) && okMonth(+m[1])) return `${m[2]}-${pad2(m[1])}`;
  if ((m = /(20\d{2})\s?[./-]\s?(\d{1,2})(?!\d)/.exec(s)) && okMonth(+m[2])) return `${m[1]}-${pad2(m[2])}`;
  if ((m = /([A-ZÄ]{3,4})\s?[/.\- ]?\s?(\d{4}|\d{2})(?!\d)/.exec(s)) && MONTHS[m[1]]) return `${year4(m[2])}-${pad2(MONTHS[m[1]])}`;
  return null;
}

// ---------------------------------------------------------------- brand

const BRANDS = [
  ['merck', /\bMERCK\b|MERCK\s?KGAA|EMSURE|EMPLURA|EMPARTA|LICHROSOLV|SUPRAPUR|MILLIPORE|DARMSTADT/],
  ['sigma', /SIGMA|ALDRICH|PCODE|FLUKA|SUPELCO|SPRUCE\s?STREET|ST\.?\s?LOUIS|^SOURCE\s?#?\s?[A-Z0-9]{5,}/],
  ['vwr', /\bVWR\b|PROLABO|NORMAPUR|ANALAR|RECTAPUR|\bBDH\b/],
  ['macklin', /MACKLIN/],
  ['thermo', /THERMO|FISHER|ACROS|ALFA\s?AESAR/],
  ['tci', /\bTCI\b|TOKYO CHEMICAL/],
  ['honeywell', /HONEYWELL|RIEDEL/],
  ['carlroth', /CARL\s?ROTH|\bROTH\b/],
  ['panreac', /PANREAC|APPLICHEM/],
];

function detectBrand(lines) {
  const counts = {};
  lines.forEach((l, i) => {
    const t = nfkc(l.text).toUpperCase();
    for (const [b, re] of BRANDS) if (re.test(t)) (counts[b] ||= []).push(i);
  });
  const best = Object.entries(counts).sort((a, b) => b[1].length - a[1].length)[0];
  if (!best) return null;
  return { value: best[0], confidence: best[1].length >= 2 ? 'high' : 'medium', line: best[1][0] };
}

// ---------------------------------------------------------------- article

// second separator may be read as a space: "1.05426 1000"
const RE_MERCK_ART = /(?<![\d.,])([1-9])\s?[.,]\s?(\d{5})(\s?[.,]\s?|\s)(\d{4})(?![\d])/;
const RE_VWR_ART = /(?<![\d.,])(\d{5})\s?[.,]\s?(\d{3})(?![\d.,])/;
const RE_CAT_SIZE = /(?<![A-Z0-9])([A-Z]{0,3}\d{3,7})-(\d+(?:[.,]\d+)?)\s?(MG|G|KG|ML|L|UL|ΜL|µL|MCG|EA)(?:-([A-Z0-9]{1,3}))?(?![A-Z0-9])/i;

function findArticle(lines, brand) {
  const found = [];
  lines.forEach((l, i) => {
    const t = nfkc(l.text);
    let m;
    if ((m = RE_MERCK_ART.exec(t))) {
      found.push({
        value: `${m[1]}.${m[2]}.${m[4]}`, format: 'merck', catalog: `${m[1]}${m[2]}`, pack_code: m[4],
        line: i, rank: 3, ...(/[.,]/.test(m[3]) ? {} : { separator_guessed: true }),
      });
    }
    if ((m = RE_CAT_SIZE.exec(t))) {
      const unit = m[3].replace(/^[Μµ]/i, 'U').toUpperCase();
      found.push({
        value: m[0].replace(/\s+/g, ''), format: 'cat-size', catalog: m[1].toUpperCase(),
        size: { value: Number(m[2].replace(',', '.')), unit: normUnit(unit) }, grade_suffix: m[4] || null,
        line: i, rank: 3,
      });
    }
    if (!RE_MERCK_ART.test(t) && (m = RE_VWR_ART.exec(t))) {
      const prefixed = /PROD|ART|CAT|REF/i.test(t) || /PROD|ART|CAT|REF/i.test(lines[i - 1]?.text || '');
      found.push({
        value: `${m[1]}.${m[2]}`, format: 'vwr', catalog: m[1], pack_code: m[2], line: i,
        rank: brand?.value === 'vwr' || prefixed ? 2 : 0,
      });
    }
  });
  const want = { merck: 'merck', sigma: 'cat-size', macklin: 'cat-size', vwr: 'vwr' }[brand?.value];
  found.sort((a, b) => (b.format === want) - (a.format === want) || b.rank - a.rank);
  const a = found[0];
  if (!a || a.rank === 0) return a ? { ...a, confidence: 'low' } : null;
  const confidence = (!want || a.format === want) && !a.separator_guessed ? 'high' : 'medium';
  delete a.rank;
  return { ...a, confidence };
}

function normUnit(u) {
  return { MG: 'mg', G: 'g', KG: 'kg', ML: 'mL', L: 'L', UL: 'µL', MCG: 'µg', EA: 'pcs' }[u] || u;
}

// ---------------------------------------------------------------- neighbours

// Nearest line to the right on the same row, else nearest above/below.
function neighbour(lines, i, accept) {
  const k = boxGeom(lines[i].box);
  let best = null;
  lines.forEach((l, j) => {
    if (j === i || !accept(nfkc(l.text).trim())) return;
    const g = boxGeom(l.box);
    const hk = Math.max(k.h, 8);
    let dist = Infinity;
    if (Math.abs(g.cy - k.cy) < 0.9 * Math.max(hk, g.h) && g.x0 > k.x1 - hk) {
      dist = Math.max(0, g.x0 - k.x1);
    } else {
      const xOverlap = Math.min(g.x1, k.x1 + 2 * hk) - Math.max(g.x0, k.x0 - 2 * hk);
      const dy = g.cy > k.cy ? g.y0 - k.y1 : k.y0 - g.y1;
      if (xOverlap > 0 && dy > -hk && dy < 4 * Math.max(hk, g.h)) dist = 1.5 * Math.max(0, dy) + hk;
    }
    if (dist < 12 * hk && (!best || dist < best.dist)) best = { j, dist };
  });
  return best?.j ?? null;
}

// ---------------------------------------------------------------- batch

const KW_BATCH = /(?:\bLOT|\bBATCH|\bCHARGE|\bCH\.?-?B\.?|\bLOTE)\s*(?:NO\.?|NR\.?|NUMBER)?\s*[#:.№]{0,3}\s*/i;
const KW_SOURCE = /\bSOURCE\s*[#:.№]{0,3}\s*/i;
const KW_BATCH_ONLY = /^(?:LOT|BATCH|CHARGE|CH\.?-?B\.?|LOTE)\s*(?:NO\.?|NR\.?|NUMBER)?\s*[#:.№]{0,3}\s*$/i;
const RE_MERCK_BATCH = /(?<![A-Z0-9])([A-Z]\d{7,8})\s?(\d{3})(?![0-9])/;
const batchish = (s) => /^[A-Z0-9][A-Z0-9\-/ ]{3,20}$/i.test(s) && (s.match(/\d/g) || []).length >= 2 && !/^\d+[.,]\d+$/.test(s);

function splitMerckBatch(s) {
  const m = RE_MERCK_BATCH.exec(s.toUpperCase());
  return m ? { value: m[1], suffix: m[2] } : null;
}

function findBatch(lines, brand, exclude) {
  const bad = (v) => !v || exclude.has(v.replace(/[\s.\-]/g, '').toUpperCase());
  const isMerck = brand?.value === 'merck';
  // 1) keyword and value on the same line: "Lot # WXBC8031V", "LOT#:C804135", "Batch: 11C230505",
  //    then Sigma's "Source MKCC2998" if no Lot/Batch keyword carries a value
  for (const kw of [KW_BATCH, KW_SOURCE]) for (let i = 0; i < lines.length; i++) {
    const t = nfkc(lines[i].text).trim();
    const m = kw.exec(t);
    if (!m) continue;
    const rest = t.slice(m.index + m[0].length).trim().split(/\s{2,}|\s(?=[A-Z][a-z])/)[0];
    const v = rest.replace(/\s+/g, ' ').toUpperCase();
    if (v && batchish(v) && !bad(v)) {
      const mb = isMerck ? splitMerckBatch(v) : null;
      const source = kw === KW_SOURCE ? 'keyword-source' : 'keyword';
      return mb ? { ...mb, confidence: 'high', line: i, source }
        : { value: v.replace(/\s+/g, ''), suffix: null, confidence: 'high', line: i, source };
    }
  }
  // 2) Merck layout: "K47917114 622" (batch + 3-digit tail), with or without the tiny "Lot:" label
  if (isMerck || !brand) {
    for (let i = 0; i < lines.length; i++) {
      const mb = splitMerckBatch(nfkc(lines[i].text));
      if (mb && !bad(mb.value)) return { ...mb, confidence: isMerck ? 'high' : 'medium', line: i, source: 'merck-pattern' };
    }
  }
  // 3) keyword alone ("Batch :", "Lot") -> neighbouring box
  for (let i = 0; i < lines.length; i++) {
    if (!KW_BATCH_ONLY.test(nfkc(lines[i].text).trim())) continue;
    const j = neighbour(lines, i, (s) => batchish(s) && !bad(s));
    if (j != null) {
      const v = nfkc(lines[j].text).trim().toUpperCase();
      const mb = isMerck ? splitMerckBatch(v) : null;
      return mb ? { ...mb, confidence: 'medium', line: j, source: 'keyword-neighbour' }
        : { value: v.replace(/\s+/g, ''), suffix: null, confidence: 'medium', line: j, source: 'keyword-neighbour' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- CAS

const RE_CAS_KW = /CAS(?:[-\s]?(?:NO|NR|RN|NUMBER|#))?\.?\s*[:#.]?\s*([0-9A-Za-z|!]{2,7})\s?-\s?([0-9A-Za-z|!]{2})\s?-\s?([0-9A-Za-z|!])(?![0-9A-Za-z])/i;
const RE_CAS_BARE = /(?<![\d\-+.])(\d{2,7})-(\d{2})-(\d)(?![\d\-.])/g;

function findCas(lines) {
  // keyword first, with OCR repair; then any bare pattern that passes the checksum
  for (let i = 0; i < lines.length; i++) {
    const t = nfkc(lines[i].text);
    const m = RE_CAS_KW.exec(t);
    if (!m) continue;
    const raw = `${m[1]}-${m[2]}-${m[3]}`;
    const fixed = `${digitize(m[1])}-${digitize(m[2])}-${digitize(m[3])}`;
    if (casCheckOk(raw)) return { value: raw, confidence: 'high', line: i, repaired: false };
    if (casCheckOk(fixed)) return { value: fixed, raw, confidence: 'medium', line: i, repaired: true };
    return { value: null, raw, confidence: 'low', line: i, repaired: false, invalid: true };
  }
  for (let i = 0; i < lines.length; i++) {
    for (const m of nfkc(lines[i].text).matchAll(RE_CAS_BARE)) {
      const v = m[0];
      if (casCheckOk(v)) return { value: v, confidence: 'medium', line: i, repaired: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------- expiry, pcode, pack, grade

const KW_EXP = /(EXP(?:IRY|IRATION)?\.?(?:\s*DATE)?|USE\s*(?:BY|BEFORE)|BEST\s*BEFORE|GUARANTEED\s*UNTIL|VALID\s*UNTIL|RETEST(?:\s*DATE)?|VERW(?:ENDBAR)?\.?\s*BIS|HALTBAR\s*BIS|SHELF\s*LIFE)/i;

function findExpiry(lines) {
  for (let i = 0; i < lines.length; i++) {
    const t = nfkc(lines[i].text);
    const m = KW_EXP.exec(t);
    if (!m) continue;
    const kind = /RETEST/i.test(m[1]) ? 'retest' : 'expiry';
    const v = parseDate(t.slice(m.index + m[0].length));
    if (v) return { value: v, kind, confidence: 'high', line: i };
    const j = neighbour(lines, i, (s) => !!parseDate(s));
    if (j != null) return { value: parseDate(lines[j].text), kind, confidence: 'medium', line: j };
  }
  return null;
}

function findPcode(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /P\s?CODE\s*[:#.]?\s*([0-9OIl]{8,10})/i.exec(nfkc(lines[i].text));
    if (m) return { value: digitize(m[1]), confidence: 'high', line: i };
  }
  return null;
}

const RE_PACK_LINE = /^(\d+(?:[.,]\d+)?)\s?(mg|g|kg|ml|l|µl)$/i;
function findPack(lines, article) {
  if (article?.size) return { ...article.size, confidence: article.confidence, line: article.line, source: 'article' };
  for (let i = 0; i < lines.length; i++) {
    const m = RE_PACK_LINE.exec(nfkc(lines[i].text).trim());
    if (m) return { value: Number(m[1].replace(',', '.')), unit: normUnit(m[2].toUpperCase()), confidence: 'medium', line: i, source: 'line' };
  }
  return null;
}

const GRADES = [
  'EMSURE', 'EMPLURA', 'EMPARTA', 'LiChrosolv', 'SupraSolv', 'Suprapur', 'Ultrapur', 'Uvasol',
  'AnalaR NORMAPUR', 'NORMAPUR', 'GPR RECTAPUR', 'RECTAPUR', 'HiPerSolv', 'ACS reagent', 'ReagentPlus',
  'puriss. p.a.', 'puriss.', 'p.a.', 'for analysis', 'for synthesis', 'HPLC grade', 'analytical reagent', 'technical',
];
function findGrade(lines) {
  const hits = [];
  lines.forEach((l, i) => {
    const t = nfkc(l.text).toLowerCase().replace(/\s+/g, ' ');
    for (const g of GRADES) {
      if (t.includes(g.toLowerCase()) && !hits.some((h) => h.value.toLowerCase().includes(g.toLowerCase()))) hits.push({ value: g, line: i });
    }
  });
  return hits.length ? { value: hits.map((h) => h.value).join(', '), confidence: 'medium', line: hits[0].line } : null;
}

function findPurity(lines) {
  for (let i = 0; i < lines.length; i++) {
    const t = nfkc(lines[i].text);
    const m = /(?:[≥>]\s?|%\s?)(\d{2}(?:[.,]\d+)?)\s?%?|(?:assay|purity|min\.?)\s*[≥>:]?\s*(\d{2}(?:[.,]\d+)?)\s?%/i.exec(t);
    if (m) {
      const v = Number((m[1] || m[2]).replace(',', '.'));
      if (v >= 50 && v <= 100) return { value: v, confidence: 'medium', line: i };
    }
  }
  return null;
}

const RE_FORMULA = /^(?:(?:[A-Z][a-z]?)\d{0,3}){2,}$/;
function findFormula(lines) {
  for (let i = 0; i < lines.length; i++) {
    const t = nfkc(lines[i].text).replace(/\s+/g, '');
    if (RE_FORMULA.test(t) && /\d/.test(t) && /C/.test(t) && t.length <= 30) return { value: t, confidence: 'low', line: i };
  }
  return null;
}

function findMw(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:\bM\s?=|\bMW\s?[:=]?|\bF\.?W\.?\s?[:=]?)\s*(\d{2,4}[.,]\d{1,3})\s?g\s?\/?\s?mol/i.exec(nfkc(lines[i].text).replace(/\s+/g, ' '));
    if (m) return { value: Number(m[1].replace(',', '.')), confidence: 'medium', line: i };
  }
  return null;
}

// ---------------------------------------------------------------- name candidates

const NAME_STOP = new RegExp([
  'made in', 'merck', 'kgaa', 'darmstadt', 'millipore', 'corporation', 'concord', 'billerica', 'germany', '\\busa\\b', '\\btel\\b',
  'sigma', 'aldrich', 'macklin', '\\bvwr\\b', 'prolabo', 'international', 'rue ', 'fontenay',
  'specification', 'spec\\.', 'assay', 'identity', 'melting', 'passes', 'contact', 'r&d use', 'not for drug', 'for r&d',
  'product', 'batch', '\\blot\\b', 'received', 'opened', 'guaranteed', 'expir', 'pcode', '\\bcas\\b', '^source',
  'for analysis', 'for synthesis', 'analytical reagent', '\\bacs\\b', 'reagent', 'emsure', 'emplura', 'normapur', 'analar',
  '\\bmax\\b', '\\bmin\\b', 'ppm', 'hazen', 'apha', 'colour', 'color', 'residue', 'heavy metals', '^chloride', '^sulphate', '^sulfate',
  'danger', 'warning', 'gefahr', 'tehlike', 'r&d', 'store at', 'store under', 'viscosity', 'available', 'sensitive', 'household',
  'dye content', 'moistened', 'spruce', 'st\\.? ?louis', 'contains\\b', '^\\(', 'enthält', 'contient', 'contiene', 'contém',
].join('|'), 'i');

const lettersOnly = (s) => nfkc(s).toLowerCase().replace(/[^a-zà-ž]/g, '');

export function similarity(a, b) {
  // normalized Levenshtein similarity on letters
  a = lettersOnly(a); b = lettersOnly(b);
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[b.length] / Math.max(a.length, b.length);
}

// word parts that occur in chemical names and almost never in label boilerplate
const CHEM_PART = /(?:ane|ene|yne|anol|enol|ol\b|al\b|one\b|ide\b|ate\b|ite\b|ium|ine\b|ose\b|acid|oxy|hydr|chlor|brom|iod|fluor|nitr|sulf|sulph|phosph|benz|phen|meth|eth|prop|but|carb|amm|amin|amid|sil|ferr|cyan|palladi|platin|cupr|copper|iron|zinc|sodium|potass|calcium|magnes|lithium|barium|nickel|cobalt|silver|gold|titan|alumin|poly|tetra|tri|di(?=[a-z])|hexa|penta|oxide|hydrate)/gi;

function chemScore(t) {
  const m = lettersOnly(t).match(CHEM_PART) || [];
  return Math.min(m.length, 4);
}

// word order differs between languages: "Sulfuric acid" / "Acido sulfurico"
function looseSimilarity(a, b) {
  const sorted = (t) => nfkc(t).toLowerCase().split(/[^a-zà-ž]+/).filter(Boolean).sort().join(' ');
  return Math.max(similarity(a, b), similarity(sorted(a), sorted(b)));
}

function nameCandidates(lines, used, articleLine) {
  const ok = (t) => {
    const letters = (t.match(/[A-Za-zÀ-ž]/g) || []).length;
    return letters >= 4 && letters / t.length >= 0.6 && !NAME_STOP.test(t);
  };
  const cand = [];
  lines.forEach((l, i) => {
    if (used.has(i)) return;
    const t = nfkc(l.text).replace(/\s+/g, ' ').trim();
    if (!ok(t)) return;
    cand.push({ text: t, line: i, h: boxGeom(l.box).h, ocr: l.score ?? 1, joined: false });
    // a name wrapped onto the next line: "Poly(dimethylsiloxane), hydroxy" + "terminated",
    // "Tetrakis(triphenylphosphine)-" + "palladium(0)", "…sulfate hexa" + "hydrate"
    const n = lines[i + 1];
    if (!n || used.has(i + 1)) return;
    const a = boxGeom(l.box), b = boxGeom(n.box);
    const nt = nfkc(n.text).replace(/\s+/g, ' ').trim();
    const aligned = Math.abs(a.x0 - b.x0) < 2.5 * a.h && b.y0 - a.y1 < 1.2 * a.h && b.h > 0.6 * a.h && b.h < 1.6 * a.h;
    const wraps = /[-,(]$/.test(t) || /^[a-z(]/.test(nt);
    if (aligned && wraps && /[A-Za-z]/.test(nt) && !NAME_STOP.test(nt)) {
      const text = /-$/.test(t) ? t + nt : `${t} ${nt}`;
      cand.push({ text, line: i, h: a.h, ocr: Math.min(l.score ?? 1, n.score ?? 1), joined: true });
    }
  });
  if (!cand.length) return [];
  const hmax = Math.max(...cand.map((c) => c.h)) || 1;
  for (const c of cand) {
    const peers = cand.filter((o) => o !== c && o.line !== c.line && looseSimilarity(o.text, c.text) >= 0.6);
    const similar = peers.length;
    // translations: Merck and VWR print the English name first, so the topmost of a cluster wins
    const laterTranslation = peers.some((o) => o.line < c.line) ? 0.25 : 0;
    // synonym lists ("Kalium-…, Hexacyanoferrate…, …") and long lines are rarely the main name
    // (", hydroxy terminated" is part of a name; ", Cloruro di…" starts another one)
    const listPenalty = /,\s?[A-Z]/.test(c.text) || (c.text.match(/,/g) || []).length >= 3 ? 0.35 : 0;
    const longPenalty = c.text.length > 60 ? 0.2 : 0;
    const near = articleLine != null && c.line > articleLine && c.line - articleLine <= 4 ? 0.25 / (c.line - articleLine) : 0;
    c.score = 0.6 * (c.h / hmax) + 0.15 * Math.min(similar, 4) + 0.15 * c.ocr + 0.15 * chemScore(c.text)
      + near + (c.joined ? 0.15 : 0) - listPenalty - longPenalty - laterTranslation;
  }
  cand.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cand) {
    if (out.some((o) => similarity(o.value, c.text) >= 0.85)) continue;
    out.push({ value: c.text, line: c.line, score: Number(c.score.toFixed(3)) });
    if (out.length === 5) break;
  }
  return out;
}

// ---------------------------------------------------------------- main

export function extractLabelFields(lines) {
  lines = (lines || []).filter((l) => l && typeof l.text === 'string' && l.text.trim());
  let brand = detectBrand(lines);
  const article = findArticle(lines, brand);
  // no brand words read, but the article format is unambiguous
  if (!brand && article?.format === 'merck' && article.confidence !== 'low') brand = { value: 'merck', confidence: 'medium', line: article.line, source: 'article-format' };
  const pcode = findPcode(lines);
  const cas = findCas(lines);
  const exclude = new Set([article?.value, pcode?.value, cas?.value].filter(Boolean).map((v) => v.replace(/[\s.\-]/g, '').toUpperCase()));
  const batch = findBatch(lines, brand, exclude);
  const expiry = findExpiry(lines);
  const pack = findPack(lines, article);
  const grade = findGrade(lines);
  const purity = findPurity(lines);
  const formula = findFormula(lines);
  const mw = findMw(lines);
  const used = new Set([article, batch, cas, expiry, pcode, formula, mw].filter(Boolean).map((f) => f.line));
  const names = nameCandidates(lines, used, article?.line);
  return { brand, article, batch, cas, expiry, pcode, pack, grade, purity, formula, mw, names };
}
