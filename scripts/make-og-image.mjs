#!/usr/bin/env node
/**
 * Generate assets/og-image.png — the social-share card (#10).
 * Renders the latest-cycle county map (the real app output) to a 1200x630 PNG
 * via the same jsdom + resvg path the run driver uses. No new data.
 *
 * Usage: node scripts/make-og-image.mjs   (needs `npm install` for jsdom/resvg)
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 1200, H = 630;

const { JSDOM } = await import('jsdom');
const { Resvg } = await import('@resvg/resvg-js');

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = await readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
const elections = JSON.parse(await readFile(path.join(ROOT, 'data/elections.json'), 'utf8'));
const geo = JSON.parse(await readFile(path.join(ROOT, 'data/tx-counties-geo.json'), 'utf8'));
const upcoming = JSON.parse(await readFile(path.join(ROOT, 'data/upcoming.json'), 'utf8'));

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.fetch = async u => ({ ok: true, json: async () => (u.includes('upcoming') ? upcoming : u.includes('geo') ? geo : elections) });
window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 700 });
window.eval(appSrc);
await new Promise(r => setTimeout(r, 150));

const doc = window.document;
const mapSvg = doc.querySelector('#map svg');
if (!mapSvg) { console.error('map did not render'); process.exit(1); }

const NS = 'http://www.w3.org/2000/svg';
const svg = doc.createElementNS(NS, 'svg');
svg.setAttribute('xmlns', NS);
svg.setAttribute('width', String(W));
svg.setAttribute('height', String(H));
svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

const rect = (x, y, w, h, fill) => { const r = doc.createElementNS(NS, 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h); r.setAttribute('fill', fill); return r; };
const text = (x, y, s, size, fill, weight) => { const t = doc.createElementNS(NS, 'text'); t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('font-size', size); t.setAttribute('fill', fill); t.setAttribute('font-family', 'Segoe UI, Helvetica, Arial, sans-serif'); if (weight) t.setAttribute('font-weight', weight); t.textContent = s; return t; };

svg.appendChild(rect(0, 0, W, H, '#0d1320'));
svg.appendChild(rect(0, 0, W, 6, '#e7b53c'));

// Map on the right, sized to fit.
const g = doc.createElementNS(NS, 'g');
const scale = (H - 60) / 760;
g.setAttribute('transform', `translate(${W - 820 * scale - 30}, 30) scale(${scale})`);
for (const p of mapSvg.querySelectorAll('path[data-fips]')) {
  const np = doc.createElementNS(NS, 'path');
  np.setAttribute('d', p.getAttribute('d'));
  np.setAttribute('fill', p.getAttribute('fill'));
  np.setAttribute('stroke', '#0d1320');
  np.setAttribute('stroke-width', '0.5');
  g.appendChild(np);
}
svg.appendChild(g);

// Text block on the left.
svg.appendChild(text(60, 150, '★ Texas Election', 64, '#e7b53c', '700'));
svg.appendChild(text(60, 220, 'Watch Board', 64, '#e9eef7', '700'));
svg.appendChild(text(62, 300, 'County-level presidential results', 30, '#93a1bd'));
svg.appendChild(text(62, 342, '2012 – 2024', 30, '#93a1bd'));
const s2024 = elections.statewide.find(s => s.year === 2024);
if (s2024) {
  svg.appendChild(text(62, 430, '2024 statewide', 24, '#6f7e9c'));
  svg.appendChild(text(62, 472, `R ${s2024.gopPct.toFixed(1)}%  ·  D ${s2024.demPct.toFixed(1)}%`, 34, '#e9eef7', '700'));
}
svg.appendChild(text(62, 560, 'Live countdown to the 2026 general election', 24, '#93a1bd'));

const png = new Resvg(svg.outerHTML, { background: '#0d1320', fitTo: { mode: 'width', value: W } }).render().asPng();
await writeFile(path.join(ROOT, 'assets/og-image.png'), png);
console.log(`Wrote assets/og-image.png (${png.length} bytes)`);
