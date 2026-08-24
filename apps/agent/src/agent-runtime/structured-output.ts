/**
 * Theme F.5 — Structured output enforcement.
 *
 * Agent config (per-agent default) or per-turn override can declare an
 * `outputSchema`. When present, the runtime switches from `streamText` to
 * Vercel AI SDK's `streamObject` / `generateObject`, validates the model's
 * response against the schema, and — on validation failure — retries once
 * with the Zod/JSON Schema error fed back as a correction prompt before
 * surfacing `StructuredOutputError` to the caller.
 *
 * The module is deliberately dependency-free aside from `ai`, `zod`, and
 * `@ai-sdk/ui-utils` (re-exported by `ai` as `jsonSchema`) so it can be
 * unit-tested in isolation. It has no Nest decorators — it's pure logic
 * consumed by `AgentService.stream` / `AgentService.run`.
 *
 * Scope isolation note (PLATOS_SPEC §3, §10 invariant 1): schemas flow
 * through this module unmodified. The caller (AgentTaskService /
 * AgentService) is the layer that enforces `(org, project, env)` —
 * this module never touches DB rows or global caches, so cross-scope
 * schema leakage is structurally impossible.
 */

import { z } from "zod";
import { jsonSchema, type Schema } from "ai";
import Ajv from "ajv";

const jsonSchemaValidator = new Ajv({ allErrors: true, strict: false });

/**
 * Error thrown when the LLM fails to produce valid output twice in a row
 * (initial call + one retry with error feedback). Carries the validation
 * errors from the final pass so the caller can surface them intact.
 *
 * Keep the name `StructuredOutputError` — the consumer SDK pattern-matches
 * on it (see THEME_F §4 + `@platosdev/client` error surface).
 */
export class StructuredOutputError extends Error {
  public readonly code = "structured_output_invalid" as const;
  public readonly retryCount: number;
  public readonly validationErrors: string[];
  public readonly rawText?: string;

  constructor(
    message: string,
    opts: {
      retryCount: number;
      validationErrors: string[];
      rawText?: string;
    },
  ) {
    super(message);
    this.name = "StructuredOutputError";
    this.retryCount = opts.retryCount;
    this.validationErrors = opts.validationErrors;
    this.rawText = opts.rawText;
  }
}

/**
 * A schema descriptor as stored on PlatosAgent.outputSchema /
 * PlatosAgentMessage.outputSchema. Three shapes are accepted:
 *
 * 1. Raw JSON Schema object — the common case (UI-authored).
 * 2. A Zod instance — internal code paths that already hold one.
 * 3. `null` / `undefined` — no enforcement, fall back to `streamText`.
 *
 * The DB stores JSON Schema; Zod-in-memory is only a programmatic
 * convenience for tests and programmatic callers.
 */
export type OutputSchemaInput =
  | null
  | undefined
  | z.ZodTypeAny
  | Record<string, unknown>;

/** The normalized form passed to Vercel AI SDK's `schema` option. */
export type NormalizedSchema = z.ZodTypeAny | Schema<unknown>;

/**
 * Normalize the persisted/requested schema descriptor into a form the
 * Vercel AI SDK can consume. Returns `null` when no enforcement is
 * requested (empty object also treated as "no schema" — a belt-and-braces
 * guard against UIs that send `{}` as a placeholder).
 *
 * JSON Schema inputs go through `ai`'s `jsonSchema` helper which wraps the
 * raw object in a `Schema<unknown>` (it validates via AJV internally and
 * feeds the provider in its preferred format — JSON mode vs tool-call
 * mode vs grammar — per the SDK's `mode: "auto"` decision).
 */
export function normalizeSchema(
  input: OutputSchemaInput,
): NormalizedSchema | null {
  if (input === null || input === undefined) return null;

  // Zod schemas — `_def` is the canonical "is this Zod" duck-type.
  if (typeof (input as any)?._def === "object" && (input as any)?._def !== null) {
    return input as z.ZodTypeAny;
  }

  // Plain object = JSON Schema. Treat `{}` as "not set" — empty schemas
  // match anything so enforcement is meaningless.
  if (typeof input === "object") {
    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length === 0) return null;
    const validateJson = jsonSchemaValidator.compile(input as any);
    return jsonSchema(input as any, {
      validate(value) {
        if (validateJson(value)) return { success: true, value };

        const error = new Error("JSON Schema validation failed") as Error & {
          errors?: typeof validateJson.errors;
        };
        error.errors = validateJson.errors;
        return { success: false, error };
      },
    });
  }

  // Anything else (strings etc.) — refuse rather than silently succeed.
  // Callers should catch and surface as an input validation error.
  throw new Error(
    `[structured-output] Unsupported outputSchema type: ${typeof input}. ` +
      `Expected JSON Schema object, Zod instance, or null.`,
  );
}

/**
 * Resolve which schema applies to THIS turn, honoring precedence:
 *   per-turn (PlatosAgentMessage.outputSchema) > agent default
 *     (PlatosAgent.outputSchema / AgentConfig.outputSchema).
 *
 * Returns `null` when no enforcement is requested at either level.
 */
export function resolveTurnSchema(args: {
  perTurn?: OutputSchemaInput;
  agentDefault?: OutputSchemaInput;
}): NormalizedSchema | null {
  const perTurn = normalizeSchema(args.perTurn);
  if (perTurn !== null) return perTurn;
  return normalizeSchema(args.agentDefault);
}

/**
 * Validate `obj` against `schema`, returning either a success result or a
 * structured list of validation errors. Works uniformly for both Zod and
 * Vercel AI SDK `Schema<unknown>` inputs — the SDK's `Schema` type exposes
 * `validate` returning `{ success: true, value } | { success: false, error }`.
 */
export function validateAgainstSchema(
  schema: NormalizedSchema,
  obj: unknown,
): { success: true; value: unknown } | { success: false; errors: string[] } {
  // Zod path.
  if (typeof (schema as any)?.safeParse === "function") {
    const result = (schema as z.ZodTypeAny).safeParse(obj);
    if (result.success) return { success: true, value: result.data };
    const errors = result.error.errors.map((e) => {
      const path = e.path.length > 0 ? e.path.join(".") : "<root>";
      return `${path}: ${e.message}`;
    });
    return { success: false, errors };
  }

  // AI-SDK Schema path — `validate` is `readonly validate?: …` in the
  // provider-utils Validator type, so guard on the function being present.
  const aiValidate = (schema as any)?.validate;
  if (typeof aiValidate === "function") {
    const result = aiValidate(obj) as
      | { success: true; value: unknown }
      | { success: false; error: Error };
    if (result.success) return { success: true, value: result.value };
    const err = result.error as any;
    const errors: string[] = [];
    if (err?.errors && Array.isArray(err.errors)) {
      // AJV-style: [{ instancePath, message, ... }]
      for (const e of err.errors) {
        errors.push(
          `${e.instancePath || "<root>"}: ${e.message ?? String(e)}`,
        );
      }
    } else {
      errors.push(err?.message ?? String(err));
    }
    return { success: false, errors };
  }

  // Unknown schema shape — conservative failure.
  return {
    success: false,
    errors: [
      "[structured-output] internal: schema has no safeParse() or validate() method",
    ],
  };
}

/**
 * Build the correction prompt used on retry. The LLM sees the prior raw
 * output plus the validation errors and is asked to produce a corrected
 * JSON object. Kept short so it doesn't blow the cache prefix.
 */
export function buildRetryCorrectionMessage(
  rawText: string | undefined,
  errors: string[],
): string {
  const errorList = errors
    .slice(0, 10) // cap so a wildly-invalid payload can't balloon the prompt
    .map((e, i) => `${i + 1}. ${e}`)
    .join("\n");
  return [
    "Your previous response did not match the required schema.",
    "",
    "Validation errors:",
    errorList,
    "",
    rawText
      ? `Your previous output (for context):\n<prior>\n${rawText.slice(0, 4000)}\n</prior>`
      : "Your previous output could not be parsed as JSON.",
    "",
    "Please respond again with a JSON object that strictly satisfies the schema.",
  ].join("\n");
}
