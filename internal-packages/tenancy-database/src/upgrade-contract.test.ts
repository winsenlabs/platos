import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = resolve(__dirname, "..");
const prismaRoot = resolve(packageRoot, "prisma");
const schema = readFileSync(resolve(prismaRoot, "schema.prisma"), "utf8");
const integratedInitial = readFileSync(
  resolve(prismaRoot, "migrations/00000000000000_initial/migration.sql"),
  "utf8"
);
const originMainInitial = readFileSync(
  resolve(prismaRoot, "upgrade-baselines/origin-main/00000000000000_initial.sql"),
  "utf8"
);
const observabilityMigration = readFileSync(
  resolve(
    prismaRoot,
    "migrations/20260824010000_win144_observability_retry_vocabulary/migration.sql"
  ),
  "utf8"
);
const memoryMigration = readFileSync(
  resolve(
    prismaRoot,
    "migrations/20260824111500_memory_profile_key_and_source_contract/migration.sql"
  ),
  "utf8"
);
const m4UpgradeMigration = readFileSync(
  resolve(prismaRoot, "migrations/20260824233000_m4_forward_upgrade_contract/migration.sql"),
  "utf8"
);

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const createTableBlock = (sql: string, table: string): string =>
  sql.match(new RegExp(`CREATE TABLE "public"\\."${table}" \\([\\s\\S]*?\\n\\);`))?.[0] ?? "";

describe("origin/main to integrated tenancy upgrade contract", () => {
  test("preserves every pre-existing migration byte and pins the exact origin/main rehearsal baseline", () => {
    expect(sha256(originMainInitial)).toBe(
      "5c43055e8b4d134676d7252ceba59bfe72d90b63c34be03e1807512b30ea19d3"
    );
    expect(sha256(integratedInitial)).toBe(
      "9c7deed5ff7d49248a972b1741e627bf00695060a11c8abfdcdc433fe9c48d5b"
    );
    expect(sha256(observabilityMigration)).toBe(
      "912c15b478d3e75cf425045ad0d045335064128b2b6ee3818fcfeecf5d445d9c"
    );
    expect(sha256(memoryMigration)).toBe(
      "297ec076b99701e557f363affb4e5318c8b6949590df81e50480360d459dde79"
    );
  });

  test("covers every physical initial-migration addition absent from origin/main", () => {
    const coverage = {
      PostmanExecution: [
        'CREATE TABLE IF NOT EXISTS "public"."PostmanExecution"',
        '"PostmanExecution_contextHandle_key"',
        '"PostmanExecution_turnId_key"',
        '"PostmanExecution_templateId_requestId_key"',
        '"PostmanExecution_environmentId_createdAt_idx"',
        '"PostmanExecution_actorUserId_createdAt_idx"',
        '"PostmanExecution_threadId_idx"',
        "PostmanExecution_environmentId_fkey",
        "PostmanExecution_agentId_fkey",
        "PostmanExecution_templateId_fkey",
        "PostmanExecution_actorUserId_fkey",
        "PostmanExecution_simulatedEndUserId_fkey",
        "PostmanExecution_threadId_fkey",
        "PostmanExecution_turnId_fkey",
        "PostmanExecution_requestFingerprint_check",
        "PostmanExecution_contextHandle_check",
        "PostmanExecution_ancestry",
        "PostmanExecution_attribution_immutable",
      ],
      ThreadFork: [
        'ADD COLUMN IF NOT EXISTS "forkedUpToTurnId" UUID',
        'ADD COLUMN IF NOT EXISTS "forkedTurnIds" UUID[]',
        '"Thread_forkedUpToTurnId_idx"',
        "Thread_forkedUpToTurnId_fkey",
        'cardinality(NEW."forkedTurnIds")',
        "Thread_owner_immutable",
        "Thread_ancestry",
      ],
      MessageAttachmentOwnership: [
        'ADD COLUMN IF NOT EXISTS "agentId" UUID',
        'ADD COLUMN IF NOT EXISTS "threadId" UUID',
        "MessageAttachment ownership backfill failed",
        'ALTER COLUMN "agentId" SET NOT NULL',
        'ALTER COLUMN "threadId" SET NOT NULL',
        "MessageAttachment_agentId_threadId_createdAt_idx",
        "MessageAttachment_threadId_turnId_idx",
        "MessageAttachment_agentId_fkey",
        "MessageAttachment_threadId_fkey",
        "MessageAttachment_owner_immutable",
        "MessageAttachment_binding_one_way",
        "MessageAttachment_ancestry",
      ],
      EntityToolPolicyOwnership: [
        'ADD COLUMN IF NOT EXISTS "environmentId" UUID',
        "EntityToolPolicy ownership backfill failed",
        "count(DISTINCT environment.id)",
        "EntityToolPolicy_environmentId_entityId_toolId_key",
        'DROP INDEX IF EXISTS "public"."EntityToolPolicy_entityId_toolId_key"',
        "EntityToolPolicy_environmentId_fkey",
        "EntityToolPolicy_ancestry",
      ],
    } as const;

    for (const [area, fragments] of Object.entries(coverage)) {
      for (const fragment of fragments) {
        expect(m4UpgradeMigration, `${area}: ${fragment}`).toContain(fragment);
      }
    }

    expect(createTableBlock(originMainInitial, "PostmanExecution")).toBe("");
    expect(createTableBlock(integratedInitial, "PostmanExecution")).not.toBe("");
    for (const addition of ['"forkedUpToTurnId" UUID', '"forkedTurnIds" UUID[]']) {
      expect(createTableBlock(originMainInitial, "Thread"), addition).not.toContain(addition);
      expect(createTableBlock(integratedInitial, "Thread"), addition).toContain(addition);
    }
    for (const addition of ['"agentId" UUID NOT NULL', '"threadId" UUID NOT NULL']) {
      expect(createTableBlock(originMainInitial, "MessageAttachment"), addition).not.toContain(
        addition
      );
      expect(createTableBlock(integratedInitial, "MessageAttachment"), addition).toContain(
        addition
      );
    }
    expect(createTableBlock(originMainInitial, "EntityToolPolicy")).not.toContain(
      '"environmentId" UUID NOT NULL'
    );
    expect(createTableBlock(integratedInitial, "EntityToolPolicy")).toContain(
      '"environmentId" UUID NOT NULL'
    );
  });

  test("accounts for schema deltas that intentionally require no additional storage DDL", () => {
    const storagePreservingMappings = [
      'requestCount   Int                 @default(1) @map("attempts")',
      'tokenRefreshClaimId    String?   @map("tokenRefreshAttemptId")',
      'retryCount       Int       @default(0) @map("attempts")',
      'retryCount             Int                 @default(0) @map("attemptCount")',
      'lastRetryAt            DateTime?           @map("lastAttemptAt")',
      'retryNumber    Int                 @map("attemptNumber")',
      '@@map("AlertDeliveryAttempt")',
      'invocationType   String     @map("triggerType")',
      'nextRetryAt       DateTime?  @map("nextAttemptAt")',
    ];
    for (const mapping of storagePreservingMappings) expect(schema).toContain(mapping);

    expect(observabilityMigration).toContain('RENAME COLUMN "attempts" TO "retryCount"');
    for (const memoryColumn of [
      'ADD COLUMN "profileKey" TEXT',
      'ADD COLUMN "originalSource" TEXT',
      'ADD COLUMN "originalSourceThreadId" TEXT',
      'ADD COLUMN "originalSourceTurnIds" TEXT[]',
    ]) {
      expect(memoryMigration).toContain(memoryColumn);
    }
  });

  test("runs fail-loud compatible preflights before atomic tenant-derived backfills", () => {
    const transaction = m4UpgradeMigration.indexOf("\nBEGIN;\n");
    const attachmentPreflight = m4UpgradeMigration.indexOf(
      "MessageAttachment ownership backfill failed"
    );
    const attachmentBackfill = m4UpgradeMigration.indexOf(
      'UPDATE "public"."MessageAttachment" attachment'
    );
    const attachmentNotNull = m4UpgradeMigration.indexOf(
      'ALTER TABLE "public"."MessageAttachment" ALTER COLUMN "agentId" SET NOT NULL'
    );
    expect(attachmentPreflight).toBeGreaterThanOrEqual(0);
    expect(attachmentPreflight).toBeLessThan(transaction);
    expect(attachmentBackfill).toBeGreaterThan(attachmentPreflight);
    expect(attachmentBackfill).toBeGreaterThan(transaction);
    expect(attachmentNotNull).toBeGreaterThan(attachmentBackfill);
    expect(m4UpgradeMigration).toContain("unattached_count");
    expect(m4UpgradeMigration).toContain("scope_mismatch_count");
    expect(m4UpgradeMigration).toContain("conflicting_owner_count");

    const policyPreflight = m4UpgradeMigration.indexOf(
      "EntityToolPolicy ownership backfill failed"
    );
    const policyBackfill = m4UpgradeMigration.indexOf("WITH owners AS");
    const policyNotNull = m4UpgradeMigration.indexOf(
      'ALTER TABLE "public"."EntityToolPolicy" ALTER COLUMN "environmentId" SET NOT NULL'
    );
    expect(policyPreflight).toBeGreaterThanOrEqual(0);
    expect(policyPreflight).toBeLessThan(transaction);
    expect(policyBackfill).toBeGreaterThan(policyPreflight);
    expect(policyBackfill).toBeGreaterThan(transaction);
    expect(policyNotNull).toBeGreaterThan(policyBackfill);
    expect(m4UpgradeMigration).toContain("missing_owner_count");
    expect(m4UpgradeMigration).toContain("ambiguous_owner_count");
    expect(m4UpgradeMigration).toContain("information_schema.columns");
    expect(m4UpgradeMigration).toContain("NULL::UUID");
    expect(m4UpgradeMigration.match(/MessageAttachment ownership backfill failed/g)).toHaveLength(
      1
    );
    expect(m4UpgradeMigration.match(/EntityToolPolicy ownership backfill failed/g)).toHaveLength(1);
    expect(m4UpgradeMigration).not.toMatch(/LIMIT\s+1/i);
  });
});
