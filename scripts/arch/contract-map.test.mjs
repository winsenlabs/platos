// WIN-267 (M4.1) — mutation / negative controls for the design-to-contract map.
//
// THIS SUITE EXISTS BECAUSE THE GATE IT COVERS COULD NOT FAIL.
//
// `contract-map.mjs` wrote `literalMigration.count: 18` into its model and then
// asserted `model.canonicalPrefix.literalMigration.count !== 18` against the
// model it had just built. Both sides came from one constant in one file, so the
// error "18-literal @Version migration note not recorded" was unreachable in
// EVERY tree — including a tree that had completed the migration and had no
// literals left at all, which is the one state a pre-gate for that migration
// exists to notice.
//
// The replacement measures the tree and checks the COMMITTED artifact against
// that measurement. The cases below feed the measurement fixtures and feed the
// check the old number, and watch both go red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  LITERAL_SCAN_ROOTS,
  ROUTING_DECORATORS,
  contractHistogram,
  contractRowErrors,
  literalMigrationErrors,
  measureApiV1LiteralLines,
  measureApiV1Literals,
} from "./contract-map.mjs";

const roots = [];
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "pl-contract-map-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const under = (name) => `${LITERAL_SCAN_ROOTS[0]}/agent/src/${name}`;

test("the scan is over the declared roots and the Nest routing decorators", () => {
  assert.deepEqual([...LITERAL_SCAN_ROOTS], ["apps", "packages", "internal-packages"]);
  assert.ok(ROUTING_DECORATORS.includes("Controller"));
  for (const verb of ["Get", "Post", "Put", "Patch", "Delete"]) {
    assert.ok(ROUTING_DECORATORS.includes(verb), `${verb} must be counted; four of the twenty files carry the prefix on a method decorator`);
  }
});

test("a controller literal is counted once, on its file and its line", () => {
  const root = fixture({
    [under("a.controller.ts")]: '@Controller("api/v1/agent")\nexport class AController {}\n',
  });
  const m = measureApiV1Literals(root);
  assert.deepEqual({ literals: m.literals, sourceLines: m.sourceLines, files: m.files }, { literals: 1, sourceLines: 1, files: 1 });
  assert.equal(m.sites[0].line, 1);
  assert.equal(m.sites[0].decorator, "Controller");
});

test("TWO LITERALS ON ONE LINE: literals and sourceLines part company", () => {
  // This is the memory.controller.ts shape and the whole reason 24 != 23.
  const root = fixture({
    [under("m.controller.ts")]: '@Controller(["api/v1/memory", "api/v1/platos/memory"])\nexport class MController {}\n',
  });
  const m = measureApiV1Literals(root);
  assert.equal(m.literals, 2);
  assert.equal(m.sourceLines, 1);
  assert.equal(m.files, 1);
  // The line-based second mechanism cannot see the alias, and must agree on lines.
  assert.equal(measureApiV1LiteralLines(root), 1);
});

test("a method decorator carrying the prefix is counted; @Controller-only counting misses it", () => {
  const root = fixture({
    [under("k.controller.ts")]: '@Controller()\nexport class KController {\n  @Get("api/v1/channels/link/callback")\n  callback() {}\n}\n',
  });
  const m = measureApiV1Literals(root);
  assert.equal(m.literals, 1);
  assert.equal(m.sites[0].decorator, "Get");
});

test("prose, comments, tests and non-decorator strings are not routes", () => {
  const root = fixture({
    [under("guard.ts")]: 'export const PATHS = ["/api/v1/agent/access-key"];\n',
    [under("doc.controller.ts")]: '// @Get("api/v1/nope")\n/* @Post("api/v1/also-nope") */\n@Controller("agent")\nexport class DController {}\n',
    [under("x.controller.test.ts")]: '@Controller("api/v1/from-a-test")\nexport class XController {}\n',
  });
  const m = measureApiV1Literals(root);
  assert.equal(m.literals, 0, JSON.stringify(m.sites));
  assert.equal(measureApiV1LiteralLines(root), 0);
});

test("a literal inside a decorator argument that also contains parentheses is still found", () => {
  const root = fixture({
    [under("p.controller.ts")]: '@Controller(prefix() + "api/v1/agent/providers")\nexport class PController {}\n',
  });
  assert.equal(measureApiV1Literals(root).literals, 1);
});

test("MUTATION: the number this gate used to assert against itself now fails", () => {
  // The exact former state: a model that says 18 while the tree says something
  // else. Under the old check this could not produce an error at all.
  const measured = { literals: 24, sourceLines: 23, files: 20 };
  const errors = literalMigrationErrors({ literals: 18, sourceLines: 18, files: 18, status: "pending" }, measured);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.startsWith("literalMigration.literals:")), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("literalMigration.sourceLines:")), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("literalMigration.files:")), errors.join("\n"));
});

test("MUTATION: a completed migration that still reports pending fails", () => {
  const errors = literalMigrationErrors(
    { literals: 0, sourceLines: 0, files: 0, status: "pending" },
    { literals: 0, sourceLines: 0, files: 0 },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^literalMigration\.status/u);
});

test("MUTATION: a missing literalMigration record fails rather than passing quietly", () => {
  assert.equal(literalMigrationErrors(undefined, { literals: 1, sourceLines: 1, files: 1 }).length, 1);
});

test("BASELINE: the recorded measurement matches the tree, and both mechanisms agree", () => {
  const measured = measureApiV1Literals();
  assert.equal(measured.sourceLines, measureApiV1LiteralLines(), "the two measuring mechanisms disagree on source lines");
  assert.ok(measured.literals >= measured.sourceLines);
  assert.ok(measured.sourceLines >= measured.files);
  assert.deepEqual(
    literalMigrationErrors(
      { literals: measured.literals, sourceLines: measured.sourceLines, files: measured.files, status: "pending" },
      measured,
    ),
    [],
  );
});

test("MUTATION: a hand-kept newCount that disagrees with its own rows fails", () => {
  // 03-home carried newCount 8 against 3 rows marked N. That divergence summed
  // to totals.newContracts 98 while the rows said 104.
  const screens = [
    { id: "03-home", newCount: 8, contracts: [{ status: "N" }, { status: "N" }, { status: "N" }, { status: "E" }] },
  ];
  const errors = contractRowErrors(screens, { newContracts: 8 });
  assert.ok(errors.some((e) => e.includes("records newCount 8 but carries 3")), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("totals.newContracts:")), errors.join("\n"));
});

test("MUTATION: an unknown contract status is refused, so the histogram cannot silently gain a bucket", () => {
  const screens = [{ id: "z", newCount: 0, contracts: [{ status: "MAYBE" }] }];
  assert.ok(contractRowErrors(screens, null).some((e) => e.includes('status "MAYBE"')));
});

test("the histogram counts every row exactly once", () => {
  const screens = [
    { id: "a", newCount: 1, contracts: [{ status: "N" }, { status: "E" }] },
    { id: "b", newCount: 0, contracts: [{ status: "E-stream" }, { status: "E-partial" }] },
  ];
  const h = contractHistogram(screens);
  assert.equal(h.rows, 4);
  assert.deepEqual(h.byStatus, { N: 1, E: 1, "E-stream": 1, "E-partial": 1 });
  assert.deepEqual(contractRowErrors(screens, { newContracts: 1 }), []);
});
