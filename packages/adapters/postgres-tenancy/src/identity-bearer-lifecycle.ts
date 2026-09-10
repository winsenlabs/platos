// WIN-268 (M4.2) stage 2 — the LISTING and the REVOCATION halves of
// `BearerCredentialStore`, over the two tables that have an oracle for either.
//
// A SEPARATE FILE FROM `identity-bearer.ts` FOR A MEASURED REASON. That file is
// 429 effective lines and ADR M0.3 §6's max-file-lines budget errors at 500
// (`scripts/arch/max-file-lines.mjs`), so these two methods do not fit beside the
// three that read and mint. The split follows the seam the port itself has:
// everything there is keyed by the DIGEST a caller presented, everything here is
// keyed by the ID in a URL.
//
// AND THE TWO ENDS OF THE MIXIN DO NOT IMPORT EACH OTHER. `identity-bearer.ts`
// imports this file for the three methods, so this file must not import back — the
// shared ancestry select lives in `identity-bearer-scope.ts`, which neither of them
// is imported by. That module's header records the run-time failure the cycle
// produced when it did exist, because it was neither a compile error nor a type
// error: the column specs below were built with `environment: undefined` and every
// projection threw inside a query that had really returned the row.
//
// -----------------------------------------------------------------------------
// TWO TABLES, AND THEY AGREE ON ALMOST NOTHING
//
//   McpToken         name        permissions  tier      mintedByUserId  revokedBy
//   McpBearerToken   label       scopes       —         mcpUserId       —
//
// So the projection is written twice rather than parameterised. A shared helper
// taking column names as strings would type-check with `permissions` and `scopes`
// transposed, and the sign of that mistake would be a credential displayed with
// somebody else's grant list.
//
// `McpBearerToken` HAS NO `revokedBy` COLUMN and `McpToken` does. That is a
// schema fact rather than an oversight here: the entity-token oracle records the
// actor in an `AdminAudit` row instead, and `AdminAudit` is `observability`'s
// table by ADR M0.3 §1 — a context this deployable does not compose. So the actor
// is written where the column exists and dropped where it does not, which is
// stated rather than hidden, and `revokedByUserId` is REQUIRED on the command
// either way so the day that column arrives nothing has to be threaded through.
//
// -----------------------------------------------------------------------------
// THE TENANT CLAUSE IS IN EVERY `where`, AND IT IS NOT DEFENCE IN DEPTH
//
// `BearerCredentialQuery.environmentId` and `BearerCredentialRevocation.environmentId`
// come from a scope `tenancy` re-derived from the environment's own ancestry. Each
// statement below matches on it, so a credential id from a sibling environment
// selects zero rows — the revocation ends `absent` and the listing omits it. There
// is no second code path that could forget: the id alone is never a `where`.
//
// -----------------------------------------------------------------------------
// THE REVOCATION IS A CONDITIONAL UPDATE AND THAT IS WHAT MAKES IT ATOMIC
//
// `updateMany({ where: { …, revokedAt: null }, … })` returns a COUNT, and the
// count is the decision: 1 means this call performed the revocation, 0 means a
// concurrent caller got there first. Two callers therefore produce exactly one
// `revoked` and one `alreadyRevoked`, and the loser reads back the WINNER's
// instant and actor instead of overwriting them. A read-then-write would report
// two revocations and record the second one's timestamp, losing who actually did
// it.

import type {
  BearerCredentialQuery,
  BearerCredentialRevocation,
  BearerCredentialSummary,
  BearerRevocationOutcome,
  McpPermissionTier,
} from "@platos/context-identity-access/application/ports/index.js";

import type { TenancyReader } from "./client.js";
import { IdentityWriteRefused } from "./identity-guards.js";
import { ENVIRONMENT_ANCESTORS, environmentScopeOf } from "./identity-bearer-scope.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * A listing or revocation of a kind that has no oracle for either.
 *
 * A DISTINCT CODE FROM `UNMINTABLE_BEARER_CREDENTIAL_KIND`, and the distinction
 * is the same one that constant's own note draws: that one is raised when
 * somebody tries to CREATE a `PersonalAccessToken` or an `EndUserSession`, this
 * one when somebody tries to ENUMERATE or END one. An operator reading the first
 * goes looking for a mint; reading this one, for a listing. The domain refuses
 * both before an adapter is reached, so a throw here means the plan was bypassed.
 */
export const UNLISTABLE_BEARER_CREDENTIAL_KIND = "identity.row.unlistable_bearer_kind";

/** `McpToken.tier` — the MCP PERMISSION tier, a String column, not a `PrincipalTier`. */
function readPermissionTier(value: string): McpPermissionTier {
  if (value === "scope" || value === "admin") return value;
  // NOT COERCED TO A DEFAULT. `normalizeTier` in the legacy service maps anything
  // unrecognised to `"scope"`, which silently downgrades an `admin` row whose
  // column was written with an unexpected spelling — and a downgrade that looks
  // like data is worse than a refusal that names the row.
  throw new IdentityWriteRefused(
    UNLISTABLE_BEARER_CREDENTIAL_KIND,
    "McpToken.tier",
    `the column holds ${JSON.stringify(value)}, which is neither "scope" nor "admin"`,
  );
}

const PLATFORM_COLUMNS = {
  id: true,
  name: true,
  permissions: true,
  tier: true,
  mintedByUserId: true,
  environmentId: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  environment: ENVIRONMENT_ANCESTORS,
} as const;

const ENTITY_COLUMNS = {
  id: true,
  label: true,
  scopes: true,
  mcpUserId: true,
  entityId: true,
  environmentId: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  environment: ENVIRONMENT_ANCESTORS,
} as const;

/**
 * `createdAt` DESC then `id` DESC — both oracles' `orderBy`.
 *
 * THE TIE-BREAK IS LOAD-BEARING. `createdAt` is not unique: a provisioning script
 * that mints five credentials in one transaction can give them the same instant,
 * and PostgreSQL is then free to return them in any order, so two consecutive
 * pages of an unstable sort can both contain the same row and both omit another.
 * The id makes the order total.
 */
const NEWEST_FIRST = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/** `McpToken` rows are addressed by (id, environment). No entity column exists. */
function platformWhere(query: Pick<BearerCredentialQuery, "environmentId">) {
  return { environmentId: query.environmentId };
}

/** `McpBearerToken` rows are addressed by (id, entity, environment). */
function entityWhere(query: Pick<BearerCredentialQuery, "environmentId" | "subjectId">) {
  if (query.subjectId === null) {
    throw new IdentityWriteRefused(
      UNLISTABLE_BEARER_CREDENTIAL_KIND,
      "BearerCredentialQuery.subjectId",
      "an entity bearer token is keyed by (entity, environment); the plan must name the entity",
    );
  }
  return { environmentId: query.environmentId, entityId: query.subjectId };
}

interface PlatformRow {
  readonly id: string;
  readonly name: string;
  readonly permissions: string[];
  readonly tier: string;
  readonly mintedByUserId: string;
  readonly environmentId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly environment: { readonly projectId: string; readonly project: { readonly organizationId: string } };
}

interface EntityRow {
  readonly id: string;
  readonly label: string;
  readonly scopes: string[];
  readonly mcpUserId: string;
  readonly entityId: string;
  readonly environmentId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly environment: { readonly projectId: string; readonly project: { readonly organizationId: string } };
}

function platformSummary(row: PlatformRow): BearerCredentialSummary {
  return {
    credentialId: row.id,
    kind: "mcp-token",
    label: row.name,
    // `mintedByUserId` IS the principal for this kind: an `McpToken` acts as the
    // operator who minted it. `identity-bearer.ts` says the same thing from the
    // verification side.
    principalId: row.mintedByUserId as never,
    permissions: row.permissions,
    permissionTier: readPermissionTier(row.tier),
    subjectId: null,
    // RE-DERIVED from the environment's own ancestry, exactly as `mint` reads its
    // answer back. A row whose environment moved projects reports the project it
    // is in now, not the one the caller asked about.
    scope: environmentScopeOf(row.environmentId, row.environment, "McpToken"),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

function entitySummary(row: EntityRow): BearerCredentialSummary {
  return {
    credentialId: row.id,
    kind: "entity-bearer-token",
    label: row.label,
    // `mcpUserId` is an END USER of the entity and not a Platos user, which is
    // why the column has no foreign key.
    principalId: row.mcpUserId as never,
    permissions: row.scopes,
    // NO SUCH COLUMN on this table, and null is the schema's answer rather than a
    // placeholder. The domain refuses a mint of this kind that carries a tier.
    permissionTier: null,
    subjectId: row.entityId,
    scope: environmentScopeOf(row.environmentId, row.environment, "McpBearerToken"),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/** The listing and revocation methods, for mixing into the bearer store. */
export interface BearerCredentialLifecycle {
  list(query: BearerCredentialQuery): Promise<readonly BearerCredentialSummary[]>;
  count(query: BearerCredentialQuery): Promise<number>;
  revoke(command: BearerCredentialRevocation): Promise<BearerRevocationOutcome>;
}

export function createBearerCredentialLifecycle(
  transactions: TenancyTransactions,
): BearerCredentialLifecycle {
  return {
    async list(query: BearerCredentialQuery): Promise<readonly BearerCredentialSummary[]> {
      const reader: TenancyReader = transactions.reader();
      if (query.kind === "mcp-token") {
        const rows = await reader.mcpToken.findMany({
          where: platformWhere(query),
          select: PLATFORM_COLUMNS,
          orderBy: NEWEST_FIRST,
          skip: query.offset,
          take: query.limit,
        });
        return rows.map(platformSummary);
      }
      const rows = await reader.mcpBearerToken.findMany({
        where: entityWhere(query),
        select: ENTITY_COLUMNS,
        orderBy: NEWEST_FIRST,
        skip: query.offset,
        take: query.limit,
      });
      return rows.map(entitySummary);
    },

    async count(query: BearerCredentialQuery): Promise<number> {
      const reader = transactions.reader();
      // THE SAME `where` THE PAGE USED, built by the same function. A count under
      // a hand-repeated filter is the pagination bug this port's note describes.
      return query.kind === "mcp-token"
        ? reader.mcpToken.count({ where: platformWhere(query) })
        : reader.mcpBearerToken.count({ where: entityWhere(query) });
    },

    async revoke(command: BearerCredentialRevocation): Promise<BearerRevocationOutcome> {
      const reader = transactions.reader();
      if (command.kind === "mcp-token") {
        const scoped = { id: command.credentialId, ...platformWhere(command) };
        const updated = await reader.mcpToken.updateMany({
          where: { ...scoped, revokedAt: null },
          // `revokedBy` EXISTS ON THIS TABLE, so the actor is recorded.
          data: { revokedAt: command.now, revokedBy: command.revokedByUserId },
        });
        const row = await reader.mcpToken.findFirst({ where: scoped, select: PLATFORM_COLUMNS });
        // READ AFTER THE WRITE, AND THE ABSENT CASE IS DECIDED BY THE READ.
        // A caller whose id is in another environment updates nothing and finds
        // nothing, so it lands here — indistinguishable from a typo, which is the
        // point.
        if (row === null) return { kind: "absent" };
        const credential = platformSummary(row);
        return updated.count === 1
          ? { kind: "revoked", credential }
          : { kind: "alreadyRevoked", credential };
      }
      const scoped = { id: command.credentialId, ...entityWhere(command) };
      const updated = await reader.mcpBearerToken.updateMany({
        where: { ...scoped, revokedAt: null },
        // NO `revokedBy` COLUMN. See the header: the actor travels on the command
        // regardless, so nothing has to be threaded through the day it arrives.
        data: { revokedAt: command.now },
      });
      const row = await reader.mcpBearerToken.findFirst({ where: scoped, select: ENTITY_COLUMNS });
      if (row === null) return { kind: "absent" };
      const credential = entitySummary(row);
      return updated.count === 1
        ? { kind: "revoked", credential }
        : { kind: "alreadyRevoked", credential };
    },
  };
}
