// Identifiers owned by the `agents` context (ADR M0.3 §1, context 5).
//
// The kernel brands the tenancy tree; these brand the seven rows this context is
// SOLE WRITER of — Agent, AgentCluster, AgentVersion, AgentBinding, AgentSkill,
// Macro, PostmanTemplate — plus the four opaque strings that are not this
// context's primary keys and are the easiest to substitute for one another: a
// slug, a route label, a foreign environment-skill id and a foreign provider-key
// id.
//
// TWO FOREIGN IDS ARE BRANDED HERE RATHER THAN IMPORTED. A context's `domain/`
// may import only its own domain and `@platos/kernel` (ADR M0.3 §2), so it
// cannot name another context's type. Each brand below is deliberately spelled
// with the SAME tag its owner uses, so the two are one type: an id that crossed
// the contract boundary from `providers` reaches a repository method here
// without a cast, and an `AgentVersionId` still cannot.
//
//   ProviderKeyId       `providers` owns it (ADR M0.3 §1 row 4). An agent
//                       version PINS one; it never writes one.
//   EnvironmentSkillId  `skills` owns it (row 6). An `AgentSkill` row names one;
//                       this context writes the loadout, never the skill.

import type { Branded } from "@platos/kernel";

/** `Agent.id` — uuid. Hangs off Project, not Environment. */
export type AgentId = Branded<string, "AgentId">;

/** `AgentCluster.id` — uuid. Environment-scoped. */
export type AgentClusterId = Branded<string, "AgentClusterId">;

/** `AgentVersion.id` — uuid. Immutable once written. */
export type AgentVersionId = Branded<string, "AgentVersionId">;

/** `AgentBinding.id` — uuid. One per `[environment, agent]`. */
export type AgentBindingId = Branded<string, "AgentBindingId">;

/** `AgentSkill.id` — uuid. One per `[agentVersion, environmentSkill]`. */
export type AgentSkillId = Branded<string, "AgentSkillId">;

/** `Macro.id` — uuid. Environment-scoped, owner-gated. */
export type MacroId = Branded<string, "MacroId">;

/** `PostmanTemplate.id` — uuid. Environment- and agent-scoped. */
export type PostmanTemplateId = Branded<string, "PostmanTemplateId">;

/**
 * `ProviderKey.id`. Referenced constantly here and NEVER written: ADR M0.3 §1
 * row 4 makes `providers` its sole writer. A version pins one on its runtime
 * configuration or on a single model route, and this context's only interest in
 * it is which key a route names — see `domain/model-route.ts`.
 */
export type ProviderKeyId = Branded<string, "ProviderKeyId">;

/**
 * `EnvironmentSkill.id`. Written by `skills` (ADR M0.3 §1 row 6); named by
 * `AgentSkill`, which §7 decision 5 places here because a loadout is authoring.
 */
export type EnvironmentSkillId = Branded<string, "EnvironmentSkillId">;

/**
 * `Agent.slug` and `AgentCluster.slug` — the human-readable name inside a
 * uniqueness constraint. Two different constraints, one type: an agent's slug is
 * unique per PROJECT and a cluster's per ENVIRONMENT, and the scope is a
 * parameter everywhere it matters, never inferred from the string.
 */
export type Slug = Branded<string, "Slug">;

/**
 * An operator-defined model-route label — `alpha`, `fast`, `compaction`. It is
 * not a row id and it is not a model name; it is the key a caller selects a
 * route by, and branding it is what stops a model string reaching a parameter
 * that means a label.
 */
export type RouteLabel = Branded<string, "RouteLabel">;

/**
 * Whoever acted. Deliberately not the kernel `PrincipalId`, for the reason
 * `providers` gives: `AgentVersion.createdBy`, `Macro.createdBy` and
 * `PostmanTemplate.createdBy` are plain `String` columns recording authorship,
 * and `agents` may not import identity-access (ADR M0.3 §1 row 5 allows
 * `tenancy`, `providers`, `skills`, `kernel`), so it names the actor without
 * adopting identity's model of one.
 */
export type ActorId = Branded<string, "ActorId">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asAgentsIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
