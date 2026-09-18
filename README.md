# iPhone price matrix

Local Playwright crawler for refurbished iPhone and MacBook configuration prices across multiple UK retailers.

Sites:

- **Back Market** — iPhone 13/14/15 and their Pro variants, configured via the on-page configurator (Condition → Battery → Storage → SIM type → Colour). Also the MacBook Pro M1 page, whose configurator groups are Screen size → Condition → Chip → Memory → Storage → Colour.
- **Amazon.co.uk** — specific iPhone models and storage sizes via product pages, plus the MacBook Pro M1 via a search-URL matrix (see flag reference below).
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

## Running on a different laptop

The repo contains everything needed to run — code, `config/models.json`, Docker files. Only the *outputs* (`data/`) are machine-local and intentionally not on GitHub; a fresh clone rebuilds them from live sites.

Prerequisites: Node ≥ 20 and Git.

```bash
git clone https://github.com/jeffhammock-art/iphone-price-matrix.git
cd iphone-price-matrix
npm install
npm run playwright:install
```

No API keys or `.env` — site config is committed, so all sites and models work immediately.

Standard cycle (MacBooks shown; swap `--model`/`--site` for iPhones):

```bash
npm run crawl -- --site "Back Market" --model macbook-pro-m1
npm run crawl -- --site "Amazon.co.uk" --model macbook-pro-m1

npm run clean -- --site "Back Market" --model macbook-pro-m1
npm run clean -- --site "Amazon.co.uk" --model macbook-pro-m1
npm run dashboard
```

Then open `data/iphone-dashboard.html` by double-clicking it (file:// works), or use `npm run dashboard:serve` for a dev server with a Refresh button.

Expect a **cold Chrome profile** on a fresh machine — the aged, trusted `data/.chrome-profile` is machine-local by design:

- Run headed (the default; do not pass `--headless`) and complete any bot-check checkbox that appears in the Chrome window. Trust builds over the first few sessions and then holds.
- Back Market may return 403s or interstitials on early runs; the crawler's backoff/cooldown machinery handles it — wait out any cooldown message and re-run the same command.
- Amazon's MacBook search matrix retries each search up to 3 times and aborts cleanly (exit code 2) if blocking persists.
- Re-runs are resume-safe by default: configurations already saved in `data/*.jsonl` are skipped, so a partial run just needs the same command again.

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

Docker gives you a portable, reproducible environment (same Node version, Playwright, Chromium) so the crawler behaves the same on any machine. The image does **not** bake in `data/` or `config/` — those are mounted at runtime.

**Keeping the headed option is the point.** The crawler is designed to run headed (a real Chrome window), because Back Market blocks headless browsers (HTTP 403). Docker does **not** change that — the whole point is you can keep running headed.

On Windows with Docker Desktop, a Linux container does **not** have access to your Windows desktop display. That means:

- you cannot run the crawler headed inside Docker on Windows and see a Chrome window on your desktop. The container cannot open a window on the host.
- if you run the crawler headed inside Docker, the browser starts but no window appears, and pages that need a real browser context (Back Market) will not behave as expected.

So Docker here is about portability and environment — same tools, same version, same Chromium build on another machine — not about changing the headed/headless tradeoff. To actually use the headed option you need a machine that can show a Chrome window, and on that machine you run headed (either directly on the host, or inside Docker with a display set up inside the container — optional, not part of normal use).

The practical options:

- **On your current machine (or any machine with a display):** run the crawler directly on the host, not inside Docker. `npm run crawl -- --model iphone-15` opens a real Chrome window and works with Back Market.
- **On another machine with a display:** use the Docker image for a reproducible environment, then run headed on that machine (outside Docker, or with a display inside the container). Docker gets you the same environment; the machine's display gets you the headed option.
- **On a machine without a display (or in Docker without a display):** you lose the headed option. Docker does not provide a display — you still need a machine with a display and either run headed outside Docker, or set up a display inside the container.

```bash
# Build the image
docker build -t iphone-price-matrix .

# Run with Docker (mounts your data/ and config/)
docker compose run --rm crawler crawl --model iphone-15
docker compose run --rm crawler crawl --site "Back Market" --all
docker compose run --rm crawler watch --model iphone-15
```

Mounts:

- `./data` → `/app/data` — scraped data (JSONL, CSV, logs) and the Chrome profile. Persist this across runs so the profile trust is retained.
- `./config` → `/app/config` — model configuration (public product URLs).

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
| `--delay` | 450 | milliseconds to wait after each selection |
| `--no-resume` | off | ignore the existing JSONL file and recapture (still appends; delete `data/*.jsonl` to start clean) |
| `--concurrency` | 1 | parallel workers for `--all` (Back Market only; shared Chrome context) |

## Flag reference (per-site models)

Back Market models: `iphone-15`, `iphone-13`, `iphone-14`, `iphone-15-pro`, `iphone-14-pro`, `iphone-13-pro`, `macbook-pro-m1`

The `macbook-pro-m1` crawl walks **every combination the page offers** (13"/14"/16", Fair/Good/Excellent, all M1-family chip variants, all memory/storage/colour options), re-establishing the parent path at each level because changing a parent option resets everything below it — same reset logic as the iPhone configurator, different groups. Combinations whose options are sold-out show as disabled radios and cannot be selected; the crawler logs those to the coverage log rather than inventing rows. The full raw processor variant (e.g. "Apple M1 Pro 10-core - 16-core GPU") is kept in the row `Notes`; the `Chip` column holds the family (`Apple M1 Pro`). Optional `filters` in `config/models.json` (e.g. `minScreenInches`, `minMemoryGb`, `minStorageGb`, `chipPattern`) prune branches at inventory time if you ever want a narrower crawl — currently unset.

Amazon.co.uk models: `amazon-14-128`, `amazon-14-256`, `amazon-14-512`, `amazon-15-128`, `amazon-15-256`, `amazon-15-512`, `amazon-13-128`, `amazon-13-256`, `amazon-13-512`, `amazon-13-pro-128`, `amazon-13-pro-256`, `amazon-13-pro-512`, `macbook-pro-m1`

The Amazon `macbook-pro-m1` crawl enumerates configurations as **search queries**: screen+chip pairs matching the real product line (13"→M1, 14"→M1 Pro/Max, 16"→M1 Max) × memory (8/16/32/64 GB) × storage (256 GB, 512 GB, 1 TB, 2 TB, 4 TB). Per search it skips sponsored tiles, takes the first organic listing, and captures the headline price plus the tile's "More Buying Choices" price. Amazon fuzzy-matches aggressively, so each listing title is verified against the query: MacBook Air and M2+ chips are rejected, and chip/screen/memory/storage come from the title when detectable (falling back to the searched values). Amazon rate-limits search crawls — a ≥2.5 s gap between searches is enforced regardless of `--delay`; a robot check retries with backoff (solve the captcha in the headed window) and then aborts cleanly for a cooldown.

Refurbed.co.uk models: `iphone-13`, `iphone-13-pro`, `iphone-14`, `iphone-14-pro`, `iphone-15`, `iphone-15-pro`

musicMagPie models: `iphone-13`, `iphone-14`, `iphone-15`, `iphone-13-pro`, `iphone-14-pro`, `iphone-15-pro`, `iphone-13-pro-max`, `iphone-14-pro-max`, `iphone-15-pro-max`

## What it will not do

- Log in, add to cart, or check out
- Invent combinations the page does not list
- Continue if the host is not the configured origin or the currency is not GBP

A Chrome window will open when running headed. Back Market blocks headless browsers and often shows a short bot check on the first run — complete the checkbox if it appears. The crawler reuses `data/.chrome-profile` so later runs usually skip that check.

## Outputs

Outputs land in `data/`:

- `backmarket-{model}.jsonl` — source of truth, one object per line
- `backmarket-{model}.csv`
- `backmarket-{model}-clean.csv` — cleaned, deduplicated, sorted (built by `npm run clean`)
- `backmarket-{model}-coverage.log` — missing/unavailable branches
- `heal-state.json` — skip-list and crash signatures (used by `watch`)
- `.heartbeat.json` — supervisor liveness (used by `watch`)
- `iphone-dashboard.html` — self-contained interactive dashboard over all clean CSVs (built by `npm run dashboard`). Two tabs: **iPhones** (battery/condition/SIM filters, value = price per GB of storage) and **MacBooks** (screen/chip/memory/storage filters, value = price per GB of RAM). Built via `npm run dashboard`; opens by double-click.

MacBook rows carry `product=macbook` plus `Chip`, `Screen`, `Memory`, `Keyboard` columns; iPhone rows keep the original schema. Both live in the same clean CSV/JSONL pipeline and the same dashboard file.
