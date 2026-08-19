import { describe, expect, it, vi } from "vitest";
import { RatingService } from "./rating.service";

const ids = {
  rating: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  turn: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agent: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  version: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  endUser: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};

describe("RatingService memory feedback ordering", () => {
  it("increments the persisted revision and schedules reconciliation by row identity", async () => {
    const reconcilePersistedRating = vi.fn(async () => ({ status: "applied", updated: 1 }));
    const prisma = {
      turn: {
        findFirst: vi.fn(async () => ({
          id: ids.turn,
          threadId: ids.thread,
          thread: {
            agentId: ids.agent,
            endUserId: ids.endUser,
            agent: { bindings: [{ activeAgentVersionId: ids.version }] },
          },
        })),
      },
      messageRating: {
        upsert: vi.fn(async () => ({
          id: ids.rating,
          environmentId: "environment",
          turnId: ids.turn,
          agentId: ids.agent,
          agentVersionId: ids.version,
          endUserId: ids.endUser,
          rating: -1,
          revision: 7,
          comment: "latest",
          createdAt: new Date("2026-08-18T00:00:00.000Z"),
          updatedAt: new Date("2026-08-18T00:00:01.000Z"),
        })),
      },
    };
    (prisma as any).$transaction = vi.fn(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
    const service = new RatingService(prisma as any, { reconcilePersistedRating } as any);

    await service.upsert(
      {
        organizationId: "organization",
        projectId: "project",
        environmentId: "environment",
        userId: ids.endUser,
      } as any,
      {
        messageId: ids.turn,
        rating: -1,
        comment: "latest",
      }
    );
    await Promise.resolve();

    expect(prisma.messageRating.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ revision: { increment: 1 } }),
      })
    );
    expect(reconcilePersistedRating).toHaveBeenCalledWith(
      { ratingId: ids.rating, expectedRevision: 7 },
      prisma
    );
    expect(reconcilePersistedRating).not.toHaveBeenCalledWith(
      expect.objectContaining({ rating: -1 })
    );
  });

  it("deletes and reconciles by canonical turn provenance in one transaction", async () => {
    const reconcilePersistedTurnRatings = vi.fn(async () => ({ updated: 1 }));
    const tx = {
      turn: {
        findFirst: vi.fn(async () => ({
          id: ids.turn,
          thread: { endUserId: ids.endUser },
        })),
      },
      messageRating: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new RatingService(prisma as any, { reconcilePersistedTurnRatings } as any);

    await expect(
      service.remove(
        {
          organizationId: "organization",
          projectId: "project",
          environmentId: "environment",
          userId: ids.endUser,
        } as any,
        ids.turn
      )
    ).resolves.toBe(true);

    expect(reconcilePersistedTurnRatings).toHaveBeenCalledWith(
      {
        environmentId: "environment",
        endUserId: ids.endUser,
        turnId: ids.turn,
      },
      tx
    );
  });
});
