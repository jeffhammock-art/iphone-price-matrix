import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import type { ModelTarget, MultiSiteConfig, SiteConfig } from "./types.js";
import { rowKey } from "./types.js";
import { calibrateModel, crawlModel, probeModel, withBrowser, withBrowserContext } from "./sites/backmarket/crawl.js";
import { crawlAmazonModel } from "./sites/amazon/crawl.js";
import { crawlRefurbedModel } from "./sites/refurbed/crawl.js";
import { crawlMusicMagpieModel } from "./sites/musicmagpie/crawl.js";
import { RateLimitError, setPagePaceId } from "./rate-limit.js";
import { ensureDataDir, finalizeCsv, loadExistingRows, modelPaths, writeCleanCsv } from "./store.js";
import { writeReport } from "./report.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(rootDir, "config", "models.json");
const dataDir = join(rootDir, "data");

async function loadConfig(): Promise<MultiSiteConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  // Support both old single-site format and new multi-site format
  if ("sites" in parsed) return parsed as MultiSiteConfig;
  return { sites: [parsed as SiteConfig] };
}

function resolveSite(config: MultiSiteConfig, siteId: string | undefined): SiteConfig {
  if (!siteId) {
    if (config.sites.length === 1) return config.sites[0];
    const ids = config.sites.map((s) => s.site).join(", ");
    throw new Error(`Multiple sites configured. Pass --site <id>. Available: ${ids}`);
  }
  const match = config.sites.find((s) => s.site.toLowerCase() === siteId.toLowerCase());
  if (!match) {
    const ids = config.sites.map((s) => s.site).join(", ");
    throw new Error(`Unknown site '${siteId}'. Available: ${ids}`);
  }
  return match;
}

function resolveModels(site: SiteConfig, modelId: string | undefined, all: boolean) {
  if (all) return site.models;
  if (!modelId) {
    throw new Error("Pass --model <id> (e.g. iphone-15) or --all");
  }
  const match = site.models.filter((model) => model.id === modelId);
  if (match.length === 0) {
    const ids = site.models.map((model) => model.id).join(", ");
    throw new Error(`Unknown model '${modelId}'. Known: ${ids}`);
  }
  return match;
}

function getSitePrefix(site: SiteConfig): string {
  if (site.site.toLowerCase().includes("amazon")) return "amazon";
  if (site.site.toLowerCase().includes("refurbed")) return "refurbed";
  if (site.site.toLowerCase().includes("musicmagpie")) return "musicmagpie";
  return "backmarket";
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      site: { type: "string" },
      all: { type: "boolean", default: false },
      headed: { type: "boolean", default: true },
      headless: { type: "boolean", default: false },
      "no-resume": { type: "boolean", default: false },
      "max-rows": { type: "string" },
      delay: { type: "string", default: "450" },
      "ignore-denylist": { type: "boolean", default: false },
      concurrency: { type: "string", default: "1" },
    },
  });

  const command = positionals[0] ?? "crawl";
  const config = await loadConfig();
  const site = resolveSite(config, values.site);
  const models = resolveModels(site, values.model, Boolean(values.all));
  const headed = values.headless ? false : values.headed !== false;
  const maxRows = values["max-rows"] ? Number(values["max-rows"]) : null;
  const delayMs = Number(values.delay ?? "450");
  const concurrency = Math.max(1, Math.min(Number(values.concurrency ?? "6") || 6, models.length));
  const sitePrefix = getSitePrefix(site);
  const isAmazon = sitePrefix === "amazon";

  /**
   * One model crawl on its own tab. Used by both the sequential path (single
   * page) and the parallel path (one page per worker). A RateLimitError is a
   * hard stop — rethrown so the process exits non-zero for cooldown signaling.
   */
  const crawlOne = async (page: Page, model: ModelTarget): Promise<void> => {
    const paths = modelPaths(dataDir, model.id, sitePrefix);
    const existing = values["no-resume"] ? [] : await loadExistingRows(paths.jsonl);
    const seen = new Set(existing.map(rowKey));
    console.log(`\n[${site.site}] [${model.name}] === Crawl (${seen.size} rows already saved) ===`);

    let result;
    if (isAmazon) {
      result = await crawlAmazonModel(page, model, dataDir, { headed, delayMs });
    } else if (sitePrefix === "refurbed") {
      result = await crawlRefurbedModel(page, model, site, dataDir, { headed, delayMs });
    } else if (sitePrefix === "musicmagpie") {
      result = await crawlMusicMagpieModel(page, model, dataDir, { headed, delayMs, maxRows });
    } else {
      result = await crawlModel(
        page,
        model,
        dataDir,
        { headed, resume: !values["no-resume"], maxRows, delayMs, ignoreDenylist: Boolean(values["ignore-denylist"]) },
        seen,
      );
    }
    await finalizeCsv(paths).catch(() => undefined);
    const rows = await loadExistingRows(paths.jsonl);
    console.log(`[${site.site}] [${model.name}] Done: +${result.captured} new, ${result.skipped} skipped, ${rows.length} total`);
    console.log(`[${site.site}] [${model.name}] CSV: ${paths.csv}`);
  };

  if (command === "calibrate") {
    await withBrowser(headed, async (page) => {
      for (const model of models) {
        console.log(`\n=== Calibrate ${model.name} ===\n`);
        console.log(await calibrateModel(page, model));
      }
    });
    return;
  }

  if (command === "probe") {
    await withBrowser(headed, async (page) => {
      for (const model of models) {
        console.log(`\n=== Probe ${model.name} ===\n`);
        console.log(await probeModel(page, model));
      }
    });
    return;
  }

  if (command === "report") {
    await ensureDataDir(dataDir);
    for (const model of models) {
      const paths = modelPaths(dataDir, model.id, sitePrefix);
      const rows = await loadExistingRows(paths.jsonl);
      if (rows.length === 0) {
        console.log(`No data for ${model.id}. Run crawl first.`);
        continue;
      }
      await writeReport(paths.report, model.name, rows);
      console.log(`Wrote ${paths.report} (${rows.length} rows)`);
    }
    return;
  }

  if (command === "clean") {
    await ensureDataDir(dataDir);
    for (const model of models) {
      const paths = modelPaths(dataDir, model.id, sitePrefix);
      const rows = await loadExistingRows(paths.jsonl);
      if (rows.length === 0) {
        console.log(`No data for ${model.id}. Run crawl first.`);
        continue;
      }
      const result = await writeCleanCsv(paths.cleanCsv, rows);
      console.log(
        `Cleaned ${site.site} ${model.name}: ${result.kept} kept, ${result.rejected} rejected, ${result.duplicates} duplicates (from ${result.total} captured)`,
      );
      console.log(`Clean CSV: ${paths.cleanCsv}`);
      if (result.reasons.length > 0) {
        console.log("Rejected rows:");
        for (const reason of result.reasons.slice(0, 20)) {
          console.log(`  - ${reason}`);
        }
        if (result.reasons.length > 20) {
          console.log(`  ... and ${result.reasons.length - 20} more`);
        }
      }
    }
    return;
  }

  if (command !== "crawl") {
    throw new Error(`Unknown command '${command}'. Use calibrate | crawl | clean | report`);
  }

  await ensureDataDir(dataDir);

  if (models.length === 1) {
    // Sequential path: one tab, one model.
    await withBrowser(headed, (page) => crawlOne(page, models[0]));
    return;
  }

  // Parallel path (--all): all 6 product pages crawl concurrently, each on
  // its own tab within ONE shared Chrome context — same profile, same
  // fingerprint, one trusted session. A bounded worker pool opens a new tab
  // per model and closes it when the model finishes.
  console.log(`\n=== Parallel crawl: ${models.length} models, ${concurrency} at a time ===`);
  await withBrowserContext(headed, async (context) => {
    const queue = [...models];
    let rateLimited = false;
    const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
      let model = queue.shift();
      while (model && !rateLimited) {
        let page: Page | null = null;
        try {
          page = await context.newPage();
          setPagePaceId(page, `w${workerIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
          await crawlOne(page, model);
        } catch (error) {
          if (error instanceof RateLimitError) {
            rateLimited = true;
            console.error(`[${model.name}] RATE LIMITED — stopping remaining models for cooldown.`);
            throw error; // fail this worker; Promise.all rejects below
          }
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${model.name}] worker ${workerIndex + 1} failed: ${message}`);
        } finally {
          if (page) await page.close().catch(() => undefined);
        }
        if (!rateLimited) model = queue.shift();
      }
    });
    await Promise.all(workers);
  });
}

main().catch((error) => {
  if (error instanceof RateLimitError) {
    console.error(`\n[rate-limit] ${error.message}\nRun level-safe checks first, and retry after a cooldown.`);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
