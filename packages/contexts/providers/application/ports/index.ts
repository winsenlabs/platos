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

// The handful of DOMAIN CONSTRUCTORS an implementation of `ModelRouter` cannot
// do its job without, re-exported here because this entrypoint is an adapter's
// only import edge into this package.
//
// Without them, two of the port's own rules would be unsatisfiable rather than
// merely unenforced. `model-router.ts` property 3 requires an implementation to
// translate its client's errors into `PROVIDERS_*` domain errors, and
// `GenerationEvent`'s `failed` carries a `DomainError` — neither is possible
// from a package that cannot reach an error factory. `modelGeneration` and
// `tokenUsage` are here for a second reason: they are the only way to build
// those two values, and both DERIVE what a hand-built literal could get wrong —
// a whole-generation total that disagrees with its steps, and a usage reading
// whose cache counts exceed its input count.
//
// Nothing else is re-exported. This is not a second contracts entrypoint: a
// caller wanting the `providers` capability imports `contracts/`, and an
// adapter wanting anything not on this list is reaching past its one job.
export {
  configurationUnavailable,
  modelGeneration,
  providerCredentialUnavailable,
  providerRequestFailed,
  structuredOutputInvalid,
  tokenUsage,
} from "../../domain/index.js";
