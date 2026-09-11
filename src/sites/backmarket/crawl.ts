import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CaptureRow, CrawlOptions, ModelTarget } from "../../types.js";
import { rowKey } from "../../types.js";
import { appendCoverage, appendRow, modelPaths } from "../../store.js";
import {
  BACKMARKET_GROUP_ORDER,
  assertUkStore,
  dismissCookies,
  isOptionEnabled,
  readLivePickers,
  selectPickerOption,
  selectedLabel,
} from "./page.js";

const profileDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", ".chrome-profile");

async function launchContext(headed: boolean): Promise<BrowserContext> {
  if (!headed) {
    console.warn("Headless Chrome is blocked by Back Market (HTTP 403). Prefer omitting --headless.");
  }
  await mkdir(profileDir, { recursive: true });
  const options = {
    headless: !headed,
    slowMo: headed ? 40 : 0,
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1440, height: 1100 },
    extraHTTPHeaders: {
      "Accept-Language": "en-GB,en;q=0.9",
    },
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launchPersistentContext(profileDir, { channel: "chrome", ...options });
  } catch {
    return await chromium.launchPersistentContext(profileDir, options);
  }
}

export async function withBrowser<T>(headed: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
  const context = await launchContext(headed);
  await context.addInitScript(`
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  `);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

export async function openProduct(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForHumanChallenge(page);
  const status = response?.status() ?? 0;
  if (status === 403 && page.url().includes("/en-gb/p/")) {
    throw new Error(
      "Back Market blocked the browser (HTTP 403). Keep the Chrome window open and complete any bot check, then re-run.",
    );
  }
  await dismissCookies(page);
  try {
    await page.waitForFunction(
      `() => {
        try {
          const nuxt = window.useNuxtApp?.();
          const data = nuxt?.payload?.data;
          if (data && Object.keys(data).some((key) => key.startsWith("pp-pickers:"))) return true;
        } catch {}
        return Boolean(document.querySelector('input[name="step-grades"]'));
      }`,
      { timeout: 30_000 },
    );
  } catch (error) {
    const debug = await page.evaluate(`({
      title: document.title,
      url: location.href,
      body: document.body.innerText.slice(0, 240),
      radios: document.querySelectorAll("input[type=radio]").length,
      nuxtData: Boolean(document.getElementById("__NUXT_DATA__")),
      useNuxtApp: typeof window.useNuxtApp,
      windowHits: Object.keys(window).filter((key) => /nuxt|__NUXT|unctx/i.test(key)),
    })`);
    throw new Error(
      `Product configurator did not boot. ${JSON.stringify(debug)}. Original: ${error instanceof Error ? error.message : error}`,
    );
  }
  await assertUkStore(page);
}

async function waitForHumanChallenge(page: Page): Promise<void> {
  const challenged = await page.evaluate(`(
    document.title.includes("Just a moment") ||
    location.pathname.includes("testchallengepage") ||
    location.pathname.includes("cdn-cgi")
  )`);
  if (!challenged) return;

  console.log("Back Market is running a bot check. If a checkbox appears in Chrome, complete it.");
  await page.waitForFunction(
    `() => {
      const blocked =
        document.title.includes("Just a moment") ||
        location.pathname.includes("testchallengepage") ||
        location.pathname.includes("cdn-cgi");
      return !blocked && Boolean(document.querySelector('input[name="step-grades"], h1'));
    }`,
    { timeout: 120_000 },
  );
}

export async function calibrateModel(page: Page, model: ModelTarget): Promise<string> {
  await openProduct(page, model.url);
  const live = await readLivePickers(page);
  const lines = [
    `Model: ${live.modelName}`,
    `URL: ${live.url}`,
    `Offer: ${live.selectedOffer.price?.amount ?? "none"} ${live.selectedOffer.price?.currency ?? ""}`,
    `Out of stock: ${live.selectedOffer.isOutOfStock}`,
    "",
    "Traversal order (page top → bottom):",
    ...BACKMARKET_GROUP_ORDER.map((id, index) => {
      const group = live.groups.find((entry) => entry.id === id);
      const options =
        group?.items
          .map((item) => {
            const flags = [
              item.selected ? "selected" : null,
              item.available ? null : "unavailable",
              item.acquirable ? null : "not-buyable",
              item.price ? `${item.price.currency} ${item.price.amount}` : "no-price",
            ]
              .filter(Boolean)
              .join(", ");
            return `    - ${item.label} (${flags})`;
          })
          .join("\n") ?? "    - MISSING";
      return `${index + 1}. ${id} — ${group?.label ?? "not present"}\n${options}`;
    }),
  ];
  return lines.join("\n");
}

export async function crawlModel(
  page: Page,
  model: ModelTarget,
  dataDir: string,
  options: CrawlOptions,
  seenKeys: Set<string>,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id);
  await openProduct(page, model.url);
  await appendCoverage(paths.coverage, `Start crawl for ${model.name} at ${page.url()}`);

  let captured = 0;
  let skipped = 0;

  const walk = async (depth: number, path: Record<string, string>): Promise<void> => {
    if (options.maxRows !== null && captured >= options.maxRows) return;

    const groupId = BACKMARKET_GROUP_ORDER[depth];
    if (!groupId) return;

    const live = await readLivePickers(page);
    assertGbp(live.selectedOffer.price?.currency ?? live.groups.flatMap((g) => g.items.map((i) => i.price?.currency ?? ""))[0] ?? "");

    const group = live.groups.find((entry) => entry.id === groupId);
    if (!group || group.items.length === 0) {
      await appendCoverage(paths.coverage, `No options listed for ${groupId} under ${pathSummary(live.groups)}`);
      return;
    }

    const isLeaf = depth === BACKMARKET_GROUP_ORDER.length - 1;

    for (const item of group.items) {
      if (options.maxRows !== null && captured >= options.maxRows) return;

      if (!item.available || !(await isOptionEnabled(page, groupId, item))) {
        await appendCoverage(
          paths.coverage,
          `Skip unavailable ${groupId}=${item.label} under ${pathSummary(live.groups)}`,
        );
        continue;
      }

      const desired = { ...path, [groupId]: item.label };
      await selectPickerOption(page, groupId, item);
      await pause(options.delayMs);
      let after = await readLivePickers(page);
      if (!pathHolds(after.groups, desired)) {
        skipped += 1;
        await appendCoverage(
          paths.coverage,
          `Combination not stable: ${formatPath(desired)} (now ${pathSummary(after.groups)})`,
        );
        await openProduct(page, model.url);
        if (Object.keys(path).length > 0 && !(await applyPath(page, path))) {
          await appendCoverage(paths.coverage, `Could not restore parent path ${formatPath(path)}`);
          return;
        }
        continue;
      }

      if (isLeaf) {
        const row = toRow(model, await readLivePickers(page));
        if (!row) {
          skipped += 1;
          await appendCoverage(paths.coverage, `Did not save incomplete leaf at ${page.url()}`);
          continue;
        }
        const key = rowKey(row);
        if (seenKeys.has(key)) {
          skipped += 1;
          continue;
        }
        await appendRow(paths, row);
        seenKeys.add(key);
        captured += 1;
        console.log(`  ${captured}. ${row.condition} | ${row.battery} | ${row.storage} | ${row.simType} | ${row.colour} | ${row.status} ${row.price}`);
      } else {
        await walk(depth + 1, desired);
      }
    }
  };

  await walk(0, {});
  await appendCoverage(paths.coverage, `Finished crawl for ${model.name}: captured=${captured} skipped=${skipped}`);
  return { captured, skipped };
}

function toRow(model: ModelTarget, live: Awaited<ReturnType<typeof readLivePickers>>): CaptureRow | null {
  const condition = selectedLabel(live.groups, "grades");
  const battery = selectedLabel(live.groups, "battery");
  const storage = selectedLabel(live.groups, "storage");
  const simType = selectedLabel(live.groups, "dual_sim");
  const colour = selectedLabel(live.groups, "color");
  const price = live.selectedOffer.price;

  if (!condition || !battery || !storage || !simType || !colour) {
    return null;
  }
  if (!live.selectedOffer.isOutOfStock && !price?.amount) {
    return null;
  }
  if (price?.currency && price.currency !== "GBP") {
    throw new Error(`Non-GBP price (${price.currency}) at ${live.url}`);
  }

  const notes = [
    live.selectedOffer.discountRate ? `discount ${live.selectedOffer.discountRate}` : null,
    live.selectedOffer.offerId ? `offer ${live.selectedOffer.offerId}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return {
    site: "Back Market",
    capturedAt: new Date().toISOString(),
    model: live.modelName || model.name,
    battery,
    condition,
    storage,
    simType,
    colour,
    price: live.selectedOffer.isOutOfStock ? "" : (price?.amount ?? ""),
    currency: "GBP",
    status: live.selectedOffer.isOutOfStock ? "Out of stock" : "Available",
    listPrice: live.selectedOffer.listPrice?.amount ?? "",
    warranty: live.selectedOffer.warranty ?? "",
    sku: live.selectedOffer.sku ?? "",
    url: live.url,
    notes,
  };
}

function pathSummary(groups: Awaited<ReturnType<typeof readLivePickers>>["groups"]): string {
  return BACKMARKET_GROUP_ORDER.map((id) => `${id}=${selectedLabel(groups, id) || "?"}`).join(" > ");
}

function formatPath(path: Record<string, string>): string {
  return BACKMARKET_GROUP_ORDER.map((id) => `${id}=${path[id] ?? "?"}`).join(" > ");
}

function pathHolds(groups: Awaited<ReturnType<typeof readLivePickers>>["groups"], path: Record<string, string>): boolean {
  return Object.entries(path).every(([id, label]) => selectedLabel(groups, id) === label);
}

async function applyPath(page: Page, path: Record<string, string>): Promise<boolean> {
  for (const groupId of BACKMARKET_GROUP_ORDER) {
    const wanted = path[groupId];
    if (!wanted) continue;
    const live = await readLivePickers(page);
    if (selectedLabel(live.groups, groupId) === wanted) continue;
    const item = live.groups.find((group) => group.id === groupId)?.items.find((entry) => entry.label === wanted);
    if (!item) return false;
    await selectPickerOption(page, groupId, item);
    const after = await readLivePickers(page);
    if (selectedLabel(after.groups, groupId) !== wanted) return false;
  }
  return pathHolds((await readLivePickers(page)).groups, path);
}

function assertGbp(currency: string): void {
  if (currency && currency !== "GBP") {
    throw new Error(`Store is not GBP (got ${currency}). Aborting.`);
  }
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

