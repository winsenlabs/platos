const DEFAULT_TELEMETRY_DATABASE = "platos_telemetry";
const CLICKHOUSE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Database used by the inherited external-runtime adapter tables and the
 * Platos metric/span projections that still share that store.
 *
 * `CLICKHOUSE_DATABASE` is intentionally configurable for a bounded rollback:
 * after migration 034 is rolled back, operators can point readers at the
 * restored database without publishing another application build. New
 * installations always default to the Platos-owned namespace.
 */
export function resolveTelemetryDatabase(value = process.env.CLICKHOUSE_DATABASE): string {
  const configured = value?.trim();
  if (!configured) return DEFAULT_TELEMETRY_DATABASE;
  if (!CLICKHOUSE_IDENTIFIER.test(configured)) {
    throw new Error("CLICKHOUSE_DATABASE must be a valid unquoted ClickHouse identifier");
  }
  return configured;
}

export const TELEMETRY_DATABASE = resolveTelemetryDatabase();
