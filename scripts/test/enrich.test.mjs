// Tests for the FEC enrichment: pure helpers (name dedupe, retry parsing) + an
// end-to-end run against the mock FEC, including the partial-failure path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMock } from './mock-fec.mjs';
import { nameKey, mergeCivic, retryAfterMs } from '../enrich-races.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENRICH = path.join(HERE, '..', 'enrich-races.mjs');

const fixture = () => ({
  meta: {},
  senate: [{ office: 'U.S. Senate', seat: 'Class 2', district: null, incumbent: {}, candidates: [] }],
  house: [{ office: 'U.S. House', district: 1, incumbent: {}, candidates: [] }],
  stateLocal: [],
});

async function enrichTemp(port, { failOffices } = {}) {
  const srv = await startMock(port, { failOffices });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'enrich-'));
  const file = path.join(dir, 'races.json');
  await writeFile(file, JSON.stringify(fixture()));
  const env = { ...process.env, FEC_API_KEY: 'TEST', CIVIC_API_KEY: '',
    FEC_BASE_URL: `http://127.0.0.1:${port}/v1`, RACES_FILE: file };
  let exitOk = true;
  try { await run('node', [ENRICH], { env }); } catch { exitOk = false; }
  const out = JSON.parse(await readFile(file, 'utf8'));
  srv.close(); await rm(dir, { recursive: true, force: true });
  return { out, exitOk };
}

test('nameKey: LAST,First == First Last, incl. multi-word surnames and suffixes', () => {
  assert.equal(nameKey('CORNYN, JOHN'), nameKey('John Cornyn'));
  assert.equal(nameKey('DE LA CRUZ, MONICA'), nameKey('Monica De La Cruz'));
  assert.equal(nameKey('VAN DUYNE, BETH'), nameKey('Beth Van Duyne'));
  assert.equal(nameKey('GONZALEZ, VICENTE, JR.'), nameKey('Vicente Gonzalez Jr.'));
  assert.notEqual(nameKey('GARCIA, SYLVIA'), nameKey('GARCIA, RAUL'));
});

test('mergeCivic dedupes the incumbent and adds Civic-only candidates', () => {
  const fec = [{ name: 'CORNYN, JOHN', party: 'R', fec_id: 'S1', finance: { receipts: 1 } }];
  const civic = [{ name: 'John Cornyn', party: 'R' }, { name: 'Maria Vega', party: 'L' }];
  const merged = mergeCivic(fec, civic);
  assert.equal(merged.length, 2, 'Cornyn deduped, Vega added');
  assert.equal(merged.filter(c => nameKey(c.name) === nameKey('CORNYN, JOHN')).length, 1);
});

test('retryAfterMs handles seconds, HTTP-date, and junk', () => {
  assert.equal(retryAfterMs('5'), 5000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('not-a-date'), null);
  const ms = retryAfterMs(new Date(Date.now() + 9000).toUTCString());
  assert.ok(ms > 3000 && ms <= 9000, `date->${ms}ms`);
});

test('integration: enrich against mock FEC enriches, ranks by receipts, dedupes', async () => {
  const { out } = await enrichTemp(8841);
  assert.equal(out.meta.enrichment.ok, true);
  assert.equal(out.senate[0].candidates.length, 2);
  assert.equal(out.senate[0].candidates[0].name, 'CORNYN, JOHN'); // top fundraiser first
  assert.equal(out.senate[0].candidates[0].party, 'R');           // REP -> R
  assert.equal(out.senate[0].candidates[0].finance.receipts, 12500000.5);
  assert.equal(out.house[0].candidates.length, 1);
});

test('integration: partial FEC failure -> enrichment.ok false, failures recorded', async () => {
  const { out, exitOk } = await enrichTemp(8842, { failOffices: ['S'] });
  assert.equal(out.meta.enrichment.ok, false);
  assert.ok(out.meta.enrichment.failures >= 1);
  assert.equal(exitOk, false, 'partial run exits non-zero for CI');
  assert.equal(out.house[0].candidates.length, 1, 'the healthy race still enriched');
});
