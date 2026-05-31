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

// "LAST, First" (FEC) vs "First Last" (Civic) -> a comparable key.
function nameKey(n) {
  let s = String(n || '').toLowerCase().replace(/[.,]/g, ' ');
  if (s.includes(',')) { const [a, b] = s.split(','); s = `${b} ${a}`; }
  const parts = s.split(/\s+/).filter(Boolean).filter(w => !/^(jr|sr|ii|iii|iv|mr|mrs|ms|dr)$/.test(w));
  return parts.length ? `${parts[0]} ${parts[parts.length - 1]}` : s.trim();
}

const PARTY_FROM_CIVIC = p => {
  const s = String(p || '').toLowerCase();
  if (s.includes('republican')) return 'R';
  if (s.includes('democrat')) return 'D';
  if (s.includes('libertarian')) return 'L';
  if (s.includes('green')) return 'G';
  return s ? 'I' : '?';
};

// Google Civic: declared candidates per office for a Texas address. Returns a
// Map office-key -> [{name, party}], or null if unavailable. Complements FEC.
async function civicByOffice() {
  if (!CIVIC_KEY) return null;
  const url = `https://www.googleapis.com/civicinfo/v2/voterinfo?key=${CIVIC_KEY}` +
    `&address=${encodeURIComponent('Texas')}&electionId=${ELECTION_YEAR}&returnAllAvailableData=true`;
  let data;
  try { data = await getJSON(url, 'Google Civic'); }
  catch (e) { console.warn(`  ! Google Civic unavailable (${e.message}); FEC-only`); return null; }
  const map = new Map();
  for (const c of data.contests || []) {
    if (!/senate|representative|house/i.test(c.office || '')) continue;
    const dist = (c.district && /\d+/.test(c.district.name || '')) ? Number((c.district.name.match(/\d+/) || [])[0]) : null;
    const key = /senate/i.test(c.office) ? 'sen' : `rep:${dist}`;
    map.set(key, (c.candidates || []).map(x => ({ name: x.name, party: PARTY_FROM_CIVIC(x.party) })));
  }
  return map;
}

// Fold Civic-only candidates into an FEC list without duplicating by name.
function mergeCivic(fecList, civicList) {
  if (!civicList || !civicList.length) return fecList;
  const seen = new Set(fecList.map(c => nameKey(c.name)));
  const merged = [...fecList];
  for (const c of civicList) {
    if (seen.has(nameKey(c.name))) continue;
    merged.push({ name: c.name, party: c.party, status: null, fec_id: null, finance: null, source: 'civic' });
    seen.add(nameKey(c.name));
  }
  return merged;
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

  // Optional complementary source: Google Civic (who's on the ballot).
  const civic = await civicByOffice();
  if (civic) console.log('  Google Civic: merged declared candidates by office');

  let filled = 0;
  for (const r of [...races.senate, ...races.house]) {
    try {
      const fec = await fecCandidates(r);
      const key = r.office === 'U.S. Senate' ? 'sen' : `rep:${r.district}`;
      r.candidates = mergeCivic(fec, civic && civic.get(key));
      const srcs = ['FEC OpenFEC'];
      if (civic && (civic.get(key) || []).length) srcs.push('Google Civic');
      r.candidatesSource = `${srcs.join(' + ')}, cycle ${ELECTION_YEAR}`;
      if (r.candidates.length) filled++;
      process.stdout.write(`  ${r.office} ${r.district ?? r.seat}: ${r.candidates.length} candidates\n`);
    } catch (e) {
      console.warn(`  ! ${r.office} ${r.district ?? r.seat}: ${e.message}`);
    }
  }

  races.meta.enrichment = {
    attempted: true, ok: true,
    source: civic ? 'FEC OpenFEC + Google Civic' : 'FEC OpenFEC', cycle: ELECTION_YEAR,
    racesWithCandidates: filled, when: new Date().toISOString(),
    civic: CIVIC_KEY ? (civic ? 'merged' : 'key present but unavailable') : 'CIVIC_API_KEY not set (skipped)',
  };
  await writeFile(FILE, JSON.stringify(races));
  console.log(`\nEnriched ${filled} races with real candidate/finance data.`);
}

main().catch(err => { console.error(err); process.exit(1); });
