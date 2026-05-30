---
name: run-election-dashboard
description: >-
  Run, serve, smoke-test, or screenshot the Texas Election Watch Board — a
  static web dashboard of county-level Texas presidential results. Use when
  asked to run/start/launch/preview/serve/screenshot the election dashboard,
  or to drive/verify it headlessly. There is no browser in this container, so
  the driver runs the real app.js in jsdom and rasterizes the map with resvg.
---

# Run: Texas Election Watch Board

A dependency-free static web app (`index.html` + `assets/app.js` + committed
`data/*.json`). **There is no browser in this container and none is
installable** (Playwright CDN → 403, Google storage → 400, no system chromium),
so `chromium-cli` won't work. The driver instead serves the site, runs the
**real `assets/app.js` in jsdom** against the live server, drives it with real
DOM events, and rasterizes the SVG county map to a PNG with **resvg**.

All paths below are relative to the repo root (`<unit>/`). The driver lives at
`.claude/skills/run-election-dashboard/driver.mjs`.

## Prerequisites

Node.js (tested v22) and Python 3 (tested 3.11) — both preinstalled here; **no
`apt-get` was needed**. The driver's dev tools (`jsdom`, `@resvg/resvg-js`)
ship as prebuilt npm packages with no system libraries:

```bash
npm install
```

## Build

None — it's a static site with committed data. `npm install` (above) is the
only setup. To refresh the data offline from the local cache:

```bash
USE_CACHE=1 node scripts/build-data.mjs
```

## Run (agent path) — START HERE

One command builds nothing, serves the app, drives it, and screenshots it:

```bash
npm run smoke
# identical to: node .claude/skills/run-election-dashboard/driver.mjs
```

It prints `PASS`/`FAIL` lines for the HTTP surface, the initial render (4 cards,
254 map paths, 254 table rows, Central-time footer), and interaction probes
(hover tooltip, search filter, sort), then writes screenshots and exits `0` on
success. Screenshots land in `/tmp/run-election-dashboard/`:

- `tx_map_2024.png` — 2024 county margin map
- `tx_map_2020.png` — 2020 county margin map

Options: `--port=8011`, `--out=<dir>`.

To keep it up and poke it yourself (curl, etc.):

```bash
node .claude/skills/run-election-dashboard/driver.mjs serve --port=8012
curl -s http://127.0.0.1:8012/data/elections.json | head -c 200
```

## Run (human path)

```bash
npm run serve        # python3 -m http.server 8000
# open http://localhost:8000/
```

Headless this is only useful via `curl` (there's no display). Use the agent
path for actual rendering/screenshots.

## Verify the data / logic

```bash
npm run validate     # data invariants + cross-check vs official canvass + jsdom render check
```

## Gotchas

- **No browser, by design.** `chromium-cli`/Playwright/Puppeteer all fail here
  (CDNs blocked, no system chromium). The driver = jsdom (runs the real client
  entry point) + resvg (rasterizes the SVG map). This verifies DOM behavior and
  the **map's** pixels, but **not** HTML/CSS layout/paint (card styling,
  responsive breakpoints) — those are unverified headless.
- **Only the map rasterizes.** County fills are inline `fill` attributes, so
  resvg renders them. The trend-chart bars are colored via CSS classes, which
  resvg can't see — that's why the driver screenshots `#map`, not the whole page.
- **Run the driver from inside the repo.** `jsdom`/`@resvg/resvg-js` resolve via
  `node_modules` walked up from the script's location. A copy run from `/tmp`
  fails with `ERR_MODULE_NOT_FOUND`.
- **The app needs HTTP.** It `fetch`es its JSON, so `file://` trips CORS and
  shows the in-app "serve over HTTP" error. `npm run smoke`/`serve` handle this.
- **Killing the background server reports exit 144.** That's the `kill`/SIGTERM,
  not a failure — the `curl` that ran before the kill is the real signal.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find package '@resvg/resvg-js'` / `jsdom` | `npm install`, and run the driver from inside the repo (not `/tmp`). |
| `server not ready at http://127.0.0.1:8011/` | Port busy — rerun with `--port=<free port>`. |
| Page/driver shows "Could not load election data" | Data missing/stale — `USE_CACHE=1 node scripts/build-data.mjs`. |
