// The team listing and the slug-addressed scope resolver, in memory.
//
// Both are PORTED read models — `settings.team`'s loader and `auth.server.ts`'s
// `requireEnvironmentScope` — and each case below names the oracle behaviour it
// holds. The real-PostgreSQL, over-HTTP half, with the forged-scope callers, is in
// `apps/core-api/src/composition/identity-tenancy-rest.integration.test.ts`.

import { describe, expect, it } from "vitest";

import {
  anEnvironment,
  OrganizationRole,
  ProjectRole,
  normalizeEmail,
  userId,
} from "../domain/index.js";
import { createTenancyService } from "./tenancy-service.js";
import { createTenancyFixture, seedMember, seedTree } from "./testing/tenant-fixture.js";

function scenario() {
  const fixture = createTenancyFixture();
  const acme = seedTree(fixture.store, "acme");
  const globex = seedTree(fixture.store, "globex");
  seedMember(fixture.store, acme, "owner", { organizationRole: OrganizationRole.OWNER });
  seedMember(fixture.store, acme, "member", { organizationRole: OrganizationRole.MEMBER, projectRole: ProjectRole.VIEWER });
  seedMember(fixture.store, acme, "gone", {
    organizationRole: OrganizationRole.ADMIN,
    deactivatedAt: new Date("2025-12-01T00:00:00.000Z"),
  });
  seedMember(fixture.store, globex, "rival", { organizationRole: OrganizationRole.OWNER });
  for (const user of ["owner", "member", "gone", "rival"]) {
    fixture.operators.add({
      userId: userId(user),
      email: normalizeEmail(`${user}@example.com`),
      // One named account, so the listing is seen to carry the name AND the null.
      displayName: user === "owner" ? "Olive Owner" : null,
      disabledAt: null,
    });
  }
  return { fixture, acme, globex, tenancy: createTenancyService(fixture.dependencies) };
}

describe("listOrganizationMembers — settings.team, ported", () => {
  it("lists the ACTIVE members with their sign-in address, and leaves the deactivated one out", async () => {
    const context = scenario();
    const listed = await context.tenancy.listOrganizationMembers({
      organizationId: context.acme.organization.id,
      actorUserId: userId("owner"),
    });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    // Both rows share the record builders' epoch, so the oracle's `createdAt asc`
    // falls to the id tiebreak: `member-in-acme` before `owner-in-acme`.
    expect(listed.value.map((row) => [row.membership.role, row.account?.email, row.account?.displayName])).toEqual([
      [OrganizationRole.MEMBER, "member@example.com", null],
      [OrganizationRole.OWNER, "owner@example.com", "Olive Owner"],
    ]);
  });

  it("refuses a MEMBER, a deactivated ADMIN, and an OWNER of another organization, under one code", async () => {
    const context = scenario();
    const gates: unknown[] = [];
    for (const user of ["member", "gone", "rival"]) {
      const refused = await context.tenancy.listOrganizationMembers({
        organizationId: context.acme.organization.id,
        actorUserId: userId(user),
      });
      expect(refused.ok, user).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("TENANCY_MEMBER_LIST_FORBIDDEN");
      gates.push(refused.error.details["gate"]);
    }
    expect(gates).toEqual(["not-an-administrator", "membership-deactivated", "not-a-member"]);
  });
});

describe("resolveOperatorEnvironment — requireEnvironmentScope, ported", () => {
  it("resolves the three slugs, authorizes on the leaf, and lists the live siblings oldest first", async () => {
    const context = scenario();
    const later = anEnvironment("acme-staging", context.acme.project.id, {
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const archived = anEnvironment("acme-old", context.acme.project.id, {
      archivedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    context.fixture.store.environments.push(later, archived);
    const resolved = await context.tenancy.resolveOperatorEnvironment({
      organizationSlug: context.acme.organization.slug,
      projectSlug: context.acme.project.slug,
      environmentSlug: context.acme.environment.slug,
      operator: { actorUserId: userId("owner"), effectiveUserId: userId("owner") },
      access: "metadata",
    });
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.environment.id).toBe(context.acme.environment.id);
    expect(resolved.value.authorization.scope.environmentId).toBe(context.acme.environment.id);
    expect(resolved.value.environments.map((row) => row.id)).toEqual([context.acme.environment.id, later.id]);
  });

  it("answers TENANCY_NOT_FOUND for slugs that name no live environment, and the four-gate refusal for one the operator may not see", async () => {
    const context = scenario();
    const operator = { actorUserId: userId("rival"), effectiveUserId: userId("rival") };
    const missing = await context.tenancy.resolveOperatorEnvironment({
      organizationSlug: context.acme.organization.slug,
      projectSlug: context.acme.project.slug,
      environmentSlug: "nope",
      operator,
      access: "metadata",
    });
    const forged = await context.tenancy.resolveOperatorEnvironment({
      organizationSlug: context.acme.organization.slug,
      projectSlug: context.acme.project.slug,
      environmentSlug: context.acme.environment.slug,
      operator,
      access: "metadata",
    });
    expect(missing.ok || forged.ok).toBe(false);
    if (missing.ok || forged.ok) return;
    expect(missing.error.code).toBe("TENANCY_NOT_FOUND");
    expect(forged.error.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
  });

  it("does not let a project slug from one organization resolve under another", async () => {
    const context = scenario();
    const crossed = await context.tenancy.resolveOperatorEnvironment({
      organizationSlug: context.globex.organization.slug,
      projectSlug: context.acme.project.slug,
      environmentSlug: context.acme.environment.slug,
      operator: { actorUserId: userId("rival"), effectiveUserId: userId("rival") },
      access: "metadata",
    });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe("TENANCY_NOT_FOUND");
  });
});
