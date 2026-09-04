// The three ways into this context, and what each one proves.
//
// THIS CONTEXT MINTS NOTHING. Both grants below are unforgeable values minted
// elsewhere — `tenancy` mints the operator one, `secrets` mints the runtime one
// — and this file only ever verifies. That is the property that makes an
// authorization here impossible to fake from data: a value that arrived over
// the wire was not minted, and both checks are identity checks against a mint
// register rather than shape checks.
//
// ---------------------------------------------------------------------------
// 1. THE OPERATOR GRANT — `tenancy`'s, for the control surfaces.
// ---------------------------------------------------------------------------
// Reading another end user's threads, launching a postman execution, forcing a
// compaction. `verifyAuthorization` is `tenancy`'s identity check; `authorizes`
// then compares the WHOLE ancestry rather than the environment id alone,
// because a grant minted for an environment that has since been re-parented
// still names that environment.
//
// ---------------------------------------------------------------------------
// 2. THE RUNTIME GRANT — `secrets`', for running a turn.
// ---------------------------------------------------------------------------
// A turn is not an operator action and there is no operator to grant it.
// `tenancy` publishes no runtime authorization — its own note records that the
// runtime principal lands there once identity-access's contract is settled — so
// the runtime path takes `secrets`' grant, exactly as `providers` does, and
// re-checks its ancestry against the scope it was called with. It is also the
// grant this context HANDS ON: `providers.runModelGeneration` demands one, and
// passing through the value a caller supplied is what keeps the credential
// decision at the composition root instead of in the turn engine.
//
// ---------------------------------------------------------------------------
// 3. THE END USER — an ASSERTION, and it is recorded as one.
// ---------------------------------------------------------------------------
// `identity-access` is not on this context's ADR M0.3 §1 row 16 allow-list, so
// this context CANNOT authenticate an end user and does not pretend to. The end
// user on a runtime command is an assertion made by the transport that
// authenticated the session. What this context checks is OWNERSHIP: that the
// asserted end user is the one the thread belongs to. `governance` states the
// same limit for the same reason and it is stated here rather than hidden.
//
// THE TWO REFUSALS ARE DELIBERATELY DIFFERENT, AND THE DIFFERENCE IS THE POINT.
// An END USER who names somebody else's thread gets `not_found`, because one who
// can tell "no such thread" from "not yours" can enumerate a tenant's threads by
// id. An OPERATOR gets `forbidden`, because a grant over the environment already
// entitles them to know the row exists. Two codes, and `authorization.test.ts`
// asserts that the same thread answers differently to the two callers.

import { environmentScope, err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";
import type { EnvironmentRuntimeAuthorization as SecretsRuntimeGrant } from "@platos/context-secrets";
import {
  authorizes,
  type EnvironmentOperatorAuthorization as TenancyOperatorGrant,
} from "@platos/context-tenancy";

import {
  scopeMismatch,
  threadForbidden,
  threadNotFound,
  type EndUserId,
  type Thread,
} from "../domain/index.js";
import type { ConversationsDependencies } from "./dependencies.js";

export type { SecretsRuntimeGrant, TenancyOperatorGrant };

function pathOf(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.environmentId}`;
}

/**
 * Verify an operator grant and confirm it reaches this scope.
 *
 * Two failures, ONE code, and it is a shared shape rather than a collapse: a
 * value that was never minted and a grant for another environment are both "this
 * grant does not authorize that", and neither may be reported as `not_found`
 * lest a probe learn whether an environment exists.
 */
export function verifyOperator(
  dependencies: ConversationsDependencies,
  authorization: unknown,
  scope: EnvironmentScope,
): Result<TenancyOperatorGrant> {
  const verified = dependencies.tenancy.verifyAuthorization(authorization);
  if (!verified.ok) return err(verified.error);
  if (!authorizes(verified.value, scope)) {
    return err(scopeMismatch(pathOf(scope), pathOf(verified.value.scope)));
  }
  return ok(verified.value);
}

/** The environment a runtime grant covers, as a kernel scope. */
export function runtimeScope(grant: SecretsRuntimeGrant): EnvironmentScope {
  return environmentScope(
    asIdentifier(grant.organizationId),
    asIdentifier(grant.projectId),
    asIdentifier(grant.environmentId),
  );
}

/**
 * Confirm a runtime grant covers the scope it is being used for.
 *
 * Compares the WHOLE chain, not the leaf. Matching on `environmentId` alone
 * accepts a grant minted for an environment that has since been re-parented,
 * which is exactly the cross-tenant read this check exists to refuse.
 */
export function verifyRuntime(
  grant: SecretsRuntimeGrant,
  scope: EnvironmentScope,
): Result<SecretsRuntimeGrant> {
  const granted = runtimeScope(grant);
  if (
    granted.organizationId !== scope.organizationId ||
    granted.projectId !== scope.projectId ||
    granted.environmentId !== scope.environmentId
  ) {
    return err(scopeMismatch(pathOf(scope), pathOf(granted)));
  }
  return ok(grant);
}

/**
 * The end user's view of a thread: theirs, or nothing.
 *
 * `null` and "somebody else's" answer identically, and the code says `not_found`
 * for both. That is concealment on purpose and it is the reason this function
 * exists rather than a bare ownership predicate at every call site.
 */
export function requireOwnedThread(
  thread: Thread | null,
  threadId: string,
  endUserId: EndUserId,
): Result<Thread> {
  if (thread === null || thread.endUserId !== endUserId) return err(threadNotFound(threadId));
  return ok(thread);
}

/**
 * The operator's view of the same thread: present, or a refusal that says which.
 *
 * A thread that is absent is still `not_found` — there is nothing to forbid — but
 * one that belongs to another end user is `forbidden`, because an operator
 * holding this environment already knows the row is there.
 */
export function requireVisibleThread(
  thread: Thread | null,
  threadId: string,
  endUserId: EndUserId | null,
): Result<Thread> {
  if (thread === null) return err(threadNotFound(threadId));
  if (endUserId !== null && thread.endUserId !== endUserId) {
    return err(threadForbidden(threadId, endUserId));
  }
  return ok(thread);
}
