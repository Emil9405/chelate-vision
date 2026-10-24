// Headless Chromium check of dist/demo: loads models (wasm, like a phone), runs OCR on every
// sample, compares fields with truth.json, saves screenshots.
// usage: node test/browser_check.cjs <outDir for screenshots>
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../dist/demo');
const ortDist = path.join(__dirname, '../node_modules/onnxruntime-web/dist');
const truth = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/labels/truth.json'), 'utf8'));
const shots = process.argv[2] || '/tmp';
const TYPES = { '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.onnx': 'application/octet-stream', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch();
  const failures = [];
  for (const [vw, vh, scheme] of [[1280, 900, 'light'], [400, 860, 'dark']]) {
    const page = await browser.newPage({ viewport: { width: vw, height: vh }, colorScheme: scheme });
    page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    // CDN is not reachable from the sandbox: serve the same pinned files locally
    await page.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/**', (r) => {
      const f = path.join(ortDist, path.basename(new URL(r.request().url()).pathname));
      r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
    });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/${process.env.PAGE || ''}`);
    await page.waitForSelector('#status.ready, #status.error', { timeout: 120000 });
    console.log(`[${vw}px ${scheme}] status:`, await page.textContent('#statusText'), `${Date.now() - t0} ms`);
    if (vw > 1000) {
      const names = ['merck_acetone', 'sigma_ferricyanide', 'vwr_hexane', 'macklin_chlorophenol', 'merck_anthracene', 'merck_ammonia'];
      for (let i = 0; i < names.length; i++) {
        const runs = await page.evaluate(() => Number(document.body.dataset.runs || 0));
        await page.click(`.thumb:nth-child(${i + 1})`);
        await page.waitForFunction((n) => Number(document.body.dataset.runs || 0) > n && document.getElementById('meta').textContent.includes('распознано'), runs, { timeout: 120000 });
        const got = await page.evaluate(() => {
          const rows = {}; document.querySelectorAll('.row').forEach((r) => { rows[r.querySelector('.k').textContent] = r.querySelector('.v').textContent; });
          return { rows, meta: [...document.querySelectorAll('#meta span')].map((x) => x.textContent).join(' · '), match: document.querySelector('.match b')?.textContent };
        });
        const t = truth[names[i]];
        const check = { 'Лот': t.article, 'Батч': t.batch, 'CAS': t.cas };
        for (const [k, want] of Object.entries(check)) {
          const v = got.rows[k];
          const ok = want == null ? v === 'не найдено' : (v || '').toUpperCase() === want.toUpperCase();
          if (!ok) failures.push(`${names[i]} ${k}: got ${v}, want ${want}`);
        }
        console.log(names[i].padEnd(22), JSON.stringify(got.rows), '| top match:', got.match, '|', got.meta);
        if (i === 0 || i === 5) await page.screenshot({ path: path.join(shots, `demo_${names[i]}_${vw}.png`), fullPage: true });
      }
    } else {
      await page.waitForFunction(() => document.getElementById('meta').textContent.includes('распознано'), null, { timeout: 120000 });
      const runs = await page.evaluate(() => Number(document.body.dataset.runs || 0));
      await page.click('.thumb:nth-child(2)');
      await page.waitForFunction((n) => Number(document.body.dataset.runs || 0) > n && document.getElementById('meta').textContent.includes('распознано'), runs, { timeout: 120000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log('phone horizontal overflow px:', overflow);
      if (overflow > 0) failures.push('horizontal overflow on phone');
      await page.screenshot({ path: path.join(shots, `demo_phone_dark.png`), fullPage: true });
    }
    await page.close();
  }
  await browser.close();
  server.close();
  console.log(failures.length ? 'FAIL\n' + failures.join('\n') : 'ALL OK');
  process.exit(failures.length ? 1 : 0);
});
