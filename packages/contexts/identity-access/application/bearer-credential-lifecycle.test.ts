// The LISTING and the REVOCATION as rules, with no database and no server.
//
// WIN-268 (M4.2). What is proved here is everything that does not need
// PostgreSQL: the page grammar, the kind/subject pairing, the three states a
// revocation reports, and the one refusal it has. The real-database claims —
// that a revoked token stops authenticating, that a concurrent second revoke does
// not rewrite the first one's instant, that one entity's listing excludes a
// sibling's — live in
// `packages/adapters/postgres-tenancy/src/identity-bearer-lifecycle.integration.test.ts`,
// because a Map cannot settle any of them.
//
// THE DOUBLE IS SEEDED THROUGH `mint`, which is deliberate rather than
// convenient: `state.bearerCredentials` is keyed on `(kind, tokenHash)` and holds
// no `label` and no `createdAt`, so a listing needs the second map that only `mint`
// writes. `list` REFUSES a credential seeded past it, and one case below proves
// that refusal rather than leaving it as a comment.

import { describe, expect, it } from "vitest";

import { createIdentityAccessService } from "./identity-access-service.js";
import { testPorts, type TestPorts } from "./testing.js";
import {
  DEFAULT_BEARER_PAGE_SIZE,
  MAX_BEARER_PAGE_SIZE,
  planBearerCredentialPage,
  planBearerCredentialRevocation,
  tenantAuthorizationScope,
} from "../domain/index.js";
import type { IdentityAccessContract } from "../contracts/index.js";
import { asIdentifier, environmentScope, type PrincipalId, type TenantScope } from "@platos/kernel";

const ORGANIZATION = "org-1";
const PROJECT = "project-1";
const ENVIRONMENT = "environment-1";
const OTHER_ENVIRONMENT = "environment-2";
const OPERATOR = "user-1";
const ENTITY = "entity-1";
const SIBLING = "entity-2";

function scope(environmentId: string = ENVIRONMENT): TenantScope {
  return environmentScope(
    asIdentifier(ORGANIZATION),
    asIdentifier(PROJECT),
    asIdentifier(environmentId),
  );
}

function service(): { readonly ports: TestPorts; readonly identity: IdentityAccessContract } {
  const ports = testPorts();
  return { ports, identity: createIdentityAccessService(ports) };
}

async function mintPlatform(
  identity: IdentityAccessContract,
  label: string,
  environmentId: string = ENVIRONMENT,
): Promise<string> {
  const minted = await identity.mintBearerCredential({
    kind: "mcp-token",
    scope: scope(environmentId),
    label,
    permissions: ["tools.*"],
    createdByUserId: OPERATOR,
    principalId: asIdentifier<PrincipalId>(OPERATOR),
    subjectId: null,
    permissionTier: "scope",
    ttlSeconds: null,
  });
  expect(minted.ok, JSON.stringify(minted)).toBe(true);
  return minted.ok ? minted.value.credentialId : "";
}

async function mintEntity(
  identity: IdentityAccessContract,
  label: string,
  subjectId: string,
): Promise<string> {
  const minted = await identity.mintBearerCredential({
    kind: "entity-bearer-token",
    scope: scope(),
    label,
    permissions: ["mcp:tools"],
    createdByUserId: OPERATOR,
    principalId: null,
    subjectId,
    permissionTier: null,
    ttlSeconds: null,
  });
  expect(minted.ok, JSON.stringify(minted)).toBe(true);
  return minted.ok ? minted.value.credentialId : "";
}

describe("WIN-268 — the page grammar REFUSES rather than clamps", () => {
  it("defaults to fifty and caps at one hundred, both extracted from the oracles", () => {
    // `boundedInteger(options.limit, 50, 1, 100)` in both `token.service.list` and
    // `mcp-bearer-token.list`. The NUMBERS are theirs; refusing instead of clamping
    // is `planEndUserPage`'s rule and the chassis's.
    expect(DEFAULT_BEARER_PAGE_SIZE).toBe(50);
    expect(MAX_BEARER_PAGE_SIZE).toBe(100);
    const defaulted = planBearerCredentialPage({
      kind: "mcp-token",
      scope: tenantAuthorizationScope(scope()),
      subjectId: null,
      limit: null,
      offset: null,
    });
    expect(defaulted.ok && defaulted.value.limit).toBe(DEFAULT_BEARER_PAGE_SIZE);
    expect(defaulted.ok && defaulted.value.offset).toBe(0);

    // THE BOUNDARY IS ACCEPTED and one past it is refused, so the cap is a cap
    // rather than an off-by-one.
    for (const [limit, accepted] of [
      [MAX_BEARER_PAGE_SIZE, true],
      [MAX_BEARER_PAGE_SIZE + 1, false],
      [1, true],
      [0, false],
      [-1, false],
      [1.5, false],
    ] as const) {
      const planned = planBearerCredentialPage({
        kind: "mcp-token",
        scope: tenantAuthorizationScope(scope()),
        subjectId: null,
        limit,
        offset: null,
      });
      expect(planned.ok, `limit ${String(limit)}`).toBe(accepted);
    }
  });

  it("derives the environment LEAF from the scope, and refuses a scope that is not one", () => {
    const planned = planBearerCredentialPage({
      kind: "mcp-token",
      scope: tenantAuthorizationScope(scope()),
      subjectId: null,
      limit: null,
      offset: null,
    });
    expect(planned.ok && planned.value.environmentId).toBe(ENVIRONMENT);
    // A GLOBAL grant reaches every tenant, so a credential listing bounded by one
    // would be a listing bounded by nothing.
    const global = planBearerCredentialPage({
      kind: "mcp-token",
      scope: { kind: "GLOBAL" },
      subjectId: null,
      limit: null,
      offset: null,
    });
    expect(global.ok).toBe(false);
    if (!global.ok) expect(global.error.code).toBe("CREDENTIAL_MATERIAL_INVALID");
  });

  it("refuses a revocation that names no credential", () => {
    const planned = planBearerCredentialRevocation({
      kind: "mcp-token",
      credentialId: "   ",
      scope: tenantAuthorizationScope(scope()),
      subjectId: null,
      revokedByUserId: OPERATOR,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error.code).toBe("CREDENTIAL_MATERIAL_INVALID");
  });
});

describe("WIN-268 — the listing answers for ONE environment and ONE entity", () => {
  it("excludes credentials in a sibling environment, and counts under the same clause", async () => {
    const { identity } = service();
    const mine = await mintPlatform(identity, "mine");
    const theirs = await mintPlatform(identity, "theirs", OTHER_ENVIRONMENT);

    const page = await identity.listBearerCredentials({ kind: "mcp-token", scope: scope() });
    expect(page.ok, JSON.stringify(page)).toBe(true);
    if (!page.ok) return;
    expect(page.value.credentials.map((row) => row.credentialId)).toEqual([mine]);
    // NOT VACUOUS: the excluded credential really exists and is really listable
    // under its own environment.
    const sibling = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scope(OTHER_ENVIRONMENT),
    });
    expect(sibling.ok && sibling.value.credentials.map((row) => row.credentialId)).toEqual([theirs]);
    expect(page.value.total).toBe(1);
    expect(page.value.hasMore).toBe(false);
  });

  it("excludes a SIBLING ENTITY's credentials inside the same environment", async () => {
    const { identity } = service();
    const mine = await mintEntity(identity, "mine", ENTITY);
    await mintEntity(identity, "theirs", SIBLING);
    const page = await identity.listBearerCredentials({
      kind: "entity-bearer-token",
      scope: scope(),
      subjectId: ENTITY,
    });
    expect(page.ok && page.value.credentials.map((row) => row.credentialId)).toEqual([mine]);
    expect(page.ok && page.value.total).toBe(1);
  });

  it("pages NEWEST-FIRST with no overlap, which the double must reproduce", async () => {
    // A MUTATION SURVIVED WITHOUT THIS CASE: returning 0 from the double's
    // comparator left every other case green, because nothing here listed more than
    // one credential in an order-sensitive way.
    //
    // WHY IT MATTERS FOR A FAKE. Both oracles order `[{ createdAt: "desc" }, { id:
    // "desc" }]` and the SQL adapter reproduces it; a double that ordered
    // arbitrarily would let a use-case test about paging pass against a store the
    // real one contradicts, and the id tiebreak is what makes two consecutive pages
    // total rather than merely usually disjoint.
    const { ports, identity } = service();
    const ids: string[] = [];
    for (const label of ["first", "second", "third", "fourth"]) {
      ids.push(await mintPlatform(identity, label));
      // The double stamps `createdAt` from the wall clock, so distinct instants need
      // distinct milliseconds; without this the tiebreak is the only ordering left
      // and the case would be proving half of the rule.
      ports.clock.advance(1000);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const first = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scope(),
      limit: 2,
      offset: 0,
    });
    const second = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scope(),
      limit: 2,
      offset: 2,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.total).toBe(4);
    expect(first.value.hasMore).toBe(true);
    expect(second.value.hasMore).toBe(false);
    // NEWEST FIRST: the last minted leads the first page.
    expect(first.value.credentials[0]?.credentialId).toBe(ids[3]);
    expect(second.value.credentials.at(-1)?.credentialId).toBe(ids[0]);
    // AND THE TWO PAGES ARE DISJOINT AND COMPLETE — four distinct ids over two pages.
    const seen = [...first.value.credentials, ...second.value.credentials].map(
      (row) => row.credentialId,
    );
    expect(new Set(seen).size).toBe(4);
    const instants = [...first.value.credentials, ...second.value.credentials].map((row) =>
      row.createdAt.getTime(),
    );
    expect(instants).toEqual([...instants].sort((left, right) => right - left));
  });

  it("refuses a platform listing that names an entity, and an entity listing that omits one", async () => {
    const { identity } = service();
    for (const request of [
      { kind: "mcp-token" as const, scope: scope(), subjectId: ENTITY },
      { kind: "entity-bearer-token" as const, scope: scope() },
    ]) {
      const refused = await identity.listBearerCredentials(request);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("CREDENTIAL_SUBJECT_MISMATCH");
    }
  });

  it("publishes NO credential material — not the secret and not the digest", async () => {
    const { ports, identity } = service();
    const minted = await identity.mintBearerCredential({
      kind: "mcp-token",
      scope: scope(),
      label: "inspected",
      permissions: ["tools.*"],
      createdByUserId: OPERATOR,
      principalId: asIdentifier<PrincipalId>(OPERATOR),
      subjectId: null,
      permissionTier: "scope",
      ttlSeconds: null,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const stored = [...ports.repository.state.bearerCredentials.values()][0];
    expect(stored?.tokenHash).toBeDefined();

    const page = await identity.listBearerCredentials({ kind: "mcp-token", scope: scope() });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const rendered = JSON.stringify(page.value.credentials);
    // THE DIGEST IS IN THE STORE AND IS NOT IN THE VIEW. Asserted against the
    // value the store actually holds, so this cannot pass by the digest happening
    // to be absent from both.
    expect(rendered).not.toContain(String(stored?.tokenHash));
    expect(rendered).not.toContain(minted.value.token);
    expect(Object.keys(page.value.credentials[0] ?? {})).not.toContain("tokenHash");
  });

  it("reports a LAPSED credential as `expired`, not as active", async () => {
    // A MUTATION SURVIVED WITHOUT THIS CASE. Replacing `credentialStateAt` with
    // `revokedAt === null ? "active" : "revoked"` left every other case green,
    // because nothing listed a credential the CLOCK had ended — and an operator
    // reading that table would have been shown a dead token as live.
    //
    // THE STATE IS THE ONE LIFECYCLE RULE'S, and it is the reason the view asks
    // rather than compares: `domain/credential.ts` decides once, for every
    // credential in this context, that a revocation beats an expiry.
    const { ports, identity } = service();
    await mintPlatform(identity, "lapsing");
    const live = await identity.listBearerCredentials({ kind: "mcp-token", scope: scope() });
    expect(live.ok && live.value.credentials[0]?.state).toBe("active");

    // Past the ninety-day default, with nothing revoked.
    ports.clock.advance(91 * 24 * 60 * 60 * 1000);
    const lapsed = await identity.listBearerCredentials({ kind: "mcp-token", scope: scope() });
    expect(lapsed.ok, JSON.stringify(lapsed)).toBe(true);
    if (!lapsed.ok) return;
    expect(lapsed.value.credentials[0]?.revokedAt).toBeNull();
    expect(lapsed.value.credentials[0]?.state).toBe("expired");

    // AND REVOKED BEATS EXPIRED when both are true, which is the ordering the rule
    // exists to fix once. A view that reported the clock here would invite a caller
    // to wait out a decision somebody made.
    const credentialId = lapsed.value.credentials[0]?.credentialId ?? "";
    await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId,
      scope: scope(),
      revokedByUserId: OPERATOR,
    });
    const ended = await identity.listBearerCredentials({ kind: "mcp-token", scope: scope() });
    expect(ended.ok && ended.value.credentials[0]?.state).toBe("revoked");
  });

  it("REFUSES a credential seeded past `mint` rather than answering a short page", async () => {
    const { ports, identity } = service();
    await mintPlatform(identity, "listed");
    // Straight into the authentication-side map, which is what four existing
    // suites do. A double that skipped it would answer `total: 1` for two rows.
    ports.repository.state.bearerCredentials.set("mcp-token:unseeded-digest", {
      credentialId: "not-in-the-listing",
      kind: "mcp-token",
      tokenHash: asIdentifier("unseeded-digest"),
      tier: "OPERATOR",
      principalId: asIdentifier<PrincipalId>(OPERATOR),
      scope: tenantAuthorizationScope(scope()),
      permissions: [],
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    await expect(
      identity.listBearerCredentials({ kind: "mcp-token", scope: scope() }),
    ).rejects.toThrow(/seeded without its listing columns/u);
  });
});

describe("WIN-268 — the revocation's three states and its one refusal", () => {
  it("reports `active` -> revoked, then `revoked` on the SECOND call, keeping the first instant", async () => {
    const { ports, identity } = service();
    const credentialId = await mintPlatform(identity, "target");
    const firstInstant = ports.clock.now();

    const first = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId,
      scope: scope(),
      revokedByUserId: OPERATOR,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.value.newlyRevoked).toBe(true);
    expect(first.value.previousState).toBe("active");
    expect(first.value.revokedAt).toEqual(firstInstant);
    expect(first.value.revokedBy).toBe(OPERATOR);

    // THE CLOCK MOVES, so a rewrite would be visible.
    ports.clock.advance(3_600_000);
    const second = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId,
      scope: scope(),
      revokedByUserId: "somebody-else",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.newlyRevoked).toBe(false);
    expect(second.value.previousState).toBe("revoked");
    expect(second.value.revokedAt).toEqual(firstInstant);
    expect(second.value.revokedBy).toBe(OPERATOR);
  });

  it("reports `expired` for a credential the CLOCK ended, and ends it anyway", async () => {
    const { ports, identity } = service();
    const credentialId = await mintPlatform(identity, "lapsing");
    // Past the ninety-day default.
    ports.clock.advance(91 * 24 * 60 * 60 * 1000);
    const revoked = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId,
      scope: scope(),
      revokedByUserId: OPERATOR,
    });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.value.newlyRevoked).toBe(true);
    // A DECISION, DISTINGUISHED FROM A CLOCK. The legacy boolean could not.
    expect(revoked.value.previousState).toBe("expired");
    expect(revoked.value.revokedAt).toEqual(ports.clock.now());
  });

  it("refuses an id no row in the scope carries — CREDENTIAL_NOT_FOUND, its own code", async () => {
    const { identity } = service();
    const credentialId = await mintPlatform(identity, "elsewhere", OTHER_ENVIRONMENT);
    // THE ID IS REAL. What is wrong is the environment, so this also proves the
    // revocation is scoped rather than global — an id-only lookup would succeed.
    const refused = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId,
      scope: scope(),
      revokedByUserId: OPERATOR,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("CREDENTIAL_NOT_FOUND");
      expect(refused.error.category).toBe("not_found");
      // IT DOES NOT NAME THE SCOPE IT SEARCHED: a caller could otherwise walk
      // environment ids and read which one holds a credential out of the
      // difference between two refusals.
      expect(JSON.stringify(refused.error.details)).not.toContain(ENVIRONMENT);
    }
  });

  it("refuses to revoke ANOTHER ENTITY's credential through the same environment", async () => {
    const { identity } = service();
    const theirs = await mintEntity(identity, "theirs", SIBLING);
    const refused = await identity.revokeBearerCredential({
      kind: "entity-bearer-token",
      credentialId: theirs,
      scope: scope(),
      subjectId: ENTITY,
      revokedByUserId: OPERATOR,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CREDENTIAL_NOT_FOUND");
    // NOT VACUOUS: the credential's own entity can revoke it.
    const allowed = await identity.revokeBearerCredential({
      kind: "entity-bearer-token",
      credentialId: theirs,
      scope: scope(),
      subjectId: SIBLING,
      revokedByUserId: OPERATOR,
    });
    expect(allowed.ok && allowed.value.newlyRevoked).toBe(true);
  });

  it("reports `revokedBy` as NULL for an entity token, because the table has no column", async () => {
    const { identity } = service();
    const credentialId = await mintEntity(identity, "entity credential", ENTITY);
    const revoked = await identity.revokeBearerCredential({
      kind: "entity-bearer-token",
      credentialId,
      scope: scope(),
      subjectId: ENTITY,
      revokedByUserId: OPERATOR,
    });
    expect(revoked.ok).toBe(true);
    // THE OPERATOR WAS SUPPLIED AND IS REPORTED AS NOT STORED. Reporting it back
    // would tell a caller an attribution exists that `McpBearerToken` cannot hold.
    if (revoked.ok) expect(revoked.value.revokedBy).toBeNull();
  });

  it("ENDS the row rather than deleting it, so the credential still resolves as revoked", async () => {
    const { ports, identity } = service();
    const credentialId = await mintPlatform(identity, "ended");
    await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId,
      scope: scope(),
      revokedByUserId: OPERATOR,
    });
    // THE AUTHENTICATION-SIDE ROW MOVED WITH IT. A double that ended only the
    // listing would leave a revoked credential authenticating.
    const rows = [...ports.repository.state.bearerCredentials.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toEqual(ports.clock.now());
    // And the listing shows it as revoked rather than dropping it: an operator has
    // to be able to see that a credential was ended.
    const page = await identity.listBearerCredentials({ kind: "mcp-token", scope: scope() });
    expect(page.ok && page.value.credentials[0]?.state).toBe("revoked");
  });
});
