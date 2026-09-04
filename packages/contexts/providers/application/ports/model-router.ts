// The `ModelRouter` port — OWNED AND PUBLISHED BY THIS CONTEXT.
//
// ADR M0.3 §1 row 4 makes `providers` the "sole holder of provider SDKs behind
// `ModelRouter`", and §13 assigns the port's ownership here rather than to the
// kernel. This interface is the only thing the rest of the system ever sees of a
// provider's API, and `packages/adapters/model-router-providers` is the only
// place a provider SDK may be imported (§5.1 rule (h)).
//
// FOUR PROPERTIES THIS INTERFACE MUST HAVE, and why each is shaped as it is:
//
// 1. IT NAMES NO VENDOR. There is no client option, no SDK type and no vendor
//    name anywhere below. What varies between providers is already decided:
//    `domain/route.ts` produces a `ModelRoutePlan` naming the dialect, the root
//    and the surface, and the adapter's job is to honour a finished plan rather
//    than to re-derive one from a string.
//
// 2. THE CREDENTIAL IS SUPPLIED PER CALL AND NEVER STORED. Every method takes
//    the material for that one call. The adapter is forbidden from caching it,
//    from writing it anywhere, and from reading an ambient one: a provider SDK's
//    own environment-variable discovery is exactly the failure this port exists
//    to prevent, because it silently charges an installation-wide key for a
//    tenant's work.
//
// 3. FAILURE IS A VALUE, NOT AN EXCEPTION. Every method returns
//    `Promise<Result<T>>`. An implementation MUST translate its client's errors
//    into the `PROVIDERS_*` domain errors and MUST NOT let a vendor error
//    escape — a caller forbidden from importing the SDK (ADR M0.3 §2) cannot
//    possibly catch a typed error from it. A rejected promise is a defect in the
//    adapter, not a business outcome.
//
// 4. A REFUSAL IS DISTINGUISHED FROM A FAILURE. `probe` reports `auth_refused`
//    only when the provider itself rejected the credential. Everything else is
//    `request_failed`. Collapsing the two sends an operator to rotate a
//    perfectly good key because a provider had an outage.
//
// THE INFERENCE HALF (ADR M0.3 §14). `generate` and `stream` were added for one
// reason: `conversations` (§1 row 16) is the last context out and it cannot be
// extracted while running a turn means importing an inference framework. It has
// to be able to ask THIS port instead, which means this port has to cover what
// a turn actually does — text, streaming, schema-shaped output, tool round
// trips, and the prompt-cache placement that decides what a turn costs.
//
// Every type in those two signatures is one this context owns. That is not
// tidiness: `inference-sdk-only` in scripts/arch/boundary-rules.mjs forbids the
// framework everywhere but the one adapter, so a vendor type appearing here
// would make the port literally unusable by the context it exists for.

import type { Result } from "@platos/kernel";

import type {
  GenerationEvent,
  ModelGeneration,
  ModelListEndpoint,
  ModelRoutePlan,
  OutputMode,
  ProbeFailure,
  Prompt,
  SamplingLimits,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
} from "../../domain/index.js";

/**
 * Secret material for exactly one call.
 *
 * A distinct type, not `string`, so it cannot be assigned into a log field, a
 * cache key or a view by accident. It is deliberately NOT the `SecretMaterial`
 * of `secrets`: that value redacts itself, and an adapter has to be able to put
 * the real bytes on the wire. The narrowing that matters is at the type, and the
 * `reveal()` call site is the one place to audit.
 */
export interface ProviderCredential {
  /** The bytes the provider expects. Never logged, never cached, never stored. */
  reveal(): string;
  /**
   * A stable, non-reversible fingerprint of the material.
   *
   * This is what a cache key is built from (`domain/health.ts`), so two
   * environments sharing one key share an answer and a rotation invalidates it
   * by construction. It must not be derivable back into the material.
   */
  readonly fingerprint: string;
}

/**
 * An opaque handle to a provider-bound model.
 *
 * The adapter holds the client; this value holds its identity. A caller can log
 * it, compare it and hand it back, and cannot call the provider with it — which
 * is what keeps the SDK inside one directory while the turn engine still has
 * something to name.
 */
export interface ModelSession {
  readonly sessionId: string;
  readonly plan: ModelRoutePlan;
  /** When this handle stops being usable and must be opened again. */
  readonly expiresAt: Date | null;
}

export interface OpenModelRequest {
  readonly plan: ModelRoutePlan;
  readonly credential: ProviderCredential;
}

export interface ProbeModelRequest {
  readonly plan: ModelRoutePlan;
  readonly credential: ProviderCredential;
  /** Budget for the whole call. The adapter MUST abandon it at this point. */
  readonly timeoutMs: number;
}

export interface ProbeOutcome {
  /** Null when the provider accepted the call. */
  readonly failure: ProbeFailure | null;
  /** What the call actually named, for the report. */
  readonly model: string;
}

export interface ListModelsRequest {
  readonly plan: ModelRoutePlan;
  /**
   * Where the list is published and how to read it.
   *
   * Separate from the plan because it is a different address: a provider's model
   * list does not always hang off its inference root. When the plan carries an
   * operator-configured root, that root wins — a private gateway publishes its
   * own list, not the upstream's.
   */
  readonly endpoint: ModelListEndpoint;
  readonly credential: ProviderCredential;
  readonly timeoutMs: number;
}

/**
 * Run one tool the model asked for, and answer it.
 *
 * A function the CALLER supplies, which is what keeps `tools` off this
 * context's dependency list while still letting the round trips happen behind
 * the port (see `domain/generation.ts` for that argument in full). `providers`
 * learns a tool's name and its JSON Schema and nothing else about it.
 *
 * A TOOL THAT FAILED IS A RESULT, NOT AN ERROR. It comes back as a
 * `ToolResultPart` with `failed: true`, because the model has to be told and is
 * often able to recover on the next step. A rejected promise is a defect in the
 * caller, not a business outcome, and will end the generation.
 */
export type ToolExecutor = (call: ToolCallPart) => Promise<ToolResultPart>;

/**
 * One inference request: a whole generation, not one call to a provider.
 *
 * The framing is deliberate. A generation runs until the model stops asking for
 * tools or `maxSteps` is spent, and the interesting behaviour lives BETWEEN the
 * steps — the cache breakpoints move, and the usage accumulates. Handing back
 * one step at a time would have pushed both of those onto every caller.
 */
export interface ModelGenerationRequest {
  /** Which binding. Names the route; carries no material. */
  readonly session: ModelSession;
  /** The material for THIS call. Supplied per call, exactly as `probe` is. */
  readonly credential: ProviderCredential;
  readonly prompt: Prompt;
  /** May be empty. An empty catalogue is a generation with no round trips. */
  readonly tools: readonly ToolDefinition[];
  readonly executeTool: ToolExecutor;
  readonly output: OutputMode;
  readonly sampling: SamplingLimits;
  /** At least one. A step budget is what bounds an open-ended tool loop. */
  readonly maxSteps: number;
  /**
   * Rewrite the prompt before EVERY step, the first one included.
   *
   * This is where prompt-cache breakpoints are moved onto the growing message
   * array, and it is the single most valuable line in this interface: without
   * it every step after the first re-pays full price for the whole history.
   *
   * The implementation MUST call this with the prompt it is about to send,
   * including the assistant and tool messages the previous steps added, and
   * MUST send what comes back. It is a pure function over this system's own
   * `Prompt`; the adapter does not need to know what it did.
   */
  readonly rewritePrompt: (prompt: Prompt) => Prompt;
  /**
   * Abandon the whole generation, including any provider stream in flight.
   *
   * Null means no deadline from the caller. An implementation that ignores this
   * keeps billing after the caller has stopped listening.
   */
  readonly abortSignal: AbortSignal | null;
}

export interface ModelRouter {
  /**
   * Bind a plan to a credential and return a handle the turn engine can use.
   *
   * The route half of the inference seam. `generate` and `stream` are the other
   * half; composing a whole TURN out of generations — deciding what to put in
   * the prompt, what to do with the answer, and what to persist — still belongs
   * to `conversations`, which the ADR extracts last.
   *
   * AN IMPLEMENTATION MAY RETURN A HANDLE IT MINTED EARLIER, and is expected to:
   * constructing a client per call is waste, and the running system holds one
   * resolved model handle across a whole route's lifetime. What it may NOT do is
   * return one whose `expiresAt` has passed. Because it may, `expiresAt` is a
   * real answer rather than a formality, and the caller checks it — see
   * `application/run-model-generation.ts`.
   */
  open(request: OpenModelRequest): Promise<Result<ModelSession>>;

  /**
   * Run a generation to completion and return everything it produced.
   *
   * Covers the whole non-streaming surface the extraction source reaches for:
   * plain text, an object shaped by a schema, and any number of tool round
   * trips up to the step budget. The per-step figures come back in
   * `steps`, and `totalUsage` is derived from them, so a caller pricing a turn
   * through `priceModelUsage` charges the same tokens the trace shows.
   *
   * Cache accounting is NOT flattened. `TokenUsage` carries the cache read and
   * write counts separately because `price-card.ts` charges them at separate
   * rates, and a surface that returned one input figure would have made a
   * cached turn indistinguishable from an uncached one on the bill.
   */
  generate(request: ModelGenerationRequest): Promise<Result<ModelGeneration>>;

  /**
   * The same generation, delivered as it happens.
   *
   * The outer `Result` is whether the generation STARTED. Once it has, a
   * failure arrives as a `failed` event in the sequence, because a caller that
   * has already received tokens needs the failure in the same order as the
   * tokens rather than as a rejection out of band.
   *
   * The sequence always ends in exactly one of `finished`, `aborted` or
   * `failed`. An implementation that ends it any other way has left the caller
   * with a turn it cannot close.
   */
  stream(request: ModelGenerationRequest): Promise<Result<AsyncIterable<GenerationEvent>>>;

  /**
   * A minimal live call that proves the credential is accepted.
   *
   * Returns `ok` with a `failure` token for a provider that answered and refused
   * — that IS the outcome, and the health report renders it. It returns `err`
   * only when the call could not be attributed to the provider at all.
   */
  probe(request: ProbeModelRequest): Promise<Result<ProbeOutcome>>;

  /**
   * The bare model ids the provider currently publishes, unqualified.
   *
   * The caller qualifies them with the provider id and unions them under the
   * curated list (`mergeModelLists`), so an adapter that returns nothing narrows
   * the picker rather than emptying it.
   */
  listModels(request: ListModelsRequest): Promise<Result<readonly string[]>>;
}
