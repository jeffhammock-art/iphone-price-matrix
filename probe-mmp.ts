// One-off probe: verify corrected musicMagpie category URLs render product cards.
// Opens each candidate URL in ONE headed Chromium (shared trusted profile),
// waits for product cards, prints model | HTTP status | card count | title.
// Run: npx tsx probe-mmp.ts
import { chromium } from "playwright";
import { chromeProfileDir } from "./src/chrome-profile.js";

const MODELS = [
  "iphone-13", // control (known good)
  "iphone-14",
  "iphone-15",
  "iphone-13-pro",
  "iphone-14-pro",
  "iphone-15-pro",
  "iphone-13-pro-max",
  "iphone-14-pro-max",
  "iphone-15-pro-max",
];

function urlFor(slug: string): string {
  return `https://www.musicmagpie.co.uk/store/category/mobile-phones/apple/${slug}/?filter=purchase_type:buy&filter=network:UNLOCKED&per-page=128`;
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(chromeProfileDir, {
    headless: false,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await context.newPage();

  for (const slug of MODELS) {
    const url = urlFor(slug);
    let cards = -1;
    let title = "";
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      title = await page.title();
      // Cloudflare interstitial?
      if (/just a moment/i.test(title)) {
        try {
          await page.waitForSelector('[class*="_productCard_"] a[href]', { timeout: 45000 });
        } catch {
          /* keep going, count below will be 0 */
        }
        title = await page.title();
      } else {
        try {
          await page.waitForSelector('[class*="_productCard_"] a[href]', { timeout: 20000 });
        } catch {
          /* no cards */
        }
      }
      cards = await page.evaluate(
        () => document.querySelectorAll('[class*="_productCard_"]').length,
      );
      console.log(`${slug.padEnd(20)} status=${resp?.status() ?? "?"} cards=${String(cards).padStart(3)} title="${title.slice(0, 60)}"`);
    } catch (e) {
      console.log(`${slug.padEnd(20)} ERROR ${(e as Error).message.slice(0, 80)} title="${title.slice(0, 60)}"`);
    }
  }

  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
