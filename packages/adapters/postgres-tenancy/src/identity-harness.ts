// The real-PostgreSQL harness the identity-access integration suites share.
//
// It reuses `startTenancyHarness` rather than starting a second container,
// because the two repositories are ONE adapter over ONE database (ADR M0.3
// §15) and a suite that stood up its own container would be measuring a
// different arrangement from the one that ships.
//
// WHAT IT SEEDS AND WHY IT IS SQL. Four kinds of row are needed that the
// identity-access PORT cannot create: the tenant tree (tenancy's, and available
// through the same adapter), and then `EndUser`, `EndUserIdentity`, `OAuthClient`,
// `OAuthAuthorizationCode` and `McpToken` — identity-access's OWN rows, for which
// the port has a reader and no writer. Those five are seeded with parameterised
// SQL through the same client, which is honest about the fact that this suite is
// standing in for a mint that does not exist in V1 yet, rather than pretending
// the port could have made them.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, inherited from the
// harness it builds on. A skipped integration suite and a passing one are
// indistinguishable in a CI summary.

import type { IdentityAccessRepository } from "@platos/context-identity-access/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import type { PostgresTenancyAdapter } from "./adapter.js";
import { envId, projId, slugOf, startTenancyHarness, type TenancyHarness } from "./harness.js";
import type { OrganizationId } from "@platos/context-tenancy/application/ports/index.js";

/** The tenant node every scoped identity row in these suites hangs off. */
export interface SeededTenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface IdentityHarness {
  readonly client: TenancyDatabaseClient;
  /** The container's connection URI, passed through from the base harness. */
  readonly databaseUrl: string;
  readonly adapter: PostgresTenancyAdapter;
  readonly repository: IdentityAccessRepository;
  statements(): readonly string[];
  resetStatements(): void;
  freshId(kind: string): string;
  /** An organization, a project and an environment, all fresh. */
  seedTenant(slug: string): Promise<SeededTenant>;
  /** A `User` row, written through the adapter's own `UserStore`. */
  seedUser(address: string): Promise<string>;
  /**
   * An ACTIVE `OrganizationMembership`, which most identity rows require.
   *
   * The migrations' `enforce_domain_ancestry` rule refuses an `OAuthClient`,
   * `OAuthAuthorizationCode`, `OAuthAccessToken`, `OAuthRefreshToken`,
   * `McpToken`, `McpBearerToken` or scoped `PersonalAccessToken` whose acting
   * user is not an active member of the organization the scope resolves to.
   * That rule fires on UPDATE as well as INSERT and is in neither
   * `schema.prisma` nor the in-memory double.
   */
  seedMembership(organizationId: string, userId: string): Promise<void>;
  seedEndUser(input: {
    readonly organizationId: string;
    readonly displayName: string | null;
    readonly disabledAt: Date | null;
    readonly createdAt: Date;
    readonly identities: readonly { readonly subject: string; readonly channel: string }[];
  }): Promise<string>;
  seedOAuthClient(organizationId: string, userId: string): Promise<string>;
  seedAuthorizationCode(input: {
    readonly clientId: string;
    readonly userId: string;
    readonly codeHash: string;
    readonly scopeKind: string;
    readonly organizationId: string | null;
    readonly projectId: string | null;
    readonly environmentId: string | null;
    readonly expiresAt: Date;
  }): Promise<void>;
  seedMcpToken(input: {
    readonly environmentId: string;
    readonly mintedByUserId: string;
    readonly tokenHash: string;
    readonly permissions: readonly string[];
    readonly tier: string;
  }): Promise<string>;
  stop(): Promise<void>;
}

const AT = new Date("2026-05-01T09:00:00.000Z");

export async function startIdentityHarness(): Promise<IdentityHarness> {
  const base: TenancyHarness = await startTenancyHarness();
  const { client, adapter } = base;

  const harness: IdentityHarness = {
    client,
    databaseUrl: base.databaseUrl,
    adapter,
    repository: adapter,
    statements: base.statements,
    resetStatements: base.resetStatements,
    freshId: base.freshId,

    async seedTenant(slug: string): Promise<SeededTenant> {
      const organizationId: OrganizationId = await base.seedOrganization(slug);
      const projectId = await base.seedProject(organizationId, `${slug}-project`);
      const environmentId = envId(base.freshId("0003"));
      await adapter.unitOfWork.run((transaction) =>
        adapter.saveEnvironment(
          {
            id: environmentId,
            projectId: projId(projectId),
            slug: slugOf("prod"),
            name: "Production",
            archivedAt: null,
            accessKeyRevocationVersion: 0,
            memoryFeedbackBackfillCursor: null,
            memoryFeedbackBackfillCompletedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return { organizationId, projectId, environmentId };
    },

    async seedUser(address: string): Promise<string> {
      // Through the PORT, not through SQL. `User` is identity-access's row and
      // this package is now its canonical-store delegate, so a fixture that
      // wrote it directly would be skipping the code under test.
      const record = await adapter.users.upsertByEmail(
        address as never,
        base.freshId("0004") as never,
      );
      return record.userId;
    },

    async seedMembership(organizationId: string, userId: string): Promise<void> {
      await adapter.unitOfWork.run((transaction) =>
        adapter.upsertOrganizationMembership(
          {
            organizationId: organizationId as never,
            userId: userId as never,
            role: "OWNER" as never,
            at: AT,
          },
          transaction,
        ),
      );
    },

    async seedEndUser(input): Promise<string> {
      const id = base.freshId("0005");
      await client.$executeRawUnsafe(
        `INSERT INTO "EndUser" ("id","organizationId","displayName","disabledAt","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3,$4::timestamp,$5::timestamp,$5::timestamp)`,
        id,
        input.organizationId,
        input.displayName,
        input.disabledAt,
        input.createdAt,
      );
      for (const identity of input.identities) {
        await client.$executeRawUnsafe(
          `INSERT INTO "EndUserIdentity" ("id","endUserId","organizationId","issuer","channel","subject","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::timestamp,$7::timestamp)`,
          base.freshId("0009"),
          id,
          input.organizationId,
          "platos",
          identity.channel,
          identity.subject,
          input.createdAt,
        );
      }
      return id;
    },

    async seedOAuthClient(organizationId: string, userId: string): Promise<string> {
      const id = base.freshId("0006");
      await client.$executeRawUnsafe(
        `INSERT INTO "OAuthClient" ("id","organizationId","clientId","clientName","redirectUris","tokenEndpointAuthMethod", "grantTypes","scopes","registeredByUserId","createdAt") VALUES ($1::uuid,$2::uuid,$3,'Conformance client',ARRAY['https://example.test/cb'], 'client_secret_basic',ARRAY['authorization_code'],ARRAY['read'],$4::uuid,$5::timestamp)`,
        id,
        organizationId,
        `client-${id}`,
        userId,
        AT,
      );
      return id;
    },

    async seedAuthorizationCode(input): Promise<void> {
      await client.$executeRawUnsafe(
        `INSERT INTO "OAuthAuthorizationCode" ("id","scopeKind","organizationId","projectId","environmentId","clientId","userId", "codeHash","codeChallenge","codeChallengeMethod","redirectUri","scopes","expiresAt","createdAt") VALUES ($1::uuid,$2::"AuthorizationScopeKind",$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid, $8,'challenge','S256','https://example.test/cb',ARRAY['read'],$9::timestamp,$10::timestamp)`,
        base.freshId("0007"),
        input.scopeKind,
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.clientId,
        input.userId,
        input.codeHash,
        input.expiresAt,
        AT,
      );
    },

    async seedMcpToken(input): Promise<string> {
      const id = base.freshId("0008");
      await client.$executeRawUnsafe(
        `INSERT INTO "McpToken" ("id","environmentId","mintedByUserId","name","tokenHash","permissions","tier","createdAt") VALUES ($1::uuid,$2::uuid,$3::uuid,'conformance',$4,$5::text[],$6,$7::timestamp)`,
        id,
        input.environmentId,
        input.mintedByUserId,
        input.tokenHash,
        [...input.permissions],
        input.tier,
        AT,
      );
      return id;
    },

    stop: base.stop,
  };
  return harness;
}
