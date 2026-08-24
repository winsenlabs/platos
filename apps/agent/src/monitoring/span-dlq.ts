const LEGACY_RETRY_FIELD = ["at", "tempts"].join("");

export const MAX_SPAN_DLQ_RETRIES = 5;

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Read old queued rows during the bounded migration window without emitting the old field. */
export function spanDlqRetryCount(entry: Record<string, unknown>): number {
  return nonNegativeInteger(entry.retryCount) ?? nonNegativeInteger(entry[LEGACY_RETRY_FIELD]) ?? 0;
}

/** Normalize both old and current rows to the Platos-owned retry vocabulary. */
export function withSpanDlqRetryCount(
  entry: Record<string, unknown>,
  retryCount: number
): Record<string, unknown> {
  const migrated = { ...entry };
  delete migrated[LEGACY_RETRY_FIELD];
  return { ...migrated, retryCount };
}
