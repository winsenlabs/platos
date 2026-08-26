import { describe, expect, it, vi } from "vitest";
import {
  MemoryProfileStartupVerifierService,
  validProfileIndexes,
} from "./memory-profile-startup-verifier.service";

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

function harness(rows: unknown = exactIndexes) {
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue(rows),
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return {
    service: new MemoryProfileStartupVerifierService(prisma as any),
    prisma,
    tx,
  };
}

describe("MemoryProfileStartupVerifierService", () => {
  it("performs only bounded, read-only exact catalog verification", async () => {
    const h = harness();

    await expect(h.service.verify()).resolves.toBeUndefined();

    expect(h.tx.$executeRawUnsafe).toHaveBeenNthCalledWith(1, "SET TRANSACTION READ ONLY");
    expect(h.tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      "SET LOCAL statement_timeout = '5000ms'",
    );
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledOnce();
    const sql = String(h.tx.$queryRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM pg_index");
    expect(sql).toContain("attribute.attname::text");
    expect(sql).not.toContain('FROM "Memory"');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|CREATE|ALTER)\b/);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 6_000 });
  });

  it.each([
    ["predicate", exactIndexes.map((row, index) => index === 0 ? { ...row, predicate: row.predicate.replace("IS NOT NULL", "IS NULL") } : row)],
    ["column order", exactIndexes.map((row, index) => index === 0 ? { ...row, columns: [...row.columns].reverse() } : row)],
    ["included column", exactIndexes.map((row, index) => index === 0 ? { ...row, totalColumns: 5 } : row)],
    ["profileKey type", exactIndexes.map((row, index) => index === 0 ? { ...row, profileKeyType: "character varying" } : row)],
    ["operator class namespace", exactIndexes.map((row, index) => index === 0 ? { ...row, operatorClasses: ["pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "pg_catalog.uuid_ops", "public.text_ops"] } : row)],
    ["collation identity", exactIndexes.map((row, index) => index === 0 ? { ...row, indexCollations: ["0", "0", "0", "101"] } : row)],
    ["readiness", exactIndexes.map((row, index) => index === 0 ? { ...row, ready: false } : row)],
  ])("fails closed when the exact %s contract changes", async (_label, rows) => {
    const h = harness(rows);

    await expect(h.service.verify()).rejects.toMatchObject({
      code: "MEMORY_PROFILE_STARTUP_CONTRACT_INCOMPLETE",
    });
  });

  it("maps catalog access failures to a stable startup error", async () => {
    const h = harness();
    h.tx.$queryRawUnsafe.mockRejectedValueOnce(new Error("database detail must not escape"));

    await expect(h.service.verify()).rejects.toMatchObject({
      code: "MEMORY_PROFILE_STARTUP_VERIFICATION_FAILED",
      message: "Memory profile catalog verification failed; the Agent will not start",
    });
  });
});

describe("validProfileIndexes", () => {
  it("requires both exact partial indexes", () => {
    expect(validProfileIndexes(exactIndexes)).toBe(true);
    expect(validProfileIndexes(exactIndexes.slice(1))).toBe(false);
  });
});
