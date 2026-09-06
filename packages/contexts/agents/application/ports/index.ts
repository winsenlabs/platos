// Driven ports this context needs, and the two adapter-facing ports it OWNS.
//
// `AgentsRepository` and `ScaffoldingRepository` are the canonical-store ports
// behind which this context's sole-writer ownership of `Agent`, `AgentCluster`,
// `AgentVersion`, `AgentBinding`, `AgentSkill`, `Macro` and `PostmanTemplate` is
// realised. `AgentVersionLock` and `MacroRecorder` are context-owned seams over
// state that is neither domain nor canonical store: ADR M0.3 §13 assigns an
// adapter-facing port to the context whose capability it serves, and both of
// these serve rules stated in this package's `domain/`.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./agents-repository.js";
export * from "./scaffolding-repository.js";
export * from "./version-lock.js";
export * from "./macro-recorder.js";

// --- what an implementation of the two store ports needs in order to build a
// --- record (WIN-258 T5)
//
// WHY THIS FILE ALSO RE-EXPORTS DOMAIN AND KERNEL NAMES. An adapter has to BUILD
// the records the ports above hand back, and its only workspace edge is to this
// package: ADR M0.3 §13 gives an adapter one project reference per port owner.
// Until this block existed, `AgentsRepository` was declared here and its
// PARAMETERS were not — `Agent`, `AgentBinding`, `AgentVersion`, `AgentCluster`,
// `AgentSkill`, `Macro` and `PostmanTemplate` were all unnameable by the only
// kind of package entitled to implement the port that takes them. An adapter
// could have reached into `../../domain/`, which the boundary rules exist to
// stop, or taken a second dependency on the kernel, which would change the V1
// project graph. `tenancy` and `providers` publish the same block for the same
// reason. Nothing new is published: every name below is already public from
// `../../domain/index.js` or from `@platos/kernel`.
//
// THE ENVELOPE FUNCTIONS ARE IN THE LIST, AND THEY ARE THE POINT. A store writes
// an `AgentVersion` as the packed ROW — nine columns and a `__runtime` envelope
// inside `memoryConfig` — and reads it back through the inverse. Those two
// functions are `domain/version-envelope.ts`, they are already exercised by the
// in-memory double, and an adapter that re-derived the packing would be a second
// definition of where every carried field lives.

export { err, ok, runResult } from "@platos/kernel";
// WIN-260 (M2.5): `runResult` joins them, and `NotResult` beside it.
// `UnitOfWork.run` REFUSES a callback whose answer is a `Result` — such a
// callback RESOLVES, and a resolved callback COMMITS, which is the defect
// `cost-monitoring` shipped — so `runResult` is the only way to end a unit of
// work with a failure, and every canonical store's suite needs it. It is
// republished HERE rather than imported from `@platos/kernel` in the adapter,
// for the reason stated above: that would be the second import edge into the
// kernel this paragraph exists to refuse.
export type { Branded, DomainError, EnvironmentId, EnvironmentScope, JsonValue, NotResult, OrganizationId, ProjectId, Result, TransactionId, TransactionScope, UnitOfWork } from "@platos/kernel";

export {
  asAgentsIdentifier,
  buildSnapshot,
  byClusterOrder,
  byListingOrder,
  byMacroOrder,
  byTemplateOrder,
  byVersionOrder,
  DEFAULT_AGENTS_POLICY,
  packVersionRow,
  readVersionRow,
  RUNTIME_ENVELOPE_KEY,
} from "../../domain/index.js";
export { macroAccessFor } from "../../domain/index.js";
export {
  agentAlreadyExists,
  clusterAlreadyExists,
  repositoryUnavailable,
  versionInvalid,
} from "../../domain/index.js";
export type {
  ActorId,
  Agent,
  AgentBinding,
  AgentBindingId,
  AgentCluster,
  AgentClusterId,
  AgentDefaultsPolicy,
  AgentId,
  AgentSkill,
  AgentSkillId,
  AgentVersion,
  AgentVersionId,
  AgentVersionRow,
  AgentVersionRowData,
  AgentVersionSnapshot,
  EnvironmentSkillId,
  JsonObject,
  Macro,
  MacroId,
  MacroStep,
  PostmanTemplate,
  PostmanTemplateId,
  SkillAssignment,
  Slug,
  ToolDefaultPolicy,
} from "../../domain/index.js";
