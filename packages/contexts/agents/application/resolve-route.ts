// Use case: resolve an agent's model route.
//
// THIS IS THE SEAM WHERE `agents` MEETS `providers`, AND IT STOPS SHORT OF THE
// PROVIDER ON PURPOSE. Selecting a route by label is this context's rule — the
// routing table is a field of a version it owns. Turning a model string and a
// key into a callable session is `providers`' rule, published as
// `openModelRoute`, and composing a turn out of sessions is `conversations`'.
// So this use case answers "which model, paid for by which key", and hands that
// to a caller that owns the next step. Reaching further would put turn execution
// in the context that authors agents, which is the god-module ADR M0.3 §1 exists
// to prevent.
//
// THE PIN CHECK IS THE RUNNING SYSTEM'S, MOVED EARLIER. When a route pins a
// provider key, resolution fails closed unless that key exists in THIS
// environment AND belongs to the provider the route's model names. The running
// system performs exactly that check at the moment of use, one layer down, and
// its message — "no ProviderKey with the pinned id for this provider in this
// environment" — is the one this context's error carries. Failing closed is the
// whole point of it: the alternative, silently falling back to the environment's
// default key, bills a different customer's credential for the turn.
//
// AND IT IS ASKED OF `providers`, NOT ANSWERED HERE. This context knows which
// key a route names; only `providers` knows whether that key exists and which
// provider it belongs to. `describeProviderKey` is the question, and its refusal
// is translated into this context's vocabulary rather than passed through — a
// caller resolving an AGENT's route should not receive an error whose code says
// `PROVIDERS_`.

import { err, ok, type Result } from "@platos/kernel";

import {
  asAgentsIdentifier,
  compactionModel,
  defaultRoute,
  providerKeyPins,
  providerKeyUnavailable,
  providerOf,
  routeNotFound,
  selectRoute,
  type AgentId,
  type ModelRoute,
  type ProviderKeyId,
  type ProviderKeyPin,
  type RouteLabel,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import { requireBound } from "./read-agents.js";

export interface ResolveRouteQuery {
  readonly authorization: unknown;
  readonly agentId: AgentId;
  /** Absent selects the default route; a label selects that route or refuses. */
  readonly label?: string | null;
}

export interface DescribePinsQuery {
  readonly authorization: unknown;
  readonly agentId: AgentId;
}

/** Which model answers, and which key pays for it. */
export interface ResolvedRoute {
  /** Null when the version carries no routing table and its own model answers. */
  readonly label: RouteLabel | null;
  readonly model: string;
  readonly provider: string;
  /** Null means "this provider's default key in this environment". */
  readonly providerKeyId: ProviderKeyId | null;
  /** The credential's bare name, when a key is pinned and resolved. */
  readonly credentialName: string | null;
}

export async function resolveRoute(
  dependencies: AgentsDependencies,
  query: ResolveRouteQuery,
): Promise<Result<ResolvedRoute>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);

  const snapshot = bound.value.activeVersion.snapshot;
  const routes = snapshot.modelRoutes ?? [];
  const selected = selectFor(routes, query.label);
  if (!selected.ok) return err(selected.error);

  const route = selected.value;
  const model = route === null ? snapshot.model : route.model;
  const providerKeyId = route === null ? snapshot.providerKeyId : route.providerKeyId;
  const provider = providerOf(model);

  if (providerKeyId === null) {
    return ok({
      label: route === null ? null : route.label,
      model,
      provider,
      providerKeyId: null,
      credentialName: null,
    });
  }
  const pinned = await resolvePin(dependencies, query.authorization, providerKeyId, provider);
  if (!pinned.ok) return err(pinned.error);
  return ok({
    label: route === null ? null : route.label,
    model,
    provider,
    providerKeyId,
    credentialName: pinned.value,
  });
}

/**
 * The model background summarisation uses for this agent.
 *
 * Its own use case because the answer for an ABSENT compaction route is not an
 * error — it is the default summarisation model. Routing that through
 * `resolveRoute` would turn "this agent never configured compaction" into a
 * failed turn, which is the failure mode the reserved label was introduced to
 * remove.
 */
export async function resolveCompactionRoute(
  dependencies: AgentsDependencies,
  query: DescribePinsQuery,
): Promise<Result<ResolvedRoute>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);

  const snapshot = bound.value.activeVersion.snapshot;
  const routes = snapshot.modelRoutes ?? [];
  const model = compactionModel(routes);
  const route = routes.find((entry) => entry.model === model) ?? null;
  const provider = providerOf(model);
  const providerKeyId = route?.providerKeyId ?? null;
  if (providerKeyId === null) {
    return ok({ label: route?.label ?? null, model, provider, providerKeyId: null, credentialName: null });
  }
  const pinned = await resolvePin(dependencies, query.authorization, providerKeyId, provider);
  if (!pinned.ok) return err(pinned.error);
  return ok({ label: route?.label ?? null, model, provider, providerKeyId, credentialName: pinned.value });
}

/**
 * Every provider key this agent's live version pins.
 *
 * The read side of the constraint that stops a pinned key being deleted. That
 * refusal lives in `providers` — it owns the key — and it walks the same two
 * places a pin can live: the version's own runtime pin, and each route's. This
 * publishes the answer from the side that owns the version, so the two never
 * have to agree by coincidence.
 */
export async function describePins(
  dependencies: AgentsDependencies,
  query: DescribePinsQuery,
): Promise<Result<readonly ProviderKeyPin[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);
  const snapshot = bound.value.activeVersion.snapshot;
  return ok(providerKeyPins(snapshot.model, snapshot.providerKeyId, snapshot.modelRoutes ?? []));
}

function selectFor(
  routes: readonly ModelRoute[],
  label: string | null | undefined,
): Result<ModelRoute | null> {
  if (routes.length === 0) {
    // No routing table at all. The version's own model answers, and a caller
    // that asked for a label by name gets a refusal rather than that model —
    // asking for `fast` and being served the default silently is worse than
    // being told there is no `fast`.
    const asked = label?.trim();
    return asked === undefined || asked === "" ? ok(null) : err(routeNotFound(asked));
  }
  const asked = label?.trim();
  if (asked === undefined || asked === "") {
    const fallback = defaultRoute(routes);
    return fallback === null ? ok(null) : ok(fallback);
  }
  return selectRoute(routes, asAgentsIdentifier<RouteLabel>(asked));
}

/**
 * Ask `providers` whether this pin resolves, and to which provider.
 *
 * A refusal from `providers` — whatever its code — becomes this context's
 * `AGENTS_PROVIDER_KEY_UNAVAILABLE` with `reason: "unresolved"`; a key that
 * resolves to a different provider becomes the same code with
 * `reason: "provider-mismatch"`. Two reasons, one code, because the caller's
 * remedy is the same and the diagnosis belongs in log-only details.
 */
async function resolvePin(
  dependencies: AgentsDependencies,
  authorization: unknown,
  providerKeyId: ProviderKeyId,
  provider: string,
): Promise<Result<string>> {
  const described = await dependencies.providers.describeProviderKey({
    authorization,
    providerKeyId: providerKeyId as never,
  });
  if (!described.ok) return err(providerKeyUnavailable(providerKeyId, provider, "unresolved"));
  if (described.value.provider !== provider) {
    return err(providerKeyUnavailable(providerKeyId, provider, "provider-mismatch"));
  }
  return ok(described.value.credentialName);
}
