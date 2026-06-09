// Reusable mock of the OpenFEC API for tests — matches the real response shapes
// (paginated /candidates/search/ and /candidate/:id/totals/). startMock returns a
// listening server; pass { failOffices:['S'] } to simulate a partial outage.
import { createServer } from 'node:http';

const SENATE = [
  { candidate_id: 'S2TX00106', name: 'CORNYN, JOHN', party: 'REP', incumbent_challenge_full: 'Incumbent' },
  { candidate_id: 'S6TX00999', name: 'DOE, JANE', party: 'DEM', incumbent_challenge_full: 'Challenger' },
];
const HOUSE_1 = [
  { candidate_id: 'H2TX01112', name: 'MORAN, NATHANIEL', party: 'REP', incumbent_challenge_full: 'Incumbent' },
];
const TOTALS = {
  S2TX00106: { receipts: 12500000.5, disbursements: 4300000, last_cash_on_hand_end_period: 8200000 },
  S6TX00999: { receipts: 4300000, disbursements: 1900000, last_cash_on_hand_end_period: 2100000 },
  H2TX01112: { receipts: 900000, disbursements: 300000, last_cash_on_hand_end_period: 600000 },
};

export function startMock(port, opts = {}) {
  const fail = new Set(opts.failOffices || []);
  const srv = createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    res.setHeader('content-type', 'application/json');
    const tot = u.pathname.match(/\/candidate\/([^/]+)\/totals\/?$/);
    if (tot) { res.end(JSON.stringify({ results: TOTALS[tot[1]] ? [TOTALS[tot[1]]] : [] })); return; }
    if (/\/candidates(\/search)?\/?$/.test(u.pathname)) {
      const office = u.searchParams.get('office');
      if (office && fail.has(office)) { res.statusCode = 500; res.end(JSON.stringify({ error: 'boom' })); return; }
      const district = u.searchParams.get('district');
      let results = [];
      if (office === 'S') results = SENATE;
      else if (office === 'H' && district === '01') results = HOUSE_1;
      res.end(JSON.stringify({ results, pagination: { page: 1, pages: 1, count: results.length } }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'nf' }));
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}
