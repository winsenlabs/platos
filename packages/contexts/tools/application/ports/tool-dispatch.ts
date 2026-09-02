// `ToolDispatch` — the adapter-facing port this context OWNS, and the SDK
// containment boundary that makes ADR M0.3 §5.1 rule (h) meaningful.
//
// Rule (h) binds `@modelcontextprotocol/*` to `packages/contexts/tools/adapters`
// and `.../transport` and nowhere else. This interface is why that is
// enforceable: everything above it — the routing, the four-tier lattice, the
// health fold, the audit envelope — is expressed against `dispatch()` and
// `discover()`, and nothing above it knows whether a call left over a
// WebSocket, an HTTP POST or an MCP session.
//
// TWO TRANSPORTS, ONE PORT, AND THE ASYMMETRY IS REAL.
//
//   a WIRE entity opened an inbound socket to Platos and Platos answers on it.
//   Liveness is something Platos OBSERVES.
//
//   an MCP entity is a server Platos opens a session TO. Liveness is something
//   Platos ATTEMPTS, and the attempt is the only way to find out.
//
// The port hides which one is in play because the caller's decision is the same
// either way, and `domain/exposure.ts` states the one rule that differs
// (`dispatchabilityOf`) as data rather than as a branch in a use case.
//
// DISCOVERY IS ONLY MEANINGFUL FOR MCP. A wire backend REGISTERS its tools by
// pushing a declaration; an MCP backend is ASKED. `discover` therefore returns
// the same admitted declaration shape `registerTools` takes, so the two paths
// converge on one write and cannot drift.
//
// NOTHING HERE TAKES A CREDENTIAL. The adapter receives already-resolved
// headers and an already-resolved URL, because resolving them is a domain rule
// with a fail-closed invariant (`domain/mcp-client.ts`) that must run before an
// adapter is reached — not inside one, where it could be skipped.

import type { Result } from "@platos/kernel";

import type { ToolDeclarationIntake, ToolName } from "../../domain/index.js";

/** The already-resolved transport a call goes out on. Never a template. */
export interface DispatchTarget {
  readonly kind: "wire" | "mcp";
  /** The entity's own name for itself, which the wire transport routes on. */
  readonly externalEntityId: string;
  /** Absolute, substituted. Null only for a stdio MCP session. */
  readonly url: string | null;
  /** Substituted. May contain secret material; never logged, never returned. */
  readonly headers: Readonly<Record<string, string>>;
  /** The pool key `domain/mcp-client.ts` computed. Sessions are shared by it. */
  readonly sessionKey: string;
  readonly timeoutMs: number;
}

export interface DispatchRequest {
  readonly target: DispatchTarget;
  readonly toolName: ToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Correlates the call across the transport, the audit row and the trace. */
  readonly callId: string;
}

/**
 * What a backend answered.
 *
 * `rateLimited` is its own outcome rather than a flavour of `failed` because it
 * carries an instruction: a model reading "try again in 30 seconds" can wait,
 * and a model reading "it failed" retries immediately and is refused again.
 */
export type DispatchOutcome =
  | { readonly kind: "succeeded"; readonly result: unknown; readonly latencyMs: number }
  | { readonly kind: "failed"; readonly reason: string; readonly latencyMs: number }
  | { readonly kind: "timeout"; readonly latencyMs: number }
  | {
      readonly kind: "rateLimited";
      readonly retryAfterSeconds: number;
      readonly latencyMs: number;
    };

export interface DiscoveryRequest {
  readonly target: DispatchTarget;
}

export interface DiscoveryOutcome {
  readonly tools: readonly ToolDeclarationIntake[];
}

export interface ToolDispatch {
  /**
   * Make one call.
   *
   * Never throws for a backend-side outcome: a refusal, a timeout and a 429 are
   * all values. A thrown exception crossing this port means a defect in the
   * adapter, which is what the kernel's `Result` note says it should mean.
   */
  dispatch(request: DispatchRequest): Promise<Result<DispatchOutcome>>;

  /**
   * Enumerate an MCP server's tools.
   *
   * Returns the UNADMITTED intake shape. Admission is a domain rule
   * (`domain/declaration.ts`) and running it inside the adapter would let a
   * transport decide what a valid tool name is.
   */
  discover(request: DiscoveryRequest): Promise<Result<DiscoveryOutcome>>;
}
