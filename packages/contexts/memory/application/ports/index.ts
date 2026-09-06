// Driven ports this context needs, implemented by `packages/adapters/*` and
// wired in `apps/core-api`. Never imported by `domain/` (ADR M0.3 §2).
//
// Five ports, and each is here for a different reason:
//
//   MemoryRepository            the canonical `Memory` store. Sole-writer
//   KnowledgeGraphRepository    ownership (§1 row 8) is expressed as these two
//                               interfaces having no generic escape hatch.
//   Cache                       ASSIGNED to this context by §13, by name.
//   EmbeddingModel              the two model seams. Neither names a vendor;
//   ExtractionJudge             both are composed over `providers` at the root.
//   ContentDigest               the one pure host capability dedupe needs.
//
// This entrypoint is published from `package.json` as
// `./application/ports/index.js` so an adapter can import the interface it
// implements without reaching for `contracts/`, which is the CONTEXT-facing
// surface and carries none of these (ADR M0.3 §13).
export * from "./memory-repository.js";
export * from "./knowledge-graph-repository.js";
export * from "./cache.js";
export * from "./embedding-model.js";
export * from "./content-digest.js";

// WIN-258 T5 — the domain values the two canonical-store ports' SIGNATURES
// already name.
//
// WITHOUT THIS BLOCK BOTH CANONICAL-STORE PORTS ARE UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `memory-repository.ts` and `knowledge-graph-repository.ts` above
// import `Memory`, `MemoryEntity`, `MemoryRelationship`, `MemorySubject`,
// `MemoryOwnership` and eighteen more from `../../domain/index.js` as TYPES and
// re-export none of them, and `contracts/index.ts` publishes the read VIEWS
// rather than the aggregates. So every method of both ports was declared in
// terms of names an adapter package — the only kind of package ADR M0.3 §2
// permits to implement a driven port — had no way to spell. The same omission
// was found four times already on this issue, on `EndUserStore`, on
// `SessionRevocationOrder`, on `BudgetRepository` and on `ChannelsRepository`;
// this is the fifth, and it is repaired the same way: the port entry point
// publishes exactly what the ports' own signatures use, plus the values an
// implementation must not re-derive, and nothing more.
//
// THE FUNCTIONS ARE HERE FOR A STRONGER REASON THAN THE TYPES.
// `normalizeProfileKey` is the STORED spelling of `Memory.profileKey`,
// `agentVisibleFor` is the derived `agentVisible` column, and `matchesArchiveState`
// is the `archivedAt IS NULL` predicate. A store that wrote its own copy of any
// of them would be a second definition of a rule the domain already owns, and
// the two would drift silently. `repositoryUnavailable` is published because a
// store must report an outage with the SAME error the in-memory double reports,
// or the shared conformance transcript compares two vocabularies and calls the
// difference a divergence. The four vocabulary predicates are published because
// a stored `kind`, `source` or `visibility` this binary has not heard of is an
// expand/contract event a store must REFUSE to read rather than cast past.
//
// The kernel values these signatures name are republished for the same reason
// `identity-access`'s, `cost-monitoring`'s and `channels`' port entry points
// republish their own: `Result` and `TransactionScope` are in every method and
// `EnvironmentScope` in most, and an adapter that reached for `@platos/kernel`
// directly would be a second import edge into the kernel from a package whose
// only declared dependency is the context whose port it satisfies.
export type { EnvironmentScope, JsonValue, Result, TransactionScope } from "@platos/kernel";
export { asIdentifier, environmentScope, err, ok } from "@platos/kernel";

export type {
  AgentBinding,
  AgentId,
  ClusterId,
  ContentHash,
  EndUserId,
  EntityKey,
  Memory,
  MemoryArchiveState,
  MemoryConfidence,
  MemoryEntity,
  MemoryEntityId,
  MemoryId,
  MemoryKind,
  MemoryLifecycle,
  MemoryMetadata,
  MemoryOwnership,
  MemoryProvenance,
  MemoryRelationship,
  MemoryRelationshipId,
  MemorySource,
  MemorySubject,
  MemoryVisibility,
  ProfileKey,
  ReconciledConfidence,
  RelationshipIdentity,
  ThreadId,
  TurnId,
} from "../../domain/index.js";
export {
  agentVisibleFor,
  asMemoryIdentifier,
  isMemoryKind,
  isMemorySource,
  isMemoryVisibility,
  MAX_CONTENT_LENGTH,
  MAX_ENTITY_KEY_LENGTH,
  matchesArchiveState,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_VISIBILITIES,
  memorySubject,
  normalizeProfileKey,
  RAG_SOURCE,
  repositoryUnavailable,
} from "../../domain/index.js";
