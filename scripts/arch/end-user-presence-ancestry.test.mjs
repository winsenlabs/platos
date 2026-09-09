// WIN-268 P3 — proof that the end-user presence invariant can fail.
//
// The audit joins three files it does not own. These cases mutate each of the
// three in a fixture copy and require the audit to go red, and one case removes
// the audit's own anchor to prove it reports blindness instead of passing.
//
// THE REMOVAL STATEMENT IS LIFTED FROM THE REAL MIGRATION, never written here.
// `20260824233000_m4_forward_upgrade_contract` already removes and reinstalls
// `Thread_ancestry`, so reusing its own line proves the matcher understands the
// exact spelling production uses rather than one invented to suit it.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  END_USERS_TOOL,
  MIGRATIONS_DIRECTORY,
  PRESENCE_FUNCTION,
  ancestryRuleTables,
  check,
  endUserRelationTargets,
  presenceRelations,
} from "./end-user-presence-ancestry.mjs";
import { CANONICAL_SCHEMA } from "./table-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "pl-presence-"));
  for (const path of [END_USERS_TOOL, CANONICAL_SCHEMA]) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    cpSync(join(repositoryRoot, path), join(root, path));
  }
  cpSync(join(repositoryRoot, MIGRATIONS_DIRECTORY), join(root, MIGRATIONS_DIRECTORY), { recursive: true });
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

test("the invariant holds on this repository", () => {
  assert.deepEqual(check(repositoryRoot).problems, []);
});

test("the audit is non-vacuous: it reads real relations and real ancestry rules", () => {
  const relations = presenceRelations(repositoryRoot);
  assert.ok(relations.length >= 5, `expected the five presence relations, saw ${relations.length}`);
  assert.ok(relations.includes("threads"));
  // `environmentId` is the key INSIDE `some`, not a relation. A textual scan
  // would have collected it, and would then have looked for a model of that name.
  assert.ok(!relations.includes("environmentId"));

  const targets = endUserRelationTargets(repositoryRoot);
  assert.equal(targets.threads, "Thread");
  assert.equal(targets.safetyEvents, "SafetyEvent");
  // A scalar column is not a relation.
  assert.equal(targets.organizationId, undefined);

  const rules = ancestryRuleTables(repositoryRoot);
  assert.ok(rules.size > 20, `expected the schema's ancestry rules, saw ${rules.size}`);
  assert.ok(rules.has("Thread"));
});

/** The real removal statement for `Thread_ancestry`, taken from the migration that issues one. */
function removalStatementFromTheTree(root) {
  const source = join(root, MIGRATIONS_DIRECTORY, "20260824233000_m4_forward_upgrade_contract", "migration.sql");
  const line = readFileSync(source, "utf8")
    .split("\n")
    .find((candidate) => /^\s*DROP\b/u.test(candidate) && candidate.includes('"Thread_ancestry"'));
  assert.ok(line, "the M4 migration no longer removes Thread_ancestry — this fixture's source has moved");
  return `${line}\n`;
}

function removeThreadAncestryInALaterMigration(root) {
  const later = join(root, MIGRATIONS_DIRECTORY, "99999999999999_remove_thread_ancestry");
  mkdirSync(later, { recursive: true });
  writeFileSync(join(later, "migration.sql"), removalStatementFromTheTree(root));
}

test("the replay honours removal, so a removed rule is not reported installed", () => {
  // The M4 migration removes and reinstalls Thread_ancestry against a different
  // function. A creation-only scan would be right there by luck; this proves the
  // replay, by removing it in a later migration and never reinstalling it.
  withFixture((root) => {
    assert.ok(ancestryRuleTables(root).has("Thread"));
    removeThreadAncestryInALaterMigration(root);
    assert.ok(!ancestryRuleTables(root).has("Thread"), "a removed rule was still reported installed");
  });
});

test("MUTATION: a presence relation whose model has no ancestry rule goes RED", () => {
  // `identities` -> EndUserIdentity is the real hazard shape: it is a list
  // relation on EndUser and EndUserIdentity carries NO ancestry rule (its
  // cross-tenant guard is the composite [endUserId, organizationId] foreign key
  // instead). Admitting it to the presence OR would put an unguarded row inside
  // the conjunction that end_users.* authorises on.
  withFixture((root) => {
    assert.deepEqual(check(root).problems, []);
    const path = join(root, END_USERS_TOOL);
    const source = readFileSync(path, "utf8");
    const mutated = source.replace(
      "      { threads: { some: { environmentId } } },",
      "      { threads: { some: { environmentId } } },\n      { identities: { some: { environmentId } } },",
    );
    assert.notEqual(mutated, source, "the fixture edit did not apply — the presence list has moved");
    writeFileSync(path, mutated);

    const result = check(root);
    assert.ok(result.relations.includes("identities"));
    assert.ok(
      result.problems.some((problem) => problem.includes("EndUserIdentity") && problem.includes("NO _ancestry rule")),
      `expected the unguarded relation to be reported, got: ${result.problems.join(" | ")}`,
    );
  });
});

test("MUTATION: removing the Thread ancestry rule goes RED", () => {
  withFixture((root) => {
    removeThreadAncestryInALaterMigration(root);

    const result = check(root);
    assert.ok(
      result.problems.some((problem) => problem.includes("threads") && problem.includes("Thread")),
      `expected the removed rule to be reported, got: ${result.problems.join(" | ")}`,
    );
  });
});

test("MUTATION: a presence relation the schema does not have goes RED", () => {
  withFixture((root) => {
    const path = join(root, END_USERS_TOOL);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "      { threads: { some: { environmentId } } },",
        "      { invented: { some: { environmentId } } },",
      ),
    );
    const result = check(root);
    assert.ok(
      result.problems.some((problem) => problem.includes('"invented"')),
      `expected the unknown relation to be reported, got: ${result.problems.join(" | ")}`,
    );
  });
});

test("MUTATION: losing the anchor reports BLINDNESS rather than passing", () => {
  // The failure mode a static audit dies of: the code it reads is renamed, it
  // finds nothing to complain about, and it goes green forever.
  withFixture((root) => {
    const path = join(root, END_USERS_TOOL);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(PRESENCE_FUNCTION, "presenceRenamed"));
    const result = check(root);
    assert.ok(
      result.problems.some((problem) => problem.includes("this audit is blind")),
      `expected a blindness report, got: ${result.problems.join(" | ")}`,
    );
  });
});
