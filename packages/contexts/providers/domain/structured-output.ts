// The one message a schema-shaped generation adds when the model gets it wrong.
//
// WHAT IT IS. When a caller asks for `{ kind: "object" }` output and the model
// answers with something the schema rejects, the second pass carries the first
// answer and its validation errors back to the model as an ordinary user
// message. That is the whole of the retry: no new schema, no different model, no
// second prompt — one appended message and one more pass.
//
// WHY THE TWO CAPS ARE HERE AND NOT IN THE ADAPTER. They are the only part of
// this that costs money, and they are pure. The correction is APPENDED to the
// prompt, so every character of it is paid for as input on the retry pass; and
// because `prompt-cache.ts` puts the moving head marker on the NEWEST message,
// the correction also lands inside the cached prefix and is paid at the
// `cacheWrite` rate rather than being free. Uncapped, a wildly-invalid payload
// produces an error list and a prior output that are together larger than the
// answer they exist to correct, and the explanation costs more than the mistake.
//
// So the caps are a policy this layer states once, where a unit test can read
// them, rather than two magic numbers beside an SDK call where only an
// end-to-end test against a live provider could see them. The adapter keeps the
// half that genuinely needs a library: turning a schema and a value into the
// list of error STRINGS this function formats.
//
// THE NUMBERS ARE THE EXTRACTION SOURCE'S. Ten errors and four thousand
// characters, transcribed rather than re-derived, so a turn that used to fit
// still fits.

import { textPart, type PromptMessage } from "./prompt.js";

/**
 * How many validation errors the correction names.
 *
 * The first ten are the ones a model can act on; a payload that violates a
 * schema in eighty places is not going to be fixed by being told about all
 * eighty, and the tail is pure cost.
 */
export const MAX_CORRECTION_ERRORS = 10;

/** How much of the rejected output is quoted back, in characters. */
export const MAX_CORRECTION_RAW_TEXT = 4000;

/** What the correction says when the model produced nothing parseable at all. */
export const NO_PARSEABLE_OUTPUT = "Your previous output could not be parsed as JSON.";

/**
 * The correction message body.
 *
 * Separated from the message so a test can assert the caps against a string
 * rather than against a content array, and so the two caps have exactly one
 * application site each.
 */
export function structuredOutputCorrectionText(
  rawText: string | null,
  errors: readonly string[],
): string {
  const listed = errors
    .slice(0, MAX_CORRECTION_ERRORS)
    .map((error, index) => `${index + 1}. ${error}`)
    .join("\n");
  const prior =
    rawText === null || rawText === ""
      ? NO_PARSEABLE_OUTPUT
      : `Your previous output (for context):\n<prior>\n${rawText.slice(0, MAX_CORRECTION_RAW_TEXT)}\n</prior>`;
  return [
    "Your previous response did not match the required schema.",
    "",
    "Validation errors:",
    listed,
    "",
    prior,
    "",
    "Please respond again with a JSON object that strictly satisfies the schema.",
  ].join("\n");
}

/**
 * The correction, as a message ready to append to the prompt.
 *
 * It does NOT go through `promptMessage`, and that is deliberate rather than an
 * oversight: its content array always holds exactly one text part, so neither of
 * the two shapes that guard refuses — an empty content array, and a media part
 * with no media type — is reachable from here. Returning a `Result` would have
 * handed every caller a branch it could not take. A test pins the equivalence,
 * so the two cannot drift apart.
 *
 * `cacheBreakpoint` is false because placement is not this function's business:
 * `placeCacheBreakpoints` reassigns every non-system marker from scratch on the
 * next pass, and a marker set here would be overwritten anyway.
 */
export function structuredOutputCorrection(
  rawText: string | null,
  errors: readonly string[],
): PromptMessage {
  return {
    role: "user",
    content: Object.freeze([textPart(structuredOutputCorrectionText(rawText, errors))]),
    cacheBreakpoint: false,
  };
}
