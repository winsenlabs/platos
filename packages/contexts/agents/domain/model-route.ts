// `AgentVersion.modelRoutes` — the routing table an operator edits, and the
// column alias that has to survive a round trip.
//
// A route is a label an operator invents (`alpha`, `fast`, `compaction`) mapped
// to a model string and, optionally, to ONE provider key. A caller selects the
// label per request; the runtime resolves the pair. Exactly one route should
// carry `isDefault`, and `selectRoute` states what happens when none or several
// do rather than leaving it to whichever row the store returned first.
//
// THE COLUMN AND THE API DISAGREE ABOUT ONE FIELD NAME, ON PURPOSE, AND BOTH
// SPELLINGS ARE LIVE. The API says `providerKeyId`; the stored JSON says
// `providerCredentialId`. `readRoute` accepts either — `providerKeyId` first,
// then `providerCredentialId` — and `writeRoute` emits only
// `providerCredentialId`, and only when a key is actually pinned. That is what
// the running system does on both sides, and it is why a route round-trips
// through this file rather than being copied field-for-field: a naive copy
// writes `providerKeyId` into the column, where the delete guard's own query
// also reads it, and the two spellings then drift apart per row.
//
// THE PROVIDER SEGMENT IS THE UNQUALIFIED-MODEL RULE, NOT A STRING SPLIT. A
// model string with no colon routes to `anthropic`, because that is what the
// running resolution does and agent versions in the field carry bare model names
// that depend on it. The delete-guard SQL instead compares the WHOLE string when
// there is no colon, so a version pinning a key against a bare model name is not
// seen as pinning it. That divergence is real, it is the store's, and this file
// takes the RUNTIME side of it — the side that decides which key actually pays
// for a turn. `PIN_SEGMENT_DIVERGENCE` names it so the disagreement is
// greppable instead of folklore.

import { err, ok, type Result } from "@platos/kernel";

import { objectsIn, coerceBlockList } from "./blocks.js";
import { routeInvalid, routeNotFound } from "./errors.js";
import { asAgentsIdentifier, type ProviderKeyId, type RouteLabel } from "./identifiers.js";

/** Where a model string with no provider segment routes. */
export const DEFAULT_PROVIDER = "anthropic";

/** The reserved label that selects the background-summarisation model. */
export const COMPACTION_ROUTE_LABEL = asAgentsIdentifier<RouteLabel>("compaction");

/** What compaction falls back to when no `compaction` route is defined. */
export const DEFAULT_COMPACTION_MODEL = "anthropic:claude-haiku-4-5-20251001";

/** The stored spelling of a pinned provider key. */
export const STORED_PROVIDER_KEY_FIELD = "providerCredentialId";

/** The API spelling of the same field. Read, never written. */
export const API_PROVIDER_KEY_FIELD = "providerKeyId";

/**
 * The one place the delete guard and the runtime disagree: an unqualified model
 * string. The guard compares the whole string against a provider id; the runtime
 * assumes `anthropic`. Recorded, not resolved — resolving it is a store change.
 */
export const PIN_SEGMENT_DIVERGENCE = "unqualified-model-string";

export interface ModelRoute {
  readonly label: RouteLabel;
  readonly model: string;
  /** Null means "use this provider's default key in this environment". */
  readonly providerKeyId: ProviderKeyId | null;
  readonly isDefault: boolean;
}

/** Ceiling on an operator-defined label. */
export const MAX_ROUTE_LABEL_LENGTH = 200;

/**
 * The provider segment of a model string, by the RUNTIME rule.
 *
 * A colon at position zero is not a provider segment — `":gpt-4"` names no
 * provider — so it falls to the default exactly as an absent colon does.
 */
export function providerOf(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(0, colon) : DEFAULT_PROVIDER;
}

/** True when the model string carries its own provider segment. */
export function isQualified(model: string): boolean {
  return model.indexOf(":") > 0;
}

function readKeyId(entry: Record<string, unknown>): ProviderKeyId | null {
  const api = entry[API_PROVIDER_KEY_FIELD];
  if (typeof api === "string" && api !== "") return asAgentsIdentifier<ProviderKeyId>(api);
  const stored = entry[STORED_PROVIDER_KEY_FIELD];
  if (typeof stored === "string" && stored !== "") return asAgentsIdentifier<ProviderKeyId>(stored);
  return null;
}

/** Read one stored route object. Returns null when it is not a usable route. */
export function readRoute(value: unknown): ModelRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const label = entry["label"];
  const model = entry["model"];
  if (typeof label !== "string" || label === "") return null;
  if (typeof model !== "string" || model === "") return null;
  return {
    label: asAgentsIdentifier<RouteLabel>(label),
    model,
    providerKeyId: readKeyId(entry),
    isDefault: entry["isDefault"] === true,
  };
}

/** Read a whole routing column. Null when the column holds no list at all. */
export function readRoutes(value: unknown): readonly ModelRoute[] | null {
  const list = coerceBlockList(value);
  if (list === null) return null;
  const routes: ModelRoute[] = [];
  for (const entry of objectsIn(list)) {
    const route = readRoute(entry);
    if (route !== null) routes.push(route);
  }
  return routes;
}

/** Write one route back into its stored shape, in the column's spelling. */
export function writeRoute(route: ModelRoute): Readonly<Record<string, unknown>> {
  return Object.freeze({
    label: route.label,
    model: route.model,
    isDefault: route.isDefault,
    ...(route.providerKeyId === null ? {} : { [STORED_PROVIDER_KEY_FIELD]: route.providerKeyId }),
  });
}

export function writeRoutes(routes: readonly ModelRoute[]): readonly Readonly<Record<string, unknown>>[] {
  return routes.map(writeRoute);
}

/** What an operator supplies for one route. */
export interface RouteIntake {
  readonly label: string;
  readonly model: string;
  readonly providerKeyId?: string | null;
  readonly isDefault?: boolean;
}

/**
 * Admit a whole routing table.
 *
 * Duplicate labels are refused. The source does not check, and a table with two
 * `fast` rows resolves to whichever one the array happened to hold first — which
 * means a turn's model depends on the order an editor serialized its rows in.
 * That is not a behaviour worth preserving; it is an absent check, and adding it
 * refuses a table nothing could have routed deterministically anyway.
 */
export function admitRoutes(intake: readonly RouteIntake[]): Result<readonly ModelRoute[]> {
  const routes: ModelRoute[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of intake.entries()) {
    const label = entry.label.trim();
    if (label === "") {
      return err(
        routeInvalid("route label is required", [
          { field: `modelRoutes[${index}].label`, code: "required", message: "label is required" },
        ]),
      );
    }
    if (label.length > MAX_ROUTE_LABEL_LENGTH) {
      return err(
        routeInvalid(`route label must be at most ${MAX_ROUTE_LABEL_LENGTH} characters`, [
          { field: `modelRoutes[${index}].label`, code: "too_long", message: "label is too long" },
        ]),
      );
    }
    if (seen.has(label)) {
      return err(
        routeInvalid("two routes carry the same label", [
          { field: `modelRoutes[${index}].label`, code: "duplicate", message: `duplicate label ${label}` },
        ]),
      );
    }
    const model = entry.model.trim();
    if (model === "") {
      return err(
        routeInvalid("route model is required", [
          { field: `modelRoutes[${index}].model`, code: "required", message: "model is required" },
        ]),
      );
    }
    seen.add(label);
    const pinned = entry.providerKeyId;
    routes.push({
      label: asAgentsIdentifier<RouteLabel>(label),
      model,
      providerKeyId:
        pinned === undefined || pinned === null || pinned === ""
          ? null
          : asAgentsIdentifier<ProviderKeyId>(pinned),
      isDefault: entry.isDefault === true,
    });
  }
  return ok(routes);
}

/**
 * The route a request with no label gets: the one marked default, else the
 * first. Transcribed exactly — `find(isDefault) ?? routes[0]` — including the
 * fallback, which is what stops an operator who forgot the flag from having no
 * route at all.
 */
export function defaultRoute(routes: readonly ModelRoute[]): ModelRoute | null {
  return routes.find((route) => route.isDefault) ?? routes[0] ?? null;
}

/** The route a caller selected by label, or the refusal naming the label. */
export function selectRoute(routes: readonly ModelRoute[], label: RouteLabel): Result<ModelRoute> {
  const found = routes.find((route) => route.label === label);
  return found === undefined ? err(routeNotFound(label)) : ok(found);
}

/**
 * The compaction route, or null.
 *
 * Distinct from `selectRoute` because an absent compaction route is not an
 * error: it means the default summarisation model. Returning a refusal here
 * would turn "this agent never configured compaction" into a failed turn.
 */
export function compactionRoute(routes: readonly ModelRoute[]): ModelRoute | null {
  return routes.find((route) => route.label === COMPACTION_ROUTE_LABEL && route.model !== "") ?? null;
}

/** The model a route resolves to, or the default when there is no route. */
export function compactionModel(routes: readonly ModelRoute[]): string {
  return compactionRoute(routes)?.model ?? DEFAULT_COMPACTION_MODEL;
}

/**
 * The model string a create request resolves to when it names no model: the
 * default route's, else the first route's, else nothing.
 */
export function modelFromRoutes(routes: readonly ModelRoute[]): string | null {
  const route = defaultRoute(routes);
  return route === null || route.model === "" ? null : route.model;
}

/** One provider key a version pins, and the provider the pin is good for. */
export interface ProviderKeyPin {
  readonly providerKeyId: ProviderKeyId;
  readonly provider: string;
  /** The route that pins it, or null when the version-level pin does. */
  readonly label: RouteLabel | null;
}

/**
 * Every provider key this version pins.
 *
 * Both places a pin can live are read: the version-level pin, whose provider is
 * the version's own model string, and each route's pin, whose provider is that
 * route's model string. This is the same disjunction the delete guard walks when
 * it refuses to remove a key an agent still names — expressed here as a value so
 * the rule is testable without a database.
 */
export function providerKeyPins(
  versionModel: string,
  versionProviderKeyId: ProviderKeyId | null,
  routes: readonly ModelRoute[],
): readonly ProviderKeyPin[] {
  const pins: ProviderKeyPin[] = [];
  if (versionProviderKeyId !== null) {
    pins.push({ providerKeyId: versionProviderKeyId, provider: providerOf(versionModel), label: null });
  }
  for (const route of routes) {
    if (route.providerKeyId === null) continue;
    pins.push({ providerKeyId: route.providerKeyId, provider: providerOf(route.model), label: route.label });
  }
  return pins;
}

/** True when this version pins that key for the provider the key belongs to. */
export function pinsProviderKey(
  pins: readonly ProviderKeyPin[],
  providerKeyId: ProviderKeyId,
  provider: string,
): boolean {
  return pins.some((pin) => pin.providerKeyId === providerKeyId && pin.provider === provider);
}
