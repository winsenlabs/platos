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
  // (WIN-256). The axes are disjoint and every
  // adoption moves THIS SAME number, so it is their sum. WIN-256's MODEL ROUTER
  // ADAPTER adds two more terms: +2 for the two PURE domain suites it puts
  // in the ALREADY-REAL providers row, and +15 for the adapter row itself, which
  // is the FIRST row under `packages/adapters` ever to hold a case; and
  // `conversations` adds +29 as the SEVENTEENTH AND LAST context (ADR M0.3 §1
  // row 16):
  // 88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 + 19 + 15 + 31 + 4 + 2 + 15 + 29 =
  // 357. The
  // eventing branch pinned 102, the
  // skills branch pinned 108, the jobs branch pinned 104, the memory branch
  // pinned 116, the cost-monitoring branch pinned 109, the privacy branch pinned
  // 103, the observability branch pinned 103 as well and the agents branch
  // pinned 113, the tools branch pinned 107 and the channels branch pinned 103;
  // the governance branch, which alone branched from agents rather than from v1,
  // pinned 144, the conversations-prerequisite branch pinned 92 and the model
  // router adapter branch pinned 109. Each is
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
  // WIN-257 then adds four more terms: +1 the identity-access contract
  // suite, +2 the tenancy creation suites, +4 the read models (two per
  // package) and +3 the session-cookie contract with the two suites the line
  // budget forced out of the façade file. Its own branch pinned 98, read off
  // v1 where only six rows were real. The conversations branch pinned 340 for
  // the same reason, blind to the adapter's +17 and to WIN-257's +10. Each is
  // right alone and wrong here; 357 + 10 = 367 is the number on this tree.
  //
  // WIN-258 TRANCHE 2 adds a term: +7 suites in the postgres-tenancy
  // adapter row, which was already real at 4. 371 + 7 = 378.
  //
  // WIN-258 TRANCHE 3 adds +5 to that same row — tenancy's other five ports,
  // one pure suite and four real-PostgreSQL ones.
  //
  // WIN-258 TRANCHE 4 adds the last TWO, and they are two terms rather than one
  // because the kernel outbox is two packages: +4 in the postgres-tenancy row
  // and +4 turning `packages/adapters/outbox` real. It is two packages because
  // `Event` has an owner that is an adapter and the ORM has one home (ADR M0.3
  // §15), so the package that owns the port cannot be the one that issues its
  // INSERT.
  //
  // The two tranches land TOGETHER, so the total is 378 + 5 + 4 + 4 = 391 — the
  // SUM of both, not either branch's own 383 or 386.
  //
  // WIN-258 TRANCHE 5 adds THREE terms, +6, +6 and +6, and all of them land on
  // the SAME postgres-tenancy row every tranche since 2 has landed on: the six
  // `tools` suites, the six `agents` ones and the six `cost-monitoring` ones. No
  // CONTEXT row moves at all — their suites already existed, because tranche 5
  // implements ports rather than widening them. Of the eighteen, four have no
  // database in them (`tools-mapping.test.ts`, `agents-guards.test.ts`,
  // `agents-rows.test.ts`, `cost-rows.test.ts`) and fourteen are
  // real-PostgreSQL. 391 + 6 + 6 + 6 = 409.
  //
  // COST-MONITORING'S SECOND SWEEP ADDS THE NINETEENTH, to the same row again.
  // Four guards were falsifiable only through a crashed `beforeAll` in the
  // conformance suite, so no named case saw them;
  // `cost-idempotency.integration.test.ts` is the file that gives them one.
  // 409 + 1 = 410.
  //
  // CHANNELS' CANONICAL STORE ADDS SIX MORE, to the same row again, and no
  // CONTEXT row moves for it either: one pure (`channels-rows.test.ts`) and five
  // real-PostgreSQL. 410 + 6 = 416.
  // AND `governance` ADDS SIX MORE to that same row: the differential, the
  // constraint pairs, the database rules, the statement pins, the failure
  // injection, and the ONE pure suite that reaches the mapping branches a
  // container cannot — a container only ever reads rows this binary wrote.
  // No context row moves, for the fourth time.
  //
  // AND `secrets` ADDS NINE MORE: eight real-PostgreSQL and one pure
  // (`secrets-rows.test.ts`). 410 + 6 + 6 + 9 = 431 across the three of them.
  //
  // AND `providers` ADDS SEVEN: six real-PostgreSQL and one pure
  // (`providers-rows.test.ts`). It is SEVEN rather than six because the §6
  // budget split the constraints proof at 491 effective lines, along the port's
  // own seam — `ProviderKey`'s rules are environment-scoped and `Model`'s and
  // `ModelPrice`'s have no scope at all. 410 + 6 + 6 + 9 + 7 = 438 across the
  // four of them. No context row moves, for the fifth time.
  //
  // AND `conversations` ADDS EIGHT, to the same row a fourth time and with no
  // CONTEXT row moving for it either: seven real-PostgreSQL and one pure
  // (`conversations-rows.test.ts`). THREE of the eight exist only because
  // `max-file-lines` bit at the 500-line HARD error — the shared scenario, the
  // constraints suite and the rules suite each split along a seam they already
  // had — which is worth saying here rather than absorbing, because a file count
  // that moved by eight for five suites' worth of work is exactly the kind of
  // thing this census is for. 431 + 8 = 439.
  //
  // AND `skills` ADDS SIX MORE: five real-PostgreSQL and one pure
  // (`skills-rows.test.ts`), and for the fifth time no CONTEXT row moves — the
  // port it implements already existed.
  //
  // AND `memory` ADDS SEVEN MORE to the same row a fourth time: six
  // real-PostgreSQL and one pure (`memory-rows.test.ts`). No CONTEXT row moves
  // for it either — both ports already existed, and widening a port entry point
  // 431 + 7 + 8 + 6 + 7 = 459 across the seven of them. No context row moves,
  // for the eighth time.
  //
  // AND THE FOUR STORES BESIDE IT ADD 25 MORE to the same row: `jobs` seven,
  // `files` seven, `observability` five and `eventing` six. 459 + 31 = 490. No
  // context row moves, for the NINTH time — every port already existed, and
  // widening a port entry point is not a new file.
  //
  // AND WIN-258 TRANCHE 7 ADDS SIX MORE to the same row, for the TENTH time
  // with no context row moving: the plan dimension implements no port at all.
  // 490 + 6 = 496.
  assert.equal(live.totalFiles, 496);
  // The sum is written out beside the literal so a file that vanished while
  // governance's 31, the prerequisite's 4, the adapter's 17 and conversations'
  // 29 arrived cannot reach the same total.
  assert.equal(live.totalFiles, 88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 + 19 + 15 + 31 + 4 + 2 + 15 + 29 + 1 + 2 + 4 + 3 + 4 + 7 + 5 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 + 7 + 8 + 6 + 7 + 6 + 7 + 7 + 5 + 6 + 6);
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
  // -> 276 -> 307 -> 311 -> 313 -> 328 -> 357: +21 providers, +14 the suites
  // `eventing` brings with it (ADR M0.3 §1 row 17), +20 the suites `skills`
  // brings, +16 the suites `jobs` brings, +28 the suites `memory` brings, +21
  // the suites `cost-monitoring` brings, +15 the suites `privacy` brings, +15 the
  // suites `observability` brings, +25 the suites `agents` brings, +19 the suites
  // `tools` brings, +15 the suites `channels` brings, +31 the suites
  // `governance` brings, and +4 the inference suites the `conversations`
  // prerequisite adds to providers, +2 the two PURE domain suites WIN-256's
  // MODEL ROUTER ADAPTER adds to that same already-real row, +15 the adapter
  // row itself, and +29 the suites `conversations` brings as the seventeenth
  // and last context. The prerequisite's +4 and the adapter's +2 are the two
  // terms here that move an already-real row rather than turning a zero row
  // real. Same 357 as above, re-derived from the pinned rows rather than the
  // tree.
  // WIN-257 then adds the last four terms: +1 the identity-access contract
  // suite, +2 the tenancy creation suites, +4 the read models (two per
  // package) and +3 the session-cookie contract with the two suites the line
  // budget forced out of the façade file. Its own branch pinned 98 and the
  // conversations branch pinned 340, each read off a tree missing the other's
  // rows; both are right alone and wrong here.
  //
  // WIN-258 adds the last term: +4 for the postgres-tenancy adapter — two unit
  // suites, and two REAL-PostgreSQL suites that this census counts and
  // `pnpm test:v1-packages` does not run. 367 + 4 = 371.
  //
  // WIN-258 TRANCHE 2 adds +7 to that same already-real row: one pure suite and
  // SIX real-PostgreSQL ones — the conformance differential against the
  // in-memory fake, the migration-only constraint proofs, the failure-injection
  // transaction proofs, the measured statement counts, and the two halves of the
  // differential against `PlatosAuthService`. 371 + 7 = 378. Ninety of the 378
  // files' cases are integration cases this census counts and
  // `pnpm test:v1-packages` does not execute; the `postgres-tenancy-repository`
  // CI job is what makes them run.
  //
  // WIN-258 TRANCHE 3 adds +5 to that same already-real row: one pure suite for
  // the invitation token issuer and FOUR real-PostgreSQL ones — whether the
  // locks block, the shared conformance scenario over the five ports, the scope
  // refusals with failure injection, and the statement counts.
  //
  // WIN-258 TRANCHE 4 adds the last TWO terms: +4 to that same postgres-tenancy
  // row, all four real-PostgreSQL suites for the `Event` row, and +4 turning
  // `packages/adapters/outbox` real with four suites that need no database at
  // all.
  //
  // WIN-258 TRANCHE 5 adds THREE terms, +6 each, to that same postgres-tenancy
  // row, and a fourth term of +1 from one store's second sweep: the `tools`
  // canonical store's one pure suite and FIVE real-PostgreSQL ones, the `agents`
  // store's two pure suites and FOUR real-PostgreSQL ones, and the
  // `cost-monitoring` store's one pure suite and FIVE real-PostgreSQL ones plus
  // `cost-idempotency`. `tools-isolation.integration.test.ts`,
  // `agents-guards.test.ts` and `cost-idempotency.integration.test.ts` all exist
  // because a mutation sweep found guards nothing could falsify.
  //
  // 378 + 5 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 + 7 + 8 + 6 = 452, and 598 of
  // those files' cases are integration cases the `postgres-tenancy-repository`
  // CI job runs and `pnpm test:v1-packages` does not, across 67 files.
  //
  // THIS SENTENCE SAID 159 AND THE TREE SAID 144, AT THE BASE OF THIS BRANCH
  // (tejas/win-258-postgres-ownership @ 42daafb3) AND BEFORE ANY TRANCHE-5 STORE
  // EXISTED. The decomposition it offered — "the ninety above plus tranche 3's
  // 36 and tranche 4's 33" — does not sum to 159 either; 90 + 36 + 33 = 159 was
  // arithmetic over a term that was never ninety. The real decomposition is the
  // row's ORIGINAL 25 real-PostgreSQL cases, plus tranche 2's six suites
  // (3 + 16 + 11 + 7 + 4 + 9 = 50), plus tranche 3's four (12 + 8 + 10 + 6 = 36),
  // plus tranche 4's four (11 + 12 + 7 + 3 = 33): 25 + 50 + 36 + 33 = 144. It is
  // corrected rather than carried because it is a COUNT OF CASES stated in prose
  // beside an asserted one, and the two disagreeing is the failure this file
  // exists to catch. Every integration case in the tree is this one package's —
  // `packages/adapters/outbox`'s four suites need no database at all — which is
  // why the tree total and the row's own total are the same number.
  //
  // 144 + `tools`' 39 (12 + 8 + 7 + 5 + 7, over 5 files)
  //     + `agents`' 39 (16 + 12 + 9 + 2, over 4 files)
  //     + `cost-monitoring`'s 43 (13 + 8 + 7 + 6 + 5, over 5 files, + 4 over
  //       cost-idempotency) = 265, over 31 files.
  //     + `channels`' 47 (16 + 10 + 10 + 6 + 5, over 5 files) = 312, over 36.
  //     + `governance`'s 45 (1 + 12 + 10 + 15 + 7, over 5 files) = 357, over 41.
  //     + `secrets`' 65 (11 + 10 + 8 + 8 + 8 + 7 + 7 + 6, over 8 files; its
  //       ninth suite, `secrets-rows.test.ts`, is PURE and runs in the ordinary
  //       package script) = 422, over 49 files.
  //     + `conversations`' 73 (14 + 12 + 11 + 11 + 8 + 16 + 1, over 7 files; its
  //       eighth suite, `conversations-rows.test.ts`, is PURE and runs in the
  //       ordinary package script) = 495, over 56 files,
  //     + `skills`' 43 (17 + 15 + 7 + 2 + 2, over 5 files; its sixth suite,
  //       `skills-rows.test.ts`, is PURE for the same reason) = 538, over 61 —
  //       and 598 over 67 once the eleven integration suites the four EARLIER
  //       owners contribute are counted with them.
  // ALL THREE branches in this wave independently corrected the 159 and each
  // landed on a figure counted against the base alone — 183, 183 and 187.
  // Merged the figure is none of them.
  //
  // EACH TRANCHE'S PURE SUITE IS DELIBERATELY NOT IN THAT SPLIT.
  // `channels-rows.test.ts` (25 cases), `governance-rows.test.ts` (21),
  // `secrets-rows.test.ts` (18), `providers-rows.test.ts` (17),
  // `conversations-rows.test.ts` (24), `skills-rows.test.ts` (19) and
  // `memory-rows.test.ts` (24) reach the mapping branches a container suite
  // cannot, because a container only ever reads rows this binary wrote — and
  // `conversations`' is the sharpest of the seven, because the branches it
  // reaches include a `Decimal` the DRIVER renders in exponential form, which
  // no row this binary wrote can produce. They run in the ordinary package test
  // script, which is why the runnable term goes
  // 118 + 25 + 21 + 18 + 17 + 24 + 19 + 24 = 266 while the integration term
  // goes 265 + 47 + 45 + 65 + 60 + 73 + 43 + 65 = 663, and 266 + 663 = 929 is
  // the row's whole case count.
  //
  // AND EACH OF THE FOUR STORES BESIDE `privacy` SHIPS ONE PURE SUITE TOO —
  // `jobs-rows.test.ts` (22), `files-rows.test.ts` (21),
  // `observability-rows.test.ts` (15) and `eventing-rows.test.ts` (17). Each
  // reaches the same kind of branch for the same reason: a row an older binary
  // wrote, a status the current one never writes, an envelope shape no container
  // can produce, because a container only ever reads rows this binary wrote.
  // They run in the ordinary package test script, so the runnable term goes
  // 266 + 25 + 22 + 21 + 15 + 17 = 366 and the integration term
  // 663 + 51 + 75 + 79 + 37 + 39 = 944, and 366 + 944 = 1310 is the row's whole
  // case count over 119 files.
  //
  // AND WIN-258 TRANCHE 7 SHIPS ONE PURE SUITE TOO, `plans-probe.test.ts` (23),
  // and it is the largest of its five rather than the smallest: it is the
  // measurement kit the four container suites report their numbers from, so it
  // is the one part of that dimension no other part can check. The runnable term
  // goes 366 + 23 = 389 and the integration term 944 + 60 = 1004, and
  // 389 + 1004 = 1393 is the row's whole case count over 125 files.
  assert.equal(files, 496);
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
  assert.equal(EXPECTED["packages/contexts/identity-access"].cases, 318, "231 at 3ed8f3ce, +25 contract suite, +28 end-user read, +34 session cookie");
  assert.equal(EXPECTED["packages/contexts/secrets"].cases, 162);
  assert.equal(EXPECTED["packages/contexts/tenancy"].cases, 207, "146 at 3ed8f3ce, +29 creation suites, +31 read models, +1 the project-order fix");
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
  // The ONE row that has moved THREE TIMES, and the only row in this file that
  // two wave-B slices moved without adopting a context. The rebase onto
  // 75ee484de252 made it real at 21 files / 283 cases; WIN-256's inference
  // surface (ADR M0.3 §14) adds four suites and 63 cases and takes nothing away;
  // WIN-256's MODEL ROUTER ADAPTER then adds the two PURE pieces it would
  // otherwise have hidden beside an SDK call — domain/tool-input-repair and
  // domain/structured-output, 16 and 9 cases — plus one case in each of four
  // existing suites: two in `errors.test.ts` (the adapter's seven new codes kept
  // apart from the codes they resemble, and a failed schema loop carrying what it
  // spent) and the pass budget in `generation.test.ts` and
  // `run-model-generation.test.ts`. That is +2 files and +29 cases. `pnpm
  // --filter @platos/context-providers exec vitest run` prints "Test Files 27
  // passed (27) / Tests 375 passed (375)"; the AST census reproduces both with
  // zero refusals. Every other
  // package is held at its 3ed8f3ce value by the test above, so a suite quietly
  // deleted elsewhere while these landed cannot hide inside the new total.
  assert.equal(EXPECTED["packages/contexts/providers"].files, 21 + 4 + 2);
  assert.equal(EXPECTED["packages/contexts/providers"].cases, 283 + 63 + 29);
  // The runtime total is re-derived from EVERY slice that contributes cases,
  // so a row moved without its delta cannot hide inside it. The eventing
  // context is the third: 142 at adoption, 147 after the 2026-09-03
  // verification's five cases, 149 after the two that close its last two
  // survivors — all with the file count held at 14. Skills is the fourth at
  // 306, jobs the fifth at 378, memory the sixth at 605 and cost-monitoring the
  // seventh at 352; each is pinned by its own test.
  // WIN-258 tranche 2 adds the last term, +67, to the postgres-tenancy row that
  // tranche 1 made real at 56.
  //
  // AND THE FINAL +83 IS WIN-258 TRANCHE 7, on that same adapter row and on no
  // other: the indexes/query-plans/pagination/count-truth dimension implements
  // no port, so not one context row moves for it. Every one of the eleven
  // re-derivations below carries the same term, which is the property this
  // file exists for — a sum stated once can be edited once, and a sum stated
  // eleven ways cannot.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  // Every previously-real package is where the last verification left it: an
  // adoption that quietly moved another context's numbers would be caught here
  // rather than absorbed into the new total. Two rows are NOT at their
  // 2026-09-02 values any more, and are carried at their current ones on
  // purpose: WIN-257 moved identity-access 231 -> 318 and tenancy 146 -> 207.
  // Leaving them at the old numbers would have made this map assert a tree that
  // no longer exists, which is the one failure this map is here to prevent.
  const untouched = {
    "packages/kernel": 44,
    "packages/contexts/identity-access": 318,
    "packages/contexts/secrets": 162,
    "packages/contexts/tenancy": 207,
    "packages/contexts/files": 134,
    "packages/contexts/providers": 375,
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
  // 1240 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198
  // + 350 = 5875. (The trailing terms below carry every adapter tranche,
  // including tranche 5's `skills` 52.) The `untouched` base is 1240 rather than 1000 for three
  // reasons, none of them an adoption: the `conversations` prerequisite moved
  // providers 283 -> 346, WIN-256's MODEL ROUTER ADAPTER then moved it
  // 346 -> 375, and WIN-257 moved identity-access to 318 and tenancy to 207.
  // The trailing 198 is the adapter row and the trailing 350 the conversations
  // row, neither of which any `untouched` entry covers because both were zero
  // when this map was written.
  // The trailing 56 is tranche 1 of the adapter row and the 67 beside it is
  // tranche 2's identity-access half of the SAME row. Tranche 4 adds two more
  // trailing terms and they are separate on purpose: 33 is its half of that same
  // postgres-tenancy row and 39 is the outbox package, a row that was zero when
  // this map was written. Tranche 5 adds ONE more trailing term, 60, which is
  // its own half of that same postgres-tenancy row: `agents` publishes no test
  // package of its own here, so nothing but the adapter row moves. The trailing
  // 97 is the same shape a fourth time — `conversations`' canonical store, whose
  // 350-case context row above is untouched by it — the trailing 62 a fifth,
  // for `skills`, whose 306-case context row is untouched for the same reason,
  // the LAST-but-four 89 a sixth, for `memory`, whose two ports already existed
  // and whose 378-case context row does not move either, and the FINAL five —
  // 76, 97, 100, 52 and 56 — a seventh through an eleventh, for `privacy`,
  // `jobs`, `files`, `observability` and `eventing`, whose context rows above
  // are untouched for exactly the same reason: the port existed and only the
  // adapter row moved.
  assert.equal(
    sum + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83,
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
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
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
  assert.equal(
    EXPECTED_RUNTIME_TOTAL,
    Object.values(EXPECTED).reduce((total, row) => total + row.cases, 0)
  );
});

test("the model-router adapter is pinned at what vitest prints", () => {
  // The row that had never held a case, and the FIRST row under
  // `packages/adapters` to hold one at all. `pnpm --filter
  // @platos/adapter-model-router-providers exec vitest run` prints "Test Files
  // 15 passed (15) / Tests 198 passed (198)". Every other package is held at its
  // earlier value by the tests above, so a suite quietly deleted elsewhere while
  // these landed cannot hide inside the new total.
  //
  // Its branch pinned the runtime total as 717 + 283 + 63 + 29 + 198 — a chain
  // over the five terms its own tree had, not the shared thirteen-term chain the
  // tests above all re-derive. Spelling it that way is how a census stops
  // agreeing with itself, so it is re-spelled here as the same chain every other
  // row uses -- INCLUDING the trailing 350 `conversations` adds, which this test
  // must carry for the same reason every other row's re-derivation carries it.
  // The merge kept this test whole from the integration side, so its chain was
  // the one instance the +350 rewrite did not reach; `test:test-case-census`
  // caught it at 5525 against an actual 5875.
  assert.equal(EXPECTED["packages/adapters/model-router-providers"].files, 15);
  assert.equal(EXPECTED["packages/adapters/model-router-providers"].cases, 198);
  assert.equal(EXPECTED_RUNTIME_TOTAL, 717 + 375 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 + 362 + 269 + 609 + 198 + 25 + 29 + 59 + 34 + 1 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
});

test("the WIN-257 identity-access contract suite is pinned at what vitest prints", () => {
  // The row this tranche moves. Its own branch read the package at 18 files and
  // 256 cases on v1; on this tree the same package is at 23 and 318, because the
  // later tranches land in it too. The +87 is what conserves.
  assert.equal(EXPECTED["packages/contexts/identity-access"].files, 23);
  assert.equal(EXPECTED["packages/contexts/identity-access"].cases, 318);
  assert.ok(
    listTestFiles(undefined, "packages/contexts/identity-access").includes(
      "packages/contexts/identity-access/application/identity-access-service.test.ts",
    ),
  );
});

test("the WIN-257 tenancy creation suites are pinned at what vitest prints", () => {
  // The row T3 moves. `application/tenancy-service.test.ts` is EDITED and gains
  // cases, which is how an edited suite stays visible next to the two ADDED
  // ones. The whole tenancy delta over the five tranches is +4 files, +61 cases.
  assert.equal(EXPECTED["packages/contexts/tenancy"].files, 20);
  assert.equal(EXPECTED["packages/contexts/tenancy"].cases, 207);
  const files = listTestFiles(undefined, "packages/contexts/tenancy");
  assert.ok(files.includes("packages/contexts/tenancy/application/create-organization.test.ts"));
  assert.ok(files.includes("packages/contexts/tenancy/application/create-project.test.ts"));
});

test("the WIN-257 read models are pinned at what vitest prints", () => {
  // The TWO rows T4 moves, two files per package, with the remaining cases in
  // the two EDITED contract suites — 28 in identity-access and 31 in tenancy,
  // and 28 + 31 = 59.
  const identity = listTestFiles(undefined, "packages/contexts/identity-access");
  assert.ok(identity.includes("packages/contexts/identity-access/domain/end-user.test.ts"));
  assert.ok(identity.includes("packages/contexts/identity-access/application/list-end-users.test.ts"));
  const tenancy = listTestFiles(undefined, "packages/contexts/tenancy");
  assert.ok(tenancy.includes("packages/contexts/tenancy/domain/visibility.test.ts"));
  assert.ok(tenancy.includes("packages/contexts/tenancy/application/operator-read-models.test.ts"));
});

test("the WIN-257 session-cookie contract is pinned at what vitest prints", () => {
  // The row T5 moves, and the file count moves by THREE for TWO reasons.
  // `domain/session-cookie.test.ts` is new behaviour (28). The other two are a
  // split the 500-effective-line budget forced when the façade's cookie cases
  // landed: 4 end-user cases and 6 cookie cases left the façade file, which is
  // back at the 25 it held before this tranche. Only the 28 and the 6 are NEW,
  // so the case delta is 34.
  const files = listTestFiles(undefined, "packages/contexts/identity-access");
  for (const suite of [
    "domain/session-cookie.test.ts",
    "application/identity-access-service.end-users.test.ts",
    "application/identity-access-service.session-cookie.test.ts",
  ]) {
    assert.ok(files.includes(`packages/contexts/identity-access/${suite}`), suite);
  }
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
  // On its own branch "the previous one" was 5150; on the integrated tree the
  // adapter's 198 and WIN-257's 148 landed first, so it is 5525 and this row
  // closes the census at 5875. The +350 is the part that conserves.
  // WIN-258 tranche 2's 67 identity-access cases join the adapter's 56, and
  // tranche 5's last four stores — `providers`', `conversations`',
  // `skills`' and `memory`'s own canonical stores, in the ADAPTER row rather
  // than this one — add their 77, 97, 62 and 89 at the end. The context rows
  // above do NOT move for any of them: all four implement ports that already
  // existed and all four had their port entry point widened in place, which is
  // what this census distinguishes from an addition.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 5525 + 350 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
});

test("the postgres-tenancy adapter is pinned at what vitest prints", () => {
  // The ONE row WIN-258 moves, and the SECOND nonzero row under
  // `packages/adapters`. `pnpm --filter @platos/adapter-postgres-tenancy exec
  // vitest run --exclude '**/*.integration.test.ts'` prints 31 across 2 files;
  // `pnpm test:postgres-tenancy:integration` prints 25 across 2 more. The census
  // counts what the package SHIPS, so the row is the sum of both runs.
  //
  // WIN-258 TRANCHE 2 adds SEVEN more suites and 67 more cases to the same row:
  // one pure (identity-mapping.test, 17) and six real-PostgreSQL — the
  // conformance differential against the in-memory fake (3), the migration-only
  // constraint proofs (16), the failure-injection transaction proofs (11), the
  // measured statement counts (7), and the two halves of the differential
  // against `PlatosAuthService` (4 and 9). 4 + 7 = 11 files, 56 + 67 = 123.
  //
  // WIN-258 TRANCHE 3 adds FIVE more suites and 43 more cases to the same row —
  // tenancy's other five ports: one pure (invitation-token.test, 7) and four
  // real-PostgreSQL — whether the locks block and the access-key fence with its
  // negative control (12), the shared conformance scenario over the five ports
  // plus the six cases it cannot reach (8), the three scope refusals on all
  // five scoped methods with failure injection and the OperatorSession database
  // rules (10), and the measured statement counts (6).
  //
  // WIN-258 TRANCHE 4 adds FOUR more suites and 33 more cases to the same row,
  // all four real-PostgreSQL: the failure-injection transaction proofs for the
  // `Event` row (11), the migration-only and catalogue-read constraint proofs
  // (12), the measured statement counts (7), and the conformance differential
  // against the committed scenario the in-memory double is also measured against
  // (3).
  //
  // BOTH tranches move THIS row, so it carries both tails: 11 + 5 + 4 = 20 files
  // and 123 + 43 + 33 = 199 cases. Neither branch's own 16/166 nor 15/156 is the
  // merged row, and either one taken alone would drop the other's suites out of
  // a census whose whole purpose is to see every case.
  //
  // WIN-258 TRANCHE 5 adds SIX more suites and 59 more cases to the same row —
  // the `tools` canonical store over the ten rows that context owns: one pure
  // (tools-mapping.test, 20) and five real-PostgreSQL — the migration-only
  // constraint proofs (12), the tenant-isolation and transcript-integrity cases
  // (8), the measured statement counts (7), the conformance differential against
  // the in-memory double (5), and the failure-injection transaction proofs (7).
  //
  // THE ISOLATION SUITE IS NOT PADDING. Its eight cases and four of the mapping
  // suite's twenty were written because the tranche's own mutation sweep
  // (`mutations-tools.json`) found those guards UNFALSIFIABLE — the other five
  // suites stayed green with the ancestry resolve's organization half deleted,
  // with an unknown environment admitted, with the replace's entity clause gone
  // and with two orderings reversed.
  //
  // WIN-258 TRANCHE 5 adds SIX MORE suites and 60 MORE cases to the same row —
  // the `agents` canonical store, the seven rows of ADR M0.3 §1 row 5. Two of
  // the six have no database in them: the refusal parser against the three
  // shapes a refusal arrives in (`agents-guards.test.ts`, 14) and the two row
  // readers that refuse rather than inventing a value (`agents-rows.test.ts`,
  // 7). Four are real-PostgreSQL: what the MIGRATIONS refuse and
  // `schema.prisma` does not say (16), failure injection with the three
  // transaction-scope refusals and the parent row lock (12), the measured
  // statement counts (9), and the shared conformance scenario run against the
  // in-memory double and against PostgreSQL and compared verbatim (2).
  //
  // THE 2 IS THE NUMBER TO WATCH. It is two because it is TWO scenarios --
  // 47 observations over `AgentsRepository` and 29 over `ScaffoldingRepository`,
  // both counts READ OFF a run rather than tallied from the source -- compared
  // step by step. Adding an observation strengthens the differential and moves
  // no count here, which is why the guards behind it are held falsifiable in
  // `mutations-agents.json` instead.
  //
  // WIN-258 TRANCHE 5 adds SIX more suites and 61 more cases to the same row —
  // `cost-monitoring`'s canonical store, the THIRD owner behind the one ORM
  // client: one pure (cost-rows.test, 22, the row mapping in both directions and
  // every guard) and five real-PostgreSQL — each guard beside the migration
  // CHECK it restates (13), the database rules no port method restates (8), the
  // failure injection on both two-statement operations with their negative
  // controls and the three scope refusals (7), the measured statement counts
  // (6), and the conformance differential against `InMemoryBudgetRepository`
  // (5).
  //
  // WIN-258 TRANCHE 5's SECOND SWEEP adds a SEVENTH suite and 4 more cases to
  // the same row. Re-running all forty ledger entries scored six with zero
  // executed cases: the edits compiled and collected, then broke the conformance
  // suite while it was BUILDING its transcript, in a `beforeAll`, so vitest
  // reported every case in that file SKIPPED and its pin of 5 did not move. Two
  // of the six had a named case elsewhere; the four in `cost-idempotency` had
  // none anywhere — the insert form that does not raise, the uuid shape test the
  // vault's revoke depends on, the terminal status that stops a second send, and
  // the count test that keeps a stale dispatcher's send record out of the
  // history. The conformance suite's 5 is deliberately unchanged: added there,
  // those four observations would have been invisible to this census.
  //
  // WIN-258 TRANCHE 5 adds SIX more suites and 72 more cases to the same row —
  // `channels`' canonical store, the SIXTH context owner behind the one ORM
  // client: one pure (channels-rows.test, 25, the row mapping in both directions
  // and every guard) and five real-PostgreSQL — each guard beside the
  // migration-only CHECK it restates or the database's willingness to take the
  // value (16), the database rules no port method restates (10), failure
  // injection over a second client with BOTH answers a returned error Result
  // gives and the three scope refusals (10), the measured statement counts (6),
  // and the conformance differential against `InMemoryChannelsRepository` (5).
  //
  // THE 25 IN THE PURE SUITE IS THE LARGEST PURE ROW ANY TRANCHE HAS ADDED, and
  // that is a fact about this port rather than about its author: `channels` is
  // the only context whose store has to REFUSE a row it can read — an unknown
  // installation status, an unknown inbox status, an unreadable routing table —
  // and each of those decisions is a value mapping with no database in it.
  //
  // ALL FIVE tranches move THIS row, so it carries every tail:
  // 11 + 5 + 4 + 6 + 6 + 6 + 1 + 6 + 6 = 51 files and
  // 123 + 43 + 33 + 59 + 60 + 61 + 4 + 72 + 66 = 521 cases. No branch's own row is
  //
  // WIN-258 TRANCHE 5 adds NINE more suites and 83 more cases to the same row —
  // `secrets`' canonical store, the FOURTH owner behind the one ORM client: one
  // pure (secrets-rows.test, 18, the three closed unions a row is read back
  // through and each of the nine guards on both sides of its boundary) and six
  // real-PostgreSQL — the database rules no port method restates (11), the
  // measured statement counts (10), the differential against
  // `inMemorySecretsStore` (8), each vault guard beside the migration CHECK it
  // restates (8), the failure injection with the three scope refusals and the
  // row lock (7), and the variable's three CHECKs with the two guards that stand
  // where no CHECK does (7), and the clauses that decide WHICH ROW a call
  // reaches (6) and the seven refusals whose only witness was a crashed hook
  // (7) — the eighth and ninth suites, which exist because the sweep found six
  // clauses with no named case anywhere and seven more whose only witness was a
  // `beforeAll` that raised.
  //
  // WIN-258 TRANCHE 5 adds SEVEN more suites and 77 more cases to the same row —
  // `providers`' canonical store, the FIFTH owner behind the one ORM client and
  // the NINTH overall: one pure (providers-rows.test, 17, the three column
  // renames the schema and the aggregates disagree about, every guard, and the
  // two unreadable-row refusals) and six real-PostgreSQL — `ProviderKey`'s five
  // database rules each stood beside a raw statement that steps around the
  // guard (13), the same pairing for `Model` and `ModelPrice` (12), the
  // conformance differential against `InMemoryProvidersRepository` (11), the
  // rules no port method restates (10), failure injection with the touch that
  // survives a rollback and the three scope refusals (7), and the measured
  // statement counts (7).
  //
  // IT IS SEVEN SUITES RATHER THAN SIX BECAUSE THE §6 BUDGET SPLIT ONE, at 491
  // effective lines and four lines of prose from the hard error. The seam is the
  // port's own and not an arbitrary halving: `ProviderKey`'s rules are
  // ENVIRONMENT-SCOPED and every case needs a tenant chain and a credential,
  // while `Model` and `ModelPrice` have no scope at all.
  //
  //
  // AND `conversations` ADDS EIGHT AND 97: the turn rollup and the driver's
  // exponential decimal in a PURE suite (24), each Thread and Turn guard beside
  // its migration CHECK (14), the same over a bill and an operator's audit row
  // (12), the three immutability rules with the tenant boundary (11), the
  // deletion rules and the transcript filter the double does not implement (11),
  // the failure injection with the three scope refusals and the blocking row
  // lock (8), the measured statement counts (16), and the differential against
  // `InMemoryConversations` (1). THREE of the eight exist only because
  // `max-file-lines` bit at the HARD error.
  //
  //
  // WIN-258 TRANCHE 5 adds SIX more suites and 62 more cases to the same row —
  // `skills`' canonical store, the NINTH owner behind the one ORM client, over
  // the three rows ADR M0.3 §1 row 6 gives it: one pure (skills-rows.test, 19,
  // the row readers and the eight write guards on BOTH sides of each boundary,
  // plus the assertion that all thirteen refusal codes are distinct) and five
  // real-PostgreSQL — the rows an older binary could have written, planted as
  // SQL, together with the two store/double divergences pinned rather than
  // hidden and the two write paths whose input the port cannot produce (15), the
  // three migration-only CHECKs read back out of `pg_catalog`, the three
  // immutability RULES and both ancestry RULES proved by statements that must
  // RAISE, the shape refusals falsified in PAIRS, and the five clauses that
  // decide WHICH ROW a call reaches (17), the
  // failure injection over a
  // SECOND client with the three scope refusals (7), the conformance
  // differential with its negative control (2) and the statement counts, whole
  // map at once over two fixtures, with the probe-filter case (2).
  //
  // TWO OF ITS SUITES ARE ONE CASE APIECE, which is the LOWEST any tranche has
  // added and is a fact about the instrument rather than about the coverage: a
  // differential is one scenario compared verbatim and a statement pin is one
  // map compared whole, so strengthening either adds observations and no cases.
  // `mutations-skills.json` beside the package is where those guards are held
  // falsifiable instead.
  //
  //
  // WIN-258 TRANCHE 5 adds SEVEN more suites and 89 more cases to the same row —
  // `memory`'s canonical store, the NINTH owner behind the one ORM client: one
  // pure (memory-rows.test, 24, the row mapping in both directions and every
  // guard, including the three vocabulary columns a row written by an older
  // binary can hold) and six real-PostgreSQL — what the MIGRATIONS refuse and
  // `schema.prisma` does not say (18), the measured statement counts (18), the
  // failure injection over a SECOND client with both answers a returned error
  // `Result` gives and the three scope refusals (12), the database rules no port
  // method restates (10), the two `vector(1536)` columns the generated client
  // cannot name (5), and the conformance differential against the context's two
  // in-memory doubles (2).
  //
  // THE 5 IN THE VECTOR SUITE IS THE NUMBER TO READ, and it exists because a
  // mutation survived. `mutations-memory.json` M-M13 clears the vector on every
  // update and stayed green through FIVE suites, because no read on either port
  // returns an embedding — the only observable consequence is a row quietly
  // dropping out of every future candidate set. Two of its five cases are not
  // rules at all: they are the contract a caller CANNOT satisfy, since
  // `searchEntities` reads a column no method on its port can write. Both halves
  // are pinned rather than worked around, which is what makes it a report
  // instead of a defect.
  //
  // WIN-258 TRANCHE 5 adds SIX more suites and 76 more cases to the same row —
  // `privacy`'s canonical store, the THIRTEENTH owner behind the one ORM client,
  // and the tranche with the most LOPSIDED split any of them has had: one pure
  // (privacy-rows.test, 25) and FIVE real-PostgreSQL. That is the inverse of what
  // a two-table store suggests, and it is a fact about the guards rather than
  // about the coverage — the ones that matter here are about CONCURRENCY and
  // about the ABSENCE of a statement, and neither is observable without a real
  // database. What the MIGRATIONS refuse and `schema.prisma` does not say (20),
  // the rules a single-threaded double cannot exhibit at all (11), the measured
  // statement counts (9), failure injection over a SECOND client plus the three
  // scope refusals (9), and the conformance differential against
  // `InMemoryPrivacyRepository` (2).
  //
  // THE 11 IN THE RULES SUITE IS THE NUMBER TO READ. Four of its cases are the
  // only ones in this directory that race TWO OPEN TRANSACTIONS against each
  // other: `claimLease` is a compare-and-set whose loser is decided by a row
  // lock, and the in-memory double is a map in a single-threaded process that
  // cannot lose a race. Two more prove the barrier by the ABSENCE of a DELETE —
  // insert-then-extend is a rule about an instant that must not exist, so
  // "the row is there afterwards" would have been satisfied by the very
  // delete-then-insert the port forbids.
  //
  // ALL FIVE tranches move THIS row, so it carries every tail:
  // 11 + 5 + 4 + 6 + 6 + 6 + 1 + 9 + 7 + 8 + 6 + 7 + 6 + 7 + 7 + 5 + 6 = 107 files and
  // 123 + 43 + 33 + 59 + 60 + 61 + 4 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56
  // = 1172 cases.
  // No branch's own row is the merged row, and any one taken alone would drop
  // the others' suites out of a census whose whole purpose is to see every case.
  assert.equal(
    EXPECTED["packages/adapters/postgres-tenancy"].files,
    2 + 2 + 1 + 6 + 1 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 + 7 + 8 + 6 + 7 + 6 + 7 + 7 + 5 + 6 + 6,
  );
  assert.equal(
    EXPECTED["packages/adapters/postgres-tenancy"].cases,
    17 + 14 + 16 + 9 + 17 + 3 + 16 + 11 + 7 + 4 + 9 + 7 + 12 + 8 + 10 + 6 + 11 + 12 + 7 + 3 +
      20 + 12 + 8 + 7 + 5 + 7 +
      14 + 7 + 16 + 12 + 9 + 2 +
      22 + 13 + 8 + 7 + 6 + 5 + 4 +
      25 + 16 + 10 + 10 + 6 + 5 +
      1 + 12 + 21 + 10 + 15 + 7 +
      18 + 11 + 10 + 8 + 8 + 8 + 7 + 7 + 6 +
      17 + 11 + 13 + 12 + 10 + 7 + 7 +
      24 + 14 + 12 + 11 + 11 + 8 + 16 + 1 +
      19 + 15 + 17 + 7 + 2 + 2 +
      24 + 18 + 18 + 12 + 10 + 5 + 2 +
      25 + 20 + 11 + 9 + 9 + 2 +
      22 + 16 + 16 + 15 + 14 + 13 + 1 +
      21 + 2 + 15 + 16 + 31 + 9 + 6 +
      15 + 17 + 10 + 9 + 1 +
      17 + 15 + 9 + 7 + 5 + 3 +
      23 + 10 + 13 + 10 + 13 + 14,
  );
  assert.equal(EXPECTED["packages/adapters/postgres-tenancy"].cases, 1393);
  // 389 of the 1393 run in `pnpm test:v1-packages`; the other 1004 need a Docker
  // daemon and run in the `postgres-tenancy-repository` CI job. A pin that
  // counted only the runnable 389 would go green if the integration suites were
  // deleted, which is the one change this row exists to make visible.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 5875 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56 + 83);
  assert.equal(
    EXPECTED_RUNTIME_TOTAL,
    Object.values(EXPECTED).reduce((total, row) => total + row.cases, 0)
  );
  // No other adapter row moved: NINE of the twelve are still zero, and
  // model-router-providers is untouched at 198. The tenth stopped being zero at
  // tranche 4, which is the outbox row asserted below.
  assert.equal(EXPECTED["packages/adapters/model-router-providers"].cases, 198);
  const zeroAdapters = Object.entries(EXPECTED).filter(
    ([name, row]) => name.startsWith("packages/adapters/") && row.cases === 0
  );
  assert.equal(zeroAdapters.length, 9);
});

test("the kernel outbox adapter is pinned at what vitest prints", () => {
  // WIN-258 TRANCHE 4, and the THIRD nonzero row under `packages/adapters`.
  // `pnpm --filter @platos/adapter-outbox exec vitest run` prints 39 across 4
  // files, and all 39 of them run there: this package holds no vendor client and
  // needs no container, which is the point of the split — the envelope, the
  // ordered identifier and every refusal are testable with no database, and the
  // 33 cases that DO need one sit in the postgres-tenancy row above.
  //
  // The four files are event-id (11), envelope (15), adapter (11) and
  // conformance (4). Two of those cases exist because the mutation sweep found
  // a survivor — the variant bits left as drawn, and the row stamped from the
  // raw clock — not because a reviewer thought of them. The conformance row is small on purpose: it is ONE scenario
  // of twelve observations compared verbatim against a committed transcript,
  // plus the two negative controls that make the comparison non-vacuous.
  assert.equal(EXPECTED["packages/adapters/outbox"].files, 4);
  assert.equal(EXPECTED["packages/adapters/outbox"].cases, 11 + 15 + 11 + 4);
  assert.equal(EXPECTED["packages/adapters/outbox"].cases, 41);
});

test("every V1 package has a pinned row, including the ones with no tests yet", () => {
  const live = listPackages();
  assert.deepEqual(live.sort(), Object.keys(EXPECTED).sort());
  assert.equal(live.length, 30);
});
