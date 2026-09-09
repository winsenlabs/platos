// PROVING THE OPENAPI SCHEMAS ARE READ OFF THE TYPES, AND THAT THE DOCUMENT IS
// JUDGED BY SOMETHING THIS REPOSITORY DID NOT WRITE.
//
// WIN-267 W2. Two claims are worth a suite here, and neither is provable by
// reading the generator:
//
//   1. THE JOIN IS REAL. Every case that matters mutates the ACTUAL controller
//      or DTO file in memory and re-derives, so a derivation that had quietly
//      become a hand-written table would fail. A suite that fed the deriver its
//      own fixtures would prove only that the deriver can read fixtures.
//
//   2. THE AUTHORITY IS EXTERNAL. The vendored OpenAPI 3.1 meta-schema is pinned
//      by digest to the bytes the OpenAPI Initiative publishes, its single
//      `$dynamicRef` flattening is proved behaviour-preserving by precondition,
//      and the compiled validator is proved NON-VACUOUS — it still rejects a
//      document that is wrong.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveRestContract,
  DerivationError,
  HTTP_STATUS_FALLBACK,
  UNDERIVABLE_QUERY_HANDLERS,
} from "../apps/agent/scripts/rest-schema-derivation.mjs";
import {
  META_SCHEMA_ID,
  META_SCHEMA_PATH,
  META_SCHEMA_SHA256,
  assertFlattenable,
  loadMetaSchema,
  openApiValidator,
  validateOpenApiDocument,
} from "../apps/agent/scripts/openapi-meta-schema.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(repositoryRoot, "apps/core-api/src/transports/rest/resources.ts");
const ERROR_STATUS = join(repositoryRoot, "apps/core-api/src/transports/error-status.ts");
const DOCUMENT = JSON.parse(
  readFileSync(join(repositoryRoot, "apps/agent/src/openapi/openapi.generated.json"), "utf8"),
);
const MANIFEST = JSON.parse(
  readFileSync(join(repositoryRoot, "apps/agent/src/control-plane/operation-manifest.generated.json"), "utf8"),
);

const source = (path) => readFileSync(path, "utf8");
const derive = (overrides = new Map()) => deriveRestContract({ repoDir: repositoryRoot, overrides });

test("every core-api REST operation in the manifest reaches a derived schema", () => {
  // WIN-268 (M4.2) P1 — THE CORE-API IMPLEMENTATION, NOT THE FIRST ONE.
  //
  // Until this tranche every operation had exactly one handler, so
  // `implementations[0]` was the only one and the two readings agreed by
  // accident. The two MCP token mints are the first operations served by BOTH
  // deployables — `apps/agent` since before V1, `apps/core-api` now that the
  // `Idempotency-Key` gate has handlers behind the templates it binds — and the
  // agent's implementation is registered first. Filtering on `[0]` would have
  // silently dropped exactly the two operations whose schemas this ratchet is
  // newly proving.
  //
  // The rule is the generator's own: `buildOpenApi` describes the core-api
  // implementation when one exists, because the V1 document describes the V1
  // deployable and only that handler's types can be derived.
  const coreApiImplementation = (operation) =>
    operation.implementations.find((implementation) =>
      implementation.source.startsWith("apps/core-api/"),
    );
  const manifestHandlers = MANIFEST.inventories.restOperations
    .map((operation) => coreApiImplementation(operation))
    .filter((implementation) => implementation !== undefined)
    .map((implementation) => `${implementation.controller}.${implementation.handler}`)
    .sort();
  assert.ok(manifestHandlers.length > 0, "the manifest carries no core-api operations");
  assert.deepEqual([...derive().handlers.keys()].sort(), manifestHandlers);
});

test("the derived document declares a schema for every core-api operation and none for the rest", () => {
  const coverage = DOCUMENT["x-platos-schema-coverage"];
  const derived = [];
  const undeclared = [];
  for (const [path, item] of Object.entries(DOCUMENT.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const label = `${method.toUpperCase()} ${path}`;
      if (operation["x-platos-schema-source"] === "typescript-dto") derived.push(label);
      else {
        assert.equal(operation["x-platos-schema-source"], "undeclared", `${label} carries no schema marker`);
        assert.ok(
          typeof operation["x-platos-schema-undeclared-reason"] === "string",
          `${label} is undeclared without saying why`,
        );
        undeclared.push(label);
      }
    }
  }
  assert.equal(derived.length, coverage.derivedOperations);
  assert.equal(undeclared.length, coverage.undeclaredOperations);
  assert.equal(derived.length, derive().handlers.size);
});

test("no derived operation publishes a permissive empty schema", () => {
  const offenders = [];
  const walk = (node, pointer) => {
    if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${pointer}/${String(index)}`));
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "schema" && typeof value === "object" && value !== null && Object.keys(value).length === 0) {
        offenders.push(pointer);
      }
      walk(value, `${pointer}/${key}`);
    }
  };
  walk(DOCUMENT.paths, "paths");
  walk(DOCUMENT.components.schemas, "components/schemas");
  assert.deepEqual(offenders, []);
});

test("deleting a property from a wire DTO removes it from the derived schema", () => {
  const before = derive().components.OperatorSessionResource;
  assert.ok("email" in before.properties, "the fixture assumes OperatorSessionResource declares email");
  const mutated = source(RESOURCES).replace("  readonly email: string;\n", "");
  assert.notEqual(mutated, source(RESOURCES), "the mutation did not apply");
  const after = derive(new Map([[RESOURCES, mutated]])).components.OperatorSessionResource;
  assert.ok(!("email" in after.properties), "the derivation kept a property the source no longer declares");
  assert.ok(!after.required.includes("email"));
});

test("adding a property to a wire DTO adds it to the derived schema", () => {
  const mutated = source(RESOURCES).replace(
    "  readonly email: string;",
    "  readonly email: string;\n  readonly nickname?: string;",
  );
  const after = derive(new Map([[RESOURCES, mutated]])).components.OperatorSessionResource;
  assert.deepEqual(after.properties.nickname, { type: "string" });
  assert.ok(!after.required.includes("nickname"), "an optional property must not be required");
});

test("an unconvertible property stops derivation instead of emitting an empty schema", () => {
  for (const replacement of [
    "  readonly email: unknown;",
    "  readonly email: Date;",
    "  readonly email: (value: string) => string;",
    "  readonly email: Record<string, string>;",
  ]) {
    const mutated = source(RESOURCES).replace("  readonly email: string;", replacement);
    assert.throws(
      () => derive(new Map([[RESOURCES, mutated]])),
      DerivationError,
      `${replacement} was converted instead of refused`,
    );
  }
});

test("the failure envelope publishes exactly the fields WireError declares, and never `details`", () => {
  const wireError = derive().components.WireError;
  const declared = [...source(ERROR_STATUS).matchAll(/^\s+readonly (\w+)\??:/gm)]
    .map((match) => match[1]);
  assert.ok(declared.includes("code") && declared.includes("traceRef"), "WireError parse found nothing");
  assert.ok(!("details" in wireError.properties), "`details` reached the wire contract");
  for (const property of Object.keys(wireError.properties)) {
    assert.ok(declared.includes(property), `${property} is published but not declared on WireError`);
  }
});

test("the published error codes are the canonical taxonomy, not a list this generator keeps", () => {
  const taxonomy = JSON.parse(readFileSync(join(repositoryRoot, "docs/error-taxonomy.json"), "utf8"));
  const expected = Object.keys(taxonomy.codes).sort();
  assert.deepEqual(DOCUMENT.components.schemas.WireError.properties.code.enum, expected);
  assert.equal(DOCUMENT["x-platos-schema-coverage"].canonicalErrorCodes, expected.length);
});

test("a route whose query string cannot be derived is declared, with a reason", () => {
  const declared = Object.keys(UNDERIVABLE_QUERY_HANDLERS).sort();
  const reported = DOCUMENT["x-platos-schema-coverage"].queryParametersNotDerived
    .map((entry) => entry.handler)
    .sort();
  assert.deepEqual(reported, declared);
  for (const [key, entry] of Object.entries(UNDERIVABLE_QUERY_HANDLERS)) {
    assert.ok(entry.detail.length > 80, `${key} is declared without an explanation`);
  }
  const derived = derive();
  for (const [key, handler] of derived.handlers) {
    if (declared.includes(key)) assert.equal(handler.queryParameters.source, "not-derived");
    else assert.notEqual(handler.queryParameters.source, "not-derived");
  }
});

test("HTTP_STATUS_FALLBACK agrees with the HttpStatus enum @nestjs/common ships", (t) => {
  let HttpStatus = null;
  try {
    const require = createRequire(join(repositoryRoot, "apps/core-api/package.json"));
    ({ HttpStatus } = require("@nestjs/common"));
  } catch {
    // SKIPPED, AND NAMED. The fallback map only matters when the derivation
    // program cannot resolve @nestjs/common; the join that proves it right needs
    // the package installed. A checkout with no install cannot make this claim,
    // and pretending otherwise would be worse than skipping.
    t.skip("@nestjs/common is not installed in this checkout");
    return;
  }
  for (const [name, status] of Object.entries(HTTP_STATUS_FALLBACK)) {
    assert.equal(HttpStatus[name], status, `HttpStatus.${name} is not ${String(status)}`);
  }
});

test("the generated document validates against the vendored OpenAPI 3.1 meta-schema", () => {
  const result = validateOpenApiDocument(DOCUMENT);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the vendored meta-schema is the bytes the OpenAPI Initiative publishes", () => {
  const schema = loadMetaSchema();
  assert.equal(schema.$id, META_SCHEMA_ID);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(assertFlattenable(schema), true);
});

test("a tampered vendored meta-schema is refused rather than compiled", () => {
  const directory = mkdtempSync(join(tmpdir(), "oas-meta-"));
  const tampered = join(directory, "meta.json");
  const schema = JSON.parse(readFileSync(META_SCHEMA_PATH, "utf8"));
  delete schema.properties.paths;
  writeFileSync(tampered, `${JSON.stringify(schema, null, 2)}\n`);
  assert.throws(
    () => loadMetaSchema({ path: tampered, expectedDigest: META_SCHEMA_SHA256 }),
    /digest mismatch/,
  );
});

test("the flattening precondition fails loudly on a second dynamic anchor", () => {
  const schema = JSON.parse(readFileSync(META_SCHEMA_PATH, "utf8"));
  schema.$defs.info.$dynamicAnchor = "meta";
  assert.throws(() => assertFlattenable(schema), /no longer flattenable/);
});

test("the compiled meta-schema validator is not vacuous", () => {
  const validate = openApiValidator();
  assert.equal(validate({ openapi: "3.1.0" }), false, "a document with no paths was accepted");
  assert.equal(
    validate({ openapi: "3.1.0", info: { title: "t" }, paths: {} }),
    false,
    "an info object with no version was accepted",
  );
  assert.equal(
    validate({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/x": { get: { responses: { 200: { description: "ok" } }, parameters: [{ name: "q", in: "nowhere", schema: { type: "string" } }] } } },
    }),
    false,
    "a parameter with an invalid `in` was accepted",
  );
  assert.equal(
    validate({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/x/{id}": { get: { responses: { 200: { description: "ok" } }, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } } },
    }),
    true,
    "a valid OpenAPI 3.1 document was rejected; the validator would fire on correct input",
  );
});
