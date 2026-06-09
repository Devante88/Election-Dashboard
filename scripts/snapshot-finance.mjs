#!/usr/bin/env node
/**
 * Append a dated campaign-finance snapshot to data/finance-history.json.
 * ---------------------------------------------------------------------
 * Run AFTER enrich-races.mjs (which populates candidates[].finance from the FEC).
 * Each run records one snapshot so the dashboard can show finance *over time*
 * (momentum), not just a point-in-time number.
 *
 * It never invents data: if no race has finance yet (no FEC_API_KEY, or early in
 * the cycle before filings), it records a zeroed snapshot flagged hasData:false
 * and leaves history otherwise untouched. Idempotent per UTC day — re-running on
 * the same day replaces that day's snapshot rather than piling up duplicates.
 *
 * Usage:  node scripts/snapshot-finance.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RACES = path.join(ROOT, 'data/races-2026.json');
const HIST = path.join(ROOT, 'data/finance-history.json');

const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

// Day key in Central Time (Texas), matching the rest of the project — so an
// evening-Central run isn't mislabeled as the next (UTC) day.
const centralDay = d => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d); // en-CA => YYYY-MM-DD

// Pure: compute one dated finance snapshot from a races object (no I/O) so it's
// unit-testable.
export function buildSnapshot(races, now = new Date()) {
  const allRaces = [...(races.senate || []), ...(races.house || []), ...(races.stateLocal || [])];
  const cands = allRaces.flatMap(r => (r.candidates || []).map(c => ({ ...c, office: r.office })));
  // Include a candidate if ANY finance figure is a real number (receipts OR
  // cash-on-hand) — don't drop someone reporting cash but null receipts.
  const numeric = v => typeof v === 'number' && Number.isFinite(v);
  const withFinance = cands.filter(c => c.finance && (numeric(c.finance.receipts) || numeric(c.finance.cashOnHand)));

  // Aggregate the day's totals (by party + overall) from real FEC finance only.
  const byParty = {};
  for (const c of withFinance) {
    const p = c.party || '?';
    byParty[p] = byParty[p] || { receipts: 0, cashOnHand: 0, candidates: 0 };
    byParty[p].receipts += c.finance.receipts || 0;
    byParty[p].cashOnHand += c.finance.cashOnHand || 0;
    byParty[p].candidates += 1;
  }

  const enr = races.meta && races.meta.enrichment;
  return {
    date: centralDay(now),                             // Central (Texas) day key
    when: now.toISOString(),
    hasData: withFinance.length > 0,
    // True when enrichment was attempted but did not fully complete, so the trend
    // can flag/skip an incomplete day rather than treat it as authoritative.
    partial: !!(enr && enr.ok === false),
    source: (enr && enr.source) || null,
    totals: {
      receipts: sum(withFinance, c => c.finance.receipts),
      cashOnHand: sum(withFinance, c => c.finance.cashOnHand),
      candidatesWithFinance: withFinance.length,
      candidatesTotal: cands.length,
    },
    byParty,
    // Top fundraisers this snapshot (name/party/office/receipts) — real data only.
    top: withFinance
      .slice()
      .sort((a, b) => (b.finance.receipts || 0) - (a.finance.receipts || 0))
      .slice(0, 10)
      .map(c => ({ name: c.name, party: c.party, office: c.office, receipts: c.finance.receipts, cashOnHand: c.finance.cashOnHand })),
  };
}

async function main() {
  if (!existsSync(RACES)) {
    console.error('data/races-2026.json missing — run `npm run build-races` first.');
    process.exit(1);
  }
  const races = JSON.parse(await readFile(RACES, 'utf8'));
  const snapshot = buildSnapshot(races);

  let hist = { meta: {}, snapshots: [] };
  if (existsSync(HIST)) {
    try { hist = JSON.parse(await readFile(HIST, 'utf8')); } catch { /* start fresh */ }
  }
  hist.snapshots = (hist.snapshots || []).filter(s => s.date !== snapshot.date);
  hist.snapshots.push(snapshot);
  hist.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  hist.meta = {
    title: '2026 Texas campaign-finance history',
    updated: snapshot.when,
    snapshots: hist.snapshots.length,
    latestHasData: snapshot.hasData,
    note: 'Each entry is a dated total from FEC candidate finance (via enrich-races.mjs). ' +
          'Zeroed entries (hasData:false) mean no FEC data yet — no figures are invented.',
    source: 'FEC OpenFEC via scripts/enrich-races.mjs',
  };

  await writeFile(HIST, JSON.stringify(hist));
  console.log(`Snapshot ${snapshot.date}: ${snapshot.totals.candidatesWithFinance} candidates with finance, ` +
    `$${snapshot.totals.receipts.toLocaleString('en-US')} raised total. ` +
    `History now ${hist.snapshots.length} snapshot(s).`);
  if (!snapshot.hasData) console.log('  (no FEC finance yet — recorded an empty snapshot; nothing invented)');
  if (snapshot.partial) console.log('  (enrichment was incomplete — snapshot flagged partial:true)');
}

export { centralDay };

// Run main() only when executed directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
