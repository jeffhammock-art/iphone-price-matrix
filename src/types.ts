export type CaptureStatus = "Available" | "Out of stock";

export interface ModelTarget {
  id: string;
  name: string;
  url: string;
}

export interface SiteConfig {
  site: string;
  origin: string;
  localePath: string;
  currency: string;
  models: ModelTarget[];
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
}

export interface CrawlOptions {
  headed: boolean;
  resume: boolean;
  maxRows: number | null;
  delayMs: number;
}

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
] as const;

export function rowKey(row: Pick<CaptureRow, "site" | "model" | "battery" | "condition" | "storage" | "simType" | "colour">): string {
  return [
    row.site,
    row.model,
    row.battery,
    row.condition,
    row.storage,
    row.simType,
    row.colour,
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
  ];
  return values.map(csvEscape).join(",");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
