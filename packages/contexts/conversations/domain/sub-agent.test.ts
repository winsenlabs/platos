// Delegation: a kill switch, a cycle check and two ceilings — four codes.
//
// Mutations M-S1 (kill switch), M-S2 (cycle), M-S3 (depth), M-S4 (fan-out). The
// cycle check is the one the extraction source has NO equivalent of: A
// delegating to B delegating to A is inside both of its ceilings and runs.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import {
  admitDelegation,
  chainDepth,
  mayDelegateFurther,
  rootChain,
  subAgentStepCeiling,
} from "./sub-agent.js";
import type { AgentId } from "./identifiers.js";

const POLICY = DEFAULT_CONVERSATIONS_POLICY.subAgent;
const agent = (name: string) => asIdentifier<AgentId>(name);

describe("the chain", () => {
  it("counts a root as depth zero, so depth is the number of DELEGATIONS", () => {
    expect(chainDepth(rootChain(agent("a")))).toBe(0);
    expect(chainDepth({ agentIds: [agent("a"), agent("b")] })).toBe(1);
    expect(chainDepth({ agentIds: [agent("a"), agent("b"), agent("c")] })).toBe(2);
  });
});

describe("admitDelegation", () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    chain: rootChain(agent("a")),
    childAgentId: agent("b"),
    fanOutSoFar: 0,
    ...overrides,
  });

  it("admits a first delegation and extends the chain with the child", () => {
    const admitted = admitDelegation(request(), POLICY);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.agentIds).toEqual(["a", "b"]);
  });

  it("refuses when the kill switch is off, BEFORE any ceiling is consulted", () => {
    const refused = admitDelegation(
      request({ chain: { agentIds: [agent("a"), agent("b"), agent("c")] }, fanOutSoFar: 99 }),
      { ...POLICY, subAgentsEnabled: false },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // This request breaches the depth AND the fan-out ceiling too. The kill
    // switch answers first, so an installation with delegation off never learns
    // about its own ceilings.
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENTS_DISABLED");
  });

  it("refuses a CYCLE with its own code, even inside every ceiling", () => {
    const refused = admitDelegation(
      request({ chain: { agentIds: [agent("a"), agent("b")] }, childAgentId: agent("a") }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENT_CYCLE");
    expect(refused.error.details.agentId).toBe("a");
  });

  it("refuses an agent delegating to ITSELF, the shortest cycle", () => {
    const refused = admitDelegation(request({ childAgentId: agent("a") }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENT_CYCLE");
  });

  it("refuses the DEPTH ceiling, admitting exactly at it", () => {
    const atCeiling = admitDelegation(
      request({ chain: { agentIds: [agent("a"), agent("b")] }, childAgentId: agent("c") }),
      POLICY,
    );
    expect(atCeiling.ok).toBe(true);
    const refused = admitDelegation(
      request({
        chain: { agentIds: [agent("a"), agent("b"), agent("c")] },
        childAgentId: agent("d"),
      }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENT_DEPTH_EXCEEDED");
    expect(refused.error.details.maximum).toBe(POLICY.maxDepth);
  });

  it("refuses the FAN-OUT ceiling with a DIFFERENT code, admitting exactly at it", () => {
    expect(admitDelegation(request({ fanOutSoFar: POLICY.maxFanOut - 1 }), POLICY).ok).toBe(true);
    const refused = admitDelegation(request({ fanOutSoFar: POLICY.maxFanOut }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENT_FAN_OUT_EXCEEDED");
    expect(refused.error.details.count).toBe(POLICY.maxFanOut + 1);
  });

  it("reports a CYCLE rather than a depth breach when a request is both", () => {
    // An operator sent to raise a ceiling that is not the problem is an operator
    // sent to the wrong place. The order of the checks is what prevents it.
    const refused = admitDelegation(
      request({
        chain: { agentIds: [agent("a"), agent("b"), agent("c")] },
        childAgentId: agent("b"),
      }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENT_CYCLE");
  });
});

describe("mayDelegateFurther", () => {
  it("is true below the ceiling and false at it — the ABSENT-capability rule", () => {
    expect(mayDelegateFurther(rootChain(agent("a")), POLICY)).toBe(true);
    expect(mayDelegateFurther({ agentIds: [agent("a"), agent("b")] }, POLICY)).toBe(true);
    expect(mayDelegateFurther({ agentIds: [agent("a"), agent("b"), agent("c")] }, POLICY)).toBe(
      false,
    );
  });

  it("is false whenever the kill switch is off, at any depth", () => {
    expect(mayDelegateFurther(rootChain(agent("a")), { ...POLICY, subAgentsEnabled: false })).toBe(
      false,
    );
  });
});

describe("subAgentStepCeiling", () => {
  it("clamps a request to the installation ceiling", () => {
    expect(subAgentStepCeiling(1_000, POLICY)).toBe(POLICY.maxStepsPerSubAgent);
  });

  it("honours a request below the ceiling", () => {
    expect(subAgentStepCeiling(3, POLICY)).toBe(3);
  });

  it("defaults an absent or unusable request to six, the source's default", () => {
    expect(subAgentStepCeiling(null, POLICY)).toBe(6);
    expect(subAgentStepCeiling(0, POLICY)).toBe(6);
    expect(subAgentStepCeiling(-4, POLICY)).toBe(6);
    expect(subAgentStepCeiling(1.5, POLICY)).toBe(6);
  });
});
