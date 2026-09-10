// `ToolDispatch`, composed: the wire POST and the MCP session pool behind one
// port, routed on `target.kind` and on nothing else.
//
// THE PORT HIDES WHICH TRANSPORT IS IN PLAY AND THIS FILE IS WHY THAT IS TRUE.
// Everything above the port asks the same question — "make this call" — and the
// asymmetry the port's header describes (a wire entity's liveness is OBSERVED, an
// MCP server's is TRIED) is expressed as two implementations under one switch
// rather than as a branch in a use case.
//
// `discover` IS NOT SYMMETRIC AND MUST NOT PRETEND TO BE. The port says
// "DISCOVERY IS ONLY MEANINGFUL FOR MCP. A wire backend REGISTERS its tools by
// pushing a declaration; an MCP backend is ASKED." So a `wire` target reaching
// `discover` is refused with `mcpDisabled` — "this entity does not host an MCP
// surface", which is exactly the fact — and NOT with `ok({ tools: [] })`. That
// second answer would be the dangerous one: `registerTools` performs an
// idempotent REPLACE including a prune, so an empty discovery of a wire entity
// would delete every tool that entity had ever registered.
//
// `close()` IS PART OF THE OBJECT AND IS NOT ON THE PORT. The port declares two
// methods and neither is a lifecycle hook, because nothing above it should have
// to know whether an implementation holds sockets. The composition root does, so
// the FACTORY's return type widens the port with a `close()` the shutdown path
// calls. This is the same shape `PostgresTenancyAdapter` uses for its pool: the
// port stays two methods, and the object an install holds knows how to stop.

import { err, ok, type Result } from "@platos/kernel";

import { mcpDisabled } from "../domain/index.js";
import type {
  DiscoveryOutcome,
  DiscoveryRequest,
  DispatchOutcome,
  DispatchRequest,
  ToolDispatch,
} from "../application/ports/index.js";
import { createMcpSessionPool, type McpSessionPool } from "./mcp-dispatch.js";
import { dispatchOverWire } from "./wire-dispatch.js";

export interface ToolDispatchAdapter extends ToolDispatch {
  /**
   * The MCP session pool's live count.
   *
   * Published so a suite can assert that two calls sharing a `sessionKey` opened
   * ONE session and that a call with a different key opened a second — the
   * invariant `domain/mcp-client.ts` computes the key for. Never read by a
   * decision in this package.
   */
  readonly liveMcpSessions: number;
  /** Close every MCP session this adapter opened. Idempotent. */
  close(): Promise<void>;
}

export function createToolDispatchAdapter(): ToolDispatchAdapter {
  const pool: McpSessionPool = createMcpSessionPool();

  return {
    get liveMcpSessions(): number {
      return pool.size;
    },

    async dispatch(request: DispatchRequest): Promise<Result<DispatchOutcome>> {
      // A SWITCH ON A TWO-VALUED UNION, not an `if (kind === "mcp")`. The union
      // is `"wire" | "mcp"`; `noFallthroughCasesInSwitch` plus the exhaustive
      // return means the day a third kind is added to the port, this file fails
      // to compile rather than silently sending it down the wire path.
      switch (request.target.kind) {
        case "wire":
          return dispatchOverWire(request);
        case "mcp":
          return pool.dispatch(request);
      }
    },

    async discover(request: DiscoveryRequest): Promise<Result<DiscoveryOutcome>> {
      switch (request.target.kind) {
        case "wire":
          return err(
            mcpDisabled(request.target.externalEntityId),
          );
        case "mcp":
          return pool.discover(request);
      }
    },

    async close(): Promise<void> {
      await pool.close();
    },
  };
}
