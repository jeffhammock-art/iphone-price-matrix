import type { Page } from "playwright";
import type { CaptureRow, ModelTarget } from "../../types.js";
import { appendCoverage, appendRow, finalizeCsv, modelPaths } from "../../store.js";

export interface MusicMagpieCrawlOptions {
  headed: boolean;
  delayMs: number;
  maxRows: number | null;
}

/** musicMagpie grade -> dashboard condition. */
function mapCondition(grade: string): string {
  const g = grade.toLowerCase();
  if (g.includes("pristine")) return "Premium";
  if (g.includes("very good")) return "Excellent";
  if (g.includes("excellent")) return "Excellent";
  if (g.includes("good")) return "Good";
  if (g.includes("fair")) return "Fair";
  return "Good";
}

interface MmpProduct {
  price: string;
  condition: string;
  storage: string;
  colour: string;
  battery: string;
  url: string;
}

/** Parse one product card's text + link into structured fields. */
function parseCard(text: string, href: string): MmpProduct | null {
  // Price: first £x.xx occurrence (current price precedes "vs £xxx" original).
  const priceM = text.match(/£([\d,]+\.\d{2})/);
  if (!priceM) return null;
  const price = priceM[1].replace(",", "");

  // Condition grade.
  const condM = text.match(/refurbished\s*-\s*(pristine|very good|excellent|good|fair|poor)/i);
  const condition = mapCondition(condM ? condM[1] : "good");

  // Title: everything between "Apple " and " UNLOCKED" (filter is network:UNLOCKED).
  const fullM = text.match(/Apple\s+(.+?)\s*UNLOCKED/i);
  if (!fullM) return null;
  let full = fullM[1];

  // Battery badge can appear inside the title ("iPhone 13 New Battery 128GB ...").
  let battery = "Standard";
  if (/new battery/i.test(full)) {
    battery = "New";
    full = full.replace(/new battery/i, "").trim();
  }

  // Storage + colour.
  const storageM = full.match(/(\d+GB)/i);
  if (!storageM) return null;
  const storage = `${storageM[1].toUpperCase().replace("GB", " GB")}`;
  const colour = full.substring(full.indexOf(storageM[0]) + storageM[0].length).trim() || "Unknown";

  return { price, condition, storage, colour, battery, url: href };
}

/**
 * Crawl a musicMagpie category page (single page load, no pagination).
 * The user-provided URL already contains the buy + UNLOCKED + per-page=128 filters.
 * musicMagpie is Cloudflare-protected: headless is blocked, must be headed.
 * All cards are extracted in ONE evaluate() call for speed and reliability.
 */
export async function crawlMusicMagpieModel(
  page: Page,
  model: ModelTarget,
  dataDir: string,
  options: MusicMagpieCrawlOptions,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id, "musicmagpie");
  let captured = 0;
  let skipped = 0;

  try {
    await page.goto(model.url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait until product cards actually contain links (content rendered post-JS).
    try {
      await page.waitForSelector('[class*="_productCard_"] a[href]', { timeout: 30000 });
    } catch {
      await appendCoverage(paths.coverage, "WARN product cards never rendered (possible bot block)");
    }
    await page.waitForTimeout(options.delayMs);

    // Cloudflare interstitial check.
    const title = await page.title();
    if (/just a moment/i.test(title)) {
      throw new Error("Blocked by Cloudflare — run headed and retry");
    }

    // Extract every card (text + first link href) in one atomic evaluate call.
    const rawCards = await page.evaluate(() => {
      const out: { text: string; href: string }[] = [];
      const cards = document.querySelectorAll<HTMLDivElement>('[class*="_productCard_"]');
      for (const card of cards) {
        const a = card.querySelector("a");
        out.push({ text: card.textContent?.replace(/\s+/g, " ").trim() ?? "", href: a?.getAttribute("href") ?? "" });
      }
      return out;
    });

    await appendCoverage(paths.coverage, `Crawled ${model.name}: ${rawCards.length} cards`);

    const seenKeys = new Set<string>();
    const max = options.maxRows ?? 128;

    for (const { text, href } of rawCards) {
      if (captured >= max) break;
      if (!href || !text) continue;

      const product = parseCard(text, href);
      if (!product) {
        skipped += 1;
        continue;
      }

      const row: CaptureRow = {
        site: "musicMagpie",
        capturedAt: new Date().toISOString(),
        model: model.name,
        battery: product.battery,
        condition: product.condition,
        storage: product.storage,
        simType: "Unknown",
        colour: product.colour,
        price: product.price,
        currency: "GBP",
        status: "Available",
        listPrice: "",
        warranty: "musicMagpie 12 month warranty",
        sku: "",
        url: product.url,
        notes: `musicMagpie refurbished`,
      };

      try {
        await appendRow(paths, row);
        captured += 1;
        console.log(`[musicMagpie] £${row.price} - ${row.condition} ${row.storage} ${row.colour} ${row.battery}`);
      } catch (e) {
        skipped += 1;
        await appendCoverage(paths.coverage, `SKIP ${(e as Error).message}`);
      }
    }
  } catch (error) {
    skipped += 1;
    const message = error instanceof Error ? error.message : String(error);
    await appendCoverage(paths.coverage, `ERROR ${model.id}: ${message}`);
    console.error(`[musicMagpie] ${model.name}: ${message}`);
  }

  await finalizeCsv(paths).catch(() => undefined);
  return { captured, skipped };
}