export type UnknownRecord = Record<string, unknown>;
export function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}
export function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function asString(value: unknown, fallback = "—"): string { return typeof value === "string" && value.trim() ? value : fallback; }
export function asNumber(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
export function asBoolean(value: unknown): boolean { return value === true; }
export function firstArray(record: UnknownRecord, ...keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}
export function moneyFromCents(value: unknown): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(asNumber(value) / 100);
}
export function compactNumber(value: unknown): string { return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(asNumber(value)); }
export function percent(value: unknown): string { return `${(asNumber(value) * (asNumber(value) <= 1 ? 100 : 1)).toFixed(1)}%`; }
export function stableJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return "Unrenderable payload"; }
}
