// Schema-shaped output: enforcing the schema, and the one bounded correction.
//
// TWO VALIDATIONS, ONE VALIDATOR. The compiled schema is handed to the framework
// AND run again on whatever the framework returns. That is not belt and braces
// for its own sake: which enforcement a provider actually applies varies by
// mode — a JSON mode, a single-tool-call mode, a grammar — and more than one
// provider has been observed to answer with output the framework accepted and
// the schema does not. Running the same compiled validator on the result closes
// that gap without a second definition of "valid".
//
// THE VALIDATOR IS REQUEST-LOCAL, AND THAT IS A TENANCY PROPERTY. A shared
// instance registers caller-supplied `$id` values GLOBALLY, so one tenant's
// schema can make a later turn belonging to somebody else fail at compile time
// with a duplicate-id error naming a schema that caller has never seen. One
// instance per compile costs a few milliseconds and makes that impossible.
//
// THE CORRECTION IS THE DOMAIN'S. `structuredOutputCorrection` builds it, with
// the two caps that keep it from costing more than the answer it is correcting.
// What is here is the half that needs a library: turning a schema and a value
// into the list of error STRINGS that function formats.

import {
  err,
  ok,
  outputSchemaInvalid,
  structuredOutputCorrection,
  structuredOutputInvalid,
  type DomainError,
  type JsonSchemaDocument,
  type Prompt,
  type Result,
} from "@platos/context-providers/application/ports/index.js";
import { jsonSchema, type Schema } from "ai";
import Ajv, { type ErrorObject } from "ajv";

/** What a validation says. Errors are strings because that is what the model reads. */
export type ValidationOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface OutputValidator {
  /** The schema as the framework consumes it, with validation already wired in. */
  readonly schema: Schema<unknown>;
  readonly check: (value: unknown) => ValidationOutcome;
}

/** `/a/0/b: must be string`, or `<root>: ...` for a failure at the top. */
function describeError(error: ErrorObject): string {
  const where = error.instancePath === "" ? "<root>" : error.instancePath;
  return `${where}: ${error.message ?? error.keyword}`;
}

/**
 * Compile a caller's schema, or refuse it.
 *
 * A schema that will not compile is a defect in the REQUEST and no retry will
 * ever fix it, which is why it comes back as `PROVIDERS_OUTPUT_SCHEMA_INVALID`
 * and not as `PROVIDERS_STRUCTURED_OUTPUT_INVALID`. Sharing one code would have
 * sent an operator hunting a model for a defect in the caller.
 */
export function compileOutputSchema(document: JsonSchemaDocument): Result<OutputValidator> {
  let validate: ReturnType<Ajv["compile"]>;
  try {
    validate = new Ajv({ allErrors: true, strict: false }).compile(document as object);
  } catch (thrown) {
    return err(outputSchemaInvalid(thrown instanceof Error ? thrown.message : String(thrown)));
  }

  const check = (value: unknown): ValidationOutcome => {
    if (validate(value) === true) return { ok: true, value };
    const errors = (validate.errors ?? []).map(describeError);
    return { ok: false, errors: errors.length > 0 ? errors : ["<root>: does not match the schema"] };
  };

  const schema = jsonSchema(document as Parameters<typeof jsonSchema>[0], {
    validate(value: unknown) {
      const outcome = check(value);
      if (outcome.ok) return { success: true as const, value: outcome.value };
      return { success: false as const, error: new Error(outcome.errors.join("; ")) };
    },
  });

  return ok({ schema, check });
}

/** What one pass produced, whether or not it satisfied the schema. */
export interface PassOutcome {
  /** The object the framework parsed, or null when it could not parse one. */
  readonly object: unknown;
  /** The raw text, for quoting back. Empty when the provider sent none. */
  readonly rawText: string;
}

/**
 * Run one pass. Returning an error ENDS the loop — it is a failure that another
 * pass cannot fix, such as an abort or an outage. A pass that merely produced
 * the wrong shape returns `ok` with an unparseable object and is corrected.
 */
export type RunPass = (prompt: Prompt, passNumber: number) => Promise<Result<PassOutcome>>;

export interface StructuredOutcome {
  readonly object: unknown;
  readonly text: string;
  /** How many corrections were sent. Zero when the first pass satisfied it. */
  readonly corrections: number;
}

/**
 * The pass loop.
 *
 * Shared by the streaming and non-streaming entry points so the two cannot
 * drift into two different ideas of how many chances a model gets — which is
 * exactly the kind of divergence that shows up as an unexplained cost
 * difference between two code paths that were supposed to be the same one.
 *
 * The correction is appended to the prompt and the prompt is then rewritten, so
 * the cache breakpoints move onto the message that was just added. Skipping the
 * rewrite would leave the head marker on the message before it, and the
 * correction pass would re-pay full price for the whole history.
 */
export async function runObjectPasses(
  source: Prompt,
  validator: OutputValidator,
  maxPasses: number,
  rewritePrompt: (prompt: Prompt) => Prompt,
  runPass: RunPass,
): Promise<Result<StructuredOutcome>> {
  let prompt = source;
  let errors: readonly string[] = [];
  let rawText: string | null = null;

  for (let passNumber = 1; passNumber <= maxPasses; passNumber += 1) {
    const outcome = await runPass(prompt, passNumber);
    if (!outcome.ok) return err(outcome.error);

    rawText = outcome.value.rawText === "" ? rawText : outcome.value.rawText;
    if (outcome.value.object === undefined) {
      errors = ["<root>: the model produced no output the schema could be applied to"];
    } else {
      const checked = validator.check(outcome.value.object);
      if (checked.ok) {
        return ok({
          object: checked.value,
          text: outcome.value.rawText,
          corrections: passNumber - 1,
        });
      }
      errors = checked.errors;
    }

    if (passNumber >= maxPasses) break;
    prompt = rewritePrompt({
      messages: [...prompt.messages, structuredOutputCorrection(rawText, errors)],
    });
  }

  return err(structuredOutputFailure(errors, maxPasses));
}

function structuredOutputFailure(errors: readonly string[], passes: number): DomainError {
  return structuredOutputInvalid(errors.join("; "), passes);
}
