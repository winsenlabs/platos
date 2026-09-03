// Start and stop operator impersonation.
//
// Impersonation is the most dangerous capability this context has, so it is the
// most constrained:
//
//   ONLY A PLATFORM OPERATOR. `User.platformOperator` is the sole gate, checked
//   against the ACTOR's row and never against the impersonation session's
//   effective user — otherwise an impersonation of a platform operator would
//   grant the right to impersonate again.
//
//   NO CHAINING. Starting from a session that is already impersonating is
//   refused. `parentSessionIsIntact` additionally requires the parent to have
//   `impersonatedUserId === null`, so a chain cannot be assembled by any route.
//
//   THE ORIGIN SESSION MUST STILL BE ALIVE TO COME BACK. Stopping revalidates
//   the parent before minting the return session. If the origin was revoked
//   while impersonation was in progress — which is exactly what happens when
//   somebody terminates the operator's access — there is nothing to return to
//   and the operator is logged out instead.
//
//   BOTH ENDS ARE AUDITED. START and STOP each append an ImpersonationAudit row
//   naming the real human. A ledger with only starts cannot answer "who was
//   impersonating at 14:05?", which is the question an incident actually asks.

import {
  impersonationForbidden,
  revoked,
  unauthenticated,
  type ImpersonationAuditEntry,
  type UserId,
} from "../domain/index.js";
import { authenticateOperator } from "./authenticate-operator.js";
import type { PortsOf } from "./dependencies.js";
import {
  issueOperatorSession,
  type IssuedOperatorSession,
  type IssueOperatorSessionPorts,
} from "./issue-operator-session.js";
import { err, ok, type Result } from "@platos/kernel";

export type ImpersonationPorts = IssueOperatorSessionPorts & PortsOf<"repository">;

export interface StartImpersonationInput {
  readonly sessionToken: string;
  readonly targetUserId: UserId;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export async function startImpersonation(
  ports: ImpersonationPorts,
  input: StartImpersonationInput,
): Promise<Result<IssuedOperatorSession>> {
  const authorization = await authenticateOperator(ports, { presentedToken: input.sessionToken });
  if (!authorization.ok) return err(authorization.error);
  if (authorization.value.impersonation !== null) return err(impersonationForbidden());

  const actor = await ports.repository.users.findById(authorization.value.actorUserId);
  const target = await ports.repository.users.findById(input.targetUserId);
  if (actor === null || !actor.platformOperator) return err(impersonationForbidden());
  if (target === null || target.disabledAt !== null) return err(impersonationForbidden());

  // The impersonation session inherits the origin's expiry and MFA state rather
  // than getting its own. Impersonating must not extend an operator's day, and
  // must not re-prove a second factor that was already proved.
  const issued = await issueOperatorSession(ports, {
    userId: actor.userId,
    impersonatedUserId: target.userId,
    parentSessionId: authorization.value.sessionId,
    mfaVerifiedAt: authorization.value.mfaVerifiedAt,
    expiresAt: authorization.value.expiresAt,
  });
  if (!issued.ok) return err(issued.error);

  await appendAudit(ports, {
    action: "START",
    actorUserId: actor.userId,
    targetUserId: target.userId,
    impersonationSessionId: issued.value.sessionId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    recordedAt: ports.clock.now(),
  });
  return ok(issued.value);
}

export interface StopImpersonationInput {
  readonly sessionToken: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export async function stopImpersonation(
  ports: ImpersonationPorts,
  input: StopImpersonationInput,
): Promise<Result<IssuedOperatorSession>> {
  const authorization = await authenticateOperator(ports, { presentedToken: input.sessionToken });
  if (!authorization.ok) return err(authorization.error);
  if (authorization.value.impersonation === null) return err(impersonationForbidden());

  const sessions = ports.repository.operatorSessions;
  const current = await sessions.findById(authorization.value.sessionId);
  if (current === null || current.parentSessionId === null) return err(impersonationForbidden());

  const now = ports.clock.now();
  const parent = await sessions.findById(current.parentSessionId);
  // Revalidated here and not trusted from the START: the origin may have been
  // revoked in the interval, and that is precisely the case where returning to
  // it would resurrect access somebody deliberately ended.
  if (parent === null || parent.revokedAt !== null || parent.expiresAt.getTime() <= now.getTime()) {
    return err(unauthenticated({ reason: "parent-session-gone" }));
  }

  const ended = revoked(current, now);
  if (!ended.ok) return err(ended.error);
  await sessions.save(ended.value);

  await appendAudit(ports, {
    action: "STOP",
    actorUserId: authorization.value.actorUserId,
    targetUserId: authorization.value.effectiveUserId,
    impersonationSessionId: authorization.value.sessionId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    recordedAt: now,
  });

  return issueOperatorSession(ports, {
    userId: authorization.value.actorUserId,
    parentSessionId: parent.sessionId,
    mfaVerifiedAt: authorization.value.mfaVerifiedAt,
    expiresAt: authorization.value.expiresAt,
  });
}

async function appendAudit(
  ports: ImpersonationPorts,
  entry: ImpersonationAuditEntry,
): Promise<void> {
  await ports.repository.impersonationAudit.append(entry);
}
