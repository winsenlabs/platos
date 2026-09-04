// A tool DECLARATION — the complete set of tools one entity offers in one
// environment, as that entity states it.
//
// THE UNIT IS THE WHOLE SET, NOT A TOOL. `registerTools` replaces an entity's
// entire exposure for an environment: whatever is in the declaration is
// exposed, whatever is not is deleted. That is why a declaration is admitted as
// one value with one verdict rather than tool-by-tool — a partially-admitted
// declaration would leave the entity exposing a set it never claimed, which is
// worse than refusing the whole registration.
//
// ADMISSION IS TOTAL AND ORDER-INDEPENDENT. Names are trimmed before they are
// judged, duplicates are refused on the trimmed name, and the admitted set
// comes back sorted. Sorting is not cosmetic: `Tool` rows are upserted in this
// order inside one transaction, and two backends registering overlapping tool
// sets concurrently in a different order is a deadlock the store cannot see
// coming.

import { err, ok, type Result } from "@platos/kernel";

import { declarationInvalid, duplicateToolName } from "./errors.js";
import { asToolsIdentifier, type ExternalEntityId, type ToolName } from "./identifiers.js";
import { inferToolCategory, MAX_TOOL_DESCRIPTION_LENGTH, MAX_TOOL_NAME_LENGTH } from "./tool.js";

/** One tool as a backend states it, before anything has been checked. */
export interface ToolDeclarationIntake {
  readonly name: string;
  readonly description?: string;
  readonly paramSchema?: unknown;
  readonly category?: string;
}

/** One tool after admission: every field present, trimmed, and typed. */
export interface AdmittedTool {
  readonly name: ToolName;
  readonly description: string;
  readonly paramSchema: Readonly<Record<string, unknown>>;
  readonly category: string;
}

/**
 * Admit a whole declaration.
 *
 * The three coercions are transcribed from `normalizeDeclaration` and each one
 * is a real shape a live backend sends:
 *
 *   a missing or non-string description becomes `""`. A tool with no briefing
 *   is still a tool; refusing it would take a working integration offline over
 *   documentation.
 *
 *   a missing, null, or non-object `paramSchema` becomes `{}`. A zero-argument
 *   tool is the commonest tool there is, and several SDKs express it by
 *   omitting the field.
 *
 *   a blank category falls back to the inference in `domain/tool.ts`.
 *
 * A blank NAME is not coerced. It is the one field with no defensible default,
 * and it is the field the exposure matrix is keyed by.
 */
export function admitDeclaration(
  intake: readonly ToolDeclarationIntake[],
  externalEntityId: ExternalEntityId,
): Result<readonly AdmittedTool[]> {
  const byName = new Map<string, AdmittedTool>();

  for (const raw of intake) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name === "") {
      return err(
        declarationInvalid("every declared tool needs a name", [
          { field: "name", code: "required", message: "tool name is required" },
        ]),
      );
    }
    if (name.length > MAX_TOOL_NAME_LENGTH) {
      return err(
        declarationInvalid(`a tool name must be at most ${MAX_TOOL_NAME_LENGTH} characters`, [
          { field: "name", code: "too_long", message: "tool name is too long" },
        ]),
      );
    }
    if (byName.has(name)) return err(duplicateToolName(name));

    const description = typeof raw.description === "string" ? raw.description : "";
    if (description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
      return err(
        declarationInvalid(`a tool description must be at most ${MAX_TOOL_DESCRIPTION_LENGTH} characters`, [
          { field: "description", code: "too_long", message: "tool description is too long" },
        ]),
      );
    }

    const category = raw.category?.trim();
    byName.set(name, {
      name: asToolsIdentifier<ToolName>(name),
      description,
      paramSchema: admitParamSchema(raw.paramSchema),
      category: category === undefined || category === "" ? inferToolCategory(name, externalEntityId) : category,
    });
  }

  return ok(
    [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  );
}

/**
 * An array is NOT an object here.
 *
 * `typeof [] === "object"` is the footgun the source's `raw.paramSchema &&
 * typeof raw.paramSchema === "object"` walks straight into: an array reaches
 * `Tool.paramSchema`, whose column comment declares an object root, and every
 * later reader that asks it for `properties` gets `undefined` in silence.
 */
function admitParamSchema(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

/** The names a declaration claims, for the caller computing what to prune. */
export function declaredNames(declaration: readonly AdmittedTool[]): ReadonlySet<ToolName> {
  return new Set(declaration.map((tool) => tool.name));
}

/**
 * What a registration did, counted the way the source counts it.
 *
 * `updated` is deliberately "registered minus new" rather than a count of rows
 * that actually changed: a re-registration of an unchanged declaration reports
 * every tool as updated, because the exposure row's `callbackUrl` and `enabled`
 * are written unconditionally. Reporting it any other way would require reading
 * the previous exposure state back, which the transaction does not do.
 */
export interface RegistrationOutcome {
  readonly registered: number;
  readonly updated: number;
  readonly newTools: number;
  readonly removed: number;
}

export function registrationOutcome(input: {
  readonly registeredToolIds: readonly string[];
  readonly previousToolIds: ReadonlySet<string>;
  readonly previousNames: readonly ToolName[];
  readonly declared: ReadonlySet<ToolName>;
}): RegistrationOutcome {
  const distinct = new Set(input.registeredToolIds);
  const newTools = [...distinct].filter((toolId) => !input.previousToolIds.has(toolId)).length;
  return {
    registered: input.registeredToolIds.length,
    updated: input.registeredToolIds.length - newTools,
    newTools,
    removed: input.previousNames.filter((name) => !input.declared.has(name)).length,
  };
}
