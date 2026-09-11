#!/usr/bin/env node

// THE V1 REST BREAKING-CHANGE RATCHET.
//
// WIN-267 W2. `apps/agent/scripts/rest-schema-derivation.mjs` reads the wire
// schemas off the TypeScript types, so the generated document cannot drift from
// the code. That closes one hole and opens another: a document that follows the
// code perfectly also follows it off a cliff. Delete `readonly email` from
// `OperatorSessionResource` and the generated schema loses the field, silently,
// in step — and every gate in the repository stays green because the artifact
// still matches its generator.
//
// So the derived contract is compared against a COMMITTED BASELINE that only
// moves when somebody moves it: `docs/openapi-v1-baseline.json`. That is the
// join. The generated side is decided by the compiler; the baseline side is
// decided by a human writing a commit; and a change that is BREAKING cannot be
// absorbed by `write` at all — the only way to green the tree after one is to
// hand-edit the baseline, which shows up in review as an explicit deletion
// rather than as a regenerated blob.
//
// -----------------------------------------------------------------------------
// WHY THE CLASSIFIER EXISTS AT ALL
//
// A guard that cannot tell a removed field from an added one fires on every
// release and is switched off within a month. The rules below are therefore
// stated per SIDE, because compatibility is not symmetric: a property added to a
// request is compatible (nobody was sending it) while a property added to a
// request's `required` list is not (everybody's existing body now fails), and a
// property removed from a response is breaking (a client was reading it) while
// one added to it is not.
//
// THE ENUM RULE IS THE ONE WORTH ARGUING WITH, so it is written down. Widening
// an enum is COMPATIBLE on both sides; narrowing is BREAKING on both. On the
// request side that is uncontroversial. On the RESPONSE side it is a deliberate
// reading of ADR M0.4 section 1's "unknown-tolerance + additive-only": the one
// large response enum in this surface is `error.code`, drawn from
// `docs/error-taxonomy.json`, and a context minting a new failure code is the
// single most routine additive change this system makes. A rule that called that
// breaking would fire every milestone on a change no caller can observe, and the
// gate would be disabled. Narrowing stays breaking, because removing a code
// removes a branch a caller was entitled to write.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRestContract } from "../apps/agent/scripts/rest-schema-derivation.mjs";
import { validateOpenApiDocument } from "../apps/agent/scripts/openapi-meta-schema.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");

export const BASELINE_PATH = join(repositoryRoot, "docs", "openapi-v1-baseline.json");
export const GENERATED_PATH = join(
  repositoryRoot,
  "apps",
  "agent",
  "src",
  "openapi",
  "openapi.generated.json",
);

export const BREAKING = "BREAKING";
export const COMPATIBLE = "COMPATIBLE";
export const INFORMATIONAL = "INFORMATIONAL";

/** The operation keys the baseline carries. Everything else is presentation. */
const CONTRACT_OPERATION_KEYS = [
  "operationId",
  "parameters",
  "requestBody",
  "responses",
  "security",
  "x-platos-schema-source",
  "x-platos-query-parameters",
];

/** Schema keywords whose change is presentation rather than contract. */
const ANNOTATION_KEYWORDS = new Set(["description", "title", "$comment", "example", "examples"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedObject(value[key])]),
  );
}

function refName(node) {
  if (!isObject(node)) return null;
  const ref = node.$ref;
  if (typeof ref !== "string") return null;
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  return match === null ? null : match[1];
}

/**
 * Every component a node reaches, transitively.
 *
 * Used to decide which SIDE a shared component is on. A schema reached from both
 * a request body and a response is held to BOTH sets of rules, because a change
 * that is compatible for one direction may not be for the other and the stricter
 * answer is the only safe one.
 */
function reachableComponents(node, schemas, found = new Set()) {
  if (Array.isArray(node)) {
    for (const entry of node) reachableComponents(entry, schemas, found);
    return found;
  }
  if (!isObject(node)) return found;
  const name = refName(node);
  if (name !== null && !found.has(name)) {
    found.add(name);
    reachableComponents(schemas[name] ?? {}, schemas, found);
  }
  for (const value of Object.values(node)) reachableComponents(value, schemas, found);
  return found;
}

/**
 * The V1 contract slice of a generated document: the operations that carry a
 * derived schema, plus exactly the components they reach.
 *
 * The slice is itself a valid OpenAPI document, so the baseline can be validated
 * by the same external authority as the generated one.
 */
export function v1Slice(document) {
  const schemas = document.components?.schemas ?? {};
  const paths = {};
  const reached = new Set();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation["x-platos-schema-source"] !== "typescript-dto") continue;
      const kept = {};
      for (const key of CONTRACT_OPERATION_KEYS) {
        if (operation[key] !== undefined) kept[key] = operation[key];
      }
      paths[path] ??= {};
      paths[path][method] = kept;
      reachableComponents(kept, schemas, reached);
    }
  }
  const keptSchemas = {};
  for (const name of [...reached].sort()) keptSchemas[name] = schemas[name];
  return sortedObject({
    openapi: document.openapi,
    info: {
      title: "Platos V1 REST contract baseline",
      version: "1",
      // NO REPOSITORY PATHS IN THIS STRING. `scripts/workspace-reachability.mjs`
      // scans every tracked file for workspace roots, so a path written here as
      // prose would make the baseline a false reachability edge into whichever
      // workspace it named. The generator is identified by its package script.
      description:
        "The frozen V1 wire contract: request and response schemas derived from the core-api " +
        "handler types. Written only by `pnpm generate:openapi-baseline`, which refuses to " +
        "absorb a breaking change.",
    },
    paths,
    components: { schemas: keptSchemas },
  });
}

/** Which side of the wire each component sits on. */
export function componentSides(slice) {
  const schemas = slice.components?.schemas ?? {};
  const request = new Set();
  const response = new Set();
  for (const item of Object.values(slice.paths ?? {})) {
    for (const operation of Object.values(item)) {
      for (const name of reachableComponents(operation.requestBody ?? {}, schemas)) request.add(name);
      for (const name of reachableComponents(operation.parameters ?? [], schemas)) request.add(name);
      for (const name of reachableComponents(operation.responses ?? {}, schemas)) response.add(name);
    }
  }
  return { request, response };
}

function finding(severity, kind, pointer, detail) {
  return { severity, kind, pointer, detail };
}

function typeSet(schema) {
  const type = schema?.type;
  if (type === undefined) return null;
  return new Set(Array.isArray(type) ? type : [type]);
}

function isSuperset(bigger, smaller) {
  for (const entry of smaller) if (!bigger.has(entry)) return false;
  return true;
}

/**
 * Compare one schema node on one side.
 *
 * `sides` is the set of sides this node is reached from — a component used by
 * both a request and a response is compared under both, and the harsher verdict
 * is what reaches the report.
 */
function compareSchema(base, current, sides, pointer, findings) {
  if (base === undefined && current === undefined) return;
  if (base === undefined) {
    findings.push(finding(COMPATIBLE, "schema-added", pointer, "not present in the baseline"));
    return;
  }
  if (current === undefined) {
    findings.push(finding(BREAKING, "schema-removed", pointer, "present in the baseline, gone now"));
    return;
  }
  const baseRef = refName(base);
  const currentRef = refName(current);
  if (baseRef !== null || currentRef !== null) {
    if (baseRef !== currentRef) {
      findings.push(
        finding(BREAKING, "ref-retargeted", pointer, `${String(baseRef)} -> ${String(currentRef)}`),
      );
    }
    return;
  }
  if (!isObject(base) || !isObject(current)) {
    if (JSON.stringify(base) !== JSON.stringify(current)) {
      findings.push(finding(BREAKING, "schema-replaced", pointer, "a non-object schema changed"));
    }
    return;
  }

  const baseTypes = typeSet(base);
  const currentTypes = typeSet(current);
  if (JSON.stringify(base.type ?? null) !== JSON.stringify(current.type ?? null)) {
    const widenedForRequest =
      baseTypes !== null && currentTypes !== null && isSuperset(currentTypes, baseTypes);
    if (widenedForRequest && sides.size === 1 && sides.has("request")) {
      findings.push(finding(COMPATIBLE, "request-type-widened", pointer, "the request accepts more"));
    } else {
      findings.push(
        finding(
          BREAKING,
          "type-changed",
          pointer,
          `${JSON.stringify(base.type ?? null)} -> ${JSON.stringify(current.type ?? null)}`,
        ),
      );
    }
  }

  const baseEnum = base.enum === undefined ? null : new Set(base.enum.map((v) => JSON.stringify(v)));
  const currentEnum =
    current.enum === undefined ? null : new Set(current.enum.map((v) => JSON.stringify(v)));
  if (baseEnum === null && currentEnum !== null) {
    findings.push(
      finding(BREAKING, "enum-introduced", pointer, "an unconstrained value became a closed set"),
    );
  } else if (baseEnum !== null && currentEnum === null) {
    findings.push(finding(COMPATIBLE, "enum-removed", pointer, "the value is no longer constrained"));
  } else if (baseEnum !== null && currentEnum !== null) {
    const removed = [...baseEnum].filter((entry) => !currentEnum.has(entry));
    const added = [...currentEnum].filter((entry) => !baseEnum.has(entry));
    if (removed.length > 0) {
      findings.push(
        finding(BREAKING, "enum-narrowed", pointer, `${String(removed.length)} value(s) removed`),
      );
    }
    if (added.length > 0) {
      findings.push(
        finding(COMPATIBLE, "enum-widened", pointer, `${String(added.length)} value(s) added`),
      );
    }
  }

  const baseRequired = new Set(base.required ?? []);
  const currentRequired = new Set(current.required ?? []);
  for (const name of baseRequired) {
    if (currentRequired.has(name)) continue;
    const severity = sides.has("response") ? BREAKING : COMPATIBLE;
    findings.push(finding(severity, "required-dropped", `${pointer}/required/${name}`, "no longer promised"));
  }
  for (const name of currentRequired) {
    if (baseRequired.has(name)) continue;
    const severity = sides.has("request") ? BREAKING : COMPATIBLE;
    findings.push(finding(severity, "required-added", `${pointer}/required/${name}`, "now demanded"));
  }

  const baseProperties = base.properties ?? {};
  const currentProperties = current.properties ?? {};
  for (const name of Object.keys(baseProperties)) {
    if (!(name in currentProperties)) {
      findings.push(
        finding(BREAKING, "property-removed", `${pointer}/properties/${name}`, "removed or renamed"),
      );
      continue;
    }
    compareSchema(
      baseProperties[name],
      currentProperties[name],
      sides,
      `${pointer}/properties/${name}`,
      findings,
    );
  }
  for (const name of Object.keys(currentProperties)) {
    if (name in baseProperties) continue;
    findings.push(
      finding(COMPATIBLE, "property-added", `${pointer}/properties/${name}`, "new optional field"),
    );
  }

  if (base.items !== undefined || current.items !== undefined) {
    compareSchema(base.items, current.items, sides, `${pointer}/items`, findings);
  }
  const baseAnyOf = base.anyOf ?? null;
  const currentAnyOf = current.anyOf ?? null;
  if (JSON.stringify(baseAnyOf === null ? null : baseAnyOf.length) !==
      JSON.stringify(currentAnyOf === null ? null : currentAnyOf.length)) {
    findings.push(finding(BREAKING, "anyof-arity-changed", `${pointer}/anyOf`, "branch count moved"));
  } else if (baseAnyOf !== null && currentAnyOf !== null) {
    baseAnyOf.forEach((branch, index) => {
      compareSchema(branch, currentAnyOf[index], sides, `${pointer}/anyOf/${String(index)}`, findings);
    });
  }

  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (["type", "enum", "required", "properties", "items", "anyOf", "$ref"].includes(key)) continue;
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    if (JSON.stringify(base[key]) === JSON.stringify(current[key])) continue;
    findings.push(finding(BREAKING, "keyword-changed", `${pointer}/${key}`, "an unmodelled keyword moved"));
  }
}

function parameterKey(parameter) {
  return `${String(parameter.in)}:${String(parameter.name)}`;
}

function compareOperation(base, current, pointer, findings) {
  if (JSON.stringify(base.security ?? null) !== JSON.stringify(current.security ?? null)) {
    findings.push(finding(BREAKING, "security-changed", `${pointer}/security`, "the auth contract moved"));
  }
  if (base["x-platos-schema-source"] !== current["x-platos-schema-source"]) {
    findings.push(
      finding(BREAKING, "schema-source-changed", `${pointer}/x-platos-schema-source`, "the route stopped declaring a schema"),
    );
  }
  if (base["x-platos-query-parameters"] !== current["x-platos-query-parameters"]) {
    findings.push(
      finding(INFORMATIONAL, "query-derivation-changed", `${pointer}/x-platos-query-parameters`, "query derivability moved"),
    );
  }

  const baseParameters = new Map((base.parameters ?? []).map((p) => [parameterKey(p), p]));
  const currentParameters = new Map((current.parameters ?? []).map((p) => [parameterKey(p), p]));
  for (const [key, parameter] of baseParameters) {
    const match = currentParameters.get(key);
    if (match === undefined) {
      findings.push(finding(BREAKING, "parameter-removed", `${pointer}/parameters/${key}`, "gone"));
      continue;
    }
    if (parameter.required !== match.required) {
      const severity = match.required === true ? BREAKING : COMPATIBLE;
      findings.push(finding(severity, "parameter-requiredness-changed", `${pointer}/parameters/${key}`, "requiredness moved"));
    }
    compareSchema(parameter.schema, match.schema, new Set(["request"]), `${pointer}/parameters/${key}/schema`, findings);
  }
  // A ROUTE LEARNING WHAT IT ALWAYS DEMANDED IS A DISCLOSURE, NOT AN ADDITION.
  //
  // M4 finish added the derivation path for `@Query` types, so three MCP token
  // routes went from `x-platos-query-parameters: not-derived` to `derived` and
  // published a REQUIRED `environmentId`. Classified as a plain
  // `parameter-added`, a required parameter is BREAKING and rightly so — ADR M0.4
  // section 1.3 puts "add required input" on the forces-major list. But NOTHING ON
  // THE WIRE MOVED: `tokenListQueryValidator` has refused a request without
  // `environmentId` since the route existed, and any client that omitted it has
  // always received a 400. Calling that a breaking change would price a
  // documentation correction as a major, and the only way through would be a
  // hand-edited baseline — which is how a ratchet stops being read.
  //
  // THE CONDITION IS STRUCTURAL AND ONE-SHOT, not a list of forgiven parameters.
  // The BASELINE must itself say `not-derived` for this operation and the current
  // document must say `derived`: that pair means "the document learned the query
  // string", and it cannot be confused with a genuinely new required parameter,
  // where the baseline already says `derived`. Once absorbed the baseline says
  // `derived` too, so the NEXT required query parameter on the same route is
  // BREAKING again. It applies to `in: "query"` only — a new required PATH
  // parameter is a different route.
  const disclosingQuery =
    base["x-platos-query-parameters"] === "not-derived" &&
    current["x-platos-query-parameters"] === "derived";
  for (const [key, parameter] of currentParameters) {
    if (baseParameters.has(key)) continue;
    if (disclosingQuery && parameter.in === "query") {
      findings.push(
        finding(
          COMPATIBLE,
          "query-parameter-disclosed",
          `${pointer}/parameters/${key}`,
          parameter.required === true
            ? "the document learned a parameter the route already required"
            : "the document learned a parameter the route already accepted",
        ),
      );
      continue;
    }
    const severity = parameter.required === true ? BREAKING : COMPATIBLE;
    findings.push(finding(severity, "parameter-added", `${pointer}/parameters/${key}`, "new parameter"));
  }

  const baseBody = base.requestBody;
  const currentBody = current.requestBody;
  if (baseBody === undefined && currentBody !== undefined) {
    findings.push(finding(BREAKING, "request-body-introduced", `${pointer}/requestBody`, "a body is now required"));
  } else if (baseBody !== undefined && currentBody === undefined) {
    findings.push(finding(BREAKING, "request-body-removed", `${pointer}/requestBody`, "the declared body is gone"));
  } else if (baseBody !== undefined && currentBody !== undefined) {
    compareSchema(
      baseBody.content?.["application/json"]?.schema,
      currentBody.content?.["application/json"]?.schema,
      new Set(["request"]),
      `${pointer}/requestBody`,
      findings,
    );
  }

  const baseResponses = base.responses ?? {};
  const currentResponses = current.responses ?? {};
  for (const status of Object.keys(baseResponses)) {
    if (!(status in currentResponses)) {
      findings.push(finding(BREAKING, "response-removed", `${pointer}/responses/${status}`, "status gone"));
      continue;
    }
    compareSchema(
      baseResponses[status].content?.["application/json"]?.schema,
      currentResponses[status].content?.["application/json"]?.schema,
      new Set(["response"]),
      `${pointer}/responses/${status}`,
      findings,
    );
  }
  for (const status of Object.keys(currentResponses)) {
    if (status in baseResponses) continue;
    findings.push(finding(COMPATIBLE, "response-added", `${pointer}/responses/${status}`, "new status"));
  }
}

/** Every difference between a baseline slice and a current slice, classified. */
export function classifyChanges(baseline, current) {
  const findings = [];
  // THE DOCUMENT'S OWN METADATA IS COMPARED TOO, so that `check` and the suite's
  // `assert.deepEqual(baseline, currentSlice())` cannot disagree about what a
  // difference is. Without this an edit to `info.description` would leave the
  // audit green and the named test red, and a gate whose two halves answer
  // differently is a gate nobody trusts. It is COMPATIBLE, not breaking — prose
  // is not a wire contract — but it is material, so it must be absorbed.
  for (const key of ["openapi", "info"]) {
    if (JSON.stringify(baseline[key] ?? null) === JSON.stringify(current[key] ?? null)) continue;
    findings.push(finding(COMPATIBLE, "document-metadata-changed", key, "the document's own header moved"));
  }
  const basePaths = baseline.paths ?? {};
  const currentPaths = current.paths ?? {};
  for (const [path, item] of Object.entries(basePaths)) {
    for (const [method, operation] of Object.entries(item)) {
      const match = currentPaths[path]?.[method];
      const pointer = `${method.toUpperCase()} ${path}`;
      if (match === undefined) {
        findings.push(finding(BREAKING, "operation-removed", pointer, "the route left the derived surface"));
        continue;
      }
      compareOperation(operation, match, pointer, findings);
    }
  }
  for (const [path, item] of Object.entries(currentPaths)) {
    for (const method of Object.keys(item)) {
      if (basePaths[path]?.[method] !== undefined) continue;
      findings.push(finding(COMPATIBLE, "operation-added", `${method.toUpperCase()} ${path}`, "new route"));
    }
  }

  const sides = componentSides(current);
  const baseSchemas = baseline.components?.schemas ?? {};
  const currentSchemas = current.components?.schemas ?? {};
  for (const name of Object.keys(baseSchemas)) {
    if (!(name in currentSchemas)) {
      findings.push(finding(BREAKING, "component-removed", `components/schemas/${name}`, "gone"));
      continue;
    }
    const usedOn = new Set();
    if (sides.request.has(name)) usedOn.add("request");
    if (sides.response.has(name)) usedOn.add("response");
    if (usedOn.size === 0) usedOn.add("response");
    compareSchema(baseSchemas[name], currentSchemas[name], usedOn, `components/schemas/${name}`, findings);
  }
  for (const name of Object.keys(currentSchemas)) {
    if (name in baseSchemas) continue;
    findings.push(finding(COMPATIBLE, "component-added", `components/schemas/${name}`, "new schema"));
  }
  return findings;
}

/** The committed generated document. */
export function committedDocument(repoDir = repositoryRoot) {
  return JSON.parse(
    readFileSync(join(repoDir, "apps", "agent", "src", "openapi", "openapi.generated.json"), "utf8"),
  );
}

/**
 * The slice the SOURCE derives right now, ignoring what was committed.
 *
 * `currentSlice()` reads the committed artifact, which is the right input for
 * the ratchet — it is the document consumers are handed. But a developer who
 * edits a DTO and forgets to regenerate would then be compared against a stale
 * artifact, and this gate would say nothing. So `check` computes BOTH and
 * refuses when they disagree, rather than leaning on the control-plane drift
 * check that happens to run in a later CI step.
 */
export function freshSlice({ repoDir = repositoryRoot, overrides = new Map() } = {}) {
  const document = committedDocument(repoDir);
  return v1Slice(rehydrate(document, deriveRestContract({ repoDir, overrides })));
}

/**
 * How the committed artifact differs from what the source derives right now.
 *
 * Empty means the document is current. `overrides` exists so a named case can
 * prove this refusal FIRES: it hands back one real DTO file with a property
 * deleted and asserts the staleness is seen.
 */
export function stalenessFindings({ repoDir = repositoryRoot, overrides = new Map() } = {}) {
  return classifyChanges(currentSlice({ repoDir }), freshSlice({ repoDir, overrides }));
}

/** The current slice, taken from the committed document. */
export function currentSlice({ repoDir = repositoryRoot, overrides = new Map() } = {}) {
  const document = committedDocument(repoDir);
  if (overrides.size === 0) return v1Slice(document);
  // A MUTATION RUN RE-DERIVES rather than reading the committed artifact, which
  // is what makes the named mutation cases a proof about the SOURCE and not
  // about a JSON file somebody could have edited to match.
  const contract = deriveRestContract({ repoDir, overrides });
  return v1Slice(rehydrate(document, contract));
}

/**
 * Replace a document's derived parts with a freshly derived contract.
 *
 * Only the derived operations and the component schemas move; everything else in
 * the document belongs to the manifest and is irrelevant to the slice.
 */
export function rehydrate(document, contract) {
  const next = structuredClone(document);
  const wireError = next.components.schemas.WireError;
  next.components.schemas = { ...contract.components };
  if (wireError?.properties?.code?.enum !== undefined && next.components.schemas.WireError) {
    next.components.schemas.WireError = {
      ...next.components.schemas.WireError,
      properties: {
        ...next.components.schemas.WireError.properties,
        code: { ...next.components.schemas.WireError.properties.code, enum: wireError.properties.code.enum },
      },
    };
  }
  for (const [path, item] of Object.entries(next.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation["x-platos-schema-source"] !== "typescript-dto") continue;
      const derived = contract.handlers.get(operation.summary);
      if (derived === undefined) {
        // THE HANDLER LEFT THE CONTROLLER. In a real generation run the manifest
        // scan would lose the route too — both read the same decorators — so the
        // faithful simulation is to drop the operation, not to leave the last
        // known schemas standing under a route that no longer exists.
        delete item[method];
        if (Object.keys(item).length === 0) delete next.paths[path];
        continue;
      }
      const responses = {};
      if (derived.responseSchema === null) responses[derived.successStatus] = { description: "No content." };
      else {
        responses[derived.successStatus] = {
          description: "Success.",
          content: { "application/json": { schema: derived.responseSchema } },
        };
      }
      responses.default = operation.responses.default;
      operation.responses = responses;
      if (derived.requestBody === null) delete operation.requestBody;
      else operation.requestBody = { required: true, content: { "application/json": { schema: derived.requestBody } } };
      // THE SAME PROJECTION `generate-control-plane.mjs` PERFORMS, path AND query.
      //
      // It has to be the same one, and M4 finish is the tranche that proved it the
      // hard way: the generator learned to publish derived query parameters, this
      // re-projection did not, and the ratchet immediately reported four
      // `parameter-removed` BREAKING findings against a document that had just
      // gained them. That is the ratchet working — two code paths privately
      // disagreeing about one document is exactly what it exists to catch — and the
      // fix is for this simulation to project what the generator projects.
      const projected = [
        ...derived.pathParameters.map((parameter) => ({
          name: parameter.name,
          in: "path",
          required: true,
          schema: parameter.schema,
        })),
        ...derived.queryParameters.parameters.map((parameter) => ({
          name: parameter.name,
          in: "query",
          required: parameter.required,
          schema: parameter.schema,
        })),
      ];
      if (projected.length > 0) operation.parameters = projected;
      else delete operation.parameters;
      operation["x-platos-query-parameters"] = derived.queryParameters.source;
    }
  }
  return next;
}

export function readBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function render(findings) {
  return findings
    .map((entry) => `  ${entry.severity.padEnd(13)} ${entry.kind.padEnd(28)} ${entry.pointer}  (${entry.detail})`)
    .join("\n");
}

function runCli(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? "check";
  const slice = currentSlice();
  const validation = validateOpenApiDocument(slice);
  if (!validation.valid) {
    process.stderr.write(
      `[openapi-compat] the V1 slice does not validate against the OpenAPI 3.1 meta-schema:\n${JSON.stringify(validation.errors, null, 2)}\n`,
    );
    process.exit(1);
  }
  let baseline = null;
  try {
    baseline = readBaseline();
  } catch {
    baseline = null;
  }
  if (baseline === null) {
    if (mode !== "write") {
      process.stderr.write(`[openapi-compat] no baseline at ${relativeToRoot(BASELINE_PATH)}; run: pnpm generate:openapi-baseline\n`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(slice, null, 2)}\n`);
    process.stderr.write(`[openapi-compat] wrote the first baseline\n`);
    return;
  }
  // THE ARTIFACT MUST STILL BE WHAT THE SOURCE DERIVES. See `freshSlice`.
  const stale = stalenessFindings();
  if (stale.length > 0) {
    const findings = stale;
    process.stderr.write(
      `[openapi-compat] the committed OpenAPI document is STALE against the core-api DTOs:\n${render(findings)}\n` +
        "Run: pnpm --filter platos-agent generate:control-plane\n",
    );
    process.exit(1);
  }
  const decision = decide({ mode, baseline, slice });
  if (decision.action === "write") {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(slice, null, 2)}\n`);
  }
  process.stderr.write(`${decision.message}\n`);
  if (decision.exitCode !== 0) process.exit(decision.exitCode);
}

/**
 * What a mode does with a classified difference, with no filesystem in it.
 *
 * Split out from `runCli` so the refusal itself is testable: a suite can ask
 * "does `write` refuse this slice" without a temporary repository, and
 * `scripts/openapi-compat.test.mjs` does exactly that.
 */
export function decide({ mode, baseline, slice }) {
  const findings = classifyChanges(baseline, slice);
  const breaking = findings.filter((entry) => entry.severity === BREAKING);
  const material = findings.filter((entry) => entry.severity !== INFORMATIONAL);
  if (mode === "write") {
    if (breaking.length > 0) {
      return {
        action: "refused",
        exitCode: 1,
        findings,
        message:
          `[openapi-compat] REFUSING to absorb ${String(breaking.length)} breaking change(s) into the V1 baseline:\n${render(breaking)}\n` +
          "V1 is additive-only (ADR M0.4 section 1). Restore the field, or change the major deliberately by editing the baseline by hand.",
      };
    }
    return {
      action: "write",
      exitCode: 0,
      findings,
      message: `[openapi-compat] baseline updated; ${String(findings.length)} compatible change(s) absorbed`,
    };
  }
  if (breaking.length > 0) {
    return {
      action: "breaking",
      exitCode: 1,
      findings,
      message: `[openapi-compat] ${String(breaking.length)} BREAKING change(s) against the V1 baseline:\n${render(breaking)}`,
    };
  }
  if (material.length > 0) {
    return {
      action: "drift",
      exitCode: 1,
      findings,
      message:
        `[openapi-compat] ${String(material.length)} compatible change(s) not yet absorbed:\n${render(material)}\n` +
        "Run: pnpm generate:openapi-baseline",
    };
  }
  return {
    action: "ok",
    exitCode: 0,
    findings,
    message: `[openapi-compat] ok: ${String(Object.keys(slice.components.schemas).length)} schema(s) over ${String(
      Object.values(slice.paths).reduce((total, item) => total + Object.keys(item).length, 0),
    )} derived operation(s) match the V1 baseline`,
  };
}

function relativeToRoot(path) {
  return path.startsWith(repositoryRoot) ? path.slice(repositoryRoot.length + 1) : path;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCli();

export { runCli, repositoryRoot };
