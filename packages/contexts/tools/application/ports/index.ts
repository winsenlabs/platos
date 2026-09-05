// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ToolDispatch` is published from here rather than from the kernel: it is
// adapter-facing, not context-facing (ADR M0.3 §13), and it is the boundary
// that makes §5.1 rule (h) — `@modelcontextprotocol/*` in exactly one directory
// — enforceable rather than aspirational. `ToolsRepository` is the
// canonical-store port behind which this context's sole-writer ownership of its
// ten rows is realised. `ContentDigest` is the one primitive two domain rules
// end in and neither may take.
//
// Implemented under `packages/adapters/*` and this context's own `adapters/`,
// wired in `apps/core-api`, never imported by `domain/` (ADR M0.3 §2).
export * from "./tools-repository.js";
export * from "./tool-dispatch.js";
export * from "./content-digest.js";

// --- what an implementation of the port above needs in order to build a record
//
// WIN-258 T5. `packages/adapters/postgres-tenancy` implements
// `ToolsRepository`, and `cross-context-contracts-only` (ADR M0.3 §5.1 rule (c))
// stops it reaching into `../../domain/`. Every parameter and every return of
// the twenty-four methods above is spelled in domain vocabulary, so without the
// block below the one package entitled to implement the port cannot name a
// single thing the port says. The precedent is the identical block in
// `@platos/context-tenancy` and `@platos/context-identity-access`, added for the
// same reason and for the same adapter. Nothing new is published: every name
// below is already public from `../../domain/index.js`.
//
// `asToolsIdentifier` and `repositoryUnavailable` are VALUES rather than types
// and are exported as such deliberately. An adapter reading a row holds bare
// strings out of the driver and has to brand them — that is what
// `asToolsIdentifier` is for, and its own comment names adapters as the caller
// it exists for. `repositoryUnavailable` is the refusal the in-memory double
// already raises when a scope does not describe the tree, so an adapter that
// minted a code of its own would make the two stores' transcripts disagree
// about a refusal they agree about.
export type {
  ActorId,
  AgentId,
  AgentPolicyBinding,
  AgentToolDefaultPolicy,
  AgentToolPolicy,
  AgentToolPolicyId,
  AgentVersionId,
  AuditEntry,
  AuditEnvelope,
  AuditQuery,
  CallStatus,
  ConnectionKind,
  CredentialId,
  CredentialName,
  DispatchSource,
  EndUserId,
  EntityMcpClient,
  EntityMcpConfig,
  EntityToolPolicy,
  EntityToolPolicyId,
  ExposureId,
  ExternalEntityId,
  HealthOutcome,
  IdentityMode,
  McpIdentityProvider,
  McpTransport,
  OrganizationMcpPolicyId,
  PolicyEffect,
  SchemaHash,
  StepId,
  ThreadId,
  Tool,
  ToolCall,
  ToolCallAuditId,
  ToolCallId,
  ToolExposure,
  ToolHealth,
  ToolHealthId,
  ToolId,
  ToolKind,
  ToolName,
} from "../../domain/index.js";
export {
  AGENT_TOOL_DEFAULT_POLICIES,
  allowedAgentIds,
  asToolsIdentifier,
  auditWindowStart,
  byExposureOrder,
  CALL_STATUSES,
  CONNECTION_KINDS,
  decodeLabels,
  dispatchabilityOf,
  DISPATCH_SOURCES,
  EMPTY_AUDIT_ENVELOPE,
  encodeLabels,
  entityNotInScope,
  exposureNotFound,
  HEALTH_OUTCOMES,
  IDENTITY_MODES,
  MCP_TRANSPORTS,
  normalizeHeaderTemplate,
  POLICY_EFFECTS,
  repositoryUnavailable,
  TOOL_KINDS,
} from "../../domain/index.js";

// The kernel names the port's own signatures are written in. Re-exported for
// exactly the reason above and no other: an adapter that added
// `@platos/kernel` to its manifest to reach `ok` would add a WORKSPACE EDGE
// that `scripts/arch/v1-project-graph.mjs` counts, for four names this package
// already publishes on every method it declares.
export type { Branded, EntityId, EnvironmentId, EnvironmentScope, Result } from "@platos/kernel";
export { err, ok, resolvePath } from "@platos/kernel";
