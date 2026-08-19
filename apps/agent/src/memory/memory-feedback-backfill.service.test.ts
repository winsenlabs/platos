import { describe, expect, it, vi } from "vitest";
import { MemoryFeedbackBackfillService } from "./memory-feedback-backfill.service";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
};

function encrypted(ct: string) {
  return { __platos_enc: 1, v: 1, ct };
}

describe("MemoryFeedbackBackfillService", () => {
  it("backfills plaintext, encrypted, and mixed legacy rows with secret-safe counts", async () => {
    const environmentUpdates: any[] = [];
    const memoryUpdates: any[] = [];
    const rows = [
      { id: "1", metadata: { flaggedByRating: { comment: "plain secret" } }, quarantinedAt: null },
      { id: "2", metadata: encrypted("encrypted-secret-flag"), quarantinedAt: null },
      { id: "3", metadata: encrypted("encrypted-safe"), quarantinedAt: null },
      { id: "4", metadata: { source: "plain-safe" }, quarantinedAt: null },
    ];
    const prisma = {
      environment: {
        findFirst: vi.fn(async (args: any) =>
          args.select?.memoryFeedbackBackfillCursor
            ? { memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null }
            : { id: "environment" }
        ),
        updateMany: vi.fn(async (args: any) => {
          environmentUpdates.push(args);
          return { count: 1 };
        }),
      },
      memory: {
        findMany: vi.fn(async () => rows),
        updateMany: vi.fn(async (args: any) => {
          memoryUpdates.push(args);
          return { count: args.where.id.in.length };
        }),
      },
    };
    const crypto = {
      decryptJsonField: vi.fn((value: any) => {
        if (value?.ct === "encrypted-secret-flag") {
          return { flaggedByRating: { comment: "encrypted secret" } };
        }
        if (value?.ct === "encrypted-safe") return { source: "encrypted-safe" };
        return value;
      }),
    };

    const result = await new MemoryFeedbackBackfillService(prisma as any, crypto as any).runBatch(
      scope,
      { limit: 10 }
    );

    expect(result).toEqual({
      scanned: 4,
      quarantined: 2,
      alreadyQuarantined: 0,
      decryptUnavailable: 0,
      completed: true,
    });
    expect(memoryUpdates[0].where.id.in).toEqual(["1", "2"]);
    expect(environmentUpdates[0].data.memoryFeedbackBackfillCompletedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(result)).not.toMatch(
      /plain secret|encrypted secret|encrypted-secret-flag/
    );
  });

  it("does not advance or complete past an undecryptable envelope", async () => {
    const environmentUpdateMany = vi.fn();
    const prisma = {
      environment: {
        findFirst: vi.fn(async (args: any) =>
          args.select?.memoryFeedbackBackfillCursor
            ? { memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null }
            : { id: "environment" }
        ),
        updateMany: environmentUpdateMany,
      },
      memory: {
        findMany: vi.fn(async () => [
          { id: "1", metadata: encrypted("missing-key"), quarantinedAt: null },
        ]),
        updateMany: vi.fn(),
      },
    };
    const crypto = { decryptJsonField: vi.fn((value: unknown) => value) };

    await expect(
      new MemoryFeedbackBackfillService(prisma as any, crypto as any).runBatch(scope, { limit: 10 })
    ).resolves.toEqual({
      scanned: 1,
      quarantined: 0,
      alreadyQuarantined: 0,
      decryptUnavailable: 1,
      completed: false,
    });
    expect(environmentUpdateMany).not.toHaveBeenCalled();
  });

  it("bounds an operator-supplied batch limit", async () => {
    const memoryFindMany = vi.fn(async () => []);
    const prisma = {
      environment: {
        findFirst: vi.fn(async (args: any) =>
          args.select?.memoryFeedbackBackfillCursor
            ? { memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null }
            : { id: "environment" }
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      memory: { findMany: memoryFindMany },
    };

    await new MemoryFeedbackBackfillService(prisma as any).runBatch(scope, { limit: 50_000 });
    expect(memoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
  });
});
