// The RUNTIME authorization this context requires, and why it cannot be forged.
//
// There are two ways into this context and they need different grants.
//
//   THE CONTROL SURFACE — an operator listing, editing, archiving or erasing a
//   subject's memories — is authorized by `tenancy`, which mints the RBAC
//   decision. `application/authorization.ts` verifies one by asking tenancy, the
//   same way `providers` does. Nothing about that grant is defined here.
//
//   THE RUNTIME SURFACE — a turn recalling memories, and a sweep extracting
//   them — has no such mint available. ADR M0.3 §1 row 8 gives this context
//   `tenancy`, `providers` and the kernel, and tenancy "publishes no runtime
//   authorization": its own note records that runtime and service principals
//   land there only once identity-access's contract is settled. `secrets`, which
//   does publish one, is not on this context's allow-list.
//
// So this context states the shape of the runtime grant it will accept and
// refuses everything else, exactly as `secrets` does for the same reason. The
// composition root, which holds identity-access, authenticates first and then
// mints one.
//
// UNFORGEABILITY IS A REAL CONTROL, NOT CEREMONY, AND IT IS THE SAME TWO-LAYER
// CONTROL `secrets` uses:
//
//   * COMPILE TIME — a phantom brand, so a structurally identical literal is a
//     type error at every call site without a cast.
//   * RUN TIME — a module-private `WeakSet` of the exact objects this module
//     minted and froze. Identity, not shape. A JSON body parsed off the wire is
//     not in the set, and neither is `{ ...realGrant }`.
//
// THE SUBJECT IS PART OF THE GRANT, NOT A PARAMETER BESIDE IT. A runtime grant
// authorizes recall for ONE end user, and reading another subject's memories
// needs another grant. Carrying the subject separately is precisely the shape
// that lets a mis-wired turn recall the wrong person's history while every
// individual check passes, so the subject is inside the value that is checked.

import { environmentScope, type EnvironmentScope } from "@platos/kernel";
import type { EnvironmentId, OrganizationId, ProjectId } from "@platos/kernel";

import type { ActorId, AgentId, EndUserId } from "./identifiers.js";

declare const memoryAuthorization: unique symbol;

type Unforgeable<Shape> = Shape & { readonly [memoryAuthorization]: "memory.authorization" };

/** Every grant is pinned to one environment in the tenancy tree. */
export interface EnvironmentAncestry {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
}

/**
 * What a turn holds while it recalls and extracts.
 *
 * `actingAgentId` may be null for a sweep that runs on the environment's behalf
 * rather than as one agent — the agent resolution rules in `domain/scope.ts`
 * then require the environment to be unambiguous, which is the same refusal an
 * operator with no acting agent meets.
 */
export type MemoryRuntimeAuthorization = Unforgeable<
  EnvironmentAncestry & {
    readonly principalType: "runtime";
    readonly endUserId: EndUserId;
    readonly actingAgentId: AgentId | null;
    readonly actorId: ActorId;
  }
>;

const minted = new WeakSet<object>();

/** Identity check against the mint register. Shape is irrelevant here. */
export function isMintedMemoryAuthorization(value: unknown): boolean {
  return typeof value === "object" && value !== null && minted.has(value);
}

export function authorizeMemoryRuntime(grant: {
  readonly ancestry: EnvironmentAncestry;
  readonly endUserId: EndUserId;
  readonly actingAgentId: AgentId | null;
  readonly actorId: ActorId;
}): MemoryRuntimeAuthorization {
  const value = Object.freeze({
    ...grant.ancestry,
    principalType: "runtime" as const,
    endUserId: grant.endUserId,
    actingAgentId: grant.actingAgentId,
    actorId: grant.actorId,
  });
  minted.add(value);
  return value as MemoryRuntimeAuthorization;
}

/** Both layers, as a predicate. Shape alone is never enough. */
export function isMemoryRuntimeAuthorization(value: unknown): value is MemoryRuntimeAuthorization {
  if (!isMintedMemoryAuthorization(value)) return false;
  return (value as { principalType?: unknown }).principalType === "runtime";
}

/** The environment a runtime grant covers, as a kernel scope. */
export function runtimeScope(grant: MemoryRuntimeAuthorization): EnvironmentScope {
  return environmentScope(grant.organizationId, grant.projectId, grant.environmentId);
}
