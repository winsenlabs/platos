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
  // +14 for the eventing suites, +20 for the skills suites, +16 for the jobs
  // suites, +28 for the memory suites and +21 for the cost-monitoring suites
  // (WIN-256). The axes are disjoint and every adoption moves THIS SAME number,
  // so it is their sum: 88 + 14 + 20 + 16 + 28 + 21 = 187. The eventing branch
  // pinned 102, the skills branch pinned 108, the jobs branch pinned 104, the
  // memory branch pinned 116 and the cost-monitoring branch pinned 109; each is
  // right alone and wrong here.
  //
  // The jobs CASE total moved three times more — 1350 -> 1354, 1354 -> 1367 and
  // 1367 -> 1378 as three successive verifications closed survivors — the
  // memory CASE total moved twice more, 596 -> 602 -> 605, the second a NET of
  // +9 and -6, and the cost-monitoring CASE total moved twice more,
  // 335 -> 345 -> 352. The FILE total did not move for any of them, because
  // every case landed in a suite that already existed. That is exactly the
  // drift a file-count pin cannot see and the case pin can.
  assert.equal(live.totalFiles, 187);
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
  // 67 -> 88 -> 102 -> 122 -> 138 -> 166 -> 187: +21 providers, +14 the suites
  // `eventing` brings with it (ADR M0.3 §1 row 17), +20 the suites `skills`
  // brings, +16 the suites `jobs` brings, +28 the suites `memory` brings, +21
  // the suites `cost-monitoring` brings. Same 187 as above, re-derived from the
  // pinned rows rather than the tree.
  assert.equal(files, 187);
});

test("the split the 2026-09-02 verification reproduced is pinned per package", () => {
  // 716 at 3ed8f3ce, +1 in `files` for the storage-key separator case.
  assert.equal(EXPECTED["packages/kernel"].cases, 44);
  assert.equal(EXPECTED["packages/contexts/identity-access"].cases, 231);
  assert.equal(EXPECTED["packages/contexts/secrets"].cases, 162);
  assert.equal(EXPECTED["packages/contexts/tenancy"].cases, 146);
  assert.equal(EXPECTED["packages/contexts/files"].cases, 134);
  assert.equal(EXPECTED["packages/contexts/files"].files, 15, "the file count did NOT move; the case count did");
  // The WIN-256 `eventing` context. Pinned beside the five above so a suite
  // deleted from it is the same kind of failure as one deleted from them.
  //
  // 142 -> 147 (2026-09-03). Five cases closing the coverage the independent
  // verification found: three for the drain-boundary `reparse` guard, which was
  // entirely dead to the suite, one for the duplicate-name pre-flight, and one
  // for an erasure plan carrying this target's name but no subject rider. The
  // FILE count deliberately does not move — all five went into existing files,
  // which is the drift `docs/v1-ledger-rules.json` cannot see and this can.
  //
  // 147 -> 149 (2026-09-03, after the rebase onto 95cbacc1). Two more, still in
  // existing files: the pair of controls that turn the two argued
  // equivalent-mutant survivors in `assertNameFree` into killed mutations —
  // one asserting the same-name re-PUT performs no store lookup, one driving
  // the stale-read interleaving the id-inequality test exists for.
  assert.equal(EXPECTED["packages/contexts/eventing"].cases, 149);
  assert.equal(EXPECTED["packages/contexts/eventing"].files, 14, "the file count did NOT move; the case count did");
  // The WIN-256 `jobs` context, pinned beside the others for the same reason.
  // 350 -> 354 -> 367 -> 378. The first four kill the two mutants the 2026-09-03
  // verification found surviving (the erasure METHOD, three cases; the payload
  // depth cap at limit+1, one case). The next thirteen kill the six that the
  // same verification found on the rebased branch: the `describeJob` projection
  // (2), the conditional write's loser branch (2), `markApprovalConsumed`'s
  // not-found guard (2), the cached failure's own code (2), the per-row
  // `retained` channel (2), and `mcpActionLabel`, which had no caller at all
  // (3). The last eleven kill the three substantive survivors of the 2026-09-03
  // RE-CHECK: which timeout clamp each approval path gets (6, pinned through the
  // published binder in both directions), `settle`'s fail-closed error-code
  // filter (2), and the 64 KB size cap at BOTH of its wired call sites (3). The
  // file count stays 16 through ALL THREE deltas because every case landed in a
  // suite that already existed — the sibling packages above are still untouched,
  // which is what this test exists to assert.
  assert.equal(EXPECTED["packages/contexts/jobs"].cases, 378);
  assert.equal(EXPECTED["packages/contexts/jobs"].files, 16);
});

test("the providers context rebased onto 75ee484de252 is pinned at what vitest prints", () => {
  // The ONE row the rebase moves. `pnpm --filter @platos/context-providers exec
  // vitest run` prints "Test Files 21 passed (21) / Tests 283 passed (283)";
  // the AST census reproduces both with zero refusals. Every other package is
  // held at its 3ed8f3ce value by the test above, so a suite quietly deleted
  // elsewhere while providers landed cannot hide inside the new total.
  assert.equal(EXPECTED["packages/contexts/providers"].files, 21);
  assert.equal(EXPECTED["packages/contexts/providers"].cases, 283);
  // The runtime total is re-derived from the SEVEN slices that contribute cases,
  // so a row moved without its delta cannot hide inside it. The eventing
  // context is the third: 142 at adoption, 147 after the 2026-09-03
  // verification's five cases, 149 after the two that close its last two
  // survivors — all with the file count held at 14. Skills is the fourth at
  // 306, jobs the fifth at 378, memory the sixth at 605 and cost-monitoring the
  // seventh at 352; each is pinned by its own test.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 283 + 149 + 306 + 378 + 605 + 352);
});

test("the skills adoption is pinned, and moved nothing else", () => {
  // WIN-256 M2.1: skills goes 0 -> 302 across 0 -> 20 files. Integrated with
  // the providers slice the runtime total is 717 + 283 + 302 = 1302; the skills
  // branch pinned 1019 because it predates the providers commit and the two
  // adoptions touch disjoint packages.
  //
  // 302 -> 306 (2026-09-03, after the rebase onto 95cbacc1). Four cases closing
  // the host-closure survivors the re-run mutation sweep found — suffix
  // look-alikes for each of the three rewrite rules, plus the closure property
  // over all of them. The FILE count deliberately does not move: all four went
  // into the existing domain/import-source.test.ts, which is the drift
  // `docs/v1-ledger-rules.json` cannot see and this can.
  assert.equal(EXPECTED["packages/contexts/skills"].cases, 306);
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
  // M2 WAVE-B: `eventing`, `jobs`, `memory` and `cost-monitoring` land in the
  // same integration branch on INDEPENDENT axes, so this re-derivation carries
  // their 149, 378, 605 and 352 too. Without those terms the identity would
  // hold only on the skills branch alone, which is exactly the side-picking
  // this comment exists to prevent: 1000 + 149 + 306 + 378 + 605 + 352 = 2790.
  assert.equal(sum + 149 + 306 + 378 + 605 + 352, EXPECTED_RUNTIME_TOTAL);
});

test("the memory context is pinned at what vitest prints", () => {
  // The ONE row this issue moves. `pnpm --filter @platos/context-memory exec
  // vitest run` prints "Test Files 28 passed (28) / Tests 605 passed (605)";
  // the AST census reproduces both with zero refusals. Every other package is
  // held at its earlier value by the tests above, so a suite quietly deleted
  // elsewhere while memory landed cannot hide inside the new total.
  //
  // 596 -> 602 on the v1 rebase: six cases closing the two defects the review
  // named, in two files that already existed. THE FILE COUNT DOES NOT MOVE, and
  // that is the whole point of this pin — 28 stays 28 while the case count
  // rises, which is exactly the drift `docs/v1-ledger-rules.json`'s file counts
  // cannot see. Four land in application/authorization.test.ts (a command may
  // not name an acting agent the runtime grant was not minted for) and two in
  // application/memory-erasure-target.test.ts (the receipt reports what the
  // deletes observed, not what the plan forecast).
  //
  // 602 -> 605 on the 2026-09-03 re-check, and this one is a NET: +9 and -6,
  // with the file count STILL at 28. The +9 are the six fail-closed erasure
  // branches pinned one at a time, the two that obtain the ErasureTarget
  // through the published binder, and the literal value of MAX_CONTENT_LENGTH.
  // The -6 are `requireRuntimeAuthorization` and `verifyRuntimeScope`, deleted
  // with their tests as dead duplicates. A pin that moved by +3 and said
  // nothing else would hide a six-case deletion inside a nine-case addition,
  // which is why the arithmetic is written out here and in the census prose.
  //
  // M2 WAVE-B: `eventing`, `skills` and `jobs` land in the same integration
  // branch on INDEPENDENT axes, so this re-derivation carries their 149, 306
  // and 378 too. The memory branch pinned 717 + 283 + 605 = 1605 and was right
  // alone; here the identity only closes with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/memory"].files, 28);
  assert.equal(EXPECTED["packages/contexts/memory"].cases, 605);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 283 + 149 + 306 + 378 + 605 + 352);
});

test("the cost-monitoring context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's cost-monitoring slice moves. `pnpm --filter
  // @platos/context-cost-monitoring exec vitest run` prints "Test Files 21
  // passed (21) / Tests 352 passed (352)"; the AST census reproduces both with
  // zero refusals. Every other package is held at its previous value by the
  // test above, so a suite quietly deleted elsewhere while this context landed
  // cannot hide inside the new total.
  //
  // 335 -> 345 on the v1 rebase: ten cases closing the three money-path
  // survivors the review named, in three files that already existed. THE FILE
  // COUNT DOES NOT MOVE, and that is the whole point of this pin — 21 stays 21
  // while the case count rises, which is exactly the drift
  // `docs/v1-ledger-rules.json`'s file counts cannot see.
  //
  // 345 -> 352 on the 2026-09-03 re-check, again with the file count at 21:
  // five cases for `targetFor`'s three undeliverable answers and the call site
  // that reads them, and two for the "both writes or neither" rollback in
  // detect-crossings — a property that was untested AND untrue.
  //
  // M2 WAVE-B: `eventing`, `skills`, `jobs` and `memory` land in the same
  // integration branch on INDEPENDENT axes, so this re-derivation carries their
  // 149, 306, 378 and 605 too. The cost-monitoring branch pinned
  // 717 + 283 + 352 = 1352 and was right alone; here the identity only closes
  // with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/cost-monitoring"].files, 21);
  assert.equal(EXPECTED["packages/contexts/cost-monitoring"].cases, 352);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 283 + 149 + 306 + 378 + 605 + 352);
});

test("every V1 package has a pinned row, including the ones with no tests yet", () => {
  const live = listPackages();
  assert.deepEqual(live.sort(), Object.keys(EXPECTED).sort());
  assert.equal(live.length, 30);
});
