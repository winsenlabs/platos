import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  baselineForInventory,
  evaluateInventory,
  inventoryRepository,
} from "./audit-webapp-database-cutover.mjs";

const LEGACY_SCHEMA = `
model RuntimeEnvironment {
  id String @id
}

model TaskRun {
  id String @id
}

model BackgroundWorker {
  id String @id
}
`;

const CLEAN_SCHEMA = `
model Environment {
  id String @id
}
`;

function write(root, path, contents) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "webapp-cutover-audit-"));
  write(root, "apps/webapp/package.json", JSON.stringify({ name: "fixture", dependencies: {} }));
  write(root, "apps/agent/package.json", JSON.stringify({ name: "agent-fixture" }));
  write(root, "internal-packages/database/legacy-prisma/schema.prisma", LEGACY_SCHEMA);
  write(root, "internal-packages/database/prisma/schema.prisma", CLEAN_SCHEMA);
  return root;
}

function categories(result) {
  return new Set(result.violations.map((finding) => finding.category));
}

test("baseline inventory is deterministic and excludes inactive fixture paths", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  write(
    root,
    "apps/webapp/app/active.server.ts",
    `import { PrismaClient } from "@platos/database";
     const prisma = new PrismaClient();
     prisma.runtimeEnvironment.findMany();
     prisma.$queryRaw\`SELECT * FROM "TaskRun"\`;`
  );
  for (const path of [
    "apps/webapp/app/example.test.ts",
    "apps/webapp/app/generated/client.ts",
    "apps/webapp/app/fixtures/legacy.ts",
    "apps/webapp/app/docs/cutover.ts",
  ]) {
    write(root, path, `import "@platos/database"; prisma.taskRun.findMany();`);
  }

  const first = inventoryRepository(root);
  const second = inventoryRepository(root);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.findings.map(({ category, path, token }) => ({ category, path, token })),
    [
      {
        category: "legacy-delegate",
        path: "apps/webapp/app/active.server.ts",
        token: "runtimeEnvironment",
      },
      {
        category: "legacy-import",
        path: "apps/webapp/app/active.server.ts",
        token: "@platos/database",
      },
      { category: "legacy-raw-table", path: "apps/webapp/app/active.server.ts", token: "TaskRun" },
    ]
  );
});

test("new forbidden ownership surfaces fail while external integrations remain allowed", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = baselineForInventory(inventoryRepository(root));

  write(
    root,
    "apps/webapp/app/new-legacy.server.ts",
    `import { PrismaClient } from "@platos/database";
     const prisma = new PrismaClient();
     prisma.taskRun.findMany();
     prisma.$queryRaw\`SELECT * FROM "TaskRun"\`;
     export const secondDatabase = "secondary database";
     export const sync = "database synchronization";
     export const writes = "dual-write to PostgreSQL";
     export const fallback = "fallback database";
     export const bridge = "database bridge";`
  );
  write(root, "apps/webapp/app/routes/engine.v2.synthetic.ts", "export const action = () => null;");
  write(root, "apps/agent/src/trigger-worker.ts", "export const worker = true;");
  write(
    root,
    "internal-packages/database/prisma/schema.prisma",
    `${CLEAN_SCHEMA}\nmodel TriggerRun {\n  id String @id\n}\n`
  );

  const result = evaluateInventory(inventoryRepository(root), baseline, "inventory");
  assert.equal(result.ok, false);
  assert.deepEqual(
    categories(result),
    new Set([
      "forbidden-architecture",
      "legacy-delegate",
      "legacy-import",
      "legacy-raw-table",
      "local-engine-route",
      "local-worker-surface",
      "trigger-owned-clean-model",
    ])
  );
  assert.deepEqual(
    new Set(
      result.violations
        .filter((finding) => finding.category === "forbidden-architecture")
        .map((finding) => finding.token)
    ),
    new Set([
      "second-database",
      "database-sync",
      "dual-write",
      "database-fallback",
      "database-bridge",
    ])
  );

  rmSync(join(root, "apps/webapp/app/new-legacy.server.ts"));
  rmSync(join(root, "apps/webapp/app/routes/engine.v2.synthetic.ts"));
  rmSync(join(root, "apps/agent/src/trigger-worker.ts"));
  write(root, "internal-packages/database/prisma/schema.prisma", CLEAN_SCHEMA);
  write(
    root,
    "apps/agent/src/external-trigger.ts",
    `import { tasks } from "@trigger.dev/sdk";
     type TriggerApi = { session: TriggerSession };
     export const analytics = "ClickHouse dual-write";
     export const blobs = "object-store database fallback";`
  );

  const allowed = evaluateInventory(inventoryRepository(root), baseline, "inventory");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.violations.length, 0);
});

test("external-store exemptions are exact and cannot hide mixed database ownership", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = baselineForInventory(inventoryRepository(root));

  write(
    root,
    "apps/webapp/app/clickhouse-mixed.server.ts",
    `export const clickhouseAnalytics = "ClickHouse dual-write";
     export const alternateUrl = "ClickHouse and TENANCY_DATABASE_URL";
     export const fallback = "ClickHouse and fallback database";
     export const bridge = "object-store and database bridge";
     export const sync = "ClickHouse and database synchronization";
     export const postgresWrites = "ClickHouse approval ledger and PostgreSQL dual-write";
     import { Pool } from "pg";`
  );

  const result = evaluateInventory(inventoryRepository(root), baseline, "inventory");
  const architecture = result.violations.filter(
    (finding) => finding.category === "forbidden-architecture"
  );
  assert.deepEqual(
    new Set(architecture.map((finding) => finding.token)),
    new Set([
      "alternate-postgres-client",
      "second-database",
      "database-fallback",
      "database-bridge",
      "database-sync",
      "dual-write",
    ])
  );
  assert.equal(architecture.find((finding) => finding.token === "dual-write")?.count, 1);

  rmSync(join(root, "apps/webapp/app/clickhouse-mixed.server.ts"));
  write(
    root,
    "apps/webapp/app/safe-external.server.ts",
    `export const analytics = "ClickHouse dual-write";
     export const blobs = "object-store database fallback";`
  );
  assert.equal(evaluateInventory(inventoryRepository(root), baseline, "inventory").ok, true);
});

test("legacy delegates are detected through computed access, aliases, and destructuring", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = baselineForInventory(inventoryRepository(root));

  write(
    root,
    "apps/webapp/app/delegate-bypasses.server.ts",
    `prisma["taskRun"].findMany();
     const runs = prisma.taskRun;
     runs.findFirst();
     const alias = runs;
     alias.count();
     const { taskRun } = prisma;
     taskRun.updateMany({});
     const { taskRun: renamedRuns } = prisma;
     renamedRuns.deleteMany({});`
  );

  const result = evaluateInventory(inventoryRepository(root), baseline, "inventory");
  const delegate = result.violations.find(
    (finding) => finding.category === "legacy-delegate" && finding.token === "taskRun"
  );
  assert.equal(delegate?.count, 5);
});

test("allowances must shrink and expire by execution phase", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacyPath = "apps/webapp/app/legacy.server.ts";
  write(root, legacyPath, `import type { TaskRun } from "@platos/database";`);
  write(root, "apps/webapp/app/routes/engine.v1.baseline.ts", "export const loader = () => null;");

  const originalInventory = inventoryRepository(root);
  const originalBaseline = baselineForInventory(originalInventory);
  assert.equal(evaluateInventory(originalInventory, originalBaseline, "inventory").ok, true);

  write(root, legacyPath, "export const clean = true;");
  const shrunkInventory = inventoryRepository(root);
  const stale = evaluateInventory(shrunkInventory, originalBaseline, "inventory");
  assert.equal(stale.ok, false);
  assert.equal(
    stale.staleAllowances.some((entry) => entry.category === "legacy-import"),
    true
  );

  const shrunkBaseline = baselineForInventory(shrunkInventory);
  assert.equal(evaluateInventory(shrunkInventory, shrunkBaseline, "inventory").ok, true);
  write(root, legacyPath, `import type { TaskRun } from "@platos/database";`);
  assert.equal(
    evaluateInventory(inventoryRepository(root), shrunkBaseline, "inventory").violations.some(
      (entry) => entry.category === "legacy-import"
    ),
    true
  );

  const webappCutover = evaluateInventory(originalInventory, originalBaseline, "webapp-cutover");
  assert.equal(
    webappCutover.violations.some((entry) => entry.category === "legacy-import"),
    true
  );
  assert.equal(
    webappCutover.violations.some((entry) => entry.category === "local-engine-route"),
    false
  );

  const modeCRemoval = evaluateInventory(originalInventory, originalBaseline, "mode-c-removal");
  assert.equal(
    modeCRemoval.violations.some((entry) => entry.category === "local-engine-route"),
    true
  );
});
