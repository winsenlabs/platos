import { describe, expect, it, vi } from "vitest";
import { MemoryProfileBackfillService } from "./memory-profile-backfill.service";

const encrypted = { __platos_enc: 1, v: 1, ct: "ciphertext" };

function harness(decryptUnavailable = false) {
  const rows = [
    {
      id: "00000000-0000-4000-8000-000000000002",
      environmentId: "10000000-0000-4000-8000-000000000000",
      endUserId: "20000000-0000-4000-8000-000000000000",
      agentId: "30000000-0000-4000-8000-000000000000",
      clusterId: null,
      metadata: encrypted,
      updatedAt: new Date("2026-08-24T12:00:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000001",
      environmentId: "10000000-0000-4000-8000-000000000000",
      endUserId: "20000000-0000-4000-8000-000000000000",
      agentId: "30000000-0000-4000-8000-000000000000",
      clusterId: null,
      metadata: { profileKey: " Preferred Name " },
      updatedAt: new Date("2026-08-23T12:00:00.000Z"),
    },
  ];
  const tx = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes("FROM \"Memory\"") && sql.includes("FOR UPDATE")) return rows;
      if (sql.includes("count(*)")) return [{ count: 0 }];
      if (sql.includes("FROM pg_index")) return [
        {
          name: "Memory_profile_cluster_key",
          unique: true,
          valid: true,
          columns: ["environmentId", "endUserId", "clusterId", "profileKey"],
          predicate: `((kind = 'profile'::text) AND ("clusterId" IS NOT NULL) AND ("profileKey" IS NOT NULL))`,
        },
        {
          name: "Memory_profile_standalone_key",
          unique: true,
          valid: true,
          columns: ["environmentId", "endUserId", "agentId", "profileKey"],
          predicate: `((kind = 'profile'::text) AND ("clusterId" IS NULL) AND ("profileKey" IS NOT NULL))`,
        },
      ];
      return [];
    }),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const crypto = {
    decryptJsonField: vi.fn((value: unknown) =>
      value === encrypted
        ? decryptUnavailable ? encrypted : { profileKey: "preferred name" }
        : value),
  };
  return {
    service: new MemoryProfileBackfillService(prisma as any, crypto as any),
    prisma,
    tx,
  };
}

describe("MemoryProfileBackfillService", () => {
  it("decrypts, deterministically deduplicates, remaps, verifies, then creates uniqueness", async () => {
    const h = harness();

    await expect(h.service.run()).resolves.toEqual({ profiles: 2, deduplicated: 1 });

    expect(h.tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("pg_advisory_xact_lock"),
    );
    expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
    );
    expect(h.tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE "MemoryRelationship"'),
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(h.tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "Memory" SET "profileKey"'),
      "preferred name",
      "00000000-0000-4000-8000-000000000002",
    );
    const calls = h.tx.$executeRawUnsafe.mock.calls.map(([sql]) => String(sql));
    expect(calls.findIndex((sql) => sql.includes("Memory_profile_standalone_key")))
      .toBeGreaterThan(calls.findIndex((sql) => sql.includes('UPDATE "Memory" SET "profileKey"')));
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 120_000,
    });
  });

  it("fails closed without installing indexes when encrypted metadata cannot be decrypted", async () => {
    const h = harness(true);

    await expect(h.service.run()).rejects.toMatchObject({
      code: "MEMORY_PROFILE_BACKFILL_DECRYPT_UNAVAILABLE",
    });
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining("Memory_profile_standalone_key"),
    );
  });
});
