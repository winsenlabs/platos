// The `memory` domain (ADR M0.3 §1, context 8).
//
// Three aggregates and one boundary.
//
//   Memory              one durable thing known about one subject, by one agent
//                       or by one agent cluster. Content, provenance, confidence
//                       and three independent lifecycle instants.
//   MemoryEntity        a node in that subject's knowledge graph, identified by
//                       a deterministic SLUG rather than by its row id, so the
//                       same person resolves to the same node months apart.
//   MemoryRelationship  a typed, directed edge between two nodes, unique on
//                       `(from, to, type)`.
//
// The boundary is the CONVERSATION. ADR M0.3 §1 row 8 states it in the row
// itself: extraction is initiated on a `TurnFinalized` event and this context
// "never imports conversations". Everything it knows about a conversation
// arrives as a transcript and a list of ids — `ThreadId` and `TurnId` are
// branded here, in this context's own vocabulary, precisely so the ids can cross
// without the model behind them following.
//
// The second boundary is the AGENT. Every row is owned by one agent, or by the
// cluster that agent belongs to, and `canShareAgentScope` is the single
// predicate every read and every write in this package reduces to.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./authorization.js";
export * from "./taxonomy.js";
export * from "./scope.js";
export * from "./content.js";
export * from "./confidence.js";
export * from "./memory.js";
export * from "./recall.js";
export * from "./fusion.js";
export * from "./entity.js";
export * from "./relationship.js";
export * from "./traversal.js";
export * from "./extraction.js";
export * from "./profile.js";
export * from "./working-set.js";
export * from "./policy.js";
