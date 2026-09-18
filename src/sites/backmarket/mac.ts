// Back Market MacBook configurator crawler.
// Same step-* machinery as the iPhone crawl (inventory.ts), different groups
// and different leaves. Config-driven filters (config/models.json "filters")
// are applied at inventory time so disqualifying branches are never clicked.
import type { Page } from "playwright";
import type { CaptureRow, ConfiguratorState, CrawlOptions, InventoriedOption, ModelTarget } from "../../types.js";
import { rowKey } from "../../types.js";
import { appendCoverage, appendRow, finalizeCsv, loadExistingRows, modelPaths } from "../../store.js";
import { openProduct } from "./crawl.js";
import { readLivePickers } from "./page.js";
import { backoffOnBlock, setPagePaceId } from "../../rate-limit.js";
import {
  MAC_GROUP_ORDER,
  ensureValues,
  readInventory,
  selectByValueDetailed,
  waitForConfiguratorStable,
  type SelectOutcome,
} from "./inventory.js";

const TRAVERSE: readonly string[] = MAC_GROUP_ORDER;

interface MacJob {
  model: ModelTarget;
  dataDir: string;
  opts: CrawlOptions;
  seen: Set<string>;
  captured: number;
  skipped: number;
  maxRows: number | null;
}

function jobPaths(job: MacJob) {
  return modelPaths(job.dataDir, job.model.id, "backmarket");
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Challenge / off-site detection: a wedged page has no configurator. */
async function isBlocked(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    if (/just a moment|attention required|access denied/i.test(title)) return true;
    return !/backmarket\.co\.uk/.test(page.url());
  } catch {
    return true;
  }
}

/** Why a select failed — recorded to coverage so the log explains itself. */
async function diagnose(page: Page, outcome: SelectOutcome): Promise<string> {
  try {
    const title = await page.title();
    return `redirected=${outcome.redirected} url=${page.url().slice(0, 140)} title="${title.slice(0, 60)}"`;
  } catch {
    return `redirected=${outcome.redirected} url=(unavailable)`;
  }
}

function inches(label: string): number {
  const m = label.match(/([\d.]+)\s*"/) || label.match(/([\d.]+)/);
  return m ? Number(m[1]) : 0;
}

function gb(label: string): number {
  const tb = label.match(/([\d.]+)\s*TB/i);
  if (tb) return Math.round(Number(tb[1]) * 1024);
  const m = label.match(/([\d.]+)\s*GB/i);
  return m ? Number(m[1]) : 0;
}

function passesFilters(model: ModelTarget, sel: Record<string, string>): boolean {
  const f = model.filters;
  if (!f) return true;
  if (f.minScreenInches != null && inches(sel.screen_size ?? "") < f.minScreenInches) return false;
  if (f.minMemoryGb != null && gb(sel.memory ?? "") < f.minMemoryGb) return false;
  if (f.minStorageGb != null && gb(sel.storage ?? "") < f.minStorageGb) return false;
  if (f.chipPattern) {
    const chip = sel.processor_type_and_graphic_card ?? "";
    if (!new RegExp(f.chipPattern, "i").test(chip)) return false;
  }
  return true;
}

function optionAllowed(model: ModelTarget, groupId: string, o: InventoriedOption): boolean {
  // Disabled radios cannot be clicked (sold-out options are disabled too on
  // Back Market), so those combinations are unreachable — they end up in the
  // coverage log, never invented as rows.
  if (!o.enabled) return false;
  const f = model.filters;
  if (!f) return true;
  if (groupId === "screen_size" && f.minScreenInches != null && inches(o.label) < f.minScreenInches) return false;
  if (groupId === "memory" && f.minMemoryGb != null && gb(o.label) < f.minMemoryGb) return false;
  if (groupId === "storage" && f.minStorageGb != null && gb(o.label) < f.minStorageGb) return false;
  if (groupId === "processor_type_and_graphic_card" && f.chipPattern) {
    if (!new RegExp(f.chipPattern, "i").test(`${o.value} ${o.label}`)) return false;
  }
  return true;
}

function buildRow(
  model: ModelTarget,
  state: ConfiguratorState,
  price: string,
  status: "Available" | "Out of stock",
  url: string,
): CaptureRow | null {
  const sel = state.selectedLabels;
  const condition = sel.grades ?? "";
  const storage = sel.storage ?? "";
  const colour = sel.color ?? "";
  const screen = sel.screen_size ?? "";
  const memory = sel.memory ?? "";
  const chip = sel.processor_type_and_graphic_card ?? "";
  const keyboard = sel.keyboard_type_language ?? "";
  if (!condition || !storage || !colour || !screen || !memory) return null;
  if (!passesFilters(model, { screen_size: screen, memory, storage, processor_type_and_graphic_card: chip })) return null;
  // Preserve the full processor variant text (e.g. "Apple M1 Pro 10-core -
  // 16-core GPU") — the canonical `chip` field keeps the family only.
  const chipRaw = state.groups.processor_type_and_graphic_card?.find((o) => o.selected)?.value ?? "";
  const notes = [`chip ${chipRaw || chip}`, `screen ${screen}`, `memory ${memory}`, keyboard ? `keyboard ${keyboard}` : ""]
    .filter(Boolean)
    .join("; ");
  return {
    site: "Back Market",
    capturedAt: new Date().toISOString(),
    model: model.name,
    battery: "N/A",
    condition,
    storage,
    simType: "N/A",
    colour,
    price,
    currency: "GBP",
    status,
    listPrice: "",
    warranty: "",
    sku: "",
    url,
    notes,
    product: "macbook",
    chip,
    screen,
    memory,
    keyboard,
  };
}

async function captureLeaf(job: MacJob, page: Page, path: Record<string, string>): Promise<void> {
  // A challenge/redirect can land on a leaf too — recover before reading.
  if (await isBlocked(page)) {
    await appendCoverage(jobPaths(job).coverage, `blocked at leaf path=${JSON.stringify(path)}; recovering`);
    await backoffOnBlock();
    await openProduct(page, job.model.url);
    if (!(await ensureValues(page, path, TRAVERSE))) {
      await appendCoverage(jobPaths(job).coverage, `leaf recovery could not re-establish path=${JSON.stringify(path)}`);
      return;
    }
  }
  await waitForConfiguratorStable(page, 6000).catch(() => null);
  const state = await readInventory(page);
  const labels = state.selectedLabels;
  const key = rowKey({
    site: "Back Market",
    model: job.model.name,
    battery: "N/A",
    condition: labels.grades ?? "",
    storage: labels.storage ?? "",
    simType: "N/A",
    colour: labels.color ?? "",
    screen: labels.screen_size,
    memory: labels.memory,
    chip: labels.processor_type_and_graphic_card,
  });
  if (job.seen.has(key)) {
    job.skipped += 1;
    return;
  }

  let price = "";
  let status: "Available" | "Out of stock" = "Available";
  let warranty = "";
  let sku = "";
  let listPrice = "";
  let url = page.url();
  try {
    const live = await readLivePickers(page);
    url = live.url || url;
    warranty = live.selectedOffer.warranty ?? "";
    sku = live.selectedOffer.sku ?? "";
    listPrice = live.selectedOffer.listPrice?.amount ?? "";
    status = live.selectedOffer.isOutOfStock ? "Out of stock" : "Available";
    price = live.selectedOffer.isOutOfStock ? "" : (live.selectedOffer.price?.amount ?? "");
  } catch {
    // fall back to selected-option prices below
  }
  if (!price && status === "Available") {
    const priced = TRAVERSE.map((g) => state.groups[g]?.find((o) => o.selected)?.price?.amount ?? "").find(Boolean);
    price = priced ?? "";
    if (!price) {
      await appendCoverage(jobPaths(job).coverage, `leaf without price path=${JSON.stringify(path)}`);
      return;
    }
  }

  const row = buildRow(job.model, state, price, status, url);
  if (!row) return;
  if (listPrice) row.listPrice = listPrice;
  if (warranty) row.warranty = warranty;
  if (sku) row.sku = sku;
  if (status === "Available" && !row.price) return;

  try {
    await appendRow(jobPaths(job), row);
    job.seen.add(key);
    job.captured += 1;
    console.log(`[mac] + ${row.condition} / ${row.screen} / ${row.memory} / ${row.storage} / ${row.colour} — £${row.price || "-"}`);
  } catch (error) {
    await appendCoverage(jobPaths(job).coverage, `rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function dfs(job: MacJob, page: Page, path: Record<string, string>, depth: number): Promise<void> {
  if (job.maxRows != null && job.captured >= job.maxRows) return;
  const groupId = TRAVERSE[depth];
  if (!groupId) {
    await captureLeaf(job, page, path);
    return;
  }
  if (!(await ensureValues(page, path, TRAVERSE))) {
    await appendCoverage(jobPaths(job).coverage, `ensureValues failed at ${groupId} path=${JSON.stringify(path)}`);
    return;
  }
  const state = await readInventory(page);
  const options = (state.groups[groupId] ?? []).filter((o) => optionAllowed(job.model, groupId, o));
  if (options.length === 0) {
    await appendCoverage(jobPaths(job).coverage, `no eligible options for ${groupId} (filtered or unavailable) path=${JSON.stringify(path)}`);
    return;
  }
  for (const option of options) {
    if (job.maxRows != null && job.captured >= job.maxRows) return;
    await pause(job.opts.delayMs);
    let outcome = await selectByValueDetailed(page, groupId, option.value);
    if (!outcome.ok) {
      // A failed click can leave the page wedged (redirected to a combination
      // with no offer, or a challenge) — every subsequent select then fails.
      // Recover exactly like the iPhone crawler's reload-hub: reload the
      // product, re-establish the parent path, retry once. Sustained
      // challenges escalate via backoffOnBlock -> RateLimitError.
      const why = await diagnose(page, outcome);
      if (await isBlocked(page)) {
        await backoffOnBlock();
      }
      await appendCoverage(jobPaths(job).coverage, `select failed ${groupId}=${option.label}[${option.value}] (${why}); recovering`);
      await openProduct(page, job.model.url);
      if (!(await ensureValues(page, path, TRAVERSE))) {
        await appendCoverage(jobPaths(job).coverage, `recovery could not re-establish path=${JSON.stringify(path)}`);
        return;
      }
      outcome = await selectByValueDetailed(page, groupId, option.value);
    }
    if (!outcome.ok) {
      await appendCoverage(jobPaths(job).coverage, `select retry failed ${groupId}=${option.label}[${option.value}] — combination likely has no offer`);
      continue;
    }
    await dfs(job, page, { ...path, [groupId]: option.value }, depth + 1);
  }
}

export async function crawlMacModel(
  page: Page,
  model: ModelTarget,
  dataDir: string,
  opts: CrawlOptions,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id, "backmarket");
  const existing = opts.resume ? await loadExistingRows(paths.jsonl) : [];
  const seen = new Set(
    existing.map((r) =>
      rowKey({
        site: r.site,
        model: r.model,
        battery: r.battery,
        condition: r.condition,
        storage: r.storage,
        simType: r.simType,
        colour: r.colour,
        screen: r.screen,
        memory: r.memory,
        chip: r.chip,
      }),
    ),
  );
  const job: MacJob = { model, dataDir, opts, seen, captured: 0, skipped: 0, maxRows: opts.maxRows };
  console.log(`\n[Back Market] [${model.name}] === Mac crawl (${seen.size} rows already saved) ===`);
  setPagePaceId(page, `mac-${Date.now().toString(36)}`);
  await openProduct(page, model.url);
  await dfs(job, page, {}, 0);
  await finalizeCsv(paths).catch(() => undefined);
  console.log(`[Back Market] [${model.name}] Done: +${job.captured} new, ${job.skipped} skipped`);
  console.log(`[Back Market] [${model.name}] JSONL: ${paths.jsonl}`);
  return { captured: job.captured, skipped: job.skipped };
}