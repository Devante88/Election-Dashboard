#!/usr/bin/env node
/**
 * Validation for the Texas Election Watch Board.
 *  1. Data invariants (counts, sums, ranges, geometry/result alignment).
 *  2. Cross-check computed statewide totals against published official figures.
 *  3. Optional headless render check via jsdom (skipped if not installed).
 *
 * Usage: node scripts/validate.mjs   (run `npm install` first for the render check)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

// Published official Texas statewide presidential totals (for sanity cross-check).
// Sources: Texas Secretary of State canvass / Federal Election Commission summaries.
//   independent: true  -> figure comes from a different source than our build
//                         input, so the check can actually catch a discrepancy.
//   independent: false -> our 2020/2024 build input IS this tabulation, so the
//                         row is provenance confirmation, not independent proof.
const OFFICIAL = {
  2012: { gop: 4569843, dem: 3308124, independent: true },
  2016: { gop: 4685047, dem: 3877868, independent: true },
  2020: { gop: 5890347, dem: 5259126, independent: false },
  2024: { gop: 6393597, dem: 4835250, independent: false },
};

async function main() {
  const data = JSON.parse(await readFile(path.join(ROOT, 'data/elections.json')));
  const geo = JSON.parse(await readFile(path.join(ROOT, 'data/tx-counties-geo.json')));
  const { meta, statewide, counties } = data;

  console.log('Data invariants');
  ok(counties.length === 254, `254 counties (got ${counties.length})`);
  ok(meta.countyCount === counties.length, 'meta.countyCount matches county array');
  ok(meta.years.join() === '2012,2016,2020,2024', `cycles are 2012-2024 (got ${meta.years.join()})`);

  let allYears = true, badSum = 0, negVotes = 0;
  for (const c of counties) {
    for (const y of meta.years) {
      const r = c.years[y];
      if (!r) { allYears = false; continue; }
      if (r.gop < 0 || r.dem < 0 || r.other < 0 || r.total <= 0) negVotes++;
      if (Math.abs((r.gop + r.dem + r.other) - r.total) > 1) badSum++;
    }
  }
  ok(allYears, 'every county has all four cycles');
  ok(negVotes === 0, 'no negative/zero-total county records');
  ok(badSum === 0, 'gop + dem + other === total for every county-year');

  console.log('\nStatewide = sum of counties');
  for (const s of statewide) {
    let g = 0, d = 0, o = 0, t = 0;
    for (const c of counties) {
      const r = c.years[s.year];
      g += r.gop; d += r.dem; o += r.other; t += r.total;
    }
    ok(g === s.gop && d === s.dem && o === s.other && t === s.total,
      `${s.year}: statewide totals equal county sums`);
    ok(s.gopPct >= 0 && s.gopPct <= 100 && s.demPct >= 0 && s.demPct <= 100,
      `${s.year}: vote-share percentages in range`);
  }

  console.log('\nGeometry alignment');
  ok(geo.counties.length === 254, `geo has 254 counties (got ${geo.counties.length})`);
  const resultFips = new Set(counties.map(c => c.fips));
  ok(geo.counties.every(c => resultFips.has(c.fips)), 'every mapped county has results');
  ok(geo.counties.every(c => Array.isArray(c.rings) && c.rings.length > 0), 'every mapped county has polygon rings');
  ok(Array.isArray(geo.bbox) && geo.bbox.length === 4, 'geo bbox present');

  console.log('\nTimestamp is Central Time');
  ok(/\b(CDT|CST)\b/.test(meta.generated), `meta.generated labeled Central (got "${meta.generated}")`);

  console.log('\nCross-check vs published official totals (tolerance 5%)');
  console.log('  year   computed GOP / DEM        official GOP / DEM        delta      source');
  for (const s of statewide) {
    const off = OFFICIAL[s.year];
    const dG = Math.abs(s.gop - off.gop) / off.gop;
    const dD = Math.abs(s.dem - off.dem) / off.dem;
    console.log(
      `  ${s.year}  ${String(s.gop).padStart(8)} / ${String(s.dem).padStart(8)}   ` +
      `${String(off.gop).padStart(8)} / ${String(off.dem).padStart(8)}   ` +
      `R ${(dG * 100).toFixed(2)}% / D ${(dD * 100).toFixed(2)}%   ` +
      `${off.independent ? 'independent' : 'provenance (same source as build)'}`
    );
    const tag = off.independent ? '' : ' [provenance]';
    ok(dG < 0.05 && dD < 0.05, `${s.year}: within 5% of official GOP & DEM totals${tag}`);
  }
  // At least the two independent cross-checks (2012, 2016) must exist — they're
  // the rows that can actually catch a data regression.
  ok(Object.values(OFFICIAL).filter(o => o.independent).length >= 2,
    'has >=2 independent official cross-checks');

  await renderCheck(data, geo);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function renderCheck(data, geo) {
  console.log('\nHeadless render check (jsdom)');
  let JSDOM;
  try { ({ JSDOM } = await import('jsdom')); }
  catch { console.log('  skip  jsdom not installed (run `npm install`)'); return; }

  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const appSrc = await readFile(path.join(ROOT, 'assets/app.js'), 'utf8');

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async url => ({ ok: true, json: async () => (url.includes('geo') ? geo : data) });
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 700 });

  window.eval(appSrc);
  await new Promise(r => setTimeout(r, 80)); // let async init() settle

  const doc = window.document;
  const err = doc.querySelector('#loadError');
  ok(err && err.hidden, 'no load error surfaced');
  ok(doc.querySelectorAll('#summaryCards .card').length === 4, 'summary renders 4 cards');
  ok(doc.querySelectorAll('#trendChart svg rect').length >= 8, 'trend chart has bars');
  ok(doc.querySelectorAll('#map svg path').length === 254, 'map renders 254 county paths');
  ok(doc.querySelectorAll('#highlights .hl-card').length === 5, 'highlights render 5 cards');
  ok(doc.querySelectorAll('#tableBody tr').length === 254, 'table renders 254 rows');
  ok(doc.querySelectorAll('#yearPicker .year-btn').length === 4, 'year picker has 4 buttons');

  // Upcoming-election panel: visible, with a live countdown and office list.
  const up = doc.querySelector('#upcoming');
  ok(up && !up.hidden, 'upcoming-election panel is visible');
  ok(doc.querySelectorAll('#upcoming .cd-unit').length === 4, 'countdown shows 4 units');
  ok(doc.querySelectorAll('#upcoming .up-dates li').length >= 3, 'upcoming lists key dates');
  ok(doc.querySelectorAll('#upcoming .up-office-group').length >= 3, 'upcoming lists office groups');

  // Accessibility: every county is keyboard-focusable and labeled for a reader.
  const paths = [...doc.querySelectorAll('#map svg path')];
  ok(paths.every(p => p.getAttribute('tabindex') === '0'), 'every county path is focusable');
  ok(paths.every(p => (p.getAttribute('aria-label') || '').length > 0), 'every county path has an aria-label');
  // Search is disabled until data loads, then re-enabled (no crash on early type).
  ok(doc.querySelector('#search').disabled === false, 'search input enabled after load');
}

main().catch(err => { console.error(err); process.exit(1); });
