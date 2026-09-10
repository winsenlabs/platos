// THE GATE THAT PROVES THE GENERATED SDK IS JOINED TO THE CONTRACT.
//
// WIN-270 (M4.4). `audit:sdk-v1` green means the committed clients equal what
// the generator emits today. That is necessary and it is not sufficient: a
// generator that read none of its inputs would also be green, forever, and
// would emit the same three files whatever happened upstream. So every case
// below PERTURBS ONE REAL INPUT — the actual file, edited in memory — and
// asserts the emitted artifact moves. A gate nobody has seen fire is a gate
// nobody should trust.
//
// The perturbations are chosen to be the ones that matter:
//
//   the idempotency class      a mint reclassified `exempt` must stop carrying
//                              an `Idempotency-Key`, in BOTH languages and in
//                              the fixture. This is the join to
//                              `apps/core-api/src/http/idempotency-policy.ts`,
//                              which no SDK file restates.
//   a response field           deleting one from the OpenAPI document must
//                              delete it from both emitted type declarations.
//   the header name            renaming `IDEMPOTENCY_KEY_HEADER` must rename it
//                              in both clients.
//   an operation               dropping one from the manifest must drop it from
//                              the emitted namespaces.
//
// THE PYTHON HALF RUNS HERE. `packages/platos-client-py/tests/test_v1_contract.py`
// imports nothing but the standard library and carries its own runner, so this
// file executes it with `python3` and fails on its exit code. Without that the
// cross-language fixture would be read by one language in CI and the other only
// on somebody's laptop, which is not a cross-language fixture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  FIXTURE_OUTPUT,
  OPENAPI_PATH,
  POLICY_HEADER_PATH,
  POLICY_PATH,
  MANIFEST_PATH,
  PYTHON_OUTPUT,
  TYPESCRIPT_OUTPUT,
  buildArtifacts,
  classifyTemplate,
  readIdempotencyHeader,
  readIdempotencyPolicy,
  repositoryRoot,
} from "./v1-contract.mjs";

const relativeTo = (absolute) => absolute.slice(repositoryRoot.length + 1);
const KEYS = {
  openapi: relativeTo(OPENAPI_PATH),
  manifest: relativeTo(MANIFEST_PATH),
  policy: relativeTo(POLICY_PATH),
  header: relativeTo(POLICY_HEADER_PATH),
};

const sourceText = (key) => readFileSync(join(repositoryRoot, key), "utf8");
const emit = (overrides = new Map()) => buildArtifacts({ overrides });
const baseline = emit();
const fixtureOf = (artifacts) => JSON.parse(artifacts[FIXTURE_OUTPUT]);

test("the committed artifacts are what the contract emits", () => {
  for (const path of [TYPESCRIPT_OUTPUT, PYTHON_OUTPUT, FIXTURE_OUTPUT]) {
    assert.ok(existsSync(path), `${relativeTo(path)} is missing`);
    assert.equal(
      readFileSync(path, "utf8"),
      baseline[path],
      `${relativeTo(path)} differs from the contract; run pnpm generate:sdk-v1`,
    );
  }
});

test("the idempotency policy is READ, not restated: reclassifying a mint moves all three artifacts", () => {
  const policy = readIdempotencyPolicy(sourceText(KEYS.policy));
  // The policy table's own rows carry a method too, and the mint is the POST.
  const mint = policy.rows.find(
    (row) => row.template === "/mcp/platform/tokens" && row.method === "POST",
  );
  assert.ok(mint !== undefined, "the platform token mint is no longer in the policy table");
  assert.equal(mint.class, "required");

  // MATCHED ON THE METHOD AS WELL AS THE TEMPLATE, and WIN-268 (M4.2)'s token
  // lifecycle is why. `GET /mcp/platform/tokens` is now a V1 operation too, so a
  // template-only `find` returns whichever of the two the fixture happens to list
  // first — and it returned the GET, whose idempotency class is `not-applicable`
  // because a read mints nothing. The case then failed while asserting something
  // true of a route it was not looking at, which is the worst shape of green.
  const before = fixtureOf(baseline).operations.find(
    (entry) => entry.template === "/mcp/platform/tokens" && entry.method === "POST",
  );
  assert.ok(before !== undefined, "the platform token mint is no longer in the fixture");
  assert.equal(before.idempotency, "required");
  assert.equal(before.expected.sendsIdempotencyKey, true);

  // The REAL file, with the one word changed.
  const mutated = sourceText(KEYS.policy).replace(
    /template: "\/mcp\/platform\/tokens",\n(\s*)class: "required",/u,
    'template: "/mcp/platform/tokens",\n$1class: "exempt",',
  );
  assert.notEqual(mutated, sourceText(KEYS.policy), "the mutation did not apply");

  const artifacts = emit(new Map([[KEYS.policy, mutated]]));
  const after = fixtureOf(artifacts).operations.find(
    (entry) => entry.template === "/mcp/platform/tokens" && entry.method === "POST",
  );
  assert.equal(after.idempotency, "exempt");
  assert.equal(after.expected.sendsIdempotencyKey, false);
  assert.match(artifacts[TYPESCRIPT_OUTPUT], /template: "\/mcp\/platform\/tokens",\n\s*pathParameters: \[\],\n\s*successStatus: 201,\n\s*idempotency: "exempt",/u);
  assert.match(artifacts[PYTHON_OUTPUT], /"template": "\/mcp\/platform\/tokens",\n\s*"pathParameters": \[\],\n\s*"successStatus": 201,\n\s*"idempotency": "exempt",/u);
});

test("a response field deleted from the document disappears from both emitted clients", () => {
  assert.match(baseline[TYPESCRIPT_OUTPUT], /readonly "email": string;/u);
  assert.match(baseline[PYTHON_OUTPUT], /^ {4}email: str$/mu);

  const document = JSON.parse(sourceText(KEYS.openapi));
  delete document.components.schemas.OperatorSessionResource.properties.email;
  document.components.schemas.OperatorSessionResource.required =
    document.components.schemas.OperatorSessionResource.required.filter((name) => name !== "email");

  const artifacts = emit(new Map([[KEYS.openapi, JSON.stringify(document)]]));
  assert.doesNotMatch(artifacts[TYPESCRIPT_OUTPUT], /readonly "email": string;/u);
  assert.doesNotMatch(artifacts[PYTHON_OUTPUT], /^ {4}email: str$/mu);
});

test("the idempotency header name is READ from core-api, not written here", () => {
  const header = readIdempotencyHeader(sourceText(KEYS.header));
  assert.equal(fixtureOf(baseline).idempotencyKeyHeader, header);

  const mutated = sourceText(KEYS.header).replace(
    /IDEMPOTENCY_KEY_HEADER = "[^"]+"/u,
    'IDEMPOTENCY_KEY_HEADER = "x-win270-probe-key"',
  );
  const artifacts = emit(new Map([[KEYS.header, mutated]]));
  assert.equal(fixtureOf(artifacts).idempotencyKeyHeader, "x-win270-probe-key");
  assert.match(artifacts[TYPESCRIPT_OUTPUT], /IDEMPOTENCY_KEY_HEADER = "x-win270-probe-key"/u);
  assert.match(artifacts[PYTHON_OUTPUT], /IDEMPOTENCY_KEY_HEADER = "x-win270-probe-key"/u);
});

test("an operation removed from the manifest leaves both emitted clients", () => {
  assert.match(baseline[TYPESCRIPT_OUTPUT], /class ProjectsV1Api/u);
  const manifest = JSON.parse(sourceText(KEYS.manifest));
  manifest.inventories.restOperations = manifest.inventories.restOperations.filter(
    (operation) => operation.path !== "/api/v1/projects",
  );
  const artifacts = emit(new Map([[KEYS.manifest, JSON.stringify(manifest)]]));
  assert.doesNotMatch(artifacts[TYPESCRIPT_OUTPUT], /class ProjectsV1Api/u);
  assert.doesNotMatch(artifacts[PYTHON_OUTPUT], /class ProjectsV1Api/u);
  assert.equal(
    fixtureOf(artifacts).operations.filter((entry) => entry.template === "/api/v1/projects").length,
    0,
  );
});

test("a table the parser cannot read is a refusal, never a smaller policy", () => {
  const withoutTable = sourceText(KEYS.policy).replace(/OPERATION_POLICIES/gu, "RENAMED_TABLE");
  assert.throws(
    () => readIdempotencyPolicy(withoutTable),
    /no longer declares OPERATION_POLICIES/u,
  );
  // A table that PARSES but yields nothing is the dangerous case: it would emit
  // clients that send no key at all. It is a refusal, not an empty policy.
  const emptyTable = sourceText(KEYS.policy).replace(
    /OPERATION_POLICIES[^=]*=\s*Object\.freeze\(\[[\s\S]*?\n\]\);/u,
    "OPERATION_POLICIES = Object.freeze([\n]);",
  );
  assert.throws(() => readIdempotencyPolicy(emptyTable), /parsed as empty/u);
  assert.throws(
    () => readIdempotencyPolicy(sourceText(KEYS.policy).replace(/SIDE_EFFECTING_METHODS/gu, "RENAMED")),
    /no longer declares SIDE_EFFECTING_METHODS/u,
  );
  assert.throws(
    () => readIdempotencyHeader("export const SOMETHING_ELSE = \"x\";"),
    /no longer declares IDEMPOTENCY_KEY_HEADER/u,
  );
});

test("classification over templates matches the table it was read from", () => {
  const policy = readIdempotencyPolicy(sourceText(KEYS.policy));
  for (const row of policy.rows) {
    assert.equal(classifyTemplate(row.method, row.template, policy), row.class, row.template);
  }
  // A side-effecting operation nobody classified defaults to `accepted`, and a
  // read is `not-applicable`. Both are the documented defaults of
  // `classifyRequest`, and both are what the emitted clients act on.
  assert.equal(classifyTemplate("POST", "/api/v1/win270/not-a-real-route", policy), "accepted");
  assert.equal(classifyTemplate("GET", "/api/v1/win270/not-a-real-route", policy), "not-applicable");
});

test("the emitted fixture drives the Python client too", () => {
  const suite = join(
    repositoryRoot,
    "packages",
    "platos-client-py",
    "tests",
    "test_v1_contract.py",
  );
  assert.ok(existsSync(suite), "the Python contract suite is missing");
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    // SKIPPED, AND NAMED. There is no interpreter on this machine; the suite is
    // not silently passed, and CI's `ubuntu-latest` image ships one, so this
    // branch is a developer-laptop condition rather than a hole in the gate.
    assert.ok(true);
    console.log("# SKIP python3 is not on PATH; the Python half of the fixture did not run");
    return;
  }
  // `-S -I`: NO site-packages AND no inherited environment. The suite claims to
  // need nothing but the standard library, and this is what turns that claim
  // into a measurement — with site-packages on the path an `httpx` that happened
  // to be installed would hide an import the runner does not have. It also
  // proves the claim for the package: `import platos_client.errors` used to
  // execute `platos_client/__init__.py`, which imported `httpx` and
  // `websockets`, so the suite was only standard-library on a machine that had
  // them. That import is lazy now.
  const run = spawnSync("python3", ["-S", "-I", suite], { encoding: "utf8", cwd: repositoryRoot });
  assert.equal(
    run.status,
    0,
    `the Python V1 contract suite failed:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`,
  );
  assert.match(run.stderr ?? "", /python V1 contract cases passed/u);
  assert.doesNotMatch(run.stderr ?? "", /^0\//mu, "the Python runner collected no cases");

  // AND THE PACKAGE'S OWN ENTRY POINT, under the same restriction. A caller that
  // wants `PlatosError` should not have to install an async HTTP stack, and
  // before WIN-270 it did.
  const entry = spawnSync(
    "python3",
    [
      "-S",
      "-I",
      "-c",
      // `-I` keeps the working directory OFF `sys.path`, which is the point of
      // it, so the package root is put back explicitly and nothing else is.
      "import sys; sys.path.insert(0, '.'); import platos_client; print(platos_client.PlatosRefusal.__name__)",
    ],
    { encoding: "utf8", cwd: join(repositoryRoot, "packages", "platos-client-py") },
  );
  assert.equal(
    entry.status,
    0,
    `importing platos_client without site-packages failed:\n${entry.stdout ?? ""}\n${entry.stderr ?? ""}`,
  );
  assert.match(entry.stdout ?? "", /PlatosRefusal/u);
});
