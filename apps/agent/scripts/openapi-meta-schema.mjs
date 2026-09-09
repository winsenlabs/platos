// VALIDATING THE GENERATED DOCUMENT AGAINST AN AUTHORITY THIS REPOSITORY DOES
// NOT WRITE.
//
// WIN-267 W2. The control-plane generator now emits request and response
// schemas, and a generator that also decided whether its own output was
// well-formed would be the shape LESSON 1 names: an assertion comparing two
// things the same author controls cannot fail. So the shape check is delegated
// to the OpenAPI Specification's OWN meta-schema, published by the OpenAPI
// Initiative at
//
//   https://spec.openapis.org/oas/3.1/schema/2022-10-07
//
// and vendored byte-for-byte at `docs/openapi-3.1-meta-schema.json`. The bytes
// are pinned by digest below: a re-vendor, a reformat, or a hand-edit changes
// the digest and this module refuses to run. Vendoring rather than fetching is
// what makes the gate hermetic — CI has no network contract — and the digest is
// what keeps the vendored copy honest about being a copy.
//
// -----------------------------------------------------------------------------
// THE ONE ADAPTATION, AND WHY IT IS PROVABLY BEHAVIOUR-PRESERVING
//
// Ajv 8 does not resolve this document's `$dynamicRef` the way JSON Schema
// 2020-12 specifies. THIS WAS MEASURED, NOT ASSUMED: compiled unmodified, the
// meta-schema rejects a three-line, unquestionably valid OpenAPI 3.1 document
// (`parameters: [{ name, in, required, schema }]`) because `$dynamicRef: "#meta"`
// inside `$defs.parameter.properties.schema` resolves back to the PARAMETER
// definition instead of to `$defs.schema`. Every such error is the validator's,
// not the document's, and shipping a gate that fires on valid input is worse
// than shipping no gate.
//
// The adaptation is therefore the smallest one that removes the indirection:
// every `{"$dynamicRef": "#meta"}` becomes `{"$ref": "#/$defs/schema"}`, and the
// now-unreferenced `$dynamicAnchor` is dropped. That rewrite is equivalent for
// THIS document if and only if the document declares exactly one
// `$dynamicAnchor` named `meta`, at `/$defs/schema`, and names no other dynamic
// reference — because a dynamic reference resolves to the outermost matching
// anchor in the dynamic scope, and with exactly one anchor there is nothing else
// it could ever reach. `assertFlattenable` below CHECKS that precondition on the
// vendored bytes and throws when it does not hold, so a future re-vendor that
// adds a second anchor fails loudly instead of being silently mis-flattened.
//
// What survives the rewrite is every rule that matters: required keys, the
// `paths`/`components`/`info` object shapes, the parameter `oneOf`, response
// object structure, and `unevaluatedProperties: false` on each of them.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "../../..");

/** The vendored copy of the published OpenAPI 3.1 meta-schema. */
export const META_SCHEMA_PATH = join(repoDir, "docs", "openapi-3.1-meta-schema.json");

/** The document this repository claims to have vendored. */
export const META_SCHEMA_SOURCE_URL = "https://spec.openapis.org/oas/3.1/schema/2022-10-07";

/**
 * SHA-256 of the vendored bytes, as published.
 *
 * Reproduce with:
 *   curl -sS https://spec.openapis.org/oas/3.1/schema/2022-10-07 | shasum -a 256
 */
export const META_SCHEMA_SHA256 =
  "da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0";

/** The `$id` the published document carries. A second, independent pin. */
export const META_SCHEMA_ID = "https://spec.openapis.org/oas/3.1/schema/2022-10-07";

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The precondition that makes the `$dynamicRef` flattening safe. Throws with the
 * offending positions rather than returning false, because there is no useful
 * partial answer: either the rewrite is equivalent or the gate must not run.
 */
export function assertFlattenable(schema) {
  const anchors = [];
  const references = new Set();
  const walk = (node, pointer) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${pointer}/${String(index)}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$dynamicAnchor") anchors.push({ pointer, value });
      if (key === "$dynamicRef") references.add(value);
      walk(value, `${pointer}/${key}`);
    }
  };
  walk(schema, "");
  const unexpectedAnchors = anchors.filter(
    (anchor) => anchor.pointer !== "/$defs/schema" || anchor.value !== "meta",
  );
  const unexpectedReferences = [...references].filter((reference) => reference !== "#meta");
  if (anchors.length !== 1 || unexpectedAnchors.length > 0 || unexpectedReferences.length > 0) {
    throw new Error(
      `openapi meta-schema is no longer flattenable: anchors=${JSON.stringify(anchors)} refs=${JSON.stringify([...references])}`,
    );
  }
  return true;
}

/** The vendored schema with the single dynamic indirection made static. */
export function flattenDynamicRefs(schema) {
  const rewritten = JSON.stringify(schema)
    .replaceAll('"$dynamicRef":"#meta"', '"$ref":"#/$defs/schema"')
    .replaceAll('"$dynamicAnchor":"meta",', "");
  return JSON.parse(rewritten);
}

/**
 * Read the vendored meta-schema, refusing bytes that are not the pinned ones.
 *
 * `allowDigest` exists for the suite that proves this refusal fires; production
 * callers pass nothing and get the pin.
 */
export function loadMetaSchema({ path = META_SCHEMA_PATH, expectedDigest = META_SCHEMA_SHA256 } = {}) {
  const bytes = readFileSync(path);
  const digest = digestOf(bytes);
  if (digest !== expectedDigest) {
    throw new Error(
      `vendored OpenAPI meta-schema digest mismatch: expected ${expectedDigest}, read ${digest}. ` +
        `Re-vendor from ${META_SCHEMA_SOURCE_URL} and update META_SCHEMA_SHA256 deliberately.`,
    );
  }
  const schema = JSON.parse(bytes.toString("utf8"));
  if (schema.$id !== META_SCHEMA_ID) {
    throw new Error(`vendored meta-schema $id is ${String(schema.$id)}, expected ${META_SCHEMA_ID}`);
  }
  assertFlattenable(schema);
  return schema;
}

let compiled = null;

/** The compiled validator, built once per process. */
export function openApiValidator(options = {}) {
  if (compiled !== null && Object.keys(options).length === 0) return compiled;
  const schema = flattenDynamicRefs(loadMetaSchema(options));
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  const validator = ajv.compile(schema);
  if (Object.keys(options).length === 0) compiled = validator;
  return validator;
}

/**
 * Validate one document.
 *
 * Returns `{ valid, errors }` rather than throwing so a caller can name the
 * artifact in its own message; `errors` is the Ajv error list, already trimmed
 * to the first twenty because a structurally wrong document produces hundreds
 * and the first few are the ones that locate it.
 */
export function validateOpenApiDocument(document) {
  const validate = openApiValidator();
  const valid = validate(document);
  return {
    valid,
    errors: valid ? [] : (validate.errors ?? []).slice(0, 20),
  };
}
