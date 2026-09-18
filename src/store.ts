import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CSV_HEADERS, toCsvLine, validateRow, type CaptureRow } from "./types.js";

export function modelPaths(dataDir: string, modelId: string, sitePrefix: string = "backmarket") {
  return {
    jsonl: join(dataDir, `${sitePrefix}-${modelId}.jsonl`),
    csv: join(dataDir, `${sitePrefix}-${modelId}.csv`),
    coverage: join(dataDir, `${sitePrefix}-${modelId}-coverage.log`),
    report: join(dataDir, `${sitePrefix}-${modelId}-report.md`),
    cleanCsv: join(dataDir, `${sitePrefix}-${modelId}-clean.csv`),
  };
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
}

export async function loadExistingRows(jsonlPath: string): Promise<CaptureRow[]> {
  try {
    const raw = await readFile(jsonlPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CaptureRow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

export async function appendRow(paths: ReturnType<typeof modelPaths>, row: CaptureRow): Promise<void> {
  // Hard schema gate (#2): never persist a row without provenance.
  // Rejects missing fields, non-GBP, off-product URLs, priceless Available.
  const validation = validateRow(row);
  if (!validation.valid) {
    throw new Error(`Refusing to save invalid row (${validation.reasons.join("; ")})`);
  }
  // Speed fix (a): append-only. rewriteCsv per row was O(N^2) IO — the CSV
  // is rebuilt once per pass via finalizeCsv instead.
  await mkdir(dirname(paths.jsonl), { recursive: true });
  await appendFile(paths.jsonl, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Rebuild the CSV table from the JSONL source of truth. Called once per pass
 * (and after the crawl) instead of once per row.
 */
export async function finalizeCsv(paths: ReturnType<typeof modelPaths>): Promise<void> {
  const rows = await loadExistingRows(paths.jsonl);
  await rewriteCsv(paths.csv, rows);
}

export async function rewriteCsv(csvPath: string, rows: CaptureRow[]): Promise<void> {
  const body = [CSV_HEADERS.join(","), ...rows.map(toCsvLine)].join("\n");
  await writeFile(csvPath, `${body}\n`, "utf8");
}

export async function appendCoverage(path: string, message: string): Promise<void> {
  const stamp = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `[${stamp}] ${message}\n`, "utf8");
}

export interface CleanResult {
  total: number;
  kept: number;
  rejected: number;
  duplicates: number;
  reasons: string[];
}

/**
 * Clean export: validate every captured row, drop failures and duplicates,
 * write the survivors as a headered CSV table. Sorted by condition, battery,
 * storage, SIM type, colour so the matrix reads predictably.
 */
export async function writeCleanCsv(
  cleanCsvPath: string,
  rows: CaptureRow[],
): Promise<CleanResult> {
  const reasons: string[] = [];
  const valid: CaptureRow[] = [];
  let rejected = 0;

  for (const row of rows) {
    const validation = validateRow(row);
    if (!validation.valid) {
      rejected += 1;
      reasons.push(`${rowKeyOf(row)}: ${validation.reasons.join("; ")}`);
      continue;
    }
    valid.push(row);
  }

  const seen = new Map<string, CaptureRow>();
  let duplicates = 0;
  // Keep the lowest-priced row on duplicate keys.
  for (const row of valid) {
    const key = rowKeyOf(row);
    const existing = seen.get(key);
    if (existing) {
      duplicates += 1;
      if (Number(row.price) < Number(existing.price)) {
        seen.set(key, row);
      }
    } else {
      seen.set(key, row);
    }
  }
  const kept = Array.from(seen.values());

  const storageOrder = (value: string): number => {
    const tb = value.match(/([\d.]+)\s*TB/i);
    if (tb) return Math.round(Number(tb[1]) * 1024);
    const gb = value.match(/([\d.]+)\s*GB/i);
    return gb ? Number(gb[1]) : Number.MAX_SAFE_INTEGER;
  };
  const conditionOrder = ["Premium", "Excellent", "Good", "Fair"];
  kept.sort(
    (a, b) =>
      conditionOrder.indexOf(a.condition) - conditionOrder.indexOf(b.condition) ||
      a.battery.localeCompare(b.battery) ||
      storageOrder(a.storage) - storageOrder(b.storage) ||
      a.simType.localeCompare(b.simType) ||
      a.colour.localeCompare(b.colour),
  );

  const body = [CSV_HEADERS.join(","), ...kept.map(toCsvLine)].join("\n");
  await mkdir(dirname(cleanCsvPath), { recursive: true });
  await writeFile(cleanCsvPath, `${body}\n`, "utf8");
  return { total: rows.length, kept: kept.length, rejected, duplicates, reasons };
}

function rowKeyOf(row: CaptureRow): string {
  // Includes the Mac-only fields so MacBook configurations with the same
  // condition/storage/colour but different screen/memory/chip stay distinct.
  return `${row.model}|${row.condition}|${row.battery}|${row.storage}|${row.simType}|${row.colour}|${row.screen ?? ""}|${row.memory ?? ""}|${row.chip ?? ""}`;
}
