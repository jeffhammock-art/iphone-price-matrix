import type { Page } from "playwright";
import type { CaptureRow, ModelTarget } from "../../types.js";
import { appendCoverage, appendRow, finalizeCsv, modelPaths } from "../../store.js";
import { canonicalAmazonUrl, readMainOffer } from "./page.js";

export interface AmazonCrawlOptions {
  headed: boolean;
  delayMs: number;
}

/**
 * Crawl a single Amazon product URL and capture the main Buy Box offer.
 * Amazon pages are direct product listings - no configurator walk needed.
 * We only capture the primary price shown to buyers, not third-party seller offers.
 */
export async function crawlAmazonModel(
  page: Page,
  model: ModelTarget,
  dataDir: string,
  options: AmazonCrawlOptions,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id, "amazon");
  let captured = 0;
  let skipped = 0;

  try {
    await page.goto(model.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(options.delayMs);

    const offer = await readMainOffer(page);

    await appendCoverage(paths.coverage, `Crawled ${model.name} (${model.storage})`);

    if (!offer) {
      await appendCoverage(paths.coverage, `SKIP no price found for ${model.id}`);
      skipped += 1;
    } else {
      await appendCoverage(paths.coverage, `Found ${offer.condition} at £${offer.price} (${offer.colour})`);

      const row: CaptureRow = {
        site: "Amazon.co.uk",
        capturedAt: new Date().toISOString(),
        model: model.name,
        battery: "Unknown",
        condition: offer.condition,
        storage: model.storage ?? "Unknown",
        simType: "Unknown",
        colour: offer.colour || "Unknown",
        price: offer.price,
        currency: "GBP",
        status: "Available",
        listPrice: "",
        warranty: "Amazon Renewed Guarantee",
        sku: "",
        url: canonicalAmazonUrl(page.url()),
        notes: `Amazon Renewed ${offer.condition}`,
      };

      try {
        await appendRow(paths, row);
        captured += 1;
      } catch (e) {
        skipped += 1;
        await appendCoverage(paths.coverage, `SKIP invalid row: ${(e as Error).message}`);
      }
    }
  } catch (error) {
    skipped += 1;
    const message = error instanceof Error ? error.message : String(error);
    await appendCoverage(paths.coverage, `ERROR crawling ${model.id}: ${message}`);
  }

  await finalizeCsv(paths).catch(() => undefined);
  return { captured, skipped };
}

