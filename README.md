# Texas Election Watch Board

A self-contained dashboard of **real county-level Texas presidential election results (2012–2024)**.
No build step, no runtime dependencies — pure HTML/CSS/vanilla JS with hand-drawn SVG charts and an
SVG county map. Data is fetched once by a reproducible script and committed as JSON.

![counties](https://img.shields.io/badge/counties-254-blue) ![cycles](https://img.shields.io/badge/cycles-2012%E2%80%932024-red) ![time](https://img.shields.io/badge/times-Central-orange)

## What it shows

- **Statewide summary** for the selected cycle — winner, electoral votes, R/D vote share, margin, total ballots.
- **Statewide trend** — two-party vote share and margin across 2012, 2016, 2020, 2024.
- **Upcoming election** — a live countdown to the next Texas general election (Nov 3, 2026), statutory key dates, and offices on the ballot by term cycle. No candidates, no predictions.
- **County choropleth map** — all 254 Texas counties. Recolor by **margin, turnout, or third-party share**, in a default red/blue or a **color-blind-safe** orange/purple palette. Every county is **keyboard-focusable** (Tab) and labeled for screen readers; detail shows on hover, keyboard focus, **and touch**.
- **County detail drawer** — click/tap/Enter any county (on the map or in the table) for its **2012–2024 margin sparkline** and per-cycle numbers.
- **Statewide trend, summary, highlights** — vote share & margin across cycles; closest races, largest R/D margins, highest turnout, biggest swing.
- **County results table** — sortable and searchable across every county.
- **Shareable views** — the selected year, search, sort, map metric, palette, and open county are encoded in the URL (`#year=2020&metric=turnout&county=48201`), so any view is bookmarkable and survives reload.

Switch cycles with the year picker in the header; every panel updates.

Accessibility & robustness: the map is keyboard-, touch-, and screen-reader-accessible, with a color-blind-safe palette; the trend axis scales to the data (no cycle can overflow); tooltips/drawer are built from DOM nodes (not `innerHTML`), so data can't inject markup; and `npm run validate` runs an **axe-core** audit that fails on serious/critical violations.

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

- Statewide figures are **summed from the 254 county returns**, so the map, table, and headline cards are always internally consistent. The builder **fails** rather than ship data if it can't assemble all 254 counties × 4 cycles, and the CSV parser rejects malformed rows instead of silently zero-filling.
- `Other = total − (Republican + Democratic)`.
- These are tabulations from public sources and may differ slightly from the final Texas Secretary of State canvass. `scripts/validate.mjs` cross-checks the computed statewide totals against published official figures on every run. **2012 & 2016 are independent checks** (a different source than the build input, so they can catch a regression); **2020 & 2024 share their source with the build input**, so those rows are labeled `provenance` — confirmation, not independent proof.
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

A scheduled GitHub Action (`.github/workflows/refresh-data.yml`) re-runs this weekly and opens a PR
**only when the data changes** — it never commits to `main` directly.

Regenerate the social-share image after a data change:

```bash
node scripts/make-og-image.mjs   # writes assets/og-image.png
```

## 2026 races — real data, and how to get the *live* layer

`data/races-2026.json` is the forward-looking battlefield for working campaigns. It is built in two
layers, and **no candidate, poll, or dollar figure is ever invented**:

```bash
node scripts/build-races.mjs     # layer 1: incumbents (FACT)
node scripts/enrich-races.mjs    # layer 2: declared candidates + finance (LIVE, key-gated)
```

- **Layer 1 — incumbents (works anywhere, including offline):** current officeholder, party, district,
  and FEC id for the 2026 ballot — the Class II U.S. Senate seat and all 38 U.S. House districts,
  including any **vacant/open** seat — from
  [`unitedstates/congress-legislators`](https://github.com/unitedstates/congress-legislators).
- **Layer 2 — live candidates & campaign finance:** declared candidates with receipts / cash-on-hand
  from the **[FEC OpenFEC API](https://api.open.fec.gov/developers/)** (and optionally Google Civic).
  This step is **key-gated and network-gated**: with no key, or on a network that blocks the API, it
  records *why* in `meta.enrichment` and leaves `candidates[]` empty — it never fabricates.

```bash
# get a free key at https://api.open.fec.gov/developers/
FEC_API_KEY=xxxx CIVIC_API_KEY=yyyy node scripts/enrich-races.mjs
```

> **Network note.** Some managed/sandboxed environments allow only GitHub egress, so the FEC/Civic/
> Census/SoS hosts return 403 there. That is an environment **network policy**, not a bug — run the
> enrichment where the internet is open: locally, or via the included GitHub Action
> (`.github/workflows/refresh-races.yml`) with `FEC_API_KEY`/`CIVIC_API_KEY` stored as repo secrets.
> The Action runs on GitHub's open network and opens a PR when the race data changes.

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
assets/app.js               # rendering: upcoming, summary, trend, map, drawer, highlights, table
assets/favicon.svg          # brand favicon
assets/og-image.png         # generated social-share card
data/elections.json         # statewide history + per-county results, 2012–2024
data/upcoming.json          # next election: date, key dates, offices (statute facts)
data/tx-counties-geo.json   # simplified Texas county geometry for the map
scripts/build-data.mjs      # reproducible data builder (cited sources, Central-time stamp)
scripts/make-og-image.mjs   # render the share card from the live map
scripts/validate.mjs        # invariants + official cross-check + render check + axe audit
```

## Roadmap

- **Non-presidential races** (U.S. Senate, Governor) by county: the data model is keyed by
  year/office-ready, but this needs *verified* county-level returns for those races. It is
  intentionally **not** populated with placeholder numbers — the project's rule is no invented data.

## Disclaimer

This is an independent data-visualization project for informational purposes. Always treat the
**Texas Secretary of State** canvass as the authoritative source for official results. The
upcoming-election panel lists statutory dates and offices by term cycle only — **no candidates and
no predictions**; verify specifics at the [Texas SoS](https://www.sos.texas.gov/elections/index.shtml)
and [VoteTexas.gov](https://www.votetexas.gov/).
