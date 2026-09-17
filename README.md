# iPhone price matrix

Local Playwright crawler for refurbished iPhone configuration prices across multiple UK retailers.

Sites:

- **Back Market** — iPhone 13/14/15 and their Pro variants, configured via the on-page configurator (Condition → Battery → Storage → SIM type → Colour).
- **Amazon.co.uk** — specific iPhone models and storage sizes via product pages.
- **Refurbed.co.uk** — iPhone 13/14/15 and Pro variants.
- **musicMagpie.co.uk** — iPhone models via category search pages.

At each Back Market branch the crawler first inventories the radios that are actually listed for the current parent path (`input[name=step-…]` values), then clicks only those options. It does not assume a global matrix of storage/SIM/colour.

Condition → Battery → Storage → SIM type → Colour

and writes one CSV row per real configuration. Changing a parent control resets children, so the crawler never moves up until the branch below it is finished.

## Setup (host)

Requires Node ≥ 20.

```bash
npm install
npx playwright install chromium
```

Or use Docker (environment is baked into the image; you just mount `data/` and `config/`):

```bash
docker build -t iphone-price-matrix .
docker compose run --rm crawler --help
```

## Running directly on the host

The crawler launches a real Chrome window by default. Back Market blocks headless browsers (HTTP 403), so headed is the default and the approach that works.

Calibrate (dumps live option labels, no matrix):

```bash
npm run calibrate -- --model iphone-15
```

Crawl one model (resume-safe):

```bash
npm run crawl -- --model iphone-15
```

Keep it alive across crashes (heartbeat + restart + skip-list):

```bash
npm run watch -- --model iphone-15
```

Value ranking is optional and not part of a crawl:

```bash
npm run report -- --model iphone-15
```

Smoke test (stop after 8 rows):

```bash
npm run crawl -- --model iphone-15 --max-rows 8
```

All six Back Market iPhone pages:

```bash
npm run crawl -- --all
```

Rebuild the markdown report from an existing CSV/JSONL file:

```bash
npm run report -- --model iphone-15
```

Full refresh of all sites (one script, not a single CLI command):

```bash
node full-refresh.cjs
```

## Running inside Docker

```bash
docker build -t iphone-price-matrix .
docker compose run --rm crawler crawl --model iphone-15
docker compose run --rm crawler crawl --site "Back Market" --all
docker compose run --rm crawler watch --model iphone-15
```

Mounts:

- `./data` → `/app/data` — scraped data (JSONL, CSV, logs) and the Chrome profile. Persist this across runs so the profile trust is retained.
- `./config` → `/app/config` — model configuration (public product URLs).

Important:

- The Docker image defaults to the same headed Chrome as the host. A container has no display by default, so headed Chrome inside the container will not render to your desktop. To run inside Docker you either:
  - pass `--headless` and test whether your target site allows it (Back Market currently returns 403 to headless), or
  - set up Xvfb / VNC inside the container, or
  - run the same commands directly on the host when you need a real Chrome window.
- Back Market blocks headless browsers and often shows a short bot check on first run. The crawler reuses `data/.chrome-profile` so later runs usually skip that check. If you mount an existing `data/` folder that already contains a trusted `.chrome-profile`, that trust carries over. Without it, expect a bot check on first run.
- The image does not bake in `data/` or `config/` — these are mounted at runtime because they're user-specific or change over time.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model` | required unless `--all` | model id from `config/models.json` |
| `--site` | required when multiple sites are configured | site id, e.g. `Back Market`, `Amazon.co.uk`, `Refurbed.co.uk`, `musicMagPie` |
| `--all` | off | crawl every model for the chosen site |
| `--headed` | on | show Chrome. Back Market blocks headless (403), so this is the default |
| `--headless` | off | force headless; expected to fail on Back Market |
| `--max-rows` | none | stop after N saved rows (useful for a first watch) |
## Flag reference (per-site models)

Back Market models: `iphone-15`, `iphone-13`, `iphone-14`, `iphone-15-pro`, `iphone-14-pro`, `iphone-13-pro`

Amazon.co.uk models: `amazon-14-128`, `amazon-14-256`, `amazon-14-512`, `amazon-15-128`, `amazon-15-256`, `amazon-15-512`, `amazon-13-128`, `amazon-13-256`, `amazon-13-512`, `amazon-13-pro-128`, `amazon-13-pro-256`, `amazon-13-pro-512`

Refurbed.co.uk models: `iphone-13`, `iphone-13-pro`, `iphone-14`, `iphone-14-pro`, `iphone-15`, `iphone-15-pro`

musicMagPie models: `iphone-13`, `iphone-14`, `iphone-15`, `iphone-13-pro`, `iphone-14-pro`, `iphone-15-pro`, `iphone-13-pro-max`, `iphone-14-pro-max`, `iphone-15-pro-max`

## What it will not do

- Log in, add to cart, or check out
- Invent combinations the page does not list
- Continue if the host is not the configured origin or the currency is not GBP

A Chrome window will open when running headed. Back Market blocks headless browsers and often shows a short bot check on the first run — complete the checkbox if it appears. The crawler reuses `data/.chrome-profile` so later runs usually skip that check.
| `--delay` | 450 | milliseconds to wait after each selection |
| `--no-resume` | off | ignore the existing JSONL file and recapture (still appends; delete `data/*.jsonl` to start clean) |
| `--concurrency` | 1 | parallel workers for `--all` (Back Market only; shared Chrome context) |

## Outputs

Outputs land in `data/`:

- `backmarket-{model}.jsonl` — source of truth, one object per line
- `backmarket-{model}.csv`
- `backmarket-{model}-clean.csv` — cleaned, deduplicated, sorted (built by `npm run clean`)
- `backmarket-{model}-coverage.log` — missing/unavailable branches
- `heal-state.json` — skip-list and crash signatures (used by `watch`)
- `.heartbeat.json` — supervisor liveness (used by `watch`)
- `iphone-dashboard.html` — self-contained interactive dashboard over all clean CSVs (built by `npm run dashboard`)
