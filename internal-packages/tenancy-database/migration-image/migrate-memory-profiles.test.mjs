import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMigrationPlan,
  runMemoryProfileMigration,
  validProfileIndexes,
} from "./migrate-memory-profiles.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

const key = "11".repeat(32);
const baseRow = {
  id: "00000000-0000-4000-8000-000000000002",
  environmentId: "10000000-0000-4000-8000-000000000000",
  endUserId: "20000000-0000-4000-8000-000000000000",
  agentId: "30000000-0000-4000-8000-000000000000",
  clusterId: null,
  profileKey: null,
  updatedAt: new Date("2026-08-24T12:00:00.000Z"),
};

const exactIndexes = [
  {
    name: "Memory_profile_cluster_key",
    unique: true,
    valid: true,
    ready: true,
    live: true,
    nullsNotDistinct: false,
    hasExpressions: false,
    accessMethod: "btree",
    keyColumns: 4,
    totalColumns: 4,
    profileKeyType: "text",
    profileKeyNullable: true,
    profileKeyDefault: null,
    operatorClasses: ["pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "pg_catalog.text_ops"],
    indexCollations: ["0", "0", "0", "100"],
    columnCollations: ["0", "0", "0", "100"],
    columns: ["environmentId", "endUserId", "clusterId", "profileKey"],
    predicate: `((kind = 'profile'::text) AND ("clusterId" IS NOT NULL) AND ("profileKey" IS NOT NULL))`,
  },
  {
    name: "Memory_profile_standalone_key",
    unique: true,
    valid: true,
    ready: true,
    live: true,
    nullsNotDistinct: false,
    hasExpressions: false,
    accessMethod: "btree",
    keyColumns: 4,
    totalColumns: 4,
    profileKeyType: "text",
    profileKeyNullable: true,
    profileKeyDefault: null,
    operatorClasses: ["pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "pg_catalog.text_ops"],
    indexCollations: ["0", "0", "0", "100"],
    columnCollations: ["0", "0", "0", "100"],
    columns: ["environmentId", "endUserId", "agentId", "profileKey"],
    predicate: `((kind = 'profile'::text) AND ("clusterId" IS NULL) AND ("profileKey" IS NOT NULL))`,
  },
];

test("builds a deterministic decrypting and deduplicating plan without exposing content", () => {
  const sentinel = "Preferred Name SENTINEL";
  const rows = [
    { ...baseRow, metadata: encryptJson({ profileKey: ` ${sentinel} ` }) },
    {
      ...baseRow,
      id: "00000000-0000-4000-8000-000000000001",
      metadata: { profileKey: sentinel.toLocaleLowerCase("en-US") },
      updatedAt: new Date("2026-08-23T12:00:00.000Z"),
    },
  ];

  const first = buildMigrationPlan(rows, messageKeyEnv());
  const second = buildMigrationPlan(rows, messageKeyEnv());

  assert.equal(first.digest, second.digest);
  assert.notEqual(
    first.digest,
    buildMigrationPlan([{ ...rows[0], id: rows[1].id }, rows[1]], messageKeyEnv()).digest,
  );
  assert.equal(first.encrypted, 1);
  assert.equal(first.losers.length, 1);
  assert.deepEqual(first.losers[0], {
    loserId: "00000000-0000-4000-8000-000000000001",
    winnerId: baseRow.id,
  });
  assert.equal(JSON.stringify({ digest: first.digest, counts: first.losers.length }).includes(sentinel), false);
});

test("dry-run is read-only and emits only redacted deterministic inventory", async () => {
  const sentinel = "DO-NOT-EMIT-PROFILE-CONTENT";
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(String(sql));
      if (String(sql).includes('SELECT "id"')) {
        return { rows: [{ ...baseRow, metadata: { profileKey: sentinel } }] };
      }
      return { rows: [] };
    },
  };

  const output = await runMemoryProfileMigration("dry-run", {
    client,
    env: messageKeyEnv(),
  });

  assert.equal(output.status, "ready");
  assert.equal(output.contentRedacted, true);
  assert.equal(JSON.stringify(output).includes(sentinel), false);
  assert.equal(queries.some((sql) => /\b(UPDATE|DELETE|CREATE|ALTER)\b/.test(sql)), false);
  assert.equal(queries[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
});

test("default bootstrap creates indexes only for an empty profile dataset", async () => {
  const queries = [];
  let catalogReads = 0;
  const client = {
    query: async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM pg_index")) {
        catalogReads += 1;
        return { rows: catalogReads === 1 ? [] : exactIndexes };
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ profilesExist: false }] };
      return { rows: [] };
    },
  };

  const output = await runMemoryProfileMigration("bootstrap-empty", {
    client,
    env: messageKeyEnv(),
  });

  assert.equal(output.status, "bootstrapped");
  assert.equal(queries.filter((sql) => sql.includes("CREATE UNIQUE INDEX")).length, 2);
  assert.equal(queries.some((sql) => sql.includes('SELECT "id"')), false);
});

test("default bootstrap refuses existing profile data without mutation", async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM pg_index")) return { rows: [] };
      if (text.includes("SELECT EXISTS")) return { rows: [{ profilesExist: true }] };
      return { rows: [] };
    },
  };

  await assert.rejects(
    runMemoryProfileMigration("bootstrap-empty", {
      client,
      env: messageKeyEnv(),
    }),
    { code: "MEMORY_PROFILE_MIGRATION_REVIEW_REQUIRED", exitCode: 65 },
  );
  assert.equal(queries.some((sql) => sql.includes("CREATE UNIQUE INDEX")), false);
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("fails closed when encrypted metadata cannot be decrypted", () => {
  assert.throws(
    () => buildMigrationPlan(
      [{ ...baseRow, metadata: encryptJson({ profileKey: "preferred name" }) }],
      {},
    ),
    { code: "MEMORY_PROFILE_MIGRATION_DECRYPT_UNAVAILABLE" },
  );
});

test("fails closed when a profile row has no usable metadata identity", () => {
  assert.throws(
    () => buildMigrationPlan([{ ...baseRow, metadata: {} }], messageKeyEnv()),
    { code: "MEMORY_PROFILE_MIGRATION_PROFILE_KEY_REQUIRED", exitCode: 65 },
  );
});

test("apply fails promptly when another migration owns the advisory lock", async () => {
  const row = { ...baseRow, metadata: { profileKey: "preferred name" } };
  const digest = buildMigrationPlan([row], messageKeyEnv()).digest;
  const client = {
    query: async (sql) => String(sql).includes("pg_try_advisory_xact_lock")
      ? { rows: [{ locked: false }] }
      : { rows: [] },
  };

  await assert.rejects(
    runMemoryProfileMigration("apply", {
      client,
      env: messageKeyEnv(),
      expectedDigest: digest,
    }),
    { code: "MEMORY_PROFILE_MIGRATION_LOCK_BUSY", exitCode: 75 },
  );
});

test("preserves bounded historical message-key lookup semantics", () => {
  const envelope = encryptJson({ profileKey: "preferred name" });
  const plan = buildMigrationPlan(
    [{ ...baseRow, metadata: envelope }],
    { PLATOS_MESSAGE_ENCRYPTION_KEY_V1: key },
  );

  assert.equal(plan.encrypted, 1);
  assert.equal(plan.updates.length, 1);
});

test("apply requires the exact digest produced by dry-run before mutation", async () => {
  const queries = [];
  const client = fakeApplyClient(queries);

  await assert.rejects(
    runMemoryProfileMigration("apply", {
      client,
      env: messageKeyEnv(),
      expectedDigest: "a".repeat(64),
    }),
    { code: "MEMORY_PROFILE_MIGRATION_DIGEST_MISMATCH", exitCode: 66 },
  );
  assert.equal(queries.some((sql) => /\b(UPDATE|DELETE|CREATE|ALTER)\b/.test(sql)), false);
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("apply digest binds the exact relationship rows that can be remapped", async () => {
  const row = { ...baseRow, metadata: { profileKey: "preferred name" } };
  const relationships = [{
    id: "40000000-0000-4000-8000-000000000000",
    sourceMemoryId: row.id,
  }];
  const digest = buildMigrationPlan([row], messageKeyEnv(), relationships).digest;
  const client = {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes('SELECT relationship."id"')) {
        return { rows: [{ ...relationships[0], sourceMemoryId: "50000000-0000-4000-8000-000000000000" }] };
      }
      if (text.includes('SELECT "id"')) return { rows: [row] };
      if (text.includes("FROM pg_index")) return { rows: [] };
      return { rows: [] };
    },
  };

  await assert.rejects(
    runMemoryProfileMigration("apply", {
      client,
      env: messageKeyEnv(),
      expectedDigest: digest,
    }),
    { code: "MEMORY_PROFILE_MIGRATION_DIGEST_MISMATCH", exitCode: 66 },
  );
});

test("apply performs the approved plan once and repeated apply is idempotent", async () => {
  const queries = [];
  let applied = false;
  const row = { ...baseRow, metadata: { profileKey: "preferred name" } };
  const digest = buildMigrationPlan([row], messageKeyEnv()).digest;
  const client = {
    query: async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes('SELECT "id"')) {
        return { rows: [{ ...row, profileKey: applied ? "preferred name" : null }] };
      }
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM pg_index")) return { rows: applied ? exactIndexes : [] };
      if (text.includes('UPDATE "public"."Memory" AS memory')) applied = true;
      return { rows: [] };
    },
  };

  const first = await runMemoryProfileMigration("apply", {
    client,
    env: messageKeyEnv(),
    expectedDigest: digest,
  });
  const appliedDigest = buildMigrationPlan(
    [{ ...row, profileKey: "preferred name" }],
    messageKeyEnv(),
  ).digest;
  const second = await runMemoryProfileMigration("apply", {
    client,
    env: messageKeyEnv(),
    expectedDigest: appliedDigest,
  });

  assert.equal(first.status, "applied");
  assert.equal(second.status, "already_applied");
  assert.equal(
    queries.filter((sql) => sql.includes('UPDATE "public"."Memory" AS memory')).length,
    1,
  );
  assert.equal(queries.filter((sql) => sql.includes("CREATE UNIQUE INDEX")).length, 2);
});

test("already-applied state still requires the exact reviewed dry-run digest", async () => {
  const row = { ...baseRow, metadata: { profileKey: "preferred name" }, profileKey: "preferred name" };
  const client = {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes('SELECT "id"')) return { rows: [row] };
      if (text.includes("FROM pg_index")) return { rows: exactIndexes };
      return { rows: [] };
    },
  };

  await assert.rejects(
    runMemoryProfileMigration("apply", {
      client,
      env: messageKeyEnv(),
      expectedDigest: "a".repeat(64),
    }),
    { code: "MEMORY_PROFILE_MIGRATION_DIGEST_MISMATCH", exitCode: 66 },
  );
});

test("catalog validation is mutation-sensitive", () => {
  assert.equal(validProfileIndexes(exactIndexes), true);
  for (const mutation of [
    { predicate: exactIndexes[0].predicate.replace("IS NOT NULL", "IS NULL") },
    { columns: [...exactIndexes[0].columns].reverse() },
    { totalColumns: 5 },
    { profileKeyType: "character varying" },
    { operatorClasses: ["pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "public.text_ops"] },
    { indexCollations: ["0", "0", "0", "101"] },
    { accessMethod: "hash" },
    { ready: false },
  ]) {
    assert.equal(validProfileIndexes([{ ...exactIndexes[0], ...mutation }, exactIndexes[1]]), false);
  }
});

test("the immutable migrations image exposes explicit dry-run, apply, and verify commands", () => {
  const entrypoint = readFileSync(resolve(fixtureDirectory, "entrypoint.sh"), "utf8");
  const dockerfile = readFileSync(resolve(fixtureDirectory, "../Dockerfile.migrations"), "utf8");

  assert.match(entrypoint, /^  memory-profile-bootstrap-empty\)$/m);
  assert.match(entrypoint, /^  memory-profile-dry-run\)$/m);
  assert.match(entrypoint, /^  memory-profile-apply\)$/m);
  assert.match(entrypoint, /^  memory-profile-verify\)$/m);
  assert.match(entrypoint, /memory-profile-apply --digest SHA256/);
  assert.match(
    dockerfile,
    /COPY internal-packages\/tenancy-database\/migration-image\/migrate-memory-profiles\.mjs \.\/migrate-memory-profiles\.mjs/,
  );
});

test("CLI failures are stable, redacted JSON with stable exit status", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(fixtureDirectory, "migrate-memory-profiles.mjs"), "memory-profile-apply"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    event: "memory_profile_migration",
    status: "failed",
    code: "MEMORY_PROFILE_MIGRATION_DIGEST_REQUIRED",
    message: "memory-profile-apply requires --digest <dry-run-sha256>",
    contentRedacted: true,
  });
});

function fakeApplyClient(queries) {
  return {
    query: async (sql) => {
      queries.push(String(sql));
      if (String(sql).includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (String(sql).includes('SELECT "id"')) {
        return { rows: [{ ...baseRow, metadata: { profileKey: "preferred name" } }] };
      }
      if (String(sql).includes("FROM pg_index")) return { rows: [] };
      return { rows: [] };
    },
  };
}

function messageKeyEnv() {
  return {
    PLATOS_MESSAGE_ENCRYPTION_KEY: key,
    PLATOS_MESSAGE_ENCRYPTION_KEY_V: "1",
  };
}

function encryptJson(value) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    __platos_enc: 1,
    v: 1,
    ct: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"),
  };
}
