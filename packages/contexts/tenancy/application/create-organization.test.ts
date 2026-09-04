import { describe, expect, it } from "vitest";

import { asIdentifier, type IdGenerator, type Ulid, type Uuid } from "@platos/kernel";

import { OrganizationRole, normalizeEmail, userId } from "../domain/index.js";
import { createCreateOrganization } from "./create-organization.js";
import type { TenancyRepository } from "./ports/index.js";
import { UniqueViolation } from "./testing/in-memory-repository.js";
import { createTenancyFixture } from "./testing/tenant-fixture.js";

const FOUNDER = userId("ada");

function scenario(options: { readonly disabledAt?: Date | null } = {}) {
  const fixture = createTenancyFixture();
  fixture.operators.add({
    userId: FOUNDER,
    email: normalizeEmail("ada@example.com"),
    disabledAt: options.disabledAt ?? null,
  });
  return { fixture, create: createCreateOrganization(fixture.dependencies) };
}

/**
 * The same fixture, with ONE repository method replaced by a thrower.
 *
 * This is how the second write is made to fail without inventing a second
 * repository: everything else still behaves, so what the test observes is the
 * transaction's response to a failing write and not a differently-shaped store.
 */
function scenarioFailingOn(method: keyof TenancyRepository, failure: Error) {
  const built = scenario();
  // A computed key widens the literal, so the spread is asserted back to the
  // port. The name is checked by `keyof TenancyRepository`, so a method renamed
  // out from under this helper is a compile error rather than a silent no-op.
  const broken = {
    ...built.fixture.dependencies.repository,
    [method]: async () => {
      throw failure;
    },
  } as TenancyRepository;
  return {
    fixture: built.fixture,
    create: createCreateOrganization({ ...built.fixture.dependencies, repository: broken }),
  };
}

/**
 * A scenario whose id generator mints the SAME organization id every call.
 *
 * It is how a REAL index violation is made to land on the second write rather
 * than the first. Left alone, every call mints a fresh organization id, so the
 * only index a second call can collide with is `Organization_slug_key` — which
 * fires on write one and proves nothing about rolling back a partial commit.
 */
function scenarioWithOneOrganizationId(fixedId: string) {
  const built = scenario();
  let call = 0;
  const ids: IdGenerator = {
    uuid: () => {
      const value = call % 2 === 0 ? fixedId : `membership-${call}`;
      call += 1;
      return asIdentifier<Uuid>(value);
    },
    ulid: () => asIdentifier<Ulid>(`ulid-${call}`),
  };
  return {
    fixture: built.fixture,
    create: createCreateOrganization({ ...built.fixture.dependencies, ids }),
  };
}

const COMMAND = { name: "Acme", slug: "acme", founderUserId: FOUNDER } as const;

describe("createOrganization", () => {
  it("writes the organization and the founding OWNER membership together", async () => {
    const { fixture, create } = scenario();
    const created = await create(COMMAND);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.organization.slug).toBe("acme");
    expect(created.value.organization.archivedAt).toBeNull();
    expect(created.value.founderMembership.role).toBe(OrganizationRole.OWNER);
    expect(created.value.founderMembership.organizationId).toBe(created.value.organization.id);
    expect(created.value.founderMembership.userId).toBe(FOUNDER);
    expect(created.value.founderMembership.deactivatedAt).toBeNull();

    // Both rows are IN THE STORE, not merely in the returned value.
    expect(fixture.store.organizations).toHaveLength(1);
    expect(fixture.store.organizationMemberships).toHaveLength(1);
    expect(fixture.store.organizationMemberships[0]?.role).toBe(OrganizationRole.OWNER);
  });

  it("commits both rows in ONE transaction", async () => {
    const { fixture, create } = scenario();
    await create(COMMAND);
    expect(fixture.unitOfWork.transactionCount()).toBe(1);
    expect(fixture.unitOfWork.rollbackCount()).toBe(0);
  });

  it("trims the name and stamps both rows with the clock", async () => {
    const { fixture, create } = scenario();
    const created = await create({ ...COMMAND, name: "  Acme  " });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.organization.name).toBe("Acme");
    expect(created.value.organization.createdAt).toEqual(fixture.clock.now());
    expect(created.value.founderMembership.createdAt).toEqual(fixture.clock.now());
  });

  // --- the guards ----------------------------------------------------------

  it("REFUSES a blank name, and writes nothing", async () => {
    const { fixture, create } = scenario();
    const refusal = await create({ ...COMMAND, name: "   " });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_INVALID_NAME");
    expect(fixture.store.organizations).toEqual([]);
    // The refusal is taken BEFORE any transaction opens, which is what keeps
    // the block below free of anything that can decide to refuse.
    expect(fixture.unitOfWork.transactionCount()).toBe(0);
  });

  it("REFUSES a slug that is not lower-case kebab-case", async () => {
    const { fixture, create } = scenario();
    for (const slug of ["Acme", "acme_co", "acme co", "-acme", "acme-", "a".repeat(65)]) {
      const refusal = await create({ ...COMMAND, slug });
      expect(refusal.ok, slug).toBe(false);
      if (refusal.ok) return;
      expect(refusal.error.code).toBe("TENANCY_INVALID_SLUG");
    }
    expect(fixture.store.organizations).toEqual([]);
    expect(fixture.unitOfWork.transactionCount()).toBe(0);
  });

  it("REFUSES a founder identity-access does not hold", async () => {
    const { fixture, create } = scenario();
    const refusal = await create({ ...COMMAND, founderUserId: userId("nobody") });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_UNKNOWN_OPERATOR");
    expect(fixture.store.organizationMemberships).toEqual([]);
  });

  it("REFUSES A DISABLED FOUNDER, which the foreign key alone would allow", async () => {
    // `OrganizationMembership.userId -> User(id)` is satisfied by a disabled
    // user, so this gate is the only thing that refuses one. Deleting the
    // `disabledAt` clause leaves the unknown-founder case passing.
    const { fixture, create } = scenario({ disabledAt: new Date("2026-01-02T00:00:00.000Z") });
    const refusal = await create(COMMAND);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_UNKNOWN_OPERATOR");
    expect(fixture.store.organizations).toEqual([]);
  });

  it("REFUSES a slug already taken, with a conflict rather than a constraint violation", async () => {
    const { fixture, create } = scenario();
    expect((await create(COMMAND)).ok).toBe(true);

    const refusal = await create({ ...COMMAND, name: "Acme Two" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_SLUG_TAKEN");
    expect(refusal.error.category).toBe("conflict");
    // Still one organization, and still one membership: the second call did not
    // reach the index, so nothing partial can have been left behind.
    expect(fixture.store.organizations).toHaveLength(1);
    expect(fixture.store.organizationMemberships).toHaveLength(1);
  });

  // --- atomicity, by failure injection -------------------------------------

  it("COMMITS NEITHER ROW when the founding membership fails to write", async () => {
    // The second of two writes rejects. If the transaction did not roll back —
    // or if the use case returned an error `Result` from inside `run`, which
    // RESOLVES and therefore commits — an organization with no owner would be
    // left behind, and nobody could ever administer it.
    const { fixture, create } = scenarioFailingOn(
      "saveOrganizationMembership",
      new Error("membership insert failed"),
    );
    await expect(create(COMMAND)).rejects.toThrow("membership insert failed");
    expect(fixture.store.organizations).toEqual([]);
    expect(fixture.store.organizationMemberships).toEqual([]);
    expect(fixture.unitOfWork.rollbackCount()).toBe(1);
  });

  it("COMMITS NOTHING when the organization write itself fails", async () => {
    const { fixture, create } = scenarioFailingOn(
      "saveOrganization",
      new UniqueViolation("Organization_slug_key"),
    );
    await expect(create(COMMAND)).rejects.toBeInstanceOf(UniqueViolation);
    expect(fixture.store.organizations).toEqual([]);
    expect(fixture.store.organizationMemberships).toEqual([]);
    expect(fixture.unitOfWork.rollbackCount()).toBe(1);
  });

  it("ROLLS BACK A REAL INDEX VIOLATION, with no fault injected at all", async () => {
    // Nothing here is a double behaving badly. The store carries
    // `OrganizationMembership_organizationId_userId_key`, exactly as Postgres
    // does, and the second call reaches it because both calls mint the same
    // organization id. The organization row is written FIRST and the violation
    // lands on the write after it, so what is observed is a genuine partial
    // transaction being taken back.
    const { fixture, create } = scenarioWithOneOrganizationId("org-fixed");
    const first = await create(COMMAND);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(fixture.store.organizations).toHaveLength(1);

    // Clearing the organizations lets the slug pre-check pass, so the call
    // reaches the writes; the membership from the first call stays.
    fixture.store.organizations.length = 0;
    await expect(create({ ...COMMAND, slug: "acme-two" })).rejects.toBeInstanceOf(UniqueViolation);

    expect(fixture.store.organizations).toEqual([]);
    expect(fixture.store.organizationMemberships).toHaveLength(1);
    expect(fixture.store.organizationMemberships[0]?.id).toBe(first.value.founderMembership.id);
    expect(fixture.unitOfWork.rollbackCount()).toBe(1);
  });
});
