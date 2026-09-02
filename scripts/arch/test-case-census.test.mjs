import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  EXPECTED,
  EXPECTED_RUNTIME_TOTAL,
  census,
  checkCensus,
  countFile,
  listPackages,
  listTestFiles,
} from "./test-case-census.mjs";

const fixtures = [];
after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files) {
  const root = mkdtempSync("/var/tmp/platos-test-case-census-");
  fixtures.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

const PACKAGE = "packages/contexts/files";
const SUITE = `${PACKAGE}/domain/x.test.ts`;
const manifest = { [`${PACKAGE}/package.json`]: "{}\n" };

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test("a plain it() and a plain test() are one case each", () => {
  const counted = countFile(SUITE, `it("a", () => {});\ntest("b", () => {});\n`);
  assert.equal(counted.cases, 2);
  assert.deepEqual(counted.refusals, []);
});

test("a case name in a string, a comment or an identifier is not a case", () => {
  const counted = countFile(
    SUITE,
    `// it("commented out", () => {});\nconst s = 'it("in a string", () => {})';\nconst it2 = { it: 1 };\nexport { s, it2 };\n`,
  );
  assert.equal(counted.cases, 0);
});

test("describe groups but does not declare", () => {
  const counted = countFile(SUITE, `describe("group", () => {\n  it("a", () => {});\n});\n`);
  assert.equal(counted.cases, 1);
});

test("it.each over a literal table counts ONE PER ROW, as vitest reports it", () => {
  const counted = countFile(SUITE, `it.each(["a", "b", "c"])("case %s", () => {});\n`);
  assert.equal(counted.cases, 3);
  assert.deepEqual(counted.refusals, []);
});

test("`as const` on the table is seen through", () => {
  const counted = countFile(SUITE, `it.each(["a", "b"] as const)("case %s", () => {});\n`);
  assert.equal(counted.cases, 2);
  assert.deepEqual(counted.refusals, []);
});

test(".skip and .todo are counted as declared AND reported as non-executing", () => {
  const counted = countFile(SUITE, `it.skip("a", () => {});\nit.todo("b");\nit("c", () => {});\n`);
  assert.equal(counted.cases, 3);
  assert.equal(counted.nonExecuting, 2);
});

// ---------------------------------------------------------------------------
// Refusals — the census is exact or it fails
// ---------------------------------------------------------------------------

test("it.each over a variable is REFUSED, not silently counted as one", () => {
  const counted = countFile(SUITE, `const rows = load();\nit.each(rows)("case %s", () => {});\n`);
  assert.equal(counted.cases, 0);
  assert.equal(counted.refusals.length, 1);
  assert.match(counted.refusals[0].reason, /not an array literal/u);
});

test("it.each over a spread table is REFUSED", () => {
  const counted = countFile(SUITE, `it.each([...rows, "x"])("case %s", () => {});\n`);
  assert.equal(counted.cases, 0);
  assert.match(counted.refusals[0].reason, /spread table/u);
});

test("it.each as a tagged template is REFUSED", () => {
  const counted = countFile(SUITE, "it.each`\n  a | b\n  ${1} | ${2}\n`(\"case\", () => {});\n");
  assert.equal(counted.cases, 0);
  assert.match(counted.refusals[0].reason, /statically visible row count/u);
});

test("describe.each is REFUSED because it multiplies everything inside it", () => {
  const counted = countFile(SUITE, `describe.each([1, 2])("group %s", () => {\n  it("a", () => {});\n});\n`);
  assert.equal(counted.cases, 0, "nothing inside an expanded group may be counted");
  // Two refusals, not one: the group itself, and the case whose enclosing
  // callback is an expanded group body. Both are true, and both fail.
  assert.equal(counted.refusals.length, 2);
  assert.ok(counted.refusals.some((refusal) => /multiplies every case/u.test(refusal.reason)));
  assert.ok(counted.refusals.some((refusal) => /non-describe callback/u.test(refusal.reason)));
});

test("a case declared inside a loop is REFUSED", () => {
  const counted = countFile(SUITE, `for (const n of [1, 2]) {\n  it(\`case \${n}\`, () => {});\n}\n`);
  assert.equal(counted.cases, 0);
  assert.match(counted.refusals[0].reason, /inside a loop or a non-describe callback/u);
});

test("a case declared inside a helper function is REFUSED", () => {
  const counted = countFile(SUITE, `function cases() {\n  it("a", () => {});\n}\ncases();\ncases();\n`);
  assert.equal(counted.cases, 0);
  assert.match(counted.refusals[0].reason, /inside a loop or a non-describe callback/u);
});

test("a case inside a nested describe is still countable", () => {
  const counted = countFile(
    SUITE,
    `describe("outer", () => {\n  describe("inner", () => {\n    it("a", () => {});\n  });\n});\n`,
  );
  assert.equal(counted.cases, 1);
  assert.deepEqual(counted.refusals, []);
});

// ---------------------------------------------------------------------------
// THE CONTROL. Deleting an it() inside a RETAINED file must fail.
// This is the hole finding 6 named: the file count does not move, so
// docs/v1-ledger-rules.json cannot see it, and `test:v1-packages` reports a
// smaller number just as green.
// ---------------------------------------------------------------------------

const THREE_CASES = `describe("g", () => {\n  it("a", () => {});\n  it("b", () => {});\n  it("c", () => {});\n});\n`;
const PINNED_ONE_PACKAGE = { [PACKAGE]: { files: 1, cases: 3 } };

test("CONTROL — the intact fixture passes its pin", () => {
  const root = fixture({ ...manifest, [SUITE]: THREE_CASES });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.deepEqual(result.problems, []);
  assert.equal(result.live.totalCases, 3);
});

test("CONTROL — deleting one it() from a RETAINED file FAILS, and the file count does not move", () => {
  const root = fixture({
    ...manifest,
    [SUITE]: `describe("g", () => {\n  it("a", () => {});\n  it("b", () => {});\n});\n`,
  });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.equal(result.live.packages[PACKAGE].files, 1, "the file survives, which is the whole point");
  assert.ok(
    result.problems.some((problem) => problem.startsWith("CASES") && problem.includes("LOST 1")),
    `expected a LOST 1 case failure, got ${JSON.stringify(result.problems)}`,
  );
});

test("CONTROL — deleting a ROW from an it.each table FAILS", () => {
  const intact = fixture({ ...manifest, [SUITE]: `it.each([1, 2, 3])("case %s", () => {});\n` });
  assert.deepEqual(checkCensus(intact, PINNED_ONE_PACKAGE).problems, []);

  const mutated = fixture({ ...manifest, [SUITE]: `it.each([1, 2])("case %s", () => {});\n` });
  const result = checkCensus(mutated, PINNED_ONE_PACKAGE);
  assert.ok(result.problems.some((problem) => problem.includes("LOST 1")), JSON.stringify(result.problems));
});

test("CONTROL — ADDING a case also fails, so the pin is a census and not a floor", () => {
  const root = fixture({
    ...manifest,
    [SUITE]: `${THREE_CASES}it("d", () => {});\n`,
  });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.ok(result.problems.some((problem) => problem.includes("GAINED 1")), JSON.stringify(result.problems));
});

test("CONTROL — deleting the whole file still fails here too, not only in the ledger", () => {
  const root = fixture({ ...manifest, [`${PACKAGE}/README.md`]: "no tests\n" });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.ok(result.problems.some((problem) => problem.startsWith("FILES")), JSON.stringify(result.problems));
  assert.ok(result.problems.some((problem) => problem.includes("LOST 3")), JSON.stringify(result.problems));
});

test("CONTROL — a package with tests but no pinned row fails as UNPINNED", () => {
  const root = fixture({
    "packages/contexts/jobs/package.json": "{}\n",
    "packages/contexts/jobs/x.test.ts": `it("a", () => {});\n`,
  });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.ok(result.problems.some((problem) => problem.startsWith("UNPINNED")), JSON.stringify(result.problems));
});

test("CONTROL — turning a case into .skip fails even though the count is unchanged", () => {
  const root = fixture({
    ...manifest,
    [SUITE]: `describe("g", () => {\n  it("a", () => {});\n  it.skip("b", () => {});\n  it("c", () => {});\n});\n`,
  });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("SKIPPED")),
    JSON.stringify(result.problems),
  );
});

test("CONTROL — an uncountable construct fails the check rather than under-counting", () => {
  const root = fixture({ ...manifest, [SUITE]: `it.each(rows)("case %s", () => {});\n` });
  const result = checkCensus(root, PINNED_ONE_PACKAGE);
  assert.ok(result.problems.some((problem) => problem.startsWith("REFUSED")), JSON.stringify(result.problems));
});

// ---------------------------------------------------------------------------
// The live repository
// ---------------------------------------------------------------------------

test("the live tree matches every pinned row exactly", () => {
  const result = checkCensus();
  assert.deepEqual(result.problems, []);
});

test("the census is not vacuous — it reads the real suites", () => {
  const live = census();
  assert.equal(live.totalCases, EXPECTED_RUNTIME_TOTAL);
  // 67 at 3ed8f3ce, +21 for the providers context rebased onto 75ee484de252,
  // +20 for the skills suites. The two are disjoint: 88 + 20 = 108.
  assert.equal(live.totalFiles, 108);
  assert.equal(live.nonExecuting, 0);
  assert.deepEqual(live.refusals, []);
  assert.ok(listPackages().includes("packages/kernel"));
  assert.ok(listTestFiles(undefined, "packages/contexts/files").includes("packages/contexts/files/domain/storage-key.test.ts"));
});

test("the pinned rows sum to the pinned runtime total", () => {
  const sum = Object.values(EXPECTED).reduce((total, row) => total + row.cases, 0);
  assert.equal(sum, EXPECTED_RUNTIME_TOTAL);
  // 67 at 3ed8f3ce, +21 for the providers context rebased onto 75ee484de252.
  const files = Object.values(EXPECTED).reduce((total, row) => total + row.files, 0);
  // Same 108 as above, re-derived from the pinned rows rather than the tree.
  assert.equal(files, 108);
});

test("the split the 2026-09-02 verification reproduced is pinned per package", () => {
  // 716 at 3ed8f3ce, +1 in `files` for the storage-key separator case.
  assert.equal(EXPECTED["packages/kernel"].cases, 44);
  assert.equal(EXPECTED["packages/contexts/identity-access"].cases, 231);
  assert.equal(EXPECTED["packages/contexts/secrets"].cases, 162);
  assert.equal(EXPECTED["packages/contexts/tenancy"].cases, 146);
  assert.equal(EXPECTED["packages/contexts/files"].cases, 134);
  assert.equal(EXPECTED["packages/contexts/files"].files, 15, "the file count did NOT move; the case count did");
});

test("the providers context rebased onto 75ee484de252 is pinned at what vitest prints", () => {
  // The ONE row the rebase moves. `pnpm --filter @platos/context-providers exec
  // vitest run` prints "Test Files 21 passed (21) / Tests 283 passed (283)";
  // the AST census reproduces both with zero refusals. Every other package is
  // held at its 3ed8f3ce value by the test above, so a suite quietly deleted
  // elsewhere while providers landed cannot hide inside the new total.
  assert.equal(EXPECTED["packages/contexts/providers"].files, 21);
  assert.equal(EXPECTED["packages/contexts/providers"].cases, 283);
});

test("the skills adoption is pinned, and moved nothing else", () => {
  // WIN-256 M2.1: skills goes 0 -> 302 across 0 -> 20 files. Integrated with
  // the providers slice the runtime total is 717 + 283 + 302 = 1302; the skills
  // branch pinned 1019 because it predates the providers commit and the two
  // adoptions touch disjoint packages.
  assert.equal(EXPECTED["packages/contexts/skills"].cases, 302);
  assert.equal(EXPECTED["packages/contexts/skills"].files, 20);
  // Every previously-real package is byte-for-byte where the 2026-09-02
  // verification left it: an adoption that quietly moved another context's
  // numbers would be caught here rather than absorbed into the new total.
  const untouched = {
    "packages/kernel": 44,
    "packages/contexts/identity-access": 231,
    "packages/contexts/secrets": 162,
    "packages/contexts/tenancy": 146,
    "packages/contexts/files": 134,
    "packages/contexts/providers": 283,
  };
  for (const [name, cases] of Object.entries(untouched)) assert.equal(EXPECTED[name].cases, cases);
  const sum = Object.values(untouched).reduce((total, cases) => total + cases, 0);
  assert.equal(sum + 302, EXPECTED_RUNTIME_TOTAL);
});

test("every V1 package has a pinned row, including the ones with no tests yet", () => {
  const live = listPackages();
  assert.deepEqual(live.sort(), Object.keys(EXPECTED).sort());
  assert.equal(live.length, 30);
});
