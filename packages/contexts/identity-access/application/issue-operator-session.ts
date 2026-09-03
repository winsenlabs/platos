// Mint an OperatorSession.
//
// Four use cases end here — magic-link login, federated login, impersonation
// start and impersonation stop — so the token format, the TTL default and the
// hash-only storage rule are decided in one place. When they were decided in
// four, three of them agreed.
//
// THE RAW TOKEN IS RETURNED AND NEVER STORED. It exists in this function, in the
// response, and nowhere else: the row holds only `tokenHash`. That is what makes
// a canonical-store compromise an inconvenience rather than a fleet-wide session
// takeover, and it is why `IssuedOperatorSession` carries the secret while
// `OperatorSessionRecord` does not.

import {
  DEFAULT_SESSION_TTL_MS,
  instantAfter,
  issuedSession,
  type OperatorSessionId,
  type OperatorSessionRecord,
  type RawToken,
  type UserId,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { asIdentifier, ok, type Result } from "@platos/kernel";

export type IssueOperatorSessionPorts = PortsOf<
  "repository" | "hasher" | "minter" | "clock" | "ids"
>;

export interface IssueOperatorSessionInput {
  readonly userId: UserId;
  /** Defaults to now + 7 days. An impersonation inherits its parent's instant. */
  readonly expiresAt?: Date;
  /** Carried forward from an already-verified session, never invented. */
  readonly mfaVerifiedAt?: Date | null;
  readonly impersonatedUserId?: UserId | null;
  readonly parentSessionId?: OperatorSessionId | null;
}

export interface IssuedOperatorSession {
  /** The only moment this value exists. */
  readonly token: RawToken;
  readonly sessionId: OperatorSessionId;
  readonly expiresAt: Date;
  readonly record: OperatorSessionRecord;
}

export async function issueOperatorSession(
  ports: IssueOperatorSessionPorts,
  input: IssueOperatorSessionInput,
): Promise<Result<IssuedOperatorSession>> {
  const now = ports.clock.now();
  const token = ports.minter.mint("operatorSession");
  const record = issuedSession({
    sessionId: asIdentifier<OperatorSessionId>(ports.ids.uuid()),
    tokenHash: ports.hasher.hash(token),
    userId: input.userId,
    now,
    expiresAt: input.expiresAt ?? instantAfter(now, DEFAULT_SESSION_TTL_MS),
    mfaVerifiedAt: input.mfaVerifiedAt ?? null,
    impersonatedUserId: input.impersonatedUserId ?? null,
    parentSessionId: input.parentSessionId ?? null,
  });

  await ports.repository.operatorSessions.save(record);
  return ok({ token, sessionId: record.sessionId, expiresAt: record.expiresAt, record });
}
