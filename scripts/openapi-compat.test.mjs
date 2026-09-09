// THE NAMED CASES THAT SEPARATE A BREAKING CHANGE FROM A COMPATIBLE ONE.
//
// WIN-267 W2. The acceptance clause this suite exists to meet, verbatim: "a DTO
// field removed, renamed, or narrowed must turn a NAMED test red, and an added
// optional field must NOT (that is the difference between a breaking change and
// a compatible one, and a guard that cannot tell them apart will be disabled
// within a month)."
//
// The first case below is the STANDING GATE — it compares the committed baseline
// to the contract derived from the tree as it is, and it is the case that goes
// red when somebody actually breaks a V1 DTO. Every case after it is a MUTATION:
// it edits the real `resources.ts`, `organizations.controller.ts` or
// `error-status.ts` in memory, re-derives through the compiler, and asserts what
// the classifier says. Feeding the classifier hand-written schema pairs would
// prove the classifier can read schema pairs; feeding it the real source with
// one line changed proves the whole chain — checker, deriver, slicer, classifier
// — is joined end to end.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PATH,
  BREAKING,
  COMPATIBLE,
  classifyChanges,
  currentSlice,
  decide,
  readBaseline,
  v1Slice,
} from "./openapi-compat.mjs";
import { validateOpenApiDocument } from "../apps/agent/scripts/openapi-meta-schema.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(repositoryRoot, "apps/core-api/src/transports/rest/resources.ts");
const ORGANIZATIONS = join(repositoryRoot, "apps/core-api/src/transports/rest/organizations.controller.ts");
const GENERATED = join(repositoryRoot, "apps/agent/src/openapi/openapi.generated.json");

const read = (path) => readFileSync(path, "utf8");
const baseline = readBaseline();

/** Re-derive the V1 slice with one real source file edited in memory. */
function sliceWith(path, mutate) {
  const original = read(path);
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `the mutation of ${path} did not apply`);
  return currentSlice({ overrides: new Map([[path, mutated]]) });
}

const breakingOf = (findings) => findings.filter((entry) => entry.severity === BREAKING);

test("the committed V1 baseline records no breaking change against the current DTOs", () => {
  const findings = classifyChanges(baseline, currentSlice());
  assert.deepEqual(breakingOf(findings), []);
});

test("the committed V1 baseline is exactly the slice the tree derives", () => {
  assert.deepEqual(baseline, currentSlice());
});

test("the V1 baseline is itself a valid OpenAPI 3.1 document", () => {
  assert.deepEqual(validateOpenApiDocument(baseline).errors, []);
});

test("the baseline covers every operation the document derives, and only those", () => {
  const document = JSON.parse(readFileSync(GENERATED, "utf8"));
  const derived = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation["x-platos-schema-source"] === "typescript-dto") derived.push(`${method} ${path}`);
    }
  }
  const covered = [];
  for (const [path, item] of Object.entries(baseline.paths)) {
    for (const method of Object.keys(item)) covered.push(`${method} ${path}`);
  }
  assert.deepEqual(covered.sort(), derived.sort());
  assert.ok(covered.length > 0, "the baseline is empty; the gate would be vacuous");
});

/* --- the four mutations the acceptance clause names ---------------------- */

test("REMOVING a field from a V1 response DTO is BREAKING", () => {
  const slice = sliceWith(RESOURCES, (text) => text.replace("  readonly email: string;\n", ""));
  const kinds = breakingOf(classifyChanges(baseline, slice)).map((entry) => entry.kind);
  assert.ok(kinds.includes("property-removed"), JSON.stringify(kinds));
  assert.ok(kinds.includes("required-dropped"), JSON.stringify(kinds));
});

test("RENAMING a field in a V1 response DTO is BREAKING", () => {
  const slice = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", "  readonly emailAddress: string;"),
  );
  const findings = classifyChanges(baseline, slice);
  const removed = breakingOf(findings).find((entry) => entry.kind === "property-removed");
  assert.ok(removed !== undefined, "a rename did not read as a removal");
  assert.match(removed.pointer, /OperatorSessionResource\/properties\/email$/);
  assert.ok(findings.some((entry) => entry.severity === COMPATIBLE && entry.kind === "property-added"));
});

test("NARROWING a V1 response field to a closed set is BREAKING", () => {
  const slice = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", '  readonly email: "primary" | "secondary";'),
  );
  const kinds = breakingOf(classifyChanges(baseline, slice)).map((entry) => entry.kind);
  assert.ok(kinds.includes("enum-introduced"), JSON.stringify(kinds));
});

test("NARROWING a V1 response field by admitting null is BREAKING", () => {
  const slice = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", "  readonly email: string | null;"),
  );
  const kinds = breakingOf(classifyChanges(baseline, slice)).map((entry) => entry.kind);
  assert.ok(kinds.includes("type-changed"), JSON.stringify(kinds));
});

test("ADDING AN OPTIONAL FIELD to a V1 response DTO is NOT breaking", () => {
  const slice = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", "  readonly email: string;\n  readonly nickname?: string;"),
  );
  const findings = classifyChanges(baseline, slice);
  assert.deepEqual(breakingOf(findings), []);
  assert.ok(findings.some((entry) => entry.kind === "property-added" && entry.severity === COMPATIBLE));
});

test("ADDING A REQUIRED FIELD to a V1 response DTO is NOT breaking", () => {
  // A response promising MORE is a promise a client can ignore. This is the
  // asymmetry the request-side case below exists to contrast with.
  const slice = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", "  readonly email: string;\n  readonly locale: string;"),
  );
  assert.deepEqual(breakingOf(classifyChanges(baseline, slice)), []);
});

/* --- the request side, where the variance flips -------------------------- */

test("ADDING A REQUIRED FIELD to a V1 request DTO is BREAKING", () => {
  const slice = sliceWith(ORGANIZATIONS, (text) =>
    text.replace(
      "export interface CreateOrganizationBody {\n  readonly name: string;",
      "export interface CreateOrganizationBody {\n  readonly region: string;\n  readonly name: string;",
    ),
  );
  const findings = breakingOf(classifyChanges(baseline, slice));
  assert.ok(
    findings.some((entry) => entry.kind === "required-added" && entry.pointer.endsWith("/region")),
    JSON.stringify(findings),
  );
});

test("ADDING AN OPTIONAL FIELD to a V1 request DTO is NOT breaking", () => {
  const slice = sliceWith(ORGANIZATIONS, (text) =>
    text.replace(
      "export interface CreateOrganizationBody {\n  readonly name: string;",
      "export interface CreateOrganizationBody {\n  readonly region?: string;\n  readonly name: string;",
    ),
  );
  assert.deepEqual(breakingOf(classifyChanges(baseline, slice)), []);
});

test("REMOVING a field from a V1 request DTO is BREAKING", () => {
  const slice = sliceWith(ORGANIZATIONS, (text) => text.replace("  readonly slug: string;\n", ""));
  const kinds = breakingOf(classifyChanges(baseline, slice)).map((entry) => entry.kind);
  assert.ok(kinds.includes("property-removed"), JSON.stringify(kinds));
});

/* --- the whole route, and the envelope ------------------------------------ */

test("REMOVING a V1 route from the derived surface is BREAKING", () => {
  const slice = sliceWith(ORGANIZATIONS, (text) => text.replace("  @Get()", "  // @Get()"));
  const kinds = breakingOf(classifyChanges(baseline, slice)).map((entry) => entry.kind);
  assert.ok(kinds.includes("operation-removed"), JSON.stringify(kinds));
});

test("REMOVING a field from the failure envelope is BREAKING", () => {
  const errorStatus = join(repositoryRoot, "apps/core-api/src/transports/error-status.ts");
  const slice = sliceWith(errorStatus, (text) =>
    text.replace("  readonly traceRef: string;\n", ""),
  );
  const findings = breakingOf(classifyChanges(baseline, slice));
  assert.ok(
    findings.some((entry) => entry.pointer === "components/schemas/WireError/properties/traceRef"),
    JSON.stringify(findings),
  );
});

/* --- the enum rule, stated in the module banner and proved here ---------- */

test("WIDENING the canonical error-code enum is compatible; NARROWING it is breaking", () => {
  const widened = structuredClone(baseline);
  widened.components.schemas.WireError.properties.code.enum = [
    ...baseline.components.schemas.WireError.properties.code.enum,
    "A_BRAND_NEW_CODE",
  ];
  assert.deepEqual(breakingOf(classifyChanges(baseline, widened)), []);
  assert.ok(classifyChanges(baseline, widened).some((entry) => entry.kind === "enum-widened"));

  const narrowed = structuredClone(baseline);
  narrowed.components.schemas.WireError.properties.code.enum =
    baseline.components.schemas.WireError.properties.code.enum.slice(1);
  const kinds = breakingOf(classifyChanges(baseline, narrowed)).map((entry) => entry.kind);
  assert.ok(kinds.includes("enum-narrowed"), JSON.stringify(kinds));
});

test("CHANGING a route's security is BREAKING", () => {
  const [path] = Object.keys(baseline.paths);
  const [method] = Object.keys(baseline.paths[path]);
  const mutated = structuredClone(baseline);
  mutated.paths[path][method].security = [{ somethingElse: [] }];
  const kinds = breakingOf(classifyChanges(baseline, mutated)).map((entry) => entry.kind);
  assert.ok(kinds.includes("security-changed"), JSON.stringify(kinds));
});

/* --- the ratchet itself --------------------------------------------------- */

test("`write` REFUSES to absorb a breaking change, and accepts a compatible one", () => {
  const broken = sliceWith(RESOURCES, (text) => text.replace("  readonly email: string;\n", ""));
  const refusal = decide({ mode: "write", baseline, slice: broken });
  assert.equal(refusal.action, "refused");
  assert.equal(refusal.exitCode, 1);
  assert.match(refusal.message, /REFUSING to absorb/);

  const compatible = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", "  readonly email: string;\n  readonly nickname?: string;"),
  );
  const accepted = decide({ mode: "write", baseline, slice: compatible });
  assert.equal(accepted.action, "write");
  assert.equal(accepted.exitCode, 0);
});

test("`check` fails on compatible drift and passes on an unchanged tree", () => {
  const slice = currentSlice();
  assert.equal(decide({ mode: "check", baseline, slice }).action, "ok");
  const drifted = sliceWith(RESOURCES, (text) =>
    text.replace("  readonly email: string;", "  readonly email: string;\n  readonly nickname?: string;"),
  );
  const decision = decide({ mode: "check", baseline, slice: drifted });
  assert.equal(decision.action, "drift");
  assert.equal(decision.exitCode, 1);
});

test("an edit to the document's own header is material to `check`, so the audit and this suite agree", () => {
  const edited = structuredClone(baseline);
  edited.info = { ...edited.info, description: "something else entirely" };
  const decision = decide({ mode: "check", baseline, slice: edited });
  assert.equal(decision.action, "drift", "a header edit would have left the audit green and this suite red");
  assert.deepEqual(breakingOf(decision.findings), []);
});

test("the slice keeps only contract-bearing keys, so a refactor of a class name is not a change", () => {
  const document = JSON.parse(readFileSync(GENERATED, "utf8"));
  const slice = v1Slice(document);
  const [path] = Object.keys(slice.paths);
  const [method] = Object.keys(slice.paths[path]);
  const keys = Object.keys(slice.paths[path][method]);
  assert.ok(!keys.includes("summary"), "the handler's class.method name is not part of the wire contract");
  assert.ok(!keys.includes("tags"));
  assert.ok(keys.includes("responses"));
  assert.equal(BASELINE_PATH.endsWith("docs/openapi-v1-baseline.json"), true);
});
