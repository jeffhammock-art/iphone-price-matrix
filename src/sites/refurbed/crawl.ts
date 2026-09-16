import type { Page } from "playwright";
import type { CaptureRow, ModelTarget, SiteConfig } from "../../types.js";
import { rowKey } from "../../types.js";
import { appendCoverage, appendRow, finalizeCsv, modelPaths } from "../../store.js";
import { attrForSelect, readAllSelects, readBasePrice } from "./page.js";

export interface RefurbedCrawlOptions {
  headed: boolean;
  delayMs: number;
}

/**
 * Fast crawl of a refurbed.co.uk model page.
 *
 * Each <select> option carries a URL AND a price delta (e.g. "256 GB+£96.39").
 * We read the base price + every option delta from ONE page load (expanding the
 * "Available in other configurations" section), then compute the price for each
 * single-attribute variant as basePrice + delta. No per-variant navigation is
 * needed, which makes this both fast and robust to refurbed's selector-reset.
 */
export async function crawlRefurbedModel(
  page: Page,
  model: ModelTarget,
  site: SiteConfig,
  dataDir: string,
  options: RefurbedCrawlOptions,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id, "refurbed");
  let captured = 0;
  let skipped = 0;
  const origin = site.origin;

  try {
    await page.goto(model.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(options.delayMs);

    const basePrice = Number(await readBasePrice(page)) || 0;
    const selects = await readAllSelects(page);

    // Build base config from the default (delta-0) option of each selector.
    const baseConfig: Record<string, string> = {};
    for (const sel of selects) {
      const attr = attrForSelect(sel.id);
      const zeroDelta = sel.options.find((o) => o.delta === 0);
      if (zeroDelta && zeroDelta.label) baseConfig[attr] = zeroDelta.label;
    }

    await appendCoverage(paths.coverage, `Crawled ${model.name}: base £${basePrice}, ${selects.length} selectors`);
    console.log(`[Refurbed] ${model.name} base £${basePrice.toFixed(2)}`);

    // Enumerate every single-attribute variant.
    const seenKeys = new Set<string>();
    const variants: { cfg: Record<string, string>; price: number; url: string }[] = [];

    for (const sel of selects) {
      const attr = attrForSelect(sel.id);
      for (const opt of sel.options) {
        if (!opt.label) continue;
        const cfg = { ...baseConfig, [attr]: opt.label };
        const key = Object.values(cfg).join("|");
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        variants.push({ cfg, price: Math.round((basePrice + opt.delta) * 100) / 100, url: absoluteUrl(origin, opt.url) });
      }
    }

    for (const v of variants) {
      const row: CaptureRow = {
        site: "Refurbed.co.uk",
        capturedAt: new Date().toISOString(),
        model: model.name,
        battery: v.cfg.battery || "Unknown",
        condition: v.cfg.condition || "Good",
        storage: v.cfg.storage || "Unknown",
        simType: v.cfg.simType || "Unknown",
        colour: v.cfg.colour || "Unknown",
        price: v.price.toFixed(2),
        currency: "GBP",
        status: "Available",
        listPrice: "",
        warranty: "Refurbed guarantee",
        sku: "",
        url: v.url,
        notes: "Refurbed configuration",
      };

      try {
        await appendRow(paths, row);
        captured += 1;
        console.log(`[Refurbed] £${row.price} - ${row.condition} ${row.storage} ${row.colour} ${row.battery}`);
      } catch (e) {
        skipped += 1;
        await appendCoverage(paths.coverage, `SKIP ${(e as Error).message}`);
      }
    }
  } catch (error) {
    skipped += 1;
    const message = error instanceof Error ? error.message : String(error);
    await appendCoverage(paths.coverage, `ERROR ${model.id}: ${message}`);
  }

  await finalizeCsv(paths).catch(() => undefined);
  return { captured, skipped };
}

function absoluteUrl(origin: string, path: string): string {
  if (path.startsWith("http")) return path;
  return `${origin}${path}`;
}