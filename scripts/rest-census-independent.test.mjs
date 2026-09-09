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
  SCAN_ROOTS,
  independentCensus,
  manifestCensus,
  parseController,
  processEdgeReport,
  reconcile,
  reconcileScanRoots,
  scanRootReport,
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
  // THE ARITHMETIC. Five controllers under `apps/core-api/src/transports` carried
  // EIGHT route decorators, none of them multi-mounted, so 8 decorators x 1 base
  // path = 8 expanded operations, and the committed manifest attributed 8 to that
  // root. The agent root is untouched at 300. 300 + 8 = 308.
  //
  // WIN-257 T8 ADDS THE SIXTH CONTROLLER AND THE NINTH DECORATOR.
  // `WorkspaceController` carries ONE `@Get`, still not multi-mounted, so
  // 9 decorators x 1 base path = 9 expanded operations. 300 + 9 = 309, which is
  // the manifest's own `summary.restOperations`.
  //
  // THIS COUNT MOVED BY ITSELF. Neither this file nor `rest-census-independent.mjs`
  // was told about the route: the census walks `apps/core-api/src/transports` for
  // `@Controller` and route decorators with its own parser, which is the whole
  // point of it being independent of the generator's AST walk. The two agreeing
  // at 309 is the assertion; the numbers below are where they are pinned.
  const roots = scanRootReport();
  const r = reconcileScanRoots(roots, processEdgeReport(), manifestCensus(), independentCensus(roots));
  assert.equal(r.ok, true, r.failures.join("\n"));
  const agent = r.table.find((t) => t.id === "agent");
  const core = r.table.find((t) => t.id === "core-api-transports");
  assert.equal(agent.manifestOperations, 300);
  assert.equal(agent.expandedOperations, 300);
  assert.equal(core.present, true, "the declared core-api transport root must exist on disk");
  assert.equal(core.sourceControllers, 6);
  assert.equal(core.sourceDecorators, 9);
  assert.equal(core.expandedOperations, 9);
  assert.equal(core.manifestOperations, 9);
  assert.equal(agent.manifestOperations + core.manifestOperations, 309);
});

test("BASELINE: the process-edge exclusion still describes the file it excludes", () => {
  const [edge] = processEdgeReport();
  assert.equal(edge.present, true);
  assert.equal(edge.observed.className, "HealthController");
  assert.equal(edge.observed.routes, 3, "livez, healthz, readyz — and nothing else");
  assert.equal(edge.observed.emptyBasePath, true);
});
