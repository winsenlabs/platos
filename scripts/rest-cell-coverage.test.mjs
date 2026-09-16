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
  const bound = extractControllerBindings(`
    import { JobsController } from "./jobs.controller";
    const controller = new JobsController(prisma, auth);
    const other = module.get(SkillsController);
    const third = app.resolve(FilesController);
    let typed: MemoryController;
    const notAController = new JobsService(prisma);
  `);
  assert.deepEqual([...bound].sort(), ["FilesController", "JobsController", "MemoryController", "SkillsController"]);
});

test("a handler join needs the call, not merely the import", () => {
  assert.equal(callsHandler("controller.list(request)", "list"), true);
  assert.equal(callsHandler("controller.listForAgent(request)", "list"), false);
  assert.equal(callsHandler("// list is not called here", "list"), false);
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
  const sites = extractHttpCallSites(`
    const variables = (environment) => \`/environments/\${environment}/variables\`;
    await call("POST", "/bff/session", { body });
    await call("GET", variables(id));
    await request(app).delete("/mcp/platform/tokens");
    await server.inject({ method: "PATCH", url: "/organizations/x/members/y" });
    await fetch(\`\${base}/livez\`);
  `);
  const seen = sites.map((site) => `${site.method} ${site.path}`).sort();
  assert.deepEqual(seen, [
    "DELETE /mcp/platform/tokens",
    "GET /environments/*/variables",
    "GET /livez",
    "PATCH /organizations/x/members/y",
    "POST /bff/session",
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
  cell("GET /api/v1/organizations", "GET", "/api/v1/organizations"),
  cell("GET /api/v1/agent/jobs", "GET", "/api/v1/agent/jobs", "jobs"),
  cell("POST /api/v1/agent/turns", "POST", "/api/v1/agent/turns", "agents"),
  cell("GET /api/v1/agent/skills/health", "GET", "/api/v1/agent/skills/health", "skills"),
  cell("GET /api/v1/agent/skills/:id", "GET", "/api/v1/agent/skills/:id", "skills"),
];

const OPERATIONS = [
  operation("GET /api/v1/organizations", "GET", "/api/v1/organizations", [
    { controller: "OrganizationsController", handler: "list", source: "apps/core-api/src/transports/rest/organizations.controller.ts" },
  ]),
  operation("GET /api/v1/agent/jobs", "GET", "/api/v1/agent/jobs", [
    { controller: "JobsController", handler: "list", source: "apps/agent/src/agent-runtime/jobs.controller.ts" },
  ]),
  operation("POST /api/v1/agent/turns", "POST", "/api/v1/agent/turns", [
    { controller: M31_CONTROLLER, handler: "createTurn", source: "apps/agent/src/agent-runtime/agent.controller.ts" },
  ]),
  operation("GET /api/v1/agent/skills/health", "GET", "/api/v1/agent/skills/health", [
    { controller: "SkillsController", handler: "health", source: "apps/agent/src/skills/skills.controller.ts" },
  ]),
  operation("GET /api/v1/agent/skills/:id", "GET", "/api/v1/agent/skills/:id", [
    { controller: "SkillsController", handler: "getOne", source: "apps/agent/src/skills/skills.controller.ts" },
  ]),
];

const FILES = [
  file(
    "apps/core-api/src/composition/identity.integration.test.ts",
    'const answer = await call("GET", `${API_VERSION_PREFIX}/organizations`, { token });',
  ),
  file(
    "apps/agent/src/agent-runtime/jobs.controller.test.ts",
    'const controller = new JobsController(prisma, auth);\nawait controller.list(request);',
  ),
  file(
    "apps/agent/src/agent-runtime/agent.controller.test.ts",
    'const controller = new AgentController(deps);\nawait controller.createTurn(request, body);',
  ),
];

function statusOf(rows, id) {
  return (rows.find((row) => row.id === id) ?? {}).status;
}

test("each evidence kind joins its own cell, and the two are reported separately", () => {
  const { rows, failures } = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: FILES });
  assert.deepEqual(failures, []);
  assert.equal(statusOf(rows, "GET /api/v1/organizations"), "covered");
  assert.equal(statusOf(rows, "GET /api/v1/agent/jobs"), "covered");
  const organizations = rows.find((row) => row.id === "GET /api/v1/organizations");
  const jobs = rows.find((row) => row.id === "GET /api/v1/agent/jobs");
  assert.deepEqual(organizations?.evidence.map((entry) => entry.kind), ["http"]);
  assert.deepEqual(jobs?.evidence.map((entry) => entry.kind), ["handler"]);
  assert.ok(STATUSES.includes(organizations?.status ?? ""));
});

test("THE MUTATION: deleting the only case for a cell turns it into residue and moves the digest", () => {
  const before = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: FILES });
  const without = FILES.filter((entry) => !entry.path.endsWith("jobs.controller.test.ts"));
  const after = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: without });
  assert.equal(statusOf(before.rows, "GET /api/v1/agent/jobs"), "covered");
  assert.equal(statusOf(after.rows, "GET /api/v1/agent/jobs"), "uncovered");
  assert.notEqual(registerDigest(before.rows), registerDigest(after.rows));
  const residue = after.rows.find((row) => row.id === "GET /api/v1/agent/jobs");
  assert.equal(residue?.blockedBy, "WIN-267");
  assert.match(residue?.reason ?? "", /no tracked test file yields either join/u);
});

test("an AgentController cell is a dependency, not coverage, even when a suite exercises it", () => {
  const { rows } = buildRegister({ restCells: CELLS, manifestOperations: OPERATIONS, testFiles: FILES });
  const carved = rows.find((row) => row.id === "POST /api/v1/agent/turns");
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
  assert.equal(statusOf(rows, "GET /api/v1/agent/skills/health"), "uncovered");
  assert.equal(statusOf(rows, "GET /api/v1/agent/skills/:id"), "uncovered");
});

test("the denominator is refused when the two enumerations disagree", () => {
  const extraCell = buildRegister({
    restCells: [...CELLS, cell("GET /api/v1/invented", "GET", "/api/v1/invented")],
    manifestOperations: OPERATIONS,
    testFiles: FILES,
  });
  assert.match(extraCell.failures.join("\n"), /have no operation in/u);

  const extraOperation = buildRegister({
    restCells: CELLS,
    manifestOperations: [...OPERATIONS, operation("GET /api/v1/ghost", "GET", "/api/v1/ghost", [
      { controller: "GhostController", handler: "list", source: "apps/agent/src/ghost.controller.ts" },
    ])],
    testFiles: FILES,
  });
  assert.match(extraOperation.failures.join("\n"), /are in no capability-matrix cell/u);

  const unimplemented = buildRegister({
    restCells: CELLS,
    manifestOperations: OPERATIONS.map((entry) =>
      entry.id === "GET /api/v1/agent/jobs" ? { ...entry, implementations: [] } : entry,
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
