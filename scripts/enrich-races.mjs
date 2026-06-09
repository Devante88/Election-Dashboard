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
// Overridable so tests can enrich a throwaway fixture instead of the real file.
const FILE = process.env.RACES_FILE || path.join(ROOT, 'data/races-2026.json');
// Overridable for testing against a mock/mirror; default to the real endpoints.
const FEC = process.env.FEC_BASE_URL || 'https://api.open.fec.gov/v1';
const CIVIC = process.env.CIVIC_BASE_URL || 'https://www.googleapis.com/civicinfo/v2';
const ELECTION_YEAR = 2026;
const STATE = 'TX';

const FEC_KEY = process.env.FEC_API_KEY;
const CIVIC_KEY = process.env.CIVIC_API_KEY;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch JSON, honoring FEC rate limits: retry on 429/503 with backoff, respecting
// Retry-After when present. Keeps the hundreds of per-candidate calls from dying
// on a throttle.
async function getJSON(url, label, attempt = 0) {
  const res = await fetch(url, { redirect: 'follow' });
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 4) throw new Error(`${label}: rate-limited (HTTP ${res.status}) after retries`);
    const wait = retryAfterMs(res.headers.get('retry-after')) ?? Math.min(30000, 1000 * 2 ** attempt);
    console.warn(`  · ${label}: HTTP ${res.status}; waiting ${Math.round(wait / 1000)}s then retrying`);
    await sleep(wait);
    return getJSON(url, label, attempt + 1);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

// Retry-After is either delta-seconds or an HTTP-date — handle both. Returns ms,
// or null if absent/unparseable (caller falls back to exponential backoff).
function retryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

// All FEC candidates for a TX office in the 2026 cycle, with their finance totals.
async function fecCandidates({ office, district }) {
  const params = new URLSearchParams({
    api_key: FEC_KEY, state: STATE, election_year: String(ELECTION_YEAR),
    office: office === 'U.S. Senate' ? 'S' : 'H',
    // Sort by a field the candidates/search endpoint actually supports — sorting
    // by total_receipts there 422s. We rank by money client-side below instead.
    sort: 'name', candidate_status: 'C',
  });
  if (office === 'U.S. House' && district != null) params.set('district', String(district).padStart(2, '0'));

  // Page through all results (FEC caps per_page at 100) so a crowded primary
  // with >100 filers isn't silently truncated.
  params.set('per_page', '100');
  const results = [];
  let page = 1, pages = 1;
  do {
    params.set('page', String(page));
    const data = await getJSON(`${FEC}/candidates/search/?${params}`, 'FEC candidates');
    results.push(...(data.results || []));
    pages = data.pagination?.pages || 1;
    page++;
  } while (page <= pages && page <= 10); // hard cap: 1000 candidates/race is already absurd
  if (pages > 10) console.warn(`  ! ${office} ${district ?? ''}: ${pages} pages of candidates; capped at 1000 (truncated).`);

  const out = [];
  for (const c of results) {
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
  // Rank by money raised (strongest fundraiser first); unknown finance sorts last.
  out.sort((a, b) => (b.finance?.receipts ?? -1) - (a.finance?.receipts ?? -1));
  return out;
}

// "LAST, First" (FEC) vs "First Last" (Civic) -> a comparable key.
// Swap on the comma FIRST (before stripping punctuation), then compare the full
// remaining token set order-independently so multi-word surnames ("De La Cruz",
// "Van Duyne") and suffixes don't cause false misses or false matches.
function nameKey(n) {
  let s = String(n || '').toLowerCase().trim();
  const comma = s.indexOf(',');
  if (comma !== -1) s = s.slice(comma + 1) + ' ' + s.slice(0, comma); // "last, first" -> "first last"
  s = s.replace(/[.,]/g, ' ');
  const parts = s.split(/\s+/).filter(Boolean)
    .filter(w => !/^(jr|sr|ii|iii|iv|v|mr|mrs|ms|dr)$/.test(w));
  // Order-independent: sort tokens so "first last" == "last first" regardless of source.
  return parts.sort().join(' ');
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
  const url = `${CIVIC}/voterinfo?key=${CIVIC_KEY}` +
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

// Reset every race to the empty (incumbent-only) state so the file can never
// carry STALE candidates from a prior successful run when this run can't enrich.
function clearCandidates(races) {
  for (const r of [...races.senate, ...races.house, ...(races.stateLocal || [])]) {
    r.candidates = [];
    r.candidatesSource = null;
  }
}

async function main() {
  const races = JSON.parse(await readFile(FILE, 'utf8'));

  if (!FEC_KEY) {
    console.log('No FEC_API_KEY set — leaving candidates[] empty (no data invented).');
    console.log('Get a free key at https://api.open.fec.gov/developers/ and re-run.');
    clearCandidates(races);
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
    clearCandidates(races); // never keep stale candidates from a prior run
    races.meta.enrichment = { attempted: true, ok: false, reason: e.message, when: new Date().toISOString() };
    await writeFile(FILE, JSON.stringify(races));
    process.exit(1);
  }

  // Optional complementary source: Google Civic (who's on the ballot).
  const civic = await civicByOffice();
  if (civic) console.log('  Google Civic: merged declared candidates by office');

  const allRaces = [...races.senate, ...races.house];
  let filled = 0;
  const failures = [];
  for (const r of allRaces) {
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
      failures.push(`${r.office} ${r.district ?? r.seat}: ${e.message}`);
      console.warn(`  ! ${r.office} ${r.district ?? r.seat}: ${e.message}`);
    }
  }

  // ok only if EVERY race was processed — a partial run is reported honestly so
  // downstream isn't misled into treating an incomplete file as complete.
  races.meta.enrichment = {
    attempted: true, ok: failures.length === 0,
    source: civic ? 'FEC OpenFEC + Google Civic' : 'FEC OpenFEC', cycle: ELECTION_YEAR,
    racesProcessed: allRaces.length - failures.length, racesTotal: allRaces.length,
    racesWithCandidates: filled, failures: failures.length, when: new Date().toISOString(),
    civic: CIVIC_KEY ? (civic ? 'merged' : 'key present but unavailable') : 'CIVIC_API_KEY not set (skipped)',
  };
  if (failures.length) races.meta.enrichment.failureDetail = failures.slice(0, 10);
  await writeFile(FILE, JSON.stringify(races));
  console.log(`\nEnriched ${filled} races with real candidate/finance data` +
    (failures.length ? ` (${failures.length} race(s) failed — see meta.enrichment).` : '.'));
  if (failures.length) process.exitCode = 1; // signal partial failure to CI
}

// Exported for unit tests; pure helpers with no I/O.
export { nameKey, mergeCivic, PARTY_FROM_CIVIC, retryAfterMs, clearCandidates };

// Run main() only when executed directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
