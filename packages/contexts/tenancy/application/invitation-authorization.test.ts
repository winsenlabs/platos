// D1 (2026-09-15) — WHO MAY ISSUE AN INVITATION, in memory.
//
// The same five refusals are proven against a real PostgreSQL, over HTTP, in
// `apps/core-api/src/composition/identity-tenancy-rest.integration.test.ts`. What
// is here is the rule's shape: every gate named, one wire code for all of them,
// and nothing minted, locked or written on any refusal.

import { describe, expect, it } from "vitest";

import { normalizeEmail, OrganizationRole, organizationId, userId } from "../domain/index.js";
import { createTenancyService } from "./tenancy-service.js";
import { createTenancyFixture, seedMember, seedTree } from "./testing/tenant-fixture.js";

const INVITEE = "invitee@example.com";

function scenario() {
  const fixture = createTenancyFixture();
  const acme = seedTree(fixture.store, "acme");
  const globex = seedTree(fixture.store, "globex");
  seedMember(fixture.store, acme, "owner", { organizationRole: OrganizationRole.OWNER });
  seedMember(fixture.store, acme, "admin", { organizationRole: OrganizationRole.ADMIN });
  seedMember(fixture.store, acme, "member", { organizationRole: OrganizationRole.MEMBER });
  seedMember(fixture.store, acme, "gone", {
    organizationRole: OrganizationRole.ADMIN,
    deactivatedAt: new Date("2025-12-01T00:00:00.000Z"),
  });
  // THE FORGED-SCOPE CALLER: a real, active ADMIN — of the OTHER organization.
  seedMember(fixture.store, globex, "rival", { organizationRole: OrganizationRole.ADMIN });
  return { fixture, acme, globex, tenancy: createTenancyService(fixture.dependencies) };
}

async function issueAs(context: ReturnType<typeof scenario>, user: string, overrides: Record<string, unknown> = {}) {
  return context.tenancy.issueInvitation({
    organizationId: context.acme.organization.id,
    inviterUserId: userId(user),
    email: INVITEE,
    ...overrides,
  });
}

function gateOf(result: { readonly ok: boolean; readonly error?: { readonly details: Record<string, unknown> } }): unknown {
  return result.error?.details["gate"];
}

describe("D1 — an ACTIVE OWNER or ADMIN of the target organization may invite", () => {
  it("admits the OWNER and the ADMIN, and each issue writes one live invitation as MEMBER", async () => {
    const context = scenario();
    const byOwner = await issueAs(context, "owner");
    const byAdmin = await issueAs(context, "admin", { email: "second@example.com" });
    expect(byOwner.ok, JSON.stringify(byOwner)).toBe(true);
    expect(byAdmin.ok, JSON.stringify(byAdmin)).toBe(true);
    expect(context.fixture.store.invitations.map((row) => row.role)).toEqual([
      OrganizationRole.MEMBER,
      OrganizationRole.MEMBER,
    ]);
    expect(context.fixture.store.invitations.map((row) => row.inviterId)).toEqual([
      userId("owner"),
      userId("admin"),
    ]);
  });
});

describe("D1 — and refuses everybody else with ONE code and a named gate", () => {
  it("refuses a MEMBER", async () => {
    const refused = await issueAs(scenario(), "member");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("TENANCY_INVITATION_FORBIDDEN");
    expect(gateOf(refused)).toBe("not-an-administrator");
  });

  it("refuses a DEACTIVATED ADMIN", async () => {
    const refused = await issueAs(scenario(), "gone");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("TENANCY_INVITATION_FORBIDDEN");
    expect(gateOf(refused)).toBe("membership-deactivated");
  });

  it("refuses an ADMIN of ANOTHER organization naming this one — the forged scope — as not-a-member, not as not-found", async () => {
    const refused = await issueAs(scenario(), "rival");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("TENANCY_INVITATION_FORBIDDEN");
    expect(refused.error.code).not.toBe("TENANCY_NOT_FOUND");
    expect(gateOf(refused)).toBe("not-a-member");
  });

  it("refuses a non-existent organization under the SAME code, and only the log-only gate differs", async () => {
    const context = scenario();
    const missing = await context.tenancy.issueInvitation({
      organizationId: organizationId("nowhere"),
      inviterUserId: userId("owner"),
      email: INVITEE,
    });
    const forged = await issueAs(context, "rival");
    expect(missing.ok || forged.ok).toBe(false);
    if (missing.ok || forged.ok) return;
    expect(missing.error.code).toBe(forged.error.code);
    expect(missing.error.message).toBe(forged.error.message);
    expect(gateOf(missing)).toBe("no-such-organization");
    expect(gateOf(forged)).toBe("not-a-member");
  });

  it("refuses an archived organization", async () => {
    const context = scenario();
    const index = context.fixture.store.organizations.findIndex((row) => row.id === context.acme.organization.id);
    const archived = { ...context.acme.organization, archivedAt: new Date("2025-12-31T00:00:00.000Z") };
    context.fixture.store.organizations[index] = archived;
    const refused = await issueAs(context, "owner");
    expect(refused.ok).toBe(false);
    expect(gateOf(refused)).toBe("organization-archived");
  });

  it("refuses an ADMIN inviting an OWNER, and admits the OWNER doing it", async () => {
    const context = scenario();
    const byAdmin = await issueAs(context, "admin", { role: OrganizationRole.OWNER });
    expect(byAdmin.ok).toBe(false);
    expect(gateOf(byAdmin)).toBe("owner-grant-requires-owner");
    const byOwner = await issueAs(context, "owner", { role: OrganizationRole.OWNER });
    expect(byOwner.ok, JSON.stringify(byOwner)).toBe(true);
  });

  it("writes, locks and mints NOTHING on any refusal", async () => {
    const context = scenario();
    for (const user of ["member", "gone", "rival", "nobody"]) {
      expect((await issueAs(context, user)).ok, user).toBe(false);
    }
    expect(context.fixture.store.invitations).toHaveLength(0);
    expect([...context.fixture.locks.invitationSlots]).toEqual([]);
  });

  it("refuses a role that is not OWNER, ADMIN or MEMBER with its own code", async () => {
    const refused = await issueAs(scenario(), "owner", { role: "SUPERUSER" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("TENANCY_INVALID_ROLE");
  });

  it("refuses an address that cannot be mailed with its own code, before authorization is even read", async () => {
    const context = scenario();
    const refused = await issueAs(context, "member", { email: "not an address" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("TENANCY_INVALID_EMAIL");
    expect(normalizeEmail(" A@B.CO ")).toBe("a@b.co");
  });
});
