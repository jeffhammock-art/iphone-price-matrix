import type { Page } from "playwright";

export const REFURBED_SELECT_ORDER = [
  "product-grade",
  "product-battery",
  "product-storage",
  "product-color",
  "sim",
] as const;

// Map select id -> dashboard attribute
export function attrForSelect(selectId: string): string {
  switch (selectId) {
    case "product-grade": return "condition";
    case "product-battery": return "battery";
    case "product-storage": return "storage";
    case "product-color": return "colour";
    case "sim": return "simType";
    default: return "unknown";
  }
}

/** Strip a trailing price delta ("Good-£10.01" -> "Good"). */
export function stripPriceDelta(text: string): string {
  return text.replace(/[+-]£[\d,.]+/g, "").trim();
}

export function parsePrice(text: string | undefined | null): string {
  if (!text) return "";
  const match = text.match(/£([\d,.]+)/);
  return match ? match[1].replace(",", "") : "";
}

export function absoluteUrl(origin: string, path: string): string {
  if (path.startsWith("http")) return path;
  return `${origin}${path}`;
}

export interface RefurbedOption {
  url: string;
  label: string;
  delta: number;
}

export interface RefurbedSelectInfo {
  id: string;
  defaults: Map<string, string>; // optionVal -> cleaned label
  defaultSelected: string; // optionVal
  options: RefurbedOption[];
}

/** Parse a price delta like "+£33.59" -> +33.59 ; "-£12.62" -> -12.62. */
export function parseDelta(label: string): number {
  const m = label.match(/([+-])£([\d,.]+)/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * parseFloat(m[2].replace(",", ""));
}

/**
 * Expand the "Available in other configurations" section so all selector
 * options are visible, then read every <select> and its <option>s.
 */
export async function readAllSelects(page: Page): Promise<RefurbedSelectInfo[]> {
  // Expand "Available in other configurations" if present
  try {
    const oc = page.locator('text=/Available in other configurations/i').first();
    if (await oc.count() > 0) {
      await oc.click();
      await page.waitForTimeout(1200);
    }
  } catch {
    // Not present — ignore
  }

  const result: RefurbedSelectInfo[] = [];
  const selects = page.locator("select");
  const count = await selects.count();

  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    let id = (await sel.getAttribute("id"))?.trim() ?? "";
    // Unnamed select is the SIM picker (last one typically)
    if (!id) id = "sim";

    const opts = sel.locator("option");
    const optCount = await opts.count();
    if (optCount === 0) continue;

    const info: RefurbedSelectInfo = {
      id,
      defaults: new Map(),
      defaultSelected: "",
      options: [],
    };

    // The select's current value is the most reliable "selected" indicator.
    let currentValue = "";
    try { currentValue = await sel.inputValue(); } catch { currentValue = ""; }

    for (let j = 0; j < optCount; j++) {
      const opt = opts.nth(j);
      const url = (await opt.getAttribute("value"))?.trim() ?? "";
      const rawLabel = (await opt.textContent())?.trim() ?? "";
      const label = stripPriceDelta(rawLabel);
      const delta = parseDelta(rawLabel);
      if (label) info.defaults.set(url, label);
      if (currentValue && url === currentValue) {
        info.defaultSelected = url;
      }
      if (url) info.options.push({ url, label, delta });
    }
    result.push(info);
  }

  return result;
}

/** Read the current base price shown on the page. */
export async function readBasePrice(page: Page): Promise<string> {
  try {
    const el = page.locator(".text-2xl.font-semibold").first();
    const text = await el.textContent();
    return parsePrice(text?.trim());
  } catch {
    return "";
  }
}