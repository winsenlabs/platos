// Turns that must answer in a shape, and the retry that gives them one chance.
//
// THE SHAPE IS A JSON SCHEMA DOCUMENT AND NOTHING ELSE. The source accepts a Zod
// instance, a JSON Schema object, `null`, `undefined` and `{}` — five inputs,
// three of which mean "no schema" — and duck-types Zod by looking for a `_def`
// property. A context whose `domain/` may import only the kernel cannot hold a
// validator library at all, so the shape here is `providers`' own
// `JsonSchemaDocument`: a plain record. The VALIDATION is `providers`' business,
// behind `OutputMode`, which is where the one compiler lives.
//
// `{}` MEANS "NO SCHEMA", AND IT IS SAID SO RATHER THAN INFERRED. The source
// treats an empty object as unset with a comment; here it is a named predicate,
// because "the operator saved an empty schema" and "the operator saved no
// schema" arriving at the same place is a decision and not an accident.
//
// PER-TURN BEATS THE AGENT'S DEFAULT. Also the source's rule, kept.
//
// TWO PASSES, AND THE SECOND ONE IS TOLD WHAT WAS WRONG. A model that answered
// out of shape is usually able to fix it when shown the errors, so the retry
// carries a correction message rather than being a bare repeat. That is what
// `buildCorrection` is, and the two caps in it are the source's: at most ten
// errors and at most four thousand characters of the offending text, because an
// unbounded correction message makes the retry more expensive than the turn.
//
// THE PASS COUNT IS A CEILING, NOT A CONVENTION. `maxPasses` reaches
// `providers`' `OutputMode`, and a turn that exhausts it is refused with
// `CONVERSATIONS_OUTPUT_UNPARSABLE` — an `unavailable`, because the model may
// well answer correctly next time and the caller should retry rather than fix
// its request.

import { err, ok, type Result } from "@platos/kernel";

import { outputSchemaInvalid } from "./errors.js";

/** A JSON Schema document, structurally: `providers` compiles it, not this. */
export type OutputSchema = Readonly<Record<string, unknown>>;

/** The source's rule, named: an empty object is not a schema. */
export function isEmptySchema(schema: OutputSchema): boolean {
  return Object.keys(schema).length === 0;
}

/**
 * Admit a schema, or refuse it.
 *
 * The refusals are the two a plain record can be wrong in: not an object at all,
 * and an array — which is a valid JSON value and never a valid schema document.
 * Everything beyond that is `providers`' compiler's to say, and duplicating a
 * validator here would put a second opinion about schema validity in the tree.
 */
export function admitOutputSchema(schema: unknown): Result<OutputSchema | null> {
  if (schema === null || schema === undefined) return ok(null);
  if (typeof schema !== "object" || Array.isArray(schema)) {
    return err(outputSchemaInvalid("an output schema must be a JSON Schema object"));
  }
  const document = schema as OutputSchema;
  return ok(isEmptySchema(document) ? null : document);
}

/** Per-turn beats the agent's default; either may be absent. */
export function resolveTurnSchema(
  perTurn: OutputSchema | null,
  agentDefault: OutputSchema | null,
): OutputSchema | null {
  if (perTurn !== null && !isEmptySchema(perTurn)) return perTurn;
  if (agentDefault !== null && !isEmptySchema(agentDefault)) return agentDefault;
  return null;
}

/** How many passes a schema-shaped turn gets. Two: the answer, and one repair. */
export const OUTPUT_PASSES = 2;

const MAX_REPORTED_ERRORS = 10;
const MAX_REPORTED_TEXT = 4_000;

/**
 * The message the second pass is given.
 *
 * Both caps are the source's, and both are load-bearing rather than tidy: a
 * model that produced a megabyte of malformed JSON would otherwise have the
 * whole megabyte quoted back at it, at full input price, on the retry.
 */
export function buildCorrection(rawText: string, errors: readonly string[]): string {
  const reported = errors.slice(0, MAX_REPORTED_ERRORS);
  const omitted = errors.length - reported.length;
  const tail = omitted > 0 ? `\n(and ${omitted} more)` : "";
  const text = rawText.length > MAX_REPORTED_TEXT ? rawText.slice(0, MAX_REPORTED_TEXT) : rawText;
  return [
    "The previous answer did not match the required schema.",
    `Errors:\n${reported.map((line) => `- ${line}`).join("\n")}${tail}`,
    `What was answered:\n${text}`,
    "Answer again, matching the schema exactly.",
  ].join("\n\n");
}
