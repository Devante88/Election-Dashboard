// Tests for the CSV parser used by build-data.mjs — quoted commas, escaped
// quotes, and the row/column-count guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCSVLine, parseCSV } from '../build-data.mjs';

test('splitCSVLine handles plain, quoted-comma, and escaped-quote cells', () => {
  assert.deepEqual(splitCSVLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCSVLine('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(splitCSVLine('a,"b""c",d'), ['a', 'b"c', 'd']);
  assert.deepEqual(splitCSVLine('x,,z'), ['x', '', 'z']);
});

test('parseCSV maps rows to header-keyed objects and trims', () => {
  const rows = parseCSV('name,votes\n"Harris, TX", 123\nDallas,456');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Harris, TX');
  assert.equal(rows[0].votes, '123');
  assert.equal(rows[1].name, 'Dallas');
});

test('parseCSV throws on a ragged row (cell/column mismatch)', () => {
  assert.throws(() => parseCSV('a,b,c\n1,2'), /row 2 has 2 cells, expected 3/);
});
