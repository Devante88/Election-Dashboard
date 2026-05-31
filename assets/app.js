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
  palette: 'rdbu',   // 'rdbu' (default) | 'orpu' (color-blind-safe)
  mapMetric: 'margin', // 'margin' | 'turnout' | 'other'
  county: null,      // FIPS of the county open in the detail drawer
};

// Diverging palettes: [Dem-end, neutral, Rep-end]. "orpu" (orange↔purple) stays
// distinguishable under red-green color-blindness, unlike the default red↔blue.
const PALETTES = {
  rdbu: { dem: [47, 111, 224], neutral: [236, 233, 224], rep: [216, 57, 47], demName: 'Blue', repName: 'Red' },
  orpu: { dem: [120, 70, 190], neutral: [238, 236, 230], rep: [224, 122, 30], demName: 'Purple', repName: 'Orange' },
};
const MARGIN_CAP = 40; // saturate the margin color scale at +/- 40 pts
// Sequential ramp (low→high) for single-value metrics like turnout.
const SEQ_LO = [25, 33, 52], SEQ_HI = [231, 181, 60];

const lerp = (a, b, t) => a.map((n, i) => Math.round(n + (b[i] - n) * t));
const rgb = c => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

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
  const p = PALETTES[state.palette] || PALETTES.rdbu;
  const t = Math.min(1, Math.abs(m) / MARGIN_CAP);
  return rgb(lerp(p.neutral, m >= 0 ? p.rep : p.dem, t));
}

// Fill for the active map metric. `ctx` carries per-cycle min/max for scaling.
function colorForMetric(m, ctx) {
  if (state.mapMetric === 'margin') return colorForMargin(m.marginPct);
  if (state.mapMetric === 'turnout') {
    const span = ctx.maxTurnout - ctx.minTurnout || 1;
    return rgb(lerp(SEQ_LO, SEQ_HI, (m.total - ctx.minTurnout) / span));
  }
  // other-party share
  const span = ctx.maxOther || 1;
  return rgb(lerp(SEQ_LO, SEQ_HI, Math.min(1, m.otherPct / span)));
}

const marginLabel = m => (m >= 0 ? 'R+' : 'D+') + Math.abs(m).toFixed(1);

/* ----------------------------------------------------------------- boot */
async function init() {
  // The forward-looking panels load on their own so they still show even if the
  // historical datasets fail to load.
  initUpcoming();
  initRaces();
  try {
    const [data, geo] = await Promise.all([
      fetch('data/elections.json').then(r => { if (!r.ok) throw new Error('elections.json'); return r.json(); }),
      fetch('data/tx-counties-geo.json').then(r => { if (!r.ok) throw new Error('geo'); return r.json(); }),
    ]);
    state.data = data;
    state.geo = geo;
    state.year = data.meta.latestYear;
    $('#search').disabled = false;
    const openFips = applyHash();          // restore view from URL (#5)
    renderStatic();
    renderYearPicker();
    renderControls();
    renderAll();
    if (openFips) openCounty(openFips);    // map exists now, so the drawer can anchor
    window.addEventListener('hashchange', () => {
      // External hash changes (back/forward) — re-apply without feedback loop.
      applyingHash = true;
      const f = applyHash();
      renderYearPicker(); renderControls(); renderAll();
      f ? openCounty(f) : closeCounty();
      applyingHash = false;
    });
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
    b.addEventListener('click', () => { state.year = y; syncHash(); renderYearPicker(); renderAll(); });
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
  // Per-cycle scaling context for the sequential (turnout/other) metrics.
  const all = [...byFips.values()].map(v => v.m);
  const ctx = {
    minTurnout: Math.min(...all.map(m => m.total)),
    maxTurnout: Math.max(...all.map(m => m.total)),
    maxOther: Math.max(5, ...all.map(m => m.otherPct)),
  };

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  for (const county of state.geo.counties) {
    const info = byFips.get(county.fips);
    const fill = info ? colorForMetric(info.m, ctx) : '#2a3550';
    // Keyboard- and screen-reader-accessible: focusable, with a full label.
    const label = info
      ? `${info.name} County: ${marginLabel(info.m.marginPct)}, ` +
        `${fmt(info.m.gop)} Republican, ${fmt(info.m.dem)} Democratic, ${fmt(info.m.total)} total`
      : `${county.name} County: no data`;
    svg.appendChild(svgEl('path', {
      class: 'county' + (county.fips === state.county ? ' selected' : ''),
      d: pathFor(county, project), fill,
      'data-fips': county.fips, tabindex: '0', role: 'button', 'aria-label': label,
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
  // Touch (#8): tap a county to pin its tooltip and open the detail drawer.
  svg.addEventListener('touchstart', ev => {
    const path = ev.target.closest('path[data-fips]');
    const info = infoFor(path);
    if (!info) return;
    ev.preventDefault();
    const b = path.getBoundingClientRect();
    showTip(info, b.left + b.width / 2, b.top + b.height / 2);
    openCounty(path.getAttribute('data-fips'));
  }, { passive: false });
  // Click / Enter / Space: open the per-county detail drawer (#4).
  const activate = node => { const f = node && node.getAttribute('data-fips'); if (byFips.has(f)) openCounty(f); };
  svg.addEventListener('click', ev => activate(ev.target.closest('path[data-fips]')));
  svg.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(ev.target.closest('path[data-fips]')); }
  });

  renderMapLegend(ctx);
  const titles = { margin: 'county margin', turnout: 'county turnout', other: 'third-party share' };
  $('#mapTitle').textContent = `${state.year} ${titles[state.mapMetric]}`;
}

function renderMapLegend(ctx) {
  const legend = $('#mapLegend');
  legend.innerHTML = '';
  if (state.mapMetric === 'margin') {
    const grad = `linear-gradient(to right, ${colorForMargin(-40)}, ${colorForMargin(0)}, ${colorForMargin(40)})`;
    const p = PALETTES[state.palette] || PALETTES.rdbu;
    legend.appendChild(el('span', { text: `${p.demName.includes('Purple') ? 'D' : 'D'}+40` }));
    legend.appendChild(el('span', { class: 'bar', style: `background:${grad}` }));
    legend.appendChild(el('span', { text: 'R+40' }));
  } else {
    const grad = `linear-gradient(to right, ${rgb(SEQ_LO)}, ${rgb(SEQ_HI)})`;
    const lo = state.mapMetric === 'turnout' ? fmt(ctx.minTurnout) : '0%';
    const hi = state.mapMetric === 'turnout' ? fmt(ctx.maxTurnout) : pct(ctx.maxOther);
    legend.appendChild(el('span', { text: lo }));
    legend.appendChild(el('span', { class: 'bar', style: `background:${grad}` }));
    legend.appendChild(el('span', { text: hi }));
  }
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
      syncHash();
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
    const tr = el('tr', { class: 'row-clickable', tabindex: '0', 'data-fips': r.fips }, [
      el('td', { text: r.name }),
      el('td', { class: winCls, text: r.winner }),
      el('td', { text: fmt(r.gop) }),
      el('td', { text: pct(r.gopPct) }),
      el('td', { text: fmt(r.dem) }),
      el('td', { text: pct(r.demPct) }),
      el('td', { text: fmt(r.other) }),
      el('td', { text: fmt(r.total) }),
      el('td', { class: marCls, text: marginLabel(r.marginPct) }),
    ]);
    tr.addEventListener('click', () => openCounty(r.fips));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCounty(r.fips); }
    });
    body.appendChild(tr);
  }
  $('#tableCaption').textContent = `${rows.length} of ${state.data.meta.countyCount} counties · ${state.year}`;
}

/* ----------------------------------------------------------- county drawer (#4) */
// Per-county detail with a 2012–2024 margin sparkline. Pure front-end — the
// multi-cycle data is already in elections.json.
function countyByFips(fips) {
  return state.data.counties.find(c => c.fips === fips);
}

function openCounty(fips) {
  const c = countyByFips(fips);
  if (!c) return;
  state.county = fips;
  syncHash();
  document.querySelectorAll('#map .county').forEach(p =>
    p.classList.toggle('selected', p.getAttribute('data-fips') === fips));

  const years = state.data.meta.years;
  const series = years.map(y => (c.years[y] ? { year: y, ...metrics(c.years[y]) } : null)).filter(Boolean);
  const latest = series[series.length - 1];

  const body = el('div', {}, [
    el('div', { class: 'drawer-stat-row' }, [
      drawerStat('Margin', marginLabel(latest.marginPct), latest.winner === 'R' ? 'val-rep' : 'val-dem'),
      drawerStat('Republican', `${fmt(latest.gop)} (${pct(latest.gopPct)})`),
      drawerStat('Democratic', `${fmt(latest.dem)} (${pct(latest.demPct)})`),
      drawerStat('Total', fmt(latest.total)),
    ]),
    el('h4', { class: 'drawer-h', text: 'Margin by cycle' }),
    marginSparkline(series),
    el('div', { class: 'drawer-cycles' },
      series.map(s => el('div', { class: 'cyc' }, [
        el('span', { class: 'cyc-yr', text: String(s.year) }),
        el('span', { class: 'cyc-val ' + (s.marginPct >= 0 ? 'val-rep' : 'val-dem'), text: marginLabel(s.marginPct) }),
      ]))),
  ]);

  const drawer = $('#drawer');
  drawer.replaceChildren(
    el('div', { class: 'drawer-head' }, [
      el('div', {}, [
        el('div', { class: 'drawer-eyebrow', text: 'County detail' }),
        el('h3', { class: 'drawer-title', text: `${c.name} County` }),
      ]),
      (() => { const b = el('button', { class: 'drawer-close', type: 'button', 'aria-label': 'Close detail', text: '✕' });
        b.addEventListener('click', closeCounty); return b; })(),
    ]),
    body,
  );
  drawer.hidden = false;
  drawer.classList.add('open');
  const bd = $('#drawer-backdrop');
  if (bd) bd.classList.add('show');
}

function drawerStat(label, val, cls) {
  return el('div', { class: 'drawer-stat' }, [
    el('div', { class: 'ds-label', text: label }),
    el('div', { class: 'ds-val ' + (cls || ''), text: val }),
  ]);
}

function marginSparkline(series) {
  const W = 320, H = 90, pad = 18;
  const cap = Math.max(20, ...series.map(s => Math.abs(s.marginPct)));
  const x = i => pad + (series.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (series.length - 1));
  const y = m => H / 2 - (m / cap) * (H / 2 - pad);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sparkline', role: 'img', 'aria-label': 'Margin trend by cycle' });
  svg.appendChild(svgEl('line', { class: 'spark-zero', x1: pad, y1: y(0), x2: W - pad, y2: y(0) }));
  let d = '';
  series.forEach((s, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.marginPct).toFixed(1); });
  svg.appendChild(svgEl('path', { class: 'spark-line', d, fill: 'none' }));
  series.forEach((s, i) => svg.appendChild(svgEl('circle', {
    cx: x(i), cy: y(s.marginPct), r: 4, fill: colorForMargin(s.marginPct),
  })));
  return svg;
}

function closeCounty() {
  state.county = null;
  syncHash();
  const drawer = $('#drawer');
  drawer.hidden = true;
  drawer.classList.remove('open');
  const bd = $('#drawer-backdrop');
  if (bd) bd.classList.remove('show');
  document.querySelectorAll('#map .county.selected').forEach(p => p.classList.remove('selected'));
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

/* ----------------------------------------------------------- 2026 races */
// Client-facing panel for the 2026 Texas federal ballot. Incumbents/parties/
// districts are FACT (from congress-legislators); declared candidates + finance
// come from FEC only when enrichment has run, so the UI degrades gracefully:
// every race has a candidates[] hook that may be empty now and full later.
// Built entirely with el() (never innerHTML on data) for XSS-safety.
const racesState = { data: null, finance: null, filter: 'all' };

// Party metadata: class suffix for the pill, the short letter shown as TEXT
// (so the pill never relies on color alone), and a long name for aria-labels.
function partyMeta(party) {
  switch (party) {
    case 'R': return { cls: 'r', letter: 'R', name: 'Republican' };
    case 'D': return { cls: 'd', letter: 'D', name: 'Democratic' };
    case 'I': return { cls: 'i', letter: 'I', name: 'Independent' };
    default:  return { cls: 'open', letter: party || 'Open', name: party || 'Open seat' };
  }
}

function partyPill(party) {
  const m = partyMeta(party);
  return el('span', { class: 'party-pill ' + m.cls, 'aria-label': m.name, text: m.letter });
}

// Last word of a name (drops a trailing "Jr."/"Sr."/"III" suffix) for compact
// district cards. Falls back to the whole string when there's nothing to trim.
function surname(name) {
  if (!name) return '';
  const parts = String(name).replace(/,/g, '').trim().split(/\s+/);
  const suffixes = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);
  while (parts.length > 1 && suffixes.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts[parts.length - 1] || name;
}

const raceIsOpen = race => race.open === true || !race.incumbent;

// A race is expandable only when it actually has declared candidates to show.
const hasCandidates = race => Array.isArray(race.candidates) && race.candidates.length > 0;

async function initRaces() {
  let data;
  try {
    const r = await fetch('data/races-2026.json');
    if (!r.ok) throw new Error('races-2026.json');
    data = await r.json();
  } catch {
    return; // panel stays hidden; the rest of the board is unaffected
  }
  // Guard the shape so a wrong-shaped payload (e.g. a stubbed fetch) can never
  // render garbage or throw — the panel simply stays hidden.
  if (!data || !data.meta || !data.meta.counts || !Array.isArray(data.senate) || !Array.isArray(data.house)) return;
  racesState.data = data;
  // Finance history is optional — load it best-effort for the trend.
  try {
    const fr = await fetch('data/finance-history.json');
    if (fr.ok) racesState.finance = await fr.json();
  } catch { /* no history yet */ }
  renderRaces();
}

function renderRaces() {
  const host = $('#races2026');
  const data = racesState.data;
  if (!host || !data) return;
  const m = data.meta;
  const counts = m.counts || {};
  const byParty = counts.houseByParty || {};

  // Header: title, count subtitle, and the provenance note from the data so the
  // viewer can see incumbents are fact and candidates come from FEC.
  const senateN = counts.senate || 0;
  const houseN = counts.house || 0;
  const openN = byParty.Open || 0;
  const sub = [
    `${senateN} U.S. Senate ${senateN === 1 ? 'seat' : 'seats'}`,
    `${houseN} U.S. House ${houseN === 1 ? 'district' : 'districts'}`,
    `${openN} open`,
  ].join(' · ');

  const slN = (data.stateLocal || []).length;
  const subFull = slN ? `${sub} · ${slN} state & local offices` : sub;
  const head = el('div', { class: 'races-head' }, [
    el('div', {}, [
      el('div', { class: 'races-eyebrow', text: 'On the ballot' }),
      el('h2', { class: 'races-title', text: '2026 Texas Races' }),
      el('div', { class: 'races-sub', text: subFull }),
    ]),
  ]);
  if (m.dataNote) head.appendChild(el('p', { class: 'races-note', text: m.dataNote }));

  // Senate (prominent) — render each Senate race as a large card.
  const senateWrap = el('div', { class: 'senate-wrap' },
    data.senate.map(renderSenateCard));

  // House party-balance bar + legend.
  const balance = renderBalanceBar(byParty);

  // House filter (segmented control) + grid (re-rendered in place on filter).
  const filterBar = renderRaceFilter(byParty);
  const grid = el('div', { class: 'races-grid', id: 'racesGrid', role: 'list', 'aria-label': 'U.S. House districts' });

  const houseHead = el('div', { class: 'races-subhead' }, [
    el('h3', { class: 'races-h', text: 'U.S. House districts' }),
    filterBar,
  ]);

  const children = [head, senateWrap, el('div', { class: 'balance-block' }, [balance]), houseHead, grid];

  // State & local: offices on the ballot by term cycle (incumbents/candidates
  // null until enriched). Grouped, read-only — no invented names.
  if (slN) children.push(renderStateLocal(data.stateLocal));

  // Campaign finance: leaderboard + R-vs-D + trend. Empty-safe (shows a
  // "connect FEC" note until real finance exists).
  children.push(renderFinance(data, racesState.finance));

  host.replaceChildren(...children);
  host.hidden = false;
  renderHouseGrid(); // fills #racesGrid based on racesState.filter
}

// State & local offices, grouped (Statewide executive / Legislature / Judicial).
function renderStateLocal(rows) {
  const groups = [];
  for (const r of rows) {
    let g = groups.find(x => x.name === r.group);
    if (!g) { g = { name: r.group, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  const wrap = el('div', { class: 'statelocal' }, [
    el('h3', { class: 'races-h', text: 'State & local offices' }),
  ]);
  for (const g of groups) {
    const ul = el('ul', { class: 'sl-list' });
    for (const r of g.items) {
      const hasCands = (r.candidates || []).length > 0;
      ul.appendChild(el('li', { class: 'sl-row' }, [
        el('span', { class: 'sl-office', text: r.office }),
        el('span', { class: 'sl-scope', text: hasCands ? `${r.candidates.length} candidates` : (r.scopeNote || '') }),
      ]));
    }
    wrap.appendChild(el('div', { class: 'sl-group' }, [el('h4', { class: 'sl-group-h', text: g.name }), ul]));
  }
  wrap.appendChild(el('p', { class: 'races-note', text: 'Offices reflect Texas term cycles; incumbents and candidates load from FEC / Civic / Ballotpedia / TX SoS when connected. No names are shown until verified.' }));
  return wrap;
}

/* ----------------------------------------------------------- campaign finance */
const usd = n => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';          // FEC net figures can be negative (refunds)
  const a = Math.abs(v);
  if (a >= 999500) return sign + '$' + (a / 1e6).toFixed(1) + 'M';   // round into M at the boundary
  if (a >= 1000) return sign + '$' + Math.round(a / 1e3) + 'K';
  return sign + '$' + Math.round(a).toLocaleString('en-US');
};

// Finance view: pulls current finance from every race's candidates[], plus the
// dated history file for a trend. Renders empty-safe — until FEC data exists it
// shows a clear "connect FEC" note, never invented numbers.
function renderFinance(data, history) {
  const cands = [...data.senate, ...data.house, ...(data.stateLocal || [])]
    .flatMap(r => (r.candidates || []).map(c => ({ ...c, office: r.office, district: r.district })));
  const funded = cands.filter(c => c.finance && typeof c.finance.receipts === 'number');

  const wrap = el('div', { class: 'finance' }, [
    el('h3', { class: 'races-h', text: 'Campaign finance' }),
  ]);

  if (!funded.length) {
    wrap.appendChild(el('p', { class: 'cand-empty',
      text: 'No FEC finance yet. Add an FEC_API_KEY repository secret (or run scripts/enrich-races.mjs with a key) and this fills with real receipts, cash-on-hand, and a fundraising leaderboard — ranked, with an R-vs-D total and a trend over time.' }));
    return wrap;
  }

  // R-vs-D money bar.
  const byParty = {};
  for (const c of funded) { byParty[c.party] = (byParty[c.party] || 0) + (c.finance.receipts || 0); }
  const total = Object.values(byParty).reduce((a, b) => a + b, 0) || 1;
  const order = ['R', 'D'].concat(Object.keys(byParty).filter(p => !'RD'.includes(p)));
  const bar = el('div', { class: 'balance-bar', role: 'img',
    'aria-label': 'Total receipts by party: ' + order.map(p => `${p} ${usd(byParty[p] || 0)}`).join(', ') });
  for (const p of order) {
    if (!byParty[p]) continue;
    const seg = el('div', { class: 'balance-seg ' + (p === 'R' ? 'r' : p === 'D' ? 'd' : 'open') });
    seg.style.width = (100 * byParty[p] / total).toFixed(1) + '%';
    bar.appendChild(seg);
  }
  const legend = el('div', { class: 'balance-legend' },
    order.filter(p => byParty[p]).map(p => el('span', { class: 'balance-key' }, [
      el('span', { class: 'balance-dot ' + (p === 'R' ? 'r' : p === 'D' ? 'd' : 'open') }),
      el('span', { text: `${p}: ${usd(byParty[p])} raised` }),
    ])));
  wrap.append(
    el('div', { class: 'fin-summary' }, [
      el('span', { text: `${usd(total)} raised across ${funded.length} candidates` }),
    ]), bar, legend);

  // Leaderboard: top fundraisers.
  const top = funded.slice().sort((a, b) => (b.finance.receipts || 0) - (a.finance.receipts || 0)).slice(0, 8);
  const list = el('ol', { class: 'fin-board' });
  for (const c of top) {
    list.appendChild(el('li', { class: 'fin-row' }, [
      partyPill(c.party),
      el('span', { class: 'fin-name', text: c.name }),
      el('span', { class: 'fin-office', text: c.office === 'U.S. House' ? `TX-${c.district}` : c.office }),
      el('span', { class: 'fin-amt', text: usd(c.finance.receipts), title: 'Total receipts' }),
      el('span', { class: 'fin-coh', text: usd(c.finance.cashOnHand) + ' COH', title: 'Cash on hand' }),
    ]));
  }
  wrap.append(el('h4', { class: 'sl-group-h', text: 'Top fundraisers' }), list);

  // Trend over time (needs ≥2 dated snapshots with data).
  const snaps = ((history && history.snapshots) || []).filter(s => s.hasData);
  if (snaps.length >= 2) {
    wrap.append(el('h4', { class: 'sl-group-h', text: 'Total raised over time' }), financeTrend(snaps));
  } else if (history) {
    wrap.appendChild(el('p', { class: 'races-note',
      text: 'Trend appears once at least two dated snapshots exist — the scheduled refresh records one per run.' }));
  }
  return wrap;
}

function financeTrend(snaps) {
  const W = 520, H = 120, padL = 48, padR = 12, padT = 12, padB = 22;
  const max = Math.max(...snaps.map(s => s.totals.receipts)) || 1;
  const x = i => padL + (snaps.length === 1 ? 0 : i * (W - padL - padR) / (snaps.length - 1));
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fin-trend', role: 'img',
    'aria-label': 'Total receipts over time' });
  svg.appendChild(svgEl('line', { class: 'axis-line', x1: padL, y1: y(0), x2: W - padR, y2: y(0) }));
  let d = '';
  snaps.forEach((s, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.totals.receipts).toFixed(1); });
  svg.appendChild(svgEl('path', { class: 'spark-line', d, fill: 'none' }));
  snaps.forEach((s, i) => svg.appendChild(svgEl('circle', { cx: x(i), cy: y(s.totals.receipts), r: 3, fill: 'var(--accent)' })));
  svg.appendChild(Object.assign(svgEl('text', { class: 'axis-text', x: padL, y: H - 6 }), { textContent: snaps[0].date }));
  svg.appendChild(Object.assign(svgEl('text', { class: 'axis-text', x: W - padR, y: H - 6, 'text-anchor': 'end' }), { textContent: snaps.at(-1).date }));
  svg.appendChild(Object.assign(svgEl('text', { class: 'axis-text', x: padL - 6, y: y(max) + 4, 'text-anchor': 'end' }), { textContent: usd(max) }));
  return svg;
}

function renderSenateCard(race) {
  const open = raceIsOpen(race);
  const inc = race.incumbent;
  const party = open ? 'Open' : (inc && inc.party);

  const header = el('div', { class: 'senate-head' }, [
    el('div', {}, [
      el('div', { class: 'senate-office', text: race.office || 'U.S. Senate' }),
      race.seat ? el('div', { class: 'senate-seat', text: roman(race.seat) }) : null,
    ]),
    partyPill(party),
  ]);

  const incLine = open
    ? el('div', { class: 'senate-incumbent open', text: 'Open seat — no incumbent' })
    : el('div', { class: 'senate-incumbent' }, [
        el('span', { class: 'inc-label', text: 'Incumbent' }),
        el('span', { class: 'inc-name', text: inc.name }),
      ]);

  const card = el('div', { class: 'senate-card' + (open ? ' open' : ''), 'data-office': race.office || 'senate' },
    [header, incLine]);

  // Candidates block: real FEC rows when present, otherwise an honest muted note.
  card.appendChild(renderCandidateBlock(race));
  return card;
}

// Builds the candidate area for any race. When candidates[] is empty (now) it
// shows a muted "load from FEC" line; when populated (later) it lists each
// declared candidate with party + finance. Never errors on either shape.
function renderCandidateBlock(race) {
  if (!hasCandidates(race)) {
    return el('div', { class: 'cand-empty', text: 'Declared candidates load from FEC when connected.' });
  }
  const list = el('ul', { class: 'cand-list' });
  for (const c of race.candidates) {
    const name = c.name || c.candidate_name || 'Candidate';
    const row = el('li', { class: 'cand-row' }, [
      el('span', { class: 'cand-name' }, [
        partyPill(c.party),
        el('span', { text: name }),
      ]),
    ]);
    const fin = candidateFinance(c);
    if (fin) row.appendChild(el('span', { class: 'cand-finance', text: fin }));
    list.appendChild(row);
  }
  const src = race.candidatesSource;
  const block = el('div', { class: 'cand-block' }, [list]);
  if (src && src.name) {
    block.appendChild(el('div', { class: 'cand-source' }, [
      src.url
        ? el('a', { href: src.url, target: '_blank', rel: 'noopener', text: 'Source: ' + src.name })
        : el('span', { text: 'Source: ' + src.name }),
    ]));
  }
  return block;
}

// Formats receipts / cash-on-hand when present (tolerant of a few field names).
function candidateFinance(c) {
  const receipts = c.receipts ?? c.total_receipts;
  const cash = c.cash_on_hand ?? c.cash_on_hand_end_period ?? c.cashOnHand;
  const parts = [];
  if (Number.isFinite(Number(receipts)) && receipts != null) parts.push('$' + fmt(Math.round(Number(receipts))) + ' raised');
  if (Number.isFinite(Number(cash)) && cash != null) parts.push('$' + fmt(Math.round(Number(cash))) + ' cash');
  return parts.join(' · ');
}

function renderBalanceBar(byParty) {
  const r = byParty.R || 0, d = byParty.D || 0, open = byParty.Open || 0;
  const total = r + d + open || 1;
  const seg = (n, cls, label) => n > 0
    ? el('div', { class: 'balance-seg ' + cls, style: `width:${(n / total) * 100}%`, title: `${label}: ${n}` })
    : null;
  const bar = el('div', {
    class: 'balance-bar', role: 'img',
    'aria-label': `Current U.S. House delegation: ${r} Republican, ${d} Democratic, ${open} open`,
  }, [seg(r, 'r', 'Republican-held'), seg(d, 'd', 'Democratic-held'), seg(open, 'open', 'Open')]);

  const legendItem = (cls, label, n) => el('span', { class: 'balance-key' }, [
    el('span', { class: 'balance-dot ' + cls, 'aria-hidden': 'true' }),
    el('span', { text: `${label} ${n}` }),
  ]);
  const legend = el('div', { class: 'balance-legend' }, [
    legendItem('r', 'R-held', r),
    legendItem('d', 'D-held', d),
    legendItem('open', 'Open', open),
  ]);
  return el('div', {}, [
    el('div', { class: 'balance-caption muted', text: 'Current delegation (seats up in 2026)' }),
    bar, legend,
  ]);
}

function renderRaceFilter(byParty) {
  const r = byParty.R || 0, d = byParty.D || 0, open = byParty.Open || 0;
  const total = r + d + open;
  const options = [
    { val: 'all', label: `All (${total})` },
    { val: 'R', label: `R-held (${r})` },
    { val: 'D', label: `D-held (${d})` },
    { val: 'open', label: `Open (${open})` },
  ];
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter House districts' });
  for (const o of options) {
    const b = el('button', {
      class: 'seg-btn' + (o.val === racesState.filter ? ' active' : ''),
      type: 'button', 'aria-pressed': o.val === racesState.filter ? 'true' : 'false', text: o.label,
    });
    b.addEventListener('click', () => {
      if (racesState.filter === o.val) return;
      racesState.filter = o.val;
      // Re-render only the filter buttons' active state and the grid.
      seg.querySelectorAll('.seg-btn').forEach((btn, i) => {
        const active = options[i].val === o.val;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      renderHouseGrid();
    });
    seg.appendChild(b);
  }
  return seg;
}

function houseMatchesFilter(race) {
  const f = racesState.filter;
  if (f === 'all') return true;
  if (f === 'open') return raceIsOpen(race);
  if (raceIsOpen(race)) return false;
  return race.incumbent && race.incumbent.party === f;
}

function renderHouseGrid() {
  const grid = $('#racesGrid');
  const data = racesState.data;
  if (!grid || !data) return;
  const houses = [...data.house]
    .sort((a, b) => (a.district || 0) - (b.district || 0))
    .filter(houseMatchesFilter);

  const cards = houses.map(renderDistrictCard);
  if (cards.length === 0) {
    grid.replaceChildren(el('div', { class: 'races-empty muted', text: 'No districts match this filter.' }));
  } else {
    grid.replaceChildren(...cards);
  }
}

function renderDistrictCard(race) {
  const open = raceIsOpen(race);
  const label = `TX-${String(race.district).padStart(2, '0')}`;
  const expandable = hasCandidates(race);

  const top = el('div', { class: 'district-top' }, [
    el('span', { class: 'district-id', text: label }),
    partyPill(open ? 'Open' : race.incumbent.party),
  ]);
  const who = open
    ? el('div', { class: 'district-who open', text: 'OPEN SEAT' })
    : el('div', { class: 'district-who', text: surname(race.incumbent.name) });

  const children = [top, who];

  // Build an accessible aria-label that conveys everything color/abbreviation does.
  const ariaParts = [label.replace('-', ' '), open ? 'open seat, no incumbent'
    : `${partyMeta(race.incumbent.party).name} incumbent ${race.incumbent.name}`];

  let card;
  if (expandable) {
    // Expandable card: a single native <button> toggles a candidates panel. Using
    // a button (not a tabindex'd div wrapping interactive children) keeps axe happy
    // (no nested-interactive) and gives free keyboard support.
    const panel = el('div', { class: 'district-candidates', hidden: 'hidden' }, [renderCandidateBlock(race)]);
    const btn = el('button', {
      class: 'district-toggle', type: 'button',
      'aria-expanded': 'false',
      'aria-label': ariaParts.join(', ') + `, ${race.candidates.length} declared — show candidates`,
    }, [top, who, el('span', { class: 'district-caret', 'aria-hidden': 'true', text: '▾' })]);
    btn.addEventListener('click', () => {
      const openNow = panel.hasAttribute('hidden');
      if (openNow) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', 'hidden');
      btn.setAttribute('aria-expanded', openNow ? 'true' : 'false');
      card.classList.toggle('expanded', openNow);
    });
    card = el('div', { class: 'race-card district-card' + (open ? ' open' : '') + ' has-candidates', role: 'listitem' },
      [btn, panel]);
  } else {
    // Non-interactive card: a plain list item (no tabindex/role=button) so screen
    // readers don't announce a control that does nothing.
    card = el('div', {
      class: 'race-card district-card' + (open ? ' open' : ''),
      role: 'listitem', 'aria-label': ariaParts.join(', '),
    }, children);
  }
  return card;
}

// "Class 2" -> "Class II" for a more formal seat label; leaves other text alone.
function roman(seat) {
  const map = { '1': 'I', '2': 'II', '3': 'III' };
  return String(seat).replace(/\b([123])\b/, (_, n) => map[n] || n);
}

/* ----------------------------------------------------------- shareable state (#5) */
// Sync year / search / sort / palette / metric / open county to location.hash so
// views are bookmarkable and survive reload.
let applyingHash = false;
function syncHash() {
  if (applyingHash) return;
  const p = new URLSearchParams();
  if (state.year) p.set('year', state.year);
  if (state.query) p.set('q', state.query);
  if (state.sortKey !== 'name' || state.sortDir !== 1) p.set('sort', `${state.sortKey}:${state.sortDir}`);
  if (state.mapMetric !== 'margin') p.set('metric', state.mapMetric);
  if (state.palette !== 'rdbu') p.set('palette', state.palette);
  if (state.county) p.set('county', state.county);
  const h = p.toString();
  // Always update via the hash only (never reconstruct the path) so this works
  // under file://, sub-paths (GitHub Pages), and strict URL parsers.
  try { history.replaceState(null, '', '#' + h); }
  catch { location.hash = h; }
}

function applyHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const years = state.data.meta.years;
  const y = Number(p.get('year'));
  if (years.includes(y)) state.year = y;
  state.query = (p.get('q') || '').toLowerCase();
  if (p.get('sort')) {
    const [k, d] = p.get('sort').split(':');
    if (COLS.some(c => c.key === k)) { state.sortKey = k; state.sortDir = Number(d) === -1 ? -1 : 1; }
  }
  if (['turnout', 'other'].includes(p.get('metric'))) state.mapMetric = p.get('metric');
  if (PALETTES[p.get('palette')]) state.palette = p.get('palette');
  const search = $('#search');
  if (search) search.value = state.query;
  return p.get('county'); // applied after first render so the map exists
}

/* ----------------------------------------------------------- view controls (#6,#7) */
function renderControls() {
  const host = $('#mapControls');
  if (!host) return;
  host.innerHTML = '';
  const group = (label, current, options, onPick) => {
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const o of options) {
      const b = el('button', {
        class: 'seg-btn' + (o.val === current ? ' active' : ''),
        type: 'button', 'aria-pressed': o.val === current ? 'true' : 'false', text: o.label,
      });
      b.addEventListener('click', () => { onPick(o.val); });
      seg.appendChild(b);
    }
    return seg;
  };
  host.appendChild(group('Map metric', state.mapMetric, [
    { val: 'margin', label: 'Margin' }, { val: 'turnout', label: 'Turnout' }, { val: 'other', label: 'Other %' },
  ], v => { state.mapMetric = v; renderControls(); renderMap(); syncHash(); }));
  host.appendChild(group('Color palette', state.palette, [
    { val: 'rdbu', label: 'Red / Blue' }, { val: 'orpu', label: 'Color-blind' },
  ], v => { state.palette = v; renderControls(); renderMap(); renderTrend(); syncHash(); }));
}

// Disabled until init() loads data; the input handler guards on state.data too.
$('#search').disabled = true;
$('#search').addEventListener('input', e => {
  state.query = e.target.value.trim().toLowerCase();
  syncHash();
  renderTable();
});
$('#drawer-backdrop')?.addEventListener('click', closeCounty);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCounty(); });

init();
