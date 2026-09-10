// WIN-294 — mutation / negative controls for the independent REST census.
// Each test feeds a MUTATED census and proves the reconciliation FAILS, so the
// gate cannot silently pass when a controller is removed, a route is hidden, or
// operator authorization is wrapped away. The final test proves the LIVE tree
// reconciles (ok=true), so the failing tests above are discriminating, not
// vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_MULTI_MOUNT,
  PROCESS_EDGE_EXCLUSIONS,
  SCAN_ROOTS,
  applicationRootOf,
  independentCensus,
  manifestCensus,
  parseController,
  processEdgeReport,
  reconcile,
  reconcileScanRoots,
  scanRootReport,
  unscannedControllerReport,
} from "./rest-census-independent.mjs";

const manOf = (controllers) => {
  let totalOps = 0,
    totalOperator = 0;
  for (const c of Object.values(controllers)) {
    totalOps += c.ops;
    totalOperator += c.operator;
  }
  return { controllers, totalOps, totalOperator };
};

test("parseController counts route decorators; hiding one drops the count", () => {
  const two = parseController(
    `export class FooController {\n  @Get("a") a(){}\n  @Post("b") b(){}\n}`
  );
  assert.equal(two.className, "FooController");
  assert.equal(two.routes, 2);
  const one = parseController(`export class FooController {\n  @Get("a") a(){}\n}`);
  assert.equal(one.routes, 1, "removing a decorator must lower the independent count");
});

test("parseController counts the operator floor from requireOperator( calls", () => {
  const guarded = parseController(
    `export class FooController {\n  @Get("a") a(){ requireOperator(scope); }\n}`
  );
  assert.equal(guarded.requireOperator, 1);
  const unguarded = parseController(`export class FooController {\n  @Get("a") a(){}\n}`);
  assert.equal(unguarded.requireOperator, 0);
});

test("MUTATION: a production controller absent from the manifest fails as OMISSION", () => {
  const indep = { FooController: { routes: 1, requireOperator: 0, basePaths: 1, file: "foo.controller.ts" } };
  const r = reconcile(indep, manOf({}));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("OMISSION")), r.failures.join("\n"));
});

test("MUTATION: a manifest controller with no source file fails as PHANTOM", () => {
  const r = reconcile({}, manOf({ GhostController: { ops: 2, operator: 0 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("PHANTOM")), r.failures.join("\n"));
});

test("MUTATION: hiding a route (manifest ops != decorators x mult) fails as ROUTE DRIFT", () => {
  const indep = { FooController: { routes: 3, requireOperator: 0, basePaths: 1, file: "foo" } };
  const r = reconcile(indep, manOf({ FooController: { ops: 5, operator: 0 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("ROUTE DRIFT")), r.failures.join("\n"));
});

test("MUTATION: wrapping operator auth away (manifest operator < floor) fails as OPERATOR REGRESSION", () => {
  const indep = { FooController: { routes: 2, requireOperator: 2, basePaths: 1, file: "foo" } };
  const r = reconcile(indep, manOf({ FooController: { ops: 2, operator: 1 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("OPERATOR REGRESSION")), r.failures.join("\n"));
});

test("array-form multi-mount: manifest ops == decorators x source basePaths", () => {
  const name = Object.keys(KNOWN_MULTI_MOUNT)[0];
  const mult = KNOWN_MULTI_MOUNT[name];
  const indep = { [name]: { routes: 4, requireOperator: 0, basePaths: mult, file: "x" } };
  // correct: 4 x source-derived basePaths
  assert.equal(reconcile(indep, manOf({ [name]: { ops: 4 * mult, operator: 0 } })).ok, true);
  // wrong: not multiplied -> route drift
  assert.equal(reconcile(indep, manOf({ [name]: { ops: 4, operator: 0 } })).ok, false);
});

test("MUTATION: basePaths disagreeing with KNOWN_MULTI_MOUNT fails as MULTI-MOUNT DRIFT", () => {
  const name = Object.keys(KNOWN_MULTI_MOUNT)[0];
  // source now says 3 base paths but the documented map says its recorded value
  const indep = { [name]: { routes: 2, requireOperator: 0, basePaths: 3, file: "x" } };
  const r = reconcile(indep, manOf({ [name]: { ops: 6, operator: 0 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("MULTI-MOUNT DRIFT")), r.failures.join("\n"));
});

test("MUTATION: an undocumented new multi-mount controller fails as NEW MULTI-MOUNT", () => {
  const indep = { FreshController: { routes: 2, requireOperator: 0, basePaths: 2, file: "x" } };
  const r = reconcile(indep, manOf({ FreshController: { ops: 4, operator: 0 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("NEW MULTI-MOUNT")), r.failures.join("\n"));
});

test("BASELINE: the live tree reconciles to zero unexplained delta (ok=true)", () => {
  const r = reconcile();
  assert.equal(r.ok, true, "live reconciliation failures:\n" + r.failures.join("\n"));
});

// ── WIN-267 (M4.1): the SECOND SCAN ROOT ────────────────────────────────────
// The enumerator walked apps/agent/src and nothing else, so a route added under
// apps/core-api was invisible to this gate. These cases mutate the scan-root
// reconciliation itself: a root that is not on disk, a manifest source that
// belongs to no declared root, a root whose source and manifest counts have
// parted company, and the named process-edge exclusion drifting into business
// surface. Together they prove the acceptance criterion in both directions — a
// route landing under apps/core-api/src/transports MOVES the census, and one
// landing in the excluded process edge is refused rather than absorbed.

const rootStub = (over = {}) => ({
  id: "agent",
  dir: "apps/agent/src",
  why: "test",
  present: true,
  controllers: 0,
  decorators: 0,
  parsed: [],
  ...over,
});
const manStub = (controllers, sources) => ({
  controllers,
  sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, new Set(v)])),
  totalOps: Object.values(controllers).reduce((s, c) => s + c.ops, 0),
  totalOperator: Object.values(controllers).reduce((s, c) => s + c.operator, 0),
});
const edgeOk = [
  {
    file: "x/health.controller.ts",
    controller: "HealthController",
    routes: 3,
    emptyBasePath: true,
    why: "test",
    present: true,
    observed: { className: "HealthController", routes: 3, emptyBasePath: true, basePaths: 1, requireOperator: 0 },
  },
];
const coreRoot = (over = {}) =>
  rootStub({ id: "core-api-transports", dir: "apps/core-api/src/transports", ...over });

test("the declared scan roots name apps/agent AND the core-api transport seam", () => {
  assert.deepEqual(
    SCAN_ROOTS.map((r) => r.dir),
    ["apps/agent/src", "apps/core-api/src/transports"],
  );
  for (const root of SCAN_ROOTS) assert.ok(root.why.length > 0, `${root.id} must say why it is scanned`);
});

test("MUTATION: a declared scan root that is not on disk fails as SCAN ROOT MISSING", () => {
  const r = reconcileScanRoots([coreRoot({ present: false })], edgeOk, manStub({}, {}), {});
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("SCAN ROOT MISSING")), r.failures.join("\n"));
});

test("MUTATION: a manifest source under no declared root fails as UNDECLARED SCAN ROOT", () => {
  // Exactly the pre-WIN-267 state, stated as a mutation: a controller serving
  // routes from apps/core-api while the enumerator declares only apps/agent.
  const man = manStub(
    { V1RestController: { ops: 4, operator: 0 } },
    { V1RestController: ["apps/core-api/src/transports/rest/v1.controller.ts"] },
  );
  const r = reconcileScanRoots([rootStub()], edgeOk, man, {});
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("UNDECLARED SCAN ROOT")), r.failures.join("\n"));
});

test("MUTATION: a root whose globbed decorators and manifest ops disagree fails as SCAN ROOT DRIFT", () => {
  const roots = [
    coreRoot({
      controllers: 1,
      decorators: 4,
      parsed: [{ className: "V1RestController", routes: 4, basePaths: 1, requireOperator: 0, file: "x" }],
    }),
  ];
  const man = manStub(
    { V1RestController: { ops: 2, operator: 0 } },
    { V1RestController: ["apps/core-api/src/transports/rest/v1.controller.ts"] },
  );
  const r = reconcileScanRoots(roots, edgeOk, man, {});
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("SCAN ROOT DRIFT")), r.failures.join("\n"));
});

test("ACCEPTANCE: a route landing under the core-api transport root moves the per-root census", () => {
  const roots = [
    coreRoot({
      controllers: 1,
      decorators: 4,
      parsed: [{ className: "V1RestController", routes: 4, basePaths: 1, requireOperator: 0, file: "x" }],
    }),
  ];
  const man = manStub(
    { V1RestController: { ops: 4, operator: 0 } },
    { V1RestController: ["apps/core-api/src/transports/rest/v1.controller.ts"] },
  );
  const landed = reconcileScanRoots(roots, edgeOk, man, {});
  assert.equal(landed.ok, true, landed.failures.join("\n"));
  assert.equal(landed.table[0].sourceControllers, 1);
  assert.equal(landed.table[0].manifestOperations, 4);
  // And the zero the same root reads today is an assertion, not an absence.
  const empty = reconcileScanRoots([coreRoot()], edgeOk, manStub({}, {}), {});
  assert.equal(empty.table[0].manifestOperations, 0);
  assert.equal(empty.table[0].ok, true);
});

test("MUTATION: a fourth route in the excluded process edge fails as PROCESS-EDGE EXCLUSION DRIFT", () => {
  const edge = [{ ...edgeOk[0], observed: { ...edgeOk[0].observed, routes: 4 } }];
  const r = reconcileScanRoots([rootStub()], edge, manStub({}, {}), {});
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("PROCESS-EDGE EXCLUSION DRIFT")), r.failures.join("\n"));
});

test("MUTATION: the process edge gaining a base path fails, because it leaves the unversioned surface", () => {
  const edge = [{ ...edgeOk[0], observed: { ...edgeOk[0].observed, emptyBasePath: false } }];
  const r = reconcileScanRoots([rootStub()], edge, manStub({}, {}), {});
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes("EMPTY @Controller()")), r.failures.join("\n"));
});

test("MUTATION: an excluded file that has vanished fails rather than excluding nothing", () => {
  const edge = [{ ...edgeOk[0], present: false, observed: null }];
  const r = reconcileScanRoots([rootStub()], edge, manStub({}, {}), {});
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes("is not on disk")), r.failures.join("\n"));
});

test("BASELINE: the live tree's scan roots reconcile, and the core-api root now CARRIES the V1 surface", () => {
  // THE ROOT IS NO LONGER EMPTY, AND THAT IS WHY IT WAS DECLARED EARLY.
  //
  // This case used to assert `core.sourceControllers === 0` and
  // `core.manifestOperations === 0`, with the comment on SCAN_ROOTS explaining
  // that the root was declared while empty "so the FIRST route to land is counted
  // by this census rather than discovered by a reader months later". WIN-267 R1
  // is that first landing, and the count moved by itself: nothing in this file or
  // in `rest-census-independent.mjs` was told about it.
  //
  // THE ARITHMETIC. Five controllers under `apps/core-api/src/transports` carry
  // EIGHT route decorators, none of them multi-mounted, so 8 decorators x 1 base
  // path = 8 expanded operations, and the committed manifest attributes 8 to that
  // root. The agent root is untouched at 300. 300 + 8 = 308, which is the
  // manifest's own `summary.restOperations`.
  const roots = scanRootReport();
  const r = reconcileScanRoots(roots, processEdgeReport(), manifestCensus(), independentCensus(roots));
  assert.equal(r.ok, true, r.failures.join("\n"));
  const agent = r.table.find((t) => t.id === "agent");
  const core = r.table.find((t) => t.id === "core-api-transports");
  assert.equal(agent.manifestOperations, 300);
  assert.equal(agent.expandedOperations, 300);
  assert.equal(core.present, true, "the declared core-api transport root must exist on disk");
  // WIN-268 (M4.2) P1 5 -> 7 controllers and 8 -> 10 decorators: the two MCP
  // one-time-secret token mints, `POST /mcp/platform/tokens` and
  // `POST /mcp/entity/:entityId/tokens`, each in its own controller under
  // `transports/mcp/`. Both enumerators moved to the same numbers on their own.
  //
  // WIN-272 (M4.6) 7 -> 8 controllers and 10 -> 11 decorators: the stream lane's
  // `GET /api/v1/environments/:environmentId/streams/:streamId`, in its own
  // controller under `transports/ws/`. Both enumerators moved to the same numbers
  // on their own again — the generator's AST walk and this file's independent
  // glob — which is the whole reason two mechanisms exist.
  assert.equal(core.sourceControllers, 8);
  assert.equal(core.sourceDecorators, 11);
  assert.equal(core.expandedOperations, 11);
  assert.equal(core.manifestOperations, 11);
  // 300 + 11 = 311 BINDINGS, and the manifest's `summary.restOperations` is 309
  // UNIQUE operations: the two mints are served by both deployables, so each is
  // counted under both roots. The census publishes that surplus and the identity
  // it reconciles to, which is what keeps the per-root sum an equality rather
  // than an approximation. The stream route adds to BOTH sides — it is served by
  // one deployable only, so it is not a third shared operation.
  assert.equal(agent.manifestOperations + core.manifestOperations, 311);
  const totals = manifestCensus();
  assert.equal(totals.crossRootBindings, 2);
  assert.equal(totals.totalOps - totals.crossRootBindings, 309);
});

test("BASELINE: the process-edge exclusion still describes the file it excludes", () => {
  const [edge] = processEdgeReport();
  assert.equal(edge.present, true);
  assert.equal(edge.observed.className, "HealthController");
  assert.equal(edge.observed.routes, 3, "livez, healthz, readyz — and nothing else");
  assert.equal(edge.observed.emptyBasePath, true);
});

// ── WIN-267 W3: THE TERMINAL 404, AND THE HALF OF THE JOIN THAT WAS MISSING ──
//
// `apps/core-api/src/http/not-found.controller.ts` is a route-bearing controller
// that neither declared scan root reached and no exclusion named. Every case
// above passed with it invisible, which is the point: the exclusion list was
// checked in ONE direction — each named file must exist and keep its shape — and
// nothing checked the other, so a controller accounted for by nothing at all was
// indistinguishable from a tree with no such controller in it.
//
// `unscannedControllerReport` is that other direction, and the cases below feed
// it a SYNTHETIC tree rather than mutating the real one, so they measure the
// rule instead of the current file list.

const sweepStub = (over = {}) => ({ applicationRoots: ["apps/core-api/src"], unscanned: [], ...over });

test("applicationRootOf derives the application from the scan root, and does not need a second list", () => {
  assert.equal(applicationRootOf("apps/agent/src"), "apps/agent/src");
  assert.equal(applicationRootOf("apps/core-api/src/transports"), "apps/core-api/src");
  assert.equal(applicationRootOf("apps/core-api/src/transports/rest"), "apps/core-api/src");
  // A root with no `src` segment is its own application root rather than being
  // silently widened to the repository.
  assert.equal(applicationRootOf("apps/agent"), "apps/agent");
});

test("MUTATION: a controller under no scan root and in no exclusion fails as UNSCANNED", () => {
  const r = reconcileScanRoots(
    [rootStub()],
    edgeOk,
    manStub({}, {}),
    {},
    sweepStub({ unscanned: ["apps/core-api/src/http/not-found.controller.ts"] }),
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) => f.startsWith("UNSCANNED ROUTE-BEARING CONTROLLER")),
    r.failures.join("\n"),
  );
  // BY NAME. A count would tell a reader that something is ungoverned without
  // telling them which file to look at, and the file is the whole finding.
  assert.ok(r.failures.some((f) => f.includes("not-found.controller.ts")), r.failures.join("\n"));
});

test("the sweep is what makes the exclusion list falsifiable: drop the entry and the file reappears", () => {
  // THE PRE-W3 STATE, RECONSTRUCTED. With `not-found.controller.ts` removed from
  // the exclusion list — which is precisely the tree as it stood — the sweep over
  // the REAL directories reports it. That is the assertion that could not have
  // been written before, because nothing enumerated the complement.
  const without = PROCESS_EDGE_EXCLUSIONS.filter(
    (e) => e.file !== "apps/core-api/src/http/not-found.controller.ts",
  );
  const before = unscannedControllerReport(undefined, SCAN_ROOTS, without);
  assert.deepEqual(before.unscanned, ["apps/core-api/src/http/not-found.controller.ts"]);
  // And with the entry restored, the live tree has nothing ungoverned at all.
  const after = unscannedControllerReport();
  assert.deepEqual(after.unscanned, [], `ungoverned controllers: ${after.unscanned.join(", ")}`);
  assert.deepEqual(after.applicationRoots, ["apps/agent/src", "apps/core-api/src"]);
});

test("parseController tells a WILDCARD @All from a named one, which routes counts as neither", () => {
  // `routes` counts only @Get/@Post/@Put/@Patch/@Delete, so a file whose entire
  // surface is @All reads zero there no matter what path it names. That is why
  // the catch-all is measured separately rather than folded in.
  const terminal = parseController(`export class NotFoundController {\n  @All("{*path}")\n  x(){}\n}`);
  assert.equal(terminal.routes, 0);
  assert.equal(terminal.allRoutes, 1);
  assert.equal(terminal.nonWildcardAllRoutes, 0);
  // Express 4's spelling, and a leading slash, are the same statement.
  assert.equal(parseController(`@All("*")\nexport class C {}`).nonWildcardAllRoutes, 0);
  assert.equal(parseController(`  @All("/{*rest}")\nexport class C {}`).nonWildcardAllRoutes, 0);
  // A NAMED path is business surface answering every HTTP method.
  const named = parseController(`export class NotFoundController {\n  @All("organizations")\n  x(){}\n}`);
  assert.equal(named.routes, 0, "a named @All still adds nothing to the method-decorator count");
  assert.equal(named.nonWildcardAllRoutes, 1);
  // And a bare @All() binds the base path exactly — one route, not every one.
  assert.equal(parseController(`  @All()\nexport class C {}`).nonWildcardAllRoutes, 1);
});

test("MUTATION: the terminal handler's @All taking a NAMED path fails, though routes stays 0", () => {
  const edge = [
    {
      file: "x/not-found.controller.ts",
      controller: "NotFoundController",
      routes: 0,
      allRoutes: 1,
      terminalCatchAll: true,
      emptyBasePath: true,
      why: "test",
      present: true,
      observed: {
        className: "NotFoundController",
        routes: 0,
        allRoutes: 1,
        nonWildcardAllRoutes: 1,
        emptyBasePath: true,
        basePaths: 1,
        requireOperator: 0,
      },
    },
  ];
  const r = reconcileScanRoots([rootStub()], edge, manStub({}, {}), {}, sweepStub());
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) => f.includes("not a bare wildcard")),
    r.failures.join("\n"),
  );
});

test("MUTATION: a SECOND @All in the terminal handler fails as exclusion drift", () => {
  const edge = [
    {
      file: "x/not-found.controller.ts",
      controller: "NotFoundController",
      routes: 0,
      allRoutes: 1,
      terminalCatchAll: true,
      emptyBasePath: true,
      why: "test",
      present: true,
      observed: {
        className: "NotFoundController",
        routes: 0,
        allRoutes: 2,
        nonWildcardAllRoutes: 0,
        emptyBasePath: true,
        basePaths: 1,
        requireOperator: 0,
      },
    },
  ];
  const r = reconcileScanRoots([rootStub()], edge, manStub({}, {}), {}, sweepStub());
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes("@All decorator(s); the exclusion")), r.failures.join("\n"));
});

test("BASELINE: the terminal 404 is excluded, measured, and the ONLY @All in the surface", () => {
  const declared = PROCESS_EDGE_EXCLUSIONS.find(
    (e) => e.file === "apps/core-api/src/http/not-found.controller.ts",
  );
  assert.ok(declared, "the terminal 404 must be named in the exclusion list");
  const observed = processEdgeReport().find((e) => e.file === declared.file);
  assert.equal(observed.present, true);
  assert.equal(observed.observed.className, "NotFoundController");
  assert.equal(observed.observed.routes, 0, "no method decorator: it is a refusal, not a resource");
  assert.equal(observed.observed.allRoutes, 1);
  assert.equal(observed.observed.nonWildcardAllRoutes, 0);
  assert.equal(observed.observed.emptyBasePath, true, "VERSION_NEUTRAL, so /does-not-exist reaches it");
  // AND NO SCANNED CONTROLLER CARRIES ONE. A catch-all inside a scan root would
  // shadow real routes registered after it, and this is where that would show up.
  const roots = scanRootReport();
  const withAll = roots.flatMap((root) => root.parsed.filter((c) => c.allRoutes > 0));
  assert.deepEqual(withAll.map((c) => c.file), []);
});
