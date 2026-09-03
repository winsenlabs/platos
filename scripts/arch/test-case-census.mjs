#!/usr/bin/env node
// Owner decision 9 (2026-09-02) — the per-package test CASE census.
//
// WHY THIS EXISTS. `docs/v1-ledger-rules.json` pins test FILE counts
// (`packages.contexts.test: 64`, `packages.kernel.test: 3`), so deleting a whole
// test file goes red. Deleting `it()` blocks INSIDE a retained file was
// invisible to every gate in `.github/workflows/ci.yml`: `test:v1-packages`
// prints "716 passed" and passes just as happily at 700. Finding 6 of the
// 2026-09-02 independent verification put it plainly — "716 is evidence, not a
// canary" — and the owner decided the case count is pinned, not only the file
// count. Everything else in this programme pins its census; this was the hole.
//
//   node scripts/arch/test-case-census.mjs          # check, exit 1 on drift
//   node scripts/arch/test-case-census.mjs --json   # machine-readable
//
// WHAT A "CASE" IS. A call to `it()` or `test()` in a `*.test.ts` file under a
// V1 package, counted on the AST so a name in a string or a comment is not a
// case. `it.each([a, b, c])(...)` counts as THREE, because that is what vitest
// reports, and pinning the declaration site instead would let two thirds of a
// table be deleted silently.
//
// IT REFUSES RATHER THAN GUESSES. The census is exact or it fails. Anything that
// makes the static count differ from the runtime count is a REFUSAL, reported
// with its file and line and failing the check:
//
//   * `it.each` over anything but an array literal, or as a tagged template —
//     the row count is not statically visible.
//   * `describe.each` — it multiplies every case inside it.
//   * a case declared inside a helper function, a loop, or any callback that is
//     not a `describe`/`suite` body — the site is one, the runtime count is not.
//
// That refusal list is what lets the pinned numbers below be the SAME numbers
// vitest prints, rather than a second, weaker census that happens to correlate.
//
// HONEST LIMITATIONS.
//   * It counts DECLARATIONS. A case that throws at collection time, a
//     `describe` skipped by a runtime condition, or a `test.skipIf` that is
//     false in CI still counts as one here. `nonExecuting` below is pinned at 0
//     precisely so none of those can arrive unnoticed.
//   * It reads `*.test.ts` only, matching what `test:v1-packages` runs. A
//     `.test.tsx`, `.spec.ts` or `__tests__/` convention would be invisible; the
//     file counts pinned here are the control on that.
//   * It says nothing about whether a case ASSERTS anything. Emptying an `it()`
//     body is not drift this gate can see. Mutation testing is the control for
//     that, and it is a separate discipline in this programme, not this file's.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** `packages/kernel` is a package; the other two are directories OF packages. */
export const PACKAGE_ROOTS = Object.freeze(["packages/kernel", "packages/contexts", "packages/adapters"]);

const TEST_FILE_SUFFIX = ".test.ts";
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "generated", "coverage"]);

/** Identifiers that declare a case, and the ones that only group. */
const CASE_ROOTS = new Set(["it", "test"]);
const GROUP_ROOTS = new Set(["describe", "suite"]);

/** Chain members that expand one declaration site into many runtime cases. */
const EXPANDING_MODIFIERS = new Set(["each", "for"]);

/** Chain members that stop a declared case from executing. */
const NON_EXECUTING_MODIFIERS = new Set(["skip", "todo"]);

/**
 * The pinned census. One row per V1 package, zeros included: a package that
 * gains its first test must be declared here, so "a new context arrived with no
 * suite" and "a suite was deleted" are the same kind of failure.
 *
 * DELTAS AGAINST `3ed8f3ce972289908a7d129bbb682e977405770f`, the head the
 * 2026-09-02 independent verification reproduced. It recorded 716 cases across
 * 67 files, split kernel 44, identity-access 231, secrets 162, tenancy 146,
 * files 133. This census reproduces that split exactly and carries ONE delta:
 *
 *   files 133 -> 134 (+1), 716 -> 717 total. The storage-key separator case
 *   added to close MAJOR 2 of that verification —
 *   `packages/contexts/files/domain/storage-key.test.ts`, "is not fooled by a
 *   first segment that merely BEGINS with the attachment segment". Deleting the
 *   trailing "/" from `storageKeyBelongsToScope` left all 133 green; it now
 *   turns exactly this case red. File count is unchanged at 15 for `files`,
 *   which is precisely the drift a file-count pin cannot see and this one can.
 *
 * REBASE DELTA (2026-09-02), `tejas/win-256-providers-context` onto
 * `75ee484de252`. The providers context was built on `3ed8f3ce`, so it predates
 * this census and its row was still the 0/0 placeholder that the map deliberately
 * carries for every unbuilt package. Making it real moves ONE row:
 *
 *   providers 0 -> 21 files, 0 -> 283 cases; 717 -> 1000 total. 13 domain
 *   suites, 7 application suites and the contracts-barrel suite. The census
 *   REFUSED nothing in that tree, so its 283 is a statically exact count, and
 *   `pnpm --filter @platos/context-providers exec vitest run` prints the same
 *   pair — "Test Files 21 passed (21) / Tests 283 passed (283)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 * No other package moved: the rebase touched no suite outside providers, and
 * `files` stays at the 134 that closed MAJOR 2. Any further drift is a finding
 * to report, not a number to force.
 *
 * WIN-256, `tools` (ADR M0.3 §1 context 7). One row moves:
 *
 *   tools 0 -> 18 files, 0 -> 299 cases; 1000 -> 1299 total. 13 domain suites,
 *   4 application suites and the contracts-barrel suite. The census REFUSED
 *   nothing in that tree, so its 299 is a statically exact count, and
 *   `pnpm --filter @platos/context-tools exec vitest run` prints the same pair
 *   — "Test Files 18 passed (18) / Tests 299 passed (299)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 * Verified as a LIVE control, the same way the providers row was: deleting one
 * `it()` from `tools/domain/permission.test.ts` leaves the file count at 106
 * and turns the case count red, which is precisely the drift a file-count pin
 * cannot see. No other package moved.
 *
 * WIN-256, `tools` again — the hosted-MCP gate. The SAME row moves again, and
 * the file count does not:
 *
 *   tools 299 -> 325 cases; 1299 -> 1325 total. 18 files, unchanged: every one
 *   of the 26 added cases lands in a suite that already existed. That shape is
 *   the point of this canary — a wave that adds only assertions is invisible to
 *   a file-count pin, and 26 of them is exactly the size of change that would
 *   otherwise pass unremarked.
 *
 *   Where the 26 went, and why each is a case rather than a comment:
 *
 *     +14  application/tool-policy.test.ts (10 -> 24). The hosted MCP surface
 *          had NO authentication before this wave: `verifyMcpCaller` and
 *          `MCP_TOOLS_PERMISSION` were deletable with the whole suite green.
 *          Eleven of the fourteen are refusals — absent, unknown, wrong-scope
 *          and permission-less credentials; a surface switched off; a caller
 *          missing a scope label, an explicit un-exposure, a token allowlist it
 *          is not on, and a bearer caller on an oidc surface — and three are
 *          the positive controls without which a refusal test passes for the
 *          wrong reason (parent-project containment, the caller's own token id,
 *          and labels taken from the verified principal).
 *     +4   application/mcp-surface.test.ts (14 -> 18). Two for the
 *          `secret:mutate` gate on the switch that makes an entity's tools
 *          publicly reachable, which was deletable; two for the audit window,
 *          whose only case asked a window of an EMPTY store.
 *     +4   contracts/index.test.ts (10 -> 14). The same gate through the
 *          PUBLISHED contract, because a transport binds that object and a
 *          binder that dropped the credential would leave every use-case
 *          refusal above passing and production open.
 *     +2   application/execution.test.ts (31 -> 33). The not-dispatchable
 *          refusal in `resolveDispatchTarget`, with its positive control.
 *     +2   application/tool-policy.test.ts, allowlist resync — counted in the
 *          +14 above; named here because they are the two that need the
 *          repository double's new by-name failure injection.
 *
 *   `pnpm --filter @platos/context-tools exec vitest run` prints the same pair
 *   — "Test Files 18 passed (18) / Tests 325 passed (325)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce. No other package moved,
 *   and no case was deleted: 299 + 26 = 325 and 1299 + 26 = 1325.
 *
 * WIN-256, `tools` a third time — the unproven-guard wave. Both numbers on the
 * row move, and the file is the point:
 *
 *   tools 18 -> 19 files, 325 -> 362 cases; 1325 -> 1362 total.
 *
 *   +29  contracts/operator-gate.test.ts, NEW (0 -> 29). The operator gate, on
 *        every published method that has one. `verifyOperator` guarded fourteen
 *        use cases and ELEVEN of them could have their guard deleted with all
 *        325 green — six of the eleven MUTATE. One case classifies every method
 *        on `Object.keys(contract)` as operator- or credential-authorized, so a
 *        method added to the surface later cannot arrive unclassified; fourteen
 *        refuse a grant tenancy did not mint; fourteen are the positive
 *        controls, without which a method that refused everything would satisfy
 *        its refusal case for the wrong reason. 1 + 14 + 14 = 29.
 *
 *        THE TWENTY-EIGHT ARE WRITTEN OUT RATHER THAN LOOPED, and this census
 *        is why. A `for` over the invocation table declares the same cases in
 *        four lines, and `declarationSiteIsCountable` REFUSES that shape —
 *        correctly, because a census that cannot count a suite exactly cannot
 *        canary it. The table is still the single source of the calls; only the
 *        `it()` declarations are unrolled.
 *
 *   +6   application/registry.test.ts (22 -> 28). The page clamp. Its one case
 *        asked `limit: 10_000, offset: -3` of a TWO-row fixture and asserted
 *        `items.length <= 200`, which holds with the clamp applied and with it
 *        removed. That case is now two — the window the port was actually
 *        handed, and the below-one/fractional window — and five more address
 *        the extracted `clampExposurePage` directly. 1 + 5 = 6.
 *
 *   +2   application/execution.test.ts (33 -> 35). The cost column on the row
 *        execution itself mints, and the per-entity `ToolHealth` key.
 *
 *   contracts/index.test.ts stays at 14: the gate suite that briefly lived
 *   there moved out whole, and the two cases it did change — the audit-row
 *   redaction case and the cost case — were REWRITTEN, not added to.
 *
 *   `pnpm --filter @platos/context-tools exec vitest run` prints "Test Files 19
 *   passed (19) / Tests 362 passed (362)", and the census REFUSES nothing in
 *   that tree, so 362 is a statically exact count. No other package moved and
 *   no case was deleted: 29 + 6 + 2 = 37, 325 + 37 = 362, 18 + 1 = 19, and
 *   1325 + 37 = 1362.
 */
export const EXPECTED = Object.freeze({
  "packages/adapters/channel-slack": { files: 0, cases: 0 },
  "packages/adapters/clickhouse-observability": { files: 0, cases: 0 },
  "packages/adapters/durable-runtime": { files: 0, cases: 0 },
  "packages/adapters/model-router-providers": { files: 0, cases: 0 },
  "packages/adapters/notifier-email": { files: 0, cases: 0 },
  "packages/adapters/notifier-webhook": { files: 0, cases: 0 },
  "packages/adapters/objectstore-minio": { files: 0, cases: 0 },
  "packages/adapters/outbox": { files: 0, cases: 0 },
  "packages/adapters/postgres-tenancy": { files: 0, cases: 0 },
  "packages/adapters/redis-cache": { files: 0, cases: 0 },
  "packages/adapters/redis-ratelimit": { files: 0, cases: 0 },
  "packages/adapters/redis-streams": { files: 0, cases: 0 },
  "packages/contexts/agents": { files: 0, cases: 0 },
  "packages/contexts/channels": { files: 0, cases: 0 },
  "packages/contexts/conversations": { files: 0, cases: 0 },
  "packages/contexts/cost-monitoring": { files: 0, cases: 0 },
  "packages/contexts/eventing": { files: 0, cases: 0 },
  "packages/contexts/files": { files: 15, cases: 134 },
  "packages/contexts/governance": { files: 0, cases: 0 },
  "packages/contexts/identity-access": { files: 17, cases: 231 },
  "packages/contexts/jobs": { files: 0, cases: 0 },
  "packages/contexts/memory": { files: 0, cases: 0 },
  "packages/contexts/observability": { files: 0, cases: 0 },
  "packages/contexts/privacy": { files: 0, cases: 0 },
  "packages/contexts/providers": { files: 21, cases: 283 },
  "packages/contexts/secrets": { files: 16, cases: 162 },
  "packages/contexts/skills": { files: 0, cases: 0 },
  "packages/contexts/tenancy": { files: 16, cases: 146 },
  "packages/contexts/tools": { files: 19, cases: 362 },
  "packages/kernel": { files: 3, cases: 44 },
});

/**
 * The number `pnpm test:v1-packages` prints, pinned separately from the sum
 * above so the two can DISAGREE and be caught. They are computed differently —
 * one by this AST, one by vitest — and the refusal list is what keeps them
 * equal. If a change makes them diverge, one of the two numbers is a lie, and
 * the census should fail rather than quietly track the wrong one.
 */
export const EXPECTED_RUNTIME_TOTAL = 1362;

/** Every case-declaring package directory, in byte order. */
export function listPackages(root = repositoryRoot) {
  const found = [];
  for (const packageRoot of PACKAGE_ROOTS) {
    const absolute = join(root, packageRoot);
    if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (statSync(join(absolute, "package.json"), { throwIfNoEntry: false })?.isFile()) {
      found.push(packageRoot);
      continue;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) found.push(`${packageRoot}/${entry.name}`);
    }
  }
  return found.sort();
}

/** Every `*.test.ts` beneath one package, repo-relative and in byte order. */
export function listTestFiles(root = repositoryRoot, packagePath) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(child);
      } else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
        found.push(relative(root, child).split("\\").join("/"));
      }
    }
  };
  walk(join(root, packagePath));
  return found.sort();
}

/** See through `as const`, `satisfies` and parentheses to the real table. */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** The `it`/`test`/`describe` chain a call site is rooted in, or null. */
function calleeChain(node) {
  let current = node.expression;
  let expandedBy = null;
  let templated = false;
  let invoked = false;

  if (ts.isCallExpression(current)) {
    // `it.each([...])("name", fn)` — the tail call's callee is the `.each` call.
    expandedBy = current.arguments[0] ? unwrap(current.arguments[0]) : null;
    current = current.expression;
    invoked = true;
  } else if (ts.isTaggedTemplateExpression(current)) {
    // `it.each`table`("name", fn)` — rows are in the template, not an array.
    templated = true;
    current = current.tag;
    invoked = true;
  }

  const modifiers = [];
  while (ts.isPropertyAccessExpression(current)) {
    modifiers.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  return { root: current.text, modifiers, expandedBy, templated, invoked };
}

/**
 * Where a case may be declared: the file body, or a `describe`/`suite` callback.
 * Anywhere else — a helper, a loop body, a `beforeEach` — makes the declaration
 * site and the runtime count different numbers, which the census refuses.
 */
function declarationSiteIsCountable(node) {
  const iterations = new Set([
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
  ]);

  for (let current = node.parent; current; current = current.parent) {
    if (iterations.has(current.kind)) return false;
    if (ts.isSourceFile(current)) return true;
    if (!ts.isFunctionLike(current)) continue;

    // The nearest enclosing function decides. It is countable only when it is
    // the body of a group call.
    const call = current.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(current)) return false;
    const chain = calleeChain(call);
    if (!chain || !GROUP_ROOTS.has(chain.root)) return false;
    if (chain.modifiers.some((modifier) => EXPANDING_MODIFIERS.has(modifier))) return false;
  }
  return true;
}

/** Cases, non-executing cases and refusals declared by one test file. */
export function countFile(virtualPath, text) {
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const refusals = [];
  let cases = 0;
  let nonExecuting = 0;

  const refuse = (node, reason) => refusals.push({ path: virtualPath, line: at(node), reason });

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node);
      const expanding = chain?.modifiers.some((modifier) => EXPANDING_MODIFIERS.has(modifier)) ?? false;

      // `it.each([...])(...)` is TWO nested calls. The inner one supplies the
      // table and declares nothing; only the outer, invoked one is a case.
      // Counting both is how the first run of this census double-reported.
      if (chain && expanding && !chain.invoked) {
        // deliberately nothing
      } else if (chain && GROUP_ROOTS.has(chain.root) && expanding) {
        refuse(node, `${chain.root}.each multiplies every case inside it; the census cannot count it exactly`);
      } else if (chain && CASE_ROOTS.has(chain.root)) {
        if (!declarationSiteIsCountable(node)) {
          refuse(node, `${chain.root}() is declared inside a loop or a non-describe callback`);
        } else if (!expanding) {
          cases += 1;
          if (chain.modifiers.some((modifier) => NON_EXECUTING_MODIFIERS.has(modifier))) nonExecuting += 1;
        } else if (chain.templated || !chain.expandedBy || !ts.isArrayLiteralExpression(chain.expandedBy)) {
          refuse(node, `${chain.root}.each over a table that is not an array literal has no statically visible row count`);
        } else {
          const rows = chain.expandedBy.elements.length;
          if (chain.expandedBy.elements.some((element) => ts.isSpreadElement(element))) {
            refuse(node, `${chain.root}.each over a spread table has no statically visible row count`);
          } else {
            cases += rows;
            if (chain.modifiers.some((modifier) => NON_EXECUTING_MODIFIERS.has(modifier))) nonExecuting += rows;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { cases, nonExecuting, refusals };
}

/** The live census: one row per package, plus totals and every refusal. */
export function census(root = repositoryRoot) {
  const packages = {};
  const refusals = [];
  let totalFiles = 0;
  let totalCases = 0;
  let totalNonExecuting = 0;

  for (const packagePath of listPackages(root)) {
    const files = listTestFiles(root, packagePath);
    let cases = 0;
    let nonExecuting = 0;
    for (const file of files) {
      const counted = countFile(file, readFileSync(join(root, file), "utf8"));
      cases += counted.cases;
      nonExecuting += counted.nonExecuting;
      refusals.push(...counted.refusals);
    }
    packages[packagePath] = { files: files.length, cases };
    totalFiles += files.length;
    totalCases += cases;
    totalNonExecuting += nonExecuting;
  }

  return { packages, totalFiles, totalCases, nonExecuting: totalNonExecuting, refusals };
}

/** Every way the live census can disagree with what is pinned. */
export function checkCensus(root = repositoryRoot, expected = EXPECTED) {
  const live = census(root);
  const problems = [];

  for (const [packagePath, counts] of Object.entries(live.packages)) {
    const pinned = expected[packagePath];
    if (!pinned) {
      problems.push(`UNPINNED ${packagePath} has ${counts.files} test file(s) and ${counts.cases} case(s) but no pinned row`);
      continue;
    }
    if (counts.files !== pinned.files) {
      problems.push(`FILES    ${packagePath} has ${counts.files} test file(s); ${pinned.files} pinned`);
    }
    if (counts.cases !== pinned.cases) {
      const direction = counts.cases < pinned.cases ? "LOST" : "GAINED";
      problems.push(
        `CASES    ${packagePath} has ${counts.cases} case(s); ${pinned.cases} pinned ` +
          `(${direction} ${Math.abs(counts.cases - pinned.cases)}) — update the delta comment in ` +
          `scripts/arch/test-case-census.mjs, never the number alone`,
      );
    }
  }
  for (const packagePath of Object.keys(expected)) {
    if (!(packagePath in live.packages)) problems.push(`MISSING  ${packagePath} is pinned but is not a package`);
  }
  for (const refusal of live.refusals) {
    problems.push(`REFUSED  ${refusal.path}:${refusal.line} — ${refusal.reason}`);
  }
  if (live.nonExecuting !== 0) {
    problems.push(`SKIPPED  ${live.nonExecuting} declared case(s) carry .skip or .todo; the pin requires 0`);
  }
  // Only meaningful for the real pin: a fixture declares its own small census
  // and has no relationship to what the repository's suites print.
  const pinnedTotal = Object.values(expected).reduce((sum, row) => sum + row.cases, 0);
  if (expected === EXPECTED && pinnedTotal !== EXPECTED_RUNTIME_TOTAL) {
    problems.push(
      `RUNTIME  the pinned rows sum to ${pinnedTotal} but EXPECTED_RUNTIME_TOTAL is ${EXPECTED_RUNTIME_TOTAL}; ` +
        `one of them no longer matches what \`pnpm test:v1-packages\` prints`,
    );
  }

  return { live, problems };
}

function main() {
  const result = checkCensus();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.problems.length > 0 ? 1 : 0;
    return;
  }

  const { live, problems } = result;
  process.stdout.write(
    `test-case-census: ${live.totalCases} case(s) across ${live.totalFiles} file(s) in ` +
      `${Object.keys(live.packages).length} V1 package(s)\n`,
  );
  for (const problem of problems) process.stdout.write(`${problem}\n`);

  if (problems.length === 0) {
    process.stdout.write(
      `ok: every package's test FILE and CASE count matches its pin, no case is skipped or todo, and no ` +
        `construct was refused as uncountable. Deleting an it() block inside a retained file now fails here.\n`,
    );
  } else {
    process.stdout.write(`\n${problems.length} test-case-census problem(s).\n`);
  }
  process.exitCode = problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("test-case-census.mjs")) main();
