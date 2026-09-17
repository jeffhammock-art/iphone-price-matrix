import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds data/iphone-dashboard.html — a self-contained interactive dashboard
 * over the captured clean CSVs (13, 14, 15, 15-pro). Regenerate after a crawl:
 *   npm run dashboard:build
 *
 * No runtime deps / no server: the data is embedded as JSON and the HTML uses
 * vanilla JS+CSS, so it opens via double-click (file://).
 */

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");

// Mirrors report.ts weights so "value" is consistent with the CLI report.
const CONDITION_WEIGHT = { Premium: 1.08, Excellent: 1.0, Good: 0.85, Fair: 0.7 };
const BATTERY_WEIGHT = { "New": 1.1, "Great": 1.05, "Standard": 1.0, "Good": 1.0 };

interface RawRow {
  capturedAt: string;
  model: string;
  battery: string;
  condition: string;
  storage: string;
  simType: string;
  colour: string;
  price: string;
  currency: string;
  status: string;
  warranty: string;
  url: string;
  notes: string;
  source: string;
  product: string;
  chip: string;
  screen: string;
  memory: string;
  keyboard: string;
}

function storageGb(label: string): number {
  const tb = label.match(/([\d.]+)\s*TB/i);
  if (tb) return Math.round(Number(tb[1]) * 1024);
  const gb = label.match(/([\d.]+)\s*GB/i);
  return gb ? Number(gb[1]) : 0;
}

function memoryGb(label: string): number {
  const gb = label.match(/([\d.]+)\s*GB/i);
  return gb ? Number(gb[1]) : 0;
}

/** Small RFC-4180-ish parser (handles quoted fields / embedded commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (inQuotes) {
      if (c === '"') {
        if (chars[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && chars[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") { rows.push(row); }
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeModel(raw: string): string {
  // The scraper sometimes concatenates colour into the Model field
  // e.g. "iPhone 15Black • 128 GB • Dual Physical SIM"
  // Strip everything after the • bullet separator first, then
  // extract the canonical iPhone model name.
  const m = raw.split("•")[0].trim();
  const match = m.match(/^(iPhone\s+\d{2}(?:\s+(?:mini|Pro|Pro Max|Plus))?)/i);
  return match ? match[1] : m;
}

async function loadRows(): Promise<RawRow[]> {
  const files = (await readdir(dataDir)).filter((f) => /^[a-z]+-.*-clean\.csv$/.test(f));
  const out: RawRow[] = [];
  for (const file of files) {
    const cells = parseCsv(await readFile(join(dataDir, file), "utf8"));
    if (cells.length < 2) continue;
    const header = cells[0];
    const idx = (name: string): number => {
      const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
      return i;
    };
    for (let r = 1; r < cells.length; r++) {
      const g = (name: string) => (cells[r][idx(name)] ?? "").trim();
      const price = g("Price");
      if (!price) continue;
      const macRow = Boolean(g("Chip") || g("Screen") || g("Memory")) || /macbook/i.test(g("Model"));
            out.push({
        capturedAt: g("DateTime"),
        model: normalizeModel(g("Model")),
        battery: g("Battery"),
        condition: g("Condition"),
        storage: g("Storage"),
        simType: g("SIMType"),
        colour: g("Colour"),
        price,
        currency: g("Currency"),
        status: g("Status"),
        warranty: g("Warranty"),
        url: g("URL"),
        notes: g("Notes"),
        chip: g("Chip"),
        screen: g("Screen"),
        memory: g("Memory"),
        keyboard: g("Keyboard"),
        product: macRow ? "macbook" : "iphone",
        source: file.startsWith("amazon-") ? "Amazon.co.uk"
        : file.startsWith("refurbed-") ? "Refurbed.co.uk"
        : file.startsWith("musicmagpie-") ? "musicMagpie"
        : "Back Market",
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const rows = await loadRows();
  if (rows.length === 0) {
    console.error("No clean CSV rows found in data/. Run `npm run clean` first.");
    process.exitCode = 1;
    return;
  }
  const enriched = rows.map((r) => {
    const gb = storageGb(r.storage);
    const price = Number(r.price) || 0;
    const memGb = memoryGb(r.memory);
    return { ...r, gb, price, perGb: gb > 0 ? price / gb : 0, memGb, perGbRam: memGb > 0 ? price / memGb : 0 };
  });
  const json = JSON.stringify(enriched).replace(/</g, "\\u003c");
  const templatePath = join(rootDir, "src", "dashboard.template.html");
  const template = await readFile(templatePath, "utf8");
  const out = join(dataDir, "iphone-dashboard.html");
  await writeFile(out, template.replace("__DATA__", json), "utf8");
  // The template references dashboard.app.js with a relative path; without
  // this copy a file:// open of data/iphone-dashboard.html 404s the script
  // and renders nothing. The dev server masks the bug by serving src/.
  await copyFile(join(rootDir, "src", "dashboard.app.js"), join(dataDir, "dashboard.app.js"));
  console.log(`Dashboard written: ${out} (${enriched.length} units)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});