#!/usr/bin/env node
/**
 * Build data/races-2026.json — the REAL 2026 Texas federal battlefield.
 * -------------------------------------------------------------------
 * Source (authoritative, continuously maintained, public):
 *   unitedstates/congress-legislators — legislators-current.yaml
 *   https://github.com/unitedstates/congress-legislators
 *
 * What this produces is FACT, not forecast: the current officeholder, party,
 * district, and FEC id for every Texas seat on the 2026 ballot —
 *   • U.S. Senate: the Class II seat (term ends Jan 2027), and
 *   • U.S. House: all 38 districts (2-year terms — every seat is up).
 *
 * It deliberately does NOT include challengers, polling, or finance totals:
 * those require the FEC / Google Civic / Ballotpedia APIs (blocked in this
 * sandbox) and would otherwise be invented. Each race carries an `incumbent`
 * and an empty `candidates` array with a documented hook to populate later.
 *
 * Usage:  node scripts/build-races.mjs
 *         USE_CACHE=1 node scripts/build-races.mjs   (offline, from scripts/.cache)
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache');
const SRC = {
  url: 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml',
  cache: 'legislators-current.yaml',
};
const ELECTION_YEAR = 2026;

async function fetchText({ url, cache }) {
  const cachePath = path.join(CACHE, cache);
  if (process.env.USE_CACHE === '1' && existsSync(cachePath)) {
    console.log(`  · cache ${cache}`);
    return readFile(cachePath, 'utf8');
  }
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await mkdir(CACHE, { recursive: true });
    await writeFile(cachePath, text);
    return text;
  } catch (err) {
    if (existsSync(cachePath)) {
      console.warn(`  ! fetch failed (${err.message}); using cached ${cache}`);
      return readFile(cachePath, 'utf8');
    }
    throw new Error(`Could not fetch ${url} and no cache: ${err.message}`);
  }
}

const PARTY = { Republican: 'R', Democrat: 'D', Independent: 'I' };

function emptyRace(extra) {
  // The hook for real challenger/finance data when run outside this sandbox.
  return {
    candidates: [],          // [{name, party, status, fec_id}] — fill from FEC/Civic/Ballotpedia
    candidatesSource: null,  // set to the source/date when populated
    ...extra,
  };
}

async function main() {
  console.log('Building 2026 Texas federal races from congress-legislators...\n');
  const all = yaml.load(await fetchText(SRC));

  const tx = [];
  for (const p of all) {
    const t = p.terms[p.terms.length - 1];
    if (t.state !== 'TX') continue;
    const fec = Array.isArray(p.id.fec) ? p.id.fec[p.id.fec.length - 1] : null;
    tx.push({
      name: p.name.official_full || `${p.name.first} ${p.name.last}`,
      type: t.type, district: t.district ?? null,
      party: PARTY[t.party] || t.party, class: t.class ?? null,
      termEnd: t.end, bioguide: p.id.bioguide, fec_id: fec,
    });
  }

  // U.S. Senate: the Class II seat is the one up in 2026 (term ends Jan 2027).
  const senateUp = tx
    .filter(x => x.type === 'sen' && String(x.termEnd).startsWith('2027'))
    .map(x => emptyRace({
      office: 'U.S. Senate', seat: `Class ${x.class}`,
      incumbent: { name: x.name, party: x.party, fec_id: x.fec_id, bioguide: x.bioguide },
      incumbentRunning: null,   // unknown here; confirm via official filings
    }));

  // U.S. House: all 38 districts are up every cycle. Build one race per district
  // 1..38 so vacancies surface as open seats (real, valuable intel) rather than
  // silently dropping out.
  const repByDistrict = new Map(tx.filter(x => x.type === 'rep').map(x => [x.district, x]));
  const TX_HOUSE_DISTRICTS = 38;
  const house = [];
  const vacancies = [];
  for (let d = 1; d <= TX_HOUSE_DISTRICTS; d++) {
    const x = repByDistrict.get(d);
    if (x) {
      house.push(emptyRace({
        office: 'U.S. House', district: d,
        incumbent: { name: x.name, party: x.party, fec_id: x.fec_id, bioguide: x.bioguide },
      }));
    } else {
      vacancies.push(d);
      house.push(emptyRace({ office: 'U.S. House', district: d, incumbent: null, open: true }));
    }
  }

  const byParty = house.reduce((m, r) => {
    const k = r.incumbent ? r.incumbent.party : 'Open';
    m[k] = (m[k] || 0) + 1; return m;
  }, {});

  const out = {
    meta: {
      title: '2026 Texas federal races',
      electionYear: ELECTION_YEAR,
      generated: new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }),
      counts: { senate: senateUp.length, house: house.length, houseByParty: byParty, vacancies },
      dataNote:
        'Incumbents/parties/districts are FACT from congress-legislators. Declared 2026 candidates, ' +
        'polling, and finance are NOT included here — populate candidates[] from the FEC, Google Civic, ' +
        'or Ballotpedia APIs (each race has a candidates[] hook). No names are invented.',
      sources: [
        { name: 'unitedstates/congress-legislators', url: 'https://github.com/unitedstates/congress-legislators',
          note: 'Current U.S. Senate & House members (name, party, district, FEC id).' },
        { name: 'FEC — candidate filings (connect for challengers/finance)', url: 'https://api.open.fec.gov/developers/' },
        { name: 'Texas Secretary of State', url: 'https://www.sos.texas.gov/elections/index.shtml' },
      ],
    },
    senate: senateUp,
    house,
  };

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data/races-2026.json'), JSON.stringify(out));

  console.log(`  U.S. Senate seats up (Class II): ${senateUp.length}`);
  for (const s of senateUp) console.log(`    ${s.seat}: ${s.incumbent.name} (${s.incumbent.party})`);
  console.log(`  U.S. House districts: ${house.length}  [${Object.entries(byParty).map(([p, n]) => `${p} ${n}`).join(', ')}]`);
  if (vacancies.length) console.log(`  Vacant (open) districts: ${vacancies.join(', ')}`);
  if (house.length !== TX_HOUSE_DISTRICTS) throw new Error(`expected 38 TX House districts, got ${house.length}`);
  if (senateUp.length !== 1) throw new Error(`expected exactly 1 TX Senate seat up in 2026, got ${senateUp.length}`);
  console.log('\nWrote data/races-2026.json');
}

main().catch(err => { console.error(err); process.exit(1); });
