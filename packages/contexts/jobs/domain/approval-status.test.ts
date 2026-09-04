import { describe, expect, it } from "vitest";

import {
  APPROVAL_SOURCES,
  APPROVAL_STATUSES,
  fromStoredStatus,
  isDecision,
  isKnownSource,
  STORED_APPROVAL_STATUSES,
  toStoredStatus,
} from "./approval-status.js";

describe("the status vocabularies", () => {
  it("pins the caller-facing set", () => {
    expect([...APPROVAL_STATUSES]).toEqual(["pending", "approved", "rejected", "timed_out"]);
  });

  it("pins the persisted enum", () => {
    expect([...STORED_APPROVAL_STATUSES]).toEqual(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);
  });
});

describe("the mapping", () => {
  it("maps timed_out to EXPIRED — the pair that does NOT match by name", () => {
    expect(toStoredStatus("timed_out")).toBe("EXPIRED");
    expect(fromStoredStatus("EXPIRED")).toBe("timed_out");
  });

  it("is NOT a simple upper-case of the caller-facing name", () => {
    expect(toStoredStatus("timed_out")).not.toBe("TIMED_OUT");
  });

  it.each(["pending", "approved", "rejected", "timed_out"] as const)(
    "round-trips %s to storage and back",
    (status) => {
      expect(fromStoredStatus(toStoredStatus(status))).toBe(status);
    },
  );

  it.each(["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const)(
    "round-trips the stored value %s and back",
    (stored) => {
      const parsed = fromStoredStatus(stored);
      expect(parsed).not.toBeNull();
      expect(toStoredStatus(parsed as (typeof APPROVAL_STATUSES)[number])).toBe(stored);
    },
  );

  it("covers every member of both vocabularies with the round-trip cases above", () => {
    // The two `it.each` tables are literals so the census can count them; this
    // guards the literals against the exported sets growing underneath them.
    expect(APPROVAL_STATUSES).toHaveLength(4);
    expect(STORED_APPROVAL_STATUSES).toHaveLength(4);
  });

  it("returns null for an unknown stored value rather than defaulting to pending", () => {
    // The live `publicStatus` defaults its switch, which would report an
    // unrecognised row as a decision nobody will ever see.
    expect(fromStoredStatus("REVOKED")).toBeNull();
    expect(fromStoredStatus("")).toBeNull();
  });

  it("is not fooled by a prototype key", () => {
    expect(fromStoredStatus("constructor")).toBeNull();
    expect(fromStoredStatus("toString")).toBeNull();
  });
});

describe("isDecision", () => {
  it("treats pending as the absence of a decision", () => {
    expect(isDecision("pending")).toBe(false);
  });

  it.each(["approved", "rejected", "timed_out"] as const)("treats %s as a decision", (status) => {
    expect(isDecision(status)).toBe(true);
  });
});

describe("sources", () => {
  it("pins the known set", () => {
    expect([...APPROVAL_SOURCES]).toEqual(["request_approval", "cancel_run", "mcp_tool_call"]);
  });

  it("recognises a known source", () => {
    expect(isKnownSource("mcp_tool_call")).toBe(true);
  });

  it("does not recognise an unknown one — the set is OPEN, so it is carried, not refused", () => {
    expect(isKnownSource("some_future_source")).toBe(false);
  });
});
