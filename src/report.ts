import { writeFile } from "node:fs/promises";
import type { CaptureRow } from "./types.js";

const CONDITION_WEIGHT: Record<string, number> = {
  Premium: 1.08,
  Excellent: 1.0,
  Good: 0.85,
  Fair: 0.7,
};

const BATTERY_WEIGHT: Record<string, number> = {
  "New battery": 1.1,
  New: 1.1,
  Great: 1.05,
  "Standard battery": 1.0,
  Good: 1.0,
};

export function storageGb(label: string): number | null {
  const tb = label.match(/([\d.]+)\s*TB/i);
  if (tb) return Math.round(Number(tb[1]) * 1024);
  const gb = label.match(/([\d.]+)\s*GB/i);
  if (gb) return Number(gb[1]);
  return null;
}

function score(row: CaptureRow): number | null {
  if (row.status !== "Available" || !row.price) return null;
  const price = Number(row.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const conditionW = CONDITION_WEIGHT[row.condition] ?? 1;
  const batteryW = BATTERY_WEIGHT[row.battery] ?? 1;
  return price / (conditionW * batteryW);
}

function cheapest(rows: CaptureRow[], predicate: (row: CaptureRow) => boolean): CaptureRow | null {
  const matches = rows.filter((row) => row.status === "Available" && row.price && predicate(row));
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => Number(a.price) - Number(b.price))[0] ?? null;
}

function describe(row: CaptureRow | null): string {
  if (!row) return "none captured";
  return `${row.condition} / ${row.battery} / ${row.storage} / ${row.simType} / ${row.colour} — £${row.price}`;
}

export function buildReport(modelName: string, rows: CaptureRow[]): string {
  const available = rows.filter((row) => row.status === "Available");
  const out = rows.filter((row) => row.status === "Out of stock");

  const withScore = available
    .map((row) => ({ row, value: score(row) }))
    .filter((entry): entry is { row: CaptureRow; value: number } => entry.value !== null)
    .sort((a, b) => a.value - b.value);

  const perGb = available
    .map((row) => {
      const gb = storageGb(row.storage);
      const price = Number(row.price);
      if (!gb || !Number.isFinite(price) || price <= 0) return null;
      return { row, perGb: price / gb };
    })
    .filter((entry): entry is { row: CaptureRow; perGb: number } => entry !== null)
    .sort((a, b) => a.perGb - b.perGb);

  const topValue = withScore.slice(0, 10)
    .map(
      (entry, index) =>
        `${index + 1}. £${entry.row.price}  score ${entry.value.toFixed(2)}  — ${entry.row.condition}, ${entry.row.battery}, ${entry.row.storage}, ${entry.row.simType}, ${entry.row.colour}`,
    )
    .join("\n");

  const topPerGb = perGb
    .slice(0, 5)
    .map(
      (entry, index) =>
        `${index + 1}. £${entry.perGb.toFixed(2)}/GB  (£${entry.row.price} for ${entry.row.storage}) — ${entry.row.condition}, ${entry.row.battery}, ${entry.row.colour}`,
    )
    .join("\n");

  return `# ${modelName} — Back Market value report

Captured at: ${new Date().toISOString()}
Rows: ${rows.length} (${available.length} available, ${out.length} out of stock)

## Headline picks

- Cheapest available: ${describe(cheapest(rows, () => true))}
- Cheapest Excellent + New battery: ${describe(cheapest(rows, (row) => row.condition === "Excellent" && row.battery === "New battery"))}
- Cheapest Excellent + Standard battery: ${describe(cheapest(rows, (row) => row.condition === "Excellent" && row.battery === "Standard battery"))}
- Cheapest Premium: ${describe(cheapest(rows, (row) => row.condition === "Premium"))}

## Quality-adjusted ranking

Lower score is better. Formula: \`price / (condition_weight * battery_weight)\`.

Weights: Premium 1.08, Excellent 1.00, Good 0.85, Fair 0.70; New battery 1.10, Great 1.05, Good/Standard 1.00.

${topValue || "none"}

## Best £ per GB

${topPerGb || "none"}

## Notes

- Sibling option prices on Back Market are not a full matrix. Changing Condition/Storage/SIM can also change colour. This file is built from leaf captures after a waterfall walk.
- Compare across models only after each model CSV is complete.
`;
}

export async function writeReport(path: string, modelName: string, rows: CaptureRow[]): Promise<void> {
  await writeFile(path, buildReport(modelName, rows), "utf8");
}
