// THE one file in the V1 layout that names the PostgreSQL client.
//
// ADR M0.3 §4 puts the tenancy-database client in this adapter and nowhere else,
// and `tenancy-prisma-only` in `scripts/arch/boundary-rules.mjs` is that
// sentence as a gate: any file outside `packages/adapters/postgres-tenancy/`
// that imports the ORM or the generated client package fails the architecture
// audit. Keeping the import in ONE module rather than spreading it across the
// repository files means the gate has one place to point at, and means the rest
// of this package is written against two local type aliases that a reader can
// hold in their head.
//
// The URL is built here too, because connection limits and timeouts are the
// adapter's business: a context asked for a repository, not for a pool.

import { Prisma, PrismaClient } from "@platos/tenancy-database";

/** The pooled client. One per process; the composition root owns its lifetime. */
export type TenancyDatabaseClient = PrismaClient;

/**
 * The client handed to the callback of an interactive transaction.
 *
 * It is a NARROWER type than the pooled client — no `$transaction`, no
 * `$connect` — which is the property this package relies on: a repository
 * method resolves one of these and physically cannot open a second transaction
 * or reconnect from inside one.
 */
export type TenancyTransactionClient = Prisma.TransactionClient;

/** Either client. Every read in this package is written against this type. */
export type TenancyReader = TenancyDatabaseClient | TenancyTransactionClient;

/**
 * JSON the client will accept for a JSONB column.
 *
 * Aliased HERE for the same reason the two client types are: this is the one
 * file that names the vendor namespace, and `outbox-store.ts` needs the type to
 * hand an envelope to `Event.payload` without importing it. The alias is not
 * `unknown` with a cast at the call site — a cast there would be a place where a
 * value the driver cannot carry passes unexamined, and the envelope's own
 * serialisation guard would then be the only thing standing between a producer
 * and a driver error.
 */
export type TenancyJsonInput = Prisma.InputJsonValue;

/**
 * What a NULLABLE `Json` column needs in order to hold SQL NULL.
 *
 * WIN-258 T5. Passing a plain `null` to a nullable `Json` field is a client
 * VALIDATION error, not a stored null — the client demands one of its two
 * sentinels and will not choose. The two are not interchangeable and only one is
 * correct here: `JsonNull` stores the JSON scalar `null`, whose `jsonb_typeof`
 * is `'null'`, and both `ToolCall_result_json_root` and
 * `ToolCallAudit_result_json_root` admit only `IS NULL`, `'object'` or
 * `'array'`. So a caller reaching for the other sentinel writes a value the
 * CHECK refuses — which is how this constant came to exist: `saveCall` with a
 * null result failed against a real database and passed against every double.
 */
export const TENANCY_JSON_DB_NULL = Prisma.DbNull;

/**
 * Pool and timeout settings, all optional and all with a stated default.
 *
 * They are separate fields rather than a URL the caller pre-builds because a
 * caller that assembled its own query string could set `connection_limit` and
 * leave `pool_timeout` at the driver default, and the pair only makes sense
 * together: a small pool with an unbounded wait converts saturation into a hang
 * instead of an error.
 */
export interface TenancyPoolSettings {
  /** Client connections in the pool. Prisma's own default is CPU-derived. */
  readonly connectionLimit?: number;
  /** Seconds a query waits for a free connection before it fails. */
  readonly poolTimeoutSeconds?: number;
  /** Milliseconds a single statement may run before PostgreSQL cancels it. */
  readonly statementTimeoutMs?: number;
}

export interface TenancyClientOptions extends TenancyPoolSettings {
  readonly databaseUrl: string;
}

/** Refused when a caller hands over something that is not a usable URL. */
export const DATABASE_URL_INVALID = "tenancy.adapter.database_url_invalid";

/** Refused when a pool or timeout setting is not a positive whole number. */
export const POOL_SETTING_INVALID = "tenancy.adapter.pool_setting_invalid";

export class AdapterConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterConfigurationError";
    this.code = code;
  }
}

function requirePositiveInteger(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AdapterConfigurationError(
      POOL_SETTING_INVALID,
      `${label} must be a positive whole number; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * The datasource URL, with pool and timeout settings folded in as query
 * parameters.
 *
 * PURE, and exported, so the whole of this decision is testable without a
 * database. A setting the caller did not give is left OFF the URL rather than
 * written at its documented default: a default restated in two places drifts,
 * and the driver's own default is the one that ships.
 *
 * A parameter the caller already put on the URL is REPLACED, not appended.
 * PostgreSQL URLs are parsed by the driver, and a duplicated key is resolved by
 * a rule nobody reading this code would guess.
 */
export function buildDatasourceUrl(databaseUrl: string, pool: TenancyPoolSettings = {}): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new AdapterConfigurationError(
      DATABASE_URL_INVALID,
      "databaseUrl must be an absolute postgresql:// URL",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new AdapterConfigurationError(
      DATABASE_URL_INVALID,
      `databaseUrl must use the postgresql scheme; received ${url.protocol}`,
    );
  }
  if (pool.connectionLimit !== undefined) {
    url.searchParams.set(
      "connection_limit",
      String(requirePositiveInteger("connectionLimit", pool.connectionLimit)),
    );
  }
  if (pool.poolTimeoutSeconds !== undefined) {
    url.searchParams.set(
      "pool_timeout",
      String(requirePositiveInteger("poolTimeoutSeconds", pool.poolTimeoutSeconds)),
    );
  }
  if (pool.statementTimeoutMs !== undefined) {
    url.searchParams.set(
      "statement_timeout",
      String(requirePositiveInteger("statementTimeoutMs", pool.statementTimeoutMs)),
    );
  }
  return url.toString();
}

/** Open the pooled client. The caller disconnects it. */
export function createTenancyDatabaseClient(
  options: TenancyClientOptions,
): TenancyDatabaseClient {
  const { databaseUrl, ...pool } = options;
  return new PrismaClient({ datasources: { db: { url: buildDatasourceUrl(databaseUrl, pool) } } });
}

/** PostgreSQL SQLSTATE 23505, as the ORM reports it. */
export const UNIQUE_VIOLATION_CODE = "P2002";

/** PostgreSQL SQLSTATE 23503, as the ORM reports it. */
export const FOREIGN_KEY_VIOLATION_CODE = "P2003";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === UNIQUE_VIOLATION_CODE;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return errorCode(error) === FOREIGN_KEY_VIOLATION_CODE;
}
