# Texas Election Watch Board

A self-contained dashboard of **real county-level Texas presidential election results (2012–2024)**.
No build step, no runtime dependencies — pure HTML/CSS/vanilla JS with hand-drawn SVG charts and an
SVG county map. Data is fetched once by a reproducible script and committed as JSON.

![counties](https://img.shields.io/badge/counties-254-blue) ![cycles](https://img.shields.io/badge/cycles-2012%E2%80%932024-red) ![time](https://img.shields.io/badge/times-Central-orange)

## What it shows

- **Statewide summary** for the selected cycle — winner, electoral votes, R/D vote share, margin, total ballots.
- **Statewide trend** — two-party vote share and margin across 2012, 2016, 2020, 2024.
- **County choropleth map** — all 254 Texas counties shaded by margin, with hover detail.
- **Highlights** — closest races, largest R/D margins, highest turnout, and the biggest swing vs. the prior cycle.
- **County results table** — sortable and searchable across every county.

Switch cycles with the year picker in the header; every panel updates.

## The data is real

All numbers are derived from public datasets — **no vote totals are invented**:

| Source | Used for |
| --- | --- |
| [`tonmcg/US_County_Level_Election_Results_08-24`](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) | County-level presidential returns (2012–2024), compiled from official state/county canvasses and major-network tabulations. |
| [`plotly/datasets` — `geojson-counties-fips.json`](https://github.com/plotly/datasets) | U.S. Census cartographic county boundaries, filtered to Texas (FIPS `48xxx`). |

Statewide figures computed by this project vs. the published official canvass:

| Cycle | Computed R / D | Official R / D | Winner |
| --- | --- | --- | --- |
| 2012 | 4,555,799 / 3,294,440 | 4,569,843 / 3,308,124 | R +15.8 |
| 2016 | 4,681,590 / 3,867,816 | 4,685,047 / 3,877,868 | R +9.1 |
| 2020 | 5,890,347 / 5,259,126 | 5,890,347 / 5,259,126 | R +5.6 |
| 2024 | 6,393,597 / 4,835,250 | 6,393,597 / 4,835,250 | R +13.7 |

Methodology notes:

- Statewide figures are **summed from the 254 county returns**, so the map, table, and headline cards are always internally consistent.
- `Other = total − (Republican + Democratic)`.
- These are tabulations from public sources and may differ slightly from the final Texas Secretary of State canvass. `scripts/validate.mjs` cross-checks the computed statewide totals against the published official figures (within tolerance) on every run.
- **All timestamps are U.S. Central Time (`America/Chicago`)** — Texas's time zone. The "Generated" stamp in the footer carries an explicit `CDT`/`CST` label.

## View it

It's a static site. Serve the folder over HTTP (the page loads JSON via `fetch`, which browsers block on `file://`):

```bash
python3 -m http.server 8000      # or: npm run serve
# then open http://localhost:8000/
```

Or publish the repo with **GitHub Pages** (Settings → Pages → deploy from branch, root) — no configuration needed.

## Refresh the data

```bash
node scripts/build-data.mjs            # fetch latest from the sources above
USE_CACHE=1 node scripts/build-data.mjs # offline, from scripts/.cache
```

This regenerates `data/elections.json` and `data/tx-counties-geo.json`, stamps the build time in
**Central Time**, and prints the statewide totals so you can eyeball them against the official canvass.

## Validate

```bash
npm install      # dev-only: jsdom, for the render check
npm run validate
```

`scripts/validate.mjs` checks data invariants (254 counties × 4 cycles, statewide = sum of counties,
percentages in range, every mapped county has results, timestamp is Central), compares statewide
totals to published official figures, and — if `jsdom` is installed — renders the page in a headless
DOM to confirm the cards, trend chart, map (254 paths), highlights, and table all populate.

## Project structure

```
index.html                  # markup
assets/styles.css           # styling (dark "ops board" theme)
assets/app.js               # rendering: summary, trend, map, highlights, table
data/elections.json         # statewide history + per-county results, 2012–2024
data/tx-counties-geo.json   # simplified Texas county geometry for the map
scripts/build-data.mjs      # reproducible data builder (cited sources, Central-time stamp)
scripts/validate.mjs        # data invariants + official cross-check + render check
```

## Disclaimer

This is an independent data-visualization project for informational purposes. Always treat the
**Texas Secretary of State** canvass as the authoritative source for official results.
