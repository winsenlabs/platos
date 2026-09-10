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
  BearerCredentialMint,
  BearerCredentialRecord,
  TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";
import type { BearerCredentialStore } from "@platos/context-identity-access/application/ports/index.js";

import { createBearerLifecycleStore } from "./identity-bearer-lifecycle.js";
import { IdentityWriteRefused, requireDigest } from "./identity-guards.js";
import type { ScopeAncestry } from "./identity-mapping.js";
import { readAuthorizationScope, readIdentityTier, writeAuthorizationScope } from "./identity-mapping.js";
import { toBearerCredentialRecord } from "./identity-rows.js";
import type { TenancyReader } from "./client.js";
import type { TenancyTransactions } from "./transaction.js";

/** A `save` for a (kind, tokenHash) pair with no row behind it. */
export const BEARER_CREDENTIAL_ABSENT = "identity.write.bearer_credential_absent";

/** A `kind` outside the four the domain enumerates. */
export const UNKNOWN_BEARER_CREDENTIAL_KIND = "identity.row.unknown_bearer_kind";

/**
 * A `mint` of one of the two kinds that have no minting oracle.
 *
 * A DISTINCT CODE FROM `UNKNOWN_BEARER_CREDENTIAL_KIND`, because the two are
 * different mistakes: that one is a kind no table holds, this one is a kind a
 * table holds and nothing in the extraction source has ever written. An operator
 * reading the first goes looking for a typo; reading the second, for the design
 * decision recorded in `domain/bearer-token.ts`'s modelling note.
 */
export const UNMINTABLE_BEARER_CREDENTIAL_KIND = "identity.write.unmintable_bearer_kind";

/** A `mint` whose scope is not one environment. */
export const UNMINTABLE_BEARER_CREDENTIAL_SCOPE = "identity.write.unmintable_bearer_scope";

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
  // WIN-268 (M4.2). LIST, COUNT and REVOKE are composed in from
  // `identity-bearer-lifecycle.ts` rather than written here, for the ADR M0.3 §6
  // budget this file is already at and because they address a credential by its
  // ID inside an environment where everything below addresses one by its DIGEST.
  // Spread FIRST, so a name collision would be a compile error on the explicit
  // member below rather than a silent override of it.
  return {
    ...createBearerLifecycleStore(transactions),

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

    /**
     * WIN-268 (M4.2) P1 — the INSERT `save` deliberately is not.
     *
     * TWO TABLES, NOT FOUR. `PersonalAccessToken` and `EndUserSession` are
     * refused here under the same code an unknown kind gets, and the reason is
     * the modelling note in `domain/bearer-token.ts`: both tables exist in the
     * baseline schema with ZERO production call sites, so nothing in the oracle
     * says what a minted `role` or `identityId` should be. Writing a guess into
     * a table nothing reads would be the worst of both — a row that satisfies a
     * foreign key and means nothing.
     *
     * THE ROW IS READ BACK THROUGH THE SAME PROJECTION `findByTokenHash` USES,
     * and that is not a convenience. The record's `scope` is re-derived from the
     * environment's OWN ancestry (`environment.projectId`,
     * `environment.project.organizationId`), so the value the caller receives is
     * what the database says the credential's tenancy is — never the triple the
     * request carried. A forged triple therefore cannot survive a round trip
     * even if every layer above this one had missed it.
     *
     * A UNIQUE-CONSTRAINT VIOLATION IS LEFT TO PROPAGATE. `tokenHash` is
     * `@unique` on both tables, so two concurrent inserts of one digest end with
     * exactly one row and one driver error. Catching it and answering "already
     * exists" would tell the loser its secret is live when the row belongs to
     * the winner's secret, so the refusal travels and `mint-bearer-credential`
     * turns it into `CREDENTIAL_MINT_REFUSED`.
     */
    async mint(credential: BearerCredentialMint): Promise<BearerCredentialRecord> {
      const client = transactions.reader();
      // The migrations' own `^[0-9a-f]{64}$` check, applied before the insert so
      // a malformed digest is refused under its own code rather than as a
      // constraint violation nobody can attribute.
      const tokenHash = requireDigest(`${credential.kind}.tokenHash`, credential.tokenHash);
      const environmentId = environmentIdOf(credential);
      if (credential.kind === "mcp-token") {
        await client.mcpToken.create({
          data: {
            id: credential.credentialId,
            environmentId,
            mintedByUserId: credential.createdByUserId,
            name: credential.label,
            tokenHash,
            permissions: [...credential.permissions],
            // `McpToken.tier` — the MCP PERMISSION tier, the String column, and
            // NOT the domain's `PrincipalTier`. See the banner at the top of
            // this file; the domain refuses a mint of this kind that does not
            // carry one, so the fallback below is unreachable and is written as
            // a refusal rather than as a default.
            tier: requiredPermissionTier(credential),
            expiresAt: credential.expiresAt,
          },
        });
      } else if (credential.kind === "entity-bearer-token") {
        await client.mcpBearerToken.create({
          data: {
            id: credential.credentialId,
            entityId: requiredSubject(credential),
            environmentId,
            createdByUserId: credential.createdByUserId,
            tokenHash,
            label: credential.label,
            // `mcpUserId` is a free-form identifier for an END USER of the
            // entity, not a Platos user id, which is why it is a String with no
            // foreign key. The domain carries it as the principal.
            mcpUserId: credential.principalId,
            scopes: [...credential.permissions],
            expiresAt: credential.expiresAt,
          },
        });
      } else {
        throw new IdentityWriteRefused(
          UNMINTABLE_BEARER_CREDENTIAL_KIND,
          "BearerCredentialMint.kind",
          `credentials of kind ${JSON.stringify(String(credential.kind))} have no minting oracle; ` +
            "only mcp-token and entity-bearer-token may be minted",
        );
      }

      const written = await this.findByTokenHash(credential.kind, credential.tokenHash);
      if (written === null) {
        // The insert reported success and the row is not readable. That is a
        // defect in this store rather than in the caller, and it is refused
        // loudly instead of being papered over with the plan the caller sent —
        // which would report a scope nothing had verified.
        throw new IdentityWriteRefused(
          BEARER_CREDENTIAL_ABSENT,
          `${credential.kind}.tokenHash`,
          "the credential was inserted and could not be read back",
        );
      }
      return written;
    },
  };
}

/** The environment a mint is bounded by, or a refusal naming why it is not one. */
function environmentIdOf(credential: BearerCredentialMint): string {
  const columns = writeAuthorizationScope(credential.scope);
  if (columns.scopeKind !== "ENVIRONMENT" || columns.environmentId === null) {
    throw new IdentityWriteRefused(
      UNMINTABLE_BEARER_CREDENTIAL_SCOPE,
      "BearerCredentialMint.scope",
      `a bearer credential is bounded by ONE environment; this mint carries a ${columns.scopeKind} scope`,
    );
  }
  return columns.environmentId;
}

/** `McpToken.tier`, which the column requires and the domain has already checked. */
function requiredPermissionTier(credential: BearerCredentialMint): string {
  if (credential.permissionTier === null) {
    throw new IdentityWriteRefused(
      UNMINTABLE_BEARER_CREDENTIAL_KIND,
      "McpToken.tier",
      "an MCP platform token must declare its permission tier",
    );
  }
  return credential.permissionTier;
}

/** `McpBearerToken.entityId`, likewise. */
function requiredSubject(credential: BearerCredentialMint): string {
  if (credential.subjectId === null) {
    throw new IdentityWriteRefused(
      UNMINTABLE_BEARER_CREDENTIAL_KIND,
      "McpBearerToken.entityId",
      "an entity bearer token must name the entity it is scoped to",
    );
  }
  return credential.subjectId;
}
