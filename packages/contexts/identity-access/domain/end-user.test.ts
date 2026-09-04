import { describe, expect, it } from "vitest";

import { asIdentifier, type OrganizationId } from "@platos/kernel";

import {
  DEFAULT_END_USER_PAGE_SIZE,
  MAX_END_USER_PAGE_SIZE,
  MAX_END_USER_SEARCH_LENGTH,
  compareEndUsers,
  matchesEndUserQuery,
  planEndUserPage,
  type EndUserQuery,
  type EndUserRecord,
  type EndUserWithIdentities,
} from "./end-user.js";
import type { EndUserId, EndUserIdentityId } from "./principal.js";

const ACME = asIdentifier<OrganizationId>("acme");
const GLOBEX = asIdentifier<OrganizationId>("globex");
const DISABLED_AT = new Date("2026-02-01T00:00:00.000Z");

function user(id: string, overrides: Partial<EndUserRecord> = {}): EndUserRecord {
  return {
    endUserId: asIdentifier<EndUserId>(id),
    organizationId: ACME,
    displayName: id,
    disabledAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function withIdentity(row: EndUserRecord, subject: string): EndUserWithIdentities {
  return {
    user: row,
    identities: [
      {
        identityId: asIdentifier<EndUserIdentityId>(`${row.endUserId}-identity`),
        endUserId: row.endUserId,
        issuer: "slack",
        channel: "slack",
        subject,
        verifiedAt: null,
        disabledAt: null,
      },
    ],
  };
}

function query(overrides: Partial<EndUserQuery> = {}): EndUserQuery {
  return {
    organizationId: ACME,
    status: null,
    search: null,
    limit: DEFAULT_END_USER_PAGE_SIZE,
    offset: 0,
    ...overrides,
  };
}

describe("planEndUserPage", () => {
  it("defaults to the oracle's page size and no filtering", () => {
    const planned = planEndUserPage(ACME, {});
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toEqual({
      organizationId: ACME,
      status: null,
      search: null,
      limit: DEFAULT_END_USER_PAGE_SIZE,
      offset: 0,
    });
  });

  it("puts the AUTHORIZED organization on the query, whatever the request says", () => {
    // The request type has no tenant field, so this is not a filter that could
    // be overridden — it is the only way an organization reaches the query.
    const planned = planEndUserPage(GLOBEX, { search: "acme" });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.organizationId).toBe(GLOBEX);
  });

  it("REFUSES A STATUS OUTSIDE THE TWO-VALUE VOCABULARY", async () => {
    for (const status of ["", "ACTIVE", "enabled", "deleted", "active "]) {
      const refusal = planEndUserPage(ACME, { status });
      expect(refusal.ok, status).toBe(false);
      if (refusal.ok) return;
      expect(refusal.error.code).toBe("INVALID_END_USER_FILTER");
      expect(refusal.error.fields[0]?.field).toBe("status");
    }
    expect(planEndUserPage(ACME, { status: "active" }).ok).toBe(true);
    expect(planEndUserPage(ACME, { status: "disabled" }).ok).toBe(true);
  });

  it("REFUSES A PAGE LARGER THAN THE CAP rather than clamping it", async () => {
    // Clamping would tell a caller asking for 500 that it had seen 500 when it
    // had seen 100, so a walk over the results would silently skip four fifths
    // of the tenant.
    const refusal = planEndUserPage(ACME, { limit: MAX_END_USER_PAGE_SIZE + 1 });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.fields[0]?.field).toBe("limit");
    expect(planEndUserPage(ACME, { limit: MAX_END_USER_PAGE_SIZE }).ok).toBe(true);
  });

  it("REFUSES a limit that is zero, negative or not an integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planEndUserPage(ACME, { limit }).ok, String(limit)).toBe(false);
    }
    expect(planEndUserPage(ACME, { limit: 1 }).ok).toBe(true);
  });

  it("REFUSES a negative or fractional offset, and allows zero", () => {
    for (const offset of [-1, 0.5, Number.NaN]) {
      expect(planEndUserPage(ACME, { offset }).ok, String(offset)).toBe(false);
    }
    expect(planEndUserPage(ACME, { offset: 0 }).ok).toBe(true);
    expect(planEndUserPage(ACME, { offset: 25 }).ok).toBe(true);
  });

  it("REFUSES a search term over the length cap", () => {
    expect(planEndUserPage(ACME, { search: "a".repeat(MAX_END_USER_SEARCH_LENGTH) }).ok).toBe(true);
    const refusal = planEndUserPage(ACME, {
      search: "a".repeat(MAX_END_USER_SEARCH_LENGTH + 1),
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.fields[0]?.field).toBe("search");
  });

  it("trims a search term, and a blank one is no search at all", () => {
    const planned = planEndUserPage(ACME, { search: "  ada  " });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.search).toBe("ada");
    const blank = planEndUserPage(ACME, { search: "   " });
    expect(blank.ok).toBe(true);
    if (!blank.ok) return;
    expect(blank.value.search).toBeNull();
  });
});

describe("matchesEndUserQuery", () => {
  it("REFUSES A ROW FROM ANOTHER TENANT, whatever else matches", () => {
    // The clause that is not a filter. It is checked first and unconditionally,
    // so a store that forgot its WHERE cannot produce a cross-tenant answer.
    const foreign = withIdentity(user("mel", { organizationId: GLOBEX }), "U-MEL");
    expect(matchesEndUserQuery(foreign, query())).toBe(false);
    expect(matchesEndUserQuery(foreign, query({ search: "mel" }))).toBe(false);
    expect(matchesEndUserQuery(foreign, query({ status: "active" }))).toBe(false);
    expect(matchesEndUserQuery(foreign, query({ organizationId: GLOBEX }))).toBe(true);
  });

  it("separates active from disabled", () => {
    const live = withIdentity(user("ada"), "U-ADA");
    const gone = withIdentity(user("mel", { disabledAt: DISABLED_AT }), "U-MEL");
    expect(matchesEndUserQuery(live, query({ status: "active" }))).toBe(true);
    expect(matchesEndUserQuery(gone, query({ status: "active" }))).toBe(false);
    expect(matchesEndUserQuery(live, query({ status: "disabled" }))).toBe(false);
    expect(matchesEndUserQuery(gone, query({ status: "disabled" }))).toBe(true);
    // No status means both.
    expect(matchesEndUserQuery(live, query())).toBe(true);
    expect(matchesEndUserQuery(gone, query())).toBe(true);
  });

  it("searches the display name and the identity subject, case-insensitively", () => {
    const row = withIdentity(user("ada", { displayName: "Ada Lovelace" }), "U0ADA123");
    expect(matchesEndUserQuery(row, query({ search: "lovelace" }))).toBe(true);
    expect(matchesEndUserQuery(row, query({ search: "LOVELACE" }))).toBe(true);
    expect(matchesEndUserQuery(row, query({ search: "u0ada" }))).toBe(true);
    expect(matchesEndUserQuery(row, query({ search: "babbage" }))).toBe(false);
  });

  it("searches a row with NO display name by its identities alone", () => {
    // `displayName` is nullable and often is null for a channel-created account.
    // A search that concatenated a null would throw or match everything.
    const anonymous = withIdentity(user("ada", { displayName: null }), "U0ADA123");
    expect(matchesEndUserQuery(anonymous, query({ search: "u0ada" }))).toBe(true);
    expect(matchesEndUserQuery(anonymous, query({ search: "ada" }))).toBe(true);
    expect(matchesEndUserQuery(anonymous, query({ search: "zzz" }))).toBe(false);
  });

  it("matches a row with no identities at all when the name matches", () => {
    expect(
      matchesEndUserQuery(
        { user: user("ada", { displayName: "Ada" }), identities: [] },
        query({ search: "ada" }),
      ),
    ).toBe(true);
  });
});

describe("compareEndUsers", () => {
  it("orders newest first", () => {
    const older = user("older", { createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const newer = user("newer", { createdAt: new Date("2026-03-01T00:00:00.000Z") });
    expect([older, newer].sort(compareEndUsers).map((row) => row.endUserId)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("BREAKS A TIE BY ID, which is what makes paging non-overlapping", () => {
    // Two rows created in the same millisecond. Without the tiebreak their order
    // is whatever the store felt like, and a caller walking pages sees one twice
    // and the other never.
    const at = new Date("2026-01-01T00:00:00.000Z");
    const a = user("a", { createdAt: at });
    const b = user("b", { createdAt: at });
    expect([a, b].sort(compareEndUsers).map((row) => row.endUserId)).toEqual(["b", "a"]);
    expect([b, a].sort(compareEndUsers).map((row) => row.endUserId)).toEqual(["b", "a"]);
  });
});
