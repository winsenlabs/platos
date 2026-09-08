// The forty-nine JSONB columns behind this package, and what stands at each
// one's decode boundary.
//
// WIN-258 names "typed JSON columns; selectors/projections" and this module is
// the first half of that answer: a CENSUS, not a decoder. Nothing under `src/`
// imports it at runtime. It exists so that "which columns hold JSON, what root
// the database pins, and which function turns each one into a domain value" is
// a fact the tree can be measured against rather than a claim spread across
// seventeen row modules.
//
// *** THE ROOT OF EVERY ONE OF THEM IS PINNED BY A MIGRATION, NOT BY A GUARD.
// `00000000000000_initial` carries forty-nine `<Model>_<column>_json_root`
// CHECKs, one per column, each of the form
// `("c" IS NULL OR) jsonb_typeof("c") = 'object' | 'array'`. That is a stronger
// fact than any decoder in this package: a scalar, or an array in an object
// column, cannot be COMMITTED — not by this adapter, not by another binary, and
// not by a hand-written statement outside either. `json-columns.integration.test.ts`
// reads the CHECKs back out of `pg_constraint` on a live container rather than
// taking the migration's word for it.
//
// SO THE INTERIOR IS WHERE A STORED SHAPE CAN STILL SURPRISE A READER, and the
// `disposition` of each row below is about the interior and only the interior:
//
//   refuse       the decoder names the interior it accepts and aborts the read
//                with its own code when the row does not carry it. Reachable and
//                proved: the integration suite writes the bad interior with
//                `prisma db execute` and then reads it back through the store.
//   carry        the root is checked and the interior is handed on as it stands,
//                by a decision the decoder's OWN comment argues for. Recorded
//                here so that "unchecked" and "checked elsewhere" cannot be
//                mistaken for one another.
//   delegate     the owning context decodes it. This package restates nothing,
//                because a second copy of the shape is the drift.
//   unprojected  no read in this package selects the column, so no decoder can
//                be handed it at all.
//   unowned      no store in this package reads or writes it.
//
// `decoder` names a symbol in THIS package or, for `delegate`, the context
// module that owns it. `json-columns.test.ts` resolves every one of them and
// fails on a name that no longer exists — which is what stops this file from
// ageing into prose.

/** The `jsonb_typeof` value, or values, a column's `_json_root` CHECK admits. */
export type JsonRoot = "object" | "array" | "object|array";

/** What the decode boundary does with the INTERIOR of a column. */
export type JsonDisposition = "refuse" | "carry" | "delegate" | "unprojected" | "unowned";

export interface JsonColumnContract {
  /** The Prisma model, spelled as the schema spells it. */
  readonly model: string;
  readonly column: string;
  /** What the migration's CHECK admits at the root. */
  readonly root: JsonRoot;
  /** Whether that CHECK carries an `IS NULL` arm. */
  readonly nullable: boolean;
  /** The context whose store owns the write, or `-` when no store does. */
  readonly owner: string;
  /** `<module>.<symbol>`, or the empty string for a column no decoder sees. */
  readonly decoder: string;
  readonly disposition: JsonDisposition;
  /** Why this disposition and not a stricter one. One sentence. */
  readonly note: string;
}

/**
 * One row per column, ordered by model then column.
 *
 * ADDING A `Json` COLUMN WITHOUT ADDING A ROW HERE FAILS `json-columns.test.ts`,
 * and so does adding a row for a column the schema does not have. The list is
 * reconciled against `schema.prisma`, against `end-user.prisma`, and against the
 * migrations' CHECK text, so no third of it can drift on its own.
 */
export const JSON_COLUMNS: readonly JsonColumnContract[] = [
  {
    model: "AdminAudit", column: "before", root: "object", nullable: true,
    owner: "observability", decoder: "observability-rows.readAuditSnapshot", disposition: "refuse",
    note: "A snapshot that is not a bag of fields would be indexed into by every reader of AdminAuditRecord.",
  },
  {
    model: "AdminAudit", column: "after", root: "object", nullable: true,
    owner: "observability", decoder: "observability-rows.readAuditSnapshot", disposition: "refuse",
    note: "The same decoder and the same reason as `before`; the column name is a parameter to it.",
  },
  {
    model: "AgentApproval", column: "arguments", root: "object", nullable: true,
    owner: "jobs", decoder: "jobs-rows.readApprovalEnvelope", disposition: "refuse",
    note: "The envelope holds consumedAt beside the caller's own arguments, so a bad envelope loses both.",
  },
  {
    model: "AgentApproval", column: "resolution", root: "object", nullable: true,
    owner: "jobs", decoder: "jobs-rows.readApprovalOutcome", disposition: "carry",
    note: "An outcome without this store's marker was written by the live path and unwraps to the object it holds.",
  },
  {
    model: "AgentCluster", column: "metadata", root: "object", nullable: true,
    owner: "agents", decoder: "agents-rows.readObjectColumn", disposition: "refuse",
    note: "The domain field is a JsonObject; a non-object there is a stored defect and is named rather than blanked.",
  },
  {
    model: "AgentEval", column: "criterionSnapshot", root: "object", nullable: false,
    owner: "governance", decoder: "governance-rows.readCriterionSnapshot", disposition: "refuse",
    note: "The snapshot is what an eval was scored against, so a missing field cannot be supplied after the fact.",
  },
  {
    model: "AgentSkill", column: "config", root: "object", nullable: false,
    owner: "agents", decoder: "agents-rows.readObjectColumn", disposition: "refuse",
    note: "A loadout entry's config is handed to the skill; an empty object put in its place runs it unconfigured.",
  },
  {
    model: "AgentVersion", column: "promptBlocks", root: "array", nullable: false,
    owner: "agents", decoder: "contexts/agents/domain/version-envelope.readVersionRow", disposition: "delegate",
    note: "The six version columns are one arrangement the domain owns; a second copy here is the drift.",
  },
  {
    model: "AgentVersion", column: "dynamicBlocks", root: "array", nullable: false,
    owner: "agents", decoder: "contexts/agents/domain/version-envelope.readVersionRow", disposition: "delegate",
    note: "Read through the same envelope as the other five.",
  },
  {
    model: "AgentVersion", column: "toolsBlockConfig", root: "object", nullable: false,
    owner: "agents", decoder: "contexts/agents/domain/version-envelope.readVersionRow", disposition: "delegate",
    note: "Read through the same envelope as the other five.",
  },
  {
    model: "AgentVersion", column: "modelRoutes", root: "array", nullable: false,
    owner: "agents", decoder: "contexts/agents/domain/version-envelope.readVersionRow", disposition: "delegate",
    note: "Read through the same envelope as the other five.",
  },
  {
    model: "AgentVersion", column: "memoryConfig", root: "object", nullable: false,
    owner: "agents", decoder: "contexts/agents/domain/version-envelope.readVersionRow", disposition: "delegate",
    note: "Holds the reserved __runtime key, which is precisely why the envelope and not this package splits it.",
  },
  {
    model: "AgentVersion", column: "outputSchema", root: "object", nullable: true,
    owner: "agents", decoder: "contexts/agents/domain/version-envelope.readVersionRow", disposition: "delegate",
    note: "Read through the same envelope as the other five.",
  },
  {
    model: "Artifact", column: "metadata", root: "object", nullable: true,
    owner: "files", decoder: "files-rows.readArtifactRow", disposition: "carry",
    note: "Every member of an object root is already a JsonValue, so the root CHECK is the whole of the contract.",
  },
  {
    model: "Budget", column: "alertThresholds", root: "array", nullable: false,
    owner: "cost-monitoring", decoder: "cost-rows.readThresholds", disposition: "refuse",
    note: "A threshold that is not a whole percentage would fire an alert at a fraction nobody chose.",
  },
  {
    model: "ChannelApp", column: "agentRouting", root: "array", nullable: false,
    owner: "channels", decoder: "channels-rows.readRouting", disposition: "carry",
    note: "domain/routing.ts re-checks every rule per message, and losing a customer's message over a stale rule is worse.",
  },
  {
    model: "ChannelConnection", column: "agentRouting", root: "array", nullable: false,
    owner: "channels", decoder: "channels-rows.readRouting", disposition: "carry",
    note: "The same table of rules on a second row, read by the same function.",
  },
  {
    model: "ChannelInstallation", column: "agentRouting", root: "array", nullable: false,
    owner: "channels", decoder: "channels-rows.readRouting", disposition: "carry",
    note: "The same table of rules on a third row, read by the same function.",
  },
  {
    model: "EndUserIdentity", column: "profile", root: "object", nullable: true,
    owner: "-", decoder: "", disposition: "unowned",
    note: "No store here names endUserIdentity; the column belongs to the hosted channel surface M4 carries.",
  },
  {
    model: "EntityMcpClient", column: "headersTemplate", root: "object", nullable: false,
    owner: "tools", decoder: "tools-rows.readStringMap", disposition: "carry",
    note: "A member that is not a string is dropped, because a header template is a map of strings and nothing else.",
  },
  {
    model: "EntityMcpConfig", column: "branding", root: "object", nullable: false,
    owner: "tools", decoder: "tools-rows.readStringMap", disposition: "carry",
    note: "Branding is cosmetic; one unreadable member must not take an entity's whole MCP surface offline.",
  },
  {
    model: "EntityMcpConfig", column: "identityProviders", root: "array", nullable: false,
    owner: "tools", decoder: "tools-rows.readJsonObjects", disposition: "carry",
    note: "A descriptor whose kind this binary does not name is dropped, so a newer writer does not blind an older reader.",
  },
  {
    model: "EnvironmentSkill", column: "config", root: "object", nullable: false,
    owner: "skills", decoder: "skills-rows.readInstallConfig", disposition: "refuse",
    note: "The install config is handed to the skill at run time, so a substituted empty object runs it unconfigured.",
  },
  {
    model: "ErasureOperation", column: "scopes", root: "array", nullable: false,
    owner: "privacy", decoder: "privacy-rows.readTenantScope", disposition: "refuse",
    note: "The discriminant is what resolvePath switches on; a level outside the three addresses the wrong subtree.",
  },
  {
    model: "ErasureOperation", column: "stores", root: "array", nullable: false,
    owner: "privacy", decoder: "privacy-rows.readTargetOutcome", disposition: "refuse",
    note: "An outcome with no target name collapses into whichever other outcome shares its absent one.",
  },
  {
    model: "ErasureOperation", column: "inventory", root: "object", nullable: true,
    owner: "privacy", decoder: "", disposition: "unprojected",
    note: "OPERATION_COLUMNS does not select it, so no read in this package can be handed the column at all.",
  },
  {
    model: "ErasureOperation", column: "resumePlan", root: "object", nullable: true,
    owner: "privacy", decoder: "", disposition: "unprojected",
    note: "OPERATION_COLUMNS does not select it either; the resume plan is M4's surface rather than this port's.",
  },
  {
    model: "Event", column: "payload", root: "object", nullable: false,
    owner: "kernel-outbox", decoder: "outbox-store.readOutboxPayload", disposition: "refuse",
    note: "A drain handed a non-object would fail on that row for as long as the row exists; the store names it instead.",
  },
  {
    model: "Job", column: "payloadSchema", root: "object", nullable: true,
    owner: "jobs", decoder: "jobs-rows.readPayloadSchema", disposition: "refuse",
    note: "A schema that is not an object is validated against by nothing and would silently admit every payload.",
  },
  {
    model: "Macro", column: "steps", root: "array", nullable: false,
    owner: "agents", decoder: "agents-rows.toMacroSteps", disposition: "refuse",
    note: "A step with no tool replays as a silent no-op and a step whose params are not an object replays with none.",
  },
  {
    model: "Macro", column: "paramSchema", root: "object", nullable: true,
    owner: "agents", decoder: "agents-rows.readObjectColumn", disposition: "refuse",
    note: "The same decoder as the other agents object columns, and the same refusal in place of a blank.",
  },
  {
    model: "Memory", column: "metadata", root: "object", nullable: true,
    owner: "memory", decoder: "memory-rows.readMemoryMetadata", disposition: "refuse",
    note: "MemoryMetadata is indexed by every reader; a non-object there is a stored defect with a name.",
  },
  {
    model: "MemoryEntity", column: "metadata", root: "object", nullable: true,
    owner: "memory", decoder: "memory-rows.readMemoryMetadata", disposition: "refuse",
    note: "The same decoder on the graph's node rows.",
  },
  {
    model: "MemoryRelationship", column: "metadata", root: "object", nullable: true,
    owner: "memory", decoder: "memory-rows.readMemoryMetadata", disposition: "refuse",
    note: "The same decoder on the graph's edge rows.",
  },
  {
    model: "NotificationRule", column: "filters", root: "object", nullable: false,
    owner: "eventing", decoder: "eventing-rows.readNotificationRule", disposition: "refuse",
    note: "parseRuleFilter is the domain's own parser, and a filter it rejects would match everything or nothing.",
  },
  {
    model: "NotificationRule", column: "delivery", root: "object", nullable: false,
    owner: "eventing", decoder: "eventing-rows.readNotificationRule", disposition: "refuse",
    note: "parseDestination likewise; a destination that does not parse would deliver to an address nobody chose.",
  },
  {
    model: "ObservabilityOutbox", column: "payload", root: "object", nullable: false,
    owner: "-", decoder: "", disposition: "unowned",
    note: "Written by the turn-shaped projection in apps/agent, one of the nineteen legacy transports T6 carries.",
  },
  {
    model: "PostmanTemplate", column: "sessionContext", root: "object", nullable: true,
    owner: "agents", decoder: "agents-rows.readObjectColumn", disposition: "refuse",
    note: "A template's session context is replayed into a turn, so a blank put in its place changes the run.",
  },
  {
    model: "SafetyEvent", column: "metadata", root: "object", nullable: true,
    owner: "governance", decoder: "governance-rows.readSafetyEnvelope", disposition: "refuse",
    note: "The envelope holds the detector's own fields beside the caller's, so a bad root loses the event's evidence.",
  },
  {
    model: "Skill", column: "manifest", root: "object", nullable: false,
    owner: "skills", decoder: "skills-rows.readManifest", disposition: "refuse",
    note: "Field by field, with unknown keys preserved, because a manifest is what a skill IS.",
  },
  {
    model: "Skill", column: "providesTools", root: "array", nullable: false,
    owner: "skills", decoder: "skills-rows.readProvidedTools", disposition: "refuse",
    note: "A descriptor the catalogue cannot read would expose a tool with no name.",
  },
  {
    model: "Thread", column: "sessionContext", root: "object", nullable: true,
    owner: "conversations", decoder: "conversations-rows.readObjectRoot", disposition: "refuse",
    note: "An array in an object column is refused rather than frozen as {0: …} for every reader to index.",
  },
  {
    model: "Tool", column: "paramSchema", root: "object", nullable: false,
    owner: "tools", decoder: "tools-rows.readJsonObject", disposition: "carry",
    note: "The root CHECK is the contract; the interior is JSON Schema, which this package does not interpret.",
  },
  {
    model: "ToolCall", column: "arguments", root: "object", nullable: false,
    owner: "tools", decoder: "tools-rows.readJsonObject", disposition: "carry",
    note: "The arguments are the caller's own bag, replayed rather than interpreted, so the root is the whole contract.",
  },
  {
    model: "ToolCall", column: "result", root: "object|array", nullable: true,
    owner: "tools", decoder: "tools-audit-rows.readResult", disposition: "carry",
    note: "One of the two columns whose CHECK admits TWO roots — the scalar wrapper is why — so an array reads as an array.",
  },
  {
    model: "ToolCallAudit", column: "arguments", root: "object", nullable: false,
    owner: "tools", decoder: "tools-audit-rows.readAuditArguments", disposition: "carry",
    note: "The audit envelope splits its own keys off the caller's and carries the rest verbatim.",
  },
  {
    model: "ToolCallAudit", column: "result", root: "object|array", nullable: true,
    owner: "tools", decoder: "tools-audit-rows.readResult", disposition: "carry",
    note: "The second column whose CHECK admits two roots, read by the same unwrapper as ToolCall.result.",
  },
  {
    model: "Turn", column: "input", root: "object", nullable: true,
    owner: "conversations", decoder: "conversations-rows.readObjectRoot", disposition: "refuse",
    note: "A turn's input is indexed by the transcript, and an array root would be read as though it held fields.",
  },
  {
    model: "Turn", column: "output", root: "object", nullable: true,
    owner: "conversations", decoder: "conversations-rows.readObjectRoot", disposition: "refuse",
    note: "The same decoder on the other half of the turn.",
  },
];

/** `Model.column` — the key all three reconciliations join on. */
export function jsonColumnKey(contract: JsonColumnContract): string {
  return `${contract.model}.${contract.column}`;
}
