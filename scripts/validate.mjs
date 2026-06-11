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

  await racesCheck();
  await renderCheck(data, geo);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

// 2026 races: real incumbent layer is complete, and (critically) no candidate
// names exist unless live enrichment actually ran — guards against fabrication.
async function racesCheck() {
  console.log('\n2026 races (real data)');
  let races;
  try { races = JSON.parse(await readFile(path.join(ROOT, 'data/races-2026.json'))); }
  catch { console.log('  skip  data/races-2026.json not present (run `npm run build-races`)'); return; }

  ok(races.senate.length === 1, `exactly 1 U.S. Senate seat up (got ${races.senate.length})`);
  ok(races.house.length === 38, `38 U.S. House districts (got ${races.house.length})`);
  const districts = races.house.map(h => h.district).sort((a, b) => a - b);
  const fullSet = districts.length === 38 && districts.every((d, i) => d === i + 1);
  ok(fullSet, 'House districts are exactly 1..38');
  ok(races.house.every(h => h.open ? h.incumbent === null : !!(h.incumbent && h.incumbent.name)),
    'every district has an incumbent or is flagged open');

  // State & local scaffold: offices on the ballot by term cycle, no invented
  // incumbents/candidates.
  const sl = races.stateLocal || [];
  ok(sl.length >= 10, `state/local offices scaffolded (got ${sl.length})`);
  ok(sl.every(o => o.incumbent === null && Array.isArray(o.candidates)),
    'state/local rows have null incumbent + candidates hook (nothing invented)');

  // Integrity: candidates may only be present if enrichment actually ran — across
  // every layer (federal + state/local).
  const enriched = races.meta.enrichment && races.meta.enrichment.ok === true;
  const anyCandidates = [...races.senate, ...races.house, ...sl].some(r => (r.candidates || []).length > 0);
  ok(enriched || !anyCandidates,
    'no candidates present unless live enrichment ran (no fabricated names)');
  ok(races.senate.every(s => s.incumbent && s.incumbent.fec_id),
    'Senate incumbent carries a real FEC id');

  // Finance history (optional): structurally sound, chronological, no invented
  // totals (a snapshot with money must be flagged hasData).
  try {
    const hist = JSON.parse(await readFile(path.join(ROOT, 'data/finance-history.json')));
    const snaps = hist.snapshots || [];
    ok(Array.isArray(snaps) && snaps.length >= 1, `finance history has snapshots (${snaps.length})`);
    const dates = snaps.map(s => s.date);
    ok(dates.every((d, i) => i === 0 || d >= dates[i - 1]), 'finance snapshots are chronological');
    ok(snaps.every(s => s.totals.receipts === 0 ? true : s.hasData === true),
      'no finance totals without hasData (nothing invented)');
    ok(snaps.every(s => s.partial === undefined || typeof s.partial === 'boolean'),
      'finance snapshots carry a boolean partial flag when present');
  } catch {
    console.log('  skip  data/finance-history.json not present yet (run `npm run snapshot-finance`)');
  }
}

async function renderCheck(data, geo) {
  console.log('\nHeadless render check (jsdom)');
  let JSDOM;
  try { ({ JSDOM } = await import('jsdom')); }
  catch { console.log('  skip  jsdom not installed (run `npm install`)'); return; }

  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const appSrc = await readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
  const upcoming = JSON.parse(await readFile(path.join(ROOT, 'data/upcoming.json'), 'utf8'));
  const readOpt = async f => { try { return JSON.parse(await readFile(path.join(ROOT, f))); } catch { return null; } };
  const races = await readOpt('data/races-2026.json');
  const finance = await readOpt('data/finance-history.json');

  // A real URL so history.replaceState works like a browser's (on the default
  // about:blank it throws, sending syncHash down the location.hash fallback,
  // which fires spurious hashchange re-renders mid-test).
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  window.fetch = async url => {
    const ok = !(url.includes('races-2026') && !races) && !(url.includes('finance-history') && !finance);
    return {
      ok,
      json: async () =>
        url.includes('finance-history') ? finance :
        url.includes('races-2026') ? races :
        url.includes('upcoming') ? upcoming :
        url.includes('geo') ? geo : data,
    };
  };
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 700 });

  window.eval(appSrc);
  await new Promise(r => setTimeout(r, 120)); // let async init() settle

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

  // View controls (#6 metric, #7 palette) and clickable rows (#4).
  ok(doc.querySelectorAll('#mapControls .seg').length === 2, 'map has metric + palette controls');
  ok(doc.querySelectorAll('#tableBody tr.row-clickable').length === 254, 'table rows are clickable');

  // County drawer (#4): opening a county shows a sparkline + per-cycle margins.
  const firstRow = doc.querySelector('#tableBody tr.row-clickable');
  firstRow.focus(); // so the focus-restore check below has a real opener
  firstRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  const drawer = doc.querySelector('#drawer');
  ok(drawer && !drawer.hidden, 'county drawer opens on row click');
  ok(doc.querySelector('#drawer .sparkline'), 'drawer shows a margin sparkline');
  ok(doc.querySelectorAll('#drawer .drawer-cycles .cyc').length === 4, 'drawer lists all 4 cycles');

  // Dialog focus management: focus moves into the drawer on open and returns
  // to the opener when Escape closes it.
  ok(doc.activeElement === doc.querySelector('#drawer .drawer-close'), 'drawer takes keyboard focus on open');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok(drawer.hidden, 'Escape closes the drawer');
  ok(doc.activeElement === firstRow, 'focus returns to the opener on close');

  // Highlights: county names are buttons that open the drawer.
  const hlBtn = doc.querySelector('#highlights .hl-name-btn');
  ok(!!hlBtn, 'highlight county names are buttons');
  hlBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok(!drawer.hidden, 'clicking a highlight opens the drawer');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 20));

  // Year picker keyboard nav (tablist pattern): arrow keys move the selection.
  const picker = doc.querySelector('#yearPicker');
  picker.querySelector('.year-btn.active').dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok(picker.querySelector('.year-btn.active').textContent === '2020', 'ArrowLeft selects the previous cycle');
  picker.querySelector('.year-btn.active').dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok(picker.querySelector('.year-btn.active').textContent === '2024', 'End selects the latest cycle');

  // Margin bars render in the table's Margin column.
  ok(doc.querySelectorAll('#tableBody .mbar').length === 254, 'margin bars render for all 254 rows');

  // CSV export: enabled after load, and the download matches the table.
  const csvBtn = doc.querySelector('#csvBtn');
  ok(csvBtn && csvBtn.disabled === false, 'CSV export button enabled after load');
  // jsdom's Blob has no .text(); capture the parts at construction instead.
  let csvParts = null;
  const RealBlob = window.Blob;
  window.Blob = class extends RealBlob {
    constructor(parts, opts) { super(parts, opts); csvParts = parts; }
  };
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};
  csvBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const csv = (csvParts || []).join('');
  const lines = csv.trim().split('\n');
  ok(lines[0] === 'county,fips,winner,rep_votes,rep_pct,dem_votes,dem_pct,other_votes,total_votes,margin_pct',
    'CSV header has the expected columns');
  ok(lines.length === 255, `CSV has 254 data rows (got ${lines.length - 1})`);
  window.Blob = RealBlob;

  // Metric toggle recolors the map without changing path count.
  const turnoutBtn = [...doc.querySelectorAll('#mapControls .seg-btn')].find(b => b.textContent === 'Turnout');
  turnoutBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok(doc.querySelectorAll('#map svg path').length === 254, 'map still has 254 paths after metric switch');

  // 2026 races panel renders (now that the stub serves the real races file).
  if (races) {
    ok(doc.querySelector('#races2026') && !doc.querySelector('#races2026').hidden, 'races panel visible');
    ok(doc.querySelectorAll('#races2026 .race-card').length === 38, 'races panel shows 38 House districts');
    ok(!!doc.querySelector('#races2026 .finance'), 'campaign-finance section renders');
  }

  await axeAudit(window);
}

// Automated accessibility audit (#9): run axe-core against the rendered DOM and
// fail on serious/critical violations. Skipped cleanly if axe isn't installed.
async function axeAudit(window) {
  console.log('\nAccessibility audit (axe-core)');
  let axe;
  try { axe = (await import('axe-core')).default || (await import('axe-core')); }
  catch { console.log('  skip  axe-core not installed (run `npm install`)'); return; }
  try {
    window.eval(axe.source);
    const results = await window.axe.run(window.document, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } }, // needs real layout/paint; not meaningful in jsdom
    });
    const serious = results.violations.filter(v => ['serious', 'critical'].includes(v.impact));
    for (const v of serious) console.log(`  ! ${v.impact}: ${v.id} (${v.nodes.length}) — ${v.help}`);
    ok(serious.length === 0, `no serious/critical axe violations (found ${serious.length})`);
  } catch (e) {
    console.log('  skip  axe run failed in jsdom: ' + e.message);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
