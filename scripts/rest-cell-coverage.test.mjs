// WIN-267 — the controls on the per-REST-cell register.
//
// The audit half (`--check`) proves the committed register still matches the
// tree. On its own that is a gate nobody has watched go red: a join that had
// stopped joining would regenerate to a smaller register and `--check` would
// agree with it as soon as somebody ran `--write`. These cases are the other
// half. They drive `buildRegister` over SYNTHETIC cells, manifests and test
// sources, so every branch of the two evidence kinds — and every refusal — is
// exercised without a repository behind it, and each control states the
// mutation it survives.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_KINDS,
  JSON_PATH,
  M31_CONTROLLER,
  M31_OWNER,
  STATUSES,
  TEST_FILE_PATTERN,
  buildRegister,
  callsHandler,
  enumerateTestFiles,
  extractControllerBindings,
  extractHttpCallSites,
  extractLocalTemplates,
  matchesRouteTemplate,
  normalisePathExpression,
  registerDigest,
  summarise,
} from "./rest-cell-coverage.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function cell(id, method, path, owner = "tenancy") {
  return { id, method, path, owner, requiresOperator: true };
}

function operation(id, method, path, implementations) {
  return { id, method, path, implementations };
}

function file(path, text) {
  return { path, text };
}

// ---------------------------------------------------------------------------
// The `handler` kind
// ---------------------------------------------------------------------------

test("controller bindings are the ones a suite instantiates or resolves, not every capitalised word", () => {
  // THE NAMES ARE FICTIONAL, AND THAT IS NOT COSMETIC. This file is READ by the
  // register it tests — `enumerateTestFiles` walks the whole index — so a fixture
  // naming a real controller and a real handler would join a real cell and this
  // suite would inflate the coverage it exists to measure. A case below asserts
  // the committed register cites nothing from this file.
  const bound = extractControllerBindings(`
    import { FixtureJobsController } from "./fixture-jobs.controller";
    const controller = new FixtureJobsController(prisma, auth);
    const other = module.get(FixtureSkillsController);
    const third = app.resolve(FixtureFilesController);
    let typed: FixtureMemoryController;
    const notAController = new FixtureJobsService(prisma);
  `);
  assert.deepEqual([...bound].sort(), [
    "FixtureFilesController",
    "FixtureJobsController",
    "FixtureMemoryController",
    "FixtureSkillsController",
  ]);
});

test("a handler join needs the call, not merely the import", () => {
  assert.equal(callsHandler("controller.fixtureList(request)", "fixtureList"), true);
  assert.equal(callsHandler("controller.fixtureListForAgent(request)", "fixtureList"), false);
  assert.equal(callsHandler("// fixtureList is not called here", "fixtureList"), false);
});

// ---------------------------------------------------------------------------
// The `http` kind
// ---------------------------------------------------------------------------

test("local path builders are resolved one level, in all three forms", () => {
  const templates = extractLocalTemplates(`
    const variables = (environment: string) => \`/environments/\${environment}/variables\`;
    function streamPath(environmentId: string, streamId: string): string {
      return \`\${API_VERSION_PREFIX}/environments/\${environmentId}/streams/\${streamId}\`;
    }
    const LOGIN = "/bff/magic-link";
    const alias = variables(environmentId);
  `);
  assert.equal(templates.get("LOGIN"), "/bff/magic-link");
  assert.match(templates.get("variables") ?? "", /^\/environments\//u);
  assert.match(templates.get("streamPath") ?? "", /streams/u);
  assert.equal(templates.get("alias"), templates.get("variables"));
});

test("a leading interpolation is a base URL and is dropped; an inner one is exactly one segment", () => {
  assert.equal(normalisePathExpression("${API_VERSION_PREFIX}/organizations"), "/organizations");
  assert.equal(normalisePathExpression("${base}/environments/${id}/variables"), "/environments/*/variables");
  assert.equal(normalisePathExpression("/organizations?limit=5"), "/organizations");
  assert.equal(normalisePathExpression("/projects/"), "/projects");
  assert.equal(normalisePathExpression("${everything}"), null, "a path with no literal at all resolves to nothing");
});

test("request sites are read from all five call forms", () => {
  // Fictional paths, for the reason above: a real one here would be read as a
  // real request site by the register that reads this file.
  const sites = extractHttpCallSites(`
    const variables = (environment) => \`/fixtures/\${environment}/variables\`;
    await call("POST", "/fixtures/session", { body });
    await call("GET", variables(id));
    await request(app).delete("/fixtures/tokens");
    await server.inject({ method: "PATCH", url: "/fixtures/x/members/y" });
    await fetch(\`\${base}/fixtures/livez\`);
  `);
  const seen = sites.map((site) => `${site.method} ${site.path}`).sort();
  assert.deepEqual(seen, [
    "DELETE /fixtures/tokens",
    "GET /fixtures/*/variables",
    "GET /fixtures/livez",
    "PATCH /fixtures/x/members/y",
    "POST /fixtures/session",
  ]);
});

test("a literal template segment must be matched exactly; a wildcard cannot satisfy one", () => {
  assert.equal(matchesRouteTemplate("/agent/skills/health", "/api/v1/agent/skills/health"), true);
  assert.equal(matchesRouteTemplate("/agent/skills/*", "/api/v1/agent/skills/health"), false);
  assert.equal(matchesRouteTemplate("/agent/skills/*", "/api/v1/agent/skills/:id"), true);
  assert.equal(matchesRouteTemplate("/agent/skills/abc", "/api/v1/agent/skills/:id"), true);
  assert.equal(matchesRouteTemplate("/organizations", "/api/v1/organizations"), true);
  assert.equal(matchesRouteTemplate("/api/v1/organizations", "/api/v1/organizations"), true);
  assert.equal(matchesRouteTemplate("/*/*", "/api/v1/organizations"), false, "a path with no literal claims nothing");
  assert.equal(matchesRouteTemplate("/api/v1/organizations/x", "/api/v1/organizations"), false, "longer than the cell");
});

// ---------------------------------------------------------------------------
// The register itself
// ---------------------------------------------------------------------------

const CELLS = [
  cell("GET /fixtures/organizations", "GET", "/fixtures/organizations"),
  cell("GET /fixtures/jobs", "GET", "/fixtures/jobs", "jobs"),
  cell("POST /fixtures/turns", "POST", "/fixtures/turns", "agents"),
  cell("GET /fixtures/skills/health", "GET", "/fixtures/skills/health", "skills"),
  cell("GET /fixtures/skills/:id", "GET", "/fixtures/skills/:id", "skills"),
];

const OPERATIONS = [
  operation("GET /fixtures/organizations", "GET", "/fixtures/organizations", [
    { controller: "FixtureOrganizationsController", handler: "fixtureList", source: "apps/core-api/src/transports/rest/fixture.controller.ts" },
  ]),
  operation("GET /fixtures/jobs", "GET", "/fixtures/jobs", [
    { controller: "FixtureJobsController", handler: "fixtureList", source: "apps/agent/src/fixture-jobs.controller.ts" },
  ]),
  // The carve-out case names the REAL controller constant, because that is what
  // decides the status, and a handler that exists nowhere, because the file
  // below binds the real name and a real handler would join a real cell.
  operation("POST /fixtures/turns", "POST", "/fixtures/turns", [
    { controller: M31_CONTROLLER, handler: "fixtureCreateTurn", source: "apps/agent/src/agent-runtime/agent.controller.ts" },
  ]),
  operation("GET /fixtures/skills/health", "GET", "/fixtures/skills/health", [
    { controller: "FixtureSkillsController", handler: "fixtureHealth", source: "apps/agent/src/fixture-skills.controller.ts" },
  ]),
  operation("GET /fixtures/skills/:id", "GET", "/fixtures/skills/:id", [
    { controller: "FixtureSkillsController", handler: "fixtureGetOne", source: "apps/agent/src/fixture-skills.controller.ts" },
  ]),
];

const FILES = [
  file(
    "apps/core-api/src/composition/fixture.integration.test.ts",
    'const answer = await call("GET", `${PREFIX}/fixtures/organizations`, { token });',
  ),
  file(
    "apps/agent/src/fixture-jobs.controller.test.ts",
    'const controller = new FixtureJobsController(prisma, auth);\nawait controller.fixtureList(request);',
  ),
  file(
    "apps/agent/src/agent-runtime/fixture-agent.controller.test.ts",
    `const controller = new ${M31_CONTROLLER}(deps);\nawait controller.fixtureCreateTurn(request, body);`,
  ),
];

function statusOf(rows, id) {
  return (rows.find((row) => row.id === id) ?? {}).status;
}

test("each evidence kind joins its own cell, and the two are reported separately", () => {
  const { rows, failures } = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: FILES });
  assert.deepEqual(failures, []);
  assert.equal(statusOf(rows, "GET /fixtures/organizations"), "covered");
  assert.equal(statusOf(rows, "GET /fixtures/jobs"), "covered");
  const organizations = rows.find((row) => row.id === "GET /fixtures/organizations");
  const jobs = rows.find((row) => row.id === "GET /fixtures/jobs");
  assert.deepEqual(organizations?.evidence.map((entry) => entry.kind), ["http"]);
  assert.deepEqual(jobs?.evidence.map((entry) => entry.kind), ["handler"]);
  assert.ok(STATUSES.includes(organizations?.status ?? ""));
});

test("THE MUTATION: deleting the only case for a cell turns it into residue and moves the digest", () => {
  const before = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: FILES });
  const without = FILES.filter((entry) => !entry.path.endsWith("fixture-jobs.controller.test.ts"));
  const after = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: without });
  assert.equal(statusOf(before.rows, "GET /fixtures/jobs"), "covered");
  assert.equal(statusOf(after.rows, "GET /fixtures/jobs"), "uncovered");
  assert.notEqual(registerDigest(before.rows), registerDigest(after.rows));
  const residue = after.rows.find((row) => row.id === "GET /fixtures/jobs");
  assert.equal(residue?.blockedBy, "WIN-267");
  assert.match(residue?.reason ?? "", /no tracked test file yields either join/u);
});

test("an AgentController cell is a dependency, not coverage, even when a suite exercises it", () => {
  const { rows } = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: FILES });
  const carved = rows.find((row) => row.id === "POST /fixtures/turns");
  assert.equal(carved?.status, "m3.1-dependency");
  assert.equal(carved?.blockedBy, M31_OWNER);
  assert.ok((carved?.evidence.length ?? 0) > 0, "its evidence is still reported, so the carve-out hides no work");
  const summary = summarise(rows);
  assert.equal(summary.m31Dependency, 1);
  assert.equal(summary.joinable, rows.length - 1);
  assert.equal(summary.covered + summary.residue, summary.joinable, "the carve-out is in neither total");
});

test("an ambiguous request path joins nothing rather than inflating two rows", () => {
  const ambiguous = [
    file("apps/agent/src/skills/ambiguous.test.ts", 'await call("GET", "/agent/skills/health");'),
  ];
  const { rows } = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: ambiguous });
  // `/agent/skills/health` lands on the literal cell AND on `:id`, so neither
  // is claimed. Two rows going green off one vague URL is the failure this
  // refusal exists to stop.
  assert.equal(statusOf(rows, "GET /fixtures/skills/health"), "uncovered");
  assert.equal(statusOf(rows, "GET /fixtures/skills/:id"), "uncovered");
});

test("the denominator is refused when the two enumerations disagree", () => {
  const extraCell = buildRegister({
    restCells: [...CELLS, cell("GET /fixtures/invented", "GET", "/fixtures/invented")],
    manifestOperations: OPERATIONS,
    testFiles: FILES,
  });
  assert.match(extraCell.failures.join("\n"), /have no operation in/u);

  const extraOperation = buildRegister({
    restCells: CELLS,
    manifestOperations: [...OPERATIONS, operation("GET /fixtures/ghost", "GET", "/fixtures/ghost", [
      { controller: "FixtureGhostController", handler: "fixtureList", source: "apps/agent/src/fixture-ghost.controller.ts" },
    ])],
    testFiles: FILES,
  });
  assert.match(extraOperation.failures.join("\n"), /are in no capability-matrix cell/u);

  const unimplemented = buildRegister({
    restCells: CELLS,
    manifestOperations: OPERATIONS.map((entry) =>
      entry.id === "GET /fixtures/jobs" ? { ...entry, implementations: [] } : entry,
    ),
    testFiles: FILES,
  });
  assert.match(unimplemented.failures.join("\n"), /names no implementation/u);
});

// ---------------------------------------------------------------------------
// The committed artifact
// ---------------------------------------------------------------------------

test("the committed register enumerates its test corpus from the index, not from a list", () => {
  const files = enumerateTestFiles(repositoryRoot);
  assert.ok(files.length > 500, `expected a real corpus, saw ${files.length}`);
  for (const path of files) assert.match(path, TEST_FILE_PATTERN);
});

test("every residue row in the committed register names an owner and a reason", () => {
  const artifact = JSON.parse(readFileSync(join(repositoryRoot, JSON_PATH), "utf8"));
  const residue = artifact.rows.filter((row) => row.status === "uncovered");
  assert.equal(residue.length, artifact.summary.residue);
  for (const row of residue) {
    assert.ok(typeof row.blockedBy === "string" && row.blockedBy.length > 0, `${row.id} has no owner`);
    assert.ok(typeof row.reason === "string" && row.reason.length > 40, `${row.id} has no reason`);
  }
  const carved = artifact.rows.filter((row) => row.status === "m3.1-dependency");
  assert.equal(carved.length, artifact.summary.m31Dependency);
  for (const row of carved) {
    assert.equal(row.blockedBy, M31_OWNER);
    assert.ok(row.controllers.includes(M31_CONTROLLER));
  }
  assert.equal(artifact.summary.covered + artifact.summary.residue, artifact.summary.joinable);
  assert.deepEqual(
    artifact.evidenceKinds.map((kind) => kind.id).sort(),
    EVIDENCE_KINDS.map((kind) => kind.id).sort(),
  );
  for (const kind of artifact.evidenceKinds) {
    assert.ok(typeof kind.limit === "string" && kind.limit.length > 20, `${kind.id} publishes no stated limit`);
  }
});

test("the register cites nothing from the files that test it, so it cannot inflate itself", () => {
  const artifact = JSON.parse(readFileSync(join(repositoryRoot, JSON_PATH), "utf8"));
  // MEASURED, NOT ANTICIPATED. The first generated register cited this file for
  // eight cells: the controller names and request paths written here as fixtures
  // for the parser were read by the parser as evidence. Every fixture in this
  // file is fictional now, and this case is what keeps it that way — including
  // in PROSE, because the extractor reads a comment exactly as it reads code and
  // the first draft of this very comment quoted a real route and re-broke it.
  const selfCitations = artifact.rows.flatMap((row) =>
    row.evidence.filter((entry) => entry.file.endsWith("scripts/rest-cell-coverage.test.mjs")).map((entry) => `${row.id} <- ${entry.kind}`),
  );
  assert.deepEqual(selfCitations, []);
});
