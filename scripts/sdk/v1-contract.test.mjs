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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  FIXTURE_OUTPUT,
  OPENAPI_PATH,
  POLICY_HEADER_PATH,
  POLICY_PATH,
  MANIFEST_PATH,
  PYTHON_OUTPUT,
  SSE_TRANSPORT_PATH,
  STREAM_FRAME_PATH,
  TYPESCRIPT_OUTPUT,
  buildArtifacts,
  classifyTemplate,
  readEventStreamHandlers,
  readIdempotencyHeader,
  readIdempotencyPolicy,
  readSseTransport,
  readStreamVocabulary,
  repositoryRoot,
} from "./v1-contract.mjs";

const relativeTo = (absolute) => absolute.slice(repositoryRoot.length + 1);
const KEYS = {
  openapi: relativeTo(OPENAPI_PATH),
  manifest: relativeTo(MANIFEST_PATH),
  policy: relativeTo(POLICY_PATH),
  header: relativeTo(POLICY_HEADER_PATH),
  sse: relativeTo(SSE_TRANSPORT_PATH),
  streamFrame: relativeTo(STREAM_FRAME_PATH),
  streamsController: "apps/core-api/src/transports/ws/streams.controller.ts",
  sessionController: "apps/core-api/src/transports/bff/session.controller.ts",
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
  // SCOPED TO THE ONE TYPE THE MUTATION EDITS (2026-09-15). This read the whole
  // emitted file for `email`, which held while `OperatorSessionResource` was the
  // only V1 type carrying one. The identity/tenancy remainder added four more
  // (`MagicLinkRequestResource`, `StartMagicLinkBody`, `IssueInvitationBody` and the
  // nullable one on `OrganizationMemberResource`), so a whole-file match kept
  // passing after the deletion — a probe that could no longer fail. Reading the one
  // declaration restores it.
  const tsBlock = (text) => /export interface OperatorSessionResource \{[^}]*\}/u.exec(text)?.[0] ?? "";
  const pyBlock = (text) => /class OperatorSessionResource\(TypedDict\):\n(?: {4}.*\n)+/u.exec(text)?.[0] ?? "";
  assert.match(tsBlock(baseline[TYPESCRIPT_OUTPUT]), /readonly "email": string;/u);
  assert.match(pyBlock(baseline[PYTHON_OUTPUT]), /^ {4}email: str$/mu);

  const document = JSON.parse(sourceText(KEYS.openapi));
  delete document.components.schemas.OperatorSessionResource.properties.email;
  document.components.schemas.OperatorSessionResource.required =
    document.components.schemas.OperatorSessionResource.required.filter((name) => name !== "email");

  const artifacts = emit(new Map([[KEYS.openapi, JSON.stringify(document)]]));
  assert.notEqual(tsBlock(artifacts[TYPESCRIPT_OUTPUT]), "");
  assert.notEqual(pyBlock(artifacts[PYTHON_OUTPUT]), "");
  assert.doesNotMatch(tsBlock(artifacts[TYPESCRIPT_OUTPUT]), /readonly "email": string;/u);
  assert.doesNotMatch(pyBlock(artifacts[PYTHON_OUTPUT]), /^ {4}email: str$/mu);
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

// WIN-272 (M4.6). WHICH operations are event streams is READ off core-api's handlers,
// and the wire facts off `sse.ts` and the kernel. Each case perturbs the real file.
test("an event-stream operation is found on core-api's handlers and emitted as a streaming method", () => {
  const stream = fixtureOf(baseline).operations.find((entry) => entry.responseKind === "event-stream");
  assert.ok(stream, "no operation is an event stream; the join to core-api's SSE lane is gone");
  assert.equal(stream.expected.accept, "text/event-stream");
  assert.equal(fixtureOf(baseline).operations.filter((entry) => entry.responseKind === "event-stream").length, 1);
  assert.match(baseline[TYPESCRIPT_OUTPUT], /read\(environmentId: string, streamId: string, options\?: V1StreamOptions\): V1EventStream \{\n\s*return this\.transport\.stream\(/u);
  assert.doesNotMatch(baseline[TYPESCRIPT_OUTPUT], /transport\.send<void>\(\{\n\s*operation: operation\("get__api_v1_environments_by_environmentId_streams_by_streamId"\)/u);
  assert.match(baseline[PYTHON_OUTPUT], /def read\(self, environment_id: str, stream_id: str, \*\*options: Any\) -> Any:[\s\S]*?return self\._transport\.stream\(/u);

  // The handler stops opening a stream: the generator refuses rather than emit a JSON call.
  const withoutOpener = sourceText(KEYS.streamsController).replace(/openEventStream\(response\);/u, "void response;");
  assert.notEqual(withoutOpener, sourceText(KEYS.streamsController), "the mutation did not apply");
  assert.throws(() => emit(new Map([[KEYS.streamsController, withoutOpener]])), /calls openEventStream; the event-stream join is gone/u);

  // A void JSON handler starts opening one: it becomes a streaming method in both languages.
  const session = sourceText(KEYS.sessionController);
  const opened = session.replace(/(async signOut\([\s\S]*?\): Promise<void> \{)/u, "$1\n    openEventStream(response);");
  assert.notEqual(opened, session, "the mutation did not apply");
  const moved = emit(new Map([[KEYS.sessionController, opened]]));
  const signOut = fixtureOf(moved).operations.find((entry) => entry.operationId === "delete__api_v1_bff_session");
  assert.equal(signOut.responseKind, "event-stream");
  assert.match(moved[TYPESCRIPT_OUTPUT], /signOut\(options\?: V1StreamOptions\): V1EventStream/u);
  assert.match(moved[PYTHON_OUTPUT], /def sign_out\(self, \*\*options: Any\) -> Any:/u);
});

test("a handler that opens a stream while the document declares a JSON body is a refusal", () => {
  const path = "apps/core-api/src/transports/rest/organizations.controller.ts";
  const controller = readFileSync(join(repositoryRoot, path), "utf8");
  const opened = controller.replace(/(async list\([\s\S]*?\): Promise<[^>]*>> \{)/u, "$1\n    openEventStream(response);");
  assert.notEqual(opened, controller, "the mutation did not apply");
  assert.throws(() => emit(new Map([[path, opened]])), /OrganizationsController\.list opens an event stream, but the document declares a JSON response body/u);
});

test("a call on the AST counts; a mention in a comment or a string does not", () => {
  const handlers = readEventStreamHandlers(
    [
      {
        path: "probe.ts",
        text: [
          "class ProbeController {",
          "  commented() { /* openEventStream(response) */ }",
          '  quoted() { return "openEventStream(response)"; }',
          "  called(response: unknown) { if (response) openEventStream(response); }",
          "}",
        ].join("\n"),
      },
    ],
    "openEventStream",
  );
  assert.deepEqual([...handlers.keys()], ["ProbeController.called"]);
});

test("the wire facts are READ off sse.ts and the kernel, and both emitted clients move with them", () => {
  const facts = readSseTransport(sourceText(KEYS.sse));
  assert.deepEqual(facts, {
    opener: "openEventStream",
    mediaType: "text/event-stream",
    resumeHeader: "last-event-id",
    metaEvent: "stream_meta",
  });
  assert.deepEqual(fixtureOf(baseline).stream, {
    mediaType: facts.mediaType,
    resumeHeader: facts.resumeHeader,
    metaEvent: facts.metaEvent,
    ...readStreamVocabulary(sourceText(KEYS.streamFrame)),
  });

  const header = sourceText(KEYS.sse).replace('request.headers["last-event-id"]', 'request.headers["x-win272-probe-resume"]');
  assert.notEqual(header, sourceText(KEYS.sse), "the mutation did not apply");
  const movedHeader = emit(new Map([[KEYS.sse, header]]));
  assert.match(movedHeader[TYPESCRIPT_OUTPUT], /LAST_EVENT_ID_HEADER = "x-win272-probe-resume"/u);
  assert.match(movedHeader[PYTHON_OUTPUT], /LAST_EVENT_ID_HEADER = "x-win272-probe-resume"/u);

  const terminal = sourceText(KEYS.streamFrame).replace(
    /(export const TERMINAL_FRAME_TYPES = Object\.freeze\(\[[^\]]*"stream\.offline",\n)/u,
    '$1  "turn.cancelled",\n',
  );
  assert.notEqual(terminal, sourceText(KEYS.streamFrame), "the mutation did not apply");
  const movedTerminal = emit(new Map([[KEYS.streamFrame, terminal]]));
  assert.match(movedTerminal[TYPESCRIPT_OUTPUT], /TERMINAL_FRAME_TYPES = \["turn\.done", "stream\.error", "stream\.offline", "turn\.cancelled"\] as const;/u);
  assert.match(movedTerminal[PYTHON_OUTPUT], /TERMINAL_FRAME_TYPES: tuple\[str, \.\.\.\] = \("turn\.done", "stream\.error", "stream\.offline", "turn\.cancelled",\)/u);

  assert.throws(
    () => emit(new Map([[KEYS.streamFrame, sourceText(KEYS.streamFrame).replace(/export const STREAM_SCHEMA_VERSION_MAX = \d+;/u, "")]])),
    /no longer declares STREAM_SCHEMA_VERSION_MAX/u,
  );
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

  // WIN-272 (M4.6): the Python event-stream reader, against the resume fixture the
  // TypeScript suite joins to core-api's encoders and the kernel. Same restriction.
  const streamSuite = join(repositoryRoot, "packages", "platos-client-py", "tests", "test_v1_stream.py");
  assert.ok(existsSync(streamSuite), "the Python stream suite is missing");
  const streamRun = spawnSync("python3", ["-S", "-I", streamSuite], { encoding: "utf8", cwd: repositoryRoot });
  assert.equal(
    streamRun.status,
    0,
    `the Python V1 stream suite failed:\n${streamRun.stdout ?? ""}\n${streamRun.stderr ?? ""}`,
  );
  assert.match(streamRun.stderr ?? "", /^[1-9]\d*\/\d+ python V1 stream cases passed$/mu);

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

// THE SDK GATES ARE WIRED INTO CI, AND NOTHING THERE PUBLISHES.
//
// WIN-270 (M4.4). The platools suites, the Python setup they need and the
// changeset gate are separate steps of the typecheck job, and a step can be
// deleted in one quiet edit. This file already runs inside the V1 evidence step
// that `scripts/ci-policy.test.mjs` pins command by command, so asserting the
// wiring HERE means deleting one of those steps turns a protected gate red.
// Founder decision D15: publication from this repository stays forbidden, so no
// workflow step may run a publish.
test("CI runs both platools suites and the changeset gate, and publishes nothing", async () => {
  const { parse } = await import("yaml");
  const workflows = join(repositoryRoot, ".github", "workflows");
  const ci = parse(readFileSync(join(workflows, "ci.yml"), "utf8"));
  const steps = ci.jobs.typecheck.steps;
  const runsOf = (step) =>
    String(step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const stepRunning = (command) => steps.find((step) => runsOf(step).includes(command));

  assert.ok(stepRunning("pnpm --filter @platosdev/platools-sdk test"), "no step runs the platools-js suite");

  const pytest = stepRunning("python -m pytest -p no:cacheprovider");
  assert.ok(pytest, "no step runs the platools-py suite");
  assert.equal(pytest["working-directory"], "packages/platools-py");
  assert.ok(
    runsOf(pytest).includes("python -m pip install --require-hashes --no-deps -r requirements-ci.txt"),
    "the platools-py dependencies are not installed from the hashed lock",
  );
  const python = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/setup-python@"));
  assert.ok(python >= 0 && python < steps.indexOf(pytest), "Python is not set up before the pytest step");
  assert.match(steps[python].uses, /^actions\/setup-python@[0-9a-f]{40}$/u, "setup-python is not pinned by commit");
  assert.match(String(steps[python].with?.["python-version"]), /^\d+\.\d+\.\d+$/u, "the interpreter is not pinned exactly");

  const gate = stepRunning('pnpm audit:changesets --base "$CHANGESET_GATE_BASE"');
  assert.ok(gate, "no step runs the changeset gate");
  assert.ok(runsOf(gate).includes("pnpm test:changesets"), "the changeset gate's own suite does not run");
  assert.equal(
    gate.env?.CHANGESET_GATE_BASE,
    "${{ github.event.pull_request.base.sha || github.event.before }}",
  );
  assert.equal(ci.jobs.typecheck.steps[0].with?.["fetch-depth"], 0, "the merge base needs full history");

  const names = readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name));
  assert.ok(names.includes("ci.yml") && names.length > 1, "the workflow directory listing is wrong");
  for (const name of names) {
    const text = readFileSync(join(workflows, name), "utf8");
    assert.doesNotMatch(text, /changeset\s+publish|npm\s+publish|pnpm\s+publish|twine\s+upload|uv\s+publish/u, name);
  }
});
