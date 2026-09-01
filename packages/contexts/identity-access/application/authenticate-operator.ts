// Authenticate a dashboard session token.
//
// The read plan is fixed and shallow: at most five point lookups, no scans, and
// every one of them keyed by a unique index. The extraction source does the same
// work as one Prisma `include` tree; splitting it into named store calls makes
// the plan visible and makes the whole decision testable against an in-memory
// map.
//
// NOTHING HERE DECIDES ANYTHING. Every rule lives in
// `domain/session.ts::evaluateOperatorSession`, including the order the failures
// are reported in. This function's job is to fetch what that rule needs and to
// persist the one side effect a successful authentication has.
//
// THE SIDE EFFECT IS BEST-EFFORT LIVENESS. A successful authentication stamps
// `lastSeenAt`. It is written after the decision, never before, so a failed
// authentication leaves no trace that would let an attacker confirm a token
// exists by watching a timestamp move.

import {
  evaluateOperatorSession,
  isTotpEnabled,
  touched,
  unauthenticated,
  type OperatorAuthorization,
  type OperatorSessionRecord,
  type OperatorUserRecord,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { err, ok, type Result } from "@platos/kernel";

export type AuthenticateOperatorPorts = PortsOf<"repository" | "hasher" | "clock">;

export interface AuthenticateOperatorInput {
  /** The raw cookie or header value. May be absent; that is not an error case. */
  readonly presentedToken: string | null | undefined;
}

export async function authenticateOperator(
  ports: AuthenticateOperatorPorts,
  input: AuthenticateOperatorInput,
): Promise<Result<OperatorAuthorization>> {
  if (!input.presentedToken) return err(unauthenticated({ reason: "no-token" }));

  const sessions = ports.repository.operatorSessions;
  const now = ports.clock.now();
  const session = await sessions.findByTokenHash(ports.hasher.hash(input.presentedToken));
  if (session === null) return err(unauthenticated({ reason: "no-session" }));

  const actor = await ports.repository.users.findById(session.userId);
  if (actor === null) return err(unauthenticated({ reason: "no-actor" }));

  const authorization = evaluateOperatorSession({
    session,
    actor,
    impersonatedUser: await loadImpersonatedUser(ports, session),
    parentSession: await loadParentSession(ports, session),
    mfaEnabled: isTotpEnabled(await ports.repository.mfa.findTotp(session.userId)),
    now,
  });
  if (!authorization.ok) return authorization;

  await sessions.save(touched(session, now));
  return ok(authorization.value);
}

async function loadImpersonatedUser(
  ports: AuthenticateOperatorPorts,
  session: OperatorSessionRecord,
): Promise<OperatorUserRecord | null> {
  if (session.impersonatedUserId === null) return null;
  return ports.repository.users.findById(session.impersonatedUserId);
}

async function loadParentSession(
  ports: AuthenticateOperatorPorts,
  session: OperatorSessionRecord,
): Promise<OperatorSessionRecord | null> {
  if (session.parentSessionId === null) return null;
  return ports.repository.operatorSessions.findById(session.parentSessionId);
}

/**
 * End a session.
 *
 * Reports whether THIS call ended it, because a logout that silently succeeds on
 * an already-revoked session cannot be distinguished from one that worked, and
 * the impersonation-stop path depends on that distinction.
 */
export async function revokeOperatorSession(
  ports: AuthenticateOperatorPorts,
  input: AuthenticateOperatorInput,
): Promise<Result<OperatorSessionRecord>> {
  if (!input.presentedToken) return err(unauthenticated({ reason: "no-token" }));
  const now = ports.clock.now();
  const sessions = ports.repository.operatorSessions;
  const session = await sessions.findByTokenHash(ports.hasher.hash(input.presentedToken));
  if (session === null) return err(unauthenticated({ reason: "no-session" }));
  if (session.revokedAt !== null) return err(unauthenticated({ reason: "already-revoked" }));

  const ended: OperatorSessionRecord = { ...session, revokedAt: now };
  await sessions.save(ended);
  return ok(ended);
}
