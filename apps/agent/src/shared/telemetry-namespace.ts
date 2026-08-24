import { env } from "./env";

/**
 * Shared metric/span database. The override is a rollback-only read strategy;
 * normal installations use the Platos-owned default.
 */
export const TELEMETRY_DATABASE = env.PLATOS_TELEMETRY_DATABASE;
