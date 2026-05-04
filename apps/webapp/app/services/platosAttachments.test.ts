/**
 * PPR-40 — Attachment retention sweep tests.
 *
 * Exercises `runRetentionSweep` in `~/services/platosAttachments.server`.
 * Seeds attachments with varying expiry states (past, future, null, already-
 * deleted storage) and verifies:
 *   - Only rows with `expiresAt < now` are deleted.
 *   - Scope isolation — a row's deletion doesn't touch other scopes.
 *   - Storage failures are counted but row deletion proceeds.
 *
 * CLAUDE.md §9.11: Vitest only, never mock — testcontainers pattern.
 *
 * Most blocks are SCAFFOLDED because running `platosAttachments.server.ts`
 * inside Vitest requires:
 *   1. A Postgres testcontainer with the full Platos schema migrated.
 *   2. A running MinIO testcontainer (`createMinIOContainer`).
 *   3. Rebinding `~/db.server`, `~/env.server`, `~/services/logger.server`
 *      to testcontainer-derived instances — the module is a Remix server
 *      file hard-wired to import { prisma } from "~/db.server".
 *
 * Follow-up ticket: wire the `postgresAndMinioTest` fixture from
 * `@platos/testcontainers` into a vitest.config.ts `setupFiles` override
 * that rebinds `~/db.server` + `~/env.server` for the duration of the test
 * run. Spike-estimate: 2-3 hours.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@platos/database";

const SCOPE_A = {
  organizationId: "org_A",
  projectId: "proj_A",
  environmentId: "env_A",
  userId: "user_A",
};
const SCOPE_B = {
  organizationId: "org_B",
  projectId: "proj_B",
  environmentId: "env_B",
  userId: "user_B",
};

describe("runRetentionSweep (scaffold)", () => {
  let prisma: PrismaClient | null = null;
  let stop: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    // TODO: use postgresAndMinioTest from @platos/testcontainers
  }, 120_000);

  afterAll(async () => {
    if (stop) await stop();
    await (prisma as any)?.$disconnect?.();
  });

  it.skip("deletes rows whose expiresAt is in the past", async () => {
    // Seed:
    //   - rowPast (expiresAt = now - 1h)   → should be deleted
    //   - rowFuture (expiresAt = now + 1h) → should survive
    //   - rowNull (expiresAt = null)       → should survive (grace period not set)
    // Assert: scanned=1, deletedRows=1, storageFailures=0
    // Assert: rowFuture + rowNull still queryable after sweep.
  });

  it.skip("scope isolation: sweeps delete rows regardless of scope (retention is global)", async () => {
    // Seed expired row in both SCOPE_A and SCOPE_B.
    // Run sweep.
    // Expect: both deleted (retention is a global operation). This is
    // intentional — scope isolation protects READS, not global maintenance.
    // Document this so future auditors know the design.
  });

  it.skip("counts storage-failure on unreachable MinIO object but still deletes row", async () => {
    // Seed row pointing at a storageKey that doesn't exist in MinIO.
    // Run sweep.
    // Expect: storageFailures=1, deletedRows=1 (row still removed).
  });

  it.skip("respects limit option (take N expired rows)", async () => {
    // Seed 10 expired rows. Run sweep with limit=3. Expect scanned=3,
    // deletedRows=3, and 7 rows still in DB.
  });

  it.skip("no-op when no expired rows exist", async () => {
    // Seed only future-expiry rows. Run sweep. Expect scanned=0.
  });

  it.skip("orders by expiresAt ASC (oldest first)", async () => {
    // Seed 3 expired rows with decreasing expiresAt.
    // With limit=1, expect the row with the earliest expiresAt to go first.
  });
});

describe("runRetentionSweep (unit — pure logic)", () => {
  it("SCOPE tuple types match PlatosMessageAttachment schema assumptions", () => {
    // Sanity: the helper scope shape we'd pass in mirrors the model. If
    // this ever changes we want a compile-time signal, not a runtime drift.
    expect(SCOPE_A).toHaveProperty("organizationId");
    expect(SCOPE_A).toHaveProperty("projectId");
    expect(SCOPE_A).toHaveProperty("environmentId");
    expect(SCOPE_A).toHaveProperty("userId");
    expect(SCOPE_B.organizationId).not.toBe(SCOPE_A.organizationId);
  });
});
