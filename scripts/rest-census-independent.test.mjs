// WIN-294 — mutation / negative controls for the independent REST census.
// Each test feeds a MUTATED census and proves the reconciliation FAILS, so the
// gate cannot silently pass when a controller is removed, a route is hidden, or
// operator authorization is wrapped away. The final test proves the LIVE tree
// reconciles (ok=true), so the failing tests above are discriminating, not
// vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseController, reconcile, DUAL_MOUNT } from "./rest-census-independent.mjs";

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
  const indep = { FooController: { routes: 1, requireOperator: 0, file: "foo.controller.ts" } };
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
  const indep = { FooController: { routes: 3, requireOperator: 0, file: "foo" } };
  const r = reconcile(indep, manOf({ FooController: { ops: 5, operator: 0 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("ROUTE DRIFT")), r.failures.join("\n"));
});

test("MUTATION: wrapping operator auth away (manifest operator < floor) fails as OPERATOR REGRESSION", () => {
  const indep = { FooController: { routes: 2, requireOperator: 2, file: "foo" } };
  const r = reconcile(indep, manOf({ FooController: { ops: 2, operator: 1 } }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.startsWith("OPERATOR REGRESSION")), r.failures.join("\n"));
});

test("dual-mount multiplier: a DUAL_MOUNT controller expects decorators x 2 ops", () => {
  const name = Object.keys(DUAL_MOUNT)[0];
  const mult = DUAL_MOUNT[name];
  const indep = { [name]: { routes: 4, requireOperator: 0, file: "x" } };
  // correct: 4 x mult
  assert.equal(reconcile(indep, manOf({ [name]: { ops: 4 * mult, operator: 0 } })).ok, true);
  // wrong: not multiplied -> drift
  assert.equal(reconcile(indep, manOf({ [name]: { ops: 4, operator: 0 } })).ok, false);
});

test("BASELINE: the live tree reconciles to zero unexplained delta (ok=true)", () => {
  const r = reconcile();
  assert.equal(r.ok, true, "live reconciliation failures:\n" + r.failures.join("\n"));
});
