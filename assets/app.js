/* Texas Election Watch Board — zero-dependency dashboard.
 * Renders statewide summary, trend, a county choropleth, highlights and a
 * sortable/searchable county table from committed JSON built by scripts/build-data.mjs.
 */

const state = {
  data: null,        // elections.json
  geo: null,         // tx-counties-geo.json
  year: null,        // selected cycle
  sortKey: 'name',
  sortDir: 1,        // 1 asc, -1 desc
  query: '',
};

const REP = [216, 57, 47];
const DEM = [47, 111, 224];
const NEUTRAL = [236, 233, 224];
const MARGIN_CAP = 40; // saturate the map color scale at +/- 40 pts

/* ----------------------------------------------------------------- utils */
const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElementNS(attrs.ns || 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'ns') continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
};
const svgEl = (tag, attrs = {}) => el(tag, { ns: 'http://www.w3.org/2000/svg', ...attrs });

const fmt = n => Number(n).toLocaleString('en-US');
const pct = n => `${n.toFixed(1)}%`;

// Derive display metrics for a single county-year record.
function metrics(rec) {
  const total = rec.total || (rec.gop + rec.dem + rec.other);
  const gopPct = total ? (rec.gop / total) * 100 : 0;
  const demPct = total ? (rec.dem / total) * 100 : 0;
  const otherPct = total ? (rec.other / total) * 100 : 0;
  const marginPct = total ? ((rec.gop - rec.dem) / total) * 100 : 0; // + R, - D
  return { ...rec, total, gopPct, demPct, otherPct, marginPct, winner: rec.gop >= rec.dem ? 'R' : 'D' };
}

function colorForMargin(m) {
  const t = Math.min(1, Math.abs(m) / MARGIN_CAP);
  const end = m >= 0 ? REP : DEM;
  const c = NEUTRAL.map((n, i) => Math.round(n + (end[i] - n) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const marginLabel = m => (m >= 0 ? 'R+' : 'D+') + Math.abs(m).toFixed(1);

/* ----------------------------------------------------------------- boot */
async function init() {
  // The forward-looking panel loads on its own so it still shows even if the
  // historical datasets fail to load.
  initUpcoming();
  try {
    const [data, geo] = await Promise.all([
      fetch('data/elections.json').then(r => { if (!r.ok) throw new Error('elections.json'); return r.json(); }),
      fetch('data/tx-counties-geo.json').then(r => { if (!r.ok) throw new Error('geo'); return r.json(); }),
    ]);
    state.data = data;
    state.geo = geo;
    state.year = data.meta.latestYear;
    $('#search').disabled = false;
    renderStatic();
    renderYearPicker();
    renderAll();
  } catch (err) {
    const box = $('#loadError');
    box.hidden = false;
    box.textContent =
      'Could not load election data (' + err.message + '). ' +
      'Serve the folder over HTTP — e.g. "python3 -m http.server" — then open http://localhost:8000/.';
  }
}

function renderStatic() {
  const m = state.data.meta;
  $('#subtitle').textContent = m.subtitle || 'County-level presidential results';
  $('#generated').textContent =
    `Generated ${m.generated} (${m.timezone || 'Central Time'}) · ${m.countyCount} counties`;
  $('#disclaimer').textContent = m.disclaimer || '';
  const links = (m.sources || [])
    .map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`)
    .join(' · ');
  $('#sources').innerHTML = 'Data: ' + links;
}

function renderYearPicker() {
  const box = $('#yearPicker');
  box.innerHTML = '';
  for (const y of state.data.meta.years) {
    const b = el('button', {
      class: 'year-btn' + (y === state.year ? ' active' : ''),
      type: 'button', role: 'tab',
      'aria-selected': y === state.year ? 'true' : 'false',
      text: String(y),
    });
    b.addEventListener('click', () => { state.year = y; renderYearPicker(); renderAll(); });
    box.appendChild(b);
  }
}

function renderAll() {
  renderSummary();
  renderTrend();
  renderMap();
  renderHighlights();
  renderTable();
}

/* ----------------------------------------------------------------- summary */
const statewideFor = year => state.data.statewide.find(s => s.year === year);

function renderSummary() {
  const s = statewideFor(state.year);
  const wrap = $('#summaryCards');
  wrap.innerHTML = '';
  const winnerName = s.winner === 'R' ? 'Republican' : s.winner === 'D' ? 'Democratic' : 'Tie';
  const winnerCls = s.winner === 'R' ? 'rep' : 'dem';

  const cards = [
    { cls: winnerCls, label: `${state.year} winner`, value: winnerName,
      sub: `${s.electoralVotes} electoral votes · ${marginLabel(s.marginPct)} margin` },
    { cls: 'rep', label: 'Republican', value: pct(s.gopPct), sub: `${fmt(s.gop)} votes` },
    { cls: 'dem', label: 'Democratic', value: pct(s.demPct), sub: `${fmt(s.dem)} votes` },
    { cls: '', label: 'Total ballots', value: fmt(s.total),
      sub: `${pct(s.otherPct)} other · ${state.data.meta.countyCount} counties` },
  ];

  for (const c of cards) {
    wrap.appendChild(el('div', { class: 'card ' + c.cls }, [
      el('div', { class: 'label', text: c.label }),
      el('div', { class: 'value', text: c.value }),
      el('div', { class: 'sub', text: c.sub }),
    ]));
  }
}

/* ----------------------------------------------------------------- trend */
function renderTrend() {
  const W = 560, H = 300, padL = 40, padR = 16, padT = 28, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const series = state.data.statewide;
  // Fit the axis to the data (rounded up to a 10s gridline, with headroom for
  // the value label) so a high-share cycle can't overflow the plot.
  const peak = Math.max(...series.flatMap(s => [s.gopPct, s.demPct]));
  const yMax = Math.min(100, Math.max(50, Math.ceil((peak + 8) / 10) * 10));
  const y = v => padT + plotH * (1 - v / yMax);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

  for (let v = 0; v <= yMax; v += 10) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: padL, y1: y(v), x2: W - padR, y2: y(v) }));
    svg.appendChild(Object.assign(
      svgEl('text', { class: 'axis-text', x: padL - 8, y: y(v) + 4, 'text-anchor': 'end' }),
      { textContent: v + '%' }
    ));
  }

  const groupW = plotW / series.length;
  const barW = Math.min(34, groupW * 0.3);

  series.forEach((s, i) => {
    const cx = padL + groupW * (i + 0.5);
    const dim = s.year === state.year ? '' : ' dim';
    const pairs = [
      { v: s.gopPct, cls: 'bar-rep', dx: -barW - 3 },
      { v: s.demPct, cls: 'bar-dem', dx: 3 },
    ];
    for (const p of pairs) {
      const h = plotH * (p.v / yMax);
      svg.appendChild(svgEl('rect', { class: p.cls + dim, x: cx + p.dx, y: y(p.v), width: barW, height: h, rx: 3 }));
      svg.appendChild(Object.assign(
        svgEl('text', { class: 'bar-label' + dim, x: cx + p.dx + barW / 2, y: y(p.v) - 6 }),
        { textContent: p.v.toFixed(0) }
      ));
    }
    svg.appendChild(Object.assign(
      svgEl('text', { class: 'margin-label' + dim, x: cx, y: padT - 12, fill: colorForMargin(s.marginPct) }),
      { textContent: marginLabel(s.marginPct) }
    ));
    svg.appendChild(Object.assign(
      svgEl('text', { class: 'year-label' + (s.year === state.year ? ' sel' : ''), x: cx, y: H - padB + 22 }),
      { textContent: String(s.year) }
    ));
  });

  svg.appendChild(svgEl('line', { class: 'axis-line', x1: padL, y1: y(0), x2: W - padR, y2: y(0) }));

  const host = $('#trendChart');
  host.innerHTML = '';
  host.appendChild(svg);
}

/* ----------------------------------------------------------------- map */
function makeProjector() {
  const [minLon, minLat, maxLon, maxLat] = state.geo.bbox;
  const W = 820, H = 760, pad = 12;
  const meanLat = (minLat + maxLat) / 2;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const lonSpan = (maxLon - minLon) * k;
  const latSpan = maxLat - minLat;
  const scale = Math.min((W - 2 * pad) / lonSpan, (H - 2 * pad) / latSpan);
  const drawW = lonSpan * scale, drawH = latSpan * scale;
  const offX = (W - drawW) / 2, offY = (H - drawH) / 2;
  const project = (lon, lat) => [offX + (lon - minLon) * k * scale, offY + (maxLat - lat) * scale];
  return { W, H, project };
}

function pathFor(county, project) {
  let d = '';
  for (const ring of county.rings) {
    ring.forEach(([lon, lat], i) => {
      const [x, y] = project(lon, lat);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    d += 'Z';
  }
  return d;
}

function renderMap() {
  const { W, H, project } = makeProjector();
  const byFips = new Map();
  for (const c of state.data.counties) {
    const rec = c.years[state.year];
    if (rec) byFips.set(c.fips, { name: c.name, m: metrics(rec) });
  }

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  for (const county of state.geo.counties) {
    const info = byFips.get(county.fips);
    const fill = info ? colorForMargin(info.m.marginPct) : '#2a3550';
    // Keyboard- and screen-reader-accessible: focusable, with a full label.
    const label = info
      ? `${info.name} County: ${marginLabel(info.m.marginPct)}, ` +
        `${fmt(info.m.gop)} Republican, ${fmt(info.m.dem)} Democratic, ${fmt(info.m.total)} total`
      : `${county.name} County: no data`;
    svg.appendChild(svgEl('path', {
      class: 'county', d: pathFor(county, project), fill,
      'data-fips': county.fips, tabindex: '0', role: 'img', 'aria-label': label,
    }));
  }

  const host = $('#map');
  host.innerHTML = '';
  host.appendChild(svg);

  const tip = $('#mapTooltip');
  const wrap = $('#mapWrap');

  // Build the tooltip from DOM nodes (never innerHTML) so county names from the
  // data can't inject markup; position it relative to the hovered/focused county.
  const ttRow = (lab, val, cls) => el('div', { class: 'tt-row' }, [
    el('span', { text: lab }), el('b', { class: cls || '', text: val }),
  ]);
  const showTip = (info, px, py) => {
    const m = info.m;
    tip.replaceChildren(
      el('div', { class: 'tt-name', text: `${info.name} County` }),
      ttRow('Margin', marginLabel(m.marginPct), m.winner === 'R' ? 'val-rep' : 'val-dem'),
      ttRow('Rep', `${fmt(m.gop)} (${pct(m.gopPct)})`),
      ttRow('Dem', `${fmt(m.dem)} (${pct(m.demPct)})`),
      ttRow('Total', fmt(m.total)),
    );
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    let x = px - r.left + 14;
    const yy = py - r.top + 14;
    if (x + 180 > r.width) x = px - r.left - 180;
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = yy + 'px';
  };
  const hideTip = () => { tip.hidden = true; };
  const infoFor = node => node && byFips.get(node.getAttribute('data-fips'));

  svg.addEventListener('mousemove', ev => {
    const info = infoFor(ev.target.closest('path[data-fips]'));
    info ? showTip(info, ev.clientX, ev.clientY) : hideTip();
  });
  svg.addEventListener('mouseleave', hideTip);
  // Keyboard focus: anchor the tooltip to the focused county's box.
  svg.addEventListener('focusin', ev => {
    const path = ev.target.closest('path[data-fips]');
    const info = infoFor(path);
    if (!info) return;
    const b = path.getBoundingClientRect();
    showTip(info, b.left + b.width / 2, b.top + b.height / 2);
  });
  svg.addEventListener('focusout', hideTip);

  const legend = $('#mapLegend');
  legend.innerHTML = '';
  const grad = `linear-gradient(to right, ${colorForMargin(-40)}, ${colorForMargin(-10)}, ${colorForMargin(0)}, ${colorForMargin(10)}, ${colorForMargin(40)})`;
  legend.appendChild(el('span', { text: 'D+40' }));
  legend.appendChild(el('span', { class: 'bar', style: `background:${grad}` }));
  legend.appendChild(el('span', { text: 'R+40' }));

  $('#mapTitle').textContent = `${state.year} county margin`;
}

/* ----------------------------------------------------------------- highlights */
function countyMetricsForYear(year) {
  const out = [];
  for (const c of state.data.counties) {
    const rec = c.years[year];
    if (!rec) continue;
    out.push({ fips: c.fips, name: c.name, ...metrics(rec) });
  }
  return out;
}

function hlCard(title, items) {
  const ul = el('ul', { class: 'hl-list' });
  for (const it of items) {
    ul.appendChild(el('li', {}, [
      el('span', { class: 'hl-name', text: it.name }),
      el('span', { class: 'hl-val ' + (it.cls || ''), text: it.val }),
    ]));
  }
  return el('div', { class: 'hl-card' }, [el('h3', { text: title }), ul]);
}

function renderHighlights() {
  const rows = countyMetricsForYear(state.year);
  const wrap = $('#highlights');
  wrap.innerHTML = '';

  const closest = [...rows].sort((a, b) => Math.abs(a.marginPct) - Math.abs(b.marginPct)).slice(0, 5)
    .map(r => ({ name: r.name, val: marginLabel(r.marginPct), cls: r.winner === 'R' ? 'val-rep' : 'val-dem' }));
  const reddest = [...rows].sort((a, b) => b.marginPct - a.marginPct).slice(0, 5)
    .map(r => ({ name: r.name, val: marginLabel(r.marginPct), cls: 'val-rep' }));
  const bluest = [...rows].sort((a, b) => a.marginPct - b.marginPct).slice(0, 5)
    .map(r => ({ name: r.name, val: marginLabel(r.marginPct), cls: 'val-dem' }));
  const turnout = [...rows].sort((a, b) => b.total - a.total).slice(0, 5)
    .map(r => ({ name: r.name, val: fmt(r.total), cls: r.winner === 'R' ? 'val-rep' : 'val-dem' }));

  wrap.appendChild(hlCard('Closest races', closest));
  wrap.appendChild(hlCard('Largest Republican margins', reddest));
  wrap.appendChild(hlCard('Largest Democratic margins', bluest));
  wrap.appendChild(hlCard('Highest turnout', turnout));

  const years = state.data.meta.years;
  const idx = years.indexOf(state.year);
  if (idx > 0) {
    const prev = years[idx - 1];
    const prevByFips = new Map(countyMetricsForYear(prev).map(r => [r.fips, r]));
    const swings = rows
      .map(r => {
        const p = prevByFips.get(r.fips);
        return p ? { name: r.name, delta: r.marginPct - p.marginPct } : null;
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5)
      .map(r => ({
        name: r.name,
        val: (r.delta >= 0 ? '→R ' : '→D ') + Math.abs(r.delta).toFixed(1),
        cls: r.delta >= 0 ? 'val-rep' : 'val-dem',
      }));
    wrap.appendChild(hlCard(`Biggest swing vs ${prev}`, swings));
  } else {
    const competitive = [...rows]
      .filter(r => Math.abs(r.marginPct) < 20)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map(r => ({ name: r.name, val: marginLabel(r.marginPct), cls: r.winner === 'R' ? 'val-rep' : 'val-dem' }));
    wrap.appendChild(hlCard('Competitive & populous', competitive));
  }
}

/* ----------------------------------------------------------------- table */
const COLS = [
  { key: 'name', label: 'County' },
  { key: 'winner', label: 'Winner' },
  { key: 'gop', label: 'Rep votes' },
  { key: 'gopPct', label: 'Rep %' },
  { key: 'dem', label: 'Dem votes' },
  { key: 'demPct', label: 'Dem %' },
  { key: 'other', label: 'Other' },
  { key: 'total', label: 'Total' },
  { key: 'marginPct', label: 'Margin' },
];

function renderTableHeader() {
  const tr = $('#tableHeaderRow');
  tr.innerHTML = '';
  for (const col of COLS) {
    const arrow = state.sortKey === col.key ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
    const th = el('th', { html: col.label + `<span class="arrow">${arrow}</span>` });
    th.addEventListener('click', () => {
      if (state.sortKey === col.key) state.sortDir *= -1;
      else { state.sortKey = col.key; state.sortDir = col.key === 'name' ? 1 : -1; }
      renderTable();
    });
    tr.appendChild(th);
  }
}

function renderTable() {
  // The #search handler can fire before init() resolves (or after it fails),
  // when state.data is still null — bail rather than deref it.
  if (!state.data) return;
  renderTableHeader();
  const rows = countyMetricsForYear(state.year)
    .filter(r => r.name.toLowerCase().includes(state.query));

  const k = state.sortKey;
  rows.sort((a, b) => {
    const av = a[k], bv = b[k];
    if (k === 'name' || k === 'winner') return String(av).localeCompare(String(bv)) * state.sortDir;
    return (av - bv) * state.sortDir;
  });

  const body = $('#tableBody');
  body.innerHTML = '';
  for (const r of rows) {
    const winCls = r.winner === 'R' ? 'win-r' : 'win-d';
    const marCls = r.marginPct >= 0 ? 'win-r' : 'win-d';
    body.appendChild(el('tr', {}, [
      el('td', { text: r.name }),
      el('td', { class: winCls, text: r.winner }),
      el('td', { text: fmt(r.gop) }),
      el('td', { text: pct(r.gopPct) }),
      el('td', { text: fmt(r.dem) }),
      el('td', { text: pct(r.demPct) }),
      el('td', { text: fmt(r.other) }),
      el('td', { text: fmt(r.total) }),
      el('td', { class: marCls, text: marginLabel(r.marginPct) }),
    ]));
  }
  $('#tableCaption').textContent = `${rows.length} of ${state.data.meta.countyCount} counties · ${state.year}`;
}

/* ----------------------------------------------------------- upcoming election */
// Forward-looking panel: the next Texas general election, statutory key dates,
// and which offices are on the ballot (by term cycle). No candidates, no
// predictions — built from data/upcoming.json (hand-maintained statute facts).
let countdownTimer = null;

async function initUpcoming() {
  let up;
  try {
    const r = await fetch('data/upcoming.json');
    if (!r.ok) throw new Error('upcoming.json');
    up = await r.json();
  } catch {
    return; // panel stays hidden; the rest of the board is unaffected
  }
  renderUpcoming(up);
}

function countdownParts(targetISO) {
  const ms = new Date(targetISO).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    mins: Math.floor((s % 3600) / 60),
    secs: s % 60,
  };
}

function renderUpcoming(up) {
  const host = $('#upcoming');
  if (!host || !up || !up.next) return;
  const n = up.next;

  const cdWrap = el('div', { class: 'countdown', id: 'countdown', role: 'timer', 'aria-label': 'Time until election day' });
  const head = el('div', { class: 'up-head' }, [
    el('div', {}, [
      el('div', { class: 'up-eyebrow', text: 'Next election' }),
      el('div', { class: 'up-title', text: n.name }),
      el('div', { class: 'up-meta', text: `${n.kind} · ${n.dateLabel}` }),
      n.pollsLabel ? el('div', { class: 'up-meta', text: n.pollsLabel }) : null,
    ]),
    cdWrap,
  ]);

  // Key dates
  const dates = el('div', { class: 'up-col' }, [el('h4', { class: 'up-offices-h', text: 'Key dates' })]);
  const dl = el('ul', { class: 'up-dates' });
  for (const d of up.keyDates || []) {
    const labelWrap = el('span', { class: 'd-label', text: d.label });
    if (d.status) labelWrap.appendChild(el('span', { class: 'tag ' + d.status, text: d.status }));
    const li = el('li', { class: d.status || '' }, [
      labelWrap,
      el('span', { class: 'd-when', text: d.dateLabel }),
    ]);
    if (d.note) li.title = d.note;
    dl.appendChild(li);
  }
  dates.appendChild(dl);

  // Offices on the ballot
  const offices = el('div', { class: 'up-offices' }, [el('h4', { text: 'On the ballot (by term cycle)' })]);
  for (const g of up.offices || []) {
    const ul = el('ul', {});
    for (const it of g.items || []) {
      ul.appendChild(el('li', {}, [
        el('span', { class: 'o-name', text: it.office }),
        el('span', { class: 'o-scope', text: it.scope }),
      ]));
    }
    offices.appendChild(el('div', { class: 'up-office-group' }, [el('h4', { text: g.group }), ul]));
  }

  const grid = el('div', { class: 'up-grid' }, [dates, offices]);

  const sourceLinks = el('span', {});
  (up.sources || []).forEach((s, i) => {
    if (i) sourceLinks.appendChild(el('span', { text: ' · ' }));
    sourceLinks.appendChild(el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.name }));
  });
  const note = el('p', { class: 'up-note' }, [
    el('span', { text: (up.disclaimer || '') + ' Sources: ' }),
    sourceLinks,
  ]);

  host.replaceChildren(head, grid, note);
  host.hidden = false;

  // Live countdown (updates every second; cleared/replaced on re-render).
  const tick = () => {
    const p = countdownParts(n.countdownTargetISO);
    if (!p) {
      cdWrap.replaceChildren(el('div', { class: 'cd-unit' }, [el('div', { class: 'cd-num', text: 'Today' })]));
      if (countdownTimer) clearInterval(countdownTimer);
      return;
    }
    cdWrap.replaceChildren(
      ...[['days', 'Days'], ['hours', 'Hrs'], ['mins', 'Min'], ['secs', 'Sec']].map(([k, lab]) =>
        el('div', { class: 'cd-unit' }, [
          el('div', { class: 'cd-num', text: String(p[k]).padStart(2, '0') }),
          el('div', { class: 'cd-lab', text: lab }),
        ])
      )
    );
  };
  if (countdownTimer) clearInterval(countdownTimer);
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// Disabled until init() loads data; the input handler guards on state.data too.
$('#search').disabled = true;
$('#search').addEventListener('input', e => {
  state.query = e.target.value.trim().toLowerCase();
  renderTable();
});

init();
