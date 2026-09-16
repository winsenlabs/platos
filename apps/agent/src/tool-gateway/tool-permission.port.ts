/**
 * WIN-269 (M4.3) — THE TOOL-DISPATCH PERMISSION PORT.
 *
 * THE CYCLE THIS EXISTS TO REMOVE. `tool-executor.service.ts` and
 * `tool-gateway.module.ts` both imported `MCPPermissionGatewayService` out of
 * `apps/agent/src/mcp-platform`, while `mcp-platform` imports the executor, the
 * router and the registry back out of `tool-gateway`. That is a tool↔MCP import
 * cycle, and `tool-gateway.module.ts` said so in a comment — it registered a
 * SECOND instance of the service locally precisely to dodge the `forwardRef`
 * the cyclic MODULE graph would otherwise have needed. A comment is not a gate;
 * `scripts/arch/agent-area-cycles.mjs` is.
 *
 * THE INVERSION. `tool-gateway` owns the port: the token, the query and the
 * decision it needs. `mcp-platform` PROVIDES it
 * (`mcp-platform/mcp-port-bindings.module.ts` binds the token to
 * `MCPPermissionGatewayService`). The dependency now runs MCP -> tool, the same
 * direction as every other edge between the two areas.
 *
 * THE SHAPE IS DELIBERATELY NARROWER THAN THE SERVICE. `ToolPermissionQuery`
 * omits `sessionOverrides` and `tokenTier`, which only an MCP caller can supply
 * and which the dispatcher has never sent; `ToolPermissionDecision` is the
 * three fields the dispatcher reads. A port that re-exported
 * `ResolvePermissionInput` wholesale would be the same import edge wearing an
 * interface, and would let the MCP token tiering leak into agent dispatch by
 * accident later.
 */

/**
 * The DI token. A string rather than a class, because binding to the class is
 * exactly the import this port removes.
 */
export const TOOL_PERMISSION_GATEWAY = "TOOL_PERMISSION_GATEWAY";

/** The three states the dispatcher branches on. */
export type ToolPermissionState = "auto_allow" | "require_approval" | "block";

/** What the dispatcher knows about the call it is about to make. */
export interface ToolPermissionQuery {
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  agentId: string | null;
  userId: string | null;
  toolName: string;
}

/** What the dispatcher needs back: the verdict, which tier won, and why. */
export interface ToolPermissionDecision {
  state: ToolPermissionState;
  tier: 1 | 2 | 3 | 4;
  reason: string;
}

/**
 * The port. `MCPPermissionGatewayService implements` this, so the structural
 * match is checked by the compiler at the implementation rather than asserted
 * here.
 */
export interface ToolPermissionGateway {
  resolve(input: ToolPermissionQuery): Promise<ToolPermissionDecision>;
}
