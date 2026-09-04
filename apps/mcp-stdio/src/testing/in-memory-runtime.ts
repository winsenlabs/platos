// A host runtime module, for evidence.
//
// `PLATOS_MCP_STDIO_RUNTIME_MODULE` names a module the HOST INSTALL supplies, and
// a specifier resolved at run time is invisible to every static boundary checker
// in this repository. That is exactly why the executable evidence points at a
// module that lives IN the repository: the seam is exercised end to end by the
// real binary, and the thing on the far side of it is still source that
// `arch-boundaries` and `v1-project-graph` police like anything else.
//
// It imports `@platos/context-tools` and nothing else — the single project
// `apps/mcp-stdio` is permitted to depend on — so this file cannot become a
// back door around rule (j) even by accident.
//
// EVERY BUSINESS METHOD REFUSES, AND THAT IS THE HONEST IMPLEMENTATION.
// WIN-256 made `tools` real, so this double now has 17 contract methods to
// satisfy instead of the one placeholder it used to. It satisfies them by
// refusing: this module holds no repository, no dispatch port and no peer
// context, so any answer other than "unavailable" would be a fabricated one.
// The frame loop under test reads `name` and never calls a business method, and
// a future frame that did would fail loudly here rather than silently succeed
// against a double that said yes.
//
// The refusal is built as a literal rather than imported from `@platos/kernel`:
// this project's generated references name `packages/contexts/tools` alone, and
// `DomainError` is structural, so the literal satisfies the type without adding
// an edge `v1-project-graph` would have to be widened to permit.

import type { ToolsContract } from "@platos/context-tools";

const UNAVAILABLE = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "TOOLS_RUNTIME_UNAVAILABLE",
    category: "unavailable",
    message: "this evidence runtime holds no tools implementation",
    fields: Object.freeze([]),
    retryAfterSeconds: null,
    details: Object.freeze({}),
  }),
} as const);

const refuse = async (): Promise<never> => await Promise.resolve(UNAVAILABLE as never);

export function createToolsRuntime(): ToolsContract {
  return {
    name: "tools",
    registerTools: refuse,
    listTools: refuse,
    pageTools: refuse,
    setToolEnabled: refuse,
    findTools: refuse,
    discoverEntityTools: refuse,
    resolvePermission: refuse,
    executeTool: refuse,
    describeMcpSurface: refuse,
    configureMcpSurface: refuse,
    listEntityToolPolicies: refuse,
    setEntityToolPolicy: refuse,
    listCallableForMcpCaller: refuse,
    listOrganizationPolicies: refuse,
    setOrganizationPolicy: refuse,
    deleteOrganizationPolicy: refuse,
    readToolAudit: refuse,
  };
}
