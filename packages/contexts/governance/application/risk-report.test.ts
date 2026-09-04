// The per-agent risk board.
//
// Two things this suite exists to hold, both of which the source gets wrong
// silently:
//
//   A DENOMINATOR THAT WAS INVENTED IS MARKED. The source writes
//   `Math.max(1, turns)`, so an agent with three PII events and no turns scores
//   as though it had one turn — a 300% rate capped to 100, weighted to 40, and a
//   `medium` band on an agent that never ran. Nothing in its output says the
//   denominator was made up. `denominatorSubstituted` says it here.
//
//   A BOARD BUILT WITHOUT ITS DENOMINATORS IS NOT COMPLETE. When the activity
//   reader is down, every rate on the board was computed against an invented
//   denominator; `complete: false` says so rather than presenting the numbers as
//   measured.

import { beforeEach, describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import type { AgentId, SafetyEventDraft } from "../domain/index.js";
import { readRiskBoard } from "./risk-report.js";
import { recordSafetyEvent } from "./record-safety-event.js";
import {
  AGENT_ID,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const DAY = 86_400_000;
const OTHER_AGENT = asIdentifier<AgentId>("agent-2");

let context: GovernanceTestContext;

beforeEach(() => {
  context = buildGovernanceTestContext({ now: new Date("2026-03-01T12:00:00.000Z") });
});

async function record(overrides: Partial<SafetyEventDraft> = {}) {
  const written = await recordSafetyEvent(context.dependencies, {
    authorization: context.authorization,
    event: { detector: "pii", action: "redact", severity: "medium", agentId: AGENT_ID, ...overrides },
  });
  if (!written.ok) throw new Error(`record failed: ${written.error.code}`);
  return written.value;
}

function board(overrides: Record<string, unknown> = {}) {
  return readRiskBoard(context.dependencies, { authorization: context.authorization, ...overrides });
}

describe("the arithmetic", () => {
  it("scores one PII event in a hundred turns at EXACTLY the weighted rate", async () => {
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 100,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record();
    const read = await board();
    const row = read.ok ? read.value.rows[0] : undefined;
    // rate = 1/100 * 100 = 1; risk = 0.4 * 1 = 0.4
    expect(row?.risk).toBe(0.4);
    expect(row?.band).toBe("low");
    expect(row?.denominatorSubstituted).toBe(false);
  });

  it("folds `tool_param` into the INJECTION rate, not into its own bucket", async () => {
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 100,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record({ detector: "tool_param", action: "block", severity: "high" });
    const read = await board();
    const row = read.ok ? read.value.rows[0] : undefined;
    expect(row?.injectionEvents).toBe(1);
    expect(row?.piiEvents).toBe(0);
    // 0.3 * 1 = 0.3
    expect(row?.risk).toBe(0.3);
  });

  it("blends all four rates with the shipped weights", async () => {
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 100,
      toolErrors: 10,
      approvalEvents: 20,
    });
    await record();
    await record({ detector: "injection", action: "block", severity: "high" });
    await record({ detector: "injection", action: "block", severity: "high" });
    const read = await board();
    const row = read.ok ? read.value.rows[0] : undefined;
    // 0.4*1 + 0.3*2 + 0.2*10 + 0.1*20 = 0.4 + 0.6 + 2 + 2 = 5
    expect(row?.risk).toBe(5);
  });

  it("puts an agent at EXACTLY the high boundary in the high band", async () => {
    context = buildGovernanceTestContext({
      now: new Date("2026-03-01T12:00:00.000Z"),
      policy: withPolicy({ risk: { highBand: 40, mediumBand: 20 } }),
    });
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 1,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record();
    const read = await board();
    // 0.4 * 100 = 40, exactly the boundary, which is inclusive.
    expect(read.ok && read.value.rows[0]?.risk).toBe(40);
    expect(read.ok && read.value.rows[0]?.band).toBe("high");
  });

  it("puts an agent one point BELOW the high boundary in the medium band", async () => {
    context = buildGovernanceTestContext({
      now: new Date("2026-03-01T12:00:00.000Z"),
      policy: withPolicy({ risk: { highBand: 41, mediumBand: 20 } }),
    });
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 1,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record();
    const read = await board();
    expect(read.ok && read.value.rows[0]?.risk).toBe(40);
    expect(read.ok && read.value.rows[0]?.band).toBe("medium");
  });

  it("orders riskiest first and breaks ties by agent id, not by insertion", async () => {
    context.agents.seed({
      agentId: OTHER_AGENT,
      name: "Billing",
      model: "anthropic:claude-sonnet-4-6",
      currentVersionId: "version-1",
      currentVersionNumber: 1,
    });
    context.activity.seed(context.scope, {
      agentId: OTHER_AGENT,
      turns: 100,
      toolErrors: 0,
      approvalEvents: 0,
    });
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 100,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record({ agentId: OTHER_AGENT });
    await record({ agentId: OTHER_AGENT });
    await record();
    const read = await board();
    expect(read.ok && read.value.rows.map((row) => row.agentId)).toEqual([OTHER_AGENT, AGENT_ID]);
  });
});

describe("the invented denominator", () => {
  it("MARKS an agent with safety events and no turns", async () => {
    await record();
    const read = await board();
    const row = read.ok ? read.value.rows[0] : undefined;
    expect(row?.turns).toBe(0);
    expect(row?.denominatorSubstituted).toBe(true);
    // One event over an invented denominator of 1 is a capped rate of 100.
    expect(row?.risk).toBe(40);
    expect(row?.band).toBe("medium");
  });

  it("does NOT mark an agent whose turns were measured", async () => {
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 5,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record();
    const read = await board();
    expect(read.ok && read.value.rows[0]?.denominatorSubstituted).toBe(false);
  });
});

describe("merging the two sources", () => {
  it("UNIONS them: an agent with only activity and one with only events both appear", async () => {
    context.agents.seed({
      agentId: OTHER_AGENT,
      name: "Billing",
      model: "anthropic:claude-sonnet-4-6",
      currentVersionId: "version-1",
      currentVersionNumber: 1,
    });
    context.activity.seed(context.scope, {
      agentId: OTHER_AGENT,
      turns: 10,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record();
    const read = await board();
    expect(read.ok && read.value.rows).toHaveLength(2);
    expect(read.ok && read.value.rows.map((row) => row.agentId).sort()).toEqual(
      [AGENT_ID, OTHER_AGENT].sort(),
    );
  });

  it("names the agents `agents` can name and leaves the rest null", async () => {
    context.activity.seed(context.scope, {
      agentId: OTHER_AGENT,
      turns: 10,
      toolErrors: 0,
      approvalEvents: 0,
    });
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 10,
      toolErrors: 0,
      approvalEvents: 0,
    });
    const read = await board();
    const named = read.ok ? read.value.rows.find((row) => row.agentId === AGENT_ID) : undefined;
    const unnamed = read.ok ? read.value.rows.find((row) => row.agentId === OTHER_AGENT) : undefined;
    expect(named?.agentName).toBe("Support");
    // `agent-2` was never seeded into the agents double, so it has no name — and
    // an unnamed high-risk agent is still a high-risk agent.
    expect(unnamed?.agentName).toBeNull();
  });
});

describe("degradation", () => {
  it("still produces a board when the activity reader is down, marked INCOMPLETE", async () => {
    await record();
    context.activity.failEverything("reader gone");
    const read = await board();
    expect(read.ok && read.value.complete).toBe(false);
    expect(read.ok && read.value.rows).toHaveLength(1);
    expect(read.ok && read.value.rows[0]?.denominatorSubstituted).toBe(true);
  });

  it("is COMPLETE when the reader answers, so the incomplete test is not vacuous", async () => {
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 3,
      toolErrors: 0,
      approvalEvents: 0,
    });
    await record();
    const read = await board();
    expect(read.ok && read.value.complete).toBe(true);
  });

  it("REFUSES outright when the SAFETY ledger is down", async () => {
    // A risk board with no safety input is not a degraded risk board; it is a
    // different and reassuring picture.
    context.safety.failNext("ledger down");
    const read = await board();
    expect(!read.ok && read.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });
});

describe("authorization, scope and the window", () => {
  it("REFUSES an unminted grant and reads nothing", async () => {
    await record();
    const read = await readRiskBoard(context.dependencies, { authorization: { forged: true } });
    expect(read.ok).toBe(false);
  });

  it("does NOT show another environment's events on this grant's board", async () => {
    await record();
    context.activity.seed(context.scope, {
      agentId: AGENT_ID,
      turns: 10,
      toolErrors: 0,
      approvalEvents: 0,
    });
    const elsewhere = await readRiskBoard(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(elsewhere.ok && elsewhere.value.rows).toEqual([]);
  });

  it("defaults to a SEVEN-day window and clamps an over-wide one to ninety", async () => {
    const byDefault = await board();
    expect(byDefault.ok && byDefault.value.sinceDays).toBe(7);
    const wide = await board({ sinceDays: 10_000 });
    expect(wide.ok && wide.value.sinceDays).toBe(90);
  });

  it("drops an event that fell out of the window", async () => {
    await record();
    context.clock.advanceMilliseconds(30 * DAY);
    const read = await board({ sinceDays: 7 });
    expect(read.ok && read.value.rows).toEqual([]);
  });

  it("counts an event with NO agent against nobody rather than against everybody", async () => {
    await record({ agentId: null });
    const read = await board();
    expect(read.ok && read.value.rows).toEqual([]);
  });
});
