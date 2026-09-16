import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { env } from "../../shared/env";
import { fetchWithValidatedRedirects } from "../../shared/url-validator";
import { McpCredentialService } from "./mcp-credential.service";

// ─────────────────────────────────────────────────────────────────────────────
// Official MCP SDK — DUAL-PACKAGE CJS build, so a normal static import is safe.
//
// The installed @modelcontextprotocol/sdk@1.26 ships a dual package: EVERY
// exports condition — including the `./*` wildcard that covers these three
// subpaths — has a "require" branch pointing at a real CommonJS build
// (dist/cjs, whose own package.json is {"type":"commonjs"}). tsc(module=
// commonjs) transpiles these imports into require(), which resolves through
// that "require" condition. So NO ESM-shield (`new Function("s","return
// import(s)")`) is needed here — unlike the ESM-ONLY chat SDK in
// channel-runtime.service.ts, whose exports map defines only "import".
// Verified against the installed package.json exports map on 2026-07-22.
// ─────────────────────────────────────────────────────────────────────────────
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

/**
 * WIN-269 — does a call's failure leave its pooled session usable?
 *
 * Eviction CLOSES the pooled `Client`, and a closed client rejects every request
 * still pending on it with "MCP error -32000: Connection closed". The pool key is
 * `server.id`, the resolved URL and the credential hash, not the call, so one
 * session carries every concurrent call to that entity's tools — and every end
 * user whose resolved URL and headers are the same. Evicting on a failure that
 * did not kill the session therefore fails calls that had nothing wrong with them.
 *
 * The session SURVIVES when both hold:
 *   * the client's transport is still attached (the SDK detaches it on close, and
 *     then every pending request has already been rejected), and
 *   * the failure is an `McpError`, i.e. it came out of the protocol layer: the
 *     server's own JSON-RPC error answer (it answered, on this session), or this
 *     client's request clock (`RequestTimeout`, -32001 — the client stopped
 *     waiting; the session did not die).
 * Everything else ENDS it: an HTTP status from the transport (a restarted server's
 * 404 for a session it never issued), `fetch failed`, a reset socket, "Not
 * connected", or a detached transport. Those are what the next call must rebuild
 * past, and calls pending on such a session fail on their own.
 *
 * `name === "McpError"` rather than `instanceof`, so the check holds whichever of
 * the SDK's dual (CJS/ESM) builds constructed the error.
 */
export function failureEndsSession(client: Pick<Client, "transport">, failure: unknown): boolean {
  if (client.transport === undefined) return true;
  const candidate = failure as { name?: unknown; code?: unknown } | null;
  const fromProtocolLayer =
    typeof candidate === "object" && candidate !== null && candidate.name === "McpError" && typeof candidate.code === "number";
  return !fromProtocolLayer;
}

const DEFAULT_POOL_IDLE_MS = 300_000;
const DEFAULT_POOL_SIZE = 32;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface GetClientInput {
  /** The server row (only `id` is read — for the pool key). */
  server: { id: string };
  /**
   * The FULLY-resolved URL — `{{endUserId}}` already substituted (via
   * `McpCredentialService.resolveUrl`). Because the pool key includes this
   * value, two end users can never share a pooled session (design §3.3).
   */
  resolvedUrl: string;
  /** Fully-resolved outbound headers (secret already interpolated). */
  resolvedHeaders: Record<string, string>;
  /** "remote-http" → StreamableHTTP; "remote-sse" → SSE. */
  transportKind: string;
}

interface PoolEntry {
  key: string;
  client: Client;
  lastUsedAt: number;
}

/**
 * MCP consumption (Surface 2) — a small LRU pool of connected official-SDK
 * `Client`s, keyed so a session is NEVER shared across different resolved URL
 * or credentials.
 *
 * Pool key = `${server.id}:${resolvedUrl}:${credentialHash(resolvedHeaders)}`.
 *
 * SSRF: every transport request (initialize handshake, tools/list, tools/call,
 * SSE GET stream, POST-backs) is routed through `fetchWithValidatedRedirects`,
 * which re-validates + address-pins each hop (BUG-4 / BUG-15 / H11). Resolved
 * headers ride on every request via `requestInit.headers`, which the SDK
 * transports merge into their common headers on each call — verified against
 * both transports' header-build path (protocol headers like Accept /
 * Mcp-Session-Id retain precedence, so a header template can't clobber them).
 *
 * Handshake (initialize + notifications/initialized) and the `Mcp-Session-Id`
 * lifecycle are owned by the SDK. stdio / hosted-* transports are NOT handled
 * here — callers guard those and throw their existing unchanged errors before
 * reaching the pool.
 */
@Injectable()
export class McpConnectionPool implements OnModuleDestroy {
  private readonly logger = new Logger(McpConnectionPool.name);
  private readonly pool = new Map<string, PoolEntry>();
  /** In-flight builds — dedupe concurrent getClient() for the same key. */
  private readonly building = new Map<string, Promise<PoolEntry>>();
  /**
   * WIN-269 — which pool key a handed-out `Client` was built for, so a caller
   * whose call failed can evict EXACTLY that session (see `evict`). Weak, so an
   * evicted or closed client is not kept alive by the lookup.
   */
  private readonly keyOfClient = new WeakMap<Client, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly credentials: McpCredentialService) {
    // Idle sweep bounded to [5s, 60s] so an idle client is closed shortly
    // after its window elapses. unref so it never keeps the process alive.
    const period = Math.min(Math.max(this.idleMs(), 5_000), 60_000);
    this.sweepTimer = setInterval(() => this.sweepIdle(), period);
    (this.sweepTimer as unknown as { unref?: () => void })?.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const key of Array.from(this.pool.keys())) this.closeEntry(key);
  }

  /**
   * Return a connected `Client` for (server, resolvedUrl, resolvedHeaders),
   * building + caching one on a miss. Concurrent misses for the same key share
   * one build.
   */
  async getClient(input: GetClientInput): Promise<Client> {
    const { server, resolvedUrl, resolvedHeaders, transportKind } = input;
    if (transportKind !== "remote-http" && transportKind !== "remote-sse") {
      // Defence-in-depth — callers already guard stdio / hosted-* and throw
      // their own unchanged errors; the pool never fabricates a session for them.
      throw new Error(`MCP pool does not support transport: ${transportKind}`);
    }

    const key = `${server.id}:${resolvedUrl}:${this.credentials.credentialHash(
      resolvedHeaders,
    )}`;

    const existing = this.pool.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }

    const inFlight = this.building.get(key);
    if (inFlight) return (await inFlight).client;

    const promise = this.build(key, resolvedUrl, resolvedHeaders, transportKind)
      .then((entry) => {
        this.pool.set(key, entry);
        this.building.delete(key);
        this.evictOverflow();
        return entry;
      })
      .catch((err) => {
        this.building.delete(key);
        throw err;
      });
    this.building.set(key, promise);
    return (await promise).client;
  }

  private async build(
    key: string,
    resolvedUrl: string,
    resolvedHeaders: Record<string, string>,
    transportKind: "remote-http" | "remote-sse",
  ): Promise<PoolEntry> {
    const url = new URL(resolvedUrl);
    const ssrfFetch = this.makeSsrfFetch();
    // `requestInit.headers` is merged by the SDK transport into EVERY request
    // it makes; `fetch` routes each request through the SSRF choke-point.
    const opts = {
      requestInit: { headers: resolvedHeaders },
      fetch: ssrfFetch,
    };

    const transport =
      transportKind === "remote-sse"
        ? new SSEClientTransport(url, opts as any)
        : new StreamableHTTPClientTransport(url, opts as any);

    const client = new Client(
      { name: "platos-agent", version: env.PLATOS_VERSION ?? "0.0.0" },
      { capabilities: {} },
    );

    try {
      // connect() performs the initialize handshake — bound by the discovery
      // timeout so a hung server can't wedge a turn.
      await client.connect(transport, { timeout: this.discoveryTimeoutMs() });
    } catch (err) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
      throw err;
    }

    this.keyOfClient.set(client, key);
    return { key, client, lastUsedAt: Date.now() };
  }

  /**
   * WIN-269 — "external MCP failures are isolated": drop a session whose call
   * failed in a way that ended it, so the NEXT call rebuilds it instead of reusing
   * a dead one.
   *
   * WHY. Before this, entries left the pool only on overflow or on the idle sweep,
   * and `getClient` refreshed `lastUsedAt` on every hit. A remote server that
   * restarted mid-session forgets its `Mcp-Session-Id`, answers every request on
   * it with 404, and the pooled client kept being handed out — so an entity used
   * at least once every `MCP_POOL_IDLE_MS` (300 s by default) never recovered
   * until the agent restarted. Callers go through `evictAfterFailure`: a request
   * timeout and a server's JSON-RPC error answer do not evict (see
   * `failureEndsSession`), and neither does an `isError: true` result — in all
   * three the session is alive, and closing it would fail every other call
   * pending on it.
   *
   * THE V1 CONTEXT ADAPTER NOW APPLIES THE SAME RULE, and this paragraph used to
   * say something false about it. It said that adapter "already evicts on exactly
   * this condition" and that this pool is NARROWER than it. It was not narrower;
   * it was correct and the adapter was wrong. `packages/contexts/tools/adapters/
   * mcp-dispatch.ts` evicted in both catch arms BEFORE classifying the failure, so
   * a plain -32001 there closed the session under every caller sharing the pool
   * key — the identical failure this pool was fixed for. That adapter now exports
   * its own `failureEndsSession` with the same reading, and its sibling-call cases
   * in `dispatch.integration.test.ts` hold it to it.
   *
   * IDENTITY, NOT KEY. The entry is dropped only if the pool still holds THIS
   * client for its key. A slow call that fails after a concurrent caller already
   * rebuilt the session must not tear down the healthy replacement.
   *
   * Only this session's key is touched, so one entity's failing server never
   * closes a client another entity is using. It DOES close the session under
   * every caller sharing the key — other tools of the same entity, and end users
   * whose resolved URL and headers are the same — which is why only a failure
   * that already ended the session may reach here. Returns whether an entry was
   * dropped.
   */
  evict(client: Client): boolean {
    const key = this.keyOfClient.get(client);
    if (key === undefined) return false;
    if (this.pool.get(key)?.client !== client) return false;
    this.closeEntry(key);
    return true;
  }

  /**
   * Evict `client` only if `failure` ended its session (`failureEndsSession`).
   * The call path and discovery both use this; returns whether an entry was
   * dropped.
   */
  evictAfterFailure(client: Client, failure: unknown): boolean {
    return failureEndsSession(client, failure) ? this.evict(client) : false;
  }

  /**
   * SSRF-safe fetch for the SDK transports. Routes every request through
   * `fetchWithValidatedRedirects` (validatePublicUrl + address-pinned redirect
   * following). The transport has already merged the resolved headers into
   * `init.headers`, so credentials ride along without us re-merging (which
   * would risk overriding protocol headers the SDK owns).
   */
  private makeSsrfFetch(): (
    url: string | URL,
    init?: RequestInit,
  ) => Promise<Response> {
    return async (url, init) => {
      const raw = typeof url === "string" ? url : url.toString();
      return (await fetchWithValidatedRedirects(
        raw,
        MAX_REDIRECTS,
        (init ?? {}) as RequestInit,
      )) as unknown as Response;
    };
  }

  private evictOverflow(): void {
    const max = this.maxSize();
    while (this.pool.size > max) {
      let lruKey: string | null = null;
      let lruAt = Infinity;
      for (const [k, entry] of this.pool) {
        if (entry.lastUsedAt < lruAt) {
          lruAt = entry.lastUsedAt;
          lruKey = k;
        }
      }
      if (!lruKey) break;
      this.closeEntry(lruKey);
    }
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.idleMs();
    for (const [k, entry] of this.pool) {
      if (entry.lastUsedAt <= cutoff) this.closeEntry(k);
    }
  }

  /** Drop an entry from the pool and close its Client (fire-and-forget). */
  private closeEntry(key: string): void {
    const entry = this.pool.get(key);
    if (!entry) return;
    this.pool.delete(key);
    void Promise.resolve()
      .then(() => entry.client.close())
      .catch(() => undefined);
  }

  private idleMs(): number {
    return env.MCP_POOL_IDLE_MS ?? DEFAULT_POOL_IDLE_MS;
  }

  private maxSize(): number {
    return env.MCP_POOL_SIZE ?? DEFAULT_POOL_SIZE;
  }

  private discoveryTimeoutMs(): number {
    return env.MCP_DISCOVERY_TIMEOUT_MS ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  }
}
