// `Macro` — a recorded sequence of tool calls, replayable with parameters.
//
// A macro is saved-request scaffolding, which is why ADR M0.3 §1 row 5 puts it
// here beside the agent definitions rather than in `tools`: it is authored, not
// executed, by this context. Replay re-dispatches each recorded step through the
// same surface an individual call would take, so every permission gate and audit
// record still applies — this context stores the steps and substitutes the
// parameters, and does not execute anything.
//
// THE VISIBILITY GATE HAS TWO ANSWERS AND BOTH ARE KEPT. A macro is READABLE by
// its owner or by anyone in its environment once it is shared; it is MUTABLE by
// its owner alone. So a shared macro that a non-owner tries to rename is
// legitimately visible and legitimately refused, and the two refusals are
// different codes (`AGENTS_MACRO_NOT_FOUND` versus
// `AGENTS_MACRO_NOT_EDITABLE`). Collapsing them would either leak the existence
// of macros a caller cannot see or tell a collaborator their macro vanished.
//
// SUBSTITUTION FAILS OPEN, ON PURPOSE. `${var.path}` with no matching parameter
// is left in place rather than replaced with an empty string. A blank where a
// path was silently produces a request that runs and does the wrong thing; a
// literal `${var.path}` produces one that fails visibly at the tool it reaches.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { macroInvalid } from "./errors.js";
import type { ActorId, MacroId } from "./identifiers.js";
import type { AgentMacroPolicy } from "./policy.js";
import type { JsonObject } from "./snapshot.js";

export interface MacroStep {
  readonly tool: string;
  readonly params: JsonObject;
}

export interface Macro {
  readonly macroId: MacroId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly description: string | null;
  readonly steps: readonly MacroStep[];
  readonly paramSchema: JsonObject | null;
  readonly sharedWithOrganization: boolean;
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a caller may do with a macro it can see. */
export type MacroAccess = "owner" | "shared";

/**
 * Whether a caller may READ this macro, and on what basis.
 *
 * The environment check comes first and is absolute: a macro belonging to
 * another environment is invisible even to the operator who wrote it, because
 * the scope is the containment boundary and authorship is not.
 */
export function macroAccessFor(
  macro: Macro,
  environmentId: EnvironmentId,
  actorId: ActorId | null,
): MacroAccess | null {
  if (macro.environmentId !== environmentId) return null;
  if (actorId !== null && macro.createdBy === actorId) return "owner";
  return macro.sharedWithOrganization ? "shared" : null;
}

/** Whether a caller may CHANGE this macro. Owner only, never shared. */
export function macroIsEditableBy(
  macro: Macro,
  environmentId: EnvironmentId,
  actorId: ActorId | null,
): boolean {
  return macroAccessFor(macro, environmentId, actorId) === "owner";
}

export interface MacroIntake {
  readonly name: string;
  readonly description?: string | null;
  readonly steps: readonly MacroStep[];
  readonly paramSchema?: JsonObject | null;
}

export interface AdmittedMacro {
  readonly name: string;
  readonly description: string | null;
  readonly steps: readonly MacroStep[];
  readonly paramSchema: JsonObject | null;
}

export function admitMacro(intake: MacroIntake, policy: AgentMacroPolicy): Result<AdmittedMacro> {
  const name = intake.name.trim();
  if (name === "") {
    return err(
      macroInvalid("name is required", [{ field: "name", code: "required", message: "name is required" }]),
    );
  }
  if (name.length > policy.maxNameLength) {
    return err(
      macroInvalid(`name must be at most ${policy.maxNameLength} characters`, [
        { field: "name", code: "too_long", message: "name is too long" },
      ]),
    );
  }
  if (intake.steps.length > policy.maxSteps) {
    return err(
      macroInvalid(`a macro may record at most ${policy.maxSteps} steps`, [
        { field: "steps", code: "too_long", message: `recorded ${intake.steps.length} steps` },
      ]),
    );
  }
  for (const [index, step] of intake.steps.entries()) {
    if (typeof step.tool !== "string" || step.tool.trim() === "") {
      return err(
        macroInvalid("every recorded step must name a tool", [
          { field: `steps[${index}].tool`, code: "required", message: "tool is required" },
        ]),
      );
    }
  }
  const description = intake.description?.trim();
  return ok({
    name,
    description: description === undefined || description === "" ? null : description,
    steps: [...intake.steps],
    paramSchema: intake.paramSchema ?? null,
  });
}

/** What changed on a macro, as an operator supplied it. */
export interface MacroPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly sharedWithOrganization?: boolean;
  readonly paramSchema?: JsonObject | null;
}

export function applyMacroPatch(macro: Macro, patch: MacroPatch, now: Date): Macro {
  return {
    ...macro,
    name: patch.name ?? macro.name,
    description: patch.description === undefined ? macro.description : patch.description,
    sharedWithOrganization: patch.sharedWithOrganization ?? macro.sharedWithOrganization,
    paramSchema: patch.paramSchema === undefined ? macro.paramSchema : patch.paramSchema,
    updatedAt: now,
  };
}

/** The listing order: most recently updated first, then by id descending. */
export function byMacroOrder(left: Macro, right: Macro): number {
  const byRecency = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (byRecency !== 0) return byRecency;
  if (left.macroId === right.macroId) return 0;
  return left.macroId > right.macroId ? -1 : 1;
}

const PLACEHOLDER = /\$\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}/gu;

/**
 * Read a dotted path out of a parameter object.
 *
 * A FLAT KEY WINS OVER A NESTED WALK, which is the source's rule and not an
 * accident: a caller may supply either `{"user.name": "x"}` or
 * `{user: {name: "x"}}`, and the flat form is checked first so a caller that
 * supplied both gets the one they wrote most explicitly. Numeric segments index
 * arrays; anything else on an array is undefined rather than a property lookup.
 */
export function readTemplatePath(context: unknown, key: string): unknown {
  if (context === null || context === undefined || typeof key !== "string" || key.length === 0) {
    return undefined;
  }
  if (typeof context === "object" && !Array.isArray(context)) {
    const flat = (context as Record<string, unknown>)[key];
    if (flat !== undefined) return flat;
  }
  return key.split(".").reduce<unknown>((held, segment) => {
    if (held === null || held === undefined || typeof held !== "object") return undefined;
    if (Array.isArray(held)) {
      const index = Number(segment);
      return Number.isInteger(index) && index >= 0 ? held[index] : undefined;
    }
    return (held as Record<string, unknown>)[segment];
  }, context);
}

/**
 * Substitute every `${var.path}` in a step's parameters.
 *
 * Walks nested objects and arrays; non-string leaves travel unchanged. A missing
 * path leaves its placeholder in place — see the note at the top.
 */
export function substitutePlaceholders(value: unknown, params: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (match, key: string) => {
      const resolved = readTemplatePath(params, key);
      if (resolved === undefined) return match;
      return typeof resolved === "string" ? resolved : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitutePlaceholders(entry, params));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substitutePlaceholders(entry, params);
    }
    return out;
  }
  return value;
}

/** One step, with its parameters resolved. What a replay hands to the router. */
export function resolveStep(step: MacroStep, params: JsonObject): MacroStep {
  return { tool: step.tool, params: substitutePlaceholders(step.params, params) as JsonObject };
}

/** Every step of a macro, resolved in recorded order. */
export function resolveSteps(macro: Macro, params: JsonObject): readonly MacroStep[] {
  return macro.steps.map((step) => resolveStep(step, params));
}
