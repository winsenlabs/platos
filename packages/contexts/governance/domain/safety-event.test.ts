import { describe, expect, it } from "vitest";

import {
  SAFETY_ACTIONS,
  SAFETY_DETECTORS,
  SAFETY_SEVERITIES,
  admitSafetyEvent,
  isSafetyAction,
  isSafetyDetector,
  isSafetySeverity,
} from "./safety-event.js";

// Written as a literal rather than read from the shipped policy: a truncation
// test whose input is `"x".repeat(POLICY.maxDetailLength + 1)` stays green when
// the ceiling moves, which is not a test of the ceiling.
const POLICY = { maxDetailLength: 10, maxPageSize: 200, defaultPageSize: 50, minWindowDays: 1, defaultWindowDays: 30, maxWindowDays: 365 } as const;

function draft(overrides: Record<string, unknown> = {}) {
  return { detector: "pii", action: "redact", severity: "medium", ...overrides } as never;
}

describe("the three closed vocabularies", () => {
  it("names the eight detectors the running system emits", () => {
    expect([...SAFETY_DETECTORS]).toEqual([
      "pii",
      "injection",
      "grounded",
      "exfiltration",
      "tool_param",
      "rate_limit",
      "budget",
      "dispatcher_permission_gate",
    ]);
  });

  it("names four actions and three severities", () => {
    expect([...SAFETY_ACTIONS]).toEqual(["flag", "redact", "block", "warn"]);
    expect([...SAFETY_SEVERITIES]).toEqual(["low", "medium", "high"]);
  });

  it("recognises a member and refuses a near miss", () => {
    expect(isSafetyDetector("pii")).toBe(true);
    expect(isSafetyDetector("PII")).toBe(false);
    expect(isSafetyAction("block")).toBe(true);
    expect(isSafetyAction("blocked")).toBe(false);
    expect(isSafetySeverity("high")).toBe(true);
    expect(isSafetySeverity("HIGH")).toBe(false);
  });
});

describe("admission refuses an unknown vocabulary value", () => {
  it("refuses an unknown DETECTOR with its own code", () => {
    const admitted = admitSafetyEvent(draft({ detector: "vibes" }), POLICY);
    expect(admitted.ok).toBe(false);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_SAFETY_DETECTOR_UNKNOWN");
  });

  it("refuses a case-variant of a real detector — a second bucket is a second phenomenon", () => {
    const admitted = admitSafetyEvent(draft({ detector: "PII" }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_SAFETY_DETECTOR_UNKNOWN");
  });

  it("refuses an unknown ACTION with a DIFFERENT code", () => {
    const admitted = admitSafetyEvent(draft({ action: "blocked" }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_SAFETY_ACTION_UNKNOWN");
  });

  it("refuses an unknown SEVERITY with a THIRD code", () => {
    const admitted = admitSafetyEvent(draft({ severity: "critical" }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_SAFETY_SEVERITY_UNKNOWN");
  });

  it("reports the FIRST failure deterministically when two are wrong", () => {
    const admitted = admitSafetyEvent(draft({ detector: "vibes", severity: "critical" }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_SAFETY_DETECTOR_UNKNOWN");
  });

  it("admits every declared detector, so the closed set is not narrower than it says", () => {
    for (const detector of SAFETY_DETECTORS) {
      expect(admitSafetyEvent(draft({ detector }), POLICY).ok).toBe(true);
    }
  });
});

describe("the detail is truncated, never refused", () => {
  it("keeps a detail at exactly the ceiling whole", () => {
    const admitted = admitSafetyEvent(draft({ detail: "0123456789" }), POLICY);
    expect(admitted.ok && admitted.value.detail).toBe("0123456789");
    expect(admitted.ok && admitted.value.detailTruncated).toBe(false);
  });

  it("cuts one character over the ceiling down to EXACTLY the ceiling", () => {
    const admitted = admitSafetyEvent(draft({ detail: "0123456789X" }), POLICY);
    expect(admitted.ok).toBe(true);
    expect(admitted.ok && admitted.value.detail).toBe("0123456789");
    expect(admitted.ok && admitted.value.detail?.length).toBe(10);
    expect(admitted.ok && admitted.value.detailTruncated).toBe(true);
  });

  it("does NOT refuse the over-long detail — a safety signal must not fail a turn", () => {
    expect(admitSafetyEvent(draft({ detail: "x".repeat(5_000) }), POLICY).ok).toBe(true);
  });

  it("truncates against the ceiling it is GIVEN", () => {
    const admitted = admitSafetyEvent(draft({ detail: "abcdef" }), { ...POLICY, maxDetailLength: 3 });
    expect(admitted.ok && admitted.value.detail).toBe("abc");
  });

  it("leaves an absent detail null rather than an empty string", () => {
    const admitted = admitSafetyEvent(draft(), POLICY);
    expect(admitted.ok && admitted.value.detail).toBeNull();
    expect(admitted.ok && admitted.value.detailTruncated).toBe(false);
  });
});

describe("what an admitted event carries", () => {
  it("defaults every optional foreign key to null rather than to undefined", () => {
    const admitted = admitSafetyEvent(draft(), POLICY);
    expect(admitted.ok && admitted.value).toEqual({
      detector: "pii",
      action: "redact",
      severity: "medium",
      detail: null,
      detailTruncated: false,
      metadata: null,
      agentId: null,
      threadId: null,
      turnId: null,
      principalId: null,
      toolName: null,
      toolCallId: null,
      rule: null,
    });
  });

  it("carries the producer's subject on `principalId`, not on the endUser column", () => {
    // `SafetyEvent.endUserId` is a foreign key to `EndUser.id`; the identifier a
    // producer holds is the caller's external subject. Writing it into the FK
    // would forge a key, so it travels here instead.
    const admitted = admitSafetyEvent(draft({ principalId: "operator-9" }), POLICY);
    expect(admitted.ok && admitted.value.principalId).toBe("operator-9");
    expect(admitted.ok && "endUserId" in admitted.value).toBe(false);
  });
});
