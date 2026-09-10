// The credential LISTING and REVOCATION, through the façade.
//
// SPLIT OUT OF `identity-access-service.test.ts` for the reason the cookie and
// end-user suites were: the file crossed its line budget and the budget pointed at
// a seam. Its siblings are about AUTHENTICATING a presented credential and about
// listing rows this context is sole writer of; this one is about a credential's
// last two acts.
//
// WHAT ONLY SHOWS UP HERE, AND IS THE REASON THE SUITE EXISTS.
//
//   THE REFUSALS THAT ARE NOT CLAMPS. `listBearerCredentials` refuses a page above
//   100 where both legacy services silently answer 100 and REPORT 100, and every
//   assertion of that shape has to be negative — a clamp passes any test that only
//   checks the rows that came back.
//
//   THE THREE-VALUED OUTCOME. `revoked`, `alreadyRevoked` and `absent` are
//   distinct here and were one boolean in both oracles. Nothing but an explicit
//   assertion on which one came back can tell the collapse from the fix.
//
//   THE VIEW'S KEYS, PINNED. A DTO that grew `tokenHash` would raise no type error
//   and every behavioural test would still pass; the key-set assertion is the only
//   thing that would notice.
//
// WHY A DOUBLE IS ENOUGH FOR ALL OF THAT AND FOR NOTHING ELSE. Every rule above is
// a rule of the DOMAIN and the FAÇADE. The rules that belong to PostgreSQL — the
// cross-environment revocation selecting no rows, the concurrent revocation's one
// winner, the ordering that survives a shared instant — are proved in
// `packages/adapters/postgres-tenancy/src/identity-bearer-lifecycle-postgres.integration.test.ts`
// against a real database, because a Map cannot fail any of them.

import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  ORGANIZATION_ID,
  PROJECT_ID,
  SIBLING_ENVIRONMENT,
  at,
} from "../domain/testing.js";
import type { BearerCredentialSummary } from "../domain/index.js";
import { tenantAuthorizationScope } from "../domain/index.js";
import { createIdentityAccessService } from "./identity-access-service.js";
import { testPorts, type TestPorts } from "./testing.js";
import { organizationScope, projectScope, type TenantScope } from "@platos/kernel";

const OPERATOR = "user-1";

function seedCredential(
  ports: TestPorts,
  id: string,
  overrides: Partial<BearerCredentialSummary> & { readonly scope?: TenantScope } = {},
): BearerCredentialSummary {
  const scope = tenantAuthorizationScope(overrides.scope ?? ENVIRONMENT);
  const summary: BearerCredentialSummary = {
    credentialId: id,
    kind: "mcp-token",
    label: id,
    principalId: OPERATOR as never,
    permissions: ["agents.*"],
    permissionTier: "scope",
    subjectId: null,
    scope,
    createdAt: at(0),
    expiresAt: at(86_400_000),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
    // AFTER the spread: an override may supply a `scope` as a `TenantScope`, and
    // the stored value is always the lifted grant.
    ...(overrides.scope === undefined ? {} : { scope }),
  };
  ports.repository.state.bearerCredentialSummaries.set(`${summary.kind}:${id}`, summary);
  return summary;
}

describe("listBearerCredentials — the read that kept four routes in the legacy deployable", () => {
  it("answers one environment's credentials and pins the view's keys", async () => {
    const ports = testPorts();
    seedCredential(ports, "alpha");
    const page = await createIdentityAccessService(ports).listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
    });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.total).toBe(1);
    const [credential] = page.value.credentials;
    expect(credential?.credentialId).toBe("alpha");
    // THE KEY SET IS THE ASSERTION THAT WOULD CATCH A DIGEST. `tokenHash` is not
    // on `BearerCredentialSummary` at all, so a leak would take a deliberate widening
    // of the domain type — and if one happened, no behavioural test in this file
    // would fail and this line would.
    expect(Object.keys(credential ?? {}).sort()).toEqual([
      "createdAt",
      "credentialId",
      "expiresAt",
      "kind",
      "label",
      "lastUsedAt",
      "permissionTier",
      "permissions",
      "principalId",
      "revokedAt",
      "scope",
      "subjectId",
    ]);
    expect(JSON.stringify(credential)).not.toContain("tokenHash");
  });

  it("omits a sibling environment's credential rather than filtering it out afterwards", async () => {
    const ports = testPorts();
    seedCredential(ports, "mine");
    seedCredential(ports, "theirs", { scope: SIBLING_ENVIRONMENT });
    const page = await createIdentityAccessService(ports).listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.credentials.map((row) => row.credentialId)).toEqual(["mine"]);
    // THE TOTAL AGREES WITH THE PAGE. A count taken under a different filter is the
    // pagination control that lies, and it is invisible unless asserted.
    expect(page.value.total).toBe(1);
  });

  it("REFUSES a page above the ceiling instead of clamping it to the ceiling", async () => {
    const ports = testPorts();
    seedCredential(ports, "alpha");
    const page = await createIdentityAccessService(ports).listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
      limit: 500,
    });
    // BOTH ORACLES ANSWER `{ tokens: […], limit: 100 }` HERE. That is the whole
    // difference this assertion exists for: a caller paging by 500 walks off the
    // end of the collection and believes it has seen everything.
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.error.code).toBe("CREDENTIAL_QUERY_INVALID");
    expect(page.error.fields.map((field) => field.field)).toEqual(["limit"]);
  });

  it("refuses a negative offset and a fractional limit by field", async () => {
    const ports = testPorts();
    const service = createIdentityAccessService(ports);
    const negative = await service.listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
      offset: -1,
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.error.fields[0]?.field).toBe("offset");
    const fractional = await service.listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
      limit: 2.5,
    });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.error.fields[0]?.field).toBe("limit");
  });

  it("refuses a scope that is not one environment, naming which scope it got", async () => {
    const ports = testPorts();
    const service = createIdentityAccessService(ports);
    for (const scope of [organizationScope(ORGANIZATION_ID), projectScope(ORGANIZATION_ID, PROJECT_ID)]) {
      const page = await service.listBearerCredentials({ kind: "mcp-token", scope });
      expect(page.ok).toBe(false);
      if (page.ok) continue;
      expect(page.error.code).toBe("CREDENTIAL_QUERY_INVALID");
      expect(page.error.fields[0]?.field).toBe("scope");
    }
  });

  it("requires an entity for an entity listing and refuses one for a platform listing", async () => {
    const ports = testPorts();
    const service = createIdentityAccessService(ports);
    const missing = await service.listBearerCredentials({
      kind: "entity-bearer-token",
      scope: ENVIRONMENT,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.fields[0]?.field).toBe("subjectId");
    // THE OTHER DIRECTION, which is the one an "ignore what you cannot use"
    // implementation would pass. `McpToken` has no entity column, so a subject
    // accepted here would answer a question the caller did not ask.
    const spurious = await service.listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
      subjectId: "entity-1",
    });
    expect(spurious.ok).toBe(false);
    if (!spurious.ok) expect(spurious.error.fields[0]?.field).toBe("subjectId");
  });

  it("derives hasMore from the window and the total rather than asserting it", async () => {
    const ports = testPorts();
    seedCredential(ports, "one", { createdAt: at(2) });
    seedCredential(ports, "two", { createdAt: at(1) });
    seedCredential(ports, "three", { createdAt: at(0) });
    const service = createIdentityAccessService(ports);
    const first = await service.listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.credentials.map((row) => row.credentialId)).toEqual(["one", "two"]);
    expect(first.value.hasMore).toBe(true);
    const last = await service.listBearerCredentials({
      kind: "mcp-token",
      scope: ENVIRONMENT,
      limit: 2,
      offset: 2,
    });
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.value.credentials.map((row) => row.credentialId)).toEqual(["three"]);
    expect(last.value.hasMore).toBe(false);
  });
});

describe("revokeBearerCredential — three outcomes where the oracles had a boolean", () => {
  const revocation = {
    kind: "mcp-token" as const,
    scope: ENVIRONMENT,
    revokedByUserId: OPERATOR,
  };

  it("revokes, then reports the second call as alreadyRevoked", async () => {
    const ports = testPorts();
    seedCredential(ports, "target");
    const service = createIdentityAccessService(ports);

    const first = await service.revokeBearerCredential({ ...revocation, credentialId: "target" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.outcome).toBe("revoked");
    expect(first.value.credential?.revokedAt).not.toBeNull();

    const second = await service.revokeBearerCredential({ ...revocation, credentialId: "target" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // BOTH LEGACY SERVICES RETURN `true` FOR BOTH OF THESE. The whole point of the
    // outcome union is that this line can be written at all.
    expect(second.value.outcome).toBe("alreadyRevoked");
    expect(second.value.credential?.revokedAt).toEqual(first.value.credential?.revokedAt);
  });

  it("answers absent — as an ok Result — for a credential in a sibling environment", async () => {
    const ports = testPorts();
    seedCredential(ports, "theirs", { scope: SIBLING_ENVIRONMENT });
    const outcome = await createIdentityAccessService(ports).revokeBearerCredential({
      ...revocation,
      credentialId: "theirs",
    });
    // AN `ok` RESULT AND NOT AN `err`. The caller asked a well-formed question; the
    // answer is "there is no such credential here". Returning `err` would make an
    // unauthorized cross-environment probe indistinguishable from a broken request.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.outcome).toBe("absent");
    // `credential` IS NULL EXACTLY WHEN `outcome` IS `absent`, which is the
    // invariant the façade's switch exists to make the compiler's.
    expect(outcome.value.credential).toBeNull();
    // AND THE VICTIM IS UNTOUCHED, which the return value alone would not show.
    expect(ports.repository.state.bearerCredentialSummaries.get("mcp-token:theirs")?.revokedAt).toBeNull();
  });

  it("stops a revoked credential authenticating, so the double's two views agree", async () => {
    const ports = testPorts();
    const summary = seedCredential(ports, "coherent");
    // The verification-side record, keyed by DIGEST rather than by id — the same
    // split the two real tables have.
    ports.repository.state.bearerCredentials.set("mcp-token:hash-c", {
      credentialId: summary.credentialId,
      kind: "mcp-token",
      tokenHash: "hash-c" as never,
      tier: "OPERATOR",
      principalId: OPERATOR as never,
      scope: summary.scope,
      permissions: summary.permissions,
      expiresAt: summary.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    await createIdentityAccessService(ports).revokeBearerCredential({
      ...revocation,
      credentialId: "coherent",
    });
    const record = await ports.repository.bearerCredentials.findByTokenHash(
      "mcp-token",
      "hash-c" as never,
    );
    // A DOUBLE THAT MOVED ONLY THE LISTING VIEW would report the credential as
    // revoked and keep authenticating it, which is a state no real table can be in.
    expect(record?.revokedAt).not.toBeNull();
  });

  it("refuses an empty credential id, and an entity revocation that names no entity", async () => {
    const ports = testPorts();
    const service = createIdentityAccessService(ports);
    const blank = await service.revokeBearerCredential({ ...revocation, credentialId: "  " });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.fields[0]?.field).toBe("credentialId");
    const unsubjected = await service.revokeBearerCredential({
      kind: "entity-bearer-token",
      scope: ENVIRONMENT,
      credentialId: "some-token",
      revokedByUserId: OPERATOR,
    });
    expect(unsubjected.ok).toBe(false);
    if (!unsubjected.ok) expect(unsubjected.error.fields[0]?.field).toBe("subjectId");
  });
});
