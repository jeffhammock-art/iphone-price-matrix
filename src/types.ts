export type CaptureStatus = "Available" | "Out of stock";

export interface ProductFilters {
  minScreenInches?: number;
  minMemoryGb?: number;
  minStorageGb?: number;
  chipPattern?: string;
}

export interface ModelTarget {
  id: string;
  name: string;
  url: string;
  storage?: string;
  product?: string;
  filters?: ProductFilters;
}

export interface SiteConfig {
  site: string;
  origin: string;
  localePath: string;
  currency: string;
  models: ModelTarget[];
}

export interface MultiSiteConfig {
  sites: SiteConfig[];
}

export interface PickerPrice {
  amount: string;
  currency: string;
}

export interface PickerItem {
  label: string;
  available: boolean;
  acquirable: boolean;
  selected: boolean;
  price: PickerPrice | null;
  productId: string | null;
  slug: string | null;
  trackingValue: string | number | null;
}

export interface PickerGroup {
  id: string;
  label: string;
  items: PickerItem[];
}

export interface SelectedOffer {
  price: PickerPrice | null;
  listPrice: PickerPrice | null;
  discountRate: string | null;
  warranty: string | null;
  newBattery: boolean | null;
  isOutOfStock: boolean;
  sku: string | null;
  offerId: string | null;
}

export interface LivePickers {
  groups: PickerGroup[];
  selectedOffer: SelectedOffer;
  modelName: string;
  url: string;
}

export interface CaptureRow {
  site: string;
  capturedAt: string;
  model: string;
  battery: string;
  condition: string;
  storage: string;
  simType: string;
  colour: string;
  price: string;
  currency: string;
  status: CaptureStatus;
  listPrice: string;
  warranty: string;
  sku: string;
  url: string;
  notes: string;
  product?: string;
  chip?: string;
  screen?: string;
  memory?: string;
  keyboard?: string;
}

export interface InventoriedOption {
  groupId: string;
  value: string;
  label: string;
  enabled: boolean;
  soldOut: boolean;
  selected: boolean;
  price: PickerPrice | null;
}

export interface ConfiguratorState {
  groups: Record<string, InventoriedOption[]>;
  selected: Record<string, string>;
  selectedLabels: Record<string, string>;
}

export interface CrawlOptions {
  headed: boolean;
  resume: boolean;
  maxRows: number | null;
  delayMs: number;
  ignoreDenylist?: boolean;
}

export type MissReason = "REDIRECTED" | "OUT_OF_STOCK" | "BLOCKED_BY_SITE" | "ERROR";

export const CSV_HEADERS = [
  "Site",
  "DateTime",
  "Model",
  "Battery",
  "Condition",
  "Storage",
  "SIMType",
  "Colour",
  "Price",
  "Currency",
  "Status",
  "ListPrice",
  "Warranty",
  "SKU",
  "URL",
  "Notes",
  "Product",
  "Chip",
  "Screen",
  "Memory",
  "Keyboard",
] as const;

export interface RowValidation {
  valid: boolean;
  reasons: string[];
}

const REQUIRED_ROW_FIELDS = [
  "model",
  "condition",
  "battery",
  "storage",
  "simType",
  "colour",
  "price",
  "currency",
  "url",
] as const;

export function validateRow(row: CaptureRow): RowValidation {
  const reasons: string[] = [];
  for (const field of REQUIRED_ROW_FIELDS) {
    const value = row[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      reasons.push(`missing ${field}`);
    }
  }
  if (row.currency !== "GBP") reasons.push(`currency=${row.currency || "(empty)"} want GBP`);
  const validBackMarket = row.url.includes("backmarket.co.uk") && row.url.includes("/en-gb/p/");
  const validAmazon = row.url.includes("amazon.co.uk") && row.url.includes("/dp/");
  const validRefurbed = row.url.includes("refurbed.co.uk") && row.url.includes("/p/");
  const validMusicMagpie = row.url.includes("musicmagpie.co.uk") && row.url.includes("/store/");
  if (row.url && !validBackMarket && !validAmazon && !validRefurbed && !validMusicMagpie) {
    reasons.push(`url not on UK product page: ${row.url}`);
  }
  if (row.status === "Available" && !row.price) reasons.push("Available row without price");
  return { valid: reasons.length === 0, reasons };
}

export function rowKey(
  row: Pick<CaptureRow, "site" | "model" | "battery" | "condition" | "storage" | "simType" | "colour"> &
    Partial<Pick<CaptureRow, "screen" | "memory">>,
): string {
  return [
    row.site,
    row.model,
    row.battery,
    row.condition,
    row.storage,
    row.simType,
    row.colour,
    row.screen ?? "",
    row.memory ?? "",
  ].join("|");
}

export function toCsvLine(row: CaptureRow): string {
  const values = [
    row.site,
    row.capturedAt,
    row.model,
    row.battery,
    row.condition,
    row.storage,
    row.simType,
    row.colour,
    row.price,
    row.currency,
    row.status,
    row.listPrice,
    row.warranty,
    row.sku,
    row.url,
    row.notes,
    row.product ?? "",
    row.chip ?? "",
    row.screen ?? "",
    row.memory ?? "",
    row.keyboard ?? "",
  ];
  return values.map(csvEscape).join(",");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
