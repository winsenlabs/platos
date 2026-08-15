import { describe, it, expect } from "vitest";
import {
  CANONICAL_TABLES, SUBJECT_USERID_TABLES, OPERATOR_USERID_TABLES,
  isSubjectUserIdTable, isOperatorTable, mergeSubjectKeys, isEmptySubject, subjectKeyHash,
} from "./subject-graph";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the operator/subject boundary", () => {
  it("NEVER treats operator tables as subject tables", () => {
    // Deleting by userId across every table with that column would destroy a
    // dashboard login, its access tokens and its MFA recovery codes while
    // claiming to serve a customer erasure request.
    for (const t of OPERATOR_USERID_TABLES) {
      expect(isOperatorTable(t)).toBe(true);
      expect(isSubjectUserIdTable(t)).toBe(false);
    }
  });

  it("the two sets never overlap", () => {
    const overlap = SUBJECT_USERID_TABLES.filter((t) => (OPERATOR_USERID_TABLES as readonly string[]).includes(t));
    expect(overlap).toEqual([]);
  });

  it("named operator tables are explicitly excluded", () => {
    for (const t of ["OrgMember", "MfaBackupCode", "PlatosPAT", "PlatosOAuthAccessToken"]) {
      expect(isSubjectUserIdTable(t)).toBe(false);
    }
  });

  it("an unknown table is not swept by default", () => {
    // Fail closed: a table added later is not silently included.
    expect(isSubjectUserIdTable("SomeNewTable")).toBe(false);
    expect(isOperatorTable("SomeNewTable")).toBe(false);
  });
});

describe("canonical coverage", () => {
  it("covers every model that carries platosEndUserId", () => {
    // Verified against the Prisma schema. A userId-keyed delete reaches none of
    // these by that path, which is the original defect.
    for (const t of ["PlatosAgentThread","PlatosChannelAppThread","PlatosChannelThread",
                     "PlatosMemory","PlatosToolCallAudit","PlatosEndUserIdentity"]) {
      expect(CANONICAL_TABLES).toContain(t as any);
    }
  });
});

describe("mergeSubjectKeys", () => {
  const s1 = { organizationId: "o1", projectId: "p1", environmentId: "e1" };
  const s2 = { organizationId: "o1", projectId: "p2", environmentId: "e2" };

  it("unions handles found by different routes", () => {
    const m = mergeSubjectKeys(
      { platosEndUserIds: ["eu1"], scopes: [s1] },
      { legacyUserIds: ["legacy-a"], scopes: [s2] },
      { platosEndUserIds: ["eu2"] },
    );
    expect(m.platosEndUserIds).toEqual(["eu1", "eu2"]);
    expect(m.legacyUserIds).toEqual(["legacy-a"]);
    expect(m.scopes).toHaveLength(2);
  });

  it("de-duplicates scopes and ids", () => {
    const m = mergeSubjectKeys({ platosEndUserIds: ["eu1","eu1"], scopes: [s1, s1] });
    expect(m.platosEndUserIds).toEqual(["eu1"]);
    expect(m.scopes).toHaveLength(1);
  });

  it("is order-independent — a retry must produce the identical key set", () => {
    // Idempotency depends on this: two runs over one person must be comparable.
    const a = mergeSubjectKeys({ platosEndUserIds: ["b","a"], scopes: [s2, s1] });
    const b = mergeSubjectKeys({ platosEndUserIds: ["a","b"], scopes: [s1, s2] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("drops malformed scopes rather than emitting a partial tuple", () => {
    const m = mergeSubjectKeys({ scopes: [{ organizationId: "o", projectId: "", environmentId: "e" } as any] });
    expect(m.scopes).toEqual([]);
  });

  it("tolerates null/undefined inputs", () => {
    expect(isEmptySubject(mergeSubjectKeys(null, undefined, {}))).toBe(true);
  });
});

describe("isEmptySubject", () => {
  it("is true when nothing resolved — caller must NOT report success", () => {
    expect(isEmptySubject({ platosEndUserIds: [], legacyUserIds: [], scopes: [] })).toBe(true);
  });
  it("is false when any handle resolved", () => {
    expect(isEmptySubject({ platosEndUserIds: [], legacyUserIds: ["u"], scopes: [] })).toBe(false);
  });
});

describe("subjectKeyHash — receipts must not recreate the personal data", () => {
  it("is stable for the same subject", () => {
    expect(subjectKeyHash("user@example.com", "org1", "salt", sha))
      .toBe(subjectKeyHash("user@example.com", "org1", "salt", sha));
  });

  it("never contains the raw identifier", () => {
    const h = subjectKeyHash("user@example.com", "org1", "salt", sha);
    expect(h).not.toContain("user@example.com");
    expect(h).not.toContain("example");
  });

  it("is scoped per organization — the same person is not correlatable across tenants", () => {
    expect(subjectKeyHash("u", "orgA", "salt", sha)).not.toBe(subjectKeyHash("u", "orgB", "salt", sha));
  });

  it("is salted — an unsalted hash of an email is trivially reversible", () => {
    expect(subjectKeyHash("u", "o", "salt1", sha)).not.toBe(subjectKeyHash("u", "o", "salt2", sha));
  });
});
