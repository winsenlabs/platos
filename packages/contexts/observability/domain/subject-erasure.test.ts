import { asIdentifier, environmentScope, type ErasureSubject } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ADMIN_AUDIT_MODEL,
  addressIsVacuous,
  addressSubject,
  adminAuditActorFor,
  buildSubjectPredicate,
  ERASABLE_MODELS,
  ERASABLE_TABLES,
  ERASURE_METHOD,
  planCoversEveryProjectionTable,
  residueColumns,
} from "./subject-erasure.js";
import { PROJECTION_TABLES } from "./projection-tables.js";

function subject(overrides: Partial<ErasureSubject> = {}): ErasureSubject {
  return {
    subjectKind: "end-user",
    subjectId: "end-user-1",
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    ...overrides,
  };
}

const TURNS = ERASABLE_TABLES[0]!;
const USAGE = ERASABLE_TABLES[3]!;

describe("the plan", () => {
  it("covers every projection table, in canonical order, and no others", () => {
    expect(planCoversEveryProjectionTable()).toBe(true);
    expect(ERASABLE_TABLES.map((entry) => entry.table)).toEqual([...PROJECTION_TABLES]);
  });

  it("names the canonical-store model this context also owns", () => {
    expect(ERASABLE_MODELS).toContain(ADMIN_AUDIT_MODEL);
    expect(ERASABLE_MODELS).toHaveLength(PROJECTION_TABLES.length + 1);
  });

  it("UNLINKS rather than deletes — the projection and the money survive", () => {
    expect(ERASURE_METHOD).toBe("anonymize");
  });

  it("clears the two plaintext identity columns only where they exist", () => {
    expect(TURNS.cleared.map((column) => column.name)).toEqual([
      "end_user_id",
      "user_display_name",
      "user_email",
    ]);
    expect(USAGE.cleared.map((column) => column.name)).toEqual(["end_user_id"]);
  });

  it("clears a nullable column to null and a defaulted one to empty", () => {
    expect(TURNS.cleared.find((column) => column.name === "user_email")?.to).toBe("null");
    expect(TURNS.cleared.find((column) => column.name === "end_user_id")?.to).toBe("empty");
  });

  it("never clears the pseudonymous key, which policy retains", () => {
    for (const table of ERASABLE_TABLES) {
      expect(table.cleared.map((column) => column.name)).not.toContain(table.subjectHashColumn);
    }
  });
});

describe("addressSubject", () => {
  it("addresses an end-user by its canonical id", () => {
    const address = addressSubject(subject());
    expect(address.endUserIds).toEqual(["end-user-1"]);
    expect(addressIsVacuous(address)).toBe(false);
  });

  it("adds the thread and hash locators a caller discovered", () => {
    const address = addressSubject(subject(), ["thread-1", "thread-2"], ["hash-1"]);
    expect(address.threadIds).toEqual(["thread-1", "thread-2"]);
    expect(address.subjectKeyHashes).toEqual(["hash-1"]);
  });

  it("drops a BLANK id before it can widen a predicate to the whole tenant", () => {
    const address = addressSubject(subject({ subjectId: "   " }), ["", "   "], [""]);
    expect(address.endUserIds).toEqual([]);
    expect(address.threadIds).toEqual([]);
    expect(address.subjectKeyHashes).toEqual([]);
    expect(addressIsVacuous(address)).toBe(true);
  });

  it("de-duplicates repeated locator values", () => {
    const address = addressSubject(subject(), ["thread-1", "thread-1"]);
    expect(address.threadIds).toEqual(["thread-1"]);
  });

  it("gives an operator subject no analytical id locator", () => {
    const address = addressSubject(subject({ subjectKind: "user", subjectId: "user-1" }));
    expect(address.endUserIds).toEqual([]);
    expect(addressIsVacuous(address)).toBe(true);
  });

  it("gives an entity subject no locator at all", () => {
    expect(addressIsVacuous(addressSubject(subject({ subjectKind: "entity" })))).toBe(true);
  });

  it("carries the organization the erasure is scoped to", () => {
    expect(addressSubject(subject()).organizationId).toBe("org-1");
  });
});

describe("buildSubjectPredicate", () => {
  it("ORs every locator the address supplies", () => {
    const predicate = buildSubjectPredicate(TURNS, addressSubject(subject(), ["thread-1"], ["hash-1"]));
    expect(predicate?.locators.map((locator) => locator.column)).toEqual([
      "end_user_id",
      "thread_id",
      "subject_key_hash",
    ]);
  });

  it("omits a locator the address has no values for", () => {
    const predicate = buildSubjectPredicate(TURNS, addressSubject(subject()));
    expect(predicate?.locators).toHaveLength(1);
    expect(predicate?.locators[0]?.column).toBe("end_user_id");
  });

  it("returns NULL for a vacuous address rather than a tenant-wide predicate", () => {
    const vacuous = addressSubject(subject({ subjectKind: "entity" }));
    expect(buildSubjectPredicate(TURNS, vacuous)).toBeNull();
  });

  it("carries the residue clause, without which verification is a tautology", () => {
    const predicate = buildSubjectPredicate(TURNS, addressSubject(subject()));
    expect(residueColumns(predicate!)).toEqual(["end_user_id", "user_display_name", "user_email"]);
  });

  it("never puts the retained hash column in the residue clause", () => {
    for (const table of ERASABLE_TABLES) {
      const predicate = buildSubjectPredicate(table, addressSubject(subject(), [], ["hash-1"]));
      expect(residueColumns(predicate!)).not.toContain(table.subjectHashColumn);
    }
  });

  it("scopes every predicate to one organization", () => {
    expect(buildSubjectPredicate(TURNS, addressSubject(subject()))?.organizationId).toBe("org-1");
  });

  it("can address a subject by thread alone, for rows whose id column was blank", () => {
    const address = addressSubject(subject({ subjectKind: "user", subjectId: "user-1" }), ["thread-9"]);
    const predicate = buildSubjectPredicate(TURNS, address);
    expect(predicate?.locators).toEqual([{ column: "thread_id", values: ["thread-9"] }]);
  });
});

describe("adminAuditActorFor", () => {
  it("addresses an operator subject", () => {
    expect(adminAuditActorFor(subject({ subjectKind: "user", subjectId: "user-1" }))).toBe("user-1");
  });

  it("gives an end-user no actor: an end user never performed an admin action", () => {
    expect(adminAuditActorFor(subject())).toBeNull();
  });

  it("gives an entity no actor", () => {
    expect(adminAuditActorFor(subject({ subjectKind: "entity" }))).toBeNull();
  });

  it("refuses a blank actor id", () => {
    expect(adminAuditActorFor(subject({ subjectKind: "user", subjectId: "  " }))).toBeNull();
  });
});
