import { describe, expect, it, vi } from "vitest";
import { MemoryFeedbackService } from "./memory-feedback.service";

function setup(
  options: {
    persistedRevision?: number;
    currentRatings?: number[];
    confidence?: number | null;
    baseline?: number | null;
    quarantinedAt?: Date | null;
  } = {}
) {
  const updates: any[] = [];
  const tx = {
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          endUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          revision: options.persistedRevision ?? 3,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          sourceTurnIds: [
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
          ],
          confidence: options.confidence ?? 0.5,
          feedbackBaselineConfidence: options.baseline ?? null,
          quarantinedAt: options.quarantinedAt ?? null,
        },
      ]),
    memory: {
      findMany: vi.fn(async () => [
        {
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          sourceTurnIds: [
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
          ],
          confidence: options.confidence ?? 0.5,
          feedbackBaselineConfidence: options.baseline ?? null,
          quarantinedAt: options.quarantinedAt ?? null,
        },
      ]),
      update: vi.fn(async (args: any) => {
        updates.push(args);
        return args;
      }),
    },
    messageRating: {
      findMany: vi.fn(async () => (options.currentRatings ?? [1]).map((rating) => ({ rating }))),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { service: new MemoryFeedbackService(prisma as any), tx, updates };
}

describe("MemoryFeedbackService persisted rating reconciliation", () => {
  it("ignores a superseded rating revision before touching memory", async () => {
    const { service, tx } = setup({ persistedRevision: 4 });
    await expect(
      service.reconcilePersistedRating({
        ratingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expectedRevision: 3,
      })
    ).resolves.toEqual({ status: "stale", updated: 0 });
    expect(tx.memory.findMany).not.toHaveBeenCalled();
  });

  it("quarantines when any current source-turn rating is negative", async () => {
    const { service, updates } = setup({ currentRatings: [1, -1] });
    await expect(
      service.reconcilePersistedRating({
        ratingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expectedRevision: 3,
      })
    ).resolves.toEqual({ status: "applied", updated: 1 });

    expect(updates[0]).toMatchObject({
      where: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      data: {
        feedbackBaselineConfidence: 0.5,
        confidence: 0.5,
      },
    });
    expect(updates[0].data.quarantinedAt).toBeInstanceOf(Date);
    expect(updates[0].data).not.toHaveProperty("metadata");
  });

  it("derives confidence from the aggregate and clears obsolete quarantine", async () => {
    const quarantinedAt = new Date("2026-08-18T00:00:00.000Z");
    const { service, updates } = setup({
      currentRatings: [1, 1],
      confidence: 0.4,
      baseline: 0.5,
      quarantinedAt,
    });
    await service.reconcilePersistedRating({
      ratingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedRevision: 3,
    });
    expect(updates[0].data).toEqual({
      feedbackBaselineConfidence: 0.5,
      confidence: 0.7,
      quarantinedAt: null,
    });
  });

  it("reconciles remaining source-turn ratings from deletion provenance", async () => {
    const { service, tx, updates } = setup({
      currentRatings: [],
      confidence: 0.4,
      baseline: 0.5,
      quarantinedAt: new Date("2026-08-18T00:00:00.000Z"),
    });

    await expect(
      service.reconcilePersistedTurnRatings(
        {
          environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          endUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
        tx
      )
    ).resolves.toEqual({ updated: 1 });
    expect(updates[0].data).toEqual({
      feedbackBaselineConfidence: 0.5,
      confidence: 0.5,
      quarantinedAt: null,
    });
  });
});
