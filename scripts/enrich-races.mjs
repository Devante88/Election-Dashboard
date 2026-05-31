#!/usr/bin/env node
/**
 * Enrich data/races-2026.json with REAL declared candidates and campaign finance.
 * ------------------------------------------------------------------------------
 * Layers live data onto the incumbent file produced by build-races.mjs:
 *   • FEC OpenFEC  — declared candidates + finance (receipts, cash-on-hand)
 *   • Google Civic — who is on the ballot (optional, complementary)
 *
 * Both are key-gated and network-gated. If a key is missing OR the host is
 * unreachable (e.g. this sandbox's GitHub-only egress), the script logs why and
 * leaves candidates[] empty — it NEVER invents names or numbers. Run it where
 * the internet is open (GitHub Actions with secrets, or locally):
 *
 *   FEC_API_KEY=xxxx CIVIC_API_KEY=yyyy node scripts/enrich-races.mjs
 *
 * Get a free FEC key: https://api.open.fec.gov/developers/
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data/races-2026.json');
const FEC = 'https://api.open.fec.gov/v1';
const ELECTION_YEAR = 2026;
const STATE = 'TX';

const FEC_KEY = process.env.FEC_API_KEY;
const CIVIC_KEY = process.env.CIVIC_API_KEY;

async function getJSON(url, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

// All FEC candidates for a TX office in the 2026 cycle, with their finance totals.
async function fecCandidates({ office, district }) {
  const params = new URLSearchParams({
    api_key: FEC_KEY, state: STATE, election_year: String(ELECTION_YEAR),
    office: office === 'U.S. Senate' ? 'S' : 'H', sort: '-total_receipts',
    per_page: '50', candidate_status: 'C',
  });
  if (office === 'U.S. House' && district != null) params.set('district', String(district).padStart(2, '0'));
  const data = await getJSON(`${FEC}/candidates/search/?${params}`, 'FEC candidates');

  const out = [];
  for (const c of data.results || []) {
    // Pull the candidate's 2026 finance totals (best-effort; absent early cycle).
    let finance = null;
    try {
      const tot = await getJSON(
        `${FEC}/candidate/${c.candidate_id}/totals/?api_key=${FEC_KEY}&cycle=${ELECTION_YEAR}&per_page=1`,
        'FEC totals');
      const t = (tot.results || [])[0];
      if (t) finance = {
        receipts: t.receipts ?? null,
        disbursements: t.disbursements ?? null,
        cashOnHand: t.last_cash_on_hand_end_period ?? null,
      };
    } catch { /* finance optional */ }
    out.push({
      name: c.name,
      party: ({ REP: 'R', DEM: 'D', IND: 'I' })[c.party] || c.party || '?',
      status: c.incumbent_challenge_full || null,
      fec_id: c.candidate_id,
      finance,
    });
  }
  return out;
}

async function main() {
  const races = JSON.parse(await readFile(FILE, 'utf8'));

  if (!FEC_KEY) {
    console.log('No FEC_API_KEY set — leaving candidates[] empty (no data invented).');
    console.log('Get a free key at https://api.open.fec.gov/developers/ and re-run.');
    races.meta.enrichment = { attempted: false, reason: 'FEC_API_KEY not set', when: new Date().toISOString() };
    await writeFile(FILE, JSON.stringify(races));
    return;
  }

  // Probe reachability once so a blocked network fails fast and clearly.
  try {
    await getJSON(`${FEC}/candidates/?api_key=${FEC_KEY}&per_page=1`, 'FEC probe');
  } catch (e) {
    console.error(`FEC unreachable (${e.message}). This environment likely blocks non-GitHub egress.`);
    console.error('Run on an open network (GitHub Actions with secrets, or locally). candidates[] left empty.');
    races.meta.enrichment = { attempted: true, ok: false, reason: e.message, when: new Date().toISOString() };
    await writeFile(FILE, JSON.stringify(races));
    process.exit(1);
  }

  let filled = 0;
  for (const r of [...races.senate, ...races.house]) {
    try {
      r.candidates = await fecCandidates(r);
      r.candidatesSource = `FEC OpenFEC, cycle ${ELECTION_YEAR}`;
      if (r.candidates.length) filled++;
      process.stdout.write(`  ${r.office} ${r.district ?? r.seat}: ${r.candidates.length} candidates\n`);
    } catch (e) {
      console.warn(`  ! ${r.office} ${r.district ?? r.seat}: ${e.message}`);
    }
  }

  races.meta.enrichment = {
    attempted: true, ok: true, source: 'FEC OpenFEC', cycle: ELECTION_YEAR,
    racesWithCandidates: filled, when: new Date().toISOString(),
    civic: CIVIC_KEY ? 'key present' : 'CIVIC_API_KEY not set (skipped)',
  };
  await writeFile(FILE, JSON.stringify(races));
  console.log(`\nEnriched ${filled} races with real FEC candidate/finance data.`);
}

main().catch(err => { console.error(err); process.exit(1); });
