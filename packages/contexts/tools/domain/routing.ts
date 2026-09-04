// Where does a named tool call go?
//
// One question, asked by four callers in the source — the executor's inline
// lookup, the MCP dispatcher, the registry's own `getScopedTools` consumers,
// and the turn preflight — and answered four slightly different ways until
// `ToolRouterService` consolidated it. This is that consolidation, as a pure
// rule over an already-narrowed exposure set.
//
// A TOOL NAME IS NOT UNIQUE AND PRETENDING OTHERWISE IS THE DEFECT THIS FILE
// EXISTS TO PREVENT. `Tool` is keyed `@@unique([name, schemaHash])`, so one
// name spans every schema version ever registered; `EnvironmentEntityTool` is
// keyed by (environment, entity, tool), so several entities in one environment
// may offer the same name at once. "Find the tool called X" therefore has zero,
// one, or many answers, and the caller has to say what it wants done about it.
//
// THE TWO STRATEGIES ARE NOT A PREFERENCE, THEY ARE TWO DIFFERENT CALLERS.
//
//   `first-match` is for a language model. It has no way to name an entity, so
//   an ambiguity error is not something it can act on; it needs a stable answer
//   and it needs the SAME stable answer on the retry.
//
//   `error` is for an MCP client. It knows which backend it meant, so handing
//   it the candidate list lets it re-ask precisely — the one case where an
//   error is more useful than a guess.

import { err, ok, type Result } from "@platos/kernel";

import { routeAmbiguous, routeNotInScope } from "./errors.js";
import {
  selectExposures,
  type ExposureFilter,
  type ToolExposure,
} from "./exposure.js";
import type { ToolName } from "./identifiers.js";

export const DISAMBIGUATION_STRATEGIES = ["first-match", "error"] as const;

export type DisambiguationStrategy = (typeof DISAMBIGUATION_STRATEGIES)[number];

export interface RouteRequest extends ExposureFilter {
  readonly toolName: ToolName;
  /** Defaults to `first-match`, the shape a model can act on. */
  readonly strategy?: DisambiguationStrategy;
}

export interface ToolRoute {
  readonly exposure: ToolExposure;
  /**
   * How many exposures matched before disambiguation.
   *
   * Carried, not discarded. `1` is an unambiguous route; anything higher is a
   * route that was CHOSEN, and an audit line that cannot tell the two apart
   * cannot explain why a call reached the backend it did.
   */
  readonly matched: number;
}

/**
 * Resolve a name to one exposure.
 *
 * The tie-break is the lowest `toolId`, transcribed. The source's note calls it
 * "≈ creation order" because the column was a CUID; the baseline schema makes
 * it `@default(uuid())`, which sorts by nothing at all. The order is therefore
 * ARBITRARY — and it is kept, because arbitrary-but-total is the property a
 * model's retry depends on, and the alternative (oldest-first by `createdAt`)
 * would silently re-route every live call the first time two exposures were
 * created in the same millisecond. `matched` is what tells an operator the
 * choice happened; the strategy is what lets a caller refuse it.
 */
export function resolveRoute(
  exposures: readonly ToolExposure[],
  request: RouteRequest,
): Result<ToolRoute> {
  const strategy = request.strategy ?? "first-match";
  const candidates = selectExposures(exposures, request).filter(
    (exposure) => exposure.toolName === request.toolName,
  );

  if (candidates.length === 0) {
    return err(routeNotInScope(request.toolName, request.externalEntityIds ?? []));
  }
  if (candidates.length === 1) {
    return ok({ exposure: candidates[0] as ToolExposure, matched: 1 });
  }
  if (strategy === "error") {
    return err(
      routeAmbiguous(
        request.toolName,
        candidates.map((candidate) => ({
          entityId: candidate.externalEntityId,
          toolId: candidate.toolId,
        })),
      ),
    );
  }

  const chosen = [...candidates].sort((left, right) =>
    left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0,
  )[0] as ToolExposure;
  return ok({ exposure: chosen, matched: candidates.length });
}

/**
 * Must this agent name an entity before it may call anything?
 *
 * True once two or more entities contribute a callable tool. With one entity
 * there is nothing to disambiguate and demanding a name is friction; with two
 * there is, and a model that guesses is a model routing a customer's call to
 * another customer's backend by name collision.
 *
 * Counted over CALLABLE exposures only, which is what makes the mandate track
 * what the model can actually reach rather than what is configured.
 */
export function requiresEntityDisambiguation(exposures: readonly ToolExposure[]): boolean {
  const entities = new Set<string>();
  for (const exposure of exposures) {
    if (!exposure.enabled || !exposure.dispatchable) continue;
    entities.add(exposure.entityId);
    if (entities.size > 1) return true;
  }
  return false;
}
