// The single `ModelRouter` implementation, and the only holder of the SDK.
//
// ADR M0.3 §1 row 4 makes `providers` the sole holder of provider SDKs behind
// this port, and §5.1 rule (h) pins them to this directory. `provider-sdk-only`
// and `inference-sdk-only` in scripts/arch/boundary-rules.mjs are the executable
// halves of that: a raw provider client and the cross-vendor inference framework
// may be imported here and nowhere else in the repository, and a file elsewhere
// that reaches for either fails the boundary gate.
//
// WHAT THIS FILE IS FOR. It is the SEAM and not the work: five methods, each of
// which resolves a client and hands off. The work is in the modules beside it,
// which is deliberate — the extraction source keeps the same behaviour in a
// 7,121-line service where the caching, the usage arithmetic and the tool loop
// can only be reached through a live provider.
//
// NOTHING IS CACHED HERE, AND `expiresAt` IS NULL BECAUSE OF IT. The port PERMITS
// an implementation to hand back a handle it minted earlier, and says the one
// thing it may not do is hand back an expired one. This implementation sidesteps
// that question rather than answering it: a `ModelSession` here holds no client
// and no material, only a plan and a credential FINGERPRINT, and every method
// that talks to a provider builds its client afresh from the plan and the
// credential it is given for that call. There is nothing to go stale, so there
// is no expiry to declare.
//
// A handle's id is DERIVED, not allocated, so two calls naming the same route
// and the same key still produce the same id — which is what makes it useful to
// log — while a rotated key produces a different one. An implementation that did
// hold clients would have to age them, and the use case is where that would be
// checked, against the clock port.
//
// THE CREDENTIAL IS NEVER CACHED WITH THE SESSION. `open` records a fingerprint;
// every method that talks to a provider takes the material afresh. That is what
// makes a rotation take effect on the next call rather than on the next restart.

import {
  err,
  ok,
  retryPolicyInvalid,
  type ListModelsRequest,
  type ModelGeneration,
  type ModelGenerationRequest,
  type ModelRouter,
  type ModelSession,
  type OpenModelRequest,
  type ProbeModelRequest,
  type ProbeOutcome,
  type Result,
  type GenerationEvent,
} from "@platos/context-providers/application/ports/index.js";

import { resolveModel } from "./clients.js";
import { failed, isAuthRefusal } from "./failure.js";
import { listPublishedModels } from "./model-list.js";
import { probeModel } from "./probe.js";
import { runGeneration } from "./run.js";
import { startStream } from "./streaming.js";
import {
  DEFAULT_RETRY_POLICY,
  retryingTransport,
  SYSTEM_TRANSPORT_CLOCK,
  type HttpTransport,
  type RetryPolicy,
  type TransportClock,
} from "./transport.js";

export interface ModelRouterProvidersAdapter extends ModelRouter {
  readonly adapterName: "model-router-providers";
}

/**
 * What the composition root supplies.
 *
 * All three are seams and all three have working defaults, so a caller that has
 * no opinion writes `createModelRouterProvidersAdapter()`. `transport` is here
 * so a test can answer a provider without a network, and `clock` so a test can
 * observe a retry policy's waits instead of serving them.
 */
export interface ModelRouterProvidersOptions {
  readonly retryPolicy?: RetryPolicy;
  readonly transport?: HttpTransport;
  readonly clock?: TransportClock;
}

function sessionIdFor(request: OpenModelRequest): string {
  // The plan and the credential FINGERPRINT, never the material. Two calls with
  // the same route and the same key share a handle; a rotated key does not,
  // which is the property that makes the id safe to log.
  const plan = request.plan;
  return [
    plan.reference.provider,
    plan.reference.modelName,
    plan.dialect,
    plan.baseUrl ?? "-",
    plan.location ?? "-",
    request.credential.fingerprint,
  ].join("|");
}

class ModelRouterProviders implements ModelRouterProvidersAdapter {
  public readonly adapterName = "model-router-providers" as const;

  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  open(request: OpenModelRequest): Promise<Result<ModelSession>> {
    // The client is built here to prove the route and the credential can produce
    // one, and then dropped: it is cheap to rebuild and holding it would mean
    // holding the material. The failure a caller cares about at `open` is a
    // route that cannot be constructed, and that is exactly what this catches.
    const resolved = resolveModel(request.plan, request.credential, this.transport);
    if (!resolved.ok) return Promise.resolve(err(resolved.error));
    return Promise.resolve(
      ok({ sessionId: sessionIdFor(request), plan: request.plan, expiresAt: null }),
    );
  }

  async generate(request: ModelGenerationRequest): Promise<Result<ModelGeneration>> {
    const model = resolveModel(request.session.plan, request.credential, this.transport);
    if (!model.ok) return err(model.error);
    try {
      return await runGeneration(request, model.value);
    } catch (thrown) {
      // The port says a rejected promise is a defect in the adapter, not a
      // business outcome. This is the backstop that keeps that true even when
      // the defect is in this package.
      return failed(thrown, request.abortSignal);
    }
  }

  stream(request: ModelGenerationRequest): Promise<Result<AsyncIterable<GenerationEvent>>> {
    const model = resolveModel(request.session.plan, request.credential, this.transport);
    if (!model.ok) return Promise.resolve(err(model.error));
    try {
      return Promise.resolve(startStream(request, model.value));
    } catch (thrown) {
      return Promise.resolve(failed(thrown, request.abortSignal));
    }
  }

  async probe(request: ProbeModelRequest): Promise<Result<ProbeOutcome>> {
    const model = resolveModel(request.plan, request.credential, this.transport);
    // A route that cannot be constructed was never called, so it is not a
    // verdict on the credential and it is not `ok` with a failure token either.
    if (!model.ok) return err(model.error);
    return probeModel(request, model.value, isAuthRefusal);
  }

  listModels(request: ListModelsRequest): Promise<Result<readonly string[]>> {
    return listPublishedModels(request, this.transport);
  }
}

/**
 * Build the adapter.
 *
 * The retry policy is validated at construction rather than at first failure —
 * see `transport.ts` — so a malformed one is a startup error and not a surprise
 * during an outage.
 */
export function createModelRouterProvidersAdapter(
  options: ModelRouterProvidersOptions = {},
): Result<ModelRouterProvidersAdapter> {
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  if (policy.rules.length === 0) {
    // An empty rule set is not "no retries", which is what a caller means when
    // it writes one: it is a policy under which every classified failure is
    // handed straight back, silently, including the ones the defaults retry.
    // Refusing makes the caller say which of the two it meant.
    return err(retryPolicyInvalid("a retry policy must carry at least one rule", "rules", 0));
  }
  const base = options.transport ?? globalThis.fetch;
  const clock = options.clock ?? SYSTEM_TRANSPORT_CLOCK;
  return ok(new ModelRouterProviders(retryingTransport(policy, base, clock)));
}
