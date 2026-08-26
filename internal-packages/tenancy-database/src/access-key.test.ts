import { describe, expect, it, vi } from "vitest";
import { revokeAccessKeys, rotateAccessKey, setAccessKeyAllowedOrigins } from "./access-key";

function safe(row: Record<string, any>) {
  const { keyHash: _keyHash, ...metadata } = row;
  return { ...metadata };
}

describe("rotateAccessKey replay", () => {
  it("returns the same correlated active and retiring metadata for a repeated hash", async () => {
    const rows: Array<Record<string, any>> = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        keyHash: "a".repeat(64),
        keyPrefix: "platos_live_old",
        allowedOrigins: ["https://app.example"],
        lastUsedAt: null,
        validUntil: null,
        replacedById: null,
        revokedAt: null,
        createdAt: new Date("2026-08-25T00:00:00.000Z"),
        updatedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ];
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          accessKeyRevocationVersion: 0,
        },
      ]),
      accessKey: {
        findFirst: vi.fn(async ({ where }: any) => {
          const row = rows.find(
            (candidate) =>
              candidate.environmentId === where.environmentId &&
              candidate.revokedAt === null &&
              (where.keyHash === undefined || candidate.keyHash === where.keyHash) &&
              (where.validUntil === undefined || candidate.validUntil === where.validUntil) &&
              (where.replacedById === undefined || candidate.replacedById === where.replacedById)
          );
          return row ? safe(row) : null;
        }),
        create: vi.fn(async ({ data, select }: any) => {
          const row = {
            id: data.id ?? "22222222-2222-4222-8222-222222222222",
            environmentId: data.environmentId,
            keyHash: data.keyHash,
            keyPrefix: data.keyPrefix,
            allowedOrigins: data.allowedOrigins ?? [],
            lastUsedAt: null,
            validUntil: data.validUntil ?? null,
            replacedById: null,
            revokedAt: null,
            createdAt: new Date("2026-08-25T00:01:00.000Z"),
            updatedAt: new Date("2026-08-25T00:01:00.000Z"),
          };
          rows.push(row);
          return select ? safe(row) : row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id)!;
          Object.assign(row, data, { updatedAt: new Date("2026-08-25T00:02:00.000Z") });
          return safe(row);
        }),
      },
    };
    const database = {
      environment: {
        findUnique: vi.fn(async () => ({ accessKeyRevocationVersion: 0 })),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const input = {
      environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      keyHash: "b".repeat(64),
      keyPrefix: "platos_live_new",
      overlapMs: 60_000,
    };

    const first = await rotateAccessKey(database as any, input);
    const replay = await rotateAccessKey(database as any, input);

    expect(rows).toHaveLength(2);
    expect(replay).toEqual(first);
    expect(replay.key.keyPrefix).toBe("platos_live_new");
    expect(replay.retiringKey).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      replacedById: replay.key.id,
    });
    expect(JSON.stringify(replay)).not.toContain(input.keyHash);
  });

  it("fails closed when revocation advances while rotation waits for the Environment lock", async () => {
    const findFirst = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          accessKeyRevocationVersion: 8,
        },
      ]),
      accessKey: { findFirst },
    };
    const database = {
      environment: {
        findUnique: vi.fn(async () => ({ accessKeyRevocationVersion: 7 })),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };

    await expect(
      rotateAccessKey(database as any, {
        environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        keyHash: "c".repeat(64),
        keyPrefix: "platos_live_fenced",
      })
    ).rejects.toThrow("access_key_rotation_superseded");
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("AccessKey serialized mutations", () => {
  function databaseFixture() {
    let accessKeyRevocationVersion = 3;
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          accessKeyRevocationVersion,
        },
      ]),
      environment: {
        update: vi.fn(async () => ({
          accessKeyRevocationVersion: ++accessKeyRevocationVersion,
        })),
      },
      accessKey: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    return {
      tx,
      database: {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
    };
  }

  it("updates origins only after acquiring the shared Environment lock", async () => {
    const { database, tx } = databaseFixture();
    await expect(
      setAccessKeyAllowedOrigins(database as any, {
        environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        origins: ["https://app.example"],
      })
    ).resolves.toBe(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.accessKey.updateMany).toHaveBeenCalledWith({
      where: {
        environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revokedAt: null,
        validUntil: null,
      },
      data: { allowedOrigins: ["https://app.example"] },
    });
  });

  it("increments the revocation fence before revoking every live key", async () => {
    const { database, tx } = databaseFixture();
    await expect(
      revokeAccessKeys(database as any, {
        environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })
    ).resolves.toBe(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.environment.update).toHaveBeenCalledWith({
      where: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      data: { accessKeyRevocationVersion: { increment: 1 } },
    });
    expect(tx.environment.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.accessKey.updateMany.mock.invocationCallOrder[0]!
    );
  });
});
