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
  generationAborted,
  honoursExplicitCacheBreakpoints,
  messageNotRepresentable,
  modelGeneration,
  outputSchemaInvalid,
  passBudget,
  providerCredentialUnavailable,
  providerRequestFailed,
  repairToolCallInput,
  retryPolicyInvalid,
  serviceAccountInvalid,
  structuredOutputCorrection,
  structuredOutputInvalid,
  tokenUsage,
  toolExecutorFailed,
} from "../../domain/index.js";

// `ok` and `err`, from the kernel, for the same reason as the error factories
// above: every method on this port returns `Result<T>`, and a package with no
// way to CONSTRUCT one could not implement a single one of them. Types would not
// have been enough — these two are values.
export { err, ok } from "@platos/kernel";
export type { DomainError, Result } from "@platos/kernel";

// EVERY TYPE THAT APPEARS IN THIS PORT'S OWN SIGNATURES, and the ones an
// implementation of those signatures has to NAME in order to build the values
// they return. `ContentPart` and `PromptMessage` are how a `Prompt` is taken
// apart; `GenerationStep`, `FinishReason` and `TokenUsage` are what
// `modelGeneration` and a `step-finished` event are assembled from;
// `ProviderDialect` is what an implementation switches on to pick a client;
// `ModelListShape` and `ModelListAuth` are how `listModels` reads an endpoint.
//
// This is not a widening of the rule stated above — it is that rule applied
// honestly. A port whose parameter types cannot be named by its one permitted
// implementer is not a port, and re-deriving these shapes inside the adapter
// would have produced a second, drifting copy of the vocabulary this context
// owns. Types only: nothing here adds a runtime edge.
export type {
  ContentPart,
  FilePart,
  FinishReason,
  GenerationEvent,
  GenerationStep,
  ImagePart,
  JsonSchemaDocument,
  MessageRole,
  ModelGeneration,
  ModelListAuth,
  ModelListEndpoint,
  ModelListShape,
  ModelRoutePlan,
  OutputMode,
  ProbeFailure,
  Prompt,
  PromptMessage,
  ProviderDialect,
  ReasoningPart,
  SamplingLimits,
  TextPart,
  TokenUsage,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
} from "../../domain/index.js";
