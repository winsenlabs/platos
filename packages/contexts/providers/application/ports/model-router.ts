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

import type { Result } from "@platos/kernel";

import type { ModelListEndpoint, ModelRoutePlan, ProbeFailure } from "../../domain/index.js";

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

export interface ModelRouter {
  /**
   * Bind a plan to a credential and return a handle the turn engine can use.
   *
   * This is the inference seam. It does not run a turn: composing a turn out of
   * sessions belongs to `conversations`, which the ADR extracts last.
   */
  open(request: OpenModelRequest): Promise<Result<ModelSession>>;

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
