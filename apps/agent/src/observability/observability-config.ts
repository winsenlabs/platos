/**
 * Where the observability projection goes, resolved at call time.
 *
 * READ AT CALL TIME, NOT AT CONSTRUCTION. SpansService parses its endpoint once
 * in its constructor, so rotating a ClickHouse password there requires
 * restarting the process. Every function here takes the environment as an
 * argument and re-reads it, which is also what makes the resolution order
 * testable without touching a real process.
 *
 * ONE ENDPOINT PER DEPLOYMENT, AND THE ERASER MUST AGREE
 *
 * apps/agent/src/privacy/clickhouse.ts resolves its own endpoint from its own
 * copy of this variable order — deliberately, because the module whose only job
 * is destroying data must not import the runtime that produces it. The cost of
 * that independence is that the two orders can drift, and a writer pointing at
 * a store the eraser never probes is a store that quietly retains erased
 * people. `observability-erasure-contract.test.ts` pins the two orders equal so
 * the drift is a failing test rather than a silent one.
 */

/** The analytical database. Never `trigger_dev`. */
export const OBSERVABILITY_DATABASE = "platos_observability";

/** Every table the projection writes, in Thread → Turn → Step → Tool Call order. */
export const OBSERVABILITY_TABLES = [
  "turns_v1",
  "steps_v1",
  "tool_calls_v1",
  "usage_events_v1",
] as const;

export type ObservabilityTable = (typeof OBSERVABILITY_TABLES)[number];

/**
 * Endpoint variables in precedence order.
 *
 * The dedicated variable comes first so an operator can point the turn-shaped
 * projection somewhere other than the legacy span store. The legacy names
 * follow so a deployment that already has a ClickHouse does not have to
 * rediscover it — but note that adopting one only makes the sink CONFIGURED.
 * If `platos_observability` is not there, the startup probe says so loudly
 * rather than writing into a database that does not exist.
 */
export const OBSERVABILITY_URL_VARIABLES = [
  "PLATOS_OBSERVABILITY_CLICKHOUSE_URL",
  "PLATOS_OTEL_CLICKHOUSE_URL",
  "CLICKHOUSE_URL",
] as const;

export interface ObservabilityEndpoint {
  /** Origin + path. No query string, no trailing slash, no credentials. */
  endpoint: string;
  auth: { user: string; pass: string } | null;
}

export interface ObservabilityConfig {
  /** An endpoint variable was set. Says nothing about whether it works. */
  configured: boolean;
  /** Present only when the configured value is a usable http(s) URL. */
  target: ObservabilityEndpoint | null;
  /** Which variable supplied the value, for logs that have to be actionable. */
  source: (typeof OBSERVABILITY_URL_VARIABLES)[number] | null;
  /** Rows per INSERT when draining the outbox. */
  batchSize: number;
  /** Outbox rows read per drain pass. */
  drainBatchSize: number;
  /**
   * Outbox rows one drain CALL may deliver, across as many passes as it takes.
   *
   * Distinct from `drainBatchSize`, and the distinction is the throughput
   * ceiling: a drain that read one batch and returned delivered at most
   * `drainBatchSize` projections per scheduled run, so any deployment busier
   * than that accumulated a backlog no healthy sink could work off. The drain
   * now loops, and this is what bounds the loop.
   */
  drainMaxRows: number;
  /** Deliveries attempted before a row is parked as FAILED. */
  maxAttempts: number;
  /**
   * Turn a configured-but-unusable sink into a boot failure.
   *
   * Off by default because the product must run with no analytical store at
   * all. An operator who has decided their deployment is not allowed to lose
   * analytics turns it on and gets fail-closed startup instead.
   */
  requireSink: boolean;
}

type EnvLike = Record<string, string | undefined>;

/** First endpoint variable that carries a non-blank value. */
export function readObservabilityUrl(
  env: EnvLike = process.env,
): { raw: string; source: (typeof OBSERVABILITY_URL_VARIABLES)[number] } | null {
  for (const name of OBSERVABILITY_URL_VARIABLES) {
    const raw = env[name]?.trim();
    // Compose passes an unset variable through as the empty string, which is
    // absence wearing a value's clothes.
    if (raw) return { raw, source: name };
  }
  return null;
}

/**
 * Split a configured URL into a fetch-safe endpoint and Basic auth.
 *
 * Returns null for anything that is not a usable http(s) URL. Null means
 * UNUSABLE, not absent: `new URL("clickhouse:8123")` parses happily into a
 * nonsense protocol, and a deployment that fat-fingered its endpoint still has
 * a ClickHouse it expects to be written to.
 */
export function parseObservabilityEndpoint(
  raw: string | undefined | null,
): ObservabilityEndpoint | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const user = url.username ? decodeURIComponent(url.username) : "";
    const pass = url.password ? decodeURIComponent(url.password) : "";
    // Node's fetch refuses a URL carrying credentials, so they move to a Basic
    // header. The configured query string goes too: `?secure=false` is a driver
    // flag for a different client and it collides with the `?query=` appended
    // on the way out.
    url.username = "";
    url.password = "";
    url.search = "";
    return {
      endpoint: url.toString().replace(/\/+$/, ""),
      auth: user ? { user, pass } : null,
    };
  } catch {
    return null;
  }
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

function boolLike(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function resolveObservabilityConfig(env: EnvLike = process.env): ObservabilityConfig {
  const found = readObservabilityUrl(env);
  return {
    configured: found !== null,
    target: found ? parseObservabilityEndpoint(found.raw) : null,
    source: found?.source ?? null,
    // 1000 rows per INSERT keeps parts large enough that ClickHouse's merge
    // scheduler is not the bottleneck, without holding a multi-megabyte body
    // in memory per drain.
    batchSize: positiveInt(env.PLATOS_OBSERVABILITY_BATCH_SIZE, 1_000, 50_000),
    drainBatchSize: positiveInt(env.PLATOS_OBSERVABILITY_DRAIN_BATCH_SIZE, 500, 5_000),
    // 50k rows per call against a 5-minute schedule is ~166 turns/second of
    // sustained projection throughput — comfortably above any rate the turn
    // path itself can produce, so the queue is bounded by the sink's health
    // rather than by the drain's arithmetic.
    drainMaxRows: positiveInt(env.PLATOS_OBSERVABILITY_DRAIN_MAX_ROWS, 50_000, 1_000_000),
    maxAttempts: positiveInt(env.PLATOS_OBSERVABILITY_MAX_ATTEMPTS, 10, 100),
    requireSink: boolLike(env.PLATOS_OBSERVABILITY_REQUIRE_SINK),
  };
}
