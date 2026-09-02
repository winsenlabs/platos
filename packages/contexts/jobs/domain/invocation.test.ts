import { describe, expect, it } from "vitest";

import {
  authorizeAgent,
  authorizeInvocation,
  CLAIMED_INVOKERS,
  invokerMayStart,
  isClaimedInvoker,
  isStoredInvocationType,
  parseStoredInvocationType,
  STORED_INVOCATION_TYPES,
  type ClaimedInvoker,
  type StoredInvocationType,
} from "./invocation.js";

describe("the two invocation vocabularies", () => {
  it("pins the stored set to the live enum", () => {
    expect([...STORED_INVOCATION_TYPES]).toEqual(["manual", "schedule", "webhook", "agent-spawn"]);
  });

  it("pins the claimed set to the live enum", () => {
    expect([...CLAIMED_INVOKERS]).toEqual(["agent", "manual", "schedule", "webhook"]);
  });

  it("REFUSES to store `agent` — it is an invoker, never a row value", () => {
    expect(isStoredInvocationType("agent")).toBe(false);
    expect(parseStoredInvocationType("agent").ok).toBe(false);
  });

  it("REFUSES to claim `agent-spawn` — it is a row value, never an invoker", () => {
    expect(isClaimedInvoker("agent-spawn")).toBe(false);
  });

  it("rejects an unknown invocation type with the permitted set in the error", () => {
    const parsed = parseStoredInvocationType("cron");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.error.code).toBe("JOBS_INVOCATION_TYPE_INVALID");
    expect(parsed.error.details["permitted"]).toEqual([...STORED_INVOCATION_TYPES]);
  });
});

describe("invokerMayStart — the complete acceptance table", () => {
  // Every accepted (claimed, stored) pair, stated exhaustively as a literal so
  // the rule is readable as a table and the test-case census can count it.
  it.each([
    ["agent", "agent-spawn"],
    ["manual", "manual"],
    ["schedule", "schedule"],
    ["webhook", "webhook"],
  ] as const)("accepts %s -> %s", (invoker: ClaimedInvoker, stored: StoredInvocationType) => {
    expect(invokerMayStart(invoker, stored)).toBe(true);
  });

  it("accepts EXACTLY four of the sixteen pairs", () => {
    const accepted = CLAIMED_INVOKERS.flatMap((invoker) =>
      STORED_INVOCATION_TYPES.filter((stored) => invokerMayStart(invoker, stored)).map(
        (stored) => `${invoker}->${stored}`,
      ),
    );
    expect(accepted.sort()).toEqual(
      ["agent->agent-spawn", "manual->manual", "schedule->schedule", "webhook->webhook"].sort(),
    );
  });

  it("REFUSES a manual caller starting an agent-spawn job", () => {
    expect(invokerMayStart("manual", "agent-spawn")).toBe(false);
  });

  it("REFUSES an agent starting a manual job", () => {
    expect(invokerMayStart("agent", "manual")).toBe(false);
  });

  it("REFUSES an agent starting a webhook job", () => {
    expect(invokerMayStart("agent", "webhook")).toBe(false);
  });

  it("REFUSES a webhook caller starting a scheduled job", () => {
    expect(invokerMayStart("webhook", "schedule")).toBe(false);
  });
});

describe("authorizeInvocation", () => {
  it("returns the stored type when the pair is accepted", () => {
    const decision = authorizeInvocation("agent", "agent-spawn");
    expect(decision).toEqual({ ok: true, value: "agent-spawn" });
  });

  it("refuses with the live JOB_NOT_AUTHORIZED code and both sides in details", () => {
    const decision = authorizeInvocation("manual", "webhook");
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("JOB_NOT_AUTHORIZED");
    expect(decision.error.category).toBe("forbidden");
    expect(decision.error.details).toMatchObject({ invokedBy: "manual", invocationType: "webhook" });
  });
});

describe("authorizeAgent — the allow-list", () => {
  it("permits any agent when the list is EMPTY (the column default)", () => {
    expect(authorizeAgent("agent", [], "agent-9").ok).toBe(true);
  });

  it("permits a listed agent", () => {
    expect(authorizeAgent("agent", ["agent-1", "agent-2"], "agent-2").ok).toBe(true);
  });

  it("REFUSES an unlisted agent once the list is populated", () => {
    const decision = authorizeAgent("agent", ["agent-1"], "agent-2");
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("JOB_NOT_AUTHORIZED");
  });

  it("REFUSES an agent dispatch carrying no agent id against a populated list", () => {
    expect(authorizeAgent("agent", ["agent-1"], null).ok).toBe(false);
  });

  it("does NOT filter a non-agent dispatch, even against a populated list", () => {
    expect(authorizeAgent("manual", ["agent-1"], null).ok).toBe(true);
    expect(authorizeAgent("schedule", ["agent-1"], "agent-2").ok).toBe(true);
  });
});
