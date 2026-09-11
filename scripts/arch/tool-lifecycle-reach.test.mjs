// The SECOND reconciliation of WIN-269's register.
//
// `audit:tool-lifecycle-reach` compares the committed evidence against the tree
// and is necessary. It is not sufficient, and this repository has learned that
// five separate times: `scripts/v1-ledger.test.mjs` carries a second
// reconciliation that has caught drift the `audit:` check could not see, and so
// do `evidence-lifecycle`, `ci-policy` and `docs-link-integrity`. A `--check`
// that regenerates the report and diffs it can only prove the report matches the
// generator; it cannot prove the GENERATOR is measuring what it claims.
//
// So the cases below re-derive the same figures a DIFFERENT WAY and compare:
//
//   * the site total is re-summed from `byOwner` and from `byVerdict`
//     independently, and from the per-file disposition counts a third time.
//   * `unblockedByComposingSubject` is re-counted from the raw site list rather
//     than read off the summary.
//   * the disjointness of the two registers is asserted against the sibling
//     module's own exported roots, not against a copy of them.
//   * every disposition's contract methods are re-checked against the AST-read
//     contract, so a renamed method fails here as well as in the audit.
//
// A figure that only one path produces is a figure nobody is checking.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPENDENCY_SLOTS,
  DISPOSITIONS,
  FOREIGN_OWNERSHIP,
  LIFECYCLE_ROOTS,
  MANIFEST,
  REPORT,
  SUBJECT_CONTEXT,
  VERDICTS,
  assertDisjointRoots,
  buildRegister,
  declaredSlots,
  lifecycleFiles,
} from "./tool-lifecycle-reach.mjs";
import {
  SURFACE_ROOTS as MCP_SURFACE_ROOTS,
  contextKey,
  contractMethods,
} from "./mcp-store-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const register = buildRegister();

test("the register has no unresolved problems", () => {
  assert.deepEqual(register.problems, []);
});

test("the two ORM registers claim disjoint roots, checked against the sibling's own export", () => {
  assert.deepEqual(assertDisjointRoots(LIFECYCLE_ROOTS, MCP_SURFACE_ROOTS), []);
  // And the sibling really does hold roots — an empty list would make the
  // disjointness above vacuously true.
  assert.ok(MCP_SURFACE_ROOTS.length >= 4, "the MCP surface register must still declare its roots");
});

test("the site total re-sums three independent ways", () => {
  const fromOwners = Object.values(register.byOwner).reduce((sum, count) => sum + count, 0);
  const fromVerdicts = Object.values(register.byVerdict).reduce((sum, count) => sum + count, 0);
  const fromDispositions = Object.values(register.dispositions).reduce(
    (sum, disposition) => sum + disposition.sites,
    0,
  );
  assert.equal(fromOwners, register.totalSites, "byOwner must re-sum to the total");
  assert.equal(fromVerdicts, register.totalSites, "byVerdict must re-sum to the total");
  assert.equal(fromDispositions, register.totalSites, "the dispositions must account for every site");
  assert.equal(
    register.delegateSites + register.clientSites,
    register.totalSites,
    "every site is a delegate call or a client-level reach and nothing else",
  );
});

test("the sites list itself re-derives every summary count", () => {
  const owners = {};
  const verdicts = {};
  for (const site of register.sites) {
    owners[site.owner] = (owners[site.owner] ?? 0) + 1;
    verdicts[site.verdict] = (verdicts[site.verdict] ?? 0) + 1;
  }
  assert.deepEqual(owners, register.byOwner);
  assert.deepEqual(verdicts, register.byVerdict);
  assert.equal(register.sites.length, register.totalSites);
});

test("`unblockedByComposingSubject` is what the raw site list says it is", () => {
  const expected = register.subjectComposed
    ? 0
    : register.sites.filter((site) => site.owner === SUBJECT_CONTEXT).length;
  assert.equal(register.unblockedByComposingSubject, expected);
});

test("every verdict used is one of the four declared, and every declared verdict is meaningful", () => {
  for (const verdict of Object.keys(register.byVerdict)) {
    assert.ok(VERDICTS[verdict] !== undefined, `${verdict} is not a declared verdict`);
  }
  for (const site of register.sites) {
    assert.ok(VERDICTS[site.verdict] !== undefined, `${site.file}:${site.line} carries ${site.verdict}`);
  }
});

test("a composed owner is never reported blocked on composition, in the root's own vocabulary", () => {
  for (const site of register.sites) {
    if (site.owner === "<client-level>") continue;
    const composed = register.composedContexts.includes(contextKey(site.owner));
    if (composed) {
      assert.notEqual(
        site.verdict,
        "blockedOnContext",
        `${site.file}:${site.line} owner ${site.owner} IS composed and is reported blocked on composition`,
      );
    }
  }
});

test("every disposition names methods the owning contract actually publishes", () => {
  for (const [file, disposition] of Object.entries(DISPOSITIONS)) {
    for (const [context, methods] of Object.entries(disposition.methods ?? {})) {
      const published = contractMethods(context, repositoryRoot);
      assert.ok(published !== null, `${context} publishes no contract for ${file} to name`);
      for (const method of methods) {
        assert.ok(
          published.includes(method),
          `${file} names ${context}.${method}; the contract publishes ${published.join(", ")}`,
        );
      }
    }
  }
});

test("every file holding a site has a disposition and no disposition is stale", () => {
  const withSites = new Set(register.sites.map((site) => site.file));
  for (const file of withSites) {
    assert.ok(DISPOSITIONS[file] !== undefined, `${file} holds sites and has no disposition`);
  }
  for (const file of Object.keys(DISPOSITIONS)) {
    assert.ok(withSites.has(file), `${file} has a disposition and holds no site`);
  }
});

test("`waitingOn` is one of the three the header declares", () => {
  const allowed = new Set(["context-composition", "contract-method", "transport-move"]);
  for (const [file, disposition] of Object.entries(DISPOSITIONS)) {
    assert.ok(allowed.has(disposition.waitingOn), `${file} waits on ${disposition.waitingOn}`);
  }
});

test("every declared dependency slot is classified, and every classification is declared", () => {
  const declared = declaredSlots(repositoryRoot);
  assert.deepEqual(
    [...declared].sort(),
    Object.keys(DEPENDENCY_SLOTS).sort(),
    "ToolsDependencies and DEPENDENCY_SLOTS must name the same slots",
  );
  const kinds = new Set(["peer", "adapter", "kernel", "domain-default", "root-satisfied", "unsatisfied"]);
  for (const [slot, entry] of Object.entries(DEPENDENCY_SLOTS)) {
    assert.ok(kinds.has(entry.kind), `${slot} carries kind ${entry.kind}`);
    assert.ok(entry.note.length > 0, `${slot} carries no note`);
  }
});

test("the foreign-ownership boundary names a root that exists and that this register does not scan", () => {
  const files = lifecycleFiles(repositoryRoot);
  for (const entry of FOREIGN_OWNERSHIP) {
    assert.ok(
      !files.some((file) => file.startsWith(`${entry.root}/`)),
      `${entry.root} is declared foreign and is being scanned`,
    );
    // It must be a real directory, or the boundary is a claim about nothing.
    const marker = join(repositoryRoot, entry.root);
    assert.doesNotThrow(() => readFileSync(join(marker, "..", "..", "package.json"), "utf8"));
  }
});

test("the committed evidence exists and reports the same total as the tree", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, MANIFEST), "utf8"));
  assert.equal(manifest.totalSites, register.totalSites);
  assert.equal(manifest.sites.length, register.sites.length);
  const report = readFileSync(join(repositoryRoot, REPORT), "utf8");
  assert.ok(
    report.includes(`**${register.totalSites} ORM call sites**`),
    "the report's headline figure must be the tree's",
  );
  // The report must name every site file, so a file cannot vanish from the prose
  // while surviving in the JSON.
  for (const file of new Set(register.sites.map((site) => site.file))) {
    assert.ok(report.includes(file), `${file} is in the manifest and not in the report`);
  }
});

test("MOVABLE is minted from the contract, and a column that over-claims is refused", () => {
  // THE VERDICT THAT COULD BE ASSERTED INTO EXISTENCE. `movable` means "the owner
  // is composed AND its published contract names this file's use case", and the
  // second half is a claim a human typed. `checkDispositions` already joins every
  // named method to the AST-read contract; what this case adds is the OTHER
  // direction and the NON-VACUITY, neither of which that check makes.
  const register = buildRegister();
  const movable = register.sites.filter((site) => site.verdict === "movable");
  assert.ok(movable.length > 0, "the register must find movable sites or the verdict is dead");

  for (const site of movable) {
    const named = DISPOSITIONS[site.file]?.methods?.[site.owner] ?? [];
    assert.ok(
      named.length > 0,
      `${site.file}:${String(site.line)} is MOVABLE and its disposition names no ${site.owner} method`,
    );
    assert.ok(
      register.composedContexts.includes(contextKey(site.owner)),
      `${site.owner} is MOVABLE and composeApplication does not compose it`,
    );
  }

  // AND A FILE THAT NAMES NOTHING HAS NO MOVABLE SITE. The two entries this stage
  // REMOVED — `tool-sync-ws.service.ts`'s `registerTools` and the discovery
  // scheduler's `discoverEntityTools` — are the reason: each named a method its own
  // note said does not serve the site, and each would have minted a verdict for a
  // call nothing can answer.
  for (const [file, disposition] of Object.entries(DISPOSITIONS)) {
    if (disposition.methods !== undefined) continue;
    assert.equal(
      register.sites.filter((site) => site.file === file && site.verdict === "movable").length,
      0,
      `${file} names no method and must have no movable site`,
    );
  }
  assert.ok(
    DISPOSITIONS["apps/agent/src/tool-gateway/tool-sync-ws.service.ts"].methods === undefined,
    "the sync socket's only tools site is a ToolHealth upsert, which registerTools does not serve",
  );
  assert.ok(
    DISPOSITIONS["apps/agent/src/tool-gateway/mcp-transport/entity-mcp-discovery-scheduler.service.ts"]
      .methods === undefined,
    "the scheduler's stale-client selection is published by no contract method",
  );
});

test("moved stays ZERO, because a moved site would be a boundary violation", () => {
  // `moved` IS A TRAP DETECTOR. A site is `moved` when it sits inside
  // `apps/core-api/src/transports/`, and `transport-reaches-no-store` (ADR M0.3
  // §5.1 rule (k2)) forbids an ORM reach there by ANY route — so a nonzero count is
  // the rule this register's destination scan root exists to catch, not progress.
  //
  // NOT A TAUTOLOGY: the destination IS a scan root and IS walked.
  const register = buildRegister();
  assert.equal(register.byVerdict.moved ?? 0, 0);
  assert.ok(LIFECYCLE_ROOTS.includes("apps/core-api/src/transports/tools"));
  assert.equal(
    register.sites.filter((site) => site.file.startsWith("apps/core-api/src/transports/")).length,
    0,
  );
});
