// The end-user read model, through the façade.
//
// SPLIT OUT OF `identity-access-service.test.ts` for the same reason the cookie
// suite was: the file crossed its line budget, and the budget was pointing at a
// seam. Its sibling is about AUTHENTICATING a presented credential; this is
// about LISTING rows the context is sole writer of. The two share a façade and
// nothing else — different ports, different arrangement, different failure
// vocabulary.
//
// WHAT ONLY SHOWS UP HERE. The projection is where a refusal quietly becomes an
// empty success, and where a DTO grows a key it should not have. Both are
// asserted: a bad filter stays a failure rather than a page of zero rows, and
// the view is pinned key by key, because extra keys are structural and no type
// error would follow a leak.

import { describe, expect, it } from "vitest";

import { ORGANIZATION_ID, OTHER_ORGANIZATION_ID, at } from "../domain/testing.js";
import type { EndUserId, EndUserIdentityId } from "../domain/index.js";
import { createIdentityAccessService } from "./identity-access-service.js";
import { testPorts, type TestPorts } from "./testing.js";
import { asIdentifier, organizationScope } from "@platos/kernel";

describe("listEndUsers — the read this context published none of", () => {
  function seedEndUser(
    ports: TestPorts,
    id: string,
    organizationId: typeof ORGANIZATION_ID,
    overrides: { readonly displayName?: string | null; readonly disabledAt?: Date | null } = {},
  ) {
    const endUserId = asIdentifier<EndUserId>(id);
    ports.repository.state.endUsers.set(endUserId, {
      endUserId,
      organizationId,
      displayName: overrides.displayName === undefined ? id : overrides.displayName,
      disabledAt: overrides.disabledAt ?? null,
      createdAt: at(0),
    });
    const identityId = asIdentifier<EndUserIdentityId>(`${id}-identity`);
    ports.repository.state.endUserIdentities.set(identityId, {
      identityId,
      endUserId,
      issuer: "slack",
      channel: "slack",
      subject: `U-${id.toUpperCase()}`,
      verifiedAt: null,
      disabledAt: null,
    });
  }

  it("projects a page through the contract, dropping the storage-only keys", async () => {
    const ports = testPorts();
    seedEndUser(ports, "ada", ORGANIZATION_ID);
    const page = await createIdentityAccessService(ports).listEndUsers({
      scope: organizationScope(ORGANIZATION_ID),
    });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.total).toBe(1);
    const [user] = page.value.users;
    expect(user?.endUserId).toBe("ada");
    // The view is flat and carries neither the tenant it was scoped by nor the
    // identity row's own id. Extra keys are structural, so a leak would raise no
    // type error and only this assertion would catch it.
    expect(Object.keys(user ?? {}).sort()).toEqual([
      "createdAt",
      "disabledAt",
      "displayName",
      "endUserId",
      "identities",
    ]);
    expect(Object.keys(user?.identities[0] ?? {}).sort()).toEqual([
      "channel",
      "disabledAt",
      "issuer",
      "subject",
      "verifiedAt",
    ]);
  });

  it("REFUSES TO SHOW ANOTHER TENANT'S END USERS THROUGH THE CONTRACT", async () => {
    const ports = testPorts();
    seedEndUser(ports, "mine", ORGANIZATION_ID);
    seedEndUser(ports, "theirs", OTHER_ORGANIZATION_ID);
    const identityAccess = createIdentityAccessService(ports);

    const page = await identityAccess.listEndUsers({
      scope: organizationScope(ORGANIZATION_ID),
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.users.map((user) => user.endUserId)).toEqual(["mine"]);
    expect(page.value.total).toBe(1);
  });

  it("KEEPS A BAD FILTER A FAILURE rather than an empty success", async () => {
    // The projection layer is exactly where a refusal quietly becomes `ok` with
    // zero rows, which a caller cannot tell from a tenant that has none.
    const refusal = await createIdentityAccessService(testPorts()).listEndUsers({
      scope: organizationScope(ORGANIZATION_ID),
      status: "deleted",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_END_USER_FILTER");
  });

  it("KEEPS AN OVER-LARGE PAGE A FAILURE, not a smaller page", async () => {
    const refusal = await createIdentityAccessService(testPorts()).listEndUsers({
      scope: organizationScope(ORGANIZATION_ID),
      limit: 101,
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.category).toBe("invalid_input");
  });
});
