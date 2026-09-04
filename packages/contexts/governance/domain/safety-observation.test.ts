import { asIdentifier, environmentScope, type PrincipalId, type SafetyObservation, type SafetyOutcome } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { OUTCOME_ACTIONS, OUTCOME_SEVERITIES, draftFromObservation, parseRuleIdentity } from "./safety-observation.js";

const SCOPE = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const OBSERVED_AT = new Date("2026-03-01T12:00:00.000Z");

function observation(overrides: Partial<SafetyObservation> = {}): SafetyObservation {
  return {
    rule: "identity.rate_limit.exceeded",
    outcome: "blocked",
    scope: SCOPE,
    principalId: asIdentifier<PrincipalId>("principal-1"),
    observedAt: OBSERVED_AT,
    details: { bucket: "per-principal" },
    ...overrides,
  };
}

describe("parseRuleIdentity", () => {
  it("reads the kernel port's own example", () => {
    const parsed = parseRuleIdentity("identity.rate_limit.exceeded");
    expect(parsed.ok && parsed.value).toEqual({
      producer: "identity",
      detector: "rate_limit",
      verdict: "exceeded",
    });
  });

  it("keeps a fourth segment on the verdict rather than refusing it", () => {
    const parsed = parseRuleIdentity("identity.rate_limit.exceeded.burst");
    expect(parsed.ok && parsed.value.verdict).toBe("exceeded.burst");
  });

  it("REFUSES a rule with fewer than three segments", () => {
    const parsed = parseRuleIdentity("rate_limit.exceeded");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.code).toBe("GOVERNANCE_SAFETY_RULE_MALFORMED");
  });

  it("REFUSES a rule with an empty segment", () => {
    expect(parseRuleIdentity("identity..exceeded").ok).toBe(false);
    expect(parseRuleIdentity(".rate_limit.exceeded").ok).toBe(false);
    expect(parseRuleIdentity("identity.rate_limit.").ok).toBe(false);
  });

  it("REFUSES a well-formed rule naming a detector the ledger has no bucket for", () => {
    const parsed = parseRuleIdentity("identity.vibes.exceeded");
    expect(parsed.ok).toBe(false);
    // A DIFFERENT code from the malformed one: a producer that never adopted the
    // format and a producer naming an unregistered detector are different bugs.
    expect(!parsed.ok && parsed.error.code).toBe("GOVERNANCE_SAFETY_DETECTOR_UNKNOWN");
  });

  it("takes the detector from the SECOND segment, not from the first", () => {
    // `budget` is a real detector and `identity` is not, so a reader taking the
    // first segment would refuse this and a reader taking the second admits it.
    const parsed = parseRuleIdentity("identity.budget.exhausted");
    expect(parsed.ok && parsed.value.detector).toBe("budget");
  });
});

describe("the outcome maps are total", () => {
  const EVERY_OUTCOME: readonly SafetyOutcome[] = ["allowed", "blocked", "held", "redacted"];

  it("maps every kernel outcome to a ledger action", () => {
    expect(OUTCOME_ACTIONS).toEqual({
      allowed: "flag",
      blocked: "block",
      held: "warn",
      redacted: "redact",
    });
    for (const outcome of EVERY_OUTCOME) expect(OUTCOME_ACTIONS[outcome]).toBeDefined();
  });

  it("maps every kernel outcome to a severity", () => {
    expect(OUTCOME_SEVERITIES).toEqual({
      allowed: "low",
      blocked: "high",
      held: "high",
      redacted: "medium",
    });
  });

  it("gives a HELD request the same severity as a blocked one", () => {
    // Both stopped the caller getting what it asked for; only the remedy differs.
    expect(OUTCOME_SEVERITIES.held).toBe(OUTCOME_SEVERITIES.blocked);
  });

  it("does not collapse held INTO blocked on the action axis", () => {
    expect(OUTCOME_ACTIONS.held).not.toBe(OUTCOME_ACTIONS.blocked);
  });
});

describe("draftFromObservation", () => {
  it("translates the rate-limit guard's observation, which is why this port exists", () => {
    const draft = draftFromObservation(observation());
    expect(draft.ok && draft.value.detector).toBe("rate_limit");
    expect(draft.ok && draft.value.action).toBe("block");
    expect(draft.ok && draft.value.severity).toBe("high");
  });

  it("carries the producer's principal through", () => {
    const draft = draftFromObservation(observation());
    expect(draft.ok && draft.value.principalId).toBe("principal-1");
  });

  it("keeps a null principal null rather than inventing one", () => {
    const draft = draftFromObservation(observation({ principalId: null }));
    expect(draft.ok && draft.value.principalId).toBeNull();
  });

  it("preserves the kernel's OWN words, so the mapping loses nothing", () => {
    const draft = draftFromObservation(observation({ outcome: "held" }));
    expect(draft.ok && draft.value.metadata).toEqual({
      bucket: "per-principal",
      __outcome: "held",
      __producer: "identity",
      __verdict: "exceeded",
    });
    expect(draft.ok && draft.value.rule).toBe("identity.rate_limit.exceeded");
  });

  it("carries the producer's already-redacted details through untouched", () => {
    const draft = draftFromObservation(observation({ details: { a: 1, b: "two", c: null } }));
    expect(draft.ok && draft.value.metadata?.["a"]).toBe(1);
    expect(draft.ok && draft.value.metadata?.["b"]).toBe("two");
    expect(draft.ok && draft.value.metadata?.["c"]).toBeNull();
  });

  it("never sets `detail` — the port carries structure, not prose", () => {
    const draft = draftFromObservation(observation());
    expect(draft.ok && draft.value.detail).toBeNull();
  });

  it("REFUSES a malformed rule rather than filing the event under a guess", () => {
    const draft = draftFromObservation(observation({ rule: "nope" }));
    expect(draft.ok).toBe(false);
    expect(!draft.ok && draft.error.code).toBe("GOVERNANCE_SAFETY_RULE_MALFORMED");
  });

  it("translates all four outcomes without failing for want of a mapping", () => {
    for (const outcome of ["allowed", "blocked", "held", "redacted"] as const) {
      const draft = draftFromObservation(observation({ outcome }));
      expect(draft.ok).toBe(true);
      expect(draft.ok && draft.value.action).toBe(OUTCOME_ACTIONS[outcome]);
      expect(draft.ok && draft.value.severity).toBe(OUTCOME_SEVERITIES[outcome]);
    }
  });
});
