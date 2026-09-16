import type { Page } from "playwright";

export function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

export interface AmazonOffer {
  condition: string;
  price: string;
  colour: string;
}

/** Canonical deep link: pins the ASIN's specific variation + offer. */
export function canonicalAmazonUrl(rawUrl: string): string {
  const m = rawUrl.match(/\/dp\/([A-Z0-9]{10})/i);
  if (!m) return rawUrl;
  return `https://www.amazon.co.uk/dp/${m[1].toUpperCase()}?th=1&psc=1`;
}

/** Apple colour vocabulary, longest first so "Space Black" wins over "Black". */
const COLOUR_WORDS = [
  "Natural Titanium", "Blue Titanium", "White Titanium", "Black Titanium", "Desert Titanium",
  "Sierra Blue", "Alpine Green", "Deep Purple", "Space Black", "Pacific Blue",
  "(PRODUCT)RED", "PRODUCT RED", "Graphite", "Midnight", "Starlight",
  "Sky Blue", "Teal", "Gold", "Silver", "Green", "Blue", "Purple",
  "Pink", "Yellow", "Red", "Black", "White", "Coral",
];

/** Extract a colour name from free text (title / swatch label). */
export function colourFromText(text: string): string {
  const t = text || "";
  const red = t.match(/\(PRODUCT\s*\)\s*RED/i);
  if (red) return "PRODUCT RED";
  const normalized = t.replace(/\s+/g, " ").trim();
  for (const word of COLOUR_WORDS) {
    if (word === "(PRODUCT)RED") continue;
    const idx = normalized.toLowerCase().indexOf(word.toLowerCase());
    if (idx !== -1) return normalized.slice(idx, idx + word.length);
  }
  return "";
}

/**
 * Read the colour of the currently selected variation.
 * Strategy: selected swatch (li.selection / its img alt) → variation label → product title.
 */
export async function readColour(page: Page): Promise<string> {
  const candidates = [
    () => page.locator("#variation_color_name li.selection img").first().getAttribute("alt", { timeout: 1500 }),
    () => page.locator("#variation_color_name li.selection").first().textContent({ timeout: 1500 }),
    () => page.locator("#variation_color_name img[alt]").first().getAttribute("alt", { timeout: 1500 }),
    () => page.locator("#productTitle").first().textContent({ timeout: 3000 }),
  ];
  for (const get of candidates) {
    try {
      const text = await get();
      const colour = colourFromText(text || "");
      if (colour) return colour;
    } catch {
      // try next strategy
    }
  }
  return "Unknown";
}

/**
 * Read the main Buy Box price from an Amazon product page.
 * Only captures the primary price shown to buyers, not third-party seller offers.
 */
export async function readMainPrice(page: Page): Promise<string> {
  try {
    // Amazon's main price uses .a-price .a-offscreen selector
    const priceEl = page.locator('.a-price .a-offscreen').first();
    const priceText = await priceEl.textContent();
    const match = priceText?.match(/£(\d+[.,]\d{2})/);
    return match ? match[1].replace(",", ".") : "";
  } catch {
    return "";
  }
}

/**
 * Read the condition grade from the page.
 * Amazon Renewed pages show the condition in the title or product details.
 */
export async function readCondition(page: Page): Promise<string> {
  try {
    // Check the product title first (.first(): some pages render #productTitle twice)
    const title = await page.locator("#productTitle").first().textContent({ timeout: 3000 });
    if (title) {
      if (title.includes("Renewed Premium")) return "Premium";
      if (title.includes("Renewed Excellent")) return "Excellent";
      if (title.includes("Renewed Good")) return "Good";
      if (title.includes("Renewed Fair")) return "Fair";
      if (title.includes("Renewed")) return "Good"; // Default for Renewed
    }

    // Check the product details section
    const details = await page.locator("#productTitle + *, #feature-bullets").first().textContent();
    if (details) {
      if (details.includes("Premium")) return "Premium";
      if (details.includes("Excellent")) return "Excellent";
      if (details.includes("Good")) return "Good";
      if (details.includes("Fair")) return "Fair";
    }
  } catch {
    // Ignore errors
  }
  return "Good"; // Default
}

/**
 * Read the main product offer (price + condition + colour).
 * This is what Amazon shows as the primary buying option.
 */
export async function readMainOffer(page: Page): Promise<AmazonOffer | null> {
  const price = await readMainPrice(page);
  if (!price) return null;

  const condition = await readCondition(page);
  const colour = await readColour(page);
  return { condition, price, colour };
}

