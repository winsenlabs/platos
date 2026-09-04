// The `tools` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable
// in memory against the in-memory doubles in `application/testing/`, and every
// one of them returns the kernel's `Result` rather than throwing.
//
// The 1,644-line `ToolExecutorService`, the 845-line `ToolRegistryService` and
// the 587-line `MCPPermissionGatewayService` are the three files this layer
// replaces. Nothing here exceeds the ADR M0.3 §6 budget, and the seam each
// split fell along is named in the file it moved to rather than in a commit
// message.
//
// May import this context's `domain/`, its own `application/ports/`, and the
// published `contracts/` of the peer contexts ADR M0.3 §1 row 7 permits — which
// for `tools` are `tenancy`, `identity-access`, `secrets` and `providers`.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./authorization.js";
export * from "./register-tools.js";
export * from "./read-tools.js";
export * from "./resolve-permission.js";
export * from "./resolve-transport.js";
export * from "./execute-tool.js";
export * from "./entity-tool-policy.js";
export * from "./organization-policy.js";
export * from "./discover-entity-tools.js";
export * from "./mcp-surface.js";
export * from "./views.js";
