// The `agents` domain (ADR M0.3 §1, context 5).
//
// Seven rows, three scoping regimes, and one invariant that runs through all of
// them.
//
//   Agent            a PROJECT-scoped definition: a name, a slug, and whether it
//                    is active. Nothing an operator edits day to day.
//   AgentVersion     an IMMUTABLE configuration numbered per agent. Every
//                    editable field lives here, most of them inside one JSON
//                    column's reserved `__runtime` envelope.
//   AgentBinding     the ENVIRONMENT-scoped row that says which version this
//                    environment serves, which one is in canary, at what
//                    percentage, and which cluster the agent sits in.
//   AgentCluster     an environment-scoped grouping whose membership IS the
//                    binding, and whose primary agent lives in free-form JSON.
//   AgentSkill       a version's skill loadout (§7 decision 5: loadout is
//                    authoring, so it lands here rather than in `skills`).
//   Macro            a recorded, replayable sequence of tool calls.
//   PostmanTemplate  a saved request against one agent.
//
// THE INVARIANT: a version is never edited. Every change writes a new version
// and moves the binding, which is what makes a canary possible, what makes
// version history an audit trail, and what makes `loadout.carryForward` load
// bearing rather than housekeeping — a save that forgets it strips a live
// agent's skills.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./slug.js";
export * from "./agent.js";
export * from "./blocks.js";
export * from "./tools-config.js";
export * from "./model-route.js";
export * from "./snapshot.js";
export * from "./version-envelope.js";
export * from "./version.js";
export * from "./binding.js";
export * from "./cluster.js";
export * from "./loadout.js";
export * from "./macro.js";
export * from "./postman-template.js";
