import type { Page } from "playwright";
import type { CaptureRow, ModelTarget } from "../../types.js";
import { rowKey } from "../../types.js";
import { appendCoverage, appendRow, loadExistingRows, modelPaths } from "../../store.js";
import { backoffOnBlock, setPagePaceId } from "../../rate-limit.js";
import { canonicalAmazonUrl } from "./page.js";

export interface AmazonMacCrawlOptions {
  headed: boolean;
  delayMs: number;
  maxRows?: number | null;
}

/**
 * Amazon.co.uk MacBook Pro M1 crawler — search-URL matrix.
 *
 * Amazon has no configurator; configurations are enumerated by SEARCH QUERY.
 * Variables (user spec): chip+screen (paired like the real product line),
 * memory, storage. Each combination becomes a search URL like:
 *   s?k=macbook+"m1 pro chip"+16GB+512GB+"14-inch"
 * On each results page: skip sponsored tiles, take the first organic listing,
 * capture the headline price plus the tile's "More Buying Choices" price.
 * The listing title is cross-checked against the query (Amazon fuzzy-matches)
 * so the row reflects the actual listing, not just what was searched.
 */

// 13" ships base M1 only; 14" M1 Pro/Max; 16" M1 Max (Back Market ground truth).
const SCREEN_CHIP = [
  { screen: "13-inch", screenCanon: `13"`, chipQuery: "m1", chipCanon: "Apple M1" },
  { screen: "14-inch", screenCanon: `14"`, chipQuery: "m1 pro", chipCanon: "Apple M1 Pro" },
  { screen: "14-inch", screenCanon: `14"`, chipQuery: "m1 max", chipCanon: "Apple M1 Max" },
  { screen: "16-inch", screenCanon: `16"`, chipQuery: "m1 max", chipCanon: "Apple M1 Max" },
];
const MEMORIES_GB = [8, 16, 32, 64];
// User-specified storage options; unavailable combos simply return no results.
const STORAGES = ["256GB", "512GB", "1TB", "2TB", "4TB"];

/** Amazon rate-limits search crawls far harder than product pages. */
const MIN_SEARCH_GAP_MS = 2500;

function searchUrl(chipQuery: string, memGb: number, storage: string, screen: string): string {
  const k = `macbook "${chipQuery} chip" ${memGb}GB ${storage} "${screen}"`;
  return `https://www.amazon.co.uk/s?k=${encodeURIComponent(k)}`;
}

function storageCanon(storage: string): string {
  const tb = storage.match(/([\d.]+)\s*TB/i);
  if (tb) return `${Math.round(Number(tb[1]) * 1000)} GB`;
  const gb = storage.match(/([\d.]+)\s*GB/i);
  return gb ? `${Number(gb[1])} GB` : storage;
}

/** Mac colour vocabulary (Amazon titles); longest-first so Space Gray wins. */
const MAC_COLOURS = ["Space Gray", "Space Black", "Midnight", "Starlight", "Silver", "Gold"];
const COLOUR_ALIASES: Record<string, string> = { "Space Grey": "Space Gray" };

function colourFromTitle(title: string): string {
  const t = title.replace(/\s+/g, " ");
  for (const colour of [...MAC_COLOURS, ...Object.keys(COLOUR_ALIASES)]) {
    const idx = t.toLowerCase().indexOf(colour.toLowerCase());
    if (idx !== -1) {
      const matched = t.slice(idx, idx + colour.length);
      return COLOUR_ALIASES[matched] ?? matched;
    }
  }
  return "Unknown";
}

function conditionFromTitle(title: string): string {
  if (/Renewed\s+Premium/i.test(title)) return "Premium";
  if (/Renewed\s+Excellent/i.test(title)) return "Excellent";
  if (/Renewed\s+Good/i.test(title)) return "Good";
  if (/Renewed\s+Fair/i.test(title)) return "Fair";
  if (/Renewed/i.test(title)) return "Good";
  // Condition not stated — recorded as Good (matches the iPhone Amazon
  // adapter's default) and flagged in Notes.
  return "Good";
}

function chipFromTitle(title: string): string | null {
  if (/M1\s*Max/i.test(title)) return "Apple M1 Max";
  if (/M1\s*Pro/i.test(title)) return "Apple M1 Pro";
  if (/M1\b/.test(title)) return "Apple M1";
  return null;
}

/** M2/M3/M4/M5 silicon in a title means the listing is not an M1 machine. */
function isNonM1Title(title: string): boolean {
  return /\bM\s?[2-9]\b|\bM\s?[2-9]\s*(?:Pro|Max|Ultra)\b/i.test(title);
}

function screenFromTitle(title: string): string | null {
  const m = title.match(/(\d{2})\s*[- ]?\s*(?:inch|")/);
  return m ? `${m[1]}"` : null;
}

function memoryFromTitle(title: string): string | null {
  const m = title.match(/\b(8|16|32|64)\s*GB\s*(?:RAM|Unified|Memory)/i);
  return m ? `${m[1]} GB` : null;
}

function storageFromTitle(title: string): string | null {
  const m = title.match(/\b(?:256|512)\s*GB\b|\b[1-4]\s*TB\b/i);
  return m ? storageCanon(m[0]) : null;
}

interface TileListing {
  asin: string;
  title: string;
  price: string;
  moreBuyingChoices: string | null;
  sponsored: boolean;
}

async function readListings(page: Page): Promise<TileListing[]> {
  const tiles = page.locator('div[data-component-type="s-search-result"][data-asin]');
  const count = await tiles.count().catch(() => 0);
  const listings: TileListing[] = [];
  for (let i = 0; i < count; i++) {
    const tile = tiles.nth(i);
    const asin = (await tile.getAttribute("data-asin").catch(() => "")) ?? "";
    if (!asin) continue;
    const title = ((await tile.locator("h2 span").first().textContent().catch(() => "")) ?? "").trim();
    const priceText =
      (await tile
        .locator(".a-price:not(.a-text-price) .a-offscreen")
        .first()
        .textContent()
        .catch(() => "")) ?? "";
    const price = priceText.match(/£\s*([\d,]+\.\d{2})/)?.[1].replace(/,/g, "") ?? "";
    const text = (await tile.innerText().catch(() => "")) ?? "";
    listings.push({
      asin,
      title,
      price,
      moreBuyingChoices:
        text.match(/More Buying Choices\s*£\s*([\d,]+\.\d{2})/i)?.[1].replace(/,/g, "") ?? null,
      sponsored: /\bSponsored\b/.test(text),
    });
  }
  return listings;
}

async function isRobotCheck(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    if (/robot check|enter the characters|sorry/i.test(title)) return true;
    const captcha = await page
      .locator('form[action*="captcha"], #captchacharacters')
      .count()
      .catch(() => 0);
    return captcha > 0;
  } catch {
    return true;
  }
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function crawlAmazonMacModel(
  page: Page,
  model: ModelTarget,
  dataDir: string,
  options: AmazonMacCrawlOptions,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id, "amazon");
  const existing = await loadExistingRows(paths.jsonl);
  const seen = new Set(existing.map(rowKey));
  const gap = Math.max(options.delayMs, MIN_SEARCH_GAP_MS);
  setPagePaceId(page, `amazon-mac-${Date.now().toString(36)}`);

  let captured = 0;
  let skipped = 0;
  let searches = 0;

  const saveRow = async (
    listing: TileListing,
    config: { screen: string; memory: string; storage: string; chip: string; chipQuery: string },
    price: string,
    kind: "headline" | "More Buying Choices",
  ): Promise<void> => {
    const renewed = /Renewed/i.test(listing.title);
    const row: CaptureRow = {
      site: "Amazon.co.uk",
      capturedAt: new Date().toISOString(),
      model: model.name,
      battery: "N/A",
      condition: conditionFromTitle(listing.title),
      storage: config.storage,
      simType: "N/A",
      colour: colourFromTitle(listing.title),
      price,
      currency: "GBP",
      status: "Available",
      listPrice: "",
      warranty: renewed ? "Amazon Renewed Guarantee" : "",
      sku: listing.asin,
      url: canonicalAmazonUrl(`https://www.amazon.co.uk/dp/${listing.asin}`),
      notes: `${listing.title.slice(0, 200)} [${kind}; search: ${config.chipQuery} ${config.screen} ${config.memory} ${config.storage}]`,
      product: "macbook",
      chip: config.chip,
      screen: config.screen,
      memory: config.memory,
    };
    const key = rowKey(row);
    if (seen.has(key)) return;
    try {
      await appendRow(paths, row);
      seen.add(key);
      captured += 1;
      console.log(
        `[amazon-mac] + ${row.condition} / ${row.screen} / ${row.memory} / ${row.storage} / ${row.chip} / ${row.colour} — £${row.price} (${kind})`,
      );
    } catch (error) {
      await appendCoverage(paths.coverage, `rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const { screen, screenCanon, chipQuery, chipCanon } of SCREEN_CHIP) {
    for (const memGb of MEMORIES_GB) {
      for (const storage of STORAGES) {
        if (options.maxRows != null && captured >= options.maxRows) break;
        const url = searchUrl(chipQuery, memGb, storage, screen);
        searches += 1;

        // Load with robot-check retry: the user can solve a captcha in the
        // headed browser, so re-check a few times before giving up on this
        // search. Sustained blocking escalates via backoffOnBlock, whose
        // limit throws RateLimitError for a clean abort.
        let loaded = false;
        for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await pause(gap);
          if (await isRobotCheck(page)) {
            await appendCoverage(paths.coverage, `robot check on ${chipQuery}/${memGb}GB/${storage}/${screen} (attempt ${attempt})`);
            await backoffOnBlock();
          } else {
            // Results render client-side — wait for tiles before counting,
            // otherwise the first search can read an empty shell (tiles=0).
            await page
              .waitForSelector('div[data-component-type="s-search-result"]', { timeout: 8000 })
              .catch(() => undefined);
            loaded = true;
          }
        }
        if (!loaded) {
          await appendCoverage(paths.coverage, `stuck on robot check — aborting at ${chipQuery}/${memGb}GB/${storage}/${screen}`);
          skipped += 1;
          return { captured, skipped };
        }

        const listings = await readListings(page);
        // Amazon fuzzy-matches "macbook" to MacBook Air (and worse) — the
        // matrix targets MacBook Pro M1, so require MacBook and exclude Air.
        const organic = listings.filter(
          (l) =>
            !l.sponsored &&
            l.price &&
            /MacBook/i.test(l.title) &&
            !/MacBook\s*Air/i.test(l.title) &&
            !isNonM1Title(l.title),
        );
        const sponsored = listings.length - listings.filter((l) => !l.sponsored).length;
        const offTarget = listings.length - sponsored - organic.length;
        if (organic.length === 0) {
          await appendCoverage(
            paths.coverage,
            `no MacBook Pro results ${chipQuery}/${memGb}GB/${storage}/${screen} (tiles=${listings.length}, sponsored=${sponsored}, off-target=${offTarget})`,
          );
          skipped += 1;
          continue;
        }

        const chosen = organic[0];
        // Trust the listing title over the search query — Amazon fuzzy-matches.
        const config = {
          screen: screenFromTitle(chosen.title) ?? screenCanon,
          memory: memoryFromTitle(chosen.title) ?? `${memGb} GB`,
          storage: storageFromTitle(chosen.title) ?? storageCanon(storage),
          chip: chipFromTitle(chosen.title) ?? chipCanon,
          chipQuery,
        };
        if (config.chip !== chipCanon) {
          await appendCoverage(paths.coverage, `chip differs from query: searched ${chipCanon}, listing ${config.chip} (${chosen.asin})`);
        }
        await saveRow(chosen, config, chosen.price, "headline");
        if (chosen.moreBuyingChoices) {
          await saveRow(chosen, config, chosen.moreBuyingChoices, "More Buying Choices");
        } else {
          await appendCoverage(paths.coverage, `no more-buying-choices price on tile ${chosen.asin}`);
        }
      }
      if (options.maxRows != null && captured >= options.maxRows) break;
    }
    if (options.maxRows != null && captured >= options.maxRows) break;
  }

  await appendCoverage(paths.coverage, `pass done: ${searches} searches, +${captured} new, ${skipped} skipped, ${seen.size} total`);
  return { captured, skipped };
}


