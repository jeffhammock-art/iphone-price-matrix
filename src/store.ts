import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CSV_HEADERS, toCsvLine, type CaptureRow } from "./types.js";

export function modelPaths(dataDir: string, modelId: string) {
  return {
    jsonl: join(dataDir, `backmarket-${modelId}.jsonl`),
    csv: join(dataDir, `backmarket-${modelId}.csv`),
    coverage: join(dataDir, `backmarket-${modelId}-coverage.log`),
    report: join(dataDir, `backmarket-${modelId}-report.md`),
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
  await mkdir(dirname(paths.jsonl), { recursive: true });
  await appendFile(paths.jsonl, `${JSON.stringify(row)}\n`, "utf8");
  await rewriteCsv(paths.csv, await loadExistingRows(paths.jsonl));
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
