import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  BLANKET_OWNER,
  MUTATING_DELEGATE_METHODS,
  OWNER,
  RAW_SQL_METHODS,
  READ_DELEGATE_METHODS,
  UNOWNED_ADR_ROWS,
  delegateName,
  modelForDelegate,
  owners,
} from "./table-ownership.mjs";
import {
  canonicalTables,
  check,
  checkMapIntegrity,
  checkWriteEnforcement,
  failures,
  findSqlMutations,
  findWrites,
  owningPackage,
  ownerDirectory,
  readSchemaModels,
  readSchemaTables,
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
  const found = findWrites("packages/contexts/x/a.ts", `\n\nawait db.budget.upsert({});\n`).writes;
  assert.equal(found.length, 1);
  assert.equal(found[0].model, "Budget");
  assert.equal(found[0].method, "upsert");
  assert.equal(found[0].line, 3);
});

// ---------------------------------------------------------------------------
// The seven evasion probes from the 2026-09-02 independent verification.
//
// SIX of these were invisible to the check as shipped at 3ed8f3ce, because the
// matcher required a literal two-level `X.<delegate>.<mutator>()`. Each probe
// is a negative control in its own right: it writes `User`, which
// identity-access owns, from `tenancy`, which does not. If the detector stops
// seeing one of them, the assertion goes red rather than the suite going quiet.
// ---------------------------------------------------------------------------

const PROBES = Object.freeze({
  "direct delegate call": `export async function run(db: any) {\n  await db.user.create({});\n}\n`,
  "element-access delegate": `export async function run(db: any) {\n  await db["user"].create({});\n}\n`,
  "destructured delegate": `export async function run(db: any) {\n  const { user } = db;\n  await user.create({});\n}\n`,
  "renamed destructured delegate": `export async function run(db: any) {\n  const { user: u } = db;\n  await u.create({});\n}\n`,
  "aliased delegate": `export async function run(db: any) {\n  const u = db.user;\n  await u.create({});\n}\n`,
  "aliased element-access delegate": `export async function run(db: any) {\n  const u = db["user"];\n  await u.deleteMany({});\n}\n`,
  "computed method on a delegate": `export async function run(db: any, m: string) {\n  await db.user[m]({});\n}\n`,
  "raw INSERT through $executeRawUnsafe": `export async function run(db: any) {\n  await db.$executeRawUnsafe('INSERT INTO "User" (id) VALUES (1)');\n}\n`,
  "raw INSERT through a $queryRaw tagged template": `export async function run(db: any, id: string) {\n  await db.$queryRaw\`INSERT INTO "User" (id) VALUES (\${id})\`;\n}\n`,
  "raw UPDATE through $executeRaw": `export async function run(db: any) {\n  await db.$executeRaw\`UPDATE "User" SET name = 'x'\`;\n}\n`,
  "raw DELETE through $queryRawUnsafe": `export async function run(db: any) {\n  await db.$queryRawUnsafe('DELETE FROM "User" WHERE id = 1');\n}\n`,
});

for (const [label, source] of Object.entries(PROBES)) {
  test(`EVASION PROBE — ${label} is caught writing a row tenancy does not own`, () => {
    const root = fixture({ "packages/contexts/tenancy/application/rogue.ts": source });
    const result = checkWriteEnforcement(root);
    assert.equal(
      result.violations.length + result.unattributable.length,
      1,
      `${label} produced ${JSON.stringify(result)}`,
    );
    if (result.violations.length === 1) {
      assert.equal(result.violations[0].model, "User");
      assert.equal(result.violations[0].expected, "packages/contexts/identity-access");
    }
  });

  test(`EVASION PROBE — ${label} is PERMITTED from the owning package`, () => {
    const root = fixture({ "packages/contexts/identity-access/application/mint.ts": source });
    const result = checkWriteEnforcement(root);
    assert.deepEqual(result.violations, [], label);
    assert.deepEqual(result.unattributable, [], label);
    assert.equal(result.writeCount, 1, `${label} must be SEEN in the owning package, not merely un-flagged`);
  });
}

test("a computed DELEGATE cannot be attributed, so it fails in every package", () => {
  const source =
    `export async function run(db: any, name: string) {\n` +
    `  await db.user.findMany({});\n` +
    `  await db[name].create({});\n}\n`;
  for (const owner of ["identity-access", "tenancy"]) {
    const root = fixture({ [`packages/contexts/${owner}/application/x.ts`]: source });
    const result = checkWriteEnforcement(root);
    assert.equal(result.unattributable.length, 1, owner);
    assert.equal(result.unattributable[0].reason, "computed-delegate");
  }
});

test("a raw statement assembled at runtime cannot be attributed, so it fails in every package", () => {
  const source = `export async function run(db: any, sql: string) {\n  await db.$executeRawUnsafe(sql);\n}\n`;
  for (const owner of ["identity-access", "tenancy"]) {
    const root = fixture({ [`packages/contexts/${owner}/application/x.ts`]: source });
    const result = checkWriteEnforcement(root);
    assert.equal(result.unattributable.length, 1, owner);
    assert.equal(result.unattributable[0].reason, "raw-sql-not-static");
  }
});

test("a raw statement whose table is interpolated cannot be attributed", () => {
  const root = fixture({
    "packages/contexts/identity-access/application/x.ts":
      `export async function run(db: any, t: string) {\n  await db.$executeRaw\`INSERT INTO \${t} (id) VALUES (1)\`;\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.unattributable.length, 1);
  assert.equal(result.unattributable[0].reason, "raw-sql-unknown-table");
});

test("a raw statement naming a table no canonical model claims cannot be attributed", () => {
  const root = fixture({
    "packages/contexts/identity-access/application/x.ts":
      `export async function run(db: any) {\n  await db.$executeRawUnsafe('INSERT INTO "SomeLegacyTable" (id) VALUES (1)');\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.unattributable.length, 1);
  assert.equal(result.unattributable[0].reason, "raw-sql-unknown-table");
});

test("a raw statement that only READS is exempt, exactly as a findMany is", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(db: any) {\n` +
      `  await db.$queryRaw\`SELECT id FROM "User" WHERE id = 1 FOR UPDATE\`;\n` +
      `  await db.$executeRaw\`SET LOCAL statement_timeout = 5000\`;\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 0);
});

test("ON CONFLICT DO UPDATE is one INSERT, not an INSERT and a stray UPDATE", () => {
  const found = findSqlMutations(
    `INSERT INTO "User" (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1`,
    canonicalTables(),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].statement, "insert into");
  assert.equal(found[0].model, "User");
});

test("a mutating verb inside a SQL comment is prose, not a write", () => {
  const found = findSqlMutations(`-- update the audit row\nSELECT 1`, canonicalTables());
  assert.deepEqual(found, []);
});

test("raw attribution follows @@map, so the PHYSICAL table name resolves", () => {
  // Derived from the schema rather than transcribed: the one `@@map`ped model
  // carries an inherited physical name that the vocabulary boundary does not
  // permit in authored V1 source, and hard-coding it here would spread it.
  const tables = readSchemaTables();
  const remapped = [...tables].filter(([table, model]) => table !== model.toLowerCase());
  assert.equal(remapped.length, 1, "the canonical schema has exactly one @@map'd model");
  const [physical, model] = remapped[0];
  assert.equal(tables.has(model.toLowerCase()), false, "the model name is NOT the table name here");

  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(db: any) {\n  await db.$executeRawUnsafe('DELETE FROM "${physical}" WHERE id = 1');\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].model, model);
  assert.equal(result.violations[0].expected, ownerDirectory(OWNER[model]));
  assert.notEqual(result.violations[0].expected, "packages/contexts/tenancy");
});

// This is the live-tree finding that decided the fail-closed AXIS. Failing
// closed on an unrecognised METHOD NAME reported four calls in identity-access
// that are not Prisma at all — `ports.repository.impersonationAudit.append()` is
// a domain port named after the row it owns. A name in neither Prisma list is
// evidence the receiver was never a delegate.
test("a method in neither Prisma list is a domain port, not a hidden write", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(ports: any, entry: any) {\n` +
      `  await ports.repository.impersonationAudit.append(entry);\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 0);
});

test("reads on a resolved delegate are counted, so the gate can show it is not blind", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(db: any) {\n  await db.user.findMany({});\n  await db["user"].count({});\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 0);
  assert.equal(result.readCount, 2, "a read must be SEEN and exempted, not merely unmatched");
});

test("the read list and the write list do not overlap, and both are non-empty", () => {
  const overlap = READ_DELEGATE_METHODS.filter((method) => MUTATING_DELEGATE_METHODS.includes(method));
  assert.deepEqual(overlap, []);
  assert.ok(READ_DELEGATE_METHODS.length >= 6);
  assert.deepEqual([...RAW_SQL_METHODS].sort(), [
    "$executeRaw",
    "$executeRawUnsafe",
    "$queryRaw",
    "$queryRawUnsafe",
  ]);
});

test("an element-access member that is not a delegate is still not a write", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(rows: any[], i: number) {\n  rows[i].create({});\n  rows["thing"].delete({});\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
});

test("the live tree still judges zero mutations, and the banner may claim no more", () => {
  const result = check();
  assert.equal(result.enforcement.writeCount, 0, "a V1 package now writes; the note in main() must be revisited");
  assert.deepEqual(result.enforcement.violations, []);
  assert.deepEqual(result.enforcement.unattributable, []);
  assert.equal(failures(result), 0);
  assert.ok(result.enforcement.fileCount > 0, "the scan must have read something");
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
