import { Inject, Injectable } from "@nestjs/common";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";

/**
 * Authenticating an entity bearer token, off the transport.
 *
 * WIN-258's open clause is "no transport imports Prisma".
 * `session-token.controller.ts` held three `mcpBearerToken`/`environment` reads
 * AND the whole admission predicate over them: ten separate conditions in one
 * `if`, deciding whether an unauthenticated caller may mint a scoped session
 * token. Authentication is the least appropriate thing for a controller to own,
 * and this file takes it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REJECTION IS NAMED WHEN THE RESPONSE IS NOT
 *
 * This programme's fifth lesson is "two guards returning the same error code
 * cannot be told apart — mint distinct codes". The controller had TEN guards
 * behind ONE string. Both `throw`s said `Invalid entity bearer`, so no test
 * could establish that the organization check fired rather than the project one,
 * and deleting any single clause of that `if` left every test green.
 *
 * The 401 the CALLER sees must stay opaque — telling an unauthenticated caller
 * WHICH check failed is an oracle for probing entity ids, environment ids and
 * token liveness. So the distinction is minted here, inside the process, where a
 * suite can assert it and an attacker cannot see it. The transport maps every
 * `ok: false` to the same message it always sent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `IdentityAccessContract`
 *
 * `mcpBearerToken` belongs to `tools` (`ADAPTER_BINDINGS` binds
 * `postgres-tenancy:ToolsRepository` to owner `tools`) and `environment` to
 * `tenancy`. Routing here to a published contract is blocked for reasons that
 * are structural rather than a matter of effort, and they are worth stating
 * where the next tranche will read them:
 *
 *   - `packages/contexts/tools/` publishes no contract factory; it is one of the
 *     six contexts `apps/core-api/src/composition/context-ports.ts` names as
 *     publishing use cases "one by one and no assembler over them".
 *   - `tenancy` IS composable — it is the only context that is — but
 *     `apps/agent` depends on no `@platos/context-*` package and has no seam
 *     through which a composed contract could reach its Nest container.
 *
 * So this is the seam, and it is shaped like the contract call that replaces it:
 * a command in, a `Result`-shaped discriminated union out, no Prisma type
 * crossing the boundary in either direction.
 */

/** The scope a caller CLAIMS. Nothing here is trusted until it is checked. */
export interface EntityBearerClaim {
  readonly entityId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** Every distinct way admission can fail. All render as the same 401. */
export type EntityBearerRejection =
  | "unknown-token"
  | "revoked"
  | "expired"
  | "environment-mismatch"
  | "entity-mismatch"
  | "project-mismatch"
  | "organization-mismatch"
  | "environment-unknown"
  | "environment-foreign"
  | "revoked-concurrently";

/** An authenticated bearer, projected to what minting needs. */
export interface AuthenticatedEntityBearer {
  readonly bearerId: string;
  readonly entityId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  /** Null when the bearer never expires; caps the minted token's TTL. */
  readonly expiresAt: Date | null;
}

export type EntityBearerAuthentication =
  | { readonly ok: true; readonly bearer: AuthenticatedEntityBearer }
  | { readonly ok: false; readonly reason: EntityBearerRejection };

function reject(reason: EntityBearerRejection): EntityBearerAuthentication {
  return { ok: false, reason };
}

@Injectable()
export class EntityBearerDirectory {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  /**
   * Admit a bearer token for one claimed scope, and stamp its last use.
   *
   * ORDER MATTERS AND IS DELIBERATE. The liveness re-check is LAST and is a
   * conditional update rather than a read: between the `findUnique` above and
   * the mint below, another request may revoke the token or its expiry may
   * elapse. `updateMany` with the liveness predicate in its `where` makes the
   * check and the stamp one atomic statement, and a `count` of zero means the
   * token stopped being valid underneath us. Re-reading and then updating would
   * be the same race with more steps.
   */
  async authenticate(
    tokenHash: string,
    claim: EntityBearerClaim,
    now: Date,
  ): Promise<EntityBearerAuthentication> {
    const bearer = await this.prisma.mcpBearerToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        environmentId: true,
        expiresAt: true,
        revokedAt: true,
        entity: {
          select: {
            externalId: true,
            project: { select: { id: true, organizationId: true } },
          },
        },
      },
    });

    if (!bearer) return reject("unknown-token");
    if (bearer.revokedAt) return reject("revoked");
    if (bearer.expiresAt && bearer.expiresAt.getTime() <= now.getTime()) {
      return reject("expired");
    }
    if (bearer.environmentId !== claim.environmentId) {
      return reject("environment-mismatch");
    }
    if (bearer.entity.externalId !== claim.entityId) return reject("entity-mismatch");
    if (bearer.entity.project.id !== claim.projectId) return reject("project-mismatch");
    if (bearer.entity.project.organizationId !== claim.organizationId) {
      return reject("organization-mismatch");
    }

    // The claimed environment must EXIST and hang off the same project as the
    // bearer's entity. Without this a caller holding a valid token for one
    // environment could name another environment's id in the body and have the
    // minted token carry it.
    const environment = await this.prisma.environment.findUnique({
      where: { id: claim.environmentId },
      select: { id: true, project: { select: { id: true, organizationId: true } } },
    });
    if (!environment) return reject("environment-unknown");
    if (
      environment.project.id !== bearer.entity.project.id ||
      environment.project.organizationId !== bearer.entity.project.organizationId
    ) {
      return reject("environment-foreign");
    }

    const active = await this.prisma.mcpBearerToken.updateMany({
      where: {
        id: bearer.id,
        environmentId: claim.environmentId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { lastUsedAt: now },
    });
    if (active.count !== 1) return reject("revoked-concurrently");

    return {
      ok: true,
      bearer: {
        bearerId: bearer.id,
        entityId: bearer.entity.externalId,
        organizationId: bearer.entity.project.organizationId,
        projectId: bearer.entity.project.id,
        environmentId: bearer.environmentId,
        expiresAt: bearer.expiresAt ?? null,
      },
    };
  }
}
