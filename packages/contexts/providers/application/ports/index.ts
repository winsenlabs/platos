// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ModelRouter` is published from here rather than from the kernel: ADR M0.3 §13
// assigns it to `providers`, and `packages/adapters/model-router-providers` has
// exactly one import edge, to this entrypoint. `ProvidersRepository` is the
// canonical-store port behind which this context's sole-writer ownership of
// `ProviderKey`, `EnvironmentProvider`, `Model` and `ModelPrice` is realised.
// `ProviderProbeCache` is a context-owned cache seam; the note on that file
// records why §13's map has no home for it.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./providers-repository.js";
export * from "./model-router.js";
export * from "./provider-probe-cache.js";
