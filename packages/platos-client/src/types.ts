/**
 * @platosdev/client — shared type surface.
 *
 * Types re-exported from the root `index.ts`. Keeping them isolated so
 * consumer code that only needs types (e.g. server-side schema
 * generation) can `import type { ... } from "@platosdev/client/types"`
 * without pulling in `socket.io-client`.
 */

export interface PlatosScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  /** Optional — falls back to the token's embedded user if not provided. */
  userId?: string;
  /**
   * EOBD.86 — per-call override for the opaque per-user identity.
   * Overrides the client-level `PlatosClientOptions.userToken` for a
   * single invocation (impersonation by admin tooling, etc).
   */
  userToken?: string;
}

export interface PlatosAgent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  [extra: string]: unknown;
}

export interface PlatosThread {
  id: string;
  agentId: string;
  title?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  [extra: string]: unknown;
}

export interface PlatosMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
  [extra: string]: unknown;
}

export interface PlatosArtifact {
  id: string;
  threadId: string;
  artifactKey: string;
  kind: string;
  revision: number;
  title?: string | null;
  language?: string | null;
  content: string;
  createdAt: string;
  [extra: string]: unknown;
}

/**
 * Discriminated union of every event the agent emits over Socket.IO.
 * Mirrors the server-side `AgentStreamEvent` type plus a few
 * client-specific helpers (`connected` / `disconnected`). Keep the
 * server + client types in lockstep — see
 * `apps/agent/src/agent-runtime/agent.service.ts` for the canonical
 * definition.
 */
export type PlatosStreamEvent =
  | { type: "connected" }
  | { type: "disconnected"; reason?: string }
  | { type: "reconnecting"; attempt: number }
  | { type: "status"; status: string; agentId?: string }
  | { type: "meta"; thread_id?: string; agent_id?: string; usage?: Record<string, unknown> }
  | { type: "token"; text: string }
  | { type: "message_boundary" }
  | { type: "message_persisted"; messageId: string; threadId?: string; costCents?: number; replyToMessageId?: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; params: Record<string, unknown>; callId: string }
  | { type: "tool_result"; name: string; result: unknown; callId: string; display?: unknown }
  | { type: "approval_needed"; approvalId: string; action: string; details?: string }
  | { type: "run_update"; runId: string; status: string; metadata?: Record<string, unknown> | null; output?: unknown; error?: unknown }
  | { type: "structured_output"; object: unknown; attempts: number }
  | { type: "artifact_start"; artifactId: string; artifactKey: string; kind: string; revision: number; title?: string; language?: string; op: "generate" | "revise" }
  | { type: "artifact_delta"; artifactId: string; artifactKey: string; chunk: string }
  | { type: "artifact_committed"; artifactId: string; artifactKey: string; kind: string; revision: number; title?: string; language?: string; finalContent: string; createdAt: string }
  | { type: "artifact_error"; artifactId?: string; artifactKey?: string; code: string; message: string }
  | { type: "safety_flags"; flags: Array<Record<string, unknown>> }
  | { type: "error"; message: string; [extra: string]: unknown }
  | { type: "done"; usage?: Record<string, unknown>; stopped?: boolean }
  | { type: string; [extra: string]: unknown };

/**
 * Retry policy options. Applied by the core `_fetch` helper on network
 * errors, 5xx responses, and 429s that carry `Retry-After`.
 */
export interface PlatosRetryOptions {
  /** Max retry attempts (excluding the original request). Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 250ms. */
  baseDelayMs?: number;
  /** Ceiling on a single delay. Default: 10_000ms. */
  maxDelayMs?: number;
  /** Jitter fraction (0..1) applied to each delay. Default: 0.2. */
  jitter?: number;
}

/**
 * Async hook invoked when a request receives 401 / 403. Return a fresh
 * session token (or `null` to bubble the original auth error up). The
 * SDK will retry the failed request exactly once with the new token.
 */
export type PlatosTokenRefreshFn = (ctx: {
  /** The current token the SDK holds (may be stale). */
  currentToken: string | undefined;
  /** The status code that triggered the refresh. */
  status: number;
}) => Promise<string | null>;

export interface PlatosClientOptions {
  /**
   * Base URL of the Platos agent service. e.g. `https://agent.platos.dev`
   * or `http://localhost:3100` for local dev.
   */
  baseUrl: string;
  /**
   * Session-token JWT minted by the entity's webapp (Mode 2). Preferred
   * for any consumer-facing deployment.
   */
  sessionToken?: string;
  /**
   * Direct-header API key — only valid for trusted internal calls. When
   * set, `scope` MUST be passed on every method.
   */
  apiKey?: string;
  /**
   * Optional `fetch` override — defaults to the global fetch. Useful for
   * tests and edge runtimes that ship a custom fetch.
   */
  fetch?: typeof fetch;
  /**
   * Socket.IO namespace — defaults to `/agent` which matches
   * `apps/agent/src/connections/connections.gateway.ts`.
   */
  socketNamespace?: string;
  /** Retry policy for REST calls. Defaults documented on `PlatosRetryOptions`. */
  retry?: PlatosRetryOptions;
  /**
   * Async hook that returns a new session token when the SDK hits 401/403.
   * Useful for SPAs that can refresh the token from the customer's backend
   * without tearing down the `PlatosClient`.
   */
  onTokenRefresh?: PlatosTokenRefreshFn;
  /**
   * Per-call timeout (ms). Default: 30_000. Applied via `AbortSignal`
   * when the caller hasn't supplied one.
   */
  timeoutMs?: number;
  /**
   * EOBD.86 — per-user identity passthrough. Opaque token minted by
   * the customer backend (can be their own JWT, a random id, or a
   * signed proof). Forwarded as `X-Platos-User-Token` on every call
   * so the agent's tool backend can scope work per end-user.
   *
   * Per-call override via `scope.userToken` when calling a specific
   * method — useful for admin tooling that impersonates a user for a
   * single request.
   */
  userToken?: string;
}

export interface SendMessageOptions {
  agentId?: string;
  contextType?: string;
  contextId?: string;
  dynamicBlocks?: Record<string, string>;
  attachmentIds?: string[];
  /**
   * Optional AbortSignal — when aborted, the Socket.IO connection is
   * closed and the iterator returns `{ type: "done", stopped: true }`.
   */
  signal?: AbortSignal;
  /**
   * Max socket-reconnection attempts during a single `send()` call.
   * Default: 5. After that the iterator emits `{ type: "error", ... }`
   * and exits. Events that arrive while reconnecting are buffered; none
   * are dropped.
   */
  maxReconnectAttempts?: number;
  /**
   * Per-request model routing label. Selects a named route from the agent's
   * `modelRoutes` config (e.g. `"alpha"`, `"bravo"`, `"fast"`). Falls back to
   * the default route (or the legacy `model` field) when omitted.
   *
   * Example:
   * ```ts
   * thread.send("Summarise this doc", { modelLabel: "fast" });
   * thread.send("Reason through this carefully", { modelLabel: "smart" });
   * ```
   */
  modelLabel?: string;
}
