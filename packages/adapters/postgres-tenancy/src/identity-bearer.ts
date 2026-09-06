// `BearerCredentialStore` — one port over FOUR tables.
//
// `McpToken`, `McpBearerToken`, `PersonalAccessToken` and `EndUserSession` are
// four rows that differ in which table they live in and almost nothing else, so
// the domain models them once. That makes this store a DISPATCH: the `kind`
// selects the table, and each table's own columns are projected onto the shared
// record.
//
// TWO THINGS THE SCHEMA SAYS THAT THE DOUBLE CANNOT.
//
// FIRST: `McpToken.tier` IS NOT A `PrincipalTier`. It is a String column holding
// `"scope"` or `"admin"` — the MCP permission tier from `token.service.ts`'s
// `PlatosMCPTokenTier`, an entirely different axis from the OPERATOR/END_USER
// enum the domain means by `tier`. Reading it as one would either refuse every
// McpToken row as unreadable, or — worse, if it were cast — make an
// authorization decision from a value that does not answer the question asked.
// The principal tier of an McpToken is OPERATOR because a User mints it; the
// permission tier stays in `permissions` territory and is not this port's
// business. The in-memory fake stores an assembled `PrincipalTier` and never
// meets the column at all.
//
// SECOND: `save` UPDATES, IT DOES NOT INSERT. Every one of the four tables has
// required columns the port cannot supply — `McpToken.name` and `mintedByUserId`,
// `McpBearerToken.label` and `mcpUserId`, `PersonalAccessToken.name` and `role`,
// `EndUserSession.identityId`. The port's only caller is
// `authenticate-bearer-token`, which saves `touchedCredential(credential, now)`
// — a credential it has just READ. So a save with no row behind it is a defect,
// and it is refused under its own code rather than silently creating a row this
// store would have to invent half of.

import type {
  BearerCredentialKind,
  BearerCredentialRecord,
  TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";
import type { BearerCredentialStore } from "@platos/context-identity-access/application/ports/index.js";

import { IdentityWriteRefused } from "./identity-guards.js";
import type { ScopeAncestry } from "./identity-mapping.js";
import { readAuthorizationScope, readIdentityTier } from "./identity-mapping.js";
import { toBearerCredentialRecord } from "./identity-rows.js";
import type { TenancyReader } from "./client.js";
import type { TenancyTransactions } from "./transaction.js";

/** A `save` for a (kind, tokenHash) pair with no row behind it. */
export const BEARER_CREDENTIAL_ABSENT = "identity.write.bearer_credential_absent";

/** A `kind` outside the four the domain enumerates. */
export const UNKNOWN_BEARER_CREDENTIAL_KIND = "identity.row.unknown_bearer_kind";

const ENVIRONMENT_ANCESTORS = {
  select: { projectId: true, project: { select: { organizationId: true } } },
} as const;

interface EnvironmentAncestor {
  readonly projectId: string;
  readonly project: { readonly organizationId: string };
}

function environmentAncestry(environment: EnvironmentAncestor): ScopeAncestry {
  return {
    environmentProjectId: environment.projectId,
    environmentOrganizationId: environment.project.organizationId,
  };
}

function environmentScopeOf(
  environmentId: string,
  environment: EnvironmentAncestor,
  table: string,
) {
  return readAuthorizationScope(
    { scopeKind: "ENVIRONMENT", organizationId: null, projectId: null, environmentId },
    environmentAncestry(environment),
    table,
  );
}

async function readMcpToken(reader: TenancyReader, tokenHash: string) {
  const row = await reader.mcpToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      environmentId: true,
      mintedByUserId: true,
      permissions: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      environment: ENVIRONMENT_ANCESTORS,
    },
  });
  if (row === null) return null;
  return toBearerCredentialRecord({
    credentialId: row.id,
    kind: "mcp-token",
    tokenHash: row.tokenHash,
    // See the note at the top of this file: NOT `row.tier`.
    tier: "OPERATOR",
    principalId: row.mintedByUserId,
    scope: environmentScopeOf(row.environmentId, row.environment, "McpToken"),
    permissions: row.permissions,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  });
}

async function readEntityBearerToken(reader: TenancyReader, tokenHash: string) {
  const row = await reader.mcpBearerToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      environmentId: true,
      mcpUserId: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      environment: ENVIRONMENT_ANCESTORS,
    },
  });
  if (row === null) return null;
  return toBearerCredentialRecord({
    credentialId: row.id,
    kind: "entity-bearer-token",
    tokenHash: row.tokenHash,
    // `mcpUserId` is an END USER of the entity, not an operator of the platform.
    tier: "END_USER",
    principalId: row.mcpUserId,
    scope: environmentScopeOf(row.environmentId, row.environment, "McpBearerToken"),
    permissions: row.scopes,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  });
}

async function readPersonalAccessToken(reader: TenancyReader, tokenHash: string) {
  const row = await reader.personalAccessToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      userId: true,
      scopeKind: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
      permissions: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      project: { select: { organizationId: true } },
      environment: ENVIRONMENT_ANCESTORS,
    },
  });
  if (row === null) return null;
  return toBearerCredentialRecord({
    credentialId: row.id,
    kind: "personal-access-token",
    tokenHash: row.tokenHash,
    tier: "OPERATOR",
    principalId: row.userId,
    scope: readAuthorizationScope(
      row,
      {
        projectOrganizationId: row.project?.organizationId ?? null,
        environmentProjectId: row.environment?.projectId ?? null,
        environmentOrganizationId: row.environment?.project.organizationId ?? null,
      },
      "PersonalAccessToken",
    ),
    permissions: row.permissions,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  });
}

async function readEndUserSession(reader: TenancyReader, tokenHash: string) {
  const row = await reader.endUserSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      identityId: true,
      environmentId: true,
      tier: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      environment: ENVIRONMENT_ANCESTORS,
    },
  });
  if (row === null) return null;
  return toBearerCredentialRecord({
    credentialId: row.id,
    kind: "end-user-session",
    tokenHash: row.tokenHash,
    // The ONE of the four with a real `PrincipalTier` column, pinned to
    // END_USER by `EndUserSession_tier_check` in the migrations. It is READ and
    // validated rather than assumed, so a row written before that check existed
    // fails loudly instead of being trusted.
    tier: readIdentityTier("EndUserSession.tier", row.tier),
    principalId: row.identityId,
    scope: environmentScopeOf(row.environmentId, row.environment, "EndUserSession"),
    // No permission column on this table. An empty list is the schema's answer,
    // not a placeholder: `assertPermission` then denies every named permission,
    // which is the safe direction.
    permissions: [],
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    // `lastSeenAt` is this table's spelling of `lastUsedAt`.
    lastUsedAt: row.lastSeenAt,
  });
}

export function createBearerCredentialStore(
  transactions: TenancyTransactions,
): BearerCredentialStore {
  return {
    async findByTokenHash(
      kind: BearerCredentialKind,
      tokenHash: TokenHash,
    ): Promise<BearerCredentialRecord | null> {
      const reader = transactions.reader();
      if (kind === "mcp-token") return readMcpToken(reader, tokenHash);
      if (kind === "entity-bearer-token") return readEntityBearerToken(reader, tokenHash);
      if (kind === "personal-access-token") return readPersonalAccessToken(reader, tokenHash);
      if (kind === "end-user-session") return readEndUserSession(reader, tokenHash);
      throw new IdentityWriteRefused(
        UNKNOWN_BEARER_CREDENTIAL_KIND,
        "BearerCredentialRecord.kind",
        `no table holds bearer credentials of kind ${JSON.stringify(String(kind))}`,
      );
    },

    async save(credential: BearerCredentialRecord): Promise<void> {
      const client = transactions.reader();
      const where = { tokenHash: credential.tokenHash };
      let count: number;
      if (credential.kind === "mcp-token") {
        const result = await client.mcpToken.updateMany({
          where,
          data: { lastUsedAt: credential.lastUsedAt, revokedAt: credential.revokedAt },
        });
        count = result.count;
      } else if (credential.kind === "entity-bearer-token") {
        const result = await client.mcpBearerToken.updateMany({
          where,
          data: { lastUsedAt: credential.lastUsedAt, revokedAt: credential.revokedAt },
        });
        count = result.count;
      } else if (credential.kind === "personal-access-token") {
        const result = await client.personalAccessToken.updateMany({
          where,
          data: { lastUsedAt: credential.lastUsedAt, revokedAt: credential.revokedAt },
        });
        count = result.count;
      } else if (credential.kind === "end-user-session") {
        const result = await client.endUserSession.updateMany({
          where,
          data: { lastSeenAt: credential.lastUsedAt, revokedAt: credential.revokedAt },
        });
        count = result.count;
      } else {
        throw new IdentityWriteRefused(
          UNKNOWN_BEARER_CREDENTIAL_KIND,
          "BearerCredentialRecord.kind",
          `no table holds bearer credentials of kind ${JSON.stringify(String(credential.kind))}`,
        );
      }
      if (count !== 1) {
        throw new IdentityWriteRefused(
          BEARER_CREDENTIAL_ABSENT,
          `${credential.kind}.tokenHash`,
          `no ${credential.kind} row carries this digest; save updates a credential, it does not mint one`,
        );
      }
    },
  };
}
