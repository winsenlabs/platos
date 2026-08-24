/**
 * The ClickHouse implementation of ObservabilitySink.
 *
 * WHY THIS IS NOT `@internal/clickhouse`. That package is the private external
 * runtime adapter: its consumers handle runtime runs, events or replication, and its
 * client is constructed once from `CLICKHOUSE_URL` in the webapp process. This
 * sink lives in the agent, resolves its endpoint per call so credentials can
 * rotate, and writes a database that package has never heard of. Importing it
 * would tie the Platos projection's availability to the health of a pipeline
 * that is currently broken (WIN-150).
 *
 * ERROR BODIES ARE PERSONAL DATA. ClickHouse echoes the failing statement back
 * inside its exception text, and a failing INSERT quotes the rows — which, when
 * an entity signed userMeta, carry a display name and an email. Only the HTTP
 * status and the numeric `Code: <n>` survive into anything this class returns,
 * logs or throws. The erasure client takes the same care for the same reason;
 * the duplication is the price of neither module depending on the other.
 */

import {
  OBSERVABILITY_DATABASE,
  OBSERVABILITY_TABLES,
  OBSERVABILITY_URL_VARIABLES,
  resolveObservabilityConfig,
  type ObservabilityConfig,
  type ObservabilityTable,
} from "./observability-config";
import {
  emptyRows,
  rowCount,
  type ObservabilityRow,
  type ObservabilityRows,
  type StepObserved,
  type ToolCallObserved,
  type TurnObserved,
  type UsageObserved,
  stepRow,
  toolCallRow,
  turnRow,
  usageRow,
} from "./observability-event";
import type {
  ObservabilitySink,
  ObservabilitySinkHealth,
  ObservabilitySinkStatus,
} from "./observability-sink";

/** A statement that did not succeed, reduced to what is safe to keep. */
export class ObservabilityWriteError extends Error {
  readonly status?: number;
  readonly code?: number;
  constructor(status?: number, code?: number) {
    super(
      `observability write failed${status === undefined ? "" : ` (http ${status})`}` +
        `${code === undefined ? "" : ` (code ${code})`}`,
    );
    this.name = "ObservabilityWriteError";
    this.status = status;
    this.code = code;
  }
}

/** ClickHouse's own error number, the only part of a body safe to keep. */
export function observabilityErrorCode(body: string): number | undefined {
  const match = /Code:\s*(\d+)/.exec(body.slice(0, 200));
  return match ? Number(match[1]) : undefined;
}

/**
 * Error CLASS and status, never a message.
 *
 * Used for the `lastErrorCode` column, which an operator reads and which must
 * therefore be safe to store next to a subject id.
 */
export function errorClass(err: unknown): string {
  if (err instanceof ObservabilityWriteError) {
    return `ObservabilityWriteError${err.status === undefined ? "" : ` ${err.status}`}` +
      `${err.code === undefined ? "" : `/${err.code}`}`;
  }
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    return status === undefined ? err.name : `${err.name} ${status}`;
  }
  return "Error";
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const PROBE_SQL =
  "SELECT name FROM system.tables" +
  " WHERE database = {database:String} AND name IN {tables:Array(String)}" +
  " FORMAT TabSeparated";

/** Render a string array as a ClickHouse query-parameter value. */
function arrayParam(values: readonly string[]): string {
  return `[${values.map((v) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",")}]`;
}

export interface ClickhouseObservabilitySinkOptions {
  /** Injected so delivery is testable without a running ClickHouse. */
  fetchImpl?: FetchLike;
  /** Injected so config resolution stays per-call and per-test. */
  readConfig?: () => ObservabilityConfig;
  timeoutMs?: number;
}

export class ClickhouseObservabilitySink implements ObservabilitySink {
  private readonly fetchImpl: FetchLike;
  private readonly readConfig: () => ObservabilityConfig;
  private readonly timeoutMs: number;

  constructor(options: ClickhouseObservabilitySinkOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.readConfig = options.readConfig ?? (() => resolveObservabilityConfig());
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async writeTurn(event: TurnObserved): Promise<void> {
    await this.writeRows({ ...emptyRows(), turns_v1: [turnRow(event)] });
  }

  async writeStep(event: StepObserved): Promise<void> {
    await this.writeRows({ ...emptyRows(), steps_v1: [stepRow(event)] });
  }

  async writeToolCall(event: ToolCallObserved): Promise<void> {
    await this.writeRows({ ...emptyRows(), tool_calls_v1: [toolCallRow(event)] });
  }

  async writeUsage(event: UsageObserved): Promise<void> {
    await this.writeRows({ ...emptyRows(), usage_events_v1: [usageRow(event)] });
  }

  /**
   * Insert every table's rows.
   *
   * Sequential rather than concurrent, in Thread → Turn → Step → Tool Call
   * order: a partial batch that landed the parent Turn and not its Steps reads
   * as a Turn with no detail, which is legible. The reverse — Steps whose Turn
   * never arrived — reads as orphaned cost. Retry re-sends the whole payload
   * and ReplacingMergeTree collapses whatever already landed.
   */
  async writeRows(rows: ObservabilityRows): Promise<void> {
    if (rowCount(rows) === 0) return;
    const config = this.readConfig();
    if (!config.target) {
      throw new Error(
        config.configured
          ? "observability endpoint is configured but is not a usable http(s) URL"
          : "observability endpoint is not configured",
      );
    }
    for (const table of OBSERVABILITY_TABLES) {
      const pending = rows[table];
      for (let offset = 0; offset < pending.length; offset += config.batchSize) {
        await this.insert(config, table, pending.slice(offset, offset + config.batchSize));
      }
    }
  }

  private async insert(
    config: ObservabilityConfig,
    table: ObservabilityTable,
    rows: ObservabilityRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const query = `INSERT INTO ${OBSERVABILITY_DATABASE}.${table} FORMAT JSONEachRow`;
    const url = new URL(`${config.target!.endpoint}/`);
    url.searchParams.set("query", query);
    // ClickHouse's own idempotence hook. Re-POSTing an identical body inside
    // the dedup window is discarded server-side, so a retry after a timeout —
    // where the insert may or may not have landed — cannot duplicate a charge.
    // ReplacingMergeTree is the backstop for retries outside that window.
    url.searchParams.set("insert_deduplicate", "1");
    const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await this.send(config, url, body, "application/json");
  }

  private async send(
    config: ObservabilityConfig,
    url: URL,
    body: string,
    contentType: string,
  ): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    const auth = config.target!.auth;
    if (auth) {
      headers["Authorization"] =
        "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
    }
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ObservabilityWriteError(response.status, observabilityErrorCode(text));
    }
    return response.text();
  }

  /**
   * Probe the endpoint and the schema.
   *
   * This is the check whose absence let a broken pipeline look healthy. It
   * distinguishes four kinds of not-working, because "we cannot reach it",
   * "the URL is nonsense" and "the tables were never created" have three
   * different fixes and one of them is not an incident at all.
   */
  async health(): Promise<ObservabilitySinkHealth> {
    const config = this.readConfig();
    if (!config.configured) {
      return {
        configured: false,
        available: false,
        status: "disabled",
        detail:
          `none of ${OBSERVABILITY_URL_VARIABLES.join(", ")} is set;` +
          " turns complete and the analytical projection is skipped",
      };
    }
    if (!config.target) {
      return {
        configured: true,
        available: false,
        status: "misconfigured",
        detail: `${config.source} is set but is not a usable http(s) URL`,
      };
    }

    let body: string;
    try {
      const url = new URL(`${config.target.endpoint}/`);
      url.searchParams.set("param_database", OBSERVABILITY_DATABASE);
      url.searchParams.set("param_tables", arrayParam(OBSERVABILITY_TABLES));
      body = await this.send(config, url, PROBE_SQL, "text/plain; charset=utf-8");
    } catch (err) {
      return {
        configured: true,
        available: false,
        status: "unreachable",
        // No message: a connection error can carry the endpoint, and the
        // endpoint carries no credentials but the URL it came from did.
        detail: `${config.source} is set but the endpoint did not answer (${errorClass(err)})`,
      };
    }

    const present = new Set(
      body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    const missing = OBSERVABILITY_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      return {
        configured: true,
        available: false,
        status: "schema_missing",
        detail:
          `${OBSERVABILITY_DATABASE} is missing ${missing.length} of ${OBSERVABILITY_TABLES.length}` +
          ` tables (${missing.join(", ")}); apply` +
          " internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql",
        missingTables: [...missing],
      };
    }

    return {
      configured: true,
      available: true,
      status: "ready",
      detail: `${OBSERVABILITY_DATABASE} reachable with all ${OBSERVABILITY_TABLES.length} tables present`,
    };
  }
}

/** Log level a health result deserves. Used by the startup check and the drain. */
export function healthLogLevel(
  status: ObservabilitySinkStatus,
): "log" | "warn" | "error" {
  switch (status) {
    case "ready":
      return "log";
    // An installation that has chosen not to run an analytical store is not in a
    // degraded state, and warning about it every boot trains operators to
    // ignore this log line — which is the state that hid WIN-150.
    case "disabled":
      return "log";
    case "unreachable":
      return "warn";
    case "misconfigured":
    case "schema_missing":
      // Someone configured a store and it cannot accept a write. That is not a
      // transient condition and it will not fix itself.
      return "error";
  }
}
