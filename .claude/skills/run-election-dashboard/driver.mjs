#!/usr/bin/env node
/**
 * run-election-dashboard driver
 * -----------------------------
 * Headless harness for the Texas Election Watch Board (a static web app).
 *
 * There is no browser in this container and none is installable (Playwright
 * CDN 403, Google storage 400, no system chromium) — so `chromium-cli` is not
 * an option. Instead this driver:
 *   1. serves the site with `python3 -m http.server`,
 *   2. executes the REAL assets/app.js inside jsdom with fetch pointed at the
 *      live server (real socket, real data files, real client entry point),
 *   3. drives it with real DOM events (year switch, search, sort, hover),
 *   4. rasterizes the rendered SVG county map to a PNG screenshot via resvg.
 *
 * Usage (paths are relative to the repo root):
 *   node .claude/skills/run-election-dashboard/driver.mjs           # smoke + screenshots
 *   node .claude/skills/run-election-dashboard/driver.mjs serve     # just serve, stay up
 *   ... --port=8011 --out=/tmp/run-election-dashboard
 *
 * Exit code: 0 if all checks pass, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIT = path.resolve(HERE, '../../..'); // repo root (skill is 3 levels deep)

const args = process.argv.slice(2);
const mode = args.find(a => !a.startsWith('-')) || 'smoke';
const opt = (name, def) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const PORT = Number(opt('port', '8011'));
const OUT = opt('out', '/tmp/run-election-dashboard');
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fails = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

function startServer() {
  return spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: UNIT, stdio: 'ignore' });
}

async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(BASE + 'index.html')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error(`server not ready at ${BASE}`);
}

// Load index.html + app.js from the live server, run app.js, return the JSDOM.
async function render() {
  const { JSDOM } = await import('jsdom');
  const html = await (await fetch(BASE + 'index.html')).text();
  const appSrc = await (await fetch(BASE + 'assets/app.js')).text();
  const dom = new JSDOM(html, { url: BASE, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = u => fetch(new URL(u, BASE).href);
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 740 });
  window.eval(appSrc);
  await sleep(250); // let async init() fetch + render
  return dom;
}

// Switch to `year`, snapshot the county map SVG, rasterize to PNG at `file`.
async function screenshot(dom, year, file) {
  const { window } = dom, doc = window.document;
  const btn = [...doc.querySelectorAll('#yearPicker .year-btn')].find(b => b.textContent === String(year));
  if (btn) { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(40); }
  const svg = doc.querySelector('#map svg').cloneNode(true);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', '820');
  svg.setAttribute('height', '760');
  const bg = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '820'); bg.setAttribute('height', '760'); bg.setAttribute('fill', '#0d1320');
  svg.insertBefore(bg, svg.firstChild);
  for (const p of svg.querySelectorAll('path[data-fips]')) {
    p.setAttribute('stroke', '#0d1320'); p.setAttribute('stroke-width', '0.5');
  }
  const { Resvg } = await import('@resvg/resvg-js');
  const png = new Resvg(svg.outerHTML, { background: '#0d1320', fitTo: { mode: 'width', value: 900 } })
    .render().asPng();
  writeFileSync(file, png);
  return file;
}

async function smoke() {
  mkdirSync(OUT, { recursive: true });
  const srv = startServer();
  try {
    await waitReady();

    console.log('\nHTTP surface');
    for (const [p, ct] of [
      ['index.html', 'text/html'],
      ['assets/app.js', 'javascript'],
      ['assets/styles.css', 'text/css'],
      ['data/elections.json', 'application/json'],
      ['data/tx-counties-geo.json', 'application/json'],
    ]) {
      const r = await fetch(BASE + p);
      check(r.ok && (r.headers.get('content-type') || '').includes(ct),
        `GET /${p} -> ${r.status} ${r.headers.get('content-type')}`);
    }

    console.log('\nInitial render (default year)');
    const dom = await render();
    const doc = dom.window.document;
    const txt = sel => (doc.querySelector(sel)?.textContent || '').trim().replace(/\s+/g, ' ');
    const rows = () => doc.querySelectorAll('#tableBody tr').length;
    check(doc.querySelector('#loadError').hidden, 'no load error surfaced');
    check(doc.querySelectorAll('#summaryCards .card').length === 4, 'summary renders 4 cards');
    check(doc.querySelectorAll('#map svg path').length === 254, 'map renders 254 county paths');
    check(doc.querySelectorAll('#trendChart svg rect').length >= 8, 'trend chart has bars');
    check(doc.querySelectorAll('#highlights .hl-card').length === 5, 'highlights render 5 cards');
    check(rows() === 254, 'table renders 254 rows');
    check(/\b(CDT|CST)\b/.test(txt('#generated')), `footer time is Central (${txt('#generated')})`);

    console.log('\nInteraction probes');
    // hover Harris/Houston (fips 48201)
    const harris = doc.querySelector('#map svg path[data-fips="48201"]');
    const mm = new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 });
    Object.defineProperty(mm, 'target', { value: harris });
    harris.dispatchEvent(mm);
    check(!doc.querySelector('#mapTooltip').hidden && /Harris County/.test(txt('#mapTooltip')),
      `hover tooltip -> ${txt('#mapTooltip').slice(0, 60)}...`);

    // search
    const search = doc.querySelector('#search');
    search.value = 'harris'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(20);
    check(rows() > 0 && rows() < 254, `search "harris" filters table -> ${rows()} rows`);
    search.value = 'zzzzz'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(20);
    check(rows() === 0, 'search with no match -> 0 rows');
    search.value = ''; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(20);

    // sort by Total desc -> Harris is most populous
    const totalTh = [...doc.querySelectorAll('#tableHeaderRow th')].find(th => th.textContent.includes('Total'));
    totalTh.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    check(/^Harris/.test(txt('#tableBody tr:first-child td:first-child')),
      `sort by Total desc -> top row ${txt('#tableBody tr:first-child td:first-child')}`);

    console.log('\nScreenshots');
    let shotOk = true;
    try {
      for (const y of [2024, 2020]) {
        const f = await screenshot(dom, y, path.join(OUT, `tx_map_${y}.png`));
        console.log(`  wrote ${f}`);
      }
    } catch (e) { shotOk = false; console.log('  (resvg unavailable: ' + e.message + ')'); }
    check(shotOk, 'rasterized county map to PNG');

    console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'} — screenshots in ${OUT}`);
  } finally {
    srv.kill();
  }
  process.exit(fails === 0 ? 0 : 1);
}

async function serve() {
  const srv = startServer();
  await waitReady();
  console.log(`Serving ${UNIT} at ${BASE}  (Ctrl-C to stop)`);
  process.on('SIGINT', () => { srv.kill(); process.exit(0); });
  await new Promise(() => {});
}

(mode === 'serve' ? serve() : smoke()).catch(err => { console.error(err); process.exit(1); });
