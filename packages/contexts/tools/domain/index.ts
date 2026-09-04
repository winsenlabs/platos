// The `tools` domain (ADR M0.3 §1, context 7).
//
// This context is the MERGE of `tool-gateway` and `mcp-platform`. §1 row 7
// collapses them because they were sole co-writers of the same rows — `Tool`,
// `ToolHealth`, `EntityMcp*` — and §3 records the five imports between them
// becoming intra-context as a result. It is the sole holder of
// `@modelcontextprotocol/*`, behind adapters; nothing under `domain/` or
// `application/` names an SDK.
//
// TEN ROWS, AND THEY GROUP INTO FOUR THINGS.
//
//   WHAT A TOOL IS       Tool, EnvironmentEntityTool. An immutable,
//                        content-addressed schema version, and the mutable
//                        matrix of who exposes it where.
//   WHO MAY CALL IT      AgentToolPolicy (Platos calling OUT),
//                        EntityToolPolicy and OrganizationMcpPolicy (a third
//                        party calling IN). Two directions, two policies, and
//                        the four-tier lattice composes them.
//   WHAT HAPPENED        ToolCall, ToolCallAudit, ToolHealth. The transcript
//                        entry, the durable environment-scoped record, and the
//                        rolling counters.
//   HOW IT IS REACHED    EntityMcpConfig (Platos hosting a server),
//                        EntityMcpClient (Platos being a client of one).
//
// THE INTERNAL DIRECTION IS ONE-WAY AND IT IS §3's CLOSING CONDITION FOR THE
// MERGE: mcp-dispatch depends on tool-registry, never the reverse. In this
// layer that means `mcp-client.ts` and `mcp-config.ts` may reach the registry
// vocabulary — `tool.ts`, `exposure.ts`, `identifiers.ts` — and nothing in the
// registry names an MCP concept. The one crossing in the other direction that
// the source has, `EnvironmentEntityTool` carrying `injectMcpContext`, is a
// BOOLEAN on the exposure rather than a reference to the config row, so the
// dependency does not exist even though the value does.
//
// `McpToken` AND `McpBearerToken` ARE NOT HERE. §3 relocates their writes to
// identity-access. This context consumes an already-authenticated principal and
// mints no identity of its own.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./tool.js";
export * from "./declaration.js";
export * from "./exposure.js";
export * from "./discovery.js";
export * from "./routing.js";
export * from "./agent-policy.js";
export * from "./permission.js";
export * from "./platform-baseline.js";
export * from "./entity-policy.js";
export * from "./call.js";
export * from "./health.js";
export * from "./audit.js";
export * from "./mcp-config.js";
export * from "./mcp-client.js";
