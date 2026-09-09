// WIN-267 (M4.1) R2 — falsification for `webapp-prisma-surface.mjs` and for the
// `webapp-no-prisma` fix it exists to keep.
//
// Every case here joins to something outside this file: the real webapp tree,
// the real `arch-boundaries` checker and the paths ITS OWN resolver produced,
// the committed rule set, or the TypeScript parser. Nothing is asserted against
// a second copy of the thing under test.
//
// THE MUTATION THAT MATTERS is `MUTATION: the pre-fix pattern matched none of
// the edges the enforcer actually reports`. It reconstructs `webapp-no-prisma`
// exactly as it stood at 5b236cdb and applies it to the resolved target paths
// the checker produced from the real tree. Zero of ten. Put that pattern back
// and the SHARPNESS case below goes red.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { ALL_RULES } from "./boundary-rules.mjs";
import { check, DEFAULT_SCAN_ROOTS } from "./arch-boundaries.mjs";
import {
  measure,
  evaluate,
  PINS,
  CLAUSE_AT_PIN,
  DATABASE_MODULE,
  CREDENTIAL_MODULE,
  CREDENTIAL_NAME,
  TENANCY_PACKAGE,
} from "./webapp-prisma-surface.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The exact `to` pattern `webapp-no-prisma` carried at 5b236cdb. */
const PRE_FIX_PATTERN = "^(node_modules/@prisma/|internal-packages/(database|tenancy-database)/)";

function ruleById(id) {
  const rule = ALL_RULES.find((r) => r.id === id);
  assert.ok(rule, `the ${id} rule must exist`);
  return rule;
}

/** The live verdict over the real webapp, computed once. */
const verdict = check(repoRoot, { scanRoots: ["apps/webapp"] });
const measured = measure();

describe("webapp-no-prisma can see the door it names", () => {
  it("MUTATION: the pre-fix pattern matched NONE of the edges the enforcer reports", () => {
    // The target paths are the checker's OWN output, produced by its own
    // `resolveTargetVirtualPath`. Restating that resolver here would make this a
    // test of my arithmetic; taking its answer makes it a test of the rule.
    const targets = [
      ...new Set(verdict.violations.filter((v) => v.rule === "tenancy-prisma-only").map((v) => v.to)),
    ];
    assert.ok(
      targets.length > 0,
      "the webapp holds no banned data-store import at all; this whole tranche has nothing to enforce",
    );

    const preFix = new RegExp(PRE_FIX_PATTERN, "u");
    const missed = targets.filter((t) => !preFix.test(t));
    assert.deepEqual(
      missed,
      targets,
      "the pre-fix pattern is being credited with matches it never had; it saw none of these",
    );

    // …and the committed one sees every single one. Without this pairing the
    // case above would pass on a rule that matches nothing at all.
    const current = new RegExp(ruleById("webapp-no-prisma").to.path, "u");
    for (const target of targets) {
      assert.ok(current.test(target), `webapp-no-prisma still cannot see ${target}`);
    }
  });

  it("SHARPNESS: the lock fires on every edge the general containment rule does", () => {
    // The invariant `evaluate` enforces, proven directly against the enforcer.
    // A rule written for one tree that is blunter inside that tree than the
    // general rule is not enforcing anything; it is being carried.
    const per = (id) => verdict.violations.filter((v) => v.rule === id).length;
    assert.ok(
      per("webapp-no-prisma") >= per("tenancy-prisma-only"),
      `webapp-no-prisma ${per("webapp-no-prisma")} < tenancy-prisma-only ${per("tenancy-prisma-only")}`,
    );
    assert.equal(evaluate(measured).filter((f) => f.id === "sharpness").length, 0);
  });

  it("MUTATION: SHARPNESS goes red when the lock is silenced", () => {
    // The invariant has teeth: a measurement in which `webapp-no-prisma` fires
    // less than `tenancy-prisma-only` — which is the tree's real state at
    // 5b236cdb — is refused by a NAMED case, not by an aggregate count.
    const silenced = {
      ...measured,
      violations: { ...measured.violations, "webapp-no-prisma": 0 },
    };
    const ids = evaluate(silenced).map((f) => f.id);
    assert.ok(ids.includes("sharpness"), `expected a sharpness failure, got ${JSON.stringify(ids)}`);
  });

  it("ACCEPTANCE: the lock names exactly the webapp files that hold the import", () => {
    // Two sides gathered by DIFFERENT mechanisms — the checker's import parser
    // and a byte scan of the tree — so they must agree with each other rather
    // than the checker agreeing with itself.
    const offenders = [
      ...new Set(verdict.violations.filter((v) => v.rule === "webapp-no-prisma").map((v) => v.from)),
    ].sort();

    const holders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) {
          if (!["node_modules", "build", "public"].includes(entry)) walk(abs);
        } else if (/\.(?:ts|tsx)$/u.test(entry)) {
          const text = readFileSync(abs, "utf8");
          if (text.includes(`"${TENANCY_PACKAGE}"`) || text.includes('"@prisma/')) {
            holders.push(abs.slice(repoRoot.length));
          }
        }
      }
    };
    walk(join(repoRoot, "apps/webapp"));

    assert.deepEqual(
      offenders,
      holders.sort(),
      "the lock and the tree disagree about which webapp files hold a banned data-store import",
    );
  });

  it("the widened pattern matches by SEGMENT and has not become a prefix", () => {
    // The §14 argument the rules file already makes for `ai`. A prefix match
    // would condemn any future sibling whose name merely opens with these bytes,
    // and the point of a containment rule is that a violation names the thing
    // that was actually imported.
    const banned = new RegExp(ruleById("webapp-no-prisma").to.path, "u");
    assert.equal(banned.test("internal-packages/tenancy-database-legacy/src/x.ts"), false);
    assert.equal(banned.test("internal-packages/database-archive/src/x.ts"), false);
    assert.equal(banned.test("node_modules/prismatic/index.js"), false);
    assert.equal(banned.test("node_modules/@platos/tenancy-database-mock/index.js"), false);
    // The anchor: a vendored copy nested inside an unrelated package is not this
    // rule's business, and an unanchored alternative would claim it.
    assert.equal(banned.test("packages/adapters/x/node_modules/prisma/index.js"), false);
  });

  it("the webapp lock is STRICTLY broader than the containment rule, by one package", () => {
    // `internal-packages/database` is the durable-runtime store's client. ADR
    // M0.3 §7 decision 10 puts it behind a different port with a different
    // adapter, so `tenancy-prisma-only` deliberately does NOT own it — and
    // `arch-boundaries.test.mjs` asserts that exclusion. The webapp is banned
    // from BOTH stores, so this rule must keep the package the other one drops.
    const lock = new RegExp(ruleById("webapp-no-prisma").to.path, "u");
    const containment = new RegExp(ruleById("tenancy-prisma-only").to.path, "u");
    assert.equal(containment.test("internal-packages/database/src/x.ts"), false);
    assert.ok(lock.test("internal-packages/database/src/x.ts"));
  });

  it("the lock is scoped to the webapp and judges nothing outside it", () => {
    const from = new RegExp(ruleById("webapp-no-prisma").from.path, "u");
    assert.ok(from.test("apps/webapp/app/services/database.server.ts"));
    assert.equal(from.test("packages/adapters/postgres-tenancy/src/client.ts"), false);
    assert.equal(from.test("apps/core-api/src/main.ts"), false);
    assert.equal(from.test("internal-packages/tenancy-database/src/index.ts"), false);
  });

  it("the generated dependency-cruiser config carries the fixed pattern", () => {
    // The second enforcer. A fix that lived only in the rules module would leave
    // the committed config asserting the old, blind pattern.
    const config = readFileSync(join(repoRoot, ".dependency-cruiser.js"), "utf8");
    assert.ok(
      config.includes(JSON.stringify(ruleById("webapp-no-prisma").to.path)),
      ".dependency-cruiser.js is stale against boundary-rules.mjs",
    );
    assert.equal(config.includes(JSON.stringify(PRE_FIX_PATTERN)), false);
  });
});

describe("the webapp's database surface is measured, not asserted", () => {
  it("the parser reproduces the surface the pins record", () => {
    assert.equal(measured.operations, PINS.operations);
    assert.equal(measured.clientHandOffs.length, PINS.clientHandOffs);
    assert.equal(measured.operationFiles.length, PINS.operationFiles);
    assert.equal(measured.moduleImporters.length, PINS.moduleImporters);
    assert.equal(measured.mockDoubles.length, PINS.mockDoubles);
    assert.equal(measured.clientImporters.length, PINS.clientImporters);
  });

  it("ARITHMETIC: 12 model calls + 1 transaction + 2 inside it = 15", () => {
    // The brief's figure, decomposed by kind rather than restated. The two
    // creates inside `projects.new`'s `$transaction` are the difference between
    // the honest 15 and the 12 a `database.` text scan can see.
    const transactions = measured.sites.filter((s) => s.kind === "transaction");
    assert.equal(measured.sites.filter((s) => s.kind === "client-hand-off").length, PINS.clientHandOffs);
    const onTransactionClient = measured.sites.filter(
      (s) => s.kind === "model-operation" && s.client !== "database",
    );
    const onDatabase = measured.sites.filter((s) => s.kind === "model-operation" && s.client === "database");
    assert.equal(transactions.length, 1);
    assert.equal(onDatabase.length, 12);
    assert.equal(onTransactionClient.length, 2);
    assert.equal(onDatabase.length + transactions.length + onTransactionClient.length, PINS.operations);
  });

  it("the two transaction-scoped writes are counted and are not spelled `database`", () => {
    // They are reachable ONLY through the callback parameter, so a scan for the
    // module binding's own name cannot see them. This is the case that fails if
    // the transaction-client tracking is removed.
    const inner = measured.sites.filter((s) => s.kind === "model-operation" && s.client !== "database");
    assert.equal(inner.length, 2);
    assert.deepEqual(
      inner.map((s) => s.member).sort(),
      ["project.create", "projectMembership.create"],
    );
    const source = readFileSync(join(repoRoot, inner[0].file), "utf8");
    for (const site of inner) {
      assert.equal(
        source.includes(`database.${site.member}`),
        false,
        `${site.member} is spelled on the module binding after all; the 15 would then be reachable by text scan`,
      );
    }
  });

  it("the client is also HANDED to two callees, which the 15 does not count", () => {
    // The fourth form, and the one that would let this gate reach zero while
    // the webapp still authenticated every request through a live client. Both
    // are in `auth.server.ts` and both are the authentication path itself.
    assert.deepEqual(
      measured.clientHandOffs.map((s) => `${s.file}:${s.member}`).sort(),
      [
        "apps/webapp/app/services/auth.server.ts:authorizeEnvironmentOperator()",
        "apps/webapp/app/services/auth.server.ts:new PlatosAuthService()",
      ],
    );
    // Joined to the bytes, not to the parser: neither is spelled as a member
    // call on the binding, which is exactly why an operation count misses them.
    const source = readFileSync(join(repoRoot, "apps/webapp/app/services/auth.server.ts"), "utf8");
    assert.ok(source.includes("new PlatosAuthService(database,"));
    assert.equal(source.includes("database.authorizeEnvironmentOperator"), false);
    assert.equal(source.includes("database.PlatosAuthService"), false);
  });

  it("MUTATION: a cutover that zeroes the operations but keeps a hand-off is refused", () => {
    // The escape hatch, closed. A tree with no `database.<model>.<op>(` left and
    // `new PlatosAuthService(database, …)` still standing has NOT met the
    // clause, and `cutoverComplete` says so rather than congratulating it.
    const half = {
      ...measured,
      operations: 0,
      sites: [],
      operationFiles: [],
      moduleImporters: [],
      clientImporters: [],
      databaseModuleExists: false,
    };
    const ids = evaluate(half).map((f) => f.id);
    assert.ok(ids.includes("clause-module-premature"), JSON.stringify(ids));
  });

  it("the ~117 the issue once claimed is a text scan, and most of it is doubles", () => {
    // Verified rather than repeated: the discrepancy is real and it is the
    // mock doubles. A gate pinned to the text figure would have been wrong from
    // its first run.
    let textual = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) {
          if (!["node_modules", "build", "public"].includes(entry)) walk(abs);
        } else if (/\.(?:ts|tsx)$/u.test(entry)) {
          textual += (readFileSync(abs, "utf8").match(/database\./gu) ?? []).length;
        }
      }
    };
    walk(join(repoRoot, "apps/webapp"));
    assert.ok(
      textual > measured.operations * 4,
      `the text figure (${textual}) is not materially larger than the real surface (${measured.operations}); ` +
        "the two figures have converged and this case no longer says anything",
    );
    assert.ok(measured.mockDoubles.length > 0, "no mock double found; the discrepancy has another cause");
  });

  it("the operation files are exactly the files that import the module, minus the test", () => {
    // Two independently gathered sets. Every file holding an operation must
    // import the module, and the only importer WITHOUT an operation is the
    // persisted-state gate's integration test, which drives a real database.
    for (const file of measured.operationFiles) {
      assert.ok(measured.moduleImporters.includes(file), `${file} holds an operation but imports nothing`);
    }
    const extra = measured.moduleImporters.filter((f) => !measured.operationFiles.includes(f));
    assert.deepEqual(extra, ["apps/webapp/test/persistedStateGate.integration.test.ts"]);
  });
});

describe("the clause fails from either side", () => {
  const base = { ...measured };

  /**
   * The clause verdict alone.
   *
   * A hypothetical completed cutover legitimately moves every pin — that is
   * what `pin-*` is FOR — so a case about the clause would otherwise be reading
   * the drift gate's answer instead of its own. `clauseIds` isolates the four
   * cases that judge whether the clause's two halves agree with each other.
   */
  const clauseIds = (state) => evaluate(state).map((f) => f.id).filter((id) => id.startsWith("clause-"));

  /** A tree in which the cutover has landed, with the pins not yet moved. */
  const cut = (overrides) => ({
    ...base,
    operations: 0,
    sites: [],
    operationFiles: [],
    moduleImporters: [],
    mockDoubles: [],
    clientHandOffs: [],
    clientImporters: [],
    violations: { "tenancy-prisma-only": 0, "webapp-no-prisma": 0 },
    ...overrides,
  });

  it("the tree matches the clause state the pins were taken at", () => {
    assert.equal(base.databaseModuleExists, CLAUSE_AT_PIN.databaseModuleExists);
    assert.equal(base.credentialRequired, CLAUSE_AT_PIN.credentialRequired);
    assert.equal(base.webappInDefaultScanRoots, false);
    assert.equal(DEFAULT_SCAN_ROOTS.includes("apps/webapp"), false);
  });

  it(`${CREDENTIAL_NAME} is a REQUIRED boot credential, with no default`, () => {
    // The sentence the clause proposes to make false, read off the schema
    // rather than assumed. `.min(1)` with no `.default(...)` and no
    // `.optional()` means the process cannot boot without it.
    const schema = readFileSync(join(repoRoot, CREDENTIAL_MODULE), "utf8");
    const line = schema.split("\n").find((l) => l.includes(`${CREDENTIAL_NAME}:`));
    assert.ok(line, `${CREDENTIAL_MODULE} no longer declares ${CREDENTIAL_NAME}`);
    assert.equal(line.includes(".optional()"), false);
    assert.equal(line.includes(".default("), false);
  });

  it("MUTATION: a deleted module with the surface still present is refused", () => {
    assert.deepEqual(clauseIds({ ...base, databaseModuleExists: false }), ["clause-module-premature"]);
  });

  it("MUTATION: a completed cutover that leaves the module in the tree is refused", () => {
    assert.deepEqual(clauseIds(cut({})), ["clause-module", "clause-credential", "clause-scan-root"]);
  });

  it(`MUTATION: a completed cutover that still requires ${CREDENTIAL_NAME} is refused`, () => {
    // The failure mode the brief names: deleting the file is not the same as
    // proving nothing needs it. A tree with the module gone, the scan root on
    // and the credential still mandatory has NOT met the clause, and exactly
    // one case says so.
    assert.deepEqual(
      clauseIds(cut({ databaseModuleExists: false, webappInDefaultScanRoots: true, credentialRequired: true })),
      ["clause-credential"],
    );
  });

  it("MUTATION: a completed cutover that leaves the scan root off is refused", () => {
    assert.deepEqual(
      clauseIds(cut({ databaseModuleExists: false, credentialRequired: false, webappInDefaultScanRoots: false })),
      ["clause-scan-root"],
    );
  });

  it("the fully-cut tree is the ONLY state that passes with the module gone", () => {
    const done = cut({ databaseModuleExists: false, credentialRequired: false, webappInDefaultScanRoots: true });
    assert.deepEqual(clauseIds(done), []);
    // …and it still fails overall until the pins are moved to match, which is
    // what makes the completed figure a reviewed edit rather than a silent one.
    assert.ok(evaluate(done).every((f) => f.id.startsWith("pin-")));
  });

  it("MUTATION: switching the scan root on early is refused", () => {
    assert.deepEqual(clauseIds({ ...base, webappInDefaultScanRoots: true }), ["clause-scan-root-premature"]);
  });

  it("MUTATION: a surface that grows past its pin is refused", () => {
    const grown = { ...base, operations: PINS.operations + 1 };
    const ids = evaluate(grown).map((f) => f.id);
    assert.ok(ids.includes("monotone-operations"), JSON.stringify(ids));
    assert.ok(ids.includes("pin-operations"), JSON.stringify(ids));
  });

  it("MUTATION: a vacuous scan is refused", () => {
    const ids = evaluate({ ...base, scannedFiles: 0 }).map((f) => f.id);
    assert.ok(ids.includes("vacuous"), JSON.stringify(ids));
  });

  it("the audit passes on the tree as committed", () => {
    assert.deepEqual(evaluate(measured), []);
  });
});

describe(`${DATABASE_MODULE} is still load-bearing`, () => {
  it("every operation file reaches the client through this one module", () => {
    // The clause is "delete this file". These are the callers that stop
    // compiling when it goes, enumerated from the tree so the number in the
    // report is the number a reviewer can count.
    assert.ok(measured.moduleImporters.includes(DATABASE_MODULE) === false);
    for (const file of measured.operationFiles) {
      assert.ok(readFileSync(join(repoRoot, file), "utf8").includes("database.server"));
    }
  });

  it("the module is the only place the webapp constructs a client", () => {
    // A second construction site would mean deleting this file removes the
    // import without removing the credential.
    const constructions = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) {
          if (!["node_modules", "build", "public"].includes(entry)) walk(abs);
        } else if (/\.(?:ts|tsx)$/u.test(entry)) {
          if (/new\s+PrismaClient\s*\(/u.test(readFileSync(abs, "utf8"))) {
            constructions.push(abs.slice(repoRoot.length));
          }
        }
      }
    };
    walk(join(repoRoot, "apps/webapp"));
    assert.deepEqual(constructions, [DATABASE_MODULE]);
  });
});
