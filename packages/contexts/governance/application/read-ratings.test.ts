import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { AgentId, AgentVersionId, MessageRating, TurnId } from "../domain/index.js";
import { readAgentSatisfaction, readVersionSatisfaction, versionNumbers } from "./read-ratings.js";
import {
  AGENT_ID,
  AGENT_VERSION_ID,
  END_USER_ID,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const DAY = 86_400_000;
let context: GovernanceTestContext;

beforeEach(() => {
  context = buildGovernanceTestContext();
});

/**
 * Seed a stored row directly.
 *
 * The use case under test only READS, and going through `rateTurn` for every
 * vote would need a distinct seeded turn per (turn, end user) pair. What matters
 * here is that a row exists with a known agent, version and value.
 */
function seedVote(
  turnId: string,
  rating: number,
  agentVersionId: AgentVersionId | null = AGENT_VERSION_ID,
  agentId: AgentId = AGENT_ID,
): MessageRating {
  const at = context.clock.now();
  return context.ratings.seedRaw(context.scope, {
    turnId: asIdentifier<TurnId>(turnId),
    agentId,
    agentVersionId,
    endUserId: END_USER_ID,
    rating: rating as 1 | -1,
    revision: 1,
    comment: null,
    createdAt: at,
    updatedAt: at,
  });
}

describe("the version-label ceiling", () => {
  it("labels only what ONE PAGE carries, and leaves the rest unlabelled", async () => {
    // Three versions against a two-row page. The source reads every version an
    // agent has ever had, unbounded, on every dashboard load; here the lookup is
    // bounded and a bucket beyond the page degrades to an unlabelled one instead.
    const context = buildGovernanceTestContext({ policy: withPolicy({ evals: { maxPageSize: 2 } }) });
    context.agents.seed({
      agentId: AGENT_ID,
      name: "Support",
      model: "anthropic:claude-sonnet-4-6",
      currentVersionId: "version-9",
      currentVersionNumber: 9,
      priorVersions: [
        { versionId: "version-6", versionNumber: 6 },
        { versionId: "version-7", versionNumber: 7 },
      ],
    });
    const labels = await versionNumbers(context.dependencies, context.authorization, AGENT_ID);
    expect(labels.size).toBe(2);
    expect(labels.get("version-6")).toBe(6);
    expect(labels.get("version-7")).toBe(7);
    // The third fell off the page, so its bucket carries scores and no label.
    expect(labels.has("version-9")).toBe(false);
  });

  it("labels ALL THREE when the page is wide enough, so the ceiling test is not vacuous", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ evals: { maxPageSize: 50 } }) });
    context.agents.seed({
      agentId: AGENT_ID,
      name: "Support",
      model: "anthropic:claude-sonnet-4-6",
      currentVersionId: "version-9",
      currentVersionNumber: 9,
      priorVersions: [
        { versionId: "version-6", versionNumber: 6 },
        { versionId: "version-7", versionNumber: 7 },
      ],
    });
    const labels = await versionNumbers(context.dependencies, context.authorization, AGENT_ID);
    expect(labels.size).toBe(3);
    expect(labels.get("version-9")).toBe(9);
  });
});

describe("readVersionSatisfaction", () => {
  it("REFUSES an unminted grant", async () => {
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: {},
      agentId: AGENT_ID,
    });
    expect(read.ok).toBe(false);
  });

  it("scores the live version from its own votes", async () => {
    seedVote("turn-1", 1);
    seedVote("turn-2", 1);
    seedVote("turn-3", -1);
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.total).toBe(3);
    expect(read.ok && read.value.rows[0]).toMatchObject({ ups: 2, downs: 1, total: 3, versionNumber: 7 });
  });

  it("labels the version from `agents`, not from the rating row", async () => {
    seedVote("turn-1", 1, asIdentifier<AgentVersionId>("version-6"));
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.rows[0]?.versionNumber).toBe(6);
  });

  it("keeps a vote whose version `agents` cannot label", async () => {
    seedVote("turn-1", 1, asIdentifier<AgentVersionId>("version-pruned"));
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.rows).toHaveLength(1);
    expect(read.ok && read.value.rows[0]?.versionNumber).toBeNull();
    expect(read.ok && read.value.rows[0]?.ups).toBe(1);
  });

  it("still renders when `agents` cannot supply ANY labels", async () => {
    // A satisfaction report that refuses to render because a label service is
    // unavailable is useless; a degraded one is not.
    seedVote("turn-1", 1);
    context.agents.failEverything();
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.rows[0]?.ups).toBe(1);
    expect(read.ok && read.value.rows[0]?.versionNumber).toBeNull();
  });

  it("excludes votes older than the window", async () => {
    seedVote("turn-old", 1);
    context.clock.advanceMilliseconds(10 * DAY);
    seedVote("turn-new", -1);
    const week = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      sinceDays: 7,
    });
    expect(week.ok && week.value.total).toBe(1);
    expect(week.ok && week.value.rows[0]?.downs).toBe(1);
  });

  it("does not read another environment's votes", async () => {
    seedVote("turn-1", 1);
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.total).toBe(0);
  });

  it("does not read a DIFFERENT agent's votes", async () => {
    seedVote("turn-1", 1, AGENT_VERSION_ID, asIdentifier<AgentId>("agent-other"));
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.total).toBe(0);
  });

  it("carries no subject on any row", async () => {
    seedVote("turn-1", 1);
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    const row = read.ok ? (read.value.rows[0] as unknown as Record<string, unknown>) : {};
    for (const key of ["endUserId", "userId", "turnId", "comment"]) expect(key in row).toBe(false);
  });

  it("reports a discarded legacy row instead of quietly changing the denominator", async () => {
    seedVote("turn-1", 1);
    seedVote("turn-2", 0);
    const read = await readVersionSatisfaction(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(read.ok && read.value.rows[0]).toMatchObject({ ups: 1, total: 1, discarded: 1, score: 1 });
  });
});

describe("readAgentSatisfaction", () => {
  it("REFUSES an unminted grant", async () => {
    expect((await readAgentSatisfaction(context.dependencies, { authorization: null })).ok).toBe(false);
  });

  it("rolls every agent in the environment up in one pass", async () => {
    seedVote("turn-1", 1);
    seedVote("turn-2", -1, AGENT_VERSION_ID, asIdentifier<AgentId>("agent-2"));
    const read = await readAgentSatisfaction(context.dependencies, {
      authorization: context.authorization,
    });
    expect(read.ok && read.value.rows).toHaveLength(2);
    expect(read.ok && read.value.rows.map((row) => row.agentId)).toEqual(["agent-1", "agent-2"]);
  });

  it("does not roll up another environment's votes", async () => {
    seedVote("turn-1", 1);
    const read = await readAgentSatisfaction(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(read.ok && read.value.rows).toEqual([]);
  });

  it("reports the clamped window it read", async () => {
    const read = await readAgentSatisfaction(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 10_000,
    });
    expect(read.ok && read.value.sinceDays).toBe(365);
  });

  it("reports a store failure rather than an empty scorecard", async () => {
    context.ratings.failNext("store down");
    const read = await readAgentSatisfaction(context.dependencies, {
      authorization: context.authorization,
    });
    expect(read.ok).toBe(false);
  });
});
