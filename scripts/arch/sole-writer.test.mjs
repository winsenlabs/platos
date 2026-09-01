import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  BLANKET_OWNER,
  MUTATING_DELEGATE_METHODS,
  OWNER,
  UNOWNED_ADR_ROWS,
  delegateName,
  modelForDelegate,
  owners,
} from "./table-ownership.mjs";
import {
  checkMapIntegrity,
  checkWriteEnforcement,
  findWrites,
  owningPackage,
  ownerDirectory,
  readSchemaModels,
} from "./sole-writer.mjs";

const fixtures = [];
after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files) {
  const root = mkdtempSync("/var/tmp/platos-sole-writer-");
  fixtures.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Map integrity — live against the real schema.
// ---------------------------------------------------------------------------

test("every canonical row in the live schema has exactly one owner", () => {
  const result = checkMapIntegrity();
  assert.deepEqual(result.problems, []);
  assert.equal(result.schemaModelCount, result.mappedModelCount);
  assert.ok(result.schemaModelCount >= 93, `scan looks vacuous: ${result.schemaModelCount} model(s)`);
});

test("the map's scan is not vacuous — it reads the real schema", () => {
  const models = readSchemaModels();
  assert.ok(models.includes("User"));
  assert.ok(models.includes("Organization"));
  assert.ok(models.includes("ToolCall"));
  assert.equal(new Set(models).size, models.length, "schema declares no duplicate model");
});

test("every owner is a real context directory, and the outbox pseudo-owner is an adapter", () => {
  assert.equal(ownerDirectory("tenancy"), "packages/contexts/tenancy");
  assert.equal(ownerDirectory("<kernel-outbox-adapter>"), "packages/adapters/outbox");
  // 17 ADR contexts + the outbox adapter pseudo-owner.
  assert.equal(owners().length, 18);
});

test("the ADR rows that are not canonical rows are recorded, not silently dropped", () => {
  assert.deepEqual(Object.keys(UNOWNED_ADR_ROWS).sort(), [
    "PlatformNotification",
    "PlatformNotificationInteraction",
    "SecretReference",
  ]);
  const schema = new Set(readSchemaModels());
  for (const model of Object.keys(UNOWNED_ADR_ROWS)) {
    assert.ok(!schema.has(model), `${model} is recorded as absent but is in the schema`);
    assert.ok(!(model in OWNER), `${model} is recorded as absent but has an owner`);
  }
});

test("ADR decisions that placed a contested row are pinned, so a silent flip fails", () => {
  // §7 decision 4: the EXECUTOR owns the execution record, not the transcript.
  assert.equal(OWNER.ToolCall, "tools");
  assert.equal(OWNER.ToolCallAudit, "tools");
  assert.equal(OWNER.Step, "conversations");
  // §7 decision 5: loadout is authoring.
  assert.equal(OWNER.AgentSkill, "agents");
  // §7 decision 6: Entity is the structural tenant row, not a channel record.
  assert.equal(OWNER.Entity, "tenancy");
  // §3: the auth wrong-way edge lands with governance as SafetyEvent's sole writer.
  assert.equal(OWNER.SafetyEvent, "governance");
  // §1 closing note + §7 decision 8: one physical outbox.
  assert.equal(OWNER.Event, "<kernel-outbox-adapter>");
  assert.equal(OWNER.ObservabilityOutbox, "<kernel-outbox-adapter>");
  // WIN-296's post-ADR row.
  assert.equal(OWNER.AccessKeyBootstrapGrant, "identity-access");
});

test("the vendor schema is owned wholesale by the durable-runtime adapter (§7 decision 10)", () => {
  assert.equal(BLANKET_OWNER.owner, "packages/adapters/durable-runtime");
  assert.match(BLANKET_OWNER.schema, /internal-packages\/database/u);
});

// ---------------------------------------------------------------------------
// Write enforcement — proven by fixtures, because no V1 package writes yet.
// ---------------------------------------------------------------------------

const write = (delegate, method) => `export async function run(db: any) {\n  await db.${delegate}.${method}({});\n}\n`;

test("a package writing a row it does not own FAILS", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/rogue.ts": write("user", "create"),
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].model, "User");
  assert.equal(result.violations[0].expected, "packages/contexts/identity-access");
  assert.match(result.violations[0].message, /identity-access is its sole writer/u);
});

test("the SAME write from the owning package PASSES", () => {
  const root = fixture({
    "packages/contexts/identity-access/application/mint.ts": write("user", "create"),
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 1, "the write must be seen, not merely un-flagged");
});

test("every mutating method is enforced, and reads are exempt by design", () => {
  for (const method of MUTATING_DELEGATE_METHODS) {
    const root = fixture({ [`packages/contexts/files/application/x.ts`]: write("user", method) });
    assert.equal(checkWriteEnforcement(root).violations.length, 1, `${method} must be enforced`);
  }
  for (const method of ["findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy"]) {
    const root = fixture({ [`packages/contexts/files/application/x.ts`]: write("user", method) });
    assert.deepEqual(checkWriteEnforcement(root).violations, [], `${method} is a read and must be exempt`);
  }
});

test("the outbox adapter is the only package that may write Event", () => {
  const bad = fixture({ "packages/contexts/observability/application/x.ts": write("event", "create") });
  assert.equal(checkWriteEnforcement(bad).violations.length, 1);

  const good = fixture({ "packages/adapters/outbox/src/x.ts": write("event", "create") });
  assert.deepEqual(checkWriteEnforcement(good).violations, []);
});

test("the gate is not foolable by a delegate name in a string, a comment or a type", () => {
  const root = fixture({
    "packages/contexts/files/application/x.ts":
      `// await db.user.create({});\n` +
      `const sql = "db.user.create({})";\n` +
      `type W = { user: { create: () => void } };\n` +
      `export type { W };\nexport const sqlText = sql;\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 0);
});

test("a write reached through a transaction handle is still a write", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(tx: any) {\n  await tx.accessKey.updateMany({});\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].model, "AccessKey");
});

test("delegate naming round-trips, including the OAuth models", () => {
  assert.equal(delegateName("User"), "user");
  assert.equal(delegateName("OAuthClient"), "oAuthClient");
  assert.equal(delegateName("McpToken"), "mcpToken");
  for (const model of Object.keys(OWNER)) {
    assert.equal(modelForDelegate(delegateName(model)), model, model);
  }
});

test("owningPackage resolves a file to its package, and nothing else", () => {
  assert.equal(owningPackage("packages/contexts/tenancy/domain/a.ts"), "packages/contexts/tenancy");
  assert.equal(owningPackage("packages/adapters/outbox/src/a.ts"), "packages/adapters/outbox");
  assert.equal(owningPackage("apps/core-api/src/main.ts"), null);
});

test("findWrites reports position and method, so a failure is actionable", () => {
  const found = findWrites("packages/contexts/x/a.ts", `\n\nawait db.budget.upsert({});\n`);
  assert.equal(found.length, 1);
  assert.equal(found[0].model, "Budget");
  assert.equal(found[0].method, "upsert");
  assert.equal(found[0].line, 3);
});

// ---------------------------------------------------------------------------
// Map-integrity failures must themselves fail.
// ---------------------------------------------------------------------------

test("map integrity fails when the schema gains a model with no owner", () => {
  const root = fixture({
    "internal-packages/tenancy-database/prisma/schema.prisma":
      `model User {\n  id String @id\n}\n\nmodel BrandNewRow {\n  id String @id\n}\n`,
  });
  // Owner directories are read from the real tree, so only the schema differs.
  const result = checkMapIntegrity(root);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("UNOWNED BrandNewRow")),
    "a new canonical row without an owner must fail",
  );
});

test("map integrity fails when an owned model leaves the schema", () => {
  const root = fixture({
    "internal-packages/tenancy-database/prisma/schema.prisma": `model User {\n  id String @id\n}\n`,
  });
  const result = checkMapIntegrity(root);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("PHANTOM Organization")),
    "an owner for a row that no longer exists must fail",
  );
});

test("map integrity fails when a row recorded as absent reappears in the schema", () => {
  const root = fixture({
    "internal-packages/tenancy-database/prisma/schema.prisma":
      `model SecretReference {\n  id String @id\n}\n`,
  });
  const result = checkMapIntegrity(root);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("RESOLVED SecretReference")),
    "a resurrected row must be given an owner rather than staying recorded as absent",
  );
});
