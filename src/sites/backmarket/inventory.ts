import type { Page } from "playwright";
import type { ConfiguratorState, InventoriedOption } from "../../types.js";

const GROUP_ORDER = ["grades", "battery", "storage", "dual_sim", "color"] as const;

// Single source of truth for labels lives in ./labels.ts (TS side).
// The string below is its injected-JS mirror — keep behaviour identical.
// Any change to canonicalize() in labels.ts must be ported here.
const CANONICALIZE_JS = `
  const canonicalize = (groupId, label, trackingValue) => {
    const raw = String(label || "").trim();
    const value = trackingValue == null ? "" : String(trackingValue).trim();
    const combined = (raw + " " + value).trim();
    const grades = { "12": "Fair", "11": "Good", "10": "Excellent", "9": "Premium" };
    if (groupId === "grades") {
      if (grades[raw]) return grades[raw];
      if (grades[value]) return grades[value];
      const named = combined.match(/\\b(fair|good|excellent|premium)\\b/i);
      if (named && named[1]) return named[1].charAt(0).toUpperCase() + named[1].slice(1).toLowerCase();
      return raw;
    }
    if (groupId === "battery") {
      const text = combined.toLowerCase();
      if (/\\bnew\\b/.test(text)) return "New";
      if (/\\bgreat\\b/.test(text)) return "Great";
      if (/standard/.test(text)) return "Standard";
      if (/\\bgood\\b/.test(text)) return "Good";
      return raw;
    }
    if (groupId === "storage") {
      const tb = combined.match(/([\\d.]+)\\s*tb/i);
      if (tb && tb[1]) return tb[1] + " TB";
      const gb = combined.match(/(\\d+)\\s*gb/i) || combined.match(/\\b(\\d{2,4})\\b/);
      if (gb && gb[1]) return gb[1] + " GB";
      return raw;
    }
    if (groupId === "dual_sim") {
      const text = combined.toLowerCase();
      if (text.includes("dual")) return "Dual Physical SIM";
      if (text.includes("physical") && text.includes("esim")) return "Physical SIM + eSIM";
      if (text.includes("esim")) return "eSIM";
      return raw;
    }
    return raw;
  };
`;

const INVENTORY_SCRIPT = `(() => {
  const groupIds = ["grades", "battery", "storage", "dual_sim", "color"];
  const parseGbp = (text) => {
    if (!text) return null;
    const match = String(text).replaceAll(/\\s/g, "").match(/£(\\d[\\d,]*(?:\\.\\d{2})?)/);
    if (!match || !match[1]) return null;
    const amount = match[1].replaceAll(",", "");
    return {
      amount: amount.includes(".") ? Number(amount).toFixed(2) : amount + ".00",
      currency: "GBP",
    };
  };
  ${CANONICALIZE_JS}

  const groups = {};
  const selected = {};
  const selectedLabels = {};
  for (const id of groupIds) {
    const options = [...document.querySelectorAll('input[name="step-' + id + '"]')].map((input) => {
      const text = input.closest("label") ? input.closest("label").innerText : "";
      const lines = text.split("\\n").map((line) => line.trim()).filter(Boolean);
      const soldOut = /sold out/i.test(text);
      const rawLabel = lines.find((line) => !/^£/.test(line) && !/^popular$/i.test(line)) || lines[0] || String(input.value);
      const label = canonicalize(id, rawLabel, input.value);
      if (input.checked) {
        selected[id] = String(input.value);
        selectedLabels[id] = label;
      }
      return {
        groupId: id,
        value: String(input.value),
        label,
        enabled: !input.disabled && !soldOut,
        soldOut,
        selected: input.checked,
        price: parseGbp(text),
      };
    });
    groups[id] = options;
  }
  return { groups, selected, selectedLabels };
})()`;

// Lightweight snapshot for the settle gate: no labels, no prices.
// Keyed off picker state (selected values + radio count), NOT full DOM.
const SNAPSHOT_SCRIPT = `(() => {
  const inputs = [...document.querySelectorAll('input[name^="step-"]')];
  const selected = {};
  for (const input of inputs) {
    const m = String(input.name || "").match(/^step-(.+)$/);
    if (m && m[1] && input.checked) selected[m[1]] = String(input.value);
  }
  return { count: inputs.length, selected: selected };
})()`;

function cssEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function radioByValue(groupId: string, value: string): string {
  return `input[name="step-${groupId}"][value="${cssEscape(value)}"]`;
}

const EMPTY_STATE: ConfiguratorState = { groups: {}, selected: {}, selectedLabels: {} };

export async function configuratorReady(page: Page, timeoutMs = 20_000): Promise<boolean> {
  try {
    await page.waitForSelector('input[name="step-grades"]', { state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function snapshot(page: Page): Promise<{ count: number; selected: Record<string, string>; url: string } | null> {
  try {
    const snap = (await page.evaluate(SNAPSHOT_SCRIPT)) as { count: number; selected: Record<string, string> };
    return { ...snap, url: page.url() };
  } catch {
    return null;
  }
}

/**
 * One-evaluate read of the whole picker state. Used by ensureValues to diff
 * an entire path in a single round-trip (was 4-5 evaluates per restore).
 */
export async function readSelectedSnapshot(
  page: Page,
): Promise<{ count: number; selected: Record<string, string> } | null> {
  try {
    return (await page.evaluate(SNAPSHOT_SCRIPT)) as { count: number; selected: Record<string, string> };
  } catch {
    return null;
  }
}

export interface SettleResult {
  stable: boolean;
  snapshot: { count: number; selected: Record<string, string>; url: string } | null;
}

/**
 * P1 settle primitive (reviewer-approved, tightened):
 *   stable = configuratorReady()
 *          && selected unchanged 2x consecutive
 *          && picker count unchanged 2x
 *          && no navigation for 1000ms
 *
 * Keyed off picker state, NOT full DOM — Nuxt keeps mutating the DOM long
 * after selections are readable, so full-DOM quiet would hang.
 */
export async function waitForConfiguratorStable(page: Page, timeoutMs = 6000): Promise<SettleResult> {
  const started = Date.now();
  const firstUrl = safeUrl(page);
  let urlStableSince = Date.now();
  let currentUrl = firstUrl;
  let prev: { count: number; selected: Record<string, string> } | null = null;
  let repeats = 0;
  let last: { count: number; selected: Record<string, string>; url: string } | null = null;

  const ready = await configuratorReady(page, 2000).catch(() => false);
  if (!ready) {
    // Configurator not booted; caller decides (reload hub). Don't burn timeout.
    return { stable: false, snapshot: last };
  }

  while (Date.now() - started < timeoutMs) {
    const snap = await snapshot(page);
    if (!snap) {
      prev = null;
      repeats = 0;
      await sleep(150);
      continue;
    }
    last = snap;

    const now = Date.now();
    if (snap.url !== currentUrl) {
      currentUrl = snap.url;
      urlStableSince = now;
    }
    const urlQuietMs = now - urlStableSince;

    const sig = `${snap.count}|${JSON.stringify(snap.selected)}`;
    const prevSig = prev ? `${prev.count}|${JSON.stringify(prev.selected)}` : null;
    repeats = sig === prevSig ? repeats + 1 : 0;
    prev = { count: snap.count, selected: snap.selected };

    // ready checked once up-front; per-iteration waitForSelector was the
    // dominant cost (~2s x N iterations). Picker count > 0 is the live check.
    if (repeats >= 1 && snap.count > 0 && urlQuietMs >= 1000) {
      // selected + count unchanged twice in a row + URL quiet 1s + radios present
      return { stable: true, snapshot: snap };
    }
    await sleep(150);
  }
  return { stable: false, snapshot: last };
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluateState(page: Page): Promise<ConfiguratorState> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await page.evaluate(INVENTORY_SCRIPT)) as ConfiguratorState;
    } catch {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      if (!(await configuratorReady(page, 6000))) {
        continue;
      }
    }
  }
  return EMPTY_STATE;
}

export async function readInventory(page: Page): Promise<ConfiguratorState> {
  return evaluateState(page);
}

export async function inventoryGroupUntilStable(
  page: Page,
  groupId: string,
): Promise<InventoriedOption[]> {
  // Settle on picker state first; only then read full inventory once.
  await waitForConfiguratorStable(page, 5000).catch(() => null);
  return (await evaluateState(page)).groups[groupId] ?? [];
}

export function valuesHold(selected: Record<string, string>, path: Record<string, string>): boolean {
  return Object.entries(path).every(([groupId, value]) => selected[groupId] === value);
}

export interface SelectOutcome {
  ok: boolean;
  redirected: boolean;
  actualValue: string | null;
  actualUrl: string;
}

/**
 * P1 navigation-aware select: click -> domcontentloaded -> ready ->
 * waitForConfiguratorStable() -> verify. Never trusts a fixed delay.
 */
export async function selectByValue(page: Page, groupId: string, value: string, timeoutMs = 15_000): Promise<boolean> {
  return (await selectByValueDetailed(page, groupId, value, timeoutMs)).ok;
}

export async function selectByValueDetailed(
  page: Page,
  groupId: string,
  value: string,
  timeoutMs = 10_000,
): Promise<SelectOutcome> {
  const fail = (redirected: boolean, actualValue: string | null): SelectOutcome => ({
    ok: false,
    redirected,
    actualValue,
    actualUrl: safeUrl(page),
  });
  try {
    if (!(await configuratorReady(page, 5_000))) return fail(false, null);
    // Fast path: already selected. One settle check, no extra 6s pre-settle.
    const pre = await evaluateState(page);
    if (pre.selected[groupId] === value) {
      return { ok: true, redirected: false, actualValue: value, actualUrl: safeUrl(page) };
    }

    const selector = radioByValue(groupId, value);
    const radio = page.locator(selector).first();
    if ((await radio.count()) === 0) return fail(false, pre.selected[groupId] ?? null);

    try {
      await radio.click({ force: true, timeout: 8000 });
    } catch {
      const label = page.locator(`label:has(${selector})`).first();
      if ((await label.count()) === 0) return fail(false, pre.selected[groupId] ?? null);
      await label.click({ timeout: 8000 });
    }

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    if (!(await configuratorReady(page, timeoutMs))) return fail(false, null);
    const settled = await waitForConfiguratorStable(page, timeoutMs);
    if (!settled.stable) return fail(false, settled.snapshot?.selected[groupId] ?? null);
    const after = await evaluateState(page);
    const actual = after.selected[groupId] ?? null;
    if (actual === value) {
      return { ok: true, redirected: false, actualValue: actual, actualUrl: safeUrl(page) };
    }
    return { ok: false, redirected: actual !== null, actualValue: actual, actualUrl: safeUrl(page) };
  } catch {
    return fail(false, null);
  }
}

export async function ensureValues(page: Page, path: Record<string, string>): Promise<boolean> {
  try {
    if (!(await configuratorReady(page, 5_000))) return false;
    // One evaluate diffs the whole path; only mismatched groups get clicked
    // (was 4-5 evaluate round-trips per restore when the path already held).
    const snap = await readSelectedSnapshot(page);
    if (!snap || snap.count === 0) return false;
    const mismatches = GROUP_ORDER.filter((groupId) => {
      const wanted = path[groupId];
      return wanted && snap.selected[groupId] !== wanted;
    });
    if (mismatches.length === 0) {
      return valuesHold(snap.selected, path);
    }
    // mismatches preserve GROUP_ORDER depth-order (parents before children).
    for (const groupId of mismatches) {
      const wanted = path[groupId];
      if (!wanted) continue;
      const outcome = await selectByValueDetailed(page, groupId, wanted);
      if (!outcome.ok) return false;
    }
    return valuesHold((await evaluateState(page)).selected, path);
  } catch {
    return false;
  }
}

export function describeOptions(options: InventoriedOption[]): string {
  if (options.length === 0) return "(none)";
  return options
    .map((option) => {
      const flags = [
        option.selected ? "on" : null,
        option.enabled ? null : "disabled",
        option.soldOut ? "sold-out" : null,
        option.price ? `£${option.price.amount}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `${option.label}[${option.value}]${flags ? ` (${flags})` : ""}`;
    })
    .join("; ");
}
