import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId, AgentVersionId } from "./identifiers.js";
import { satisfactionByAgent, satisfactionByVersion, type SatisfactionInput } from "./satisfaction.js";

const AGENT_A = asIdentifier<AgentId>("agent-a");
const AGENT_B = asIdentifier<AgentId>("agent-b");
const V6 = asIdentifier<AgentVersionId>("version-6");
const V7 = asIdentifier<AgentVersionId>("version-7");

function vote(agentId: AgentId, agentVersionId: AgentVersionId | null, rating: number): SatisfactionInput {
  return { agentId, agentVersionId, rating };
}

const NUMBERS = new Map([
  ["version-6", 6],
  ["version-7", 7],
]);

describe("satisfactionByVersion", () => {
  it("scores each version on its own votes", () => {
    const rows = satisfactionByVersion(
      [vote(AGENT_A, V7, 1), vote(AGENT_A, V7, 1), vote(AGENT_A, V7, -1), vote(AGENT_A, V6, -1)],
      NUMBERS,
    );
    const seven = rows.find((row) => row.agentVersionId === V7);
    expect(seven).toEqual({
      agentVersionId: V7,
      versionNumber: 7,
      ups: 2,
      downs: 1,
      total: 3,
      discarded: 0,
      score: 2 / 3,
    });
  });

  it("lists the newest version first", () => {
    const rows = satisfactionByVersion([vote(AGENT_A, V6, 1), vote(AGENT_A, V7, 1)], NUMBERS);
    expect(rows.map((row) => row.versionNumber)).toEqual([7, 6]);
  });

  it("breaks a tie in version number by the busier bucket", () => {
    // The QUIETER bucket is seen first, so the Map's insertion order is the
    // opposite of the answer. A stable sort with the tie-break deleted would
    // return the quieter one first, which is what makes this case reach the
    // comparator rather than ride on insertion order.
    const rows = satisfactionByVersion(
      [vote(AGENT_A, V7, 1), vote(AGENT_A, null, 1), vote(AGENT_A, null, 1)],
      new Map([["version-7", 0]]),
    );
    expect(rows[0]?.total).toBe(2);
    expect(rows[0]?.agentVersionId).toBeNull();
    expect(rows[1]?.total).toBe(1);
  });

  it("keeps votes whose version has no label rather than dropping them", () => {
    const rows = satisfactionByVersion([vote(AGENT_A, V7, 1)], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versionNumber).toBeNull();
    expect(rows[0]?.ups).toBe(1);
  });

  it("keeps votes cast with NO version at all", () => {
    const rows = satisfactionByVersion([vote(AGENT_A, null, -1)], NUMBERS);
    expect(rows[0]?.agentVersionId).toBeNull();
    expect(rows[0]?.downs).toBe(1);
  });

  it("scores 0 for an all-down bucket AND publishes the total beside it", () => {
    // A score of 0 and a score with no votes render identically; `total` is what
    // lets a surface tell them apart.
    const rows = satisfactionByVersion([vote(AGENT_A, V7, -1)], NUMBERS);
    expect(rows[0]?.score).toBe(0);
    expect(rows[0]?.total).toBe(1);
  });

  it("reports an unreadable stored value as discarded, out of the denominator", () => {
    const rows = satisfactionByVersion([vote(AGENT_A, V7, 1), vote(AGENT_A, V7, 0)], NUMBERS);
    expect(rows[0]).toMatchObject({ ups: 1, downs: 0, total: 1, discarded: 1, score: 1 });
  });

  it("conserves every input row across the buckets", () => {
    const rows = [
      vote(AGENT_A, V7, 1),
      vote(AGENT_A, V6, -1),
      vote(AGENT_A, null, 1),
      vote(AGENT_A, V7, 0),
    ];
    const counted = satisfactionByVersion(rows, NUMBERS);
    const accounted = counted.reduce((total, row) => total + row.total + row.discarded, 0);
    expect(accounted).toBe(rows.length);
  });
});

describe("satisfactionByAgent", () => {
  it("groups by agent in one pass", () => {
    const rows = satisfactionByAgent([
      vote(AGENT_A, V7, 1),
      vote(AGENT_B, V7, -1),
      vote(AGENT_A, V6, 1),
    ]);
    expect(rows).toEqual([
      { agentId: AGENT_A, ups: 2, downs: 0, total: 2, discarded: 0, score: 1 },
      { agentId: AGENT_B, ups: 0, downs: 1, total: 1, discarded: 0, score: 0 },
    ]);
  });

  it("orders by agent id, so two runs over one input list agree", () => {
    const rows = satisfactionByAgent([vote(AGENT_B, null, 1), vote(AGENT_A, null, 1)]);
    expect(rows.map((row) => row.agentId)).toEqual([AGENT_A, AGENT_B]);
  });

  it("answers nothing for no votes", () => {
    expect(satisfactionByAgent([])).toEqual([]);
  });
});
