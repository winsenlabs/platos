import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId } from "./identifiers.js";
import { INJECTION_DETECTORS, PII_DETECTORS, bandOf, rateOf, scoreAgentRisk, scoreAgents, type AgentActivity } from "./risk.js";

// The shipped weights, written as literals so a change to the default is a
// change to this file rather than a silent change in behaviour.
const POLICY = {
  piiWeight: 0.4,
  injectionWeight: 0.3,
  toolErrorWeight: 0.2,
  approvalWeight: 0.1,
  highBand: 50,
  mediumBand: 20,
  minWindowDays: 1,
  defaultWindowDays: 7,
  maxWindowDays: 90,
} as const;

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    agentId: asIdentifier<AgentId>("agent-1"),
    turns: 100,
    piiEvents: 0,
    injectionEvents: 0,
    toolErrors: 0,
    approvalEvents: 0,
    ...overrides,
  };
}

describe("rateOf", () => {
  it("counts events per 100 turns", () => {
    expect(rateOf(5, 100)).toBe(5);
    expect(rateOf(1, 10)).toBe(10);
  });

  it("caps at 100 rather than reporting 300%", () => {
    expect(rateOf(3, 1)).toBe(100);
  });

  it("answers zero for no events, whatever the denominator", () => {
    expect(rateOf(0, 100)).toBe(0);
    expect(rateOf(-1, 100)).toBe(0);
  });
});

describe("bandOf", () => {
  it("is high AT the boundary, not one above it", () => {
    expect(bandOf(50, POLICY)).toBe("high");
    expect(bandOf(49.999, POLICY)).toBe("medium");
  });

  it("is medium AT its boundary too", () => {
    expect(bandOf(20, POLICY)).toBe("medium");
    expect(bandOf(19.999, POLICY)).toBe("low");
  });

  it("uses the bands it is GIVEN", () => {
    expect(bandOf(30, { ...POLICY, highBand: 25, mediumBand: 10 })).toBe("high");
  });
});

describe("scoreAgentRisk", () => {
  it("blends the four rates by their weights", () => {
    // 10 PII in 100 turns is a rate of 10, weighted 0.4 -> 4.
    // 20 injections is a rate of 20, weighted 0.3 -> 6. Total 10.
    const risk = scoreAgentRisk(activity({ piiEvents: 10, injectionEvents: 20 }), null, POLICY);
    expect(risk.risk).toBe(10);
    expect(risk.band).toBe("low");
  });

  it("weights each input differently, so the weights are not decoration", () => {
    const pii = scoreAgentRisk(activity({ piiEvents: 100 }), null, POLICY).risk;
    const injection = scoreAgentRisk(activity({ injectionEvents: 100 }), null, POLICY).risk;
    const toolErrors = scoreAgentRisk(activity({ toolErrors: 100 }), null, POLICY).risk;
    const approvals = scoreAgentRisk(activity({ approvalEvents: 100 }), null, POLICY).risk;
    expect([pii, injection, toolErrors, approvals]).toEqual([40, 30, 20, 10]);
  });

  it("reaches 100 when every rate is saturated", () => {
    const risk = scoreAgentRisk(
      activity({ piiEvents: 100, injectionEvents: 100, toolErrors: 100, approvalEvents: 100 }),
      null,
      POLICY,
    );
    expect(risk.risk).toBe(100);
    expect(risk.band).toBe("high");
  });

  it("clamps to 100 even when an install's weights sum above one", () => {
    const risk = scoreAgentRisk(
      activity({ piiEvents: 100, injectionEvents: 100 }),
      null,
      { ...POLICY, piiWeight: 1, injectionWeight: 1 },
    );
    expect(risk.risk).toBe(100);
  });

  it("SAYS SO when the denominator was invented", () => {
    // Three PII events and no turns scores as though there had been one turn.
    // The source substitutes the same denominator and says nothing, so the
    // dashboard shows a rate that was never measured.
    const risk = scoreAgentRisk(activity({ turns: 0, piiEvents: 3 }), null, POLICY);
    expect(risk.denominatorSubstituted).toBe(true);
    expect(risk.risk).toBe(40);
    expect(risk.turns).toBe(0);
  });

  it("does not claim a substitution when there were turns", () => {
    expect(scoreAgentRisk(activity(), null, POLICY).denominatorSubstituted).toBe(false);
  });

  it("rounds to one decimal place", () => {
    const risk = scoreAgentRisk(activity({ turns: 3, piiEvents: 1 }), null, POLICY);
    expect(risk.risk).toBe(13.3);
  });

  it("carries the counts through untouched", () => {
    const risk = scoreAgentRisk(activity({ piiEvents: 2, toolErrors: 3, approvalEvents: 4 }), "Support", POLICY);
    expect(risk).toMatchObject({ piiEvents: 2, toolErrors: 3, approvalEvents: 4, agentName: "Support" });
  });

  it("keeps an unnamed agent on the board", () => {
    expect(scoreAgentRisk(activity(), null, POLICY).agentName).toBeNull();
  });
});

describe("scoreAgents", () => {
  it("lists the riskiest first", () => {
    const rows = scoreAgents(
      [
        activity({ agentId: asIdentifier<AgentId>("calm") }),
        activity({ agentId: asIdentifier<AgentId>("risky"), piiEvents: 100 }),
      ],
      new Map(),
      POLICY,
    );
    expect(rows.map((row) => row.agentId)).toEqual(["risky", "calm"]);
  });

  it("breaks a tie by agent id, so two runs over one input agree", () => {
    const rows = scoreAgents(
      [activity({ agentId: asIdentifier<AgentId>("b") }), activity({ agentId: asIdentifier<AgentId>("a") })],
      new Map(),
      POLICY,
    );
    expect(rows.map((row) => row.agentId)).toEqual(["a", "b"]);
  });

  it("labels the agents it can name", () => {
    const rows = scoreAgents([activity()], new Map([["agent-1", "Support"]]), POLICY);
    expect(rows[0]?.agentName).toBe("Support");
  });
});

describe("which detectors feed which rate", () => {
  it("folds a poisoned tool argument into the INJECTION rate", () => {
    expect([...INJECTION_DETECTORS]).toEqual(["injection", "tool_param"]);
  });

  it("keeps the PII rate to the pii detector alone", () => {
    expect([...PII_DETECTORS]).toEqual(["pii"]);
  });

  it("does not double-count a detector across the two rates", () => {
    for (const detector of PII_DETECTORS) expect(INJECTION_DETECTORS).not.toContain(detector);
  });
});
