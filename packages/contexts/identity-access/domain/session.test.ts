import { describe, expect, it } from "vitest";

import {
  evaluateOperatorSession,
  parentSessionIsIntact,
  revoked,
  touched,
  type OperatorSessionEvaluation,
} from "./session.js";
import {
  DAY_MS,
  MINUTE_MS,
  T0,
  anOperatorSession,
  anOperatorUser,
  at,
  sessionId,
  userId,
} from "./testing.js";

function evaluation(overrides: Partial<OperatorSessionEvaluation> = {}): OperatorSessionEvaluation {
  return {
    session: anOperatorSession(),
    actor: anOperatorUser(),
    impersonatedUser: null,
    parentSession: null,
    mfaEnabled: false,
    now: T0,
    ...overrides,
  };
}

function refusalCode(input: OperatorSessionEvaluation): string {
  const result = evaluateOperatorSession(input);
  if (result.ok) throw new Error("expected the session to be refused");
  return result.error.code;
}

describe("an operator session is accepted only when every check passes", () => {
  it("authorizes a live session and separates the actor from the effective user", () => {
    const result = evaluateOperatorSession(evaluation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actorUserId).toBe(userId());
    expect(result.value.effectiveUserId).toBe(userId());
    expect(result.value.impersonation).toBeNull();
  });
});

describe("negative controls", () => {
  it("rejects an EXPIRED session", () => {
    expect(refusalCode(evaluation({ now: at(8 * DAY_MS) }))).toBe("SESSION_EXPIRED");
  });

  it("rejects a session expiring exactly now — the boundary belongs to the past", () => {
    const session = anOperatorSession({ expiresAt: T0 });
    expect(refusalCode(evaluation({ session }))).toBe("SESSION_EXPIRED");
  });

  it("rejects a REVOKED session", () => {
    const session = anOperatorSession({ revokedAt: at(-MINUTE_MS) });
    expect(refusalCode(evaluation({ session }))).toBe("SESSION_REVOKED");
  });

  it("reports REVOKED, not EXPIRED, when a session is both", () => {
    const session = anOperatorSession({ revokedAt: T0, expiresAt: T0 });
    expect(refusalCode(evaluation({ session, now: at(9 * DAY_MS) }))).toBe("SESSION_REVOKED");
  });

  it("rejects a disabled actor opaquely, ahead of every other check", () => {
    const actor = anOperatorUser({ disabledAt: T0 });
    const session = anOperatorSession({ revokedAt: T0 });
    expect(refusalCode(evaluation({ actor, session }))).toBe("UNAUTHENTICATED");
  });

  it("demands the second factor when one is enrolled and unverified", () => {
    expect(refusalCode(evaluation({ mfaEnabled: true }))).toBe("MFA_REQUIRED");
  });

  it("accepts a session whose second factor was already verified", () => {
    const session = anOperatorSession({ mfaVerifiedAt: at(-MINUTE_MS) });
    expect(evaluateOperatorSession(evaluation({ session, mfaEnabled: true })).ok).toBe(true);
  });
});

describe("the impersonation chain", () => {
  const impersonating = anOperatorSession({
    impersonatedUserId: userId("target"),
    parentSessionId: sessionId("origin"),
  });
  const origin = anOperatorSession({ sessionId: sessionId("origin") });
  const platformOperator = anOperatorUser({ platformOperator: true });
  const target = anOperatorUser({ userId: userId("target") });

  it("authorizes impersonation for a platform operator with a live origin session", () => {
    const result = evaluateOperatorSession(
      evaluation({
        session: impersonating,
        actor: platformOperator,
        impersonatedUser: anOperatorUser({ userId: userId("target") }),
        parentSession: origin,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actorUserId).toBe(userId());
    expect(result.value.effectiveUserId).toBe(userId("target"));
    expect(result.value.impersonation).toEqual({
      active: true,
      actorUserId: userId(),
      targetUserId: userId("target"),
    });
  });

  it("refuses impersonation by a user who is not a platform operator", () => {
    expect(
      refusalCode(
        evaluation({
          session: impersonating,
          actor: anOperatorUser({ platformOperator: false }),
          impersonatedUser: anOperatorUser({ userId: userId("target") }),
          parentSession: origin,
        }),
      ),
    ).toBe("UNAUTHENTICATED");
  });

  it("refuses impersonation of a disabled target", () => {
    expect(
      refusalCode(
        evaluation({
          session: impersonating,
          actor: platformOperator,
          impersonatedUser: anOperatorUser({ userId: userId("target"), disabledAt: T0 }),
          parentSession: origin,
        }),
      ),
    ).toBe("UNAUTHENTICATED");
  });

  it("refuses when the origin session was revoked underneath it", () => {
    expect(
      refusalCode(
        evaluation({
          session: impersonating,
          actor: platformOperator,
          impersonatedUser: anOperatorUser({ userId: userId("target") }),
          parentSession: anOperatorSession({ sessionId: sessionId("origin"), revokedAt: T0 }),
        }),
      ),
    ).toBe("SESSION_REVOKED");
  });

  it("refuses when the origin session is missing entirely", () => {
    expect(
      refusalCode(
        evaluation({
          session: impersonating,
          actor: platformOperator,
          impersonatedUser: anOperatorUser({ userId: userId("target") }),
          parentSession: null,
        }),
      ),
    ).toBe("SESSION_REVOKED");
  });

  it("refuses to chain: an origin that is itself impersonating is not intact", () => {
    const chained = anOperatorSession({
      sessionId: sessionId("origin"),
      impersonatedUserId: userId("someone-else"),
    });
    expect(parentSessionIsIntact(impersonating, chained, T0)).toBe(false);
  });

  it("refuses an origin belonging to a different user", () => {
    const foreign = anOperatorSession({ sessionId: sessionId("origin"), userId: userId("other") });
    expect(parentSessionIsIntact(impersonating, foreign, T0)).toBe(false);
  });

  it("refuses an expired origin", () => {
    expect(parentSessionIsIntact(impersonating, origin, at(8 * DAY_MS))).toBe(false);
  });

  it("accepts an origin that is live, unrevoked and not itself impersonating", () => {
    expect(parentSessionIsIntact(impersonating, origin, T0)).toBe(true);
    expect(target.userId).toBe(userId("target"));
  });
});

describe("session mutation is explicit and returns new values", () => {
  it("stamps liveness without mutating the original", () => {
    const session = anOperatorSession();
    const seen = touched(session, at(MINUTE_MS));
    expect(session.lastSeenAt).toBeNull();
    expect(seen.lastSeenAt).toEqual(at(MINUTE_MS));
  });

  it("reports who won: revoking twice refuses the second caller", () => {
    const first = revoked(anOperatorSession(), T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = revoked(first.value, at(MINUTE_MS));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("SESSION_REVOKED");
  });
});
