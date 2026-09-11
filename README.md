# iPhone price matrix

Local Playwright crawler for refurbished iPhone configuration prices. First site: Back Market UK.

It walks the product configurator in page order:

Condition → Battery → Storage → SIM type → Colour

and writes one CSV row per real configuration. Changing a parent control resets children, so the crawler never moves up until the branch below it is finished.

## Setup

```powershell
cd C:\Users\jeffh\Documents\PP\iphone-price-matrix
npm install
npx playwright install chromium
```

## Commands

Calibrate (dumps live option labels, no matrix):

```powershell
npm run calibrate -- --model iphone-15
```

Crawl one model (resume-safe):

```powershell
npm run crawl -- --model iphone-15
```

Smoke test (stop after 8 rows):

```powershell
npm run crawl -- --model iphone-15 --max-rows 8
```

All six iPhone pages:

```powershell
npm run crawl -- --all
```

Rebuild the markdown report from an existing CSV/JSONL file:

```powershell
npm run report -- --model iphone-15
```

Outputs land in `data/`:

- `backmarket-iphone-15.jsonl` — source of truth, one object per line
- `backmarket-iphone-15.csv`
- `backmarket-iphone-15-coverage.log` — missing/unavailable branches
- `backmarket-iphone-15-report.md`

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model` | required unless `--all` | `iphone-15`, `iphone-13`, `iphone-14`, `iphone-15-pro`, `iphone-14-pro`, `iphone-13-pro` |
| `--all` | off | crawl every model in `config/models.json` |
| `--headed` | on | show Chrome. Back Market blocks headless (403), so this is the default |
| `--headless` | off | force headless; expected to fail on Back Market |
| `--max-rows` | none | stop after N saved rows (useful for a first watch) |
| `--delay` | 450 | milliseconds to wait after each selection |
| `--no-resume` | off | ignore the existing JSONL file and recapture (still appends; delete `data/*.jsonl` to start clean) |

## What it will not do

- Log in, add to cart, or check out
- Invent combinations the page does not list
- Continue if the host is not `backmarket.co.uk` or the currency is not GBP

A Chrome window will open. Back Market blocks headless browsers and often shows a short bot check on the first run — complete the checkbox if it appears. The crawler reuses `data/.chrome-profile` so later runs usually skip that check.
