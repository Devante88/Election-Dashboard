#!/usr/bin/env node
/**
 * Render docs/*.md into styled, standalone public/*.html for GitHub Pages.
 * ----------------------------------------------------------------------
 * Single source of truth is the Markdown in docs/. This emits committed HTML
 * into public/, which the Pages workflow copies verbatim — so the deploy needs
 * no build step or dependencies. Re-run after editing any doc:
 *
 *   node scripts/build-docs.mjs
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(ROOT, 'public');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const page = (title, bodyHtml) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(title)} — research brief." />
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
<style>
  :root { --bg:#0b1018; --panel:#0f1726; --border:#1f2b40; --text:#e9eef7; --muted:#93a1bd; --accent:#e7b53c; --link:#6fa8ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:16px/1.65 -apple-system,Segoe UI,Helvetica,Arial,sans-serif; }
  .topbar { border-bottom:1px solid var(--border); background:var(--panel); }
  .wrap { max-width:880px; margin:0 auto; padding:0 22px; }
  .topbar .wrap { display:flex; align-items:center; gap:10px; padding:14px 22px; }
  .star { color:var(--accent); }
  .topbar a { color:var(--muted); text-decoration:none; font-size:.9rem; margin-left:auto; }
  .topbar a:hover { color:var(--text); }
  main { padding:28px 0 64px; }
  h1 { font-size:1.9rem; line-height:1.2; margin:.2em 0 .5em; }
  h2 { font-size:1.35rem; margin:1.8em 0 .5em; padding-top:.4em; border-top:1px solid var(--border); }
  h3 { font-size:1.1rem; margin:1.4em 0 .4em; color:#cdd8ee; }
  h4 { font-size:.95rem; margin:1.1em 0 .3em; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  a { color:var(--link); }
  blockquote { margin:1em 0; padding:.6em 1em; border-left:3px solid var(--accent);
    background:rgba(231,181,60,.06); color:#d7def0; border-radius:0 8px 8px 0; }
  blockquote p { margin:.3em 0; }
  table { border-collapse:collapse; width:100%; margin:1em 0; font-size:.92rem; }
  th, td { border:1px solid var(--border); padding:7px 10px; text-align:left; vertical-align:top; }
  th { background:#13203a; }
  tr:nth-child(even) td { background:rgba(255,255,255,.02); }
  code { background:#0c1322; border:1px solid var(--border); border-radius:4px; padding:.1em .35em; font-size:.9em; }
  hr { border:0; border-top:1px solid var(--border); margin:2em 0; }
  ul, ol { padding-left:1.3em; }
  li { margin:.2em 0; }
  .meta { color:var(--muted); font-size:.85rem; margin-top:8px; }
</style>
</head>
<body>
  <div class="topbar"><div class="wrap" style="max-width:880px">
    <span class="star" aria-hidden="true">★</span><strong>Research</strong>
    <a href="../index.html">← Election dashboard</a>
  </div></div>
  <main class="wrap">
${bodyHtml}
    <p class="meta">Rendered from the project's <code>docs/</code> Markdown · point-in-time research, re-verify before use.</p>
  </main>
</body>
</html>
`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const files = (await readdir(DOCS)).filter(f => f.endsWith('.md'));
  if (!files.length) { console.log('No docs/*.md to build.'); return; }
  const index = [];
  for (const f of files) {
    const md = await readFile(path.join(DOCS, f), 'utf8');
    const title = (md.match(/^#\s+(.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim();
    const html = page(title, marked.parse(md, { gfm: true }));
    const out = f.replace(/\.md$/, '.html');
    await writeFile(path.join(OUT, out), html);
    index.push({ title, out });
    console.log(`  ${f} -> public/${out}  (${html.length} bytes)`);
  }
  // Lightweight index so /public/ has a landing page.
  const list = index.map(i => `<li><a href="${i.out}">${esc(i.title)}</a></li>`).join('\n');
  await writeFile(path.join(OUT, 'index.html'),
    page('Research', `<h1>Research briefs</h1>\n<ul>\n${list}\n</ul>`));
  console.log(`  built public/index.html (${index.length} doc(s))`);
}

main().catch(e => { console.error(e); process.exit(1); });
