#!/usr/bin/env node

// THE V1 SDK SURFACE, GENERATED FROM THE CONTRACT AND NOT FROM MEMORY.
//
// WIN-270 (M4.4). Every SDK in this repository was hand-written against the
// frozen `apps/agent` surface: `packages/platos-client/src/apis/*.ts` names its
// paths as string literals, `platos_client/apis/*.py` names them again in
// another language, and nothing joins either list to the server. That is two
// parallel sources of truth beside the real one, and this programme has already
// withdrawn five stale claims that existed for exactly that reason.
//
// WIN-267 W2 removed the excuse. `apps/agent/src/openapi/openapi.generated.json`
// now carries REQUEST AND RESPONSE SCHEMAS for the V1 core-api operations,
// derived from the TypeScript type checker by
// `apps/agent/scripts/rest-schema-derivation.mjs` and ratcheted against breaking
// change by `scripts/openapi-compat.mjs`. So the V1 half of the SDK is not
// written here. It is EMITTED, in both languages, from that document.
//
// -----------------------------------------------------------------------------
// THE FOUR INPUTS, NONE OF WHICH THIS FILE CONTROLS
//
//   apps/agent/src/openapi/openapi.generated.json
//       the wire schemas, derived from the core-api handler types.
//   apps/agent/src/control-plane/operation-manifest.generated.json
//       the route TEMPLATE (`:param` form) of every operation. Read rather than
//       recomputed from the OpenAPI path, because two computations of one path
//       are two answers that can disagree — and because the template is the key
//       the idempotency table is stated in.
//   apps/core-api/src/http/idempotency-policy.ts
//       `OPERATION_POLICIES` and `SIDE_EFFECTING_METHODS`, read off the AST.
//       Which operations REQUIRE an `Idempotency-Key` is a decision that file
//       owns; restating it in a generator would be a fourth copy of a rule this
//       repository has exactly one of.
//   apps/core-api/src/http/idempotency-errors.ts
//       `IDEMPOTENCY_KEY_HEADER`, so the emitted clients spell the header the
//       way the middleware reads it rather than the way a doc comment does.
//
// A DTO edit, a policy row, or a renamed header therefore moves the emitted
// files, and `--check` fails until somebody regenerates. That is the whole
// claim: a generated client cannot drift, because the only way to change it is
// to change something upstream of it.
//
// -----------------------------------------------------------------------------
// WHY BOTH LANGUAGES COME OUT OF ONE PASS
//
// The acceptance criteria ask for cross-language fixtures. Fixtures that each
// language wrote for itself prove nothing; these are emitted ONCE, from the
// contract, into `tests/sdk-contract/v1-fixtures.json`, and the TypeScript and
// Python suites each drive their own generated client and compare the REQUEST
// IT PRODUCES against them. Two clients that disagree cannot both match.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT EMITTED
//
// Only operations the document marks `x-platos-schema-source: typescript-dto`.
// The other 298 declare no wire DTO — the document says so itself — and a
// generated method with a `Record<string, unknown>` body would be a client that
// looks typed and is not. The hand-written `apps/agent` namespaces keep serving
// those, unchanged, and `packages/platos-client/tests/generated-contracts.test.ts`
// keeps joining them to the manifest.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..", "..");

export const OPENAPI_PATH = join(
  repositoryRoot, "apps", "agent", "src", "openapi", "openapi.generated.json",
);
export const MANIFEST_PATH = join(
  repositoryRoot, "apps", "agent", "src", "control-plane", "operation-manifest.generated.json",
);
export const POLICY_PATH = join(
  repositoryRoot, "apps", "core-api", "src", "http", "idempotency-policy.ts",
);
export const POLICY_HEADER_PATH = join(
  repositoryRoot, "apps", "core-api", "src", "http", "idempotency-errors.ts",
);

export const TYPESCRIPT_OUTPUT = join(
  repositoryRoot, "packages", "platos-client", "src", "generated", "v1.ts",
);
export const PYTHON_OUTPUT = join(
  repositoryRoot, "packages", "platos-client-py", "platos_client", "generated", "v1.py",
);
export const FIXTURE_OUTPUT = join(
  repositoryRoot, "tests", "sdk-contract", "v1-fixtures.json",
);

/** The marker `x-platos-schema-source` carries on an operation with real schemas. */
const DERIVED_SOURCE = "typescript-dto";

class GenerationError extends Error {}

function fail(message) {
  throw new GenerationError(message);
}

/* ---------------------------------------------------------------------------
 * READING THE INPUTS
 * ------------------------------------------------------------------------- */

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * `OPERATION_POLICIES` and `SIDE_EFFECTING_METHODS`, read off the real file.
 *
 * A REGULAR EXPRESSION OVER THE SOURCE, NOT A RE-TYPED TABLE. The parse is
 * strict on purpose: an entry whose four fields cannot all be found, or a table
 * that comes back empty, raises rather than silently yielding a smaller policy —
 * a policy this generator read as empty would emit clients that send no
 * `Idempotency-Key` at all, which is precisely the failure the header exists to
 * prevent. `apps/core-api/src/http/idempotency-policy.test.ts` already joins
 * every row to the operation manifest, so a row that survives this parse is a
 * row that names a real operation.
 */
export function readIdempotencyPolicy(source) {
  const methods = /SIDE_EFFECTING_METHODS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/u.exec(source);
  if (methods === null) fail("idempotency-policy.ts no longer declares SIDE_EFFECTING_METHODS as a frozen array");
  const sideEffecting = [...methods[1].matchAll(/"([A-Z]+)"/gu)].map((match) => match[1]);
  if (sideEffecting.length === 0) fail("SIDE_EFFECTING_METHODS parsed as empty");

  const table = /OPERATION_POLICIES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\n\]\);/u.exec(source);
  if (table === null) fail("idempotency-policy.ts no longer declares OPERATION_POLICIES as a frozen array");
  const rows = [];
  for (const entry of table[1].split(/\n\s*\{\n/u)) {
    const method = /method:\s*"([A-Z]+)"/u.exec(entry);
    const template = /template:\s*"([^"]+)"/u.exec(entry);
    const klass = /class:\s*"(required|exempt)"/u.exec(entry);
    if (method === null && template === null && klass === null) continue;
    if (method === null || template === null || klass === null) {
      fail(`an OPERATION_POLICIES entry is missing method, template or class:\n${entry.slice(0, 200)}`);
    }
    rows.push({ method: method[1], template: template[1], class: klass[1] });
  }
  if (rows.length === 0) fail("OPERATION_POLICIES parsed as empty");
  return { sideEffecting, rows };
}

/** `IDEMPOTENCY_KEY_HEADER`, read off the file the middleware reads it from. */
export function readIdempotencyHeader(source) {
  const found = /IDEMPOTENCY_KEY_HEADER\s*=\s*"([^"]+)"/u.exec(source);
  if (found === null) fail("idempotency-errors.ts no longer declares IDEMPOTENCY_KEY_HEADER");
  return found[1];
}

/**
 * The class of one operation, stated over TEMPLATES.
 *
 * `classifyRequest` in `idempotency-policy.ts` answers the same question over a
 * CONCRETE path, at runtime, by pattern. This answers it over the template, at
 * generation time, by string equality — which is exactly what that file says its
 * table is compared by. The two are joined by execution rather than by belief:
 * `apps/core-api/src/http/idempotency-policy.test.ts` instantiates every
 * template emitted here and asserts `classifyRequest` returns the same class.
 */
export function classifyTemplate(method, template, policy) {
  const upper = method.toUpperCase();
  if (!policy.sideEffecting.includes(upper)) return "not-applicable";
  const row = policy.rows.find((entry) => entry.method === upper && entry.template === template);
  return row === undefined ? "accepted" : row.class;
}

const openApiPath = (template) => template.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");

/**
 * Every operation the document carries real schemas for, in manifest order.
 *
 * The MANIFEST is walked and the document is looked up, rather than the other
 * way round, because the manifest is the artifact that states the template. An
 * operation the document derives but the manifest does not carry is impossible
 * — the document is built from the manifest — and is raised rather than skipped.
 */
export function derivedOperations({ document, manifest, policy }) {
  const operations = [];
  for (const entry of manifest.inventories.restOperations) {
    const path = openApiPath(entry.path);
    const operation = document.paths?.[path]?.[entry.method.toLowerCase()];
    if (operation === undefined) continue;
    if (operation["x-platos-schema-source"] !== DERIVED_SOURCE) continue;

    const summary = String(operation.summary ?? "");
    const split = /^([A-Za-z0-9]+)Controller\.([A-Za-z0-9_]+)$/u.exec(summary);
    if (split === null) {
      fail(`${entry.method} ${entry.path}: summary "${summary}" is not Controller.handler; the naming derivation needs it`);
    }
    const successStatus = Object.keys(operation.responses ?? {}).filter((status) => status !== "default");
    if (successStatus.length !== 1) {
      fail(`${entry.method} ${entry.path}: expected exactly one success status, found ${successStatus.length}`);
    }

    operations.push({
      operationId: operation.operationId,
      method: entry.method.toUpperCase(),
      template: entry.path,
      openApiPath: path,
      namespace: split[1],
      handler: split[2],
      pathParameters: (operation.parameters ?? [])
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name),
      requestSchema: componentOf(operation.requestBody?.content?.["application/json"]?.schema),
      responseSchema: componentOf(
        operation.responses[successStatus[0]]?.content?.["application/json"]?.schema,
      ),
      successStatus: Number(successStatus[0]),
      queryParameters: operation["x-platos-query-parameters"],
      queryNotDerivedDetail: operation["x-platos-query-not-derived-detail"] ?? null,
      idempotency: classifyTemplate(entry.method, entry.path, policy),
    });
  }
  if (operations.length === 0) fail("no operation in the document declares a derived schema; the input is wrong");
  return operations;
}

/** A `$ref` to a component, or null for "no body". Anything else raises. */
function componentOf(schema) {
  if (schema === undefined) return null;
  const ref = schema.$ref;
  if (typeof ref !== "string") {
    fail(`a derived operation's schema is inline rather than a component: ${JSON.stringify(schema).slice(0, 120)}`);
  }
  const match = /^#\/components\/schemas\/(.+)$/u.exec(ref);
  if (match === null) fail(`unsupported $ref ${ref}`);
  return match[1];
}

/* ---------------------------------------------------------------------------
 * SCHEMAS -> NAMED TYPES
 *
 * INLINE OBJECTS ARE HOISTED, IN BOTH LANGUAGES, TO THE SAME NAME. TypeScript
 * could inline them and Python could not; letting each language do what suits it
 * would leave the two SDKs with different type inventories and nothing to
 * compare. So an object under `CreatedProjectResource.environment` becomes
 * `CreatedProjectResource_environment` in the emitted `.ts` and the emitted
 * `.py` alike, and the fixture carries the one list both must produce.
 * ------------------------------------------------------------------------- */

function refName(schema) {
  const ref = schema?.$ref;
  if (typeof ref !== "string") return null;
  const match = /^#\/components\/schemas\/(.+)$/u.exec(ref);
  return match === null ? null : match[1];
}

function typeSet(schema) {
  const declared = schema.type;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared)) return declared;
  return fail(`schema has no \`type\` and no \`$ref\`: ${JSON.stringify(schema).slice(0, 120)}`);
}

/**
 * Walk one component, hoisting every inline object it contains.
 *
 * Returns a node tree the emitters render. The walk is shared so the two
 * languages cannot disagree about the SHAPE — only about how they spell it.
 */
function analyse(schema, name, hoisted) {
  const ref = refName(schema);
  if (ref !== null) return { kind: "ref", name: ref };

  const types = typeSet(schema);
  const nullable = types.includes("null");
  const concrete = types.filter((entry) => entry !== "null");
  if (concrete.length !== 1) {
    fail(`${name}: expected one non-null type, found ${JSON.stringify(types)}`);
  }
  const [type] = concrete;

  if (type === "string" || type === "number" || type === "boolean" || type === "integer") {
    const values = schema.enum;
    if (values !== undefined) {
      if (!Array.isArray(values) || values.length === 0) fail(`${name}: enum must be a non-empty array`);
      return { kind: "enum", values: [...values], nullable, base: type };
    }
    return { kind: "scalar", type, nullable };
  }
  if (type === "array") {
    if (schema.items === undefined) fail(`${name}: array with no items`);
    return { kind: "array", items: analyse(schema.items, `${name}_item`, hoisted), nullable };
  }
  if (type === "object") {
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const fields = Object.keys(properties).map((property) => ({
      name: property,
      required: required.has(property),
      node: analyse(properties[property], `${name}_${property}`, hoisted),
    }));
    if (hoisted.has(name)) fail(`${name}: two schemas hoist to one name`);
    hoisted.set(name, fields);
    return { kind: "ref", name };
  }
  return fail(`${name}: unsupported type ${type}`);
}

/** Every named type the emitted clients declare, in declaration order. */
export function analyseComponents(document, operations) {
  const schemas = document.components?.schemas ?? {};
  const wanted = new Set();
  const visit = (name) => {
    if (name === null || wanted.has(name)) return;
    if (schemas[name] === undefined) fail(`operation references missing component ${name}`);
    wanted.add(name);
    for (const nested of referencedComponents(schemas[name])) visit(nested);
  };
  for (const operation of operations) {
    visit(operation.requestSchema);
    visit(operation.responseSchema);
  }
  // The failure envelope is reachable from every operation's `default` response
  // and is the reason the SDK can name a refusal at all.
  visit("ErrorEnvelope");

  const hoisted = new Map();
  for (const name of [...wanted].sort()) analyse(schemas[name], name, hoisted);
  return hoisted;
}

function referencedComponents(schema, found = new Set()) {
  if (Array.isArray(schema)) {
    for (const entry of schema) referencedComponents(entry, found);
    return found;
  }
  if (schema === null || typeof schema !== "object") return found;
  const ref = refName(schema);
  if (ref !== null) found.add(ref);
  for (const value of Object.values(schema)) referencedComponents(value, found);
  return found;
}

/* ---------------------------------------------------------------------------
 * NAMING
 * ------------------------------------------------------------------------- */

const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);

export function snake(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();
}

export const tsNamespace = (operation) => lowerFirst(operation.namespace);
export const tsMethod = (operation) => operation.handler;
export const pyNamespace = (operation) => snake(operation.namespace);
export const pyMethod = (operation) => snake(operation.handler);

/* ---------------------------------------------------------------------------
 * THE FIXTURE — WHAT BOTH LANGUAGES MUST PRODUCE
 * ------------------------------------------------------------------------- */

/**
 * A deterministic example value for one analysed node.
 *
 * DERIVED FROM THE SCHEMA, NOT WRITTEN OUT. A hand-written example body is a
 * third parallel copy of the request shape and would go stale the first time a
 * field is added — the exact failure this whole tranche exists to remove. A
 * required NULLABLE field is emitted as `null`, because that is the branch a
 * hand-written example never remembers to take.
 */
function sampleFor(node, hoisted, path) {
  if (node.nullable === true) return null;
  switch (node.kind) {
    case "ref": {
      const fields = hoisted.get(node.name);
      if (fields === undefined) fail(`${path}: no hoisted type named ${node.name}`);
      return Object.fromEntries(
        fields
          .filter((field) => field.required)
          .map((field) => [field.name, sampleFor(field.node, hoisted, `${path}.${field.name}`)]),
      );
    }
    case "enum":
      return node.values[0];
    case "array":
      return [];
    case "scalar":
      if (node.type === "boolean") return false;
      if (node.type === "number" || node.type === "integer") return 1;
      return `sample-${path}`;
    default:
      return fail(`${path}: unsupported node ${node.kind}`);
  }
}

/**
 * The path-parameter value both languages must encode identically.
 *
 * `/` and a space are the two characters worth exercising: they are the ones a
 * naive client leaves raw, they change which route the server matches, and
 * `encodeURIComponent` and `urllib.parse.quote(safe="")` agree on both. Values
 * the two spell differently (`!`, `*`, `'`) are deliberately NOT here: a fixture
 * that fails on a legitimate difference of spelling teaches nothing.
 */
const samplePathValue = (name) => `${name}-1/a b`;

const encodePathValue = (value) =>
  encodeURIComponent(value).replaceAll("%20", "%20");

/** The request one operation must produce when driven with the sample arguments. */
function invocationFor(operation, hoisted) {
  const pathParameters = Object.fromEntries(
    operation.pathParameters.map((name) => [name, samplePathValue(name)]),
  );
  const body =
    operation.requestSchema === null
      ? null
      : sampleFor({ kind: "ref", name: operation.requestSchema }, hoisted, operation.requestSchema);
  const path = operation.template.replaceAll(/:([A-Za-z0-9_]+)/gu, (_match, name) =>
    encodePathValue(pathParameters[name]),
  );
  return {
    arguments: { pathParameters, body },
    expected: {
      method: operation.method,
      path,
      sendsIdempotencyKey: operation.idempotency === "required" || operation.idempotency === "accepted",
      contentType: body === null ? null : "application/json",
    },
  };
}

export function buildFixture({ operations, hoisted, header, sources }) {
  return {
    $comment:
      "GENERATED by `pnpm generate:sdk-v1`. The V1 request every generated SDK must produce, " +
      "and the type inventory both must declare. Edited by hand it stops matching the contract " +
      "it was derived from, and `pnpm audit:sdk-v1` fails.",
    idempotencyKeyHeader: header,
    sourceDigests: sources,
    typeNames: [...hoisted.keys()].sort(),
    operations: operations
      .map((operation) => ({
        operationId: operation.operationId,
        method: operation.method,
        template: operation.template,
        pathParameters: operation.pathParameters,
        requestSchema: operation.requestSchema,
        responseSchema: operation.responseSchema,
        successStatus: operation.successStatus,
        idempotency: operation.idempotency,
        queryParameters: operation.queryParameters,
        typescript: { namespace: tsNamespace(operation), method: tsMethod(operation) },
        python: { namespace: pyNamespace(operation), method: pyMethod(operation) },
        ...invocationFor(operation, hoisted),
      }))
      .sort((left, right) => (left.operationId < right.operationId ? -1 : 1)),
  };
}

/* ---------------------------------------------------------------------------
 * EMITTERS
 * ------------------------------------------------------------------------- */

const BANNER = [
  "// GENERATED FILE — DO NOT EDIT.",
  "//",
  "// Emitted by `pnpm generate:sdk-v1` (scripts/sdk/v1-contract.mjs) from the V1",
  "// OpenAPI document, the operation manifest and core-api's idempotency policy.",
  "// `pnpm audit:sdk-v1` regenerates this file and fails when the committed copy",
  "// differs, so an edit here is reverted by the next check rather than shipped.",
];

function tsType(node) {
  const suffix = node.nullable === true ? " | null" : "";
  switch (node.kind) {
    case "ref":
      return node.name;
    case "scalar":
      return `${node.type === "integer" ? "number" : node.type}${suffix}`;
    case "enum":
      return `${node.values.map((value) => JSON.stringify(value)).join(" | ")}${suffix}`;
    case "array":
      return `readonly ${wrapTs(node.items)}[]${suffix}`;
    default:
      return fail(`unsupported node ${node.kind}`);
  }
}

/** Parenthesise a union before `[]`, which binds tighter than `|`. */
function wrapTs(node) {
  const rendered = tsType(node);
  return /[|]/u.test(rendered) ? `(${rendered})` : rendered;
}

function pyType(node) {
  const suffix = node.nullable === true ? " | None" : "";
  switch (node.kind) {
    case "ref":
      return `"${node.name}"${suffix}`;
    case "scalar":
      return `${{ string: "str", number: "float", integer: "int", boolean: "bool" }[node.type]}${suffix}`;
    case "enum":
      return `Literal[${node.values.map((value) => JSON.stringify(value)).join(", ")}]${suffix}`;
    case "array":
      return `list[${pyType(node.items)}]${suffix}`;
    default:
      return fail(`unsupported node ${node.kind}`);
  }
}

function emitTypescript({ operations, hoisted, header, wireErrorCodes }) {
  const lines = [...BANNER, "", "/* eslint-disable */", ""];
  lines.push(
    "/** Every `error.code` the canonical taxonomy admits, as the V1 document enumerates it. */",
    "export const WIRE_ERROR_CODES = [",
    ...wireErrorCodes.map((code) => `  ${JSON.stringify(code)},`),
    "] as const;",
    "",
    "export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];",
    "",
    "/** The header M0.4 section 2 binds one-time-secret mints to. */",
    `export const IDEMPOTENCY_KEY_HEADER = ${JSON.stringify(header)};`,
    "",
  );

  for (const [name, fields] of hoisted) {
    lines.push(`export interface ${name} {`);
    for (const field of fields) {
      const rendered = name === "WireError" && field.name === "code" ? "WireErrorCode" : tsType(field.node);
      lines.push(`  readonly ${JSON.stringify(field.name)}${field.required ? "" : "?"}: ${rendered};`);
    }
    lines.push("}", "");
  }

  lines.push(
    "/** How a caller must treat `Idempotency-Key` on one operation. */",
    'export type V1IdempotencyClass = "required" | "accepted" | "exempt" | "not-applicable";',
    "",
    "export interface V1Operation {",
    "  readonly operationId: string;",
    "  readonly method: string;",
    "  /** The route template, `:param` segments included — the form the policy table states. */",
    "  readonly template: string;",
    "  readonly pathParameters: readonly string[];",
    "  readonly successStatus: number;",
    "  readonly idempotency: V1IdempotencyClass;",
    "}",
    "",
    "export const V1_OPERATIONS: readonly V1Operation[] = [",
  );
  for (const operation of operations) {
    lines.push(
      "  {",
      `    operationId: ${JSON.stringify(operation.operationId)},`,
      `    method: ${JSON.stringify(operation.method)},`,
      `    template: ${JSON.stringify(operation.template)},`,
      `    pathParameters: [${operation.pathParameters.map((name) => JSON.stringify(name)).join(", ")}],`,
      `    successStatus: ${String(operation.successStatus)},`,
      `    idempotency: ${JSON.stringify(operation.idempotency)},`,
      "  },",
    );
  }
  lines.push("];", "");

  lines.push(
    "/**",
    " * What a generated method hands the transport.",
    " *",
    " * A REQUEST, NOT A RESPONSE. The generated layer decides the method, the path,",
    " * the body and whether this operation is bound to an `Idempotency-Key`; the",
    " * hand-written transport decides auth, retry and how a refusal becomes an error.",
    " * Splitting them there is what lets the whole request be asserted in a test with",
    " * no server, in both languages, against one fixture.",
    " */",
    "export interface V1Request {",
    "  readonly operation: V1Operation;",
    "  readonly path: string;",
    "  readonly body: unknown;",
    "  readonly query: Readonly<Record<string, string>> | undefined;",
    "}",
    "",
    "export interface V1Transport {",
    "  send<T>(request: V1Request): Promise<T>;",
    "}",
    "",
    "const BY_ID = new Map(V1_OPERATIONS.map((operation) => [operation.operationId, operation]));",
    "",
    "function operation(operationId: string): V1Operation {",
    "  const found = BY_ID.get(operationId);",
    "  if (found === undefined) throw new Error(`unknown V1 operation ${operationId}`);",
    "  return found;",
    "}",
    "",
    "/**",
    " * Substitute path parameters, refusing an empty one.",
    " *",
    " * An empty segment silently changes which route the server matches — a mint",
    " * addressed at `/mcp/entity//tokens` is not that entity's mint — so it is a",
    " * refusal here rather than a 404 nobody can explain.",
    " */",
    "function fill(template: string, values: Readonly<Record<string, string>>): string {",
    "  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {",
    "    const value = values[name];",
    "    if (typeof value !== \"string\" || value.length === 0) {",
    "      throw new Error(`V1: path parameter ${name} is required and must not be empty`);",
    "    }",
    "    return encodeURIComponent(value);",
    "  });",
    "}",
    "",
  );

  const namespaces = new Map();
  for (const operation of operations) {
    const bucket = namespaces.get(tsNamespace(operation)) ?? [];
    bucket.push(operation);
    namespaces.set(tsNamespace(operation), bucket);
  }

  for (const [namespace, members] of namespaces) {
    const className = `${namespace.charAt(0).toUpperCase()}${namespace.slice(1)}V1Api`;
    lines.push(`export class ${className} {`, "  constructor(private readonly transport: V1Transport) {}", "");
    for (const member of members) {
      const args = [];
      for (const parameter of member.pathParameters) args.push(`${parameter}: string`);
      if (member.requestSchema !== null) args.push(`body: ${member.requestSchema}`);
      if (member.queryParameters === "not-derived") {
        args.push("query?: Readonly<Record<string, string>>");
      }
      const returns = member.responseSchema === null ? "void" : member.responseSchema;
      if (member.queryParameters === "not-derived" && member.queryNotDerivedDetail !== null) {
        lines.push(
          "  /**",
          `   * ${member.method} ${member.template}`,
          "   *",
          "   * THE QUERY STRING IS NOT TYPED, AND THE DOCUMENT SAYS WHY:",
          `   * ${member.queryNotDerivedDetail.replace(/\s+/gu, " ")}`,
          "   */",
        );
      } else {
        lines.push("  /** " + `${member.method} ${member.template}` + " */");
      }
      lines.push(
        `  async ${tsMethod(member)}(${args.join(", ")}): Promise<${returns}> {`,
        `    return this.transport.send<${returns}>({`,
        `      operation: operation(${JSON.stringify(member.operationId)}),`,
        member.pathParameters.length === 0
          ? `      path: ${JSON.stringify(member.template)},`
          : `      path: fill(${JSON.stringify(member.template)}, { ${member.pathParameters
              .map((name) => `${name}`)
              .join(", ")} }),`,
        `      body: ${member.requestSchema === null ? "undefined" : "body"},`,
        `      query: ${member.queryParameters === "not-derived" ? "query" : "undefined"},`,
        "    });",
        "  }",
        "",
      );
    }
    lines.push("}", "");
  }

  lines.push("/** Every generated V1 namespace, attached to one transport. */", "export class V1Api {");
  for (const namespace of namespaces.keys()) {
    const className = `${namespace.charAt(0).toUpperCase()}${namespace.slice(1)}V1Api`;
    lines.push(`  readonly ${namespace}: ${className};`);
  }
  lines.push("", "  constructor(transport: V1Transport) {");
  for (const namespace of namespaces.keys()) {
    const className = `${namespace.charAt(0).toUpperCase()}${namespace.slice(1)}V1Api`;
    lines.push(`    this.${namespace} = new ${className}(transport);`);
  }
  lines.push("  }", "}", "");
  return `${lines.join("\n")}`;
}

function emitPython({ operations, hoisted, header, wireErrorCodes }) {
  const lines = [
    '"""',
    "GENERATED FILE - DO NOT EDIT.",
    "",
    "Emitted by `pnpm generate:sdk-v1` (scripts/sdk/v1-contract.mjs) from the V1",
    "OpenAPI document, the operation manifest and core-api's idempotency policy.",
    "`pnpm audit:sdk-v1` regenerates this file and fails when the committed copy",
    "differs, so an edit here is reverted by the next check rather than shipped.",
    '"""',
    "",
    "from __future__ import annotations",
    "",
    "from typing import Any, Literal, Protocol, TypedDict, TypeVar",
    "",
    "#: Every ``error.code`` the canonical taxonomy admits, as the V1 document enumerates it.",
    "WIRE_ERROR_CODES: tuple[str, ...] = (",
    ...wireErrorCodes.map((code) => `    ${JSON.stringify(code)},`),
    ")",
    "",
    "#: The header M0.4 section 2 binds one-time-secret mints to.",
    `IDEMPOTENCY_KEY_HEADER = ${JSON.stringify(header)}`,
    "",
  ];

  for (const [name, fields] of hoisted) {
    const required = fields.filter((field) => field.required);
    const optional = fields.filter((field) => !field.required);
    // A TypedDict cannot mix required and optional members in the class form
    // without `NotRequired`, so an optional member is declared in a
    // `total=False` base the required half inherits. That is the standard
    // spelling and it keeps the emitted module importable on 3.9.
    if (optional.length > 0) {
      lines.push(`class ${name}Optional(TypedDict, total=False):`);
      for (const field of optional) lines.push(`    ${field.name}: ${pyType(field.node)}`);
      lines.push("", "");
      lines.push(`class ${name}(${name}Optional):`);
    } else {
      lines.push(`class ${name}(TypedDict):`);
    }
    if (required.length === 0 && optional.length === 0) lines.push("    pass");
    for (const field of required) lines.push(`    ${field.name}: ${pyType(field.node)}`);
    lines.push("", "");
  }

  lines.push(
    'V1IdempotencyClass = Literal["required", "accepted", "exempt", "not-applicable"]',
    "",
    "",
    "class V1Operation(TypedDict):",
    "    operationId: str",
    "    method: str",
    "    template: str",
    "    pathParameters: list[str]",
    "    successStatus: int",
    "    idempotency: V1IdempotencyClass",
    "",
    "",
    "V1_OPERATIONS: tuple[V1Operation, ...] = (",
  );
  for (const operation of operations) {
    lines.push(
      "    {",
      `        "operationId": ${JSON.stringify(operation.operationId)},`,
      `        "method": ${JSON.stringify(operation.method)},`,
      `        "template": ${JSON.stringify(operation.template)},`,
      `        "pathParameters": [${operation.pathParameters.map((name) => JSON.stringify(name)).join(", ")}],`,
      `        "successStatus": ${String(operation.successStatus)},`,
      `        "idempotency": ${JSON.stringify(operation.idempotency)},`,
      "    },",
    );
  }
  lines.push(
    ")",
    "",
    "",
    "class V1Request(TypedDict):",
    "    operation: V1Operation",
    "    path: str",
    "    body: Any",
    "    query: dict[str, str] | None",
    "",
    "",
    'T = TypeVar("T")',
    "",
    "",
    "class V1Transport(Protocol):",
    "    def send(self, request: V1Request) -> Any:",
    '        """Perform one V1 request and return its decoded body."""',
    "",
    "",
    "_BY_ID = {operation[\"operationId\"]: operation for operation in V1_OPERATIONS}",
    "",
    "",
    "def _operation(operation_id: str) -> V1Operation:",
    "    found = _BY_ID.get(operation_id)",
    "    if found is None:",
    '        raise ValueError(f"unknown V1 operation {operation_id}")',
    "    return found",
    "",
    "",
    "def _fill(template: str, values: dict[str, str]) -> str:",
    '    """Substitute path parameters, refusing an empty one.',
    "",
    "    An empty segment silently changes which route the server matches - a mint",
    "    addressed at ``/mcp/entity//tokens`` is not that entity's mint - so it is a",
    "    refusal here rather than a 404 nobody can explain.",
    '    """',
    "    import re",
    "    from urllib.parse import quote",
    "",
    "    def replace(match: Any) -> str:",
    "        name = match.group(1)",
    "        value = values.get(name)",
    "        if not isinstance(value, str) or value == \"\":",
    '            raise ValueError(f"V1: path parameter {name} is required and must not be empty")',
    '        return quote(value, safe="")',
    "",
    '    return re.sub(r":([A-Za-z0-9_]+)", replace, template)',
    "",
  );

  const namespaces = new Map();
  for (const operation of operations) {
    const bucket = namespaces.get(pyNamespace(operation)) ?? [];
    bucket.push(operation);
    namespaces.set(pyNamespace(operation), bucket);
  }

  const classNameOf = (namespace) =>
    `${namespace.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}V1Api`;

  for (const [namespace, members] of namespaces) {
    lines.push("", `class ${classNameOf(namespace)}:`, "    def __init__(self, transport: V1Transport) -> None:", "        self._transport = transport", "");
    for (const member of members) {
      const args = ["self"];
      for (const parameter of member.pathParameters) args.push(`${snake(parameter)}: str`);
      if (member.requestSchema !== null) args.push(`body: "${member.requestSchema}"`);
      if (member.queryParameters === "not-derived") args.push("query: dict[str, str] | None = None");
      const returns = member.responseSchema === null ? "None" : `"${member.responseSchema}"`;
      lines.push(`    def ${pyMethod(member)}(${args.join(", ")}) -> ${returns}:`);
      if (member.queryParameters === "not-derived" && member.queryNotDerivedDetail !== null) {
        lines.push(
          '        """' + `${member.method} ${member.template}`,
          "",
          "        THE QUERY STRING IS NOT TYPED, AND THE DOCUMENT SAYS WHY:",
          `        ${member.queryNotDerivedDetail.replace(/\s+/gu, " ")}`,
          '        """',
        );
      } else {
        lines.push(`        """${member.method} ${member.template}"""`);
      }
      const values = member.pathParameters
        .map((name) => `${JSON.stringify(name)}: ${snake(name)}`)
        .join(", ");
      lines.push(
        "        return self._transport.send(",
        "            {",
        `                "operation": _operation(${JSON.stringify(member.operationId)}),`,
        member.pathParameters.length === 0
          ? `                "path": ${JSON.stringify(member.template)},`
          : `                "path": _fill(${JSON.stringify(member.template)}, {${values}}),`,
        `                "body": ${member.requestSchema === null ? "None" : "body"},`,
        `                "query": ${member.queryParameters === "not-derived" ? "query" : "None"},`,
        "            }",
        "        )",
        "",
      );
    }
  }

  lines.push("", "class V1Api:", '    """Every generated V1 namespace, attached to one transport."""', "", "    def __init__(self, transport: V1Transport) -> None:");
  for (const namespace of namespaces.keys()) {
    lines.push(`        self.${namespace} = ${classNameOf(namespace)}(transport)`);
  }
  lines.push("");
  return lines.join("\n");
}

/* ---------------------------------------------------------------------------
 * DRIVER
 * ------------------------------------------------------------------------- */

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

/**
 * The three emitted artifacts, keyed by absolute path.
 *
 * `overrides` replaces one input's TEXT without touching the disk. That is how
 * `scripts/sdk/v1-contract.test.mjs` proves the join is real: it hands back the
 * REAL policy file with `class: "required"` turned into `class: "exempt"`,
 * re-emits, and asserts the mint stops carrying a key. A gate whose inputs are
 * never perturbed is a gate nobody has seen fire.
 */
export function buildArtifacts({ root = repositoryRoot, overrides = new Map() } = {}) {
  const read = (absolute) => {
    const key = relative(repositoryRoot, absolute);
    const override = overrides.get(key);
    return override ?? readFileSync(join(root, key), "utf8");
  };
  const openapiText = read(OPENAPI_PATH);
  const manifestText = read(MANIFEST_PATH);
  const policyText = read(POLICY_PATH);
  const headerText = read(POLICY_HEADER_PATH);

  const document = JSON.parse(openapiText);
  const manifest = JSON.parse(manifestText);
  const policy = readIdempotencyPolicy(policyText);
  const header = readIdempotencyHeader(headerText);

  const operations = derivedOperations({ document, manifest, policy });
  const hoisted = analyseComponents(document, operations);

  const wireErrorCodes = document.components?.schemas?.WireError?.properties?.code?.enum;
  if (!Array.isArray(wireErrorCodes) || wireErrorCodes.length === 0) {
    fail("the V1 document's WireError.code carries no enum; the error taxonomy join is gone");
  }

  const sources = {
    "apps/agent/src/openapi/openapi.generated.json": digest(openapiText),
    "apps/agent/src/control-plane/operation-manifest.generated.json": digest(manifestText),
    "apps/core-api/src/http/idempotency-policy.ts": digest(policyText),
    "apps/core-api/src/http/idempotency-errors.ts": digest(headerText),
  };

  return {
    [TYPESCRIPT_OUTPUT]: `${emitTypescript({ operations, hoisted, header, wireErrorCodes })}`,
    [PYTHON_OUTPUT]: `${emitPython({ operations, hoisted, header, wireErrorCodes })}`,
    [FIXTURE_OUTPUT]: `${JSON.stringify(buildFixture({ operations, hoisted, header, sources }), null, 2)}\n`,
  };
}

function runCli(argv = process.argv.slice(2)) {
  const mode = argv.includes("--check") ? "check" : argv.includes("--write") ? "write" : null;
  if (mode === null) {
    process.stderr.write("usage: node scripts/sdk/v1-contract.mjs [--write | --check]\n");
    process.exit(2);
  }
  let artifacts;
  try {
    artifacts = buildArtifacts();
  } catch (error) {
    if (!(error instanceof GenerationError)) throw error;
    process.stderr.write(`[sdk-v1] ${error.message}\n`);
    process.exit(1);
    return;
  }
  const stale = [];
  for (const [path, content] of Object.entries(artifacts)) {
    const shown = relative(repositoryRoot, path);
    if (mode === "write") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      continue;
    }
    if (!existsSync(path)) {
      stale.push(`${shown} is missing`);
      continue;
    }
    if (readFileSync(path, "utf8") !== content) stale.push(`${shown} differs from the contract`);
  }
  if (mode === "write") {
    process.stderr.write(
      `[sdk-v1] wrote ${String(Object.keys(artifacts).length)} generated artifact(s)\n`,
    );
    return;
  }
  if (stale.length > 0) {
    process.stderr.write(
      `[sdk-v1] the generated SDK has drifted from the V1 contract:\n${stale.map((entry) => `  ${entry}`).join("\n")}\n` +
        "Run: pnpm generate:sdk-v1\n",
    );
    process.exit(1);
  }
  process.stderr.write("[sdk-v1] ok: the generated TypeScript, Python and fixture artifacts match the V1 contract\n");
}

export { GenerationError, runCli };

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCli();
