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

// WIN-258 T5 — the names `ProvidersRepository`'s OWN SIGNATURES already use, and
// the handful an implementation of them cannot build a return value without.
//
// WITHOUT THIS BLOCK THE CANONICAL-STORE PORT IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `providers-repository.ts` above imports `Model`, `ModelFacts`,
// `ModelId`, `ModelKey`, `ModelPrice`, `ModelPriceSnapshot`, `PriceCard`,
// `ProviderId`, `ProviderKey`, `ProviderKeyId` and `ProviderLink` from
// `../../domain/index.js` as TYPES and re-exported none of them, and it names
// `EnvironmentScope` and `TransactionScope` from the kernel. So every method on
// the port was declared in terms of names an adapter package — the only kind of
// package ADR M0.3 §2 permits to implement a driven port — had no way to spell.
// The same omission has now been found five times on this issue: `EndUserStore`,
// `SessionRevocationOrder`, `cost-monitoring`'s whole aggregate set, `secrets`'
// two ports, and this. It is repaired the same way each time — the port entry
// point publishes exactly what the port's own signatures use, and nothing more.
//
// THE VALUE EXPORTS ARE HERE FOR A STRONGER REASON THAN THE TYPES.
//
//   `byListingOrder` IS the order `pageProviderKeys` promises, tie-break
//   included. A store that could not name it would have written the order out
//   again in SQL, and two statements of one total order is how a paged listing
//   starts dropping and repeating rows across pages.
//
//   `RATE_SOURCES` and `isRateSource` are the CLOSED union `ModelPrice`'s four
//   `ModelRateSource` columns are read back through. A store that could not name
//   them would have written its own literal list, and two lists over one column
//   is how a row becomes unreadable by the release that did not write it.
//
//   `rateFromDecimalString` and `rateToDecimalString` are the ONLY exact
//   crossing between a `TokenRate` and the `Decimal(24, 12)` column that holds
//   it. `rate.ts` exists because the extraction source went through `number` and
//   lost a half-cent on the boundary; a store that re-derived the conversion
//   would have re-introduced exactly that.
//
//   `providerKeyAlreadyExists`, `priceRevisionConflict` and
//   `repositoryUnavailable` are the three refusals the port's own documentation
//   names — the label conflict, the append-only price clash the port says MUST
//   NOT become an update, and the store outage. A store that minted its own
//   codes would answer a caller matching on `PROVIDERS_PRICE_REVISION_CONFLICT`
//   with something it does not recognise.
//
//   `asProvidersIdentifier` is the tagging function `domain/identifiers.ts`
//   reserves for "adapters reading a row, and transports parsing a request",
//   which is this caller exactly.
//
// The kernel values these signatures name are republished for the reason
// `identity-access`'s, `cost-monitoring`'s and `secrets`' port entry points
// republish theirs: an adapter that reached for `@platos/kernel` directly would
// be a second import edge into the kernel from a package whose only declared
// dependency is the context whose port it satisfies.
export type { EnvironmentId, EnvironmentScope, TransactionScope } from "@platos/kernel";

export type {
  ActorId,
  CredentialId,
  CredentialName,
  EnvironmentProviderId,
  Model,
  ModelFacts,
  ModelId,
  ModelKey,
  ModelPrice,
  ModelPriceId,
  ModelPriceSnapshot,
  PriceCard,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
  ProviderLink,
  RateBook,
  RateEntry,
  RateName,
  RateSource,
  TokenRate,
} from "../../domain/index.js";
export {
  asProvidersIdentifier,
  byListingOrder,
  credentialUnavailable,
  isRateSource,
  priceRevisionConflict,
  providerKeyAlreadyExists,
  providerKeyPinnedByAgents,
  RATE_NAMES,
  RATE_SOURCES,
  rateFromDecimalString,
  rateToDecimalString,
  repositoryUnavailable,
} from "../../domain/index.js";
