/**
 * MCPF-followup — minimal in-house JSON Schema validator for MCP tool inputs.
 *
 * Why in-house, not Ajv: ajv 8.x is already in the pnpm cache (transitive via
 * @nestjs/cli's lefthook chain) but is not a direct dep of `apps/agent`.
 * Adding it would force a `pnpm install` on the VPS deploy path. The set of
 * JSON Schema features we use across `apps/agent/src/mcp-platform/tools/`
 * is small and stable — supporting them in ~120 lines is cheaper than
 * pinning a new transitive dep.
 *
 * Supported features (matching what the tool builders actually emit):
 *   - type: "string" | "integer" | "number" | "boolean" | "object" | "array" | "null"
 *   - type: ["string", "null"]                  (nullable scalar)
 *   - required: string[]
 *   - properties: { [k]: schema }
 *   - additionalProperties: false               (rejects unknown keys)
 *   - additionalProperties: true | undefined    (passes through; default JSON Schema)
 *   - enum: unknown[]
 *   - minLength / maxLength                     (strings)
 *   - minimum / maximum                          (numbers)
 *   - items / minItems / maxItems                (arrays)
 *   - oneOf                                      (used by nullable object inputs)
 *   - format: email | date-time                  (the emitted string formats)
 *
 * NOT supported (we never emit them in our tool schemas):
 *   - $ref / definitions / allOf / anyOf / not / patternProperties
 *   - pattern (use a service-level check if needed)
 *   - dependencies / if/then/else
 *
 * If a future tool needs one of those, add it here — keep the validator
 * close to the actual schema vocabulary we use. The router fails open
 * with `INVALID_PARAMS` for any genuinely malformed input.
 */

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

type AnyObj = Record<string, any>;

function typeOfValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v) && typeof v === "number") return "integer";
  return typeof v;
}

function typeMatches(want: string | string[], v: unknown): boolean {
  const got = typeOfValue(v);
  if (Array.isArray(want)) {
    return want.some((t) => typeMatches(t, v));
  }
  if (want === "number") {
    // JSON Schema "number" matches both float and integer.
    return got === "number" || got === "integer";
  }
  if (want === "integer") {
    return got === "integer";
  }
  return want === got;
}

function validateNode(
  schema: AnyObj | undefined,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!schema || typeof schema !== "object") return;

  // oneOf — exactly one branch must accept the value. Branch findings stay
  // private; callers only need the stable aggregate failure at this path.
  if (Array.isArray(schema["oneOf"])) {
    let matches = 0;
    for (const branch of schema["oneOf"] as AnyObj[]) {
      const branchErrors: ValidationError[] = [];
      validateNode(branch, value, path, branchErrors);
      if (branchErrors.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push({
        path: path || "(root)",
        message: `value must match exactly one oneOf branch (matched ${matches})`,
      });
      return;
    }
  }

  // type
  if (schema["type"] !== undefined) {
    if (!typeMatches(schema["type"], value)) {
      errors.push({
        path: path || "(root)",
        message: `expected type ${JSON.stringify(schema["type"])} but got ${typeOfValue(value)}`,
      });
      // Keep walking siblings — additional findings help the caller.
      return;
    }
  }

  // enum
  if (Array.isArray(schema["enum"])) {
    const enumVals = schema["enum"] as unknown[];
    const ok = enumVals.some((e) => deepEqual(e, value));
    if (!ok) {
      errors.push({
        path: path || "(root)",
        message: `value must be one of ${JSON.stringify(enumVals)}`,
      });
    }
  }

  // string facets
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      errors.push({ path: path || "(root)", message: `string length < minLength ${schema["minLength"]}` });
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      errors.push({ path: path || "(root)", message: `string length > maxLength ${schema["maxLength"]}` });
    }
    if (schema["format"] === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors.push({ path: path || "(root)", message: "string must be a valid email" });
    }
    if (
      schema["format"] === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    ) {
      errors.push({ path: path || "(root)", message: "string must be a valid date-time" });
    }
  }

  // numeric facets
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      errors.push({ path: path || "(root)", message: `value < minimum ${schema["minimum"]}` });
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      errors.push({ path: path || "(root)", message: `value > maximum ${schema["maximum"]}` });
    }
  }

  // arrays
  if (Array.isArray(value) && schema["items"]) {
    for (let i = 0; i < value.length; i++) {
      validateNode(schema["items"] as AnyObj, value[i], `${path}[${i}]`, errors);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
      errors.push({ path: path || "(root)", message: `array length < minItems ${schema["minItems"]}` });
    }
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
      errors.push({ path: path || "(root)", message: `array length > maxItems ${schema["maxItems"]}` });
    }
  }

  // objects
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (schema["type"] === undefined || schema["type"] === "object")
  ) {
    const obj = value as AnyObj;
    const properties = (schema["properties"] || {}) as AnyObj;
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    const additionalProperties = schema["additionalProperties"];

    // required keys
    for (const k of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === undefined) {
        errors.push({
          path: path ? `${path}.${k}` : k,
          message: `required property '${k}' is missing`,
        });
      }
    }

    // unknown keys (additionalProperties: false)
    if (additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, k)) {
          errors.push({
            path: path ? `${path}.${k}` : k,
            message: `unknown property '${k}' (additionalProperties: false)`,
          });
        }
      }
    }

    // recurse into known keys
    for (const k of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
        validateNode(properties[k], obj[k], path ? `${path}.${k}` : k, errors);
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as AnyObj);
    const bk = Object.keys(b as AnyObj);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!deepEqual((a as AnyObj)[k], (b as AnyObj)[k])) return false;
    return true;
  }
  return false;
}

/**
 * Compile a JSON Schema into a fast-path validator function. The "compile"
 * step today just captures a closure over the schema; if profiling shows
 * dispatch cost we can swap to a code-gen approach later.
 */
export function compileSchema(schema: Record<string, unknown> | undefined) {
  return (input: unknown): ValidationResult => {
    if (!schema) return { valid: true, errors: [] };
    const errors: ValidationError[] = [];
    validateNode(schema as AnyObj, input === undefined ? {} : input, "", errors);
    return { valid: errors.length === 0, errors };
  };
}

export type CompiledValidator = ReturnType<typeof compileSchema>;
