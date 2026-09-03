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
