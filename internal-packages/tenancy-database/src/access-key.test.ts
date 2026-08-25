import { describe, expect, it, vi } from "vitest";
import { rotateAccessKey } from "./access-key";

function safe(row: Record<string, any>) {
  const { keyHash: _keyHash, ...metadata } = row;
  return { ...metadata };
}

describe("rotateAccessKey replay", () => {
  it("returns the same correlated active and retiring metadata for a repeated hash", async () => {
    const rows: Array<Record<string, any>> = [{
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
    }];
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]),
      accessKey: {
        findFirst: vi.fn(async ({ where }: any) => {
          const row = rows.find((candidate) =>
            candidate.environmentId === where.environmentId &&
            candidate.revokedAt === null &&
            (where.keyHash === undefined || candidate.keyHash === where.keyHash) &&
            (where.validUntil === undefined || candidate.validUntil === where.validUntil) &&
            (where.replacedById === undefined || candidate.replacedById === where.replacedById),
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
});
