// Use case: record the liveness fact the tool-sync socket owns.
//
// THIS USE CASE EXISTS BECAUSE `Entity.connectionStatus` HAD NO WRITER AT ALL.
// The column is tenancy's — `Entity` is this context's fourth aggregate — and
// the only thing in the product that writes it is
// `apps/agent/src/tool-gateway/tool-sync-ws.service.ts`, which reaches the row
// through Prisma directly. `docs/audits/win-269-tool-lifecycle-reach.json`
// records both of that file's `Entity.update` sites as `blockedOnContract` with
// the reason stated in one line: "`Entity.connectionStatus` is a liveness fact
// `tenancy` owns the row for and publishes no writer of". This is that writer,
// and publishing it is what makes those two sites movable.
//
// THE SEMANTICS ARE THE ORACLE'S, COPIED RATHER THAN DESIGNED.
//
//   CONNECT    `{ connectionStatus: "connected", lastConnectedAt: <now> }`,
//              written after the handshake resolves an entity and an
//              environment (tool-sync-ws.service.ts:341).
//   DISCONNECT `{ connectionStatus: "disconnected" }` and NOTHING ELSE, written
//              on close and only when no other environment connection for that
//              entity remains (tool-sync-ws.service.ts:385).
//
// THE "LAST CONNECTION WINS" RULE IS THE CALLER'S AND STAYS THERE. The oracle
// decides whether any connection is left by looking at its own in-memory
// connection map, which is a fact about ONE process and cannot be re-derived
// from the database: two replicas each holding a live socket for the same entity
// would both read the same row and neither could tell the other's socket from a
// stale one. So this use case records the transition it is TOLD, and the socket
// that owns the map is the thing that decides which transition to ask for. That
// is a faithful port; inventing a quorum here would be a new distributed rule
// dressed up as an extraction.
//
// IT IS AUTHORIZED, WHICH THE ORACLE'S WRITE IS NOT. The socket's write is
// reached only after its own handshake, so the oracle never re-asks. A published
// method has no such guarantee: a caller holding an entity id could otherwise
// flip any installation's entity to `disconnected` and take its tools out of
// every model's reach. The grant is tenancy's own, re-verified through
// `requireAuthorization` rather than trusted as a shape — the same protection
// `verifyAuthorization` gives every consumer that took one across a boundary —
// and the entity is then checked against the project the grant re-derived from
// the environment's ancestry, never against a project id the caller supplied.

import { err, ok, runResult, type EntityId, type Result } from "@platos/kernel";

import {
  entityNotInScope,
  invalidConnectionStatus,
  isEntityConnectionStatus,
  markEntityConnected,
  markEntityDisconnected,
  requireAuthorization,
  tenantNotFound,
  type EntityConnectionStatus,
  type EntityRecord,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface RecordEntityConnectionCommand {
  /**
   * An `EnvironmentOperatorAuthorization`, taken as `unknown` for the reason
   * `verifyAuthorization` exists: it reaches this method from a transport, where
   * its type was erased, and the only thing that makes it proof is this
   * context's own mint register.
   */
  readonly authorization: unknown;
  readonly entityId: EntityId;
  /**
   * `"connected"` or `"disconnected"`. Validated rather than narrowed by the
   * type alone, because the value arrives from a wire frame.
   */
  readonly status: EntityConnectionStatus | string;
}

export type RecordEntityConnection = (
  command: RecordEntityConnectionCommand,
) => Promise<Result<EntityRecord>>;

type Dependencies = Pick<TenancyDependencies, "repository" | "clock" | "unitOfWork">;

export function createRecordEntityConnection(
  dependencies: Dependencies,
): RecordEntityConnection {
  const { repository, clock, unitOfWork } = dependencies;
  return async (command) => {
    const granted = requireAuthorization(command.authorization);
    if (!granted.ok) return err(granted.error);
    if (!isEntityConnectionStatus(command.status)) {
      return err(invalidConnectionStatus(String(command.status)));
    }

    const entity = await repository.findEntity(command.entityId);
    if (entity === null) return err(tenantNotFound("entity"));
    // AGAINST THE GRANT'S OWN PROJECT, NOT A CALLER-SUPPLIED ONE. The scope on
    // an authorization was re-derived from the environment's ancestry when it
    // was minted (`domain/authorization.ts`), so this comparison cannot be
    // satisfied by anything the caller wrote down.
    if (entity.projectId !== granted.value.scope.projectId) {
      return err(entityNotInScope(command.entityId, granted.value.scope.projectId));
    }

    const at = clock.now();
    const next =
      command.status === "connected"
        ? markEntityConnected(entity, at)
        : markEntityDisconnected(entity, at);

    return runResult(unitOfWork, async (transaction) => {
      await repository.saveEntity(next, transaction);
      return ok(next);
    });
  };
}
