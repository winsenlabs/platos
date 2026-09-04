// Identifiers owned by the `tools` context (ADR M0.3 §1, context 7).
//
// The kernel brands the tenancy tree; these brand the ten rows this context is
// SOLE WRITER of, plus the handful of opaque strings that are not primary keys
// and are the easiest to substitute for one another.
//
// THE SUBSTITUTION THIS FILE EXISTS TO STOP IS REAL AND IT IS IN THE SOURCE.
// `McpToolAclService.list` returns rows whose `toolId` field carries an
// `EnvironmentEntityTool.id`, not a `Tool.id`, and leaves a comment explaining
// that the controller resolves it back before mutating. Two uuids, one field
// name, one prose note standing between them and a policy written against the
// wrong row. Here they are `ToolId` and `ExposureId`, and the compiler holds
// the line the comment was holding.
//
// `EntityId`, `EnvironmentId` and `ProjectId` come from the kernel: they are
// tenancy's, and this context references them constantly and writes none of
// them. `CredentialId` is branded here with the SAME tag `secrets` uses, so an
// id that crossed the contract boundary from `secrets` reaches a repository
// method here without a cast — and a `ToolId` still cannot.

import type { Branded } from "@platos/kernel";

/** `Tool.id` — uuid. The immutable content-addressed schema version. */
export type ToolId = Branded<string, "ToolId">;

/** `EnvironmentEntityTool.id` — uuid. The mutable exposure of a Tool. */
export type ExposureId = Branded<string, "ExposureId">;

/** `ToolHealth.id` — uuid. */
export type ToolHealthId = Branded<string, "ToolHealthId">;

/** `ToolCall.id` — uuid. */
export type ToolCallId = Branded<string, "ToolCallId">;

/** `ToolCallAudit.id` — uuid. */
export type ToolCallAuditId = Branded<string, "ToolCallAuditId">;

/** `AgentToolPolicy.id` — uuid. */
export type AgentToolPolicyId = Branded<string, "AgentToolPolicyId">;

/** `EntityToolPolicy.id` — uuid. */
export type EntityToolPolicyId = Branded<string, "EntityToolPolicyId">;

/** `OrganizationMcpPolicy.id` — uuid. */
export type OrganizationMcpPolicyId = Branded<string, "OrganizationMcpPolicyId">;

/**
 * `Tool.name` — the dotted name a model writes to call something.
 *
 * It is NOT unique on its own. `@@unique([name, schemaHash])` means one name
 * spans every schema version ever registered under it, and several entities in
 * one environment may expose the same name at once. That is why routing
 * (`domain/routing.ts`) has a disambiguation strategy rather than a lookup.
 */
export type ToolName = Branded<string, "ToolName">;

/** `Tool.schemaHash` — the truncated digest of the canonical tool document. */
export type SchemaHash = Branded<string, "SchemaHash">;

/**
 * `Entity.externalId` — the caller's own name for an entity, unique within its
 * project. The source calls this `sourceEntityId` in the registry and
 * `entityExternalId` on `ToolHealth`; both are this.
 */
export type ExternalEntityId = Branded<string, "ExternalEntityId">;

/** `Agent.id`. Referenced by `AgentToolPolicy` and never written here. */
export type AgentId = Branded<string, "AgentId">;

/** `AgentVersion.id` — what an `AgentToolPolicy` actually hangs off. */
export type AgentVersionId = Branded<string, "AgentVersionId">;

/** `Step.id` — a `ToolCall`'s parent. Written by `conversations`, never here. */
export type StepId = Branded<string, "StepId">;

/** `Thread.id`. A nullable back-reference on an audit row. */
export type ThreadId = Branded<string, "ThreadId">;

/** `EndUser.id`. Nullable on an audit row; the identity `mcp-dispatch` carries. */
export type EndUserId = Branded<string, "EndUserId">;

/**
 * `Credential.id`. Referenced by `EntityMcpClient.credentialId` and NEVER
 * written: ADR M0.3 §1 row 3 makes `secrets` its sole writer, and this context
 * resolves material through that context's contract.
 */
export type CredentialId = Branded<string, "CredentialId">;

/**
 * A credential's bare reference name in an environment's own namespace
 * (`COMPOSIO_API_KEY`). Never secret material, never a process variable.
 */
export type CredentialName = Branded<string, "CredentialName">;

/**
 * Whoever acted. `EntityToolPolicy.addedBy` is a plain `String` column
 * recording authorship, and while ADR M0.3 §1 row 7 does permit this context
 * to import identity-access, adopting identity's model of a principal for a
 * free-text authorship column would overstate what the column holds — the
 * source writes the literal `"system"` into it from two call sites.
 */
export type ActorId = Branded<string, "ActorId">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asToolsIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
