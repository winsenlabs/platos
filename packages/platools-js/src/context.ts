/**
 * Per-call context for platools tool handlers (TypeScript SDK).
 *
 * Mirrors `platools/context.py` in shape and semantics. The Platos
 * platform injects a `__platos` envelope into every `tool_call`
 * message's `params` dict before it reaches this SDK. The transport
 * layer pops the envelope (so user handlers never see it) and stores
 * it on an `AsyncLocalStorage` frame for the duration of one call, so
 * handler code can read it via {@link currentContext} without every
 * function signature growing a context parameter.
 *
 * Example:
 *
 *     import { currentContext, currentUserId } from "@platosdev/platools-sdk";
 *
 *     export const listOrders = platools.tool(
 *       {
 *         name: "list_orders",
 *         description: "List orders for a customer",
 *         input: z.object({ customerId: z.string() }),
 *         auth: "user",
 *       },
 *       async ({ customerId }) => {
 *         const uid = currentUserId();                    // string | undefined
 *         const ctx = currentContext();                    // full typed shape
 *         return db.listOrders({ customerId, userId: uid });
 *       },
 *     );
 *
 * Concurrent tool calls in the same Node worker do not leak context
 * into each other: `AsyncLocalStorage.run()` creates an async-scoped
 * frame, and the transport wraps every handler invocation in its own
 * frame (see `transport/client.ts::dispatchCall`). The invariant
 * matches the Python SDK's `contextvars` semantics bit-for-bit.
 *
 * Field names mirror the envelope the server writes in
 * `apps/agent/src/tool-gateway/tool-executor.service.ts` (camelCase,
 * because that's the wire format).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Typed snapshot of the `__platos` envelope for the current tool call.
 *
 * Field set is the Platos-V2 mandatory tool-call params matrix:
 *
 * | Field            | Meaning                                            |
 * |------------------|----------------------------------------------------|
 * | organizationId   | trigger.dev org id                                 |
 * | projectId        | trigger.dev project id                             |
 * | environmentId    | trigger.dev environment id (dev/staging/prod/…)    |
 * | entityId         | Which registered entity's SDK is handling this     |
 * | userId           | End-user id the agent is acting on behalf of       |
 * | userToken        | Optional caller access token (present for auth:user)|
 * | agentId          | The agent that dispatched this call                |
 * | threadId         | The conversation / thread the call belongs to      |
 * | callId           | Unique platform-assigned id for this invocation    |
 * | timestamp        | Server-signed timestamp (ISO-8601)                 |
 * | nonce            | Per-request nonce (PPR-71, absent on legacy callers)|
 * | signature        | HMAC-SHA256 signature of the request body          |
 */
export interface PlatosCallContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly entityId: string;
  readonly userId: string;
  readonly userToken?: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly callId: string;
  readonly timestamp: string;
  /** PPR-71: per-request nonce. Absent on legacy (pre-PPR-71) callers. */
  readonly nonce?: string;
  readonly signature: string;
}

/**
 * Internal AsyncLocalStorage slot carrying the full context. Module-
 * private — everything external goes through the accessors below so
 * we can swap the storage backend without breaking the public API.
 */
const storage = new AsyncLocalStorage<PlatosCallContext>();

/**
 * Run `fn` with `context` as the active `PlatosCallContext`. Intended
 * for the transport layer and tests — user code should never need to
 * call this directly.
 *
 * Returns a Promise that resolves to `fn`'s return value. The context
 * is scoped to the async subtree of this invocation; once `fn` settles
 * the context is torn down automatically by `AsyncLocalStorage`.
 */
export function runWithContext<T>(
  context: PlatosCallContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    storage.run(context, () => {
      Promise.resolve()
        .then(fn)
        .then(resolve, reject);
    });
  });
}

/**
 * Return the full typed context for the in-flight tool call, or
 * `undefined` if called outside a dispatched handler (e.g. from
 * module top-level, a unit test with no envelope, or the local test
 * runner).
 */
export function currentContext(): PlatosCallContext | undefined {
  return storage.getStore();
}

/** The calling end-user's id, or `undefined` if not in a tool call. */
export function currentUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/** Optional caller access token, or `undefined`. */
export function currentUserToken(): string | undefined {
  return storage.getStore()?.userToken;
}

/** Conversation/thread id, or `undefined`. */
export function currentThreadId(): string | undefined {
  return storage.getStore()?.threadId;
}

/** Dispatching agent id, or `undefined`. */
export function currentAgentId(): string | undefined {
  return storage.getStore()?.agentId;
}

/** Registered entity id, or `undefined`. */
export function currentEntityId(): string | undefined {
  return storage.getStore()?.entityId;
}

/** Platform-assigned call id, or `undefined`. */
export function currentCallId(): string | undefined {
  return storage.getStore()?.callId;
}

/**
 * The trigger.dev scope tuple `(organizationId, projectId, environmentId)`
 * for the current call. Any element is `undefined` outside a dispatch.
 */
export function currentScope(): {
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
} {
  const ctx = storage.getStore();
  if (ctx === undefined) return {};
  return {
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
  };
}

/**
 * Per-call handler context (CTX.5).
 *
 * Passed as the optional second argument to every registered tool
 * handler. Gives handlers direct access to the Platos `_context`
 * envelope the agent builds from `contextMapping.envelopeKeys` —
 * things like `user.id`, custom per-entity identity fields, and the
 * caller-declared `entity_ids` used for matrix routing.
 *
 * The handler argument is **optional** for backwards compatibility:
 * existing handlers declared as `(params) => ...` keep working. New
 * handlers that want the context pop a `ctx?: PlatosContext` onto
 * their signature and read `ctx?.context["user.id"]` etc.
 *
 * The `_context` envelope is distinct from the `__platos` envelope
 * (which is the organization/project/environment/entity tuple the
 * platform signs and verifies). Both ride in the tool-call
 * `arguments` payload; the SDK pops both before Zod validation so
 * neither leaks into the handler's typed input.
 */
export interface PlatosContext {
  /** Platform-assigned id for this single tool invocation. */
  readonly callId: string;
  /**
   * The unpacked `_context` envelope — arbitrary key/value pairs
   * built by the platform from the tool's `contextMapping`. Keys can
   * be dotted (e.g. `user.id`) and values are whatever the agent
   * resolved at dispatch time. Empty `{}` when the platform did not
   * attach a `_context` envelope (older agent, local test run).
   */
  readonly context: Readonly<Record<string, unknown>>;
  /**
   * The caller-declared entity id narrowing list (used for
   * tool-matrix routing when a tool-name collides across multiple
   * registered entities). Heuristically extracted from the envelope's
   * `entity_ids` or `entityIds` key when present — otherwise
   * `undefined`. Consumers that need a specific key should read it
   * directly from `context` instead.
   */
  readonly entityIds?: readonly string[];
  /**
   * Escape hatch: the original, untouched `_context` envelope value
   * the platform sent. Use when `context` does not expose a field you
   * need (e.g. inspecting the wire shape during debugging, or when
   * the envelope contains nested objects that a flat `Record` does
   * not faithfully represent).
   */
  readonly raw: unknown;
}

/**
 * Build a `PlatosContext` from a popped `_context` envelope. Tolerant:
 * a missing / non-object envelope produces a context with an empty
 * `context` map and `undefined` `entityIds`, so handlers branching on
 * `if (ctx.entityIds)` behave predictably.
 *
 * Exported so the local test runner (`testing/runner.ts`) and
 * consumers wiring their own dispatcher can construct the same shape
 * the transport produces. `makeLocalContext` is the canonical entry
 * point for unit tests — this one is for advanced use only.
 */
export function buildPlatosContext(callId: string, rawContextEnvelope: unknown): PlatosContext {
  const safeObject: Readonly<Record<string, unknown>> =
    rawContextEnvelope !== null && typeof rawContextEnvelope === "object"
      ? Object.freeze({ ...(rawContextEnvelope as Record<string, unknown>) })
      : Object.freeze({});
  const entityIds = extractEntityIds(safeObject);
  return Object.freeze({
    callId,
    context: safeObject,
    ...(entityIds !== undefined ? { entityIds } : {}),
    raw: rawContextEnvelope,
  });
}

function extractEntityIds(
  envelope: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  // The platform's default envelope key is `entity_ids` (see
  // `apps/agent/src/tool-gateway/tool-executor.service.ts:267`); some
  // entities configure `entityIds` or a custom path. We check the two
  // common defaults and leave anything else for the caller to read
  // directly off `ctx.context`.
  const raw = envelope["entity_ids"] ?? envelope["entityIds"];
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string") out.push(v);
  }
  return out.length === 0 ? undefined : Object.freeze(out);
}

/**
 * Raw envelope shape the server writes onto the wire. Only used by the
 * transport layer to turn the wire dict into a typed `PlatosCallContext`
 * — callers should consume `PlatosCallContext` instead.
 */
export interface PlatosEnvelope {
  readonly organizationId?: unknown;
  readonly projectId?: unknown;
  readonly environmentId?: unknown;
  readonly entityId?: unknown;
  readonly userId?: unknown;
  readonly userToken?: unknown;
  readonly agentId?: unknown;
  readonly threadId?: unknown;
  readonly callId?: unknown;
  readonly timestamp?: unknown;
  readonly nonce?: unknown;
  readonly signature?: unknown;
}

/**
 * Coerce an envelope dict (as popped off `params.__platos`) into a
 * fully-populated `PlatosCallContext`.
 *
 * **Strict semantics (PPR-29):** mirrors the Python SDK's
 * `current_context()` — returns `null` if *any* required field is
 * missing or not a string. Consumers get the typed shape or nothing, so
 * handler code that branches on `if (ctx)` behaves identically across
 * languages on partial envelopes. Prior (lenient) behavior coerced
 * missing fields to empty strings; that created a cross-SDK divergence
 * where the same wire envelope produced a populated context in TS and
 * `None` in Python.
 *
 * `userToken` is optional — absent or non-string is fine.
 *
 * Returns `null` if `envelope` itself is not an object, or if any
 * required field is missing / not a string.
 */
export function envelopeToContext(envelope: unknown): PlatosCallContext | null {
  if (envelope === null || typeof envelope !== "object") return null;
  const e = envelope as PlatosEnvelope;
  const required = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const organizationId = required(e.organizationId);
  const projectId = required(e.projectId);
  const environmentId = required(e.environmentId);
  const entityId = required(e.entityId);
  const userId = required(e.userId);
  const agentId = required(e.agentId);
  const threadId = required(e.threadId);
  const callId = required(e.callId);
  const timestamp = required(e.timestamp);
  const signature = required(e.signature);
  if (
    organizationId === null ||
    projectId === null ||
    environmentId === null ||
    entityId === null ||
    userId === null ||
    agentId === null ||
    threadId === null ||
    callId === null ||
    timestamp === null ||
    signature === null
  ) {
    return null;
  }
  const token =
    typeof e.userToken === "string" && e.userToken.length > 0 ? e.userToken : undefined;
  // PPR-71: `nonce` is optional for one release so legacy callers (or a
  // rolling deploy where the agent hasn't been upgraded yet) don't error
  // out. When present, we surface it; the replay-guard layer (see
  // `verifyRequest` / per-entity LRU) is responsible for enforcement.
  const nonce =
    typeof e.nonce === "string" && e.nonce.length > 0 ? e.nonce : undefined;
  const context: PlatosCallContext = {
    organizationId,
    projectId,
    environmentId,
    entityId,
    userId,
    agentId,
    threadId,
    callId,
    timestamp,
    signature,
    ...(token !== undefined ? { userToken: token } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
  };
  return context;
}
