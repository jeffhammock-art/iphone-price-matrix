import type { Page } from "playwright";
import type { LivePickers, PickerGroup, PickerItem } from "../../types.js";
import { labelsEqual } from "./labels.js";

interface RawPickerPrice {
  amount?: string;
  currency?: string;
}

interface RawPickerItem {
  label?: string;
  available?: boolean;
  acquirable?: boolean;
  selected?: boolean;
  price?: RawPickerPrice | null;
  productId?: string | null;
  slug?: string | null;
  trackingValue?: string | number | null;
}

interface RawPickerGroup {
  id?: string;
  label?: string;
  items?: RawPickerItem[];
}

interface RawSelectedOffer {
  price?: RawPickerPrice | null;
  discount?: { price?: RawPickerPrice | null; rate?: string | null } | null;
  defaultWarrantyDelay?: string | null;
  newBattery?: { status?: string | null } | null;
  sku?: string | null;
  offerId?: string | null;
}

interface RawPickersPayload {
  pickerGroups?: RawPickerGroup[];
  selectedOffer?: RawSelectedOffer | null;
  isOutOfStock?: boolean;
}

interface RawProductPayload {
  titles?: { default?: string; raw?: string } | null;
  priceWhenNew?: RawPickerPrice | null;
}

export const BACKMARKET_GROUP_ORDER = [
  "grades",
  "battery",
  "storage",
  "dual_sim",
  "color",
] as const;

export type BackMarketGroupId = (typeof BACKMARKET_GROUP_ORDER)[number];

export async function dismissCookies(page: Page): Promise<void> {
  const reject = page.getByRole("button", { name: /^Reject all$/i });
  try {
    await reject.click({ timeout: 4000 });
  } catch {
    const accept = page.getByRole("button", { name: /^Accept all$/i });
    try {
      await accept.click({ timeout: 1500 });
    } catch {
      // Banner may already be gone.
    }
  }
}

export async function assertUkStore(page: Page): Promise<void> {
  const url = page.url();
  if (!url.includes("backmarket.co.uk") || !url.includes("/en-gb/")) {
    throw new Error(`Not on the UK English storefront: ${url}`);
  }
}

const READ_PICKERS_SCRIPT = `(() => {
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

  const fromDom = () => {
    const groups = groupIds
      .map((id) => {
        const inputs = [...document.querySelectorAll('input[name="step-' + id + '"]')];
        return {
          id,
          label: id,
          items: inputs.map((input) => {
            const text = input.closest("label") ? input.closest("label").innerText : "";
            const lines = text.split("\\n").map((line) => line.trim()).filter(Boolean);
            const soldOut = /sold out/i.test(text);
            const rawLabel = lines.find((line) => !/^£/.test(line) && !/^popular$/i.test(line)) || lines[0] || String(input.value);
            return {
              label: canonicalize(id, rawLabel, input.value),
              available: !input.disabled && !soldOut,
              acquirable: !soldOut,
              selected: input.checked,
              price: parseGbp(text),
              productId: null,
              slug: null,
              trackingValue: input.value,
            };
          }),
        };
      })
      .filter((group) => group.items.length > 0);

    const selectedItems = groups.flatMap((group) => group.items.filter((item) => item.selected));
    const leaf = selectedItems.slice().reverse()[0];
    const listMatch = document.body.innerText.match(/£[\\d,.]+\\s*new/i);
    const warrantyMatch = document.body.innerText.match(/\\d+\\s+months?[^.\\n]{0,40}warranty/i);
    const heading = document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : "Unknown model";

    return {
      groups,
      selectedOffer: {
        price: leaf && leaf.price ? leaf.price : null,
        listPrice: parseGbp(listMatch ? listMatch[0] : ""),
        discountRate: null,
        warranty: warrantyMatch ? warrantyMatch[0] : null,
        newBattery: null,
        isOutOfStock: Boolean(leaf && !leaf.acquirable),
        sku: null,
        offerId: null,
      },
      modelName: heading.split("•")[0].replace(/refurbished/i, "").trim(),
      url: window.location.href,
    };
  };

  try {
    const nuxt = window.useNuxtApp && window.useNuxtApp();
    const data = nuxt && nuxt.payload && nuxt.payload.data;
    const pickersKey = data ? Object.keys(data).find((key) => key.startsWith("pp-pickers:")) : undefined;
    const productKey = data ? Object.keys(data).find((key) => key.startsWith("pp-product-")) : undefined;
    const dom = fromDom();
    if (!data || !pickersKey) return dom;

    const pickers = data[pickersKey];
    const product = productKey ? data[productKey] : null;
    const offer = pickers.selectedOffer || null;
    const nuxtSelected = {};
    for (const group of pickers.pickerGroups || []) {
      const selected = (group.items || []).find((item) => item.selected);
      if (selected) nuxtSelected[group.id] = selected.label;
    }
    const domSelected = {};
    for (const group of dom.groups) {
      const selected = group.items.find((item) => item.selected);
      if (selected) domSelected[group.id] = selected.label;
    }
    const sameSelection = ["grades", "battery", "storage", "dual_sim", "color"].every((id) => {
      if (!domSelected[id] || !nuxtSelected[id]) return true;
      return canonicalize(id, String(domSelected[id]), null).toLowerCase() === canonicalize(id, String(nuxtSelected[id]), null).toLowerCase();
    });
    if (!sameSelection) return dom;

    return {
      groups: dom.groups,
      selectedOffer: {
        price: offer && offer.price && offer.price.amount
          ? { amount: offer.price.amount, currency: offer.price.currency || "GBP" }
          : dom.selectedOffer.price,
        listPrice: offer && offer.discount && offer.discount.price && offer.discount.price.amount
          ? {
              amount: offer.discount.price.amount,
              currency: offer.discount.price.currency || (offer.price && offer.price.currency) || "GBP",
            }
          : product && product.priceWhenNew && product.priceWhenNew.amount
            ? { amount: product.priceWhenNew.amount, currency: product.priceWhenNew.currency || "GBP" }
            : dom.selectedOffer.listPrice,
        discountRate: offer && offer.discount ? offer.discount.rate || null : null,
        warranty: offer ? offer.defaultWarrantyDelay || null : dom.selectedOffer.warranty,
        newBattery: offer && offer.newBattery && offer.newBattery.status
          ? offer.newBattery.status === "available"
          : null,
        isOutOfStock: Boolean(pickers.isOutOfStock),
        sku: offer ? offer.sku || null : null,
        offerId: offer ? offer.offerId || null : null,
      },
      modelName: (product && (product.titles && (product.titles.default || product.titles.raw))) || dom.modelName,
      url: window.location.href,
    };
  } catch (error) {}

  return fromDom();
})()`;

export async function readLivePickers(page: Page): Promise<LivePickers> {
  let lastError: unknown = new Error("Could not read pickers.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return (await page.evaluate(READ_PICKERS_SCRIPT)) as LivePickers;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const ready = await page.waitForSelector('input[name="step-grades"]', { timeout: 20_000 }).catch(() => null);
      if (!ready && !/execution context was destroyed|target closed|frame was detached/i.test(message)) {
        throw error;
      }
    }
  }
  throw lastError;
}

export function selectedLabel(groups: PickerGroup[], groupId: string): string {
  const group = groups.find((item) => item.id === groupId);
  return group?.items.find((item) => item.selected)?.label ?? "";
}

export function radioSelector(groupId: string, trackingValue: string | number | null, label: string): string {
  const name = `input[name="step-${groupId}"]`;
  if (trackingValue !== null && trackingValue !== undefined && String(trackingValue).length > 0) {
    const value = cssEscape(String(trackingValue));
    return `${name}[value="${value}"]`;
  }
  return `${name}[value="${cssEscape(label)}"]`;
}

function cssEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function isOptionEnabled(page: Page, groupId: string, item: PickerItem): Promise<boolean> {
  const selector = radioSelector(groupId, item.trackingValue, item.label);
  const input = page.locator(selector).first();
  if ((await input.count()) === 0) return false;
  return input.isEnabled();
}

export async function selectPickerOption(
  page: Page,
  groupId: string,
  item: PickerItem,
  timeoutMs = 20_000,
): Promise<void> {
  const current = await readLivePickers(page);
  if (labelsEqual(groupId, selectedLabel(current.groups, groupId), item.label)) {
    return;
  }

  const previousUrl = page.url();
  const selector = radioSelector(groupId, item.trackingValue, item.label);

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.locator(selector).first().click({ force: true, timeout: 8000 });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      try {
        await page.locator(`label:has(${selector})`).first().click({ timeout: 8000 });
        lastError = undefined;
        break;
      } catch (inner) {
        lastError = inner;
        await page.waitForTimeout(350);
      }
    }
  }
  if (lastError) throw lastError;

  try {
    await waitForGroupSelected(page, groupId, item, timeoutMs);
  } catch (error) {
    if (page.url() !== previousUrl) {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForSelector(`input[name="step-${groupId}"]`, { timeout: 15_000 });
      await waitForGroupSelected(page, groupId, item, timeoutMs);
      return;
    }
    throw error;
  }
}

async function waitForGroupSelected(
  page: Page,
  groupId: string,
  item: PickerItem,
  timeoutMs: number,
): Promise<void> {
  let lastError: unknown = new Error("Selection did not settle.");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.waitForFunction(
        `({ groupId, label, trackingValue }) => {
      const checked = document.querySelector('input[name="step-' + groupId + '"]:checked');
      if (!checked) return false;
      const text = checked.closest("label") ? checked.closest("label").innerText : "";
      if (trackingValue != null && String(checked.value) === String(trackingValue)) return true;
      const firstLine = text.split("\\n")[0] ? text.split("\\n")[0].trim() : "";
      const compact = (value) => String(value || "").trim().toLowerCase().replace(/\\s+/g, " ").replace(/ gb$/, "").replace(/ battery$/, "");
      if (compact(firstLine) === compact(label)) return true;
      if (groupId === "dual_sim") {
        const hay = (firstLine + " " + String(checked.value)).toLowerCase();
        const want = compact(label);
        if (want.includes("dual")) return hay.includes("dual");
        if (want.includes("physical") && want.includes("esim")) return hay.includes("physical") && hay.includes("esim") && !hay.includes("dual");
        if (want === "esim") return hay.includes("esim") && !hay.includes("physical");
      }
      return false;
    }`,
        { groupId, label: item.label, trackingValue: item.trackingValue },
        { timeout: timeoutMs },
      );
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/execution context was destroyed|target closed|frame was detached/i.test(message)) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForSelector(`input[name="step-${groupId}"]`, { timeout: 15_000 }).catch(() => undefined);
    }
  }
  throw lastError;
}
