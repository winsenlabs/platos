import { Injectable, Logger } from "@nestjs/common";

/**
 * Minimal ClickHouse HTTP client for erasure.
 *
 * Its own client rather than SpansService's, for the same reason
 * ErasureObjectStore is its own S3 client: the module whose only job is
 * destroying data must not import the runtime that produces it. The cost is
 * ~40 lines of duplicated URL handling.
 *
 * THREE THINGS THIS CLIENT EXISTS TO GET RIGHT
 *
 * 1. CREDENTIALS IN THE URL. The compose stack ships ClickHouse URLs shaped
 *    `http://default:pwd@clickhouse:8123?secure=false`. Node's fetch REFUSES a
 *    URL carrying credentials ("Request cannot be constructed from a URL that
 *    includes credentials"), so they are split into a Basic header — and the
 *    configured query string is dropped, because appending `?query=…` to a URL
 *    that already has one produces a request ClickHouse cannot parse. The
 *    previous executor did neither, so pointing it at the documented URL made
 *    every probe throw, which then read as "no ClickHouse here".
 *
 * 2. ABSENT IS NOT BROKEN. `available` is false only when nothing is
 *    configured. Every other failure — DNS, 401, 500 — throws. A deployment
 *    that HAS ClickHouse and cannot reach it must never be reported as a
 *    deployment that does not have ClickHouse, because the second reading
 *    settles the erasure and the first one does not.
 *
 * 3. ERROR BODIES ARE PERSONAL DATA. ClickHouse echoes the failing statement
 *    back inside its exception text, and an erasure statement embeds the very
 *    identifiers being erased. Only the HTTP status and the numeric
 *    `Code: <n>` survive into anything this class returns, logs or throws.
 */

/** Options for a single statement. Parameters are ALWAYS sent out of band. */
export interface ClickhouseQueryOptions {
  /** Sent as `param_<name>`; referenced in SQL as `{name:Type}`. */
  params?: Record<string, string>;
  /** Per-statement settings, e.g. `mutations_sync`. */
  settings?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * The seam the erasure logic is written against.
 *
 * Injected rather than imported so the mutation/poll/verify sequence is
 * testable without a running ClickHouse — the same reason the orchestrator
 * takes executors rather than importing them.
 */
export interface ClickhouseErasureTransport {
  readonly available: boolean;
  query(sql: string, options?: ClickhouseQueryOptions): Promise<string>;
}

/**
 * A ClickHouse statement that did not succeed.
 *
 * Carries the status and ClickHouse's numeric error code and NOTHING else: the
 * response body quotes the statement, which quotes the subject.
 */
export class ClickhouseQueryError extends Error {
  readonly status?: number;
  readonly code?: number;
  constructor(status?: number, code?: number) {
    super(
      `clickhouse statement failed${status === undefined ? "" : ` (http ${status})`}` +
        `${code === undefined ? "" : ` (code ${code})`}`,
    );
    this.name = "ClickhouseQueryError";
    this.status = status;
    this.code = code;
  }
}

/** ClickHouse's own error number, the only part of a body safe to keep. */
export function clickhouseErrorCode(body: string): number | undefined {
  const match = /Code:\s*(\d+)/.exec(body.slice(0, 200));
  return match ? Number(match[1]) : undefined;
}

export interface ClickhouseEndpoint {
  /** Origin + path, no query string, no trailing slash, no credentials. */
  endpoint: string;
  auth: { user: string; pass: string } | null;
}

/**
 * Split a configured ClickHouse URL into a fetch-safe endpoint and Basic auth.
 *
 * Returns null for anything that is not a usable http(s) URL. Null means
 * UNUSABLE, not absent — `new URL("clickhouse:8123")` parses happily into a
 * nonsense protocol, and a deployment that fat-fingered its endpoint still HAS
 * a ClickHouse. Whether the store is absent is decided by `available` below,
 * from whether the variable was set at all.
 */
export function parseClickhouseEndpoint(raw: string | undefined | null): ClickhouseEndpoint | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const user = url.username ? decodeURIComponent(url.username) : "";
    const pass = url.password ? decodeURIComponent(url.password) : "";
    url.username = "";
    url.password = "";
    // Drop the configured query string: `?secure=false` is a driver flag for a
    // different client, and it collides with the `?query=` we append.
    url.search = "";
    return {
      endpoint: url.toString().replace(/\/+$/, ""),
      auth: user ? { user, pass } : null,
    };
  } catch {
    return null;
  }
}

/**
 * Render a string array as a ClickHouse query-parameter value.
 *
 * Erasure predicates are built from external identifiers, which are attacker-
 * influenced strings. They are never concatenated into SQL; they travel as
 * `param_x=['a','b']` and are substituted by the server's parser.
 */
export function clickhouseArrayParam(values: string[]): string {
  const escaped = values.map((v) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  return `[${escaped.join(",")}]`;
}

/** Split a TabSeparated response into rows of raw cells. */
export function parseTabSeparated(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

@Injectable()
export class ErasureClickhouse implements ClickhouseErasureTransport {
  private readonly logger = new Logger(ErasureClickhouse.name);
  private readonly configured: boolean;
  private readonly target: ClickhouseEndpoint | null;

  constructor() {
    // PLATOS_OTEL_CLICKHOUSE_URL first: that is the variable the AGENT process
    // receives in compose, and therefore the endpoint the spans this executor
    // erases were actually written to. Reading only CLICKHOUSE_URL — which is
    // set on the webapp service, not this one — is why the previous executor
    // reported "no ClickHouse" on a stack that was writing to it all along.
    const raw = (process.env.PLATOS_OTEL_CLICKHOUSE_URL ?? process.env.CLICKHOUSE_URL)?.trim();
    this.configured = Boolean(raw);
    this.target = parseClickhouseEndpoint(raw);
    if (!this.configured) {
      // Expected in local/dev: ClickHouse is deliberately not in the local
      // compose stack. Absence is reported, never assumed to mean "clean".
      this.logger.log("[erasure] no clickhouse endpoint configured; store reports not_provisioned");
    } else if (!this.target) {
      this.logger.error("[erasure] clickhouse endpoint is not a usable http(s) URL");
    }
  }

  /**
   * Whether this deployment claims a ClickHouse at all.
   *
   * True for a configured-but-unusable endpoint on purpose: the erasure
   * executor turns `false` into `not_provisioned`, which SETTLES the operation,
   * and a typo in a URL is not evidence that a store holds no personal data.
   * A broken endpoint fails loudly in `query` instead.
   */
  get available(): boolean {
    return this.configured;
  }

  async query(sql: string, options: ClickhouseQueryOptions = {}): Promise<string> {
    if (!this.target) throw new Error("clickhouse endpoint is not configured or not usable");
    const url = new URL(`${this.target.endpoint}/`);
    for (const [name, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(`param_${name}`, value);
    }
    for (const [name, value] of Object.entries(options.settings ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
    if (this.target.auth) {
      headers["Authorization"] =
        "Basic " + Buffer.from(`${this.target.auth.user}:${this.target.auth.pass}`).toString("base64");
    }
    // The statement travels in the BODY: erasure predicates carry an unbounded
    // id list, and a URL-encoded query would hit the server's URI length limit
    // for exactly the subjects with the most data.
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: sql,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ClickhouseQueryError(response.status, clickhouseErrorCode(body));
    }
    return response.text();
  }
}
