import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Prisma, PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { RatingService } from "../evals/rating.service";
import { MemoryFeedbackBackfillService } from "./memory-feedback-backfill.service";
import { MemoryFeedbackService } from "./memory-feedback.service";
import { MemoryService } from "./memory.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const DIMENSIONS = 1_536;
const queryVector = unitVectorValues(1);
const encryptionKey = "11".repeat(32);

type ScopeFixture = Awaited<ReturnType<typeof seedScope>>;

describe("memory feedback PostgreSQL recall semantics", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let memory: MemoryService;
  let feedback: MemoryFeedbackService;
  let backfill: MemoryFeedbackBackfillService;
  let crypto: MessageCryptoService;
  let primary: ScopeFixture;
  let secondary: ScopeFixture;
  let legacy: ScopeFixture;
  let legacyUnderfill: ScopeFixture;
  let priorKey: string | undefined;

  beforeAll(async () => {
    priorKey = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = encryptionKey;
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(process.cwd(), "../../node_modules/.bin/prisma"),
      [
        "migrate",
        "deploy",
        "--schema",
        resolve(process.cwd(), "../../internal-packages/tenancy-database/prisma/schema.prisma"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      }
    );

    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    crypto = new MessageCryptoService();
    memory = new MemoryService(prisma, { embed: async () => queryVector } as any, crypto);
    feedback = new MemoryFeedbackService(prisma);
    backfill = new MemoryFeedbackBackfillService(prisma, crypto);
    primary = await seedScope(prisma, "primary", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    secondary = await seedScope(prisma, "secondary", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    legacy = await seedScope(prisma, "legacy", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    legacyUnderfill = await seedScope(
      prisma,
      "legacy-underfill",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  }, 180_000);

  afterAll(async () => {
    if (priorKey === undefined) delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    else process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = priorKey;
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("transitionally filters plaintext and encrypted legacy flags, then backfills them", async () => {
    const plaintextFlagged = await createMemory(prisma, legacy, {
      kind: "legacy-backfill-test",
      content: "plaintext legacy rejected",
      cosine: 1,
      confidence: 0.5,
      metadata: { flaggedByRating: { comment: "plaintext secret" } },
    });
    const encryptedMetadata = crypto.encryptJsonField({
      flaggedByRating: { comment: "encrypted secret" },
    }) as Prisma.InputJsonValue;
    const encryptedFlagged = await createMemory(prisma, legacy, {
      kind: "legacy-backfill-test",
      content: "encrypted legacy rejected",
      cosine: 0.99,
      confidence: 0.5,
      metadata: encryptedMetadata,
    });
    const safe = await createMemory(prisma, legacy, {
      kind: "legacy-backfill-test",
      content: "safe mixed-corpus row",
      cosine: 0.95,
      confidence: 0.5,
      metadata: crypto.encryptJsonField({ source: "safe" }) as Prisma.InputJsonValue,
    });

    await expect(search(memory, legacy, "legacy-backfill-test", 5)).resolves.toMatchObject([
      { id: safe.id },
    ]);
    const result = await backfill.runBatch(searchScope(legacy), { limit: 500 });
    expect(result).toEqual({
      scanned: 3,
      quarantined: 2,
      alreadyQuarantined: 0,
      decryptUnavailable: 0,
      completed: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /plaintext secret|encrypted secret|ciphertext|metadata/
    );

    const rows = await prisma.memory.findMany({
      where: { id: { in: [plaintextFlagged.id, encryptedFlagged.id, safe.id] } },
      orderBy: { id: "asc" },
    });
    expect(
      rows
        .filter((row) => row.quarantinedAt)
        .map((row) => row.id)
        .sort()
    ).toEqual([plaintextFlagged.id, encryptedFlagged.id].sort());
    expect(rows.find((row) => row.id === encryptedFlagged.id)?.metadata).toEqual(encryptedMetadata);
    await expect(
      prisma.environment.findUniqueOrThrow({ where: { id: legacy.environmentId } })
    ).resolves.toMatchObject({ memoryFeedbackBackfillCompletedAt: expect.any(Date) });
    await expect(search(memory, legacy, "legacy-backfill-test", 5)).resolves.toMatchObject([
      { id: safe.id },
    ]);
  });

  it("fills recall below more than 200 encrypted legacy blocks and fails closed on undecryptable metadata", async () => {
    const encryptedFlag = crypto.encryptJsonField({
      flaggedByRating: { comment: "legacy encrypted rejection" },
    }) as Prisma.InputJsonValue;
    await createMemoryBatch(prisma, legacyUnderfill, {
      kind: "legacy-deep-filter-test",
      count: 205,
      cosine: 0.999,
      confidence: 0.5,
      contentPrefix: "encrypted blocked",
      metadata: encryptedFlag,
    });
    const undecryptable = await createMemory(prisma, legacyUnderfill, {
      kind: "legacy-deep-filter-test",
      content: "undecryptable nearest row",
      cosine: 0.995,
      confidence: 0.5,
      metadata: { __platos_enc: 1, v: 999, ct: "unavailable" },
    });
    await createMemoryBatch(prisma, legacyUnderfill, {
      kind: "legacy-deep-filter-test",
      count: 50,
      cosine: 0.9,
      confidence: 0.5,
      contentPrefix: "approved below legacy window",
      metadata: crypto.encryptJsonField({ source: "safe" }) as Prisma.InputJsonValue,
    });

    const expectedIds = (
      await prisma.memory.findMany({
        where: {
          environmentId: legacyUnderfill.environmentId,
          kind: "legacy-deep-filter-test",
          content: { startsWith: "approved below legacy window" },
        },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map(({ id }) => id);
    const first = await search(memory, legacyUnderfill, "legacy-deep-filter-test", 50);
    const second = await search(memory, legacyUnderfill, "legacy-deep-filter-test", 50);

    expect(first).toHaveLength(50);
    expect(first.map(({ id }) => id)).toEqual(expectedIds);
    expect(second.map(({ id }) => id)).toEqual(expectedIds);
    expect(first.every(({ content, score }) =>
      content.startsWith("approved below legacy window") && Math.abs(score - 0.9) < 0.00001
    )).toBe(true);
    expect(first.some(({ id }) => id === undecryptable.id)).toBe(false);
    await expect(
      prisma.environment.findUniqueOrThrow({ where: { id: legacyUnderfill.environmentId } }),
    ).resolves.toMatchObject({ memoryFeedbackBackfillCompletedAt: null });
  });

  it("excludes authoritative thumbs-down quarantine without rewriting encrypted metadata", async () => {
    const encryptedMetadata = crypto.encryptJsonField({
      source: "opaque",
    }) as Prisma.InputJsonValue;
    const rejected = await createMemory(prisma, primary, {
      kind: "quarantine-test",
      content: "rejected exact match",
      cosine: 1,
      confidence: 1,
      sourceTurnIds: [primary.turnIds.negative],
      metadata: encryptedMetadata,
    });
    const safe = await createMemory(prisma, primary, {
      kind: "quarantine-test",
      content: "safe nearby match",
      cosine: 0.95,
      confidence: 0.5,
    });
    const rating = await persistRating(prisma, primary, primary.turnIds.negative, -1);

    await expect(
      feedback.reconcilePersistedRating({
        ratingId: rating.id,
        expectedRevision: rating.revision,
      })
    ).resolves.toEqual({ status: "applied", updated: 1 });

    const stored = await prisma.memory.findUniqueOrThrow({ where: { id: rejected.id } });
    expect(stored.quarantinedAt).toBeInstanceOf(Date);
    expect(stored.metadata).toEqual(encryptedMetadata);
    expect((await search(memory, primary, "quarantine-test", 5)).map(({ id }) => id)).toEqual([
      safe.id,
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'Memory_environmentId_endUserId_quarantinedAt_idx'
    `;
    expect(indexes).toEqual([{ indexname: "Memory_environmentId_endUserId_quarantinedAt_idx" }]);
  });

  it("overfetches cosine candidates so current positive feedback changes final rank", async () => {
    const closest = await createMemory(prisma, primary, {
      kind: "positive-rerank-test",
      content: "closest neutral memory",
      cosine: 1,
      confidence: 0.5,
    });
    const boosted = await createMemory(prisma, primary, {
      kind: "positive-rerank-test",
      content: "slightly less similar confirmed memory",
      cosine: 0.99,
      confidence: 0.5,
      sourceTurnIds: [primary.turnIds.positive],
    });

    await expect(search(memory, primary, "positive-rerank-test", 1)).resolves.toMatchObject([
      { id: closest.id },
    ]);
    const rating = await persistRating(prisma, primary, primary.turnIds.positive, 1);
    await feedback.reconcilePersistedRating({
      ratingId: rating.id,
      expectedRevision: rating.revision,
    });

    await expect(search(memory, primary, "positive-rerank-test", 1)).resolves.toMatchObject([
      { id: boosted.id },
    ]);
    await expect(
      prisma.memory.findUniqueOrThrow({ where: { id: boosted.id } })
    ).resolves.toMatchObject({
      confidence: 0.6,
      feedbackBaselineConfidence: 0.5,
      quarantinedAt: null,
    });
  });

  it("uses memory ID as the stable tie-break before applying the limit", async () => {
    const lowerId = "00000000-0000-4000-8000-000000000001";
    const higherId = "00000000-0000-4000-8000-000000000002";
    await createMemory(prisma, primary, {
      id: higherId,
      kind: "stable-tie-test",
      content: "second stable tie",
      cosine: 0.8,
      confidence: 0.7,
    });
    await createMemory(prisma, primary, {
      id: lowerId,
      kind: "stable-tie-test",
      content: "first stable tie",
      cosine: 0.8,
      confidence: 0.7,
    });

    expect((await search(memory, primary, "stable-tie-test", 2)).map(({ id }) => id)).toEqual([
      lowerId,
      higherId,
    ]);
    expect((await search(memory, primary, "stable-tie-test", 2)).map(({ id }) => id)).toEqual([
      lowerId,
      higherId,
    ]);
  });

  it("does not recall or mutate memories outside the rating row's canonical scope", async () => {
    const outside = await createMemory(prisma, secondary, {
      kind: "cross-scope-test",
      content: "outside exact match",
      cosine: 1,
      confidence: 0.4,
      sourceTurnIds: [secondary.turnIds.negative],
    });
    const primaryUnrelated = await createMemory(prisma, primary, {
      kind: "cross-scope-test",
      content: "primary unrelated",
      cosine: 0.9,
      confidence: 0.4,
    });
    const rating = await persistRating(prisma, secondary, secondary.turnIds.negative, -1);

    await feedback.reconcilePersistedRating({
      ratingId: rating.id,
      expectedRevision: rating.revision,
    });
    await expect(
      prisma.memory.findUniqueOrThrow({ where: { id: outside.id } })
    ).resolves.toMatchObject({ confidence: 0.3, quarantinedAt: expect.any(Date) });
    await expect(
      prisma.memory.findUniqueOrThrow({ where: { id: primaryUnrelated.id } })
    ).resolves.toMatchObject({ confidence: 0.4, quarantinedAt: null });
    await expect(search(memory, secondary, "cross-scope-test", 5)).resolves.toEqual([]);
    await expect(search(memory, primary, "cross-scope-test", 5)).resolves.toMatchObject([
      { id: primaryUnrelated.id },
    ]);
  });

  it("resolves rapid +1 then -1 and -1 then +1 by persisted revision", async () => {
    const plusThenMinusTurn = await createTurn(prisma, primary);
    const plusThenMinus = await createMemory(prisma, primary, {
      kind: "rapid-plus-minus",
      content: "rapid plus then minus",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [plusThenMinusTurn],
    });
    const oldPositive = await persistRating(prisma, primary, plusThenMinusTurn, 1);
    const currentNegative = await persistRating(prisma, primary, plusThenMinusTurn, -1);
    await Promise.all([
      feedback.reconcilePersistedRating({
        ratingId: oldPositive.id,
        expectedRevision: oldPositive.revision,
      }),
      feedback.reconcilePersistedRating({
        ratingId: currentNegative.id,
        expectedRevision: currentNegative.revision,
      }),
    ]);
    await expect(
      prisma.memory.findUniqueOrThrow({ where: { id: plusThenMinus.id } })
    ).resolves.toMatchObject({ confidence: 0.4, quarantinedAt: expect.any(Date) });

    const minusThenPlusTurn = await createTurn(prisma, primary);
    const minusThenPlus = await createMemory(prisma, primary, {
      kind: "rapid-minus-plus",
      content: "rapid minus then plus",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [minusThenPlusTurn],
    });
    const oldNegative = await persistRating(prisma, primary, minusThenPlusTurn, -1);
    const currentPositive = await persistRating(prisma, primary, minusThenPlusTurn, 1);
    await Promise.all([
      feedback.reconcilePersistedRating({
        ratingId: currentPositive.id,
        expectedRevision: currentPositive.revision,
      }),
      feedback.reconcilePersistedRating({
        ratingId: oldNegative.id,
        expectedRevision: oldNegative.revision,
      }),
    ]);
    await expect(
      prisma.memory.findUniqueOrThrow({ where: { id: minusThenPlus.id } })
    ).resolves.toMatchObject({ confidence: 0.6, quarantinedAt: null });
  });

  it("commits the persisted rating revision and memory aggregate atomically", async () => {
    const turnId = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "transactional-rating-test",
      content: "transactional rating",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [turnId],
    });
    const ratingService = new RatingService(prisma, feedback);

    await ratingService.upsert(
      {
        organizationId: primary.organizationId,
        projectId: primary.projectId,
        environmentId: primary.environmentId,
        userId: primary.externalUserId,
      } as any,
      {
        messageId: turnId,
        rating: -1,
      }
    );

    await expect(
      prisma.messageRating.findUniqueOrThrow({
        where: { turnId_endUserId: { turnId, endUserId: primary.endUserId } },
      })
    ).resolves.toMatchObject({ rating: -1, revision: 1 });
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { confidence: 0.4, quarantinedAt: expect.any(Date) }
    );
  });

  it("deletes a negative rating and restores its memory aggregate atomically", async () => {
    const turnId = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "delete-negative-rating",
      content: "delete negative rating",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [turnId],
    });
    const ratingService = new RatingService(prisma, feedback);
    const scope = ratingScope(primary);

    await ratingService.upsert(scope, { messageId: turnId, rating: -1 });
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { confidence: 0.4, quarantinedAt: expect.any(Date) }
    );

    await expect(ratingService.remove(scope, turnId)).resolves.toBe(true);
    await expect(
      prisma.messageRating.findUnique({
        where: { turnId_endUserId: { turnId, endUserId: primary.endUserId } },
      })
    ).resolves.toBeNull();
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { feedbackBaselineConfidence: 0.5, confidence: 0.5, quarantinedAt: null }
    );
  });

  it("deletes a positive rating and restores its memory aggregate atomically", async () => {
    const turnId = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "delete-positive-rating",
      content: "delete positive rating",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [turnId],
    });
    const ratingService = new RatingService(prisma, feedback);
    const scope = ratingScope(primary);

    await ratingService.upsert(scope, { messageId: turnId, rating: 1 });
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { confidence: 0.6, quarantinedAt: null }
    );

    await expect(ratingService.remove(scope, turnId)).resolves.toBe(true);
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { feedbackBaselineConfidence: 0.5, confidence: 0.5, quarantinedAt: null }
    );
  });

  it("reconciles conflicting source ratings after deleting the negative source", async () => {
    const positiveTurn = await createTurn(prisma, primary);
    const negativeTurn = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "delete-conflicting-source-rating",
      content: "delete conflicting source rating",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [positiveTurn, negativeTurn],
    });
    const ratingService = new RatingService(prisma, feedback);
    const scope = ratingScope(primary);

    await ratingService.upsert(scope, { messageId: positiveTurn, rating: 1 });
    await ratingService.upsert(scope, { messageId: negativeTurn, rating: -1 });
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { confidence: 0.5, quarantinedAt: expect.any(Date) }
    );

    await expect(ratingService.remove(scope, negativeTurn)).resolves.toBe(true);
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { feedbackBaselineConfidence: 0.5, confidence: 0.6, quarantinedAt: null }
    );
  });

  it("rolls back rating deletion when memory reconciliation fails", async () => {
    const turnId = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "delete-rating-rollback",
      content: "delete rating rollback",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [turnId],
    });
    const scope = ratingScope(primary);
    await new RatingService(prisma, feedback).upsert(scope, { messageId: turnId, rating: -1 });
    const failingFeedback = {
      reconcilePersistedTurnRatings: vi.fn(async () => {
        throw new Error("forced reconciliation failure");
      }),
    };
    const ratingService = new RatingService(prisma, failingFeedback as any);

    await expect(ratingService.remove(scope, turnId)).rejects.toThrow(
      "forced reconciliation failure"
    );
    await expect(
      prisma.messageRating.findUniqueOrThrow({
        where: { turnId_endUserId: { turnId, endUserId: primary.endUserId } },
      })
    ).resolves.toMatchObject({ rating: -1 });
    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      { confidence: 0.4, quarantinedAt: expect.any(Date) }
    );
  });

  it("serializes concurrent rating updates and applies only the persisted winner", async () => {
    const turnId = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "concurrent-rating-test",
      content: "concurrent rating winner",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [turnId],
    });
    await persistRating(prisma, primary, turnId, 1);
    const updates = await Promise.all([
      persistRating(prisma, primary, turnId, -1),
      persistRating(prisma, primary, turnId, 1),
    ]);
    await Promise.all(
      updates.map((update) =>
        feedback.reconcilePersistedRating({
          ratingId: update.id,
          expectedRevision: update.revision,
        })
      )
    );

    const authoritative = await prisma.messageRating.findUniqueOrThrow({
      where: { turnId_endUserId: { turnId, endUserId: primary.endUserId } },
    });
    const stored = await prisma.memory.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.confidence).toBe(authoritative.rating === 1 ? 0.6 : 0.4);
    expect(!!stored.quarantinedAt).toBe(authoritative.rating === -1);
  });

  it("quarantines conflicting source turns if any current rating is negative", async () => {
    const positiveTurn = await createTurn(prisma, primary);
    const negativeTurn = await createTurn(prisma, primary);
    const row = await createMemory(prisma, primary, {
      kind: "conflicting-source-ratings",
      content: "conflicting source ratings",
      cosine: 1,
      confidence: 0.5,
      sourceTurnIds: [positiveTurn, negativeTurn],
    });
    const [positive, negative] = await Promise.all([
      persistRating(prisma, primary, positiveTurn, 1),
      persistRating(prisma, primary, negativeTurn, -1),
    ]);
    await Promise.all([
      feedback.reconcilePersistedRating({
        ratingId: negative.id,
        expectedRevision: negative.revision,
      }),
      feedback.reconcilePersistedRating({
        ratingId: positive.id,
        expectedRevision: positive.revision,
      }),
    ]);

    await expect(prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject(
      {
        feedbackBaselineConfidence: 0.5,
        confidence: 0.5,
        quarantinedAt: expect.any(Date),
      }
    );
  });
});

async function seedScope(prisma: PrismaClient, slug: string, subject: string) {
  const organization = await prisma.organization.create({
    data: { slug: `feedback-${slug}`, name: `Feedback ${slug}` },
  });
  const project = await prisma.project.create({
    data: { organizationId: organization.id, slug: `feedback-${slug}`, name: `Feedback ${slug}` },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, slug: "development", name: "Development" },
  });
  const agent = await prisma.agent.create({
    data: { projectId: project.id, slug: `feedback-${slug}`, name: `Feedback ${slug}` },
  });
  const agentVersion = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      model: "fixture:model",
      createdBy: "memory-feedback-test",
    },
  });
  await prisma.agentBinding.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      activeAgentVersionId: agentVersion.id,
    },
  });
  const endUser = await prisma.endUser.create({
    data: { organizationId: organization.id, displayName: `Feedback ${slug} subject` },
  });
  await prisma.endUserIdentity.create({
    data: {
      endUserId: endUser.id,
      organizationId: organization.id,
      issuer: "platos",
      channel: "session",
      subject,
      verifiedAt: new Date(),
    },
  });
  const thread = await prisma.thread.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      endUserId: endUser.id,
      title: `Feedback ${slug}`,
    },
  });
  const [positiveTurn, negativeTurn] = await Promise.all([
    prisma.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: agentVersion.id,
        versionBucket: "CURRENT",
        sequence: 1,
        status: "SUCCEEDED",
      },
    }),
    prisma.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: agentVersion.id,
        versionBucket: "CURRENT",
        sequence: 2,
        status: "SUCCEEDED",
      },
    }),
  ]);
  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    agentId: agent.id,
    agentVersionId: agentVersion.id,
    endUserId: endUser.id,
    externalUserId: subject,
    threadId: thread.id,
    turnIds: { positive: positiveTurn.id, negative: negativeTurn.id },
  };
}

async function createTurn(prisma: PrismaClient, fixture: ScopeFixture): Promise<string> {
  const aggregate = await prisma.turn.aggregate({
    where: { threadId: fixture.threadId },
    _max: { sequence: true },
  });
  const turn = await prisma.turn.create({
    data: {
      threadId: fixture.threadId,
      agentVersionId: fixture.agentVersionId,
      versionBucket: "CURRENT",
      sequence: (aggregate._max.sequence ?? 0) + 1,
      status: "SUCCEEDED",
    },
  });
  return turn.id;
}

async function persistRating(
  prisma: PrismaClient,
  fixture: ScopeFixture,
  turnId: string,
  rating: 1 | -1
) {
  return prisma.messageRating.upsert({
    where: { turnId_endUserId: { turnId, endUserId: fixture.endUserId } },
    update: { rating, revision: { increment: 1 } },
    create: {
      environmentId: fixture.environmentId,
      turnId,
      agentId: fixture.agentId,
      agentVersionId: fixture.agentVersionId,
      endUserId: fixture.endUserId,
      rating,
    },
  });
}

async function createMemoryBatch(
  prisma: PrismaClient,
  fixture: ScopeFixture,
  input: {
    kind: string;
    count: number;
    cosine: number;
    confidence: number;
    contentPrefix: string;
    metadata: Prisma.InputJsonValue;
  },
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Memory" (
       "id", "environmentId", "endUserId", "agentId", "kind", "content",
       "visibility", "source", "confidence", "metadata", "embedding",
       "createdAt", "updatedAt"
     )
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4,
            concat($5::text, ' ', series), 'agent_visible', 'extracted', $6,
            $7::jsonb, $8::vector, NOW(), NOW()
     FROM generate_series(1, $9::integer) AS series`,
    fixture.environmentId,
    fixture.endUserId,
    fixture.agentId,
    input.kind,
    input.contentPrefix,
    input.confidence,
    JSON.stringify(input.metadata),
    unitVector(input.cosine),
    input.count,
  );
}

async function createMemory(
  prisma: PrismaClient,
  fixture: ScopeFixture,
  input: {
    id?: string;
    kind: string;
    content: string;
    cosine: number;
    confidence: number;
    sourceTurnIds?: string[];
    metadata?: Prisma.InputJsonValue;
  }
) {
  const sourceTurnIds = input.sourceTurnIds ?? [];
  const provenance = sourceTurnIds.length
    ? {
        sourceThreadId: fixture.threadId,
        sourceTurnIds,
        extractorVersion: "memory-feedback-test-v1",
        contentHash: createHash("sha256").update(input.content).digest("hex"),
      }
    : {};
  const row = await prisma.memory.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      environmentId: fixture.environmentId,
      endUserId: fixture.endUserId,
      agentId: fixture.agentId,
      kind: input.kind,
      content: input.content,
      visibility: "agent_visible",
      source: "extracted",
      confidence: input.confidence,
      metadata: input.metadata,
      ...provenance,
    },
  });
  await prisma.$executeRawUnsafe(
    'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2::uuid',
    unitVector(input.cosine),
    row.id
  );
  return row;
}

function search(memory: MemoryService, fixture: ScopeFixture, kind: string, limit: number) {
  return memory.semanticSearch(searchScope(fixture), {
    query: "query",
    userId: fixture.externalUserId,
    kind,
    limit,
  });
}

function searchScope(fixture: ScopeFixture) {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    agentId: fixture.agentId,
  };
}

function ratingScope(fixture: ScopeFixture) {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    userId: fixture.externalUserId,
  } as any;
}

function unitVector(cosine: number): string {
  return `[${unitVectorValues(cosine).join(",")}]`;
}

function unitVectorValues(cosine: number): number[] {
  const values = Array<number>(DIMENSIONS).fill(0);
  values[0] = cosine;
  values[1] = Math.sqrt(Math.max(0, 1 - cosine ** 2));
  return values;
}
