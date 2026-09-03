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
