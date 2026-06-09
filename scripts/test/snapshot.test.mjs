// Tests for the finance-snapshot aggregation: by-party totals, cash-only
// inclusion, the partial flag, and the Central-time day key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, centralDay } from '../snapshot-finance.mjs';

const races = (cands, enrichment) => ({
  meta: enrichment ? { enrichment } : {},
  senate: [{ office: 'U.S. Senate', candidates: cands }],
  house: [], stateLocal: [],
});

test('aggregates by party + overall totals and ranks top fundraisers', () => {
  const s = buildSnapshot(races([
    { name: 'A', party: 'R', finance: { receipts: 100, cashOnHand: 50 } },
    { name: 'B', party: 'D', finance: { receipts: 40, cashOnHand: 20 } },
  ], { ok: true, source: 'X' }));
  assert.equal(s.hasData, true);
  assert.equal(s.totals.receipts, 140);
  assert.equal(s.byParty.R.receipts, 100);
  assert.equal(s.byParty.D.cashOnHand, 20);
  assert.equal(s.top[0].name, 'A'); // highest receipts first
  assert.equal(s.partial, false);
});

test('includes a cash-only candidate (null receipts)', () => {
  const s = buildSnapshot(races([{ name: 'C', party: 'R', finance: { receipts: null, cashOnHand: 600 } }], { ok: true }));
  assert.equal(s.hasData, true);
  assert.equal(s.totals.cashOnHand, 600);
  assert.equal(s.byParty.R.candidates, 1);
});

test('flags partial when enrichment.ok === false', () => {
  const s = buildSnapshot(races([{ name: 'A', party: 'R', finance: { receipts: 10 } }], { ok: false, failures: 3 }));
  assert.equal(s.partial, true);
});

test('empty -> hasData false, nothing invented', () => {
  const s = buildSnapshot(races([]));
  assert.equal(s.hasData, false);
  assert.equal(s.totals.receipts, 0);
  assert.equal(s.top.length, 0);
  assert.equal(s.partial, false);
});

test('centralDay yields a YYYY-MM-DD key in Texas time (evening != next UTC day)', () => {
  assert.match(centralDay(new Date()), /^\d{4}-\d{2}-\d{2}$/);
  // 9:31 PM CDT on May 30 is 02:31 UTC May 31 — must key to May 30 (Central).
  assert.equal(centralDay(new Date('2026-05-30T21:31:00-05:00')), '2026-05-30');
});
