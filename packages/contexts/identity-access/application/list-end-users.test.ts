import { describe, expect, it } from "vitest";

import {
  asIdentifier,
  environmentScope,
  organizationScope,
  projectScope,
  type EnvironmentId,
  type OrganizationId,
  type ProjectId,
} from "@platos/kernel";

import type { EndUserId, EndUserIdentityId, EndUserRecord } from "../domain/index.js";
import { listEndUsers } from "./list-end-users.js";
import { testPorts, type TestPorts } from "./testing.js";

const ACME = asIdentifier<OrganizationId>("acme");
const GLOBEX = asIdentifier<OrganizationId>("globex");
const ACME_SCOPE = organizationScope(ACME);
const DISABLED_AT = new Date("2026-02-01T00:00:00.000Z");

function seed(
  ports: TestPorts,
  id: string,
  options: {
    readonly organizationId?: OrganizationId;
    readonly displayName?: string | null;
    readonly disabledAt?: Date | null;
    readonly createdAt?: Date;
    readonly subject?: string;
  } = {},
): EndUserRecord {
  const endUserId = asIdentifier<EndUserId>(id);
  const row: EndUserRecord = {
    endUserId,
    organizationId: options.organizationId ?? ACME,
    displayName: options.displayName === undefined ? id : options.displayName,
    disabledAt: options.disabledAt ?? null,
    createdAt: options.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
  ports.repository.state.endUsers.set(endUserId, row);
  if (options.subject !== undefined) {
    const identityId = asIdentifier<EndUserIdentityId>(`${id}-identity`);
    ports.repository.state.endUserIdentities.set(identityId, {
      identityId,
      endUserId,
      issuer: "slack",
      channel: "slack",
      subject: options.subject,
      verifiedAt: null,
      disabledAt: null,
    });
  }
  return row;
}

function idsOf(page: { ok: boolean } & { value?: { users: readonly { user: EndUserRecord }[] } }) {
  if (!page.ok || page.value === undefined) throw new Error("expected a page");
  return page.value.users.map((row) => row.user.endUserId);
}

describe("listEndUsers", () => {
  it("lists the tenant's end users, newest first, with their identities", async () => {
    const ports = testPorts();
    seed(ports, "older", { createdAt: new Date("2026-01-01T00:00:00.000Z"), subject: "U-OLD" });
    seed(ports, "newer", { createdAt: new Date("2026-03-01T00:00:00.000Z"), subject: "U-NEW" });

    const page = await listEndUsers(ports, { scope: ACME_SCOPE });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.users.map((row) => row.user.endUserId)).toEqual(["newer", "older"]);
    expect(page.value.users[0]?.identities.map((identity) => identity.subject)).toEqual(["U-NEW"]);
    expect(page.value.total).toBe(2);
    expect(page.value.hasMore).toBe(false);
  });

  it("REFUSES TO CROSS TENANTS — another organization's rows are never returned", async () => {
    const ports = testPorts();
    seed(ports, "mine", { organizationId: ACME });
    seed(ports, "theirs", { organizationId: GLOBEX });

    const mine = await listEndUsers(ports, { scope: ACME_SCOPE });
    expect(idsOf(mine)).toEqual(["mine"]);
    if (!mine.ok) return;
    // The TOTAL is the part a leak hides in: a page filtered correctly with a
    // total counted globally tells the caller there is more of somebody else's
    // tenant to fetch.
    expect(mine.value.total).toBe(1);

    const theirs = await listEndUsers(ports, { scope: organizationScope(GLOBEX) });
    expect(idsOf(theirs)).toEqual(["theirs"]);
  });

  it("takes the tenant from the SCOPE, at every level of the tree", async () => {
    // There is no organization id on the request. A project- or
    // environment-scoped caller is answered for the organization above them,
    // which is the widening `toOrganizationScope` performs and the only place
    // the tenant can come from.
    const ports = testPorts();
    seed(ports, "mine", { organizationId: ACME });
    seed(ports, "theirs", { organizationId: GLOBEX });

    const project = projectScope(ACME, asIdentifier<ProjectId>("checkout"));
    const environment = environmentScope(
      ACME,
      asIdentifier<ProjectId>("checkout"),
      asIdentifier<EnvironmentId>("production"),
    );
    expect(idsOf(await listEndUsers(ports, { scope: project }))).toEqual(["mine"]);
    expect(idsOf(await listEndUsers(ports, { scope: environment }))).toEqual(["mine"]);
  });

  it("filters by status, and counts under the SAME filter it pages under", async () => {
    const ports = testPorts();
    seed(ports, "live");
    seed(ports, "gone", { disabledAt: DISABLED_AT });

    const active = await listEndUsers(ports, { scope: ACME_SCOPE, status: "active" });
    expect(idsOf(active)).toEqual(["live"]);
    if (!active.ok) return;
    expect(active.value.total).toBe(1);

    const disabled = await listEndUsers(ports, { scope: ACME_SCOPE, status: "disabled" });
    expect(idsOf(disabled)).toEqual(["gone"]);
    if (!disabled.ok) return;
    expect(disabled.value.total).toBe(1);
  });

  it("searches display names and identity subjects", async () => {
    const ports = testPorts();
    seed(ports, "ada", { displayName: "Ada Lovelace", subject: "U0ADA" });
    seed(ports, "mel", { displayName: null, subject: "U0MEL" });

    expect(idsOf(await listEndUsers(ports, { scope: ACME_SCOPE, search: "lovelace" }))).toEqual([
      "ada",
    ]);
    expect(idsOf(await listEndUsers(ports, { scope: ACME_SCOPE, search: "u0mel" }))).toEqual([
      "mel",
    ]);
  });

  it("pages without overlapping, and reports whether more remains", async () => {
    const ports = testPorts();
    for (let index = 0; index < 5; index += 1) {
      seed(ports, `u${index}`, {
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    }

    const first = await listEndUsers(ports, { scope: ACME_SCOPE, limit: 2, offset: 0 });
    const second = await listEndUsers(ports, { scope: ACME_SCOPE, limit: 2, offset: 2 });
    const third = await listEndUsers(ports, { scope: ACME_SCOPE, limit: 2, offset: 4 });
    expect(idsOf(first)).toEqual(["u4", "u3"]);
    expect(idsOf(second)).toEqual(["u2", "u1"]);
    expect(idsOf(third)).toEqual(["u0"]);
    if (!first.ok || !third.ok) return;
    expect(first.value.total).toBe(5);
    expect(first.value.hasMore).toBe(true);
    expect(third.value.hasMore).toBe(false);
  });

  it("REFUSES an unknown status without reading the store", async () => {
    const ports = testPorts();
    seed(ports, "ada");
    let reads = 0;
    const counting: TestPorts = {
      ...ports,
      repository: {
        ...ports.repository,
        endUsers: {
          list: async (query) => {
            reads += 1;
            return ports.repository.endUsers.list(query);
          },
          count: async (query) => {
            reads += 1;
            return ports.repository.endUsers.count(query);
          },
        },
      },
    };

    const refusal = await listEndUsers(counting, { scope: ACME_SCOPE, status: "deleted" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_END_USER_FILTER");
    // Asserting the CONSEQUENCE, not only the code: a validation that ran after
    // the read would produce the same error and would still have touched the
    // store, which is what an expensive unbounded scan looks like.
    expect(reads).toBe(0);

    expect((await listEndUsers(counting, { scope: ACME_SCOPE, status: "active" })).ok).toBe(true);
    expect(reads).toBe(2);
  });

  it("REFUSES AN OVER-LARGE PAGE rather than quietly serving a smaller one", async () => {
    const ports = testPorts();
    const refusal = await listEndUsers(ports, { scope: ACME_SCOPE, limit: 101 });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.fields[0]?.field).toBe("limit");
    expect((await listEndUsers(ports, { scope: ACME_SCOPE, limit: 100 })).ok).toBe(true);
  });

  it("REFUSES a negative offset and an over-long search term", async () => {
    const ports = testPorts();
    expect((await listEndUsers(ports, { scope: ACME_SCOPE, offset: -1 })).ok).toBe(false);
    expect(
      (await listEndUsers(ports, { scope: ACME_SCOPE, search: "a".repeat(201) })).ok,
    ).toBe(false);
  });
});
