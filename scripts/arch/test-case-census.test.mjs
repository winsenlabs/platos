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
  // suites, +28 for the memory suites, +21 for the cost-monitoring suites and
  // +15 for the privacy suites, +15 for the observability suites, +25 for the
  // agents suites, +19 for the tools suites, +15 for the channels suites and
  // +31 for the governance suites, and +4 for the four inference suites the
  // `conversations` prerequisite adds to the ALREADY-REAL providers row
  // (WIN-256), and +29 for the conversations suites themselves — the
  // SEVENTEENTH AND LAST context (ADR M0.3 §1 row 16). The axes are disjoint and
  // every adoption moves THIS SAME number, so it is their sum:
  // 88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 + 19 + 15 + 31 + 4 + 29 = 340. The
  // eventing branch pinned 102, the
  // skills branch pinned 108, the jobs branch pinned 104, the memory branch
  // pinned 116, the cost-monitoring branch pinned 109, the privacy branch pinned
  // 103, the observability branch pinned 103 as well and the agents branch
  // pinned 113, the tools branch pinned 107 and the channels branch pinned 103;
  // the governance branch, which alone branched from agents rather than from v1,
  // pinned 144, and the conversations-prerequisite branch pinned 92. Each is
  // right alone and wrong here. Privacy and observability
  // agreeing on 103 is a coincidence of two
  // 15-suite contexts on the same base, not a number to adopt.
  //
  // The jobs CASE total moved three times more — 1350 -> 1354, 1354 -> 1367 and
  // 1367 -> 1378 as three successive verifications closed survivors — the
  // memory CASE total moved twice more, 596 -> 602 -> 605, the second a NET of
  // +9 and -6, the cost-monitoring CASE total moved twice more,
  // 335 -> 345 -> 352, and the governance CASE total moved twice more,
  // 586 -> 587 -> 609. The FILE total did not move for any of them, because
  // every case landed in a suite that already existed. That is exactly the
  // drift a file-count pin cannot see and the case pin can.
  assert.equal(live.totalFiles, 340);
  // The sum is written out beside the literal so a file that vanished while
  // governance's 31, the prerequisite's 4 and conversations' 29 arrived cannot
  // reach the same total.
  assert.equal(live.totalFiles, 88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 + 19 + 15 + 31 + 4 + 29);
  assert.equal(live.nonExecuting, 0);
  assert.deepEqual(live.refusals, []);
  assert.ok(listPackages().includes("packages/kernel"));
  assert.ok(listTestFiles(undefined, "packages/contexts/files").includes("packages/contexts/files/domain/storage-key.test.ts"));
});

test("the pinned rows sum to the pinned runtime total", () => {
  const sum = Object.values(EXPECTED).reduce((total, row) => total + row.cases, 0);
  assert.equal(sum, EXPECTED_RUNTIME_TOTAL);
  // 67 at 3ed8f3ce, +21 for providers rebased onto 75ee484de252, +15 for the
  // observability context rebased onto v1 @ 95cbacc1.
  const files = Object.values(EXPECTED).reduce((total, row) => total + row.files, 0);
  // 67 -> 88 -> 102 -> 122 -> 138 -> 166 -> 187 -> 202 -> 217 -> 242 -> 261
  // -> 276 -> 307 -> 311 -> 340: +21 providers, +14 the suites
  // `eventing` brings with it (ADR M0.3 §1 row 17), +20 the suites `skills`
  // brings, +16 the suites `jobs` brings, +28 the suites `memory` brings, +21
  // the suites `cost-monitoring` brings, +15 the suites `privacy` brings, +15 the
  // suites `observability` brings, +25 the suites `agents` brings, +19 the suites
  // `tools` brings, +15 the suites `channels` brings, +31 the suites
  // `governance` brings, and +4 the inference suites the `conversations`
  // prerequisite adds to providers — the one term here that moves an
  // already-real row rather than turning a zero row real — and +29 the suites
  // `conversations` brings as the seventeenth and last context. Same 340 as
  // above, re-derived from the pinned rows rather than the tree.
  assert.equal(files, 340);
});

test("the split the 2026-09-02 verification reproduced is pinned per package", () => {
  // 716 at 3ed8f3ce, +1 in `files` for the storage-key separator case, then
  // +240 in `privacy` when WIN-256 made ADR M0.3 §1 row 18 real: 716 + 1 + 240
  // = 957 on that branch. This comment read "+236" — the implementer's own
  // count, carried into the commit message and wrong by 4 — while the pin
  // beside it was already the true 240; the arithmetic is now stated so the two
  // cannot silently disagree again. The five packages below are asserted
  // UNMOVED, which is what makes each new context an addition rather than a
  // re-baseline.
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

test("the providers context is pinned at what vitest prints", () => {
  // The ONE row that has moved TWICE, and the only row in this file that a
  // wave-B slice moved without adopting a context. The rebase onto 75ee484de252
  // made it real at 21 files / 283 cases; WIN-256's inference surface (ADR M0.3
  // §14) adds four suites and 63 cases and takes nothing away. `pnpm --filter
  // @platos/context-providers exec vitest run` prints "Test Files 25 passed
  // (25) / Tests 346 passed (346)"; the AST census reproduces both with zero
  // refusals. Every other
  // package is held at its 3ed8f3ce value by the test above, so a suite quietly
  // deleted elsewhere while these landed cannot hide inside the new total.
  assert.equal(EXPECTED["packages/contexts/providers"].files, 21 + 4);
  assert.equal(EXPECTED["packages/contexts/providers"].cases, 283 + 63);
  // The runtime total is re-derived from the SEVEN slices that contribute cases,
  // so a row moved without its delta cannot hide inside it. The eventing
  // context is the third: 142 at adoption, 147 after the 2026-09-03
  // verification's five cases, 149 after the two that close its last two
  // survivors — all with the file count held at 14. Skills is the fourth at
  // 306, jobs the fifth at 378, memory the sixth at 605 and cost-monitoring the
  // seventh at 352; each is pinned by its own test.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
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
    "packages/contexts/providers": 346,
  };
  for (const [name, cases] of Object.entries(untouched)) assert.equal(EXPECTED[name].cases, cases);
  const sum = Object.values(untouched).reduce((total, cases) => total + cases, 0);
  // M2 WAVE-B: `eventing`, `jobs`, `memory`, `cost-monitoring`, `privacy`,
  // `observability`, `agents`, `tools`, `channels` and `governance` land in the
  // same integration branch on INDEPENDENT axes, so this re-derivation carries
  // their 149, 378, 605, 352, 254, 288, 515, 362, 269 and 609 too. Without those
  // terms the identity would
  // hold only on the skills branch alone, which is exactly the side-picking
  // this comment exists to prevent:
  // 1063 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350
  // = 5500.
  // The `untouched` base is 1063 rather than 1000 because the `conversations`
  // prerequisite moved providers 283 -> 346 without adopting anything; the
  // trailing 350 is the conversations row itself, which this slice turns real.
  assert.equal(
    sum + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350,
    EXPECTED_RUNTIME_TOTAL,
  );
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
  // M2 WAVE-B: `eventing`, `skills`, `jobs`, `privacy`, `observability`,
  // `agents`, `tools`, `channels` and `governance` land in the same integration
  // branch on INDEPENDENT axes, so this re-derivation carries their 149, 306,
  // 378, 254, 288, 515, 362, 269 and 609 too. The memory branch pinned 717 + 283 + 605 = 1605 and was right
  // alone; here the identity only closes with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/memory"].files, 28);
  assert.equal(EXPECTED["packages/contexts/memory"].cases, 605);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
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
  // M2 WAVE-B: `eventing`, `skills`, `jobs`, `memory`, `privacy`,
  // `observability` and `agents` land in the same integration branch on
  // INDEPENDENT axes, so this re-derivation carries their 149, 306, 378, 605,
  // 254, 288 and 515 too. The cost-monitoring branch pinned
  // 717 + 283 + 352 = 1352 and was right alone; here the identity only closes
  // with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/cost-monitoring"].files, 21);
  assert.equal(EXPECTED["packages/contexts/cost-monitoring"].cases, 352);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
});

test("the privacy context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's privacy slice moves. 240 -> 254, and the FILE count
  // does not move once. That is the whole point of a case pin: every case the
  // mutation controls forced landed in a suite that already existed, because a
  // guard is proved from the use case that can reach it rather than from a new
  // file next to its definition. A file-count pin sees none of this.
  //
  //   240  the context as built
  //    +7  request-erasure    the content-free wiring (2), no sweep without a
  //                           seal (1), a transaction that never opened (1),
  //                           a refused progress write (1), retainedRecords (2)
  //    +2  run-erasure-pass   the non-carrier catch branch
  //    +2  retry-erasure      a refused progress write, from the retry
  //    +1  seal-subject       a store-refused seal is not a seal of zero
  //   ---
  //   252  the 2026-09-03 verification's head
  //    +2  retry-erasure      2026-09-04: the SAME handle now resolving to
  //                           nobody (1), and the retry-path re-seal extending
  //                           the tombstone window (1)
  //   ---
  //   254. The base and the two additions are written out separately, so a
  //   deletion cannot hide inside an addition and reach the same total. UNLIKE
  //   the twelve before them, one production module DID change for the last two:
  //   the two guards were given distinct codes (`PRIVACY_SUBJECT_NOT_RESOLVED`
  //   and the NEW `PRIVACY_SUBJECT_MISMATCH`), and `refuse` now takes a
  //   DomainError and labels the audit event with that error's own `code`
  //   rather than a string written beside it. Four existing cases gained
  //   refusal-label assertions; gaining an assertion is not a case, so they move
  //   no number here.
  //
  // M2 WAVE-B: the privacy branch pinned 717 + 283 + 254 = 1254 and was right
  // alone; here the identity only closes with every adoption's term present,
  // observability's 288 and agents' 515 included.
  assert.equal(EXPECTED["packages/contexts/privacy"].cases, 240 + 12 + 2);
  assert.equal(EXPECTED["packages/contexts/privacy"].files, 15, "the file count did NOT move; the case count did");
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
});

test("the observability context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's observability slice moves. `pnpm --filter
  // @platos/context-observability exec vitest run` prints "Test Files 15 passed
  // (15) / Tests 288 passed (288)"; the AST census reproduces both with zero
  // refusals. Every other package is held at its earlier value by the tests
  // above, so a suite quietly deleted elsewhere while observability landed
  // cannot hide inside the total.
  //
  //   281  the source branch tip
  //    +6  the money-path cases the v1 rebase forced — five in the NEW
  //        application/drain-projections.lanes.test.ts (which is the 14 -> 15
  //        file move) and one empty-lane control in the contracts suite
  //    +1  2026-09-04: the pricing RATES end to end, in the file the +6 created,
  //        so the file count does NOT move for it
  //   ---
  //   288. The base and both additions are written out separately so a deletion
  //   cannot hide inside an addition and reach the same total.
  //
  // NO PRODUCTION MODULE CHANGED for any of the seven. The fix was to
  // testFinalizedPayload — the fixture now carries rates on the step and the
  // usage event — plus exact per-million and pricing_version assertions on the
  // SINK rows. This context's census delta is entirely test-side, which is why
  // the arch-boundaries and max-file-lines source censuses still move by its
  // full 48 while nothing under domain/ or application/ changed behaviour.
  //
  // M2 WAVE-B: the observability branch pinned 717 + 283 + 288 = 1288 and was
  // right alone; here the identity only closes with every adoption's term,
  // agents' 515 included.
  assert.equal(EXPECTED["packages/contexts/observability"].files, 15);
  assert.equal(EXPECTED["packages/contexts/observability"].cases, 281 + 6 + 1);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
});

test("the agents context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's agents slice moves. `pnpm --filter
  // @platos/context-agents exec vitest run` prints "Test Files 25 passed (25) /
  // Tests 515 passed (515)"; the AST census reproduces both with zero refusals.
  // Every other package is held at its previous value by the tests above, so a
  // suite quietly deleted elsewhere while agents landed cannot hide inside the
  // new total.
  //
  // 513 -> 517 -> 515 with the FILE count unchanged at 25 throughout. The second
  // move is a DECREASE, which is the movement most worth a second look, so the
  // DELETIONS are written out separately from the ADDITION and the pin asserts
  // that arithmetic rather than only its result:
  //
  //   513  the context as built
  //    +4  application/agent-write.test.ts — the four releaseHolds cases the
  //        2026-09-03 verification forced; removeAgent was the only one of the
  //        five call sites with no control
  //    -3  domain/agent.test.ts — the whole "slug uniqueness is scoped to the
  //        project" block, deleted WITH domain/agent.ts::slugIsTaken, a second
  //        and unwireable implementation of a rule the use case already applies
  //    -1  application/authorization.test.ts — deleted WITH
  //        authorization.ts::projectOf, a one-line duplicate of
  //        grant.scope.projectId that nothing else called
  //    +2  the two "REFUSES when even the disambiguated slug is taken" cases,
  //        for guards that had none; both assert the WRITE LOG is empty, which
  //        is the only thing separating "refused before the write" from
  //        "refused by the store"
  //   ---
  //   515
  //
  // domain/cluster.ts::clusterSlugIsTaken was the THIRD unwired guard and is the
  // one that was WIRED rather than deleted. Its own cases are unchanged, which
  // is exactly why it is not a term in the arithmetic above — a reader who
  // expects three deletions should find only two, and this sentence is why.
  //
  // M2 WAVE-B: the agents branch pinned 717 + 283 + 515 = 1515 and was right
  // alone; here the identity only closes with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/agents"].files, 25);
  assert.equal(EXPECTED["packages/contexts/agents"].cases, 515);
  assert.equal(EXPECTED["packages/contexts/agents"].cases, 513 + 4 - 3 - 1 + 2);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
});

test("the tools context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's `tools` slice moves. `pnpm --filter
  // @platos/context-tools exec vitest run` prints "Test Files 19 passed (19) /
  // Tests 362 passed (362)"; the AST census reproduces both with zero refusals.
  // Every other package is held at its earlier value by the tests above, so a
  // suite quietly deleted elsewhere while `tools` landed cannot hide inside the
  // new total.
  //
  // THREE WAVES ON ONE ROW, AND THE MIDDLE TWO MOVED NO FILE. 0 -> 299 built
  // the context (18 files); 299 -> 325 was the hosted-MCP gate wave, 26
  // assertions and NOT ONE FILE; 325 -> 362 is the unproven-guard wave, which
  // adds 37 and exactly one file. A file-count pin would have seen the first
  // and third and been blind to the second, which is the case this canary
  // exists for. The arithmetic is decomposed per suite in the census module's
  // own delta comment.
  //
  // The +37 is written out here as well as there, so a deletion cannot hide
  // inside an addition: 29 in the new contracts/operator-gate.test.ts, 6 in
  // application/registry.test.ts (22 -> 28), 2 in application/execution.test.ts
  // (33 -> 35), and contracts/index.test.ts unchanged at 14.
  //
  // M2 WAVE-B: the tools branch pinned 717 + 283 + 362 = 1362 and was right
  // alone; here the identity only closes with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/tools"].files, 19);
  assert.equal(EXPECTED["packages/contexts/tools"].cases, 362);
  assert.equal(EXPECTED["packages/contexts/tools"].cases, 325 + 29 + 6 + 2);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
});

test("the channels context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's `channels` slice moves. `pnpm --filter
  // @platos/context-channels exec vitest run` prints "Test Files 15 passed (15)
  // / Tests 269 passed (269)"; the AST census reproduces both with zero
  // refusals. Every other package is held at its earlier value by the tests
  // above, so a suite quietly deleted elsewhere while `channels` landed cannot
  // hide inside the new total.
  //
  // TWO WAVES, AND THE SECOND MOVED NO FILE. 0 -> 263 built the context (15
  // files, 7 domain suites, 7 application suites and the contracts barrel);
  // 263 -> 269 is the unenforced-fence wave, six refusals in suites that already
  // existed. A file-count pin would have been blind to the second, which is the
  // case this canary exists for.
  //
  // The +6 is written out so a deletion cannot hide inside an addition: 4 in
  // domain/installation.test.ts (30 -> 34) for the refresh fence's THIRD AXIS,
  // 1 in contracts/channels-contract.test.ts (18 -> 19) for `describeApp` being
  // invisible across environments, and 1 in
  // application/channels-erasure-target.test.ts (12 -> 13) for the foreign-plan
  // refusal and its positive control.
  //
  // `RefreshExpectation.credentialRevision` IS THE THIRD AXIS AND IT STAYS.
  // Deleting the field compiled and left all 263 of this context's cases green,
  // which is what those four cases now prevent; the ground-truth
  // `channel-persistence.service.ts` enforces three axes, so removing it would
  // be a silent regression rather than a simplification.
  //
  // M2 WAVE-B: the channels branch pinned 717 + 283 + 269 = 1269 and was right
  // alone; here the identity only closes with every adoption's term present.
  assert.equal(EXPECTED["packages/contexts/channels"].files, 15);
  assert.equal(EXPECTED["packages/contexts/channels"].cases, 269);
  assert.equal(EXPECTED["packages/contexts/channels"].cases, 263 + 4 + 1 + 1);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350);
});

test("the governance context is pinned at what vitest prints", () => {
  // The ONE row WIN-256's governance slice moves. `pnpm --filter
  // @platos/context-governance exec vitest run` prints "Test Files 31 passed
  // (31) / Tests 609 passed (609)"; the AST census reproduces both with zero
  // refusals. Every other package is held at its previous value by the tests
  // above, so a suite quietly deleted elsewhere while governance landed cannot
  // hide inside the new total.
  //
  // 0 -> 609 with the file count 0 -> 31: 586 at the first pin, +1 for the case
  // that replaced a claim the schema contradicted, +22 for guards an adversarial
  // pass found nothing could turn red. The file count never moved through either
  // addition, which is the drift a file-count pin cannot see; the reasoning for
  // each addend is in the header of scripts/arch/test-case-census.mjs. The TOTAL does, and it is written as a sum
  // of every pinned row rather than as `previous + 586`, so a row that fell
  // while this one rose cannot cancel out and reach the same number.
  //
  // M2 WAVE-B: the governance branch pinned 717 + 283 + 515 + 609 = 2124 and
  // was right alone — it branched from the agents branch, so agents' 515 was
  // the only other adoption it could see. Here the identity only closes with
  // every adoption's term present, and 2124 would be short by 3376.
  assert.equal(EXPECTED["packages/contexts/governance"].files, 31);
  assert.equal(EXPECTED["packages/contexts/governance"].cases, 609);
  assert.equal(EXPECTED["packages/contexts/governance"].cases, 586 + 1 + 22);
  assert.equal(
    EXPECTED_RUNTIME_TOTAL,
    717 + 346 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 350,
  );
  assert.equal(
    EXPECTED_RUNTIME_TOTAL,
    Object.values(EXPECTED).reduce((total, row) => total + row.cases, 0)
  );
});

test("the conversations context is pinned at what vitest prints", () => {
  // THE SEVENTEENTH AND LAST CONTEXT, and the ONE row this issue moves.
  // `pnpm --filter @platos/context-conversations exec vitest run` prints
  // "Test Files 29 passed (29) / Tests 350 passed (350)".
  //
  // 0 -> 350 with the file count 0 -> 29, written as a sum of its three layers
  // rather than as a single literal, so a domain suite that vanished while an
  // application suite arrived cannot reach the same total: 194 domain cases
  // across 17 files, 143 application cases across 11, and 13 on the published
  // contract. The contract layer is one file and it is not optional — it is the
  // only layer that reaches `erasureTarget()` THROUGH the published binder, and
  // a binder that stopped publishing it is the defect another context shipped
  // this month.
  //
  // The 143 includes the twelve suites salvaged from the interrupted run. They
  // ran green under vitest, which never typechecks, while `tsc -b` rejected five
  // of their identifier constructions — so "the suites pass" and "the package
  // builds" were two different questions and only one of them had been asked.
  assert.equal(EXPECTED["packages/contexts/conversations"].files, 29);
  assert.equal(EXPECTED["packages/contexts/conversations"].cases, 350);
  assert.equal(EXPECTED["packages/contexts/conversations"].files, 17 + 11 + 1);
  assert.equal(EXPECTED["packages/contexts/conversations"].cases, 194 + 143 + 13);
  // Nothing may import this context (ADR M0.3 §1 row 16), so no other row can
  // move because of it. The workspace total is the previous one plus this row.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 5150 + 350);
});

test("every V1 package has a pinned row, including the ones with no tests yet", () => {
  const live = listPackages();
  assert.deepEqual(live.sort(), Object.keys(EXPECTED).sort());
  assert.equal(live.length, 30);
});
