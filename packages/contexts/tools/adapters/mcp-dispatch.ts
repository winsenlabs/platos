// The MCP half of `ToolDispatch`, and the ONE place in the V1 tree entitled to
// import `@modelcontextprotocol/*`.
//
// ADR M0.3 §5.1 rule (h) (`SDK_CONTAINMENT.mcp-sdk-only-in-tools`) homes that
// scope in `packages/contexts/tools/(adapters|transport)/` and nowhere else, and
// `BANNED_CORE_IMPORT_SOURCES` bans it from every context's `domain/` and
// `application/`. That pair of rules is why this file exists as a separate layer
// rather than as a branch inside a use case: everything above the port — the
// four-tier lattice, the routing, the health fold, the audit envelope — is
// written against `dispatch()` and `discover()` and cannot name a `Client`.
//
// -----------------------------------------------------------------------------
// THREE TRANSPORTS, TWO IMPLEMENTED, ONE REFUSED UNDER ITS OWN CODE
//
// `MCP_TRANSPORTS` is `http | sse | stdio`. `DispatchTarget.transport` carries
// which one, ADMITTED by `admitTransport` in the domain before an adapter sees it
// — WIN-269 added that field precisely because a target carrying `kind: "mcp"`
// and a URL cannot distinguish `http` from `sse`, which are two different client
// constructions over the same absolute URL.
//
//   `http`   `StreamableHTTPClientTransport`. Implemented.
//   `sse`    `SSEClientTransport`. Implemented.
//   `stdio`  REFUSED, with `mcpTransportUnimplemented` and NOT with
//            `DispatchOutcome.failed`.
//
// WHY `stdio` IS REFUSED RATHER THAN HALF-BUILT. A stdio MCP server is a CHILD
// PROCESS: the client's job is to spawn a command, hold its stdin and stdout, and
// keep it alive between calls. Every part of that is a supplier decision this
// tranche is not entitled to take alone — WHICH command, from where, with which
// environment, under what isolation, with whose filesystem and network. ADR M0.3
// §7 decision 10 puts untrusted handler execution behind `durable-runtime`, an
// EXTERNAL service (`PLATOS_DURABLE_RUNTIME_API_URL` plus a secret key), and
// `SkillSandbox` is the other named holder of the same question. A `spawn()` in
// this file would be a third answer, taken by an adapter, to a question two
// architecture decisions have already assigned elsewhere.
//
// AND WHY THE REFUSAL CARRIES ITS OWN CODE. `DispatchOutcome.failed` means the
// backend was REACHED and refused. Reporting a transport this process cannot open
// as `failed` would make a SKIPPED call indistinguishable from a failed one: a
// caller reading `failed` retries, folds a health sample in, and tells its user
// the tool is broken — and none of those is true when nothing left the process and
// the backend has no opinion. `TOOLS_MCP_TRANSPORT_UNIMPLEMENTED` is `unavailable`
// with no retry hint, because retrying cannot help. It is also distinct from
// `TOOLS_MCP_TRANSPORT_INVALID`, which is a row an operator can fix.
// -----------------------------------------------------------------------------
//
// SESSIONS ARE POOLED BY `target.sessionKey`, WHICH THIS FILE DOES NOT COMPUTE.
// The key is the digest of the canonical resolved header set and
// `domain/mcp-client.ts` owns its form; the port's comment says "sessions are
// shared by it". That is the invariant that stops two credentials sharing one
// session, so an adapter that keyed the pool on the URL — or on the entity —
// would silently reintroduce the leak the domain rule exists to prevent. The pool
// is keyed on the value it was handed and on nothing else.
//
// THE SDK'S OWN TIMEOUT IS USED, NOT AN `AbortController`. `RequestOptions.timeout`
// makes the SDK raise `McpError` with `ErrorCode.RequestTimeout` (-32001), a code
// this file can branch on to produce `timeout` rather than `failed`. Wrapping the
// call in an abort instead would tear the SESSION down on one slow request, which
// is the opposite of what a pool is for.
//
// WHAT THIS FILE DOES NOT DO: it does not screen the destination. See the same
// paragraph in `wire-dispatch.ts` — `eventing`'s `DestinationScreen` is the
// declared SSRF boundary in this architecture, and a weaker second definition
// written here would drift from it. The SDK transports both accept a `fetch`
// override, which is the seam that screen plugs into on the day it is composed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { err, ok, type DomainError, type Result } from "@platos/kernel";

import {
  dispatchFailed,
  mcpTransportInvalid,
  mcpTransportUnimplemented,
  type McpTransport,
  type ToolDeclarationIntake,
} from "../domain/index.js";
import type {
  DiscoveryOutcome,
  DiscoveryRequest,
  DispatchOutcome,
  DispatchRequest,
  DispatchTarget,
} from "../application/ports/index.js";

/** The SDK's `ErrorCode.RequestTimeout`, named so a branch on -32001 reads. */
const REQUEST_TIMEOUT_CODE = -32001;

/**
 * What Platos calls itself in the MCP `initialize` handshake.
 *
 * A CONSTANT AND NOT CONFIGURATION. The name is what a third-party MCP server
 * logs and rate-limits on, so an installation that could rename it would be an
 * installation whose calls a server operator cannot attribute. The version is
 * deliberately absent rather than read from an environment variable: the MCP
 * version this tree publishes lives once in `apps/agent/src/http/mcp-surface.ts`
 * and an AST lint refuses a second spelling of it, so a literal here would be
 * that second spelling. `initialize` does not require one from a client.
 */
const CLIENT_IDENTITY = { name: "platos", version: "0" } as const;

/** One live session and the last time a call used it. */
interface PooledSession {
  readonly client: Client;
  lastUsedAt: number;
}

export interface McpSessionPool {
  dispatch(request: DispatchRequest): Promise<Result<DispatchOutcome>>;
  discover(request: DiscoveryRequest): Promise<Result<DiscoveryOutcome>>;
  /** Close every live session. Called by the composition root on shutdown. */
  close(): Promise<void>;
  /** How many sessions are live. Read by the suite; never a decision input. */
  readonly size: number;
}

export function createMcpSessionPool(): McpSessionPool {
  const sessions = new Map<string, PooledSession>();
  // IN-FLIGHT BUILDS ARE DEDUPED. Two concurrent calls on one pool key must
  // share one session, and without this they each open one and the second
  // replaces the first in the map — leaking a live socket and, on a server that
  // counts sessions, doubling the client's footprint. Transcribed from the
  // legacy pool, which has the same map for the same reason.
  const building = new Map<string, Promise<PooledSession>>();

  async function session(target: DispatchTarget): Promise<PooledSession> {
    const live = sessions.get(target.sessionKey);
    if (live !== undefined) {
      live.lastUsedAt = Date.now();
      return live;
    }
    const inFlight = building.get(target.sessionKey);
    if (inFlight !== undefined) return inFlight;

    const promise = connect(target)
      .then((entry) => {
        sessions.set(target.sessionKey, entry);
        return entry;
      })
      .finally(() => building.delete(target.sessionKey));
    building.set(target.sessionKey, promise);
    return promise;
  }

  /** Drop a session whose transport has died, so the next call rebuilds it. */
  async function evict(sessionKey: string): Promise<void> {
    const entry = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    if (entry === undefined) return;
    // BEST EFFORT, AND DELIBERATELY SWALLOWED. The session is already being
    // discarded; a throw out of `close()` on a socket that is gone would replace
    // the outcome the caller is waiting for with an unrelated failure.
    await entry.client.close().catch(() => undefined);
  }

  /**
   * Evict only if the pool still holds THIS session for that key, and only for a
   * failure that actually ended the session.
   *
   * IDENTITY, NOT KEY, for the reason the agent-side pool states: a slow call
   * that fails after a concurrent caller has already rebuilt the session must not
   * tear down the healthy replacement.
   */
  async function evictAfterFailure(sessionKey: string, entry: PooledSession, cause: unknown): Promise<void> {
    if (!failureEndsSession(cause)) return;
    if (sessions.get(sessionKey) !== entry) return;
    await evict(sessionKey);
  }

  return {
    get size(): number {
      return sessions.size;
    },

    async dispatch(request: DispatchRequest): Promise<Result<DispatchOutcome>> {
      const refusal = unreachable(request.target);
      if (refusal !== null) return err(refusal);

      const started = Date.now();
      let entry: PooledSession;
      try {
        entry = await session(request.target);
      } catch (cause) {
        // A HANDSHAKE FAILURE IS `failed` AND NOT AN `err`, and the distinction
        // is the port's: a server that would not complete `initialize` WAS
        // reached and did refuse, which is exactly what `failed` means. `err` is
        // reserved for the case where nothing was tried at all.
        return ok({ kind: "failed", reason: handshakeReason(cause), latencyMs: Date.now() - started });
      }

      try {
        const answer = await entry.client.callTool(
          { name: request.toolName, arguments: { ...request.arguments } },
          undefined,
          { timeout: request.target.timeoutMs },
        );
        const latencyMs = Date.now() - started;
        // `isError` IS THE PROTOCOL'S OWN TOOL-LEVEL FAILURE and is not a
        // transport error: the server answered, and the answer says the tool
        // itself failed. Folding it into `succeeded` would report a broken tool
        // as working; raising it as `err` would say nothing was dispatched.
        if (answer.isError === true) {
          return ok({ kind: "failed", reason: "tool_reported_error", latencyMs });
        }
        return ok({ kind: "succeeded", result: answer, latencyMs });
      } catch (cause) {
        const latencyMs = Date.now() - started;
        // The session may be dead. Drop it so the next call rebuilds rather than
        // reusing a transport whose socket has gone — but ONLY when the failure
        // really ended it. `evict` closes the session under EVERY caller sharing
        // this pool key, so an unconditional close here turned one tool's request
        // timeout into "MCP error -32000: Connection closed" for every other call
        // in flight on the same key.
        await evictAfterFailure(request.target.sessionKey, entry, cause);
        if (isTimeout(cause)) return ok({ kind: "timeout", latencyMs });
        return ok({ kind: "failed", reason: callReason(cause), latencyMs });
      }
    },

    async discover(request: DiscoveryRequest): Promise<Result<DiscoveryOutcome>> {
      const refusal = unreachable(request.target);
      if (refusal !== null) return err(refusal);

      let entry: PooledSession;
      try {
        entry = await session(request.target);
      } catch (cause) {
        // DISCOVERY FAILS AS AN `err` WHERE DISPATCH FAILS AS A VALUE, and the
        // asymmetry is `discover-entity-tools.ts`'s rather than this file's: it
        // treats a failed discovery as a recorded failure that registers and
        // PRUNES NOTHING. `ok({ tools: [] })` would be indistinguishable from a
        // server that genuinely publishes no tools, and `registerTools` does an
        // idempotent replace — so that answer would delete every tool the entity
        // has whenever its server was briefly unreachable.
        return err(discoveryFailed(cause));
      }
      try {
        const listed = await entry.client.listTools(undefined, {
          timeout: request.target.timeoutMs,
        });
        return ok({ tools: listed.tools.map(intakeOf) });
      } catch (cause) {
        // The same rule as `dispatch`'s catch arm, and for the same reason: a
        // `tools/list` that timed out or that the server answered with a JSON-RPC
        // error left the session alive, and closing it would fail every call
        // another caller has in flight on this key.
        await evictAfterFailure(request.target.sessionKey, entry, cause);
        return err(discoveryFailed(cause));
      }
    },

    async close(): Promise<void> {
      const live = [...sessions.values()];
      sessions.clear();
      building.clear();
      await Promise.all(live.map((entry) => entry.client.close().catch(() => undefined)));
    },
  };
}

/**
 * Whether this adapter can reach the target at all, and the refusal if not.
 *
 * Returns `null` when it can. The two refusals are DIFFERENT CODES because they
 * have different operator responses: `stdio` is a supplier gap nothing an
 * operator edits will close, and a missing or unrecognised transport on an `mcp`
 * target is a row that `admitTransport` should already have refused — reaching
 * here means the resolver was bypassed, which is a defect rather than a gap.
 */
function unreachable(target: DispatchTarget): DomainError | null {
  const transport: McpTransport | null = target.transport;
  if (transport === "stdio") {
    return mcpTransportUnimplemented(
      "stdio",
      "a stdio MCP server is a child process; ADR M0.3 §7 decision 10 assigns untrusted process execution to durable-runtime and SkillSandbox, and no adapter in this tree supplies either",
    );
  }
  if (transport === null) {
    return mcpTransportInvalid(
      "an mcp target reached the dispatch adapter with no transport; admitTransport was not run",
      "null",
    );
  }
  if (target.url === null) {
    // `admitTransport` already refuses `http`/`sse` with no URL, so this is the
    // same defect the clause above catches, one field along.
    return mcpTransportInvalid(
      "an mcp target reached the dispatch adapter with no url; admitTransport was not run",
      transport,
    );
  }
  return null;
}

async function connect(target: DispatchTarget): Promise<PooledSession> {
  const url = new URL(target.url as string);
  // `requestInit.headers` is merged by BOTH transports into every request they
  // make, which is how the already-resolved credential rides along without this
  // file re-merging it per call — and re-merging per call is what would risk
  // overwriting a protocol header the SDK owns (`mcp-session-id`, `accept`).
  const options = { requestInit: { headers: { ...target.headers } } };
  const transport =
    target.transport === "sse"
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options);

  const client = new Client(CLIENT_IDENTITY, { capabilities: {} });
  try {
    // The handshake is bound by the target's own budget. A server that accepts a
    // socket and never answers `initialize` would otherwise wedge the caller for
    // the SDK's default timeout rather than for the one the domain resolved.
    await client.connect(transport, { timeout: target.timeoutMs });
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause;
  }
  return { client, lastUsedAt: Date.now() };
}

/**
 * One listed tool, reduced to the port's UNADMITTED intake shape.
 *
 * `inputSchema` becomes `paramSchema` and NOTHING ELSE MOVES. Admission is a
 * domain rule — `admitDeclaration` in `domain/declaration.ts` trims the name,
 * bounds the description, defaults the schema and infers the category — and the
 * port says outright that running it inside the adapter "would let a transport
 * decide what a valid tool name is". No `category` is sent because MCP has no
 * such field: inventing one from `annotations.title` would be this adapter
 * deciding a domain default.
 */
function intakeOf(tool: { name: string; description?: string; inputSchema?: unknown }): ToolDeclarationIntake {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { paramSchema: tool.inputSchema }),
  };
}

/** The SDK raises `McpError` with code -32001 on its own request timeout. */
function isTimeout(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === REQUEST_TIMEOUT_CODE;
}

/**
 * Did this failure END the session, or is the session still alive?
 *
 * THE POOL KEY IS SHARED, WHICH IS WHY THIS QUESTION EXISTS. Sessions here are
 * pooled by `target.sessionKey`, so closing one closes it under every caller
 * holding that key — the entity's other tools, and every end user whose resolved
 * URL and headers are the same. Before this, both catch arms closed the session
 * for ANY thrown value, so a plain `McpError` `RequestTimeout` (-32001) on one
 * slow tool killed every concurrent call on the key with
 * `MCP error -32000: Connection closed`. The failure a caller then saw had
 * nothing to do with the call it made.
 *
 * A PROTOCOL-LAYER ANSWER IS PROOF THE SESSION IS ALIVE. An `McpError` with a
 * numeric `code` is the SDK surfacing something that came back over a working
 * transport: the server's own JSON-RPC error, or the client's own timer firing
 * on a request the server has not answered yet. Both leave the socket open, so
 * neither is a reason to close it. Everything else — a socket that went away, a
 * 404 on a session id a restarted server has forgotten, a fetch that threw — is
 * taken as the end of the session, which is the old behaviour for exactly the
 * cases it was right for.
 *
 * THIS IS THE SAME RULE `failureEndsSession` APPLIES IN
 * `apps/agent/src/tool-gateway/mcp-transport/mcp-client-pool.service.ts`, whose
 * own comment used to point AT THIS FILE as the copy that "already evicts on
 * exactly this condition". It did not; it evicted on every condition. The two
 * are now the same rule in both deployables, and `mcp-dispatch.test.ts`'s
 * sibling-call cases are what hold this one to it.
 *
 * ONE DIFFERENCE FROM THE AGENT'S, AND IT IS NOT A DISAGREEMENT: that one also
 * asks whether the client still has a transport attached, because it holds the
 * `Client` and can. Here the equivalent state is the pool entry itself, and the
 * caller checks it — `evictAfterFailure` evicts only while the map still holds
 * the entry the failing call used.
 */
export function failureEndsSession(cause: unknown): boolean {
  const candidate = cause as { name?: unknown; code?: unknown } | null;
  const fromProtocolLayer =
    typeof candidate === "object" && candidate !== null && candidate.name === "McpError" && typeof candidate.code === "number";
  return !fromProtocolLayer;
}

/**
 * Why the `initialize` handshake did not complete, reduced to a safe token.
 *
 * NOT the message. A TLS or DNS failure message carries the host, the resolved
 * address and sometimes a certificate subject, and this string reaches an audit
 * row an MCP client may be shown.
 */
function handshakeReason(cause: unknown): string {
  const code = (cause as { cause?: { code?: unknown }; code?: unknown } | null);
  const inner = code?.cause?.code;
  if (typeof inner === "string" && inner !== "") return `handshake_${inner.toLowerCase()}`;
  if (typeof code?.code === "number") return `handshake_jsonrpc_${String(code.code)}`;
  return "handshake_failed";
}

/** The same reduction for a failed `tools/call`. */
function callReason(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "number") return `jsonrpc_${String(code)}`;
  return "call_failed";
}

/**
 * A failed enumeration, as a domain error.
 *
 * `mcpTransportInvalid` would be wrong — the transport is fine and the server is
 * not — so this reuses the runtime-unavailable code the catalogue already has for
 * a backend that could not be reached, and puts the reduced cause in `details`.
 * `discover-entity-tools.ts` renders `error.message` into its own answer, which
 * is why the message says what happened and the diagnosis stays in `details`.
 */
function discoveryFailed(cause: unknown): DomainError {
  return dispatchFailed(isTimeout(cause) ? "discovery_timeout" : handshakeReason(cause));
}
