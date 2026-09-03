// The two grants this context accepts, and the one resolution both end in.
//
// `memory` sits below two very different callers. An OPERATOR administers a
// subject's memories from a control surface, and `tenancy` mints the RBAC
// decision that says they may. A TURN recalls and extracts, and holds the
// runtime grant this context defines (`domain/authorization.ts`) because tenancy
// publishes none and `secrets` — which does — is not on this context's
// allow-list (ADR M0.3 §1 row 8).
//
// TENANCY'S GRANT IS VERIFIED BY ASKING TENANCY, not by importing its predicate.
// The check goes through `TenancyContract.verifyAuthorization` for the reason
// `providers` gives at the same seam: an authorization is genuine only if
// tenancy's own private mint register holds it, and asking its owner is what
// keeps the decision in the context that owns it. In the composition root the
// two are the same code.
//
// THE TWO GRANTS ARE TRIED IN ONE ORDER AND IT IS THE STRICTER ONE FIRST. A
// runtime grant is recognised by IDENTITY against this context's own mint
// register, which no value that arrived as data can pass, so trying it first
// cannot admit anything. Trying tenancy first would be equally safe and would
// send every turn through a peer contract call it does not need.
//
// THE SUBJECT COMES FROM WHICHEVER GRANT IS HELD, NOT FROM THE COMMAND. A
// runtime grant NAMES its subject, so a command that also names one must name
// the same one — `subjectFor` refuses a mismatch rather than preferring either,
// which is what stops a mis-wired turn from recalling one person's history under
// another person's grant. An operator grant names no subject, so there the
// command supplies it and a blank one is the source's `MemoryEndUserContextError`.
//
// BOTH PATHS END IN THE SAME PLACE: an `EnvironmentScope`, a `MemorySubject`,
// and the set of agents the caller may read (`resolveReadScope`) or the one
// agent it may write as (`resolveWriteScope`). No use case in this package takes
// an environment id from a caller — the scope is derived from the grant, which
// is the shape that cannot mismatch.

import { environmentScope, err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import type { EnvironmentAccess, EnvironmentOperatorAuthorization } from "@platos/context-tenancy";

import {
  endUserContextRequired,
  isMemoryRuntimeAuthorization,
  memorySubject,
  resolveReadBindings,
  resolveWriteBinding,
  scopeMismatch,
  type AgentBinding,
  type AgentId,
  type EndUserId,
  type MemoryRuntimeAuthorization,
  type MemorySubject,
  type ThreadId,
  type WriteBindingRequest,
} from "../domain/index.js";
import type { MemoryDependencies } from "./dependencies.js";

export type TenancyOperatorGrant = EnvironmentOperatorAuthorization;

/** Either grant, already verified, with the environment it resolves to. */
export type MemoryGrant =
  | { readonly kind: "operator"; readonly environment: EnvironmentScope; readonly operator: TenancyOperatorGrant }
  | { readonly kind: "runtime"; readonly environment: EnvironmentScope; readonly runtime: MemoryRuntimeAuthorization };

/**
 * Verify whichever grant a caller holds.
 *
 * The runtime check is an identity test against a module-private `WeakSet`; the
 * operator check is a question put to `tenancy`. Both are all-or-nothing, and a
 * value that passes neither is refused with the same error either way — which
 * grant was missing is not information a caller is entitled to.
 */
export function verifyGrant(
  dependencies: MemoryDependencies,
  authorization: unknown,
): Result<MemoryGrant> {
  if (isMemoryRuntimeAuthorization(authorization)) {
    return ok({ kind: "runtime", environment: runtimeEnvironment(authorization), runtime: authorization });
  }
  const operator = dependencies.tenancy.verifyAuthorization(authorization);
  if (!operator.ok) return err(operator.error);
  return ok({ kind: "operator", environment: operator.value.scope, operator: operator.value });
}

/** Verify, and require the grant to be a runtime one. Recall and extraction do. */
export function verifyRuntime(
  dependencies: MemoryDependencies,
  authorization: unknown,
): Result<MemoryRuntimeAuthorization> {
  if (!isMemoryRuntimeAuthorization(authorization)) {
    return err(scopeMismatch("memory runtime authorization", "a value this context did not mint"));
  }
  return ok(authorization);
}

/** `metadata` cannot mutate. An operator asking for more than it carries fails. */
export function requireAccess(grant: MemoryGrant, access: EnvironmentAccess): Result<MemoryGrant> {
  if (access !== "secret:mutate") return ok(grant);
  if (grant.kind === "runtime") return ok(grant);
  if (grant.operator.access !== "secret:mutate") {
    return err(scopeMismatch("secret:mutate", grant.operator.access));
  }
  return ok(grant);
}

export function runtimeEnvironment(grant: MemoryRuntimeAuthorization): EnvironmentScope {
  return environmentScope(grant.organizationId, grant.projectId, grant.environmentId);
}

/** What a command may state about the subject and the acting agent. */
export interface SubjectRequest {
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
}

/** The subject and acting agent a grant resolves to, with the command checked. */
export interface GrantedSubject {
  readonly environment: EnvironmentScope;
  readonly endUserId: EndUserId;
  readonly actingAgentId: AgentId | null;
}

export function subjectFor(grant: MemoryGrant, request: SubjectRequest): Result<GrantedSubject> {
  if (grant.kind === "runtime") {
    if (request.endUserId !== null && request.endUserId !== grant.runtime.endUserId) {
      return err(scopeMismatch(grant.runtime.endUserId, request.endUserId));
    }
    return ok({
      environment: grant.environment,
      endUserId: grant.runtime.endUserId,
      // The grant NAMES the acting agent. A command's claim is ignored rather
      // than merged: a turn cannot act as an agent its grant was not minted for.
      actingAgentId: grant.runtime.actingAgentId,
    });
  }
  if (request.endUserId === null || request.endUserId.trim().length === 0) {
    return err(endUserContextRequired());
  }
  return ok({
    environment: grant.environment,
    endUserId: request.endUserId,
    actingAgentId: request.actingAgentId,
  });
}

/** A subject, and the agents a caller may see. The input to every read. */
export interface ReadScope {
  readonly environment: EnvironmentScope;
  readonly subject: MemorySubject;
  readonly bindings: readonly AgentBinding[];
  readonly agentIds: readonly AgentId[];
}

/** A subject, and the ONE agent a write is attributed to. */
export interface WriteScope {
  readonly environment: EnvironmentScope;
  readonly subject: MemorySubject;
  readonly binding: AgentBinding;
  /**
   * Every agent bound here, carried so a write that must also READ — an edge
   * checking both its endpoints — can widen to the writing agent's cluster
   * without a second round trip and without re-deriving the peer set.
   */
  readonly bindings: readonly AgentBinding[];
}

/**
 * Resolve which agents a caller may read.
 *
 * The bindings come from the store; the DECISION is `domain/scope.ts`, which is
 * pure. Fetching and deciding are separate so every refusal — an unbound agent,
 * an agent outside the acting cluster, an ambiguous multi-agent environment — is
 * exercisable without a store.
 */
export async function resolveReadScope(
  dependencies: MemoryDependencies,
  granted: GrantedSubject,
  requestedAgentIds: readonly AgentId[],
): Promise<Result<ReadScope>> {
  const bindings = await dependencies.repository.listAgentBindings(granted.environment);
  if (!bindings.ok) return err(bindings.error);
  const resolved = resolveReadBindings(bindings.value, {
    actingAgentId: granted.actingAgentId,
    requestedAgentIds,
  });
  if (!resolved.ok) return err(resolved.error);
  return ok({
    environment: granted.environment,
    subject: memorySubject(granted.environment, granted.endUserId),
    bindings: bindings.value,
    agentIds: resolved.value.map((binding) => binding.agentId),
  });
}

/**
 * Resolve the one agent a write is attributed to.
 *
 * When a source thread is named, its ownership is read and checked TWICE: the
 * thread must belong to this subject, and the writing agent must share scope
 * with the thread's agent. The source does both, and dropping either would let a
 * memory be attributed to a conversation that was somebody else's.
 */
export async function resolveWriteScope(
  dependencies: MemoryDependencies,
  granted: GrantedSubject,
  request: { readonly requestedAgentId: AgentId | null; readonly sourceThreadId: ThreadId | null },
): Promise<Result<WriteScope>> {
  const bindings = await dependencies.repository.listAgentBindings(granted.environment);
  if (!bindings.ok) return err(bindings.error);

  let sourceThreadBinding: AgentBinding | null = null;
  if (request.sourceThreadId !== null) {
    const owned = await dependencies.repository.findSourceThreadOwnership(
      granted.environment,
      request.sourceThreadId,
    );
    if (!owned.ok) return err(owned.error);
    if (owned.value === null || owned.value.endUserId !== granted.endUserId) {
      return err(scopeMismatch(`thread/${request.sourceThreadId}`, "a thread outside this subject's scope"));
    }
    sourceThreadBinding = owned.value.ownership;
  }

  const write: WriteBindingRequest = {
    actingAgentId: granted.actingAgentId,
    requestedAgentId: request.requestedAgentId,
    sourceThreadBinding,
  };
  const binding = resolveWriteBinding(bindings.value, write);
  if (!binding.ok) return err(binding.error);
  if (sourceThreadBinding !== null && !sharesScope(binding.value, sourceThreadBinding)) {
    return err(scopeMismatch("the source thread's agent scope", binding.value.agentId));
  }
  return ok({
    environment: granted.environment,
    subject: memorySubject(granted.environment, granted.endUserId),
    binding: binding.value,
    bindings: bindings.value,
  });
}

/** Verify, resolve the subject, and resolve the readable agents. One step. */
export async function authorizeRead(
  dependencies: MemoryDependencies,
  request: SubjectRequest & {
    readonly authorization: unknown;
    readonly requestedAgentIds: readonly AgentId[];
  },
): Promise<Result<ReadScope>> {
  const granted = verifyGrant(dependencies, request.authorization);
  if (!granted.ok) return err(granted.error);
  const subject = subjectFor(granted.value, request);
  if (!subject.ok) return err(subject.error);
  return resolveReadScope(dependencies, subject.value, request.requestedAgentIds);
}

/**
 * Verify, REQUIRE the mutating grant, and resolve the readable agents.
 *
 * The gate for an operation that CHANGES an existing row rather than creating
 * one: archive, restore, revise, forget, forget-many, forget-entity. All six
 * find their subject by id inside the caller's agent scope — which is a read —
 * and then mutate it, so they need the read scope AND the `secret:mutate`
 * access an operator's `metadata` grant does not carry.
 *
 * It exists as a third entry point rather than a flag on `authorizeRead`
 * because the distinction is the one that matters most here: `authorizeRead`
 * must stay reachable under `metadata`, and a boolean parameter is how it would
 * eventually be called with the wrong value at one of six call sites.
 */
export async function authorizeMutation(
  dependencies: MemoryDependencies,
  request: SubjectRequest & {
    readonly authorization: unknown;
    readonly requestedAgentIds: readonly AgentId[];
  },
): Promise<Result<ReadScope>> {
  const granted = verifyGrant(dependencies, request.authorization);
  if (!granted.ok) return err(granted.error);
  const mutable = requireAccess(granted.value, "secret:mutate");
  if (!mutable.ok) return err(mutable.error);
  const subject = subjectFor(mutable.value, request);
  if (!subject.ok) return err(subject.error);
  return resolveReadScope(dependencies, subject.value, request.requestedAgentIds);
}

/** Verify, resolve the subject, and resolve the writing agent. One step. */
export async function authorizeWrite(
  dependencies: MemoryDependencies,
  request: SubjectRequest & {
    readonly authorization: unknown;
    readonly requestedAgentId: AgentId | null;
    readonly sourceThreadId: ThreadId | null;
  },
): Promise<Result<WriteScope>> {
  const granted = verifyGrant(dependencies, request.authorization);
  if (!granted.ok) return err(granted.error);
  const mutable = requireAccess(granted.value, "secret:mutate");
  if (!mutable.ok) return err(mutable.error);
  const subject = subjectFor(mutable.value, request);
  if (!subject.ok) return err(subject.error);
  return resolveWriteScope(dependencies, subject.value, {
    requestedAgentId: request.requestedAgentId,
    sourceThreadId: request.sourceThreadId,
  });
}

function sharesScope(left: AgentBinding, right: AgentBinding): boolean {
  return left.agentId === right.agentId || (left.clusterId !== null && left.clusterId === right.clusterId);
}
