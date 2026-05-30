#!/usr/bin/env node
/**
 * Texas Election Watch Board — data builder
 * -----------------------------------------
 * Fetches REAL county-level U.S. presidential election returns and reduces them
 * to the Texas subset (254 counties) consumed by the dashboard. No vote totals
 * are invented — every number is derived from the public sources below.
 *
 * Sources (publicly available; compiled from official county canvasses):
 *   - tonmcg/US_County_Level_Election_Results_08-24
 *       2020 / 2024 single-year files (state_name / county_fips schema) and a
 *       2008-2016 panel (used for 2012 & 2016, which carry *_2012 / *_2016 cols).
 *       https://github.com/tonmcg/US_County_Level_Election_Results_08-24
 *   - plotly/datasets — geojson-counties-fips.json (U.S. Census county geometry)
 *       https://github.com/plotly/datasets
 *
 * Outputs:
 *   data/elections.json        — statewide history + per-county results (2012-2024)
 *   data/tx-counties-geo.json  — simplified Texas county geometry for the map
 *
 * Timestamps are emitted in U.S. Central Time (America/Chicago), Texas's zone.
 *
 * Usage:  node scripts/build-data.mjs            (fetch fresh from sources)
 *         USE_CACHE=1 node scripts/build-data.mjs (offline, from scripts/.cache)
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(__dirname, '.cache');

const RAW = 'https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master';
const GEO_RAW = 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';

const SOURCES = {
  y2024: { url: `${RAW}/2024_US_County_Level_Presidential_Results.csv`, cache: '2024.csv' },
  y2020: { url: `${RAW}/2020_US_County_Level_Presidential_Results.csv`, cache: '2020.csv' },
  panel: { url: `${RAW}/US_County_Level_Presidential_Results_08-16.csv`, cache: '08-16.csv' },
  geo:   { url: GEO_RAW, cache: 'geojson-counties-fips.json' },
};

const TX_PREFIX = '48';                       // Texas state FIPS
const YEARS = [2012, 2016, 2020, 2024];
const EV = { 2012: 38, 2016: 38, 2020: 38, 2024: 40 }; // TX electoral votes (40 after 2020 census)
const TZ = 'America/Chicago';                 // Central Time — Texas's time zone

/* ----------------------------------------------------------------- helpers */

async function fetchText({ url, cache }) {
  const cachePath = path.join(CACHE, cache);
  // USE_CACHE=1 skips the network entirely and reads the local cache (offline/CI).
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
      console.warn(`  ! fetch failed for ${url} (${err.message}); using cached ${cache}`);
      return readFile(cachePath, 'utf8');
    }
    throw new Error(`Could not fetch ${url} and no cache at ${cachePath}: ${err.message}`);
  }
}

// County names contain no commas, so a simple split is safe for these files.
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

const num = v => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

const cleanName = s => String(s || '').replace(/\s+County$/i, '').trim();

/* ---------------------------------------------------------- county results */

const counties = new Map(); // fips -> { fips, name, years: { [year]: {gop,dem,other,total} } }

function ensure(fips, name) {
  if (!counties.has(fips)) counties.set(fips, { fips, name: name || '', years: {} });
  const c = counties.get(fips);
  if (name && !c.name) c.name = name;
  return c;
}

// tonmcg single-year files: state_name == "Texas", county_fips, votes_gop/dem, total_votes.
function addTonmcgYear(rows, year) {
  let n = 0;
  for (const r of rows) {
    if (r.state_name !== 'Texas') continue;
    const fips = String(r.county_fips).padStart(5, '0');
    const gop = num(r.votes_gop), dem = num(r.votes_dem), total = num(r.total_votes);
    const other = Math.max(0, total - gop - dem);
    ensure(fips, cleanName(r.county_name)).years[year] = { gop, dem, other, total };
    n++;
  }
  return n;
}

// 2008-2016 panel: fips_code + per-year columns gop_YYYY / dem_YYYY / oth_YYYY / total_YYYY.
function addPanelYear(rows, year) {
  let n = 0;
  for (const r of rows) {
    const fips = String(r.fips_code).padStart(5, '0');
    if (!fips.startsWith(TX_PREFIX)) continue;
    const gop = num(r[`gop_${year}`]), dem = num(r[`dem_${year}`]), other = num(r[`oth_${year}`]);
    const total = num(r[`total_${year}`]) || (gop + dem + other);
    ensure(fips, cleanName(r.county)).years[year] = { gop, dem, other, total };
    n++;
  }
  return n;
}

/* ------------------------------------------------------------- geometry */

const round = n => Math.round(n * 1000) / 1000; // ~111 m precision; plenty for a state map

function outerRings(geom) {
  const out = [];
  const push = ring => {
    const simp = [];
    let prev = null;
    for (const [lon, lat] of ring) {
      const p = [round(lon), round(lat)];
      if (!prev || p[0] !== prev[0] || p[1] !== prev[1]) { simp.push(p); prev = p; }
    }
    if (simp.length >= 4) out.push(simp);
  };
  if (geom.type === 'Polygon') push(geom.coordinates[0]);
  else if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) push(poly[0]);
  return out;
}

function fipsOf(feature) {
  if (feature.id != null) return String(feature.id).padStart(5, '0');
  const p = feature.properties || {};
  if (p.STATE && p.COUNTY) return `${p.STATE}${p.COUNTY}`.padStart(5, '0');
  if (p.GEO_ID) return String(p.GEO_ID).slice(-5);
  return null;
}

/* ----------------------------------------------------------------- main */

async function main() {
  console.log('Building Texas Election Watch Board data...\n');

  console.log('Fetching county results...');
  const [c2024, c2020, panel] = await Promise.all([
    fetchText(SOURCES.y2024).then(parseCSV),
    fetchText(SOURCES.y2020).then(parseCSV),
    fetchText(SOURCES.panel).then(parseCSV),
  ]);

  // Process newest first so canonical (clean) county names win.
  console.log(`  2024: ${addTonmcgYear(c2024, 2024)} TX counties`);
  console.log(`  2020: ${addTonmcgYear(c2020, 2020)} TX counties`);
  console.log(`  2016: ${addPanelYear(panel, 2016)} TX counties (from 2008-2016 panel)`);
  console.log(`  2012: ${addPanelYear(panel, 2012)} TX counties (from 2008-2016 panel)`);

  const countyList = [...counties.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Sanity: every county should have all four cycles.
  const incomplete = countyList.filter(c => YEARS.some(y => !c.years[y]));
  if (incomplete.length) {
    console.warn(`  ! ${incomplete.length} counties missing a cycle, e.g. ${incomplete.slice(0, 3).map(c => c.name).join(', ')}`);
  }

  // Statewide aggregates per cycle (summed from county returns).
  const statewide = YEARS.map(year => {
    let gop = 0, dem = 0, other = 0, total = 0;
    for (const c of countyList) {
      const d = c.years[year];
      if (!d) continue;
      gop += d.gop; dem += d.dem; other += d.other; total += d.total;
    }
    return {
      year, gop, dem, other, total,
      gopPct: total ? +(gop / total * 100).toFixed(2) : 0,
      demPct: total ? +(dem / total * 100).toFixed(2) : 0,
      otherPct: total ? +(other / total * 100).toFixed(2) : 0,
      marginPct: total ? +((gop - dem) / total * 100).toFixed(2) : 0, // + R, - D
      winner: gop > dem ? 'R' : dem > gop ? 'D' : 'T',
      electoralVotes: EV[year],
    };
  });

  const now = new Date();
  const generated = now.toLocaleString('en-US', {
    timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  const meta = {
    title: 'Texas Election Watch Board',
    subtitle: 'County-level presidential results, 2012–2024',
    state: 'Texas',
    stateFips: TX_PREFIX,
    countyCount: countyList.length,
    years: YEARS,
    latestYear: Math.max(...YEARS),
    electoralVotes: EV,
    timezone: 'America/Chicago (Central Time)',
    generated,                                   // human-readable, Central Time
    generatedUTC: now.toISOString(),             // machine-readable reference
    sources: [
      {
        name: 'tonmcg/US_County_Level_Election_Results_08-24',
        url: 'https://github.com/tonmcg/US_County_Level_Election_Results_08-24',
        note: 'County-level presidential returns (2012–2024), compiled from official state/county canvasses and major-network tabulations.',
      },
      {
        name: 'plotly/datasets — geojson-counties-fips.json',
        url: 'https://github.com/plotly/datasets',
        note: 'U.S. Census cartographic county boundaries, filtered to Texas (FIPS 48xxx).',
      },
    ],
    disclaimer:
      '“Other” = total − (Republican + Democratic). Figures are tabulations compiled from public sources and may differ slightly from the final Texas Secretary of State canvass.',
  };

  // Geometry, filtered to Texas + simplified.
  console.log('\nFetching county geometry...');
  const geoRaw = JSON.parse(await fetchText(SOURCES.geo));
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const geoCounties = [];
  for (const f of geoRaw.features) {
    const fips = fipsOf(f);
    if (!fips || !fips.startsWith(TX_PREFIX)) continue;
    const rings = outerRings(f.geometry);
    if (!rings.length) continue;
    for (const ring of rings) for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    geoCounties.push({
      fips,
      name: counties.get(fips)?.name || cleanName(f.properties && f.properties.NAME) || fips,
      rings,
    });
  }
  geoCounties.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`  Texas geometry: ${geoCounties.length} counties`);

  const geo = {
    bbox: [round(minLon), round(minLat), round(maxLon), round(maxLat)],
    counties: geoCounties,
  };

  await mkdir(DATA, { recursive: true });
  await writeFile(path.join(DATA, 'elections.json'),
    JSON.stringify({ meta, statewide, counties: countyList }));
  await writeFile(path.join(DATA, 'tx-counties-geo.json'), JSON.stringify(geo));

  // Report for eyeball validation against published official totals.
  console.log('\nStatewide presidential results (summed from county returns):');
  console.log('  year   GOP        DEM        OTHER    TOTAL       margin  win  EV');
  for (const s of statewide) {
    console.log(
      `  ${s.year}  ${String(s.gop).padStart(9)}  ${String(s.dem).padStart(9)}  ` +
      `${String(s.other).padStart(6)}  ${String(s.total).padStart(10)}  ` +
      `${(s.marginPct >= 0 ? 'R+' : 'D+') + String(Math.abs(s.marginPct).toFixed(1)).padStart(4)}  ` +
      `${s.winner}    ${s.electoralVotes}`
    );
  }
  console.log(`\nGenerated (Central): ${generated}`);
  console.log('Wrote data/elections.json and data/tx-counties-geo.json');
}

main().catch(err => { console.error(err); process.exit(1); });
