// WIN-268 (M4.2) — THE LISTING AND THE REVOCATION, OVER THE TWO MINTABLE TABLES.
//
// `identity-bearer.ts` holds VERIFY and MINT and is at its ADR M0.3 §6 budget, so
// the other half of a credential's life lives here. The split falls on a real
// seam: everything below addresses a credential by ITS ID inside an environment,
// where everything there addresses one by its DIGEST.
//
// -----------------------------------------------------------------------------
// TWO TABLES, NOT FOUR — AND FOR THE MINT'S REASON, NOT A NEW ONE
//
// `PersonalAccessToken` and `EndUserSession` have zero production call sites, so
// nothing lists them and nothing revokes them either. `MintableBearerKind` is the
// type that keeps them out; `domain/bearer-token.ts`'s modelling note is why.
//
// -----------------------------------------------------------------------------
// A LISTING PROJECTS NEITHER THE SECRET NOR THE DIGEST
//
// No row holds the raw secret after a mint. `tokenHash` is a different matter:
// every verification compares against it, so a listing that returned it would
// hand a reader offline guessing material for every credential in an environment
// at once. `BearerCredentialSummary` HAS NO SUCH FIELD, so the `select`s below
// could not project it and still compile — which is why the omission is a type
// rather than a review note.
//
// -----------------------------------------------------------------------------
// THE ENVIRONMENT IS THE WHOLE TENANCY CLAUSE, AND THAT IS A SCHEMA FACT
//
// `mint` re-derives a scope from the environment's own ancestry because it must
// READ BACK a tenancy the request could have forged. A listing only FILTERS, and
// both tables carry `environmentId` as a NOT NULL foreign key to `Environment` —
// so a row's `environmentId` IS its tenancy and `where: { environmentId }` is
// complete. Joining the ancestry again would re-derive a value nothing here
// compares against.
//
// FOR THE ENTITY TABLE THE ENTITY IS PART OF THE ADDRESS. `McpBearerToken` carries
// BOTH `entityId` and `environmentId`, and `tenancy/domain/entity.ts` records that
// neither derives from the other. A listing that filtered on the environment alone
// would show an operator holding one entity every OTHER entity's credentials in
// the same environment — which is why `matchesBearerQuery` in the double and the
// two `where` clauses below both carry the entity clause.
//
// -----------------------------------------------------------------------------
// THE REVOCATION IS ONE CONDITIONAL UPDATE FOLLOWED BY ONE READ
//
// `WHERE ... AND revokedAt IS NULL` is what makes a second revoke a no-op rather
// than a rewrite: two operators revoking at once end with one `count: 1` and one
// `count: 0`, and BOTH read back the winner's instant. Overwriting would destroy
// the fact an operator actually needs — when the credential was really ended.
//
// EXPIRY IS NOT IN THE PRECONDITION. Both oracles revoke a lapsed credential
// without checking one, and `revoke-bearer-credential.ts`'s banner says why that
// is right: a lapsed credential can be put beyond use for good.
//
// THE READ-BACK IS WHAT DISTINGUISHES "ALREADY REVOKED" FROM "NEVER EXISTED", and
// `Promise<boolean>` — what both legacy services return — cannot. `null` here
// means no row carries that id in this scope; a result with `newlyRevoked: false`
// means the row is there and was already ended.

import type {
  BearerCredentialQuery,
  BearerCredentialRevocation,
  BearerCredentialRevocationResult,
  BearerCredentialSummary,
  McpPermissionTier,
} from "@platos/context-identity-access/application/ports/index.js";
import { MCP_PERMISSION_TIERS } from "@platos/context-identity-access";
import type { PrincipalId } from "@platos/kernel";

import { UnreadableRowError } from "./mapping.js";
import type { TenancyReader } from "./client.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * A `McpToken.tier` this binary cannot read.
 *
 * ITS OWN CODE, and not `UNKNOWN_IDENTITY_PRINCIPAL_TIER`. That one names the
 * OPERATOR/END_USER axis; this one names the MCP PERMISSION axis, and
 * `identity-bearer.ts`'s banner exists because reading either as the other would
 * make an authorization decision from a value that does not answer the question
 * asked. Two codes so a reader can tell which column was unreadable.
 */
export const UNKNOWN_MCP_PERMISSION_TIER = "identity.row.unknown_mcp_permission_tier";

/**
 * An entity-credential query that named no entity.
 *
 * Its own code because it is a DEFECT rather than an unreadable value: the two
 * planners refuse this shape, so reaching it means a caller bypassed them. See
 * `entityWhere`.
 */
export const ENTITY_CREDENTIAL_SUBJECT_MISSING = "identity.query.entity_credential_subject_missing";

/**
 * `McpToken.tier`, VALIDATED RATHER THAN NORMALISED — and the consequence is
 * named rather than hidden.
 *
 * THERE IS NO CHECK CONSTRAINT ON THIS COLUMN. `EndUserSession.tier` has
 * `EndUserSession_tier_check` in the migrations and `readIdentityTier` can lean on
 * it; `McpToken.tier` is a bare `String`, so nothing in the database stops a row
 * holding `"adminn"`.
 *
 * WHAT THE TWO ANSWERS COST. `token.service.ts` normalises anything that is not
 * `"admin"` to `"scope"`, and that value IS load-bearing in the legacy
 * deployable's permission gateway — so an operator auditing which credentials hold
 * admin would be shown a junk row as `scope` and would miss it. Throwing instead
 * makes such a row an unreadable row, which is the answer `readIdentityTier` gives
 * for the same shape of problem, and it is the one that cannot mislead.
 *
 * THE PRICE IS REAL AND IS RECORDED HERE: one unreadable row fails the whole page
 * it appears on, so an operator would have to reach the legacy listing (which
 * normalises) to see the rest. Nothing this surface writes can produce such a row
 * — the V1 mint refuses an unrecognised tier by name — so this is a guard against
 * history rather than against callers.
 */
export function readMcpPermissionTier(value: string): McpPermissionTier {
  const known: readonly string[] = MCP_PERMISSION_TIERS;
  if (!known.includes(value)) {
    throw new UnreadableRowError(UNKNOWN_MCP_PERMISSION_TIER, "McpToken.tier", value);
  }
  return value as McpPermissionTier;
}

/** `[{ createdAt: "desc" }, { id: "desc" }]` — both oracles', written once.
 *
 * THE ID TIEBREAK IS NOT DECORATION. Two credentials minted in the same
 * millisecond would otherwise page in an order the database picks, and two
 * consecutive pages could overlap or skip a row. */
const NEWEST_FIRST: ReadonlyArray<{ readonly createdAt: "desc" } | { readonly id: "desc" }> =
  Object.freeze([{ createdAt: "desc" }, { id: "desc" }]);

const PLATFORM_COLUMNS = {
  id: true,
  name: true,
  permissions: true,
  tier: true,
  mintedByUserId: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  revokedBy: true,
} as const;

const ENTITY_COLUMNS = {
  id: true,
  label: true,
  scopes: true,
  mcpUserId: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

interface PlatformRow {
  readonly id: string;
  readonly name: string;
  readonly permissions: string[];
  readonly tier: string;
  readonly mintedByUserId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
}

interface EntityRow {
  readonly id: string;
  readonly label: string;
  readonly scopes: string[];
  readonly mcpUserId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

function platformSummary(row: PlatformRow): BearerCredentialSummary {
  return {
    credentialId: row.id,
    kind: "mcp-token",
    label: row.name,
    permissions: row.permissions,
    // The OPERATOR who minted it, which for this table is also the principal the
    // credential acts as — `identity-bearer.ts` reads the same column for the
    // same reason.
    principalId: row.mintedByUserId as PrincipalId,
    permissionTier: readMcpPermissionTier(row.tier),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

function entitySummary(row: EntityRow): BearerCredentialSummary {
  return {
    credentialId: row.id,
    kind: "entity-bearer-token",
    label: row.label,
    permissions: row.scopes,
    // `mcpUserId` is an END USER of the entity, not a Platos user — which is why
    // it is a String with no foreign key.
    principalId: row.mcpUserId as PrincipalId,
    // NO SUCH COLUMN ON THIS TABLE, and null is the schema's answer rather than a
    // placeholder: an entity token has no MCP permission tier at all, which is why
    // the domain refuses a mint of this kind that names one.
    permissionTier: null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    // LIKEWISE ABSENT. `McpBearerToken` has no `revokedBy`; the legacy service
    // records the actor in an `AdminAudit` row, which is `observability`'s and is
    // not composed. Reporting null is what stops a caller believing an
    // attribution was stored that this table cannot hold.
    revokedBy: null,
  };
}

/**
 * The entity table's tenancy clause — BOTH COLUMNS, ALWAYS.
 *
 * A MISSING SUBJECT IS REFUSED AND NOT WIDENED, and that is the one branch worth
 * spelling out. `planBearerCredentialPage` and `planBearerCredentialRevocation`
 * both refuse an `entity-bearer-token` address with no entity, so this cannot be
 * reached through the contract — but the fallback a reader would write by reflex
 * (`subjectId === null ? { environmentId } : { entityId, environmentId }`) is the
 * cross-entity leak this file's banner is about: it answers with EVERY entity's
 * credentials in the environment, and a caller that had lost its entity id would
 * be handed exactly the rows it must not see. So the null case throws, under the
 * same `UnreadableRowError` shape the rest of this package uses for a value it
 * cannot act on.
 */
function entityWhere(query: Pick<BearerCredentialQuery, "environmentId" | "subjectId">) {
  if (query.subjectId === null) {
    throw new UnreadableRowError(
      ENTITY_CREDENTIAL_SUBJECT_MISSING,
      "McpBearerToken.entityId",
      "null",
    );
  }
  return { entityId: query.subjectId, environmentId: query.environmentId };
}

export function createBearerLifecycleStore(transactions: TenancyTransactions) {
  const reader = (): TenancyReader => transactions.reader();

  return {
    async list(query: BearerCredentialQuery): Promise<readonly BearerCredentialSummary[]> {
      // SPREAD INTO EACH CALL rather than shared by reference: Prisma's generated
      // `orderBy` parameter is a MUTABLE array type, so a frozen constant has to be
      // copied at the boundary. Copying is also what stops one query's `orderBy`
      // being reordered under another.
      const window = { skip: query.offset, take: query.limit, orderBy: [...NEWEST_FIRST] };
      if (query.kind === "mcp-token") {
        const rows = await reader().mcpToken.findMany({
          where: { environmentId: query.environmentId },
          select: PLATFORM_COLUMNS,
          ...window,
        });
        return (rows as PlatformRow[]).map(platformSummary);
      }
      const rows = await reader().mcpBearerToken.findMany({
        where: entityWhere(query),
        select: ENTITY_COLUMNS,
        ...window,
      });
      return (rows as EntityRow[]).map(entitySummary);
    },

    async count(query: BearerCredentialQuery): Promise<number> {
      // THE SAME `where`, WITHOUT THE WINDOW. Counted under different filtering it
      // would tell an operator how many credentials exist in tenants they cannot
      // see, and `hasMore` would be derived from it.
      if (query.kind === "mcp-token") {
        return reader().mcpToken.count({ where: { environmentId: query.environmentId } });
      }
      return reader().mcpBearerToken.count({ where: entityWhere(query) });
    },

    async revoke(
      revocation: BearerCredentialRevocation,
    ): Promise<BearerCredentialRevocationResult | null> {
      const client = reader();
      if (revocation.kind === "mcp-token") {
        const where = { id: revocation.credentialId, environmentId: revocation.environmentId };
        const updated = await client.mcpToken.updateMany({
          where: { ...where, revokedAt: null },
          data: { revokedAt: revocation.revokedAt, revokedBy: revocation.revokedByUserId },
        });
        const row = await client.mcpToken.findFirst({ where, select: PLATFORM_COLUMNS });
        if (row === null) return null;
        return { credential: platformSummary(row as PlatformRow), newlyRevoked: updated.count === 1 };
      }
      const where = { id: revocation.credentialId, ...entityWhere(revocation) };
      const updated = await client.mcpBearerToken.updateMany({
        where: { ...where, revokedAt: null },
        // NO `revokedBy`: the column does not exist on this table. Passing one
        // would be a write Prisma refuses at runtime rather than an attribution.
        data: { revokedAt: revocation.revokedAt },
      });
      const row = await client.mcpBearerToken.findFirst({ where, select: ENTITY_COLUMNS });
      if (row === null) return null;
      return { credential: entitySummary(row as EntityRow), newlyRevoked: updated.count === 1 };
    },
  };
}
