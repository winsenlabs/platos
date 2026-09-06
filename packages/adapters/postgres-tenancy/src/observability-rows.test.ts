// The `AdminAudit` mapping and its guards, WITHOUT a container.
//
// It is here because a container suite can only ever read rows THIS binary
// wrote, and the branches that matter most are the ones a row an OLDER binary
// wrote reaches: a `before` that is not an object root, a `source` nobody
// stated. `observability-constraints.integration.test.ts` plants one of each as
// raw SQL against the real table; this file reaches the rest, and reaches them
// without a daemon so a laptop can run them.
//
// THE GUARDS ARE HERE FOR THE OPPOSITE REASON. Each one refuses a value BEFORE a
// statement is sent, so its behaviour is entirely this package's and a database
// adds nothing to it. What the database adds — that the column would have
// refused the same value, and would have taken the caller's transaction with it
// — is what the constraints suite measures.

import { describe, expect, test } from "vitest";

import { DEFAULT_AUDIT_SOURCE } from "@platos/context-observability/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";
import {
  ADMIN_AUDIT_IMMUTABLE_RAISE,
  AUDIT_ACTOR_BLANK,
  AUDIT_ORGANIZATION_BLANK,
  AUDIT_PAGE_LIMIT_INVALID,
  isAdminAuditImmutable,
  isAuditUuid,
  ObservabilityStoreRefused,
  OBSERVABILITY_IDENTIFIER_NOT_UUID,
  requireAuditActor,
  requireAuditLimit,
  requireAuditUuid,
} from "./observability-guards.js";
import {
  AUDIT_STATE_NOT_AN_OBJECT,
  readAdminAudit,
  readAuditSnapshot,
  readAuditSource,
  environmentWhere,
  organizationWhere,
  type AdminAuditRow,
} from "./observability-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

function row(overrides: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: "bbbbbbbb-0001-4000-8000-000000000001",
    environmentId: "bbbbbbbb-0003-4000-8000-000000000003",
    actorUserId: "operator-1",
    action: "agent.delete",
    subjectType: "Agent",
    subjectId: "agent-7",
    before: { name: "support bot" },
    after: null,
    reason: "retired",
    source: "ui",
    createdAt: AT,
    environment: {
      projectId: "bbbbbbbb-0002-4000-8000-000000000002",
      project: { organizationId: "bbbbbbbb-0000-4000-8000-000000000000" },
    },
    ...overrides,
  };
}

describe("the scope a row does not carry", () => {
  test("the record's scope is rebuilt from the JOINED ancestry, not from the environment column", () => {
    const record = readAdminAudit(row());
    expect(record.scope).toEqual({
      level: "environment",
      organizationId: "bbbbbbbb-0000-4000-8000-000000000000",
      projectId: "bbbbbbbb-0002-4000-8000-000000000002",
      environmentId: "bbbbbbbb-0003-4000-8000-000000000003",
    });
  });

  test("an environment read names all THREE levels, so a mismatched scope matches nothing", () => {
    // The row has one scope column and no ancestry rule. Without the two relation
    // clauses a trail read for one organization would return another's rows
    // whenever the caller passed a foreign environment id.
    const where = environmentWhere({
      level: "environment",
      organizationId: "org" as never,
      projectId: "proj" as never,
      environmentId: "env" as never,
    });
    expect(where).toEqual({
      environmentId: "env",
      environment: { projectId: "proj", project: { organizationId: "org" } },
    });
  });

  test("an actor read walks to the ORGANIZATION, because an erasure is organization-scoped", () => {
    expect(organizationWhere("org-1")).toEqual({
      environment: { project: { organizationId: "org-1" } },
    });
  });
});

describe("the two snapshot columns", () => {
  test("SQL NULL is absence on both columns", () => {
    const record = readAdminAudit(row({ before: null, after: null }));
    expect(record.before).toBeNull();
    expect(record.after).toBeNull();
  });

  test("an object root is carried through unchanged", () => {
    expect(readAuditSnapshot({ maxSteps: 10 }, "before")).toEqual({ maxSteps: 10 });
  });

  test("a value that is NOT an object root is REFUSED on read, not cast", () => {
    // Unreachable through the column's own CHECK, and reachable through a row an
    // older binary wrote. Casting it would put a number where every reader of
    // `AdminAuditRecord` expects a bag of fields.
    expect(() => readAuditSnapshot(42, "before")).toThrow(UnreadableRowError);
    try {
      readAuditSnapshot([1, 2], "after");
      expect.unreachable("an array snapshot must be refused");
    } catch (error) {
      expect((error as UnreadableRowError).code).toBe(AUDIT_STATE_NOT_AN_OBJECT);
      expect((error as UnreadableRowError).column).toBe("AdminAudit.after");
    }
  });

  test("an ARRAY is refused, and that is the migration's own narrower CHECK", () => {
    // Every other `*_json_root` in the initial migration admits `'array'`. These
    // two admit only `'object'`.
    expect(() => readAuditSnapshot([], "before")).toThrow(UnreadableRowError);
  });
});

describe("the source column", () => {
  test("an unstated source reads back as the DOMAIN's default rather than as null", () => {
    // `AdminAudit.source` is nullable and `AdminAuditRecord.source` is not.
    // `DEFAULT_AUDIT_SOURCE` is the domain's own published answer to "what
    // `source` becomes when a caller does not say".
    expect(readAuditSource(null)).toBe(DEFAULT_AUDIT_SOURCE);
    expect(readAdminAudit(row({ source: null })).source).toBe("api");
  });

  test("a stated source is never overwritten by the default", () => {
    expect(readAuditSource("scheduled")).toBe("scheduled");
  });
});

describe("the guards", () => {
  test("the uuid shape is the one the column parses, not a looser hex pattern", () => {
    expect(isAuditUuid("bbbbbbbb-0001-4000-8000-000000000001")).toBe(true);
    expect(isAuditUuid("audit-1")).toBe(false);
    // A version nibble outside 1..8 and a variant outside 8..b are both refused,
    // because `@db.Uuid` parses them and the store would then be storing a value
    // the guard called canonical.
    expect(isAuditUuid("bbbbbbbb-0001-9000-8000-000000000001")).toBe(false);
    expect(isAuditUuid("bbbbbbbb-0001-4000-c000-000000000001")).toBe(false);
  });

  test("a null identifier is always allowed, and a malformed one carries its own code", () => {
    expect(() => requireAuditUuid("AdminAudit.id", null)).not.toThrow();
    try {
      requireAuditUuid("AdminAudit.id", "audit-1");
      expect.unreachable("a non-uuid must be refused");
    } catch (error) {
      expect((error as ObservabilityStoreRefused).code).toBe(OBSERVABILITY_IDENTIFIER_NOT_UUID);
    }
  });

  test("a blank actor and a blank organization are TWO codes, not one", () => {
    const codeOf = (organizationId: string, actorUserId: string): string => {
      try {
        requireAuditActor(organizationId, actorUserId);
        return "ACCEPTED";
      } catch (error) {
        return (error as ObservabilityStoreRefused).code;
      }
    };
    expect(codeOf("org-1", "   ")).toBe(AUDIT_ACTOR_BLANK);
    expect(codeOf("  ", "operator-1")).toBe(AUDIT_ORGANIZATION_BLANK);
    expect(codeOf("org-1", "operator-1")).toBe("ACCEPTED");
    // Two guards that shared a code could not be told apart in a log.
    expect(AUDIT_ACTOR_BLANK).not.toBe(AUDIT_ORGANIZATION_BLANK);
  });

  test("a negative or fractional page size is refused; zero and whole numbers are not", () => {
    // A negative `take` is read by the client as "the last N, in reverse", which
    // answers a newest-first contract with the oldest row and no error anywhere.
    const codeOf = (limit: number): string => {
      try {
        requireAuditLimit(limit);
        return "ACCEPTED";
      } catch (error) {
        return (error as ObservabilityStoreRefused).code;
      }
    };
    expect(codeOf(-1)).toBe(AUDIT_PAGE_LIMIT_INVALID);
    expect(codeOf(2.5)).toBe(AUDIT_PAGE_LIMIT_INVALID);
    expect(codeOf(Number.NaN)).toBe(AUDIT_PAGE_LIMIT_INVALID);
    expect(codeOf(0)).toBe("ACCEPTED");
    expect(codeOf(200)).toBe("ACCEPTED");
  });
});

describe("the database's own refusal", () => {
  test("the append-only raise is recognised by its message, not by SQLSTATE alone", () => {
    // 23514 is `check_violation`, and both `*_json_root` CHECKs on this same
    // table raise it too. Telling "this table cannot be changed" apart from
    // "that column is not an object" is exactly what one shared code destroys.
    expect(isAdminAuditImmutable(new Error(`ERROR: ${ADMIN_AUDIT_IMMUTABLE_RAISE}`))).toBe(true);
    expect(
      isAdminAuditImmutable(new Error("new row violates check constraint AdminAudit_before_json_root")),
    ).toBe(false);
    expect(isAdminAuditImmutable("AdminAudit is immutable")).toBe(false);
  });
});
