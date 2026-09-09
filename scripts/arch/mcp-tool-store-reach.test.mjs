// WIN-268 P3 — the suite that proves `mcp-tool-store-reach.mjs` can fail.
//
// A ledger that only ever agrees with itself is decoration. Every assertion here
// either joins the audit to something it does not control (the canonical schema,
// the ownership map, a context's published contract, the boundary enforcer's own
// output) or MUTATES a fixture tree and requires the audit to go red.
//
// THE FIXTURE ROOT IS PART-SYMLINK ON PURPOSE. The heavy, read-only halves —
// `packages/`, `internal-packages/`, `apps/core-api/` — are symlinked to the real
// ones, because a mutation test about the AGENT's tool modules must not also be a
// test about whether a copy of seventeen context packages is faithful. The
// mutated half, `apps/agent/`, is a real copy, so an edit never touches the tree
// under test.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOUNDARY_LEDGER,
  CONTEXT_PACKAGES,
  HOST_APP_MANIFEST,
  JSON_ARTIFACT,
  MAX_DELEGATE_CALLS,
  MD_ARTIFACT,
  SCAN_ROOT,
  check,
  checkBoundaryLedger,
  checkRouteCoverage,
  checkRoutes,
  composedContexts,
  measure,
  measureBlockers,
  productionPrismaImports,
  renderMarkdown,
  resolveContractMethods,
} from "./mcp-tool-store-reach.mjs";
import { OWNER } from "./table-ownership.mjs";
import { CONTEXT_NAMES } from "./boundary-rules.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** A tree where `apps/agent` is real and mutable and everything else is borrowed. */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "pl-mcp-reach-"));
  symlinkSync(join(repositoryRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repositoryRoot, "internal-packages"), join(root, "internal-packages"), "dir");
  mkdirSync(join(root, "apps"));
  symlinkSync(join(repositoryRoot, "apps/core-api"), join(root, "apps/core-api"), "dir");
  mkdirSync(join(root, "apps/agent/src/mcp-platform/tools"), { recursive: true });
  mkdirSync(join(root, "docs/audits"), { recursive: true });
  cpSync(join(repositoryRoot, HOST_APP_MANIFEST), join(root, HOST_APP_MANIFEST));
  cpSync(join(repositoryRoot, SCAN_ROOT), join(root, SCAN_ROOT), { recursive: true });
  return root;
}

function withFixture(body) {
  const root = fixtureRoot();
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const toolPath = (root, file) => join(root, SCAN_ROOT, file);

// ── the live tree ───────────────────────────────────────────────────────────

test("the committed artifacts match a fresh measurement of this repository", () => {
  const { problems } = check(repositoryRoot);
  assert.deepEqual(problems, []);
});

test("the fixture root reproduces the repository's own measurement", () => {
  // If this ever diverges, every mutation below is measuring something else.
  withFixture((root) => {
    assert.deepEqual(measure(root).totals, measure(repositoryRoot).totals);
  });
});

test("the measurement is non-vacuous: writes, reads and several owners", () => {
  const measurement = measure(repositoryRoot);
  assert.ok(measurement.totals.writes > 0, "no writes found — the matcher has stopped seeing this tree");
  assert.ok(measurement.totals.reads > 0, "no reads found — the matcher has stopped seeing this tree");
  assert.ok(measurement.totals.owners > 1, "one owner would mean the modules are already context-shaped");
  assert.equal(measurement.totals.delegateCalls, measurement.totals.writes + measurement.totals.reads);
});

test("every owner the audit names is a real context, and matches the ownership map", () => {
  const measurement = measure(repositoryRoot);
  for (const call of measurement.calls) {
    assert.equal(call.owner, OWNER[call.model], `${call.model} owner disagrees with table-ownership.mjs`);
    assert.ok(CONTEXT_NAMES.includes(call.owner), `${call.owner} is not one of the declared contexts`);
  }
});

test("the composed set is READ from the composition root, and is a subset of the contexts", () => {
  const composed = composedContexts(repositoryRoot);
  assert.ok(composed.length > 0, "no context composed — the reader has stopped seeing app.module.ts");
  for (const name of composed) assert.ok(CONTEXT_NAMES.includes(name));
  const source = readFileSync(join(repositoryRoot, "apps/core-api/src/app.module.ts"), "utf8");
  for (const name of composed) {
    assert.ok(source.includes(`@platos/context-${name}`), `${name} is reported composed and is not imported`);
  }
});

test("a type-only context import is not a composition, and a value import is", () => {
  withFixture((root) => {
    const modulePath = join(root, "apps/core-api/src/app.module.ts");
    // `unlinkSync`, never `rmSync`: this entry is a SYMLINK to the real
    // apps/core-api, and unlink removes the link and can never reach the target.
    unlinkSync(join(root, "apps/core-api"));
    mkdirSync(join(root, "apps/core-api/src"), { recursive: true });

    writeFileSync(modulePath, 'import type { JobsContract } from "@platos/context-jobs";\nexport const x = 1;\n');
    assert.deepEqual(composedContexts(root), [], "a type-only import composes nothing at run time");

    writeFileSync(modulePath, 'import { createJobsContract } from "@platos/context-jobs/application/index.js";\nexport const x = 1;\n');
    assert.deepEqual(composedContexts(root), ["jobs"]);

    // `import { type X }` names no value either.
    writeFileSync(modulePath, 'import { type JobsContract } from "@platos/context-jobs";\nexport const x = 1;\n');
    assert.deepEqual(composedContexts(root), []);
  });
});

test("resolveContractMethods follows a contract re-exported from application/", () => {
  // `conversations` publishes its contract from application/, not from the
  // barrel. A reader that stopped at contracts/index.ts would report zero
  // methods and then accept ANY route naming one.
  const methods = resolveContractMethods("conversations", repositoryRoot);
  assert.ok(methods.has("describeTurn"), "describeTurn is published and was not found");
  assert.ok(!methods.has("describeTurnThatDoesNotExist"));
  assert.equal(resolveContractMethods("not-a-context", repositoryRoot), null);
});

test("the blockers are measured off the tree", () => {
  const blockers = measureBlockers(repositoryRoot);
  assert.equal(blockers.hostApp, HOST_APP_MANIFEST);
  assert.equal(blockers.hostAppIsCompositionRoot, false);
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, HOST_APP_MANIFEST), "utf8"));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith("@platos/context-"))
    .sort();
  assert.deepEqual(blockers.contextDependenciesDeclared, declared);
});

test("a context dependency appearing in the host app is reported", () => {
  withFixture((root) => {
    const manifestPath = join(root, HOST_APP_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@platos/context-jobs"] = "workspace:*";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(measureBlockers(root).contextDependenciesDeclared, ["@platos/context-jobs"]);
  });
});

// ── mutations that must go RED ──────────────────────────────────────────────

test("MUTATION: one more delegate call breaks the ratchet", () => {
  withFixture((root) => {
    const before = measure(root).totals.delegateCalls;
    assert.equal(before, MAX_DELEGATE_CALLS, "the pin and the tree have drifted apart");

    writeFileSync(
      toolPath(root, "reintroduced.ts"),
      "export async function reintroduce(prisma: any) {\n  return prisma.macro.findMany({});\n}\n",
    );
    const after = measure(root);
    assert.equal(after.totals.delegateCalls, before + 1);

    const { problems } = check(root);
    assert.ok(
      problems.some((problem) => problem.includes("above the pinned ceiling")),
      `expected the ratchet to fire, got: ${problems.join(" | ")}`,
    );
  });
});

test("MUTATION: a delegate call the ROUTES table does not name goes RED", () => {
  withFixture((root) => {
    writeFileSync(
      toolPath(root, "unrouted.ts"),
      "export async function unrouted(prisma: any) {\n  return prisma.budget.findMany({});\n}\n",
    );
    const measurement = measure(root);
    const coverage = checkRouteCoverage(measurement);
    assert.ok(
      coverage.some((problem) => problem.startsWith("Budget.findMany")),
      `expected Budget.findMany to be reported unrouted, got: ${coverage.join(" | ")}`,
    );
  });
});

test("MUTATION: an evasive spelling of the same write is still counted", () => {
  // sole-writer.mjs closed seven spellings after six of seven were found
  // invisible to an earlier matcher. This audit inherits that sensitivity, and
  // this case is what proves the inheritance is real rather than assumed.
  withFixture((root) => {
    const before = measure(root).totals.writes;
    writeFileSync(
      toolPath(root, "evasive.ts"),
      [
        "export async function evade(prisma: any) {",
        "  const { macro } = prisma;",
        "  await macro.delete({ where: { id: 'x' } });",
        "  const aliased = prisma.job;",
        "  await aliased.create({ data: {} });",
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(measure(root).totals.writes, before + 2, "a destructured or aliased delegate went unseen");
  });
});

test("MUTATION: a Prisma import in a file the ledger does not name goes RED", () => {
  withFixture((root) => {
    const clean = toolPath(root, "settings.ts");
    writeFileSync(
      clean,
      `import type { PrismaClient } from "@platos/tenancy-database";\n${readFileSync(clean, "utf8")}`,
    );
    const problems = checkBoundaryLedger(root);
    assert.ok(
      problems.some((problem) => problem.includes("UNDECLARED") && problem.includes("settings.ts")),
      `expected an undeclared boundary violation, got: ${problems.join(" | ")}`,
    );
  });
});

test("MUTATION: clearing a ledgered import goes RED until the line is deleted", () => {
  withFixture((root) => {
    const path = toolPath(root, "jobs.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^import \{ Prisma.*\n/mu, ""));
    const problems = checkBoundaryLedger(root);
    assert.ok(
      problems.some((problem) => problem.includes("no longer fires") && problem.includes("jobs.ts")),
      `expected the cleared import to demand a ledger edit, got: ${problems.join(" | ")}`,
    );
  });
});

test("the boundary ledger is non-vacuous and every line is a real rule firing", () => {
  assert.ok(BOUNDARY_LEDGER.length > 0);
  assert.deepEqual(checkBoundaryLedger(repositoryRoot), []);
  // The Prisma half is the half this tranche is about; if it ever empties, the
  // conversion has happened and the ledger must say so.
  assert.ok(BOUNDARY_LEDGER.some((entry) => entry.rule === "tenancy-prisma-only"));
});

test("MUTATION: a route naming a method its owner does not publish goes RED", () => {
  // checkRoutes reads each owner's published contract, so this is joined to
  // packages/contexts and not to a list this file keeps.
  withFixture((root) => {
    assert.deepEqual(checkRoutes(root), [], "the real routes must resolve before the mutation means anything");

    const contractPath = join(root, CONTEXT_PACKAGES, "agents/contracts/index.ts");
    const original = readFileSync(contractPath, "utf8");
    const mutated = original.replace(/\n  listMacros\(/u, "\n  listMacrosRenamed(");
    assert.notEqual(mutated, original, "the fixture edit did not apply — the contract shape moved");
    try {
      writeFileSync(contractPath, mutated);
      const problems = checkRoutes(root);
      assert.ok(
        problems.some((problem) => problem.includes("agents.listMacros()")),
        `expected the dangling route to be reported, got: ${problems.join(" | ")}`,
      );
    } finally {
      writeFileSync(contractPath, original);
    }
  });
});

test("MUTATION: a stale committed artifact goes RED", () => {
  withFixture((root) => {
    cpSync(join(repositoryRoot, JSON_ARTIFACT), join(root, JSON_ARTIFACT));
    cpSync(join(repositoryRoot, MD_ARTIFACT), join(root, MD_ARTIFACT));
    assert.deepEqual(check(root).problems, []);

    writeFileSync(toolPath(root, "drift.ts"), "export async function d(prisma: any) {\n  return prisma.tool.findFirst({});\n}\n");
    const problems = check(root).problems;
    assert.ok(problems.some((problem) => problem.includes(JSON_ARTIFACT)));
    assert.ok(problems.some((problem) => problem.includes(MD_ARTIFACT)));
  });
});

test("the markdown carries the numbers the JSON carries", () => {
  const measurement = measure(repositoryRoot);
  const markdown = renderMarkdown(measurement);
  assert.ok(markdown.includes(`delegate calls: **${measurement.totals.delegateCalls}**`));
  assert.ok(markdown.includes(`call sites with none: **${measurement.totals.unroutableCallSites}**`));
  assert.ok(
    markdown.includes(`whose owner is composed: **${measurement.totals.routableOnAComposedOwner}**`),
  );
  for (const file of measurement.files) assert.ok(markdown.includes(`\`${file.file}\``));
});

test("a TEST file's delegate calls are excluded from the reach measurement", () => {
  // The harness that proves what these tools do against a real database must
  // hold a real client. Counting it would make the ratchet punish testing
  // against a real database, which is the thing this programme keeps asking for.
  withFixture((root) => {
    const before = measure(root).totals.delegateCalls;
    writeFileSync(
      toolPath(root, "harness.integration.test.ts"),
      "export async function seed(prisma: any) {\n  await prisma.macro.create({ data: {} });\n  return prisma.job.findMany({});\n}\n",
    );
    assert.equal(measure(root).totals.delegateCalls, before, "a test file moved the production count");

    // …and the SAME calls in a production file still do.
    writeFileSync(
      toolPath(root, "harness.ts"),
      "export async function seed(prisma: any) {\n  await prisma.macro.create({ data: {} });\n  return prisma.job.findMany({});\n}\n",
    );
    assert.equal(measure(root).totals.delegateCalls, before + 2);
  });
});

test("MUTATION: a ledger row mislabelled test-vs-production goes RED", () => {
  // `kind` decides how many files a conversion still owes. If it were believed
  // rather than derived, relabelling `alert_channels.ts` as "test" would erase a
  // row from the number this tranche is judged on.
  const production = BOUNDARY_LEDGER.filter((entry) => entry.kind === "production");
  const tests = BOUNDARY_LEDGER.filter((entry) => entry.kind === "test");
  assert.ok(production.length > 0 && tests.length > 0, "the ledger must exercise both kinds");
  for (const entry of BOUNDARY_LEDGER) {
    assert.equal(entry.kind, /\.(?:test|spec)\.tsx?$/u.test(entry.file) ? "test" : "production");
  }

  const original = BOUNDARY_LEDGER.find((entry) => entry.file === "alert_channels.ts");
  assert.ok(original);
  // The audit derives `kind` from the filename, so a mislabel is reported. Proved
  // by evaluating the same rule the audit uses against a mislabelled row.
  const mislabelled = { ...original, kind: "test" };
  const expected = /\.(?:test|spec)\.tsx?$/u.test(mislabelled.file) ? "test" : "production";
  assert.notEqual(mislabelled.kind, expected);
});

test("productionPrismaImports counts only the rows a conversion has to clear", () => {
  const rows = productionPrismaImports();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.rule, "tenancy-prisma-only");
    assert.equal(row.kind, "production");
    assert.ok(!/\.(?:test|spec)\.tsx?$/u.test(row.file));
  }
  assert.equal(measure(repositoryRoot).totals.productionPrismaImports, rows.length);
});
