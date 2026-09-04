import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { MemoryId, TurnId } from "../domain/index.js";
import { reconcileFromRating, reconcileFromTurn } from "./reconcile-feedback.js";
import {
  ENVIRONMENT_SCOPE,
  harness,
  memoryFixture,
  runtimeGrant,
  SUBJECT_ID,
  THREAD,
  type MemoryHarness,
} from "./testing/fixtures.js";

const TURN = asIdentifier<TurnId>("turn-1");
const OTHER_TURN = asIdentifier<TurnId>("turn-2");

function seedMemory(
  context: MemoryHarness,
  id: string,
  turnIds: readonly TurnId[],
  overrides: Parameters<typeof memoryFixture>[0] = {},
): void {
  context.repository.seed(
    memoryFixture({
      memoryId: asIdentifier<MemoryId>(id),
      provenance: {
        sourceThreadId: THREAD,
        sourceTurnIds: turnIds,
        extractorVersion: "v1",
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
      confidence: { confidence: 0.5, feedbackBaselineConfidence: null },
      ...overrides,
    }),
  );
}

function seedRating(
  context: MemoryHarness,
  ratingId: string,
  turnId: TurnId,
  rating: number,
  revision = 1,
): void {
  context.repository.seedRating({
    ratingId,
    environment: ENVIRONMENT_SCOPE,
    endUserId: SUBJECT_ID,
    turnId,
    revision,
    rating,
  });
}

const RATING_COMMAND = { authorization: runtimeGrant(), ratingId: "rating-1", expectedRevision: 1 };

describe("reconcileFromRating", () => {
  it("raises confidence on a positive rating and captures the baseline", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    seedRating(context, "rating-1", TURN, 1);
    const report = await reconcileFromRating(context.dependencies, RATING_COMMAND);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.standing).toBe("applied");
    expect(report.value.updated).toBe(1);

    const stored = context.repository.all()[0];
    expect(stored?.confidence.confidence).toBeCloseTo(0.6, 10);
    expect(stored?.confidence.feedbackBaselineConfidence).toBe(0.5);
  });

  it("QUARANTINES on a negative rating", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    seedRating(context, "rating-1", TURN, -1);
    const report = await reconcileFromRating(context.dependencies, RATING_COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.quarantined).toBe(1);
    expect(context.repository.all()[0]?.lifecycle.quarantinedAt).not.toBeNull();
  });

  it("aggregates EVERY source turn of the memory, not only the one that changed", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN, OTHER_TURN]);
    seedRating(context, "rating-1", TURN, 1);
    seedRating(context, "rating-2", OTHER_TURN, -1);
    const report = await reconcileFromRating(context.dependencies, RATING_COMMAND);
    if (!report.ok) throw new Error("unreachable");
    // +1 and -1 cancel; the negative still withdraws the memory.
    expect(context.repository.all()[0]?.confidence.confidence).toBeCloseTo(0.5, 10);
    expect(report.value.quarantined).toBe(1);
  });

  it("is IDEMPOTENT over the same ratings", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    seedRating(context, "rating-1", TURN, 1);
    await reconcileFromRating(context.dependencies, RATING_COMMAND);
    const first = context.repository.all()[0]?.confidence.confidence;
    await reconcileFromRating(context.dependencies, RATING_COMMAND);
    expect(context.repository.all()[0]?.confidence.confidence).toBe(first);
  });

  it("SKIPS as stale when a later revision already won", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    seedRating(context, "rating-1", TURN, 1, 5);
    const report = await reconcileFromRating(context.dependencies, RATING_COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.standing).toBe("stale");
    expect(report.value.updated).toBe(0);
    expect(context.repository.all()[0]?.confidence.confidence).toBe(0.5);
  });

  it("reports `missing` when the rating no longer exists", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    const report = await reconcileFromRating(context.dependencies, RATING_COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.standing).toBe("missing");
  });

  it("refuses a blank rating id and a non-positive revision", async () => {
    const context = harness();
    expect(
      (await reconcileFromRating(context.dependencies, { ...RATING_COMMAND, ratingId: "  " })).ok,
    ).toBe(false);
    for (const expectedRevision of [0, -1, 1.5, Number.NaN]) {
      const report = await reconcileFromRating(context.dependencies, {
        ...RATING_COMMAND,
        expectedRevision,
      });
      expect(report.ok).toBe(false);
      if (report.ok) throw new Error("unreachable");
      expect(report.error.code).toBe("MEMORY_QUERY_INVALID");
    }
  });

  it("refuses an unauthorized caller", async () => {
    const context = harness();
    expect(
      (await reconcileFromRating(context.dependencies, { ...RATING_COMMAND, authorization: {} })).ok,
    ).toBe(false);
  });

  it("runs everything inside ONE transaction", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    seedRating(context, "rating-1", TURN, 1);
    await reconcileFromRating(context.dependencies, RATING_COMMAND);
    expect(context.unitOfWork.transactions).toHaveLength(1);
  });

  it("touches nothing when no memory names that turn", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [OTHER_TURN]);
    seedRating(context, "rating-1", TURN, 1);
    const report = await reconcileFromRating(context.dependencies, RATING_COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.updated).toBe(0);
  });
});

describe("reconcileFromTurn", () => {
  const command = {
    authorization: runtimeGrant(),
    environment: ENVIRONMENT_SCOPE,
    endUserId: SUBJECT_ID,
    turnId: TURN,
  };

  it("LIFTS a quarantine once the last negative rating is gone", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN], {
      confidence: { confidence: 0.4, feedbackBaselineConfidence: 0.5 },
      lifecycle: { ...memoryFixture().lifecycle, quarantinedAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    const report = await reconcileFromTurn(context.dependencies, command);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.quarantined).toBe(0);
    expect(context.repository.all()[0]?.lifecycle.quarantinedAt).toBeNull();
    expect(context.repository.all()[0]?.confidence.confidence).toBe(0.5);
  });

  it("has NO revision to check — the row that carried it is gone", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN]);
    const report = await reconcileFromTurn(context.dependencies, command);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.standing).toBe("applied");
    expect(report.value.updated).toBe(1);
  });

  it("keeps a quarantine while another negative remains on a sibling turn", async () => {
    const context = harness();
    seedMemory(context, "mem-1", [TURN, OTHER_TURN], {
      lifecycle: { ...memoryFixture().lifecycle, quarantinedAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    seedRating(context, "rating-2", OTHER_TURN, -1);
    const report = await reconcileFromTurn(context.dependencies, command);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.quarantined).toBe(1);
    // The ORIGINAL instant survives.
    expect(context.repository.all()[0]?.lifecycle.quarantinedAt?.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("surfaces a store failure rather than reporting zero updates", async () => {
    const context = harness();
    context.repository.failWith("store down");
    const report = await reconcileFromTurn(context.dependencies, command);
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
  });
});
