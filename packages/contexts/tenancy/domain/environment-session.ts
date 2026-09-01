// `EnvironmentSession` — modelled minimally, and stated plainly why.
//
// NO BEHAVIOURAL ORACLE EXISTS FOR THIS ROW. Across the whole repository there
// is exactly one reference to it outside the generated client and the schema
// conformance test: a single `control.environmentSession.create(...)` inside
// `internal-packages/tenancy-database/src/integration.test.ts`, which exists to
// prove the table accepts a row. There is no service, no controller, no reader,
// no revocation path and no lifecycle anywhere in production code.
//
// So this file models the SCHEMA and nothing else. Every field below is a
// column; every function below is derivable from the columns alone. Inventing a
// lifecycle here — expiry policy, heartbeat cadence, a revocation cascade —
// would be inventing product behaviour and calling it a migration, and the next
// reader would have no way to tell the invented part from the extracted part.
// When the first real caller appears it brings the rules with it.
//
// One thing IS known from the schema and worth keeping: the row points at an
// `OperatorSession` owned by identity-access, `onDelete: Cascade`. So an
// environment session can never outlive the operator session it hangs off, and
// the session-revocation rules in `session-revocation.ts` reach it transitively
// without tenancy writing anything.

import type { EnvironmentId } from "@platos/kernel";

import type { EnvironmentSessionId, OperatorSessionId } from "./identifiers.js";
import type { PrincipalTier } from "./roles.js";

export interface EnvironmentSessionRecord {
  readonly id: EnvironmentSessionId;
  readonly environmentId: EnvironmentId;
  /** identity-access's row. `onDelete: Cascade` from the parent. */
  readonly operatorSessionId: OperatorSessionId;
  readonly tier: PrincipalTier;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly lastSeenAt: Date | null;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
}

export function isEnvironmentSessionOpen(session: EnvironmentSessionRecord): boolean {
  return session.endedAt === null;
}

export function endEnvironmentSession(
  session: EnvironmentSessionRecord,
  at: Date,
): EnvironmentSessionRecord {
  if (session.endedAt !== null) return session;
  return { ...session, endedAt: at };
}

export function touchEnvironmentSession(
  session: EnvironmentSessionRecord,
  at: Date,
): EnvironmentSessionRecord {
  if (session.endedAt !== null) return session;
  return { ...session, lastSeenAt: at };
}
