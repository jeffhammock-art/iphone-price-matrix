import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CaptureRow, ConfiguratorState, CrawlOptions, LivePickers, ModelTarget, PickerPrice } from "../../types.js";
import { rowKey } from "../../types.js";
import { appendCoverage, appendRow, finalizeCsv, modelPaths } from "../../store.js";
import { writeHeartbeat } from "../../heartbeat.js";
import { isDenylisted, isLeafPath, loadHealState, pruneHealState } from "../../heal.js";
import { chromeProfileDir, releaseChromeProfile } from "../../chrome-profile.js";
import { BACKMARKET_GROUP_ORDER, assertUkStore, dismissCookies, readLivePickers } from "./page.js";
import { RateLimitError, STALL_ABORT_AFTER, backoffOnBlock, paceNetwork, registerBlock, browserId } from "../../rate-limit.js";
import {
  configuratorReady,
  describeOptions,
  ensureValues,
  inventoryGroupUntilStable,
  readInventory,
  selectByValueDetailed,
  valuesHold,
  waitForConfiguratorStable,
} from "./inventory.js";

const profileDir = chromeProfileDir;

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
  let lastError: unknown = new Error("Could not launch Chrome.");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(profileDir, { channel: "chrome", ...options });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/existing browser session|ProcessSingleton|profile is already in use/i.test(message) && attempt === 1) {
        try {
          return await chromium.launchPersistentContext(profileDir, options);
        } catch (bundled) {
          lastError = bundled;
        }
      }
      await releaseChromeProfile();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function withBrowserContext<T>(
  headed: boolean,
  fn: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await launchContext(headed);
  // Context-level init: applies to every page created from this context,
  // including the parallel worker tabs.
  await context.addInitScript(`
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  `);
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}

export async function withBrowser<T>(headed: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
  return withBrowserContext(headed, async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    return fn(page);
  });
}

export async function openProduct(page: Page, url: string): Promise<void> {
  let lastError: unknown = new Error(`Could not open ${url}`);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await openProductOnce(page, url);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof RateLimitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/403|429|forbidden|too many|challenge/i.test(message)) {
        // Confirmed block → escalate to backoff; may throw RateLimitError.
        await backoffOnBlock();
      } else {
        await waitForHumanChallenge(page).catch(() => undefined);
      }
      await pause(1200 * attempt);
    }
  }
  if (lastError instanceof RateLimitError) throw lastError;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function openProductOnce(page: Page, url: string): Promise<void> {
  // Rate-limit guard: enforce a minimum wall-clock gap between page loads.
  await paceNetwork(page);
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForHumanChallenge(page);
  const status = response?.status() ?? 0;
  if (status === 403 || status === 429 || status === 401) {
    registerBlock(`status ${status}`);
    throw new Error(
      `Back Market blocked the browser (HTTP ${status}). Keep Chrome open and complete any bot check, then re-run.`,
    );
  }
  // Challenge / WAF bounce detection: the site redirects to /en-gb/help or a
  // malformed /p/gb/<uuid> when the session is under challenge.
  const landing = page.url();
  if (!landing.includes("/en-gb/p/") || /\/p\/gb\//.test(landing)) {
    registerBlock(`bounced to ${landing}`);
    throw new Error(`Blocked/redirected to unexpected URL: ${landing}`);
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
  let challenged = false;
  try {
    challenged = Boolean(
      await page.evaluate(`(
        document.title.includes("Just a moment") ||
        location.pathname.includes("testchallengepage") ||
        location.pathname.includes("cdn-cgi")
      )`),
    );
  } catch {
    return;
  }
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
  const state = await readInventory(page);
  const lines = [
    `Model: ${model.name}`,
    `URL: ${page.url()}`,
    "",
    "Inventory (radio value in brackets). Traversal is top -> bottom.",
    ...BACKMARKET_GROUP_ORDER.map((id, index) => {
      const options = state.groups[id] ?? [];
      return `${index + 1}. ${id}\n    ${describeOptions(options) || "- MISSING"}`;
    }),
  ];
  return lines.join("\n");
}

/**
 * Single-navigation health check. Loads ONE product page through the real
 * persistent Chrome profile + fingerprint and reports whether the configurator
 * boots. No walking, no clicking, one request — the safe way to confirm we're
 * unblocked after a cooldown (a plain HTTP client always 403s on Cloudflare).
 */
export async function probeModel(page: Page, model: ModelTarget): Promise<string> {
  await openProduct(page, model.url);
  const state = await readInventory(page).catch(() => null);
  const url = safePageUrl(page);
  const grades = state?.groups.grades?.length ?? 0;
  const options = state?.groups.grades?.map((o) => o.label).join("/") ?? "(none)";
  return `OK url=${url}\ngrades=${grades} [${options}]`;
}

export async function crawlModel(
  page: Page,
  model: ModelTarget,
  dataDir: string,
  options: CrawlOptions,
  seenKeys: Set<string>,
): Promise<{ captured: number; skipped: number }> {
  const paths = modelPaths(dataDir, model.id);
  const startedAt = Date.now();
  // Parallel-safe logging: every line is prefixed so interleaved model runs
  // stay readable in the shared console.
  const log = (message: string): void => console.log(`[${model.name}] ${message}`);
  let captured = 0;
  let skipped = 0;
  let needsReplay = false;
  let consecutiveStalls = 0;
  // Stall cap: if we keep hitting block/empty-settled/restore-fail at the hub,
  // throw RateLimitError to abort the model instead of retry-looping (the
  // amplifier behind the site rate-limiting us).
  const noteStall = (reason: string): void => {
    consecutiveStalls += 1;
    if (consecutiveStalls >= STALL_ABORT_AFTER) {
      throw new RateLimitError(
        `model ${model.id} stalled ${consecutiveStalls}x (${reason}) at ${safePageUrl(page)}; aborting to end the retry loop`,
      );
    }
  };
  let heal = pruneHealState(await loadHealState(dataDir));
  // P2 state-discovery: every unique settled state (labels + offerId) is a
  // graph node. Redirects that land on the same offer collapse naturally.
  const visitedStates = new Set<string>();

  const stateHash = async (): Promise<string | null> => {
    try {
      const state = await readInventory(page);
      const live = await readLivePickers(page).catch(() => null);
      const labels = BACKMARKET_GROUP_ORDER.map((id) => state.selectedLabels[id] ?? state.selected[id] ?? "?");
      return [...labels, live?.selectedOffer.offerId ?? ""].join("|");
    } catch {
      return null;
    }
  };

  const pulse = async (event: string) => {
    await writeHeartbeat(dataDir, {
      modelId: model.id,
      captured,
      skipped,
      lastEvent: event,
    });
  };
  await pulse("opening");
  await openProduct(page, model.url);
  await appendCoverage(paths.coverage, `Start crawl for ${model.name} at ${page.url()}`);
  await pulse("start");

  const restoreParents = async (path: Record<string, string>): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await pulse(`restore ${attempt} ${JSON.stringify(path)}`);
        await waitForHumanChallenge(page);
        if (!(await configuratorReady(page, 5_000))) {
          await openProduct(page, model.url);
        }
        if (Object.keys(path).length === 0) {
          return true;
        }
        // Navigation-aware replay: click -> settle -> verify per group.
        // ensureValues already settles after each click; no extra settle here.
        if (await ensureValues(page, path)) {
          return true;
        }
        // One hub reload then re-apply; if the site still corrects us this is
        // a REDIRECT signal (closestPickerConfig), handled by the caller.
        if (attempt === 1) {
          await pulse(`restore-reload ${JSON.stringify(path)}`);
          await openProduct(page, model.url);
          if (await ensureValues(page, path)) {
            return true;
          }
        }
      } catch (error) {
        await appendCoverage(
          paths.coverage,
          `ERROR restore attempt ${attempt} failed for ${JSON.stringify(path)}: ${errorMessage(error)} at ${safePageUrl(page)}`,
        );
      }
    }
    return false;
  };

  const walk = async (depth: number, path: Record<string, string>): Promise<void> => {
    if (options.maxRows !== null && captured >= options.maxRows) return;

    const groupId = BACKMARKET_GROUP_ORDER[depth];
    if (!groupId) return;

    if (!(await restoreParents(path))) {
      needsReplay = true;
      noteStall("restore-fail");
      await appendCoverage(paths.coverage, `ERROR could not restore parent path ${JSON.stringify(path)}`);
      await pulse(`restore-fail ${JSON.stringify(path)}`);
      return;
    }
    // A successfully restored branch = progress; clear the stall counter.
    consecutiveStalls = 0;

    const optionsAtBranch = await inventoryGroupUntilStable(page, groupId);
    // inventoryGroupUntilStable already settled; one read only (was 2x).
    const state = await readInventory(page).catch(() => null);
    if (!state) {
      skipped += 1;
      needsReplay = true;
      return;
    }
    await appendCoverage(
      paths.coverage,
      `Inventory ${groupId} under ${describePath(state.selectedLabels, path)}: ${describeOptions(optionsAtBranch)}`,
    );
    log(`inventory ${groupId}: ${describeOptions(optionsAtBranch)}`);
    await pulse(`inventory ${groupId}`);

    if (optionsAtBranch.length === 0) {
      // Picker group not present on this model (e.g. some variants lack a
      // dual_sim picker). Skip the empty group and walk the next depth with
      // the same path so we still reach the leaf (color) level.
      if (depth < BACKMARKET_GROUP_ORDER.length - 1) {
        await walk(depth + 1, path);
      }
      skipped += 1;
      if (Object.keys(state.selected).length === 0) needsReplay = true;
      return;
    }

    const isLeaf = depth === BACKMARKET_GROUP_ORDER.length - 1;

    for (const option of optionsAtBranch) {
      if (options.maxRows !== null && captured >= options.maxRows) return;

      try {
        if (!(await restoreParents(path))) {
          needsReplay = true;
          noteStall("lost-parent");
          await appendCoverage(paths.coverage, `Lost parent path before ${groupId}=${option.label}; continuing siblings`);
          continue;
        }
        consecutiveStalls = 0;

        if (!option.enabled) {
          await appendCoverage(paths.coverage, `OUT_OF_STOCK skip ${groupId}=${option.label}[${option.value}] (disabled/sold out)`);
          continue;
        }

        const desired = { ...path, [groupId]: option.value };
        // P1: denylist applies to leaf paths only. Non-leaf entries are
        // legacy poisoning from transient empty reads — ignore them.
        if (isLeafPath(desired) && !options.ignoreDenylist && isDenylisted(heal, desired)) {
          skipped += 1;
          await appendCoverage(paths.coverage, `OUT_OF_STOCK skip denylisted leaf ${JSON.stringify(desired)}`);
          continue;
        }

        if (isLeaf) {
          const liveState = await readInventory(page);
          const predicted = predictedRowKey(model, liveState.selectedLabels, option.label);
          if (predicted && seenKeys.has(predicted)) {
            skipped += 1;
            continue;
          }
        }

        const outcome = await selectByValueDetailed(page, groupId, option.value);
        // selectByValueDetailed already gated on settle; one verification
        // read only. No extra settle here (was the dominant per-option cost).

        let settled = await readInventory(page);
        let holds = valuesHold(settled.selected, desired);
        // /help-bounce guard (#1): the SPA occasionally lands on a non-product
        // page (observed: /en-gb/help after selecting 512 GB). That is a site
        // navigation fault, not inventory. Reload hub once + retry; only then
        // classify as BLOCKED_BY_SITE.
        if (!isProductUrl(safePageUrl(page))) {
          skipped += 1;
          noteStall("blocked-by-site");
          await appendCoverage(
            paths.coverage,
            `BLOCKED_BY_SITE non-product url after select wanted ${JSON.stringify(desired)} at ${safePageUrl(page)}; reloading hub once`,
          );
          await captureDebugArtifact(page, dataDir, model.id, desired).catch(() => undefined);
          await pulse(`blocked-by-site ${JSON.stringify(desired)}`);
          const recovered = await openProduct(page, model.url)
            .then(() => isProductUrl(safePageUrl(page)))
            .catch(() => false);
          if (!recovered) {
            needsReplay = true;
            continue;
          }
          const retry = await selectByValueDetailed(page, groupId, option.value);
          const rechecked = await readInventory(page).catch(() => null);
          if (!retry.ok || !rechecked || !valuesHold(rechecked.selected, desired)) {
            needsReplay = true;
            await appendCoverage(
              paths.coverage,
              `BLOCKED_BY_SITE still off-product after hub reload wanted ${JSON.stringify(desired)} at ${safePageUrl(page)}`,
            );
            continue;
          }
          // Refresh state post-recovery so leaf handling sees the wanted path.
          settled = rechecked;
          holds = valuesHold(settled.selected, desired);
          await appendCoverage(paths.coverage, `RECOVERED hub reload fixed non-product url for ${JSON.stringify(desired)}`);
        }
        if (!outcome.ok || !holds) {
          const now = settled;
          if (Object.keys(now.selected).length === 0) {
            // P1: empty snapshot after settle is a sync failure, NOT inventory.
            // Log EMPTY_SETTLED with artifact; do NOT denylist. Retry via replay.
            skipped += 1;
            needsReplay = true;
            noteStall("empty-settled");
            await appendCoverage(
              paths.coverage,
              `ERROR empty settled pickers after settled select wanted ${JSON.stringify(desired)} at ${safePageUrl(page)}`,
            );
            await captureDebugArtifact(page, dataDir, model.id, desired).catch(() => undefined);
            await pulse(`empty-settled ${JSON.stringify(desired)}`);
            await openProduct(page, model.url);
            continue;
          }
          if (outcome.redirected || !holds) {
            // P2: closestPickerConfig correction is inventory signal. Record
            // the redirect and continue exploring the ACTUAL state.
            const hash = await stateHash();
            if (hash && visitedStates.has(hash)) {
              skipped += 1;
              await appendCoverage(
                paths.coverage,
                `REDIRECTED wanted ${JSON.stringify(desired)} now ${JSON.stringify(now.selected)} (${describePath(now.selectedLabels, now.selected)}) already visited ${hash}`,
              );
              await pulse(`redirected-visited ${JSON.stringify(desired)}`);
              continue;
            }
            if (hash) visitedStates.add(hash);
            await appendCoverage(
              paths.coverage,
              `REDIRECTED wanted ${JSON.stringify(desired)} now ${JSON.stringify(now.selected)} (${describePath(now.selectedLabels, now.selected)}) @ ${safePageUrl(page)}`,
            );
            await pulse(`redirected ${JSON.stringify(desired)}`);
            if (isLeaf) {
              const row = await captureRow(page, model);
              if (!row) {
                skipped += 1;
                await appendCoverage(paths.coverage, `ERROR did not save redirected leaf at ${safePageUrl(page)}`);
                continue;
              }
              row.notes = [`redirected from ${JSON.stringify(desired)}`, row.notes].filter(Boolean).join("; ");
              const key = rowKey(row);
              if (seenKeys.has(key)) {
                skipped += 1;
                continue;
              }
              try {
                await appendRow(paths, row);
              } catch (error) {
                skipped += 1;
                await appendCoverage(
                  paths.coverage,
                  `ERROR schema gate rejected redirected leaf: ${errorMessage(error)} at ${safePageUrl(page)}`,
                );
                await captureDebugArtifact(page, dataDir, model.id, desired).catch(() => undefined);
                continue;
              }
              seenKeys.add(key);
              captured += 1;
              await pulse(`saved ${key}`);
              console.log(
                `  ${captured}. ${row.condition} | ${row.battery} | ${row.storage} | ${row.simType} | ${row.colour} | ${row.status} ${row.price}`,
              );
            } else {
              // Explore the actual corrected prefix instead of the wanted one.
              await walk(depth + 1, { ...now.selected });
            }
            continue;
          }
        }

        if (isLeaf) {
          // Colour-level fan-out: the colour inventory already lists the price
          // of every sibling colour (your screenshot observation). Save one row
          // per enabled colour from this single settled state instead of
          // clicking each colour (5x navigations per leaf prefix).
          const leafState = settled.selected ? settled : await readInventory(page);
          const leafLive = await readLivePickers(page).catch(() => null);
          const colourOptions = leafState.groups.color ?? [];
          if (colourOptions.length > 0 && leafLive) {
            let savedAny = false;
            for (const colour of colourOptions) {
              if (!colour.enabled) {
                skipped += 1;
                await appendCoverage(
                  paths.coverage,
                  `OUT_OF_STOCK skip color=${colour.label}[${colour.value}] (disabled/sold out)`,
                );
                continue;
              }
              const row = buildRowFromLeafState(
                model,
                leafState,
                leafLive,
                colour.label,
                colour.price,
                leafLive.selectedOffer.isOutOfStock ? "" : undefined,
              );
              if (!row) {
                skipped += 1;
                await appendCoverage(paths.coverage, `ERROR did not save fan-out leaf ${colour.label} at ${safePageUrl(page)}`);
                continue;
              }
              if (!outcome.ok || !holds) {
                row.notes = [`redirected from ${JSON.stringify(desired)}`, row.notes].filter(Boolean).join("; ");
              }
              row.notes = [`sibling price (no colour click)`, row.notes].filter(Boolean).join("; ");
              const key = rowKey(row);
              if (seenKeys.has(key)) {
                skipped += 1;
                continue;
              }
              try {
                await appendRow(paths, row);
              } catch (error) {
                skipped += 1;
                await appendCoverage(
                  paths.coverage,
                  `ERROR schema gate rejected fan-out leaf ${colour.label}: ${errorMessage(error)} at ${safePageUrl(page)}`,
                );
                await captureDebugArtifact(page, dataDir, model.id, desired).catch(() => undefined);
                continue;
              }
              seenKeys.add(key);
              captured += 1;
              savedAny = true;
              await pulse(`saved ${key}`);
              log(
                `${captured}. ${row.condition} | ${row.battery} | ${row.storage} | ${row.simType} | ${row.colour} | ${row.status} ${row.price}`,
              );
              if (options.maxRows !== null && captured >= options.maxRows) return;
            }
            const hash = await stateHash();
            if (hash) visitedStates.add(hash);
            if (!savedAny) {
              await appendCoverage(paths.coverage, `ERROR did not save fan-out leaf at ${safePageUrl(page)}`);
            }
            continue;
          }
          const row = await captureRow(page, model);
          if (!row) {
            skipped += 1;
            await appendCoverage(paths.coverage, `ERROR did not save incomplete leaf at ${safePageUrl(page)}`);
            continue;
          }
          const hash = await stateHash();
          if (hash) {
            if (visitedStates.has(hash)) {
              skipped += 1;
              continue;
            }
            visitedStates.add(hash);
          }
          const key = rowKey(row);
          if (seenKeys.has(key)) {
            skipped += 1;
            continue;
          }
          try {
            await appendRow(paths, row);
          } catch (error) {
            skipped += 1;
            await appendCoverage(
              paths.coverage,
              `ERROR schema gate rejected leaf: ${errorMessage(error)} at ${safePageUrl(page)}`,
            );
            await captureDebugArtifact(page, dataDir, model.id, desired).catch(() => undefined);
            continue;
          }
          seenKeys.add(key);
          captured += 1;
          await pulse(`saved ${key}`);
          log(
            `${captured}. ${row.condition} | ${row.battery} | ${row.storage} | ${row.simType} | ${row.colour} | ${row.status} ${row.price}`,
          );
        } else {
          await walk(depth + 1, desired);
        }
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        skipped += 1;
        needsReplay = true;
        await appendCoverage(
          paths.coverage,
          `ERROR recoverable at ${groupId}=${option.label}: ${errorMessage(error)} (${safePageUrl(page)})`,
        );
        console.warn(`[${model.name}] recoverable: ${groupId}=${option.label}: ${errorMessage(error)}`);
        await restoreParents(path);
      }
    }
  };

  for (let pass = 1; pass <= 3; pass += 1) {
    needsReplay = false;
    try {
      if (pass > 1) {
        await appendCoverage(paths.coverage, `Restarting walk from hub (pass ${pass})`);
        log(`restarting from hub (pass ${pass})`);
        await openProduct(page, model.url);
      }
      await walk(0, {});
      // Speed fix (a): CSV rebuilt once per pass, not once per row.
      await finalizeCsv(paths).catch(() => undefined);
      if (!needsReplay) break;
      if (pass < 3) {
        await appendCoverage(paths.coverage, `Pass ${pass} finished with gaps; replaying from hub`);
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      needsReplay = true;
      await appendCoverage(
        paths.coverage,
        `ERROR crash pass ${pass}: ${errorMessage(error)} at ${safePageUrl(page)}`,
      );
      console.error(`[${model.name}] crawl pass ${pass} crashed: ${errorMessage(error)}`);
      if (pass === 3) {
        await appendCoverage(
          paths.coverage,
          `Aborted after 3 passes for ${model.name}: captured=${captured} skipped=${skipped}`,
        );
        await finalizeCsv(paths).catch(() => undefined);
        return { captured, skipped };
      }
    }
  }

  if (page.isClosed()) {
    await appendCoverage(
      paths.coverage,
      `Aborted for ${model.name}: browser closed captured=${captured} skipped=${skipped}`,
    );
    await finalizeCsv(paths).catch(() => undefined);
    throw new Error("Browser closed before the walk completed.");
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  await appendCoverage(
    paths.coverage,
    `Finished crawl for ${model.name}: captured=${captured} skipped=${skipped} durationSec=${durationSec}`,
  );
  log(`finished: +${captured} new, ${skipped} skipped in ${durationSec}s`);
  return { captured, skipped };
}

function describePath(labels: Record<string, string>, values: Record<string, string>): string {
  return BACKMARKET_GROUP_ORDER.map((id) => {
    if (!values[id]) return null;
    return `${labels[id] ?? id}=${values[id]}`;
  })
    .filter(Boolean)
    .join(" > ");
}

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "(no url: target closed)";
  }
}

export function isProductUrl(url: string): boolean {
  return url.includes("backmarket.co.uk") && url.includes("/en-gb/p/");
}

async function captureDebugArtifact(page: Page, dataDir: string, modelId: string, path: Record<string, string>): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(dataDir, "debug");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const base = join(dir, `${modelId}-${stamp}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: false });
  } catch {
    // screenshot is best-effort
  }
  try {
    await writeFile(`${base}.html`, await page.content(), "utf8");
  } catch {
    // html dump is best-effort
  }
  try {
    await writeFile(`${base}.json`, JSON.stringify({ ts: new Date().toISOString(), modelId, path, url: safePageUrl(page) }, null, 2), "utf8");
  } catch {
    // meta dump is best-effort
  }
}

async function settleValues(page: Page, path: Record<string, string>): Promise<boolean> {
  // Legacy fixed-poll replaced by waitForConfiguratorStable (P1).
  // Kept as thin wrapper for callers not yet migrated.
  const settled = await waitForConfiguratorStable(page, 8000).catch(() => null);
  if (!settled) return valuesHold((await readInventory(page).catch(() => ({ selected: {} }) as never)).selected ?? {}, path);
  const state = await readInventory(page).catch(() => null);
  if (!state) return false;
  return valuesHold(state.selected, path);
}

function predictedRowKey(
  model: ModelTarget,
  parentLabels: Record<string, string>,
  colourLabel: string,
): string | null {
  const condition = parentLabels.grades ?? "";
  const battery = parentLabels.battery ?? "";
  const storage = parentLabels.storage ?? "";
  const simType = parentLabels.dual_sim ?? "Unknown";
  if (!condition || !battery || !storage || !simType || !colourLabel) return null;
  return rowKey({
    site: "Back Market",
    model: model.name,
    battery,
    condition,
    storage,
    simType,
    colour: colourLabel,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function captureRow(page: Page, model: ModelTarget): Promise<CaptureRow | null> {
  await waitForConfiguratorStable(page, 4000).catch(() => null);
  const state = await readInventory(page);
  let live;
  try {
    live = await readLivePickers(page);
  } catch {
    return null;
  }
  return buildRowFromLeafState(
    model,
    state,
    live,
    state.selectedLabels.color ?? "",
    state.groups.color?.find((option) => option.selected)?.price ?? null,
  );
}

function buildRowFromLeafState(
  model: ModelTarget,
  state: ConfiguratorState,
  live: LivePickers,
  colourLabel: string,
  colourPrice: PickerPrice | null,
  priceOverride?: string,
): CaptureRow | null {
  const condition = state.selectedLabels.grades ?? "";
  const battery = state.selectedLabels.battery ?? "";
  const storage = state.selectedLabels.storage ?? "";
  const simType = state.selectedLabels.dual_sim ?? "Unknown";
  const colour = colourLabel;
  const listed = colourPrice ?? live.selectedOffer.price;

  if (!condition || !battery || !storage || !colour) return null;
  if (!live.selectedOffer.isOutOfStock && !listed?.amount) return null;
  if (listed?.currency && listed.currency !== "GBP") {
    return null;
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
    model: model.name,
    battery,
    condition,
    storage,
    simType,
    colour,
    price: priceOverride ?? (live.selectedOffer.isOutOfStock ? "" : (listed?.amount ?? "")),
    currency: "GBP",
    status: live.selectedOffer.isOutOfStock ? "Out of stock" : "Available",
    listPrice: live.selectedOffer.listPrice?.amount ?? "",
    warranty: live.selectedOffer.warranty ?? "",
    sku: live.selectedOffer.sku ?? "",
    url: live.url || "",
    notes,
  };
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
