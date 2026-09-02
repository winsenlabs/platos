import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_WIDE,
  EVERY_USER,
  collisionKey,
  decodeBudgetTarget,
  describeTarget,
  encodeBudgetTarget,
  isBudgetSubject,
  isBudgetTier,
  type BudgetTarget,
} from "./budget-scope.js";
import { asCostIdentifier, type ActorId, type AgentId, type SkillSlug } from "./identifiers.js";

function target(overrides: Partial<BudgetTarget> = {}): BudgetTarget {
  return { ...ENVIRONMENT_WIDE, ...overrides };
}

describe("the one column a target is packed into", () => {
  it("round-trips every field", () => {
    const original = target({
      subject: "user",
      targetId: "user-7",
      tier: "skill",
      skillSlug: asCostIdentifier<SkillSlug>("web-search"),
      legacyWebhookUrl: "https://hooks.example.test/x",
      legacyEmails: "ops@example.test",
      overrideBy: asCostIdentifier<ActorId>("operator-1"),
    });
    expect(decodeBudgetTarget(encodeBudgetTarget(original))).toEqual(original);
  });

  it("keeps the SOURCE's field names, which cannot be renamed", () => {
    // The column is not versioned; renaming a field orphans every row already
    // written.
    const encoded = JSON.parse(encodeBudgetTarget(target({ subject: "agent", targetId: "a-1" })));
    expect(Object.keys(encoded).sort()).toEqual([
      "alertEmails",
      "alertWebhookUrl",
      "overrideBy",
      "scopeType",
      "skillSlug",
      "targetId",
      "tier",
    ]);
  });

  it("takes the agent id from the ROW, not from the column", () => {
    // `Budget.agentId` is its own indexed foreign key, so the decoder cannot
    // invent it and the encoder must not claim it.
    const agent = asCostIdentifier<AgentId>("agent-9");
    const decoded = decodeBudgetTarget(encodeBudgetTarget(target()), agent);
    expect(decoded.agentId).toBe(agent);
    expect(encodeBudgetTarget(target({ agentId: agent }))).not.toContain("agent-9");
  });
});

describe("what an unreadable column means", () => {
  it("reads a non-JSON column as an environment-wide llm cap", () => {
    // Not error handling: the statement that a row written by something other
    // than this encoder still governs the whole environment. The difference
    // between caps-everything and caps-nothing is not a serialisation detail.
    for (const raw of ["", "scope", "not json", "[1,2,3]", "null", '"scope"']) {
      expect(decodeBudgetTarget(raw)).toEqual(ENVIRONMENT_WIDE);
    }
  });

  it("reads an unrecognised subject as environment-wide", () => {
    expect(decodeBudgetTarget(JSON.stringify({ scopeType: "team" }))).toEqual(ENVIRONMENT_WIDE);
  });

  it("reads an unrecognised tier as llm, the tier every legacy row has", () => {
    const decoded = decodeBudgetTarget(JSON.stringify({ scopeType: "scope", tier: "bgo" }));
    expect(decoded.tier).toBe("llm");
  });

  it("reads a blank optional field as absent rather than as an empty string", () => {
    const decoded = decodeBudgetTarget(
      JSON.stringify({ scopeType: "scope", skillSlug: "", overrideBy: "" }),
    );
    expect(decoded.skillSlug).toBeNull();
    expect(decoded.overrideBy).toBeNull();
  });

  it("carries the agent id through even on the fallback path", () => {
    const agent = asCostIdentifier<AgentId>("agent-3");
    expect(decodeBudgetTarget("garbage", agent).agentId).toBe(agent);
  });
});

describe("the collision key", () => {
  it("separates two caps that differ only by tier", () => {
    // Written with only (subject, target, period), an llm environment-wide cap
    // and a skill environment-wide cap at one period aliased onto one row and
    // the second declaration silently replaced the first.
    expect(collisionKey(target({ tier: "llm" }), "day")).not.toBe(
      collisionKey(target({ tier: "skill" }), "day"),
    );
  });

  it("separates two caps that differ only by skill", () => {
    expect(
      collisionKey(target({ tier: "skill", skillSlug: asCostIdentifier<SkillSlug>("a") }), "day"),
    ).not.toBe(
      collisionKey(target({ tier: "skill", skillSlug: asCostIdentifier<SkillSlug>("b") }), "day"),
    );
  });

  it("separates two caps that differ only by agent", () => {
    expect(collisionKey(target({ agentId: asCostIdentifier<AgentId>("a") }), "day")).not.toBe(
      collisionKey(target({ agentId: null }), "day"),
    );
  });

  it("separates two caps that differ only by period", () => {
    expect(collisionKey(target(), "day")).not.toBe(collisionKey(target(), "month"));
  });

  it("ignores the fields that are not part of identity", () => {
    // A legacy recipient list and an override author are state, not identity;
    // editing either must find the same cap rather than create a second one.
    expect(collisionKey(target({ legacyEmails: "x@example.test" }), "day")).toBe(
      collisionKey(target({ overrideBy: asCostIdentifier<ActorId>("operator-2") }), "day"),
    );
  });
});

describe("naming a target", () => {
  it("distinguishes the wildcard from a named user", () => {
    expect(describeTarget(target({ subject: "user", targetId: EVERY_USER }))).toBe("Every user");
    expect(describeTarget(target({ subject: "user", targetId: "u-1" }))).toBe("User: u-1");
  });

  it("names an agent and the environment", () => {
    expect(describeTarget(target({ subject: "agent", targetId: "a-1" }))).toBe("Agent: a-1");
    expect(describeTarget(target())).toBe("Scope-wide");
  });
});

describe("the closed vocabularies", () => {
  it("recognises exactly the three subjects and two tiers", () => {
    expect(["scope", "agent", "user"].every(isBudgetSubject)).toBe(true);
    expect(isBudgetSubject("team")).toBe(false);
    expect(["llm", "skill"].every(isBudgetTier)).toBe(true);
    expect(isBudgetTier("bgo")).toBe(false);
  });
});
