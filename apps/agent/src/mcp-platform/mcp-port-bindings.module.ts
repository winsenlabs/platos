import { Global, Module } from "@nestjs/common";

import { ERASURE_ADMIN_CREDENTIALS } from "../privacy/admin-credential.port";
import { TOOL_PERMISSION_GATEWAY } from "../tool-gateway/tool-permission.port";
import { MCPPermissionGatewayService } from "./permission-gateway.service";
import { PlatosMCPTokenService } from "./token.service";

/**
 * WIN-269 (M4.3) — THE MCP SIDE OF EVERY PORT ANOTHER AREA OWNS.
 *
 * Two areas need a service that lives in `mcp-platform`, and until this module
 * existed both reached for the concrete class:
 *
 *   tool-gateway  ->  MCPPermissionGatewayService   (the 4-tier dispatch gate)
 *   privacy       ->  PlatosMCPTokenService         (the admin bearer verifier)
 *
 * `mcp-platform` already depends on `tool-gateway` (executor, router, registry)
 * and reaches `privacy` through `agent-runtime -> memory -> privacy`, so both
 * of those imports closed a cycle. Each consumer now DECLARES A PORT it owns —
 * `tool-gateway/tool-permission.port.ts`,
 * `privacy/admin-credential.port.ts` — and this module binds the ports to the
 * MCP services. Every edge between the three areas now runs MCP -> consumer.
 *
 * WHY `@Global()`. The inversion is only real if the consumers can resolve the
 * binding WITHOUT importing anything from `mcp-platform`, and Nest offers
 * exactly one mechanism for a provider visible to a module that does not import
 * its home: a global module. Both composition roots that run a tool gateway —
 * `app.module.ts` and `mcp-platform/stdio-app.module.ts` — reach
 * `McpPlatformModule`, which imports this one, so the bindings are registered in
 * both graphs. `PrivacyModule` is reached only from `app.module.ts`, which also
 * reaches `McpPlatformModule`.
 *
 * ONE INSTANCE EACH, NOT THREE. `ToolGatewayModule` used to register its own
 * copy of `MCPPermissionGatewayService` and `PrivacyModule` its own copy of
 * `PlatosMCPTokenService`, both to dodge a cyclic module graph. Those copies are
 * gone. `McpPlatformModule` keeps providing and exporting both classes for its
 * own controllers, which is a separate registration and always was.
 *
 * WHAT A MISSING BINDING MEANS, SO NOBODY READS THE `@Optional()` AS A HOLE.
 * `ToolExecutorService`'s injection is optional and its gate FAILS CLOSED: with
 * `PLATOS_TOOL_DISPATCH_PERMISSION_GATE=1` and no gateway it denies the
 * dispatch. `ErasureController`'s injection is REQUIRED — an erasure route with
 * no verifier must not boot at all.
 */
@Global()
@Module({
  providers: [
    MCPPermissionGatewayService,
    PlatosMCPTokenService,
    { provide: TOOL_PERMISSION_GATEWAY, useExisting: MCPPermissionGatewayService },
    { provide: ERASURE_ADMIN_CREDENTIALS, useExisting: PlatosMCPTokenService },
  ],
  exports: [
    MCPPermissionGatewayService,
    PlatosMCPTokenService,
    TOOL_PERMISSION_GATEWAY,
    ERASURE_ADMIN_CREDENTIALS,
  ],
})
export class McpPortBindingsModule {}
