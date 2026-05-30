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
  try {
    const [data, geo] = await Promise.all([
      fetch('data/elections.json').then(r => { if (!r.ok) throw new Error('elections.json'); return r.json(); }),
      fetch('data/tx-counties-geo.json').then(r => { if (!r.ok) throw new Error('geo'); return r.json(); }),
    ]);
    state.data = data;
    state.geo = geo;
    state.year = data.meta.latestYear;
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
  const yMax = 70;
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
    svg.appendChild(svgEl('path', { class: 'county', d: pathFor(county, project), fill, 'data-fips': county.fips }));
  }

  const host = $('#map');
  host.innerHTML = '';
  host.appendChild(svg);

  const tip = $('#mapTooltip');
  const wrap = $('#mapWrap');
  svg.addEventListener('mousemove', ev => {
    const path = ev.target.closest('path[data-fips]');
    if (!path) { tip.hidden = true; return; }
    const info = byFips.get(path.getAttribute('data-fips'));
    if (!info) { tip.hidden = true; return; }
    const m = info.m;
    const winCls = m.winner === 'R' ? 'val-rep' : 'val-dem';
    tip.innerHTML =
      `<div class="tt-name">${info.name} County</div>` +
      `<div class="tt-row"><span>Margin</span> <b class="${winCls}">${marginLabel(m.marginPct)}</b></div>` +
      `<div class="tt-row"><span>Rep</span> <b>${fmt(m.gop)} (${pct(m.gopPct)})</b></div>` +
      `<div class="tt-row"><span>Dem</span> <b>${fmt(m.dem)} (${pct(m.demPct)})</b></div>` +
      `<div class="tt-row"><span>Total</span> <b>${fmt(m.total)}</b></div>`;
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    let x = ev.clientX - r.left + 14;
    const yy = ev.clientY - r.top + 14;
    if (x + 180 > r.width) x = ev.clientX - r.left - 180;
    tip.style.left = x + 'px';
    tip.style.top = yy + 'px';
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });

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

$('#search').addEventListener('input', e => {
  state.query = e.target.value.trim().toLowerCase();
  renderTable();
});

init();
