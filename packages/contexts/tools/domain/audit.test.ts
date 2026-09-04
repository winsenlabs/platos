import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitAuditQuery,
  auditLatency,
  auditStatusFor,
  auditWindowStart,
  byAuditOrder,
  DEFAULT_AUDIT_PAGE,
  DEFAULT_AUDIT_WINDOW_DAYS,
  EMPTY_AUDIT_ENVELOPE,
  MAX_AUDIT_PAGE,
  SENSITIVE_AUDIT_FIELDS,
  type AuditEntry,
} from "./audit.js";
import { asToolsIdentifier, type ToolCallAuditId, type ToolName } from "./identifiers.js";

const AT = new Date("2026-01-10T00:00:00.000Z");

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    toolCallAuditId: asToolsIdentifier<ToolCallAuditId>("audit-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    toolId: null,
    toolName: asToolsIdentifier<ToolName>("files.upload"),
    agentId: null,
    threadId: null,
    endUserId: null,
    traceId: null,
    arguments: {},
    result: null,
    error: null,
    status: "SUCCEEDED",
    latencyMs: 10,
    costCents: null,
    envelope: EMPTY_AUDIT_ENVELOPE,
    createdAt: AT,
    ...overrides,
  };
}

describe("mapping a dispatch outcome onto the audit column", () => {
  it("collapses a timeout into FAILED, because WorkStatus has no timeout member", () => {
    expect(auditStatusFor("success")).toBe("SUCCEEDED");
    expect(auditStatusFor("failed")).toBe("FAILED");
    expect(auditStatusFor("timeout")).toBe("FAILED");
  });
});

describe("the latency column", () => {
  it("is a non-negative integer, whatever was measured", () => {
    expect(auditLatency(12.6)).toBe(13);
    expect(auditLatency(-500)).toBe(0);
    expect(auditLatency(0)).toBe(0);
  });
});

describe("admitting a query", () => {
  it("clamps rather than refusing, because this is a diagnostic surface", () => {
    expect(admitAuditQuery({ limit: 10_000 }).limit).toBe(MAX_AUDIT_PAGE);
    expect(admitAuditQuery({ limit: 0 }).limit).toBe(1);
    expect(admitAuditQuery({ offset: -5 }).offset).toBe(0);
    expect(admitAuditQuery({ sinceDays: 0 }).sinceDays).toBe(1);
  });

  it("supplies the transcribed defaults", () => {
    const admitted = admitAuditQuery({});
    expect(admitted.limit).toBe(DEFAULT_AUDIT_PAGE);
    expect(admitted.sinceDays).toBe(DEFAULT_AUDIT_WINDOW_DAYS);
    expect(admitted.offset).toBe(0);
    expect(admitted.toolName).toBeNull();
  });

  it("truncates a fractional page rather than passing it to the store", () => {
    expect(admitAuditQuery({ limit: 12.9, offset: 3.7 })).toMatchObject({ limit: 12, offset: 3 });
  });
});

describe("the window", () => {
  it("is computed from a supplied instant, never from the wall clock", () => {
    const start = auditWindowStart(admitAuditQuery({ sinceDays: 2 }), AT);
    expect(start.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("listing order", () => {
  it("is newest first", () => {
    const older = entry({ createdAt: new Date(AT.getTime() - 1000) });
    expect(byAuditOrder(entry(), older)).toBeLessThan(0);
  });

  it("is TOTAL, which matters because a parallel batch writes several per millisecond", () => {
    const left = entry({ toolCallAuditId: asToolsIdentifier<ToolCallAuditId>("audit-1") });
    const right = entry({ toolCallAuditId: asToolsIdentifier<ToolCallAuditId>("audit-2") });
    expect(byAuditOrder(left, right)).toBeLessThan(0);
    expect(byAuditOrder(right, left)).toBeGreaterThan(0);
    expect(byAuditOrder(left, left)).toBe(0);
  });
});

describe("what the row declares as sensitive", () => {
  it("names exactly the two Json columns the source seals", () => {
    expect([...SENSITIVE_AUDIT_FIELDS]).toEqual(["arguments", "result"]);
  });

  it("does NOT include `error`, and the gap is deliberate rather than forgotten", () => {
    // `error` is a String column, so the crypto envelope does not fit it. That
    // is a real gap and it is recorded rather than quietly closed here —
    // closing it is a storage change, not a domain one.
    expect(SENSITIVE_AUDIT_FIELDS as readonly string[]).not.toContain("error");
  });
});

describe("the envelope", () => {
  it("starts entirely empty, because every field is absent on some real path", () => {
    expect(Object.values(EMPTY_AUDIT_ENVELOPE).every((value) => value === null)).toBe(true);
  });
});
