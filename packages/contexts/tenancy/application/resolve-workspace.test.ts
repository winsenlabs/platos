// The slug walk, the authorization it feeds, and the one property that makes a
// slug-addressed route safe to publish.
//
// THE CENTRAL CASE IS `refuses every failure identically`. It does not assert a
// code this file wrote down. It computes the refusal a REAL RBAC denial produces
// — by running `authorizeEnvironmentOperator` against a member who genuinely may
// not enter — and then requires every resolution failure to be byte-identical to
// it on the wire. A future edit that answered `TENANCY_NOT_FOUND` for a missing
// organization would fail that case, which is the whole point: the enumeration
// oracle this use case exists to avoid is invisible to any assertion written
// against a literal.

import { describe, expect, it } from "vitest";

import {
  environmentId as makeEnvironmentId,
  isEnvironmentOperatorAuthorization,
  OrganizationRole,
  ProjectRole,
  userId,
  type EnvironmentRecord,
} from "../domain/index.js";
import type { TenancyRepository } from "./ports/index.js";
import { createAuthorizeEnvironmentOperator } from "./authorize-environment-operator.js";
import { createResolveWorkspace } from "./resolve-workspace.js";
import { createTenancyFixture, seedMember, seedTree } from "./testing/tenant-fixture.js";

const ARCHIVED_AT = new Date("2026-05-05T00:00:00.000Z");
const ADA = { actorUserId: userId("ada"), effectiveUserId: userId("ada") };
const MALLORY = { actorUserId: userId("mallory"), effectiveUserId: userId("mallory") };

/** The wire-visible half of a domain error: what a client can actually observe. */
function onTheWire(error: { readonly code: string; readonly message: string; readonly category: string }) {
  return { code: error.code, message: error.message, category: error.category };
}

function world(
  options: { readonly role?: OrganizationRole; readonly projectRole?: ProjectRole } = {},
) {
  const fixture = createTenancyFixture();
  const acme = seedTree(fixture.store, "acme");
  // A SECOND, COMPLETE TENANT. Every cross-tenant case below needs a foreign
  // tree that really exists, because a slug that resolves to nothing proves
  // nothing about isolation.
  const globex = seedTree(fixture.store, "globex");
  seedMember(fixture.store, acme, "ada", {
    organizationRole: options.role ?? OrganizationRole.ADMIN,
    projectRole: options.projectRole ?? null,
  });
  seedMember(fixture.store, globex, "mallory", { organizationRole: OrganizationRole.OWNER });
  return {
    fixture,
    acme,
    globex,
    resolve: createResolveWorkspace(fixture.dependencies),
    authorize: createAuthorizeEnvironmentOperator(fixture.dependencies),
  };
}

const ACME_SLUGS = {
  organizationSlug: "acme",
  projectSlug: "acme-app",
  environmentSlug: "acme-prod",
};

describe("resolveWorkspace", () => {
  it("resolves the tree an operator addressed by name, and authorizes them for it", async () => {
    const { acme, resolve } = world();
    const result = await resolve({ ...ACME_SLUGS, operator: ADA, access: "metadata" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.organization.id).toBe(acme.organization.id);
    expect(result.value.project.id).toBe(acme.project.id);
    expect(result.value.environment.id).toBe(acme.environment.id);
    // The branded value, not a copy — a consumer keys its reads by this scope.
    expect(isEnvironmentOperatorAuthorization(result.value.authorization)).toBe(true);
    expect(result.value.authorization.scope).toEqual({
      level: "environment",
      organizationId: acme.organization.id,
      projectId: acme.project.id,
      environmentId: acme.environment.id,
    });
  });

  // THE PROPERTY THE WHOLE DESIGN RESTS ON.
  //
  // The expected value is MEASURED, not written: `authorize` is run against a
  // real member of another tenant to obtain the refusal a genuine RBAC denial
  // produces, and every resolution failure is required to match it. Joining to a
  // literal here would let the two drift apart silently.
  it("refuses every failure identically, so a slug cannot be used to probe for tenants", async () => {
    const { acme, resolve, authorize } = world();

    const genuineDenial = await authorize({
      environmentId: acme.environment.id,
      operator: MALLORY,
      access: "metadata",
    });
    expect(genuineDenial.ok).toBe(false);
    if (genuineDenial.ok) throw new Error("unreachable");
    const rbacRefusal = onTheWire(genuineDenial.error);

    const probes: ReadonlyArray<readonly [string, Parameters<typeof resolve>[0]]> = [
      ["no such organization", { ...ACME_SLUGS, organizationSlug: "no-such-org", operator: ADA, access: "metadata" }],
      ["no such project", { ...ACME_SLUGS, projectSlug: "no-such-project", operator: ADA, access: "metadata" }],
      ["no such environment", { ...ACME_SLUGS, environmentSlug: "no-such-env", operator: ADA, access: "metadata" }],
      ["a slug that could never exist", { ...ACME_SLUGS, organizationSlug: "Not A Slug!", operator: ADA, access: "metadata" }],
      // A REAL workspace this operator may not enter. Indistinguishable from all
      // of the above is exactly the requirement.
      ["a real tenant they are not in", { organizationSlug: "globex", projectSlug: "globex-app", environmentSlug: "globex-prod", operator: ADA, access: "metadata" }],
    ];

    for (const [label, command] of probes) {
      const result = await resolve(command);
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(onTheWire(result.error), label).toEqual(rbacRefusal);
    }
  });

  // LESSON 7: a two-tenant test is not a tenancy test. Both halves of this triple
  // NAME REAL ROWS — `acme` is a real organization and `globex-app` a real
  // project — and the pairing is the forgery. It is refused because
  // `findProjectBySlug` is keyed by the organization id the walk just resolved,
  // never by the slug alone.
  it("refuses a triple whose halves are real but belong to different tenants", async () => {
    const { resolve } = world();
    const forged = await resolve({
      organizationSlug: "acme",
      projectSlug: "globex-app",
      environmentSlug: "globex-prod",
      operator: ADA,
      access: "metadata",
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) throw new Error("unreachable");
    expect(forged.error.details).toEqual({ gate: "no-such-project" });
  });

  it("refuses an environment slug that belongs to another tenant's project", async () => {
    const { resolve } = world();
    const forged = await resolve({
      organizationSlug: "acme",
      projectSlug: "acme-app",
      environmentSlug: "globex-prod",
      operator: ADA,
      access: "metadata",
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) throw new Error("unreachable");
    expect(forged.error.details).toEqual({ gate: "no-such-environment" });
  });

  // ARCHIVAL IS NOT RE-DECIDED IN THE WALK — it is the authorization's gate, and
  // this proves the walk really does reach it rather than filtering first.
  it.each(["organization", "project", "environment"] as const)(
    "refuses through the authorization's own gate when the %s is archived",
    async (level) => {
      const { fixture, acme, resolve } = world({ role: OrganizationRole.OWNER });
      if (level === "organization") {
        fixture.store.organizations = fixture.store.organizations.map((row) =>
          row.id === acme.organization.id ? { ...row, archivedAt: ARCHIVED_AT } : row,
        );
      }
      if (level === "project") {
        fixture.store.projects = fixture.store.projects.map((row) =>
          row.id === acme.project.id ? { ...row, archivedAt: ARCHIVED_AT } : row,
        );
      }
      if (level === "environment") {
        fixture.store.environments = fixture.store.environments.map((row) =>
          row.id === acme.environment.id ? { ...row, archivedAt: ARCHIVED_AT } : row,
        );
      }
      const result = await resolve({ ...ACME_SLUGS, operator: ADA, access: "metadata" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.details).toEqual({ gate: "archived-ancestor" });
    },
  );

  // The SAME operator, the SAME workspace, and only the requested access differs:
  // a VIEWER may read metadata and may not mutate a secret. Holding everything
  // else fixed is what makes this a test of the access level rather than of the
  // membership.
  it("carries secret:mutate through to the gate that discriminates on it", async () => {
    const { resolve } = world({
      role: OrganizationRole.MEMBER,
      projectRole: ProjectRole.VIEWER,
    });
    const metadata = await resolve({ ...ACME_SLUGS, operator: ADA, access: "metadata" });
    expect(metadata.ok).toBe(true);
    const mutate = await resolve({ ...ACME_SLUGS, operator: ADA, access: "secret:mutate" });
    expect(mutate.ok).toBe(false);
    if (mutate.ok) throw new Error("unreachable");
    expect(mutate.error.details).toEqual({ gate: "secret-mutate-role" });
  });

  describe("the environment switcher's list", () => {
    it("carries the project's unarchived environments, oldest first, and excludes the archived", async () => {
      const { fixture, acme, resolve } = world();
      const sibling = (id: string, createdAt: string, archivedAt: Date | null): EnvironmentRecord => ({
        ...acme.environment,
        id: makeEnvironmentId(id),
        slug: acme.environment.slug,
        createdAt: new Date(createdAt),
        archivedAt,
      });
      // Pushed OUT OF ORDER on purpose: the ordering must be the use case's, not
      // the store's insertion order.
      fixture.store.environments.push(sibling("acme-staging", "2026-03-01T00:00:00.000Z", null));
      fixture.store.environments.push(sibling("acme-dev", "2026-02-01T00:00:00.000Z", null));
      fixture.store.environments.push(sibling("acme-dead", "2026-01-15T00:00:00.000Z", ARCHIVED_AT));

      const result = await resolve({ ...ACME_SLUGS, operator: ADA, access: "metadata" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const rows = result.value.environments;
      const ids = rows.map((row) => row.id);
      expect(ids).not.toContain("acme-dead");
      expect(ids).toContain(acme.environment.id);
      // THE PROPERTY: oldest first. Asserted over the returned rows' own
      // timestamps, so it keeps holding when the fixture's dates change.
      for (let index = 1; index < rows.length; index += 1) {
        expect(rows[index - 1]!.createdAt.getTime()).toBeLessThanOrEqual(
          rows[index]!.createdAt.getTime(),
        );
      }
      // And the observed order, which is NOT the insertion order and NOT
      // alphabetical: `acme-prod` is seeded at the fixture epoch and therefore
      // leads, despite sorting last of the three by name.
      expect(ids).toEqual(["acme-prod", "acme-dev", "acme-staging"]);
    });

    it("does not leak another tenant's environments into the switcher", async () => {
      const { globex, resolve } = world();
      const result = await resolve({ ...ACME_SLUGS, operator: ADA, access: "metadata" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.environments.map((row) => row.id)).not.toContain(globex.environment.id);
    });
  });

  // THE JOIN, MADE FALSIFIABLE. The in-memory repository is self-consistent by
  // construction, so the slug walk and the ancestry load can never disagree
  // against it — which would leave the guard unfalsifiable and rotting green. A
  // repository that answers the slug lookup with a FOREIGN environment is the
  // only way to reach it, and a store really can drift this way: the two answers
  // come from different indexes.
  it("refuses when the slug walk and the re-derived ancestry disagree", async () => {
    const { fixture, globex, resolve: _honest } = world();
    const honest = fixture.dependencies.repository;
    const lying: TenancyRepository = {
      ...honest,
      findEnvironmentBySlug: async () => globex.environment,
    };
    const resolve = createResolveWorkspace({ repository: lying });
    const result = await resolve({ ...ACME_SLUGS, operator: ADA, access: "metadata" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // It is refused, and NOT with a scope for a tenant the caller did not name.
    expect(result.error.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
  });
});
