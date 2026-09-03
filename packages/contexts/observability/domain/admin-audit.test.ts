import { asIdentifier, environmentScope, type EnvironmentScope, type PrincipalId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  AUDIT_STATE_MAX_BYTES,
  buildAdminAuditRecord,
  DEFAULT_AUDIT_SOURCE,
  readAuditState,
  recordsAStateChange,
  resolveAuditLimit,
  type AdminActionRequest,
} from "./admin-audit.js";
import type { AdminAuditId } from "./identifiers.js";

const AUDIT_ID = asIdentifier<AdminAuditId>("audit-0001");
const RECORDED_AT = new Date("2026-01-01T00:00:00.000Z");

function scope(): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
}

function request(overrides: Partial<AdminActionRequest> = {}): AdminActionRequest {
  return {
    scope: scope(),
    actorUserId: asIdentifier<PrincipalId>("user-1"),
    action: "agent.delete",
    subjectType: "Agent",
    subjectId: "agent-1",
    ...overrides,
  };
}

describe("buildAdminAuditRecord", () => {
  it("builds a frozen record from a well-formed request", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request(), RECORDED_AT);
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.action).toBe("agent.delete");
    expect(built.value.subjectType).toBe("Agent");
    expect(built.value.recordedAt).toEqual(RECORDED_AT);
    expect(Object.isFrozen(built.value)).toBe(true);
  });

  it("keeps an absent actor absent rather than backfilling one", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request({ actorUserId: null }), RECORDED_AT);
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.actorUserId).toBeNull();
  });

  it("defaults the source rather than leaving it empty", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request(), RECORDED_AT);
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.source).toBe(DEFAULT_AUDIT_SOURCE);
  });

  it("keeps an installation's own source word", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request({ source: "scheduled" }), RECORDED_AT);
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.source).toBe("scheduled");
  });

  it("refuses an empty action", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request({ action: "   " }), RECORDED_AT);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("OBSERVABILITY_AUDIT_ACTION_INVALID");
  });

  it("refuses an action that is not a dotted lower-case name", () => {
    for (const action of ["Agent.Delete", "agent delete", "agent..delete", "1agent"]) {
      const built = buildAdminAuditRecord(AUDIT_ID, request({ action }), RECORDED_AT);
      expect(built.ok).toBe(false);
    }
  });

  it("accepts the dotted, dashed and underscored spellings the live actions use", () => {
    for (const action of ["agent.delete", "entity.secret.rotate", "memory.import-replace", "skills.enable"]) {
      expect(buildAdminAuditRecord(AUDIT_ID, request({ action }), RECORDED_AT).ok).toBe(true);
    }
  });

  it("refuses an empty subject type", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request({ subjectType: "" }), RECORDED_AT);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("OBSERVABILITY_AUDIT_SUBJECT_INVALID");
  });

  it("collapses a blank subject id and reason to null", () => {
    const built = buildAdminAuditRecord(
      AUDIT_ID,
      request({ subjectId: "  ", reason: "   " }),
      RECORDED_AT,
    );
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.subjectId).toBeNull();
    expect(built.value.reason).toBeNull();
  });

  it("stores an object-root before/after snapshot", () => {
    const built = buildAdminAuditRecord(
      AUDIT_ID,
      request({ before: { name: "old" }, after: { name: "new" } }),
      RECORDED_AT,
    );
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.before).toEqual({ name: "old" });
    expect(recordsAStateChange(built.value)).toBe(true);
  });

  it("refuses a scalar or an array snapshot rather than wrapping it", () => {
    for (const before of ["deleted", 42, true, ["a"]]) {
      const built = buildAdminAuditRecord(AUDIT_ID, request({ before }), RECORDED_AT);
      expect(built.ok).toBe(false);
      if (built.ok) throw new Error("unreachable");
      expect(built.error.code).toBe("OBSERVABILITY_AUDIT_STATE_NOT_AN_OBJECT");
    }
  });

  it("refuses JSON null, which the shape registry says is not an absent value", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request({ after: null }), RECORDED_AT);
    expect(built.ok).toBe(false);
  });

  it("treats an omitted snapshot as absent, which is legitimate", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request(), RECORDED_AT);
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.before).toBeNull();
    expect(built.value.after).toBeNull();
    expect(recordsAStateChange(built.value)).toBe(false);
  });

  it("refuses a snapshot larger than the cap, so the table stays queryable", () => {
    const before = { prompt: "x".repeat(AUDIT_STATE_MAX_BYTES + 10) };
    const built = buildAdminAuditRecord(AUDIT_ID, request({ before }), RECORDED_AT);
    expect(built.ok).toBe(false);
  });

  it("truncates an over-long reason rather than refusing the whole record", () => {
    const built = buildAdminAuditRecord(AUDIT_ID, request({ reason: "y".repeat(900) }), RECORDED_AT);
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.reason).toHaveLength(512);
  });
});

describe("readAuditState", () => {
  it("accepts an object root", () => {
    const read = readAuditState({ a: 1 }, "before");
    expect(read.ok).toBe(true);
  });

  it("accepts absence", () => {
    const read = readAuditState(undefined, "after");
    if (!read.ok) throw new Error(read.error.code);
    expect(read.value).toBeNull();
  });

  it("names the field it refused", () => {
    const read = readAuditState(7, "after");
    if (read.ok) throw new Error("unreachable");
    expect(read.error.fields[0]?.field).toBe("after");
  });
});

describe("resolveAuditLimit", () => {
  it("defaults an absent limit", () => {
    expect(resolveAuditLimit(undefined)).toBe(AUDIT_PAGE_DEFAULT);
    expect(resolveAuditLimit(null)).toBe(AUDIT_PAGE_DEFAULT);
  });

  it("caps a limit larger than the page maximum", () => {
    expect(resolveAuditLimit(10_000)).toBe(AUDIT_PAGE_MAX);
  });

  it("keeps a reasonable limit", () => {
    expect(resolveAuditLimit(10)).toBe(10);
  });

  it("defaults a limit that is not a positive count", () => {
    expect(resolveAuditLimit(0)).toBe(AUDIT_PAGE_DEFAULT);
    expect(resolveAuditLimit(-5)).toBe(AUDIT_PAGE_DEFAULT);
    expect(resolveAuditLimit(Number.NaN)).toBe(AUDIT_PAGE_DEFAULT);
  });
});
