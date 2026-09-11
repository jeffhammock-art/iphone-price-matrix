import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig } from "./types.js";
import { rowKey } from "./types.js";
import { calibrateModel, crawlModel, withBrowser } from "./sites/backmarket/crawl.js";
import { ensureDataDir, loadExistingRows, modelPaths } from "./store.js";
import { writeReport } from "./report.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(rootDir, "config", "models.json");
const dataDir = join(rootDir, "data");

async function loadConfig(): Promise<SiteConfig> {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as SiteConfig;
}

function resolveModels(config: SiteConfig, modelId: string | undefined, all: boolean) {
  if (all) return config.models;
  if (!modelId) {
    throw new Error("Pass --model <id> (e.g. iphone-15) or --all");
  }
  const match = config.models.filter((model) => model.id === modelId);
  if (match.length === 0) {
    const ids = config.models.map((model) => model.id).join(", ");
    throw new Error(`Unknown model '${modelId}'. Known: ${ids}`);
  }
  return match;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      all: { type: "boolean", default: false },
      headed: { type: "boolean", default: true },
      headless: { type: "boolean", default: false },
      "no-resume": { type: "boolean", default: false },
      "max-rows": { type: "string" },
      delay: { type: "string", default: "450" },
    },
  });

  const command = positionals[0] ?? "crawl";
  const config = await loadConfig();
  const models = resolveModels(config, values.model, Boolean(values.all));
  const headed = values.headless ? false : values.headed !== false;
  const maxRows = values["max-rows"] ? Number(values["max-rows"]) : null;
  const delayMs = Number(values.delay ?? "450");

  if (command === "calibrate") {
    await withBrowser(headed, async (page) => {
      for (const model of models) {
        console.log(`\n=== Calibrate ${model.name} ===\n`);
        console.log(await calibrateModel(page, model));
      }
    });
    return;
  }

  if (command === "report") {
    await ensureDataDir(dataDir);
    for (const model of models) {
      const paths = modelPaths(dataDir, model.id);
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

  if (command !== "crawl") {
    throw new Error(`Unknown command '${command}'. Use calibrate | crawl | report`);
  }

  await ensureDataDir(dataDir);

  await withBrowser(headed, async (page) => {
    for (const model of models) {
      const paths = modelPaths(dataDir, model.id);
      const existing = values["no-resume"] ? [] : await loadExistingRows(paths.jsonl);
      const seen = new Set(existing.map(rowKey));
      console.log(`\n=== Crawl ${model.name} (${seen.size} rows already saved) ===`);
      const result = await crawlModel(
        page,
        model,
        dataDir,
        { headed, resume: !values["no-resume"], maxRows, delayMs },
        seen,
      );
      const rows = await loadExistingRows(paths.jsonl);
      await writeReport(paths.report, model.name, rows);
      console.log(`Done ${model.name}: +${result.captured} new, ${result.skipped} skipped, ${rows.length} total`);
      console.log(`CSV: ${paths.csv}`);
      console.log(`Report: ${paths.report}`);
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
