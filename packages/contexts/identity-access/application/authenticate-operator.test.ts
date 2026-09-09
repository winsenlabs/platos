import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  MINUTE_MS,
  T0,
  anOperatorSession,
  anOperatorUser,
  aTotpCredential,
  at,
  sessionId,
  userId,
} from "../domain/testing.js";
import type { TokenHash } from "../domain/index.js";
import { authenticateOperator, revokeOperatorSession } from "./authenticate-operator.js";
import { testPorts, type TestPorts } from "./testing.js";

const RAW = "plt_os_raw-session-token";

function arrange(overrides: Parameters<typeof anOperatorSession>[0] = {}): TestPorts {
  const ports = testPorts();
  const session = anOperatorSession({ tokenHash: ports.hasher.hash(RAW), ...overrides });
  ports.repository.state.sessions.set(session.sessionId, session);
  ports.repository.state.users.set(userId(), anOperatorUser());
  return ports;
}

async function refusalCode(ports: TestPorts, token: string | null = RAW): Promise<string> {
  const result = await authenticateOperator(ports, { presentedToken: token });
  if (result.ok) throw new Error("expected the request to be refused");
  return result.error.code;
}

describe("authenticating a dashboard session in memory", () => {
  it("authorizes a live session and stamps liveness afterwards", async () => {
    const ports = arrange();
    const result = await authenticateOperator(ports, { presentedToken: RAW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actorUserId).toBe(userId());
    expect(ports.repository.state.sessions.get(sessionId())?.lastSeenAt).toEqual(T0);
  });

  it("never stamps liveness on a refused request", async () => {
    const ports = arrange({ revokedAt: T0 });
    await authenticateOperator(ports, { presentedToken: RAW });
    expect(ports.repository.state.sessions.get(sessionId())?.lastSeenAt).toBeNull();
  });
});

describe("negative controls", () => {
  it("refuses an absent token WITHOUT CONSULTING THE SESSION STORE", async () => {
    // The refusal code alone does not prove the guard: hashing an absent token
    // produces a digest that matches no row, so the fall-through refuses with
    // the SAME `UNAUTHENTICATED` and a suite asserting only the code stays green
    // with the guard deleted. What the guard actually buys is that no lookup is
    // issued at all, so that is what is asserted.
    const ports = arrange();
    let lookups = 0;
    const watched = {
      ...ports,
      repository: {
        ...ports.repository,
        operatorSessions: {
          ...ports.repository.operatorSessions,
          findByTokenHash: async (hash: TokenHash) => {
            lookups += 1;
            return ports.repository.operatorSessions.findByTokenHash(hash);
          },
        },
      },
    };
    const result = await authenticateOperator(watched, { presentedToken: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAUTHENTICATED");
    expect(lookups).toBe(0);
  });

  it("refuses a token that matches no session", async () => {
    expect(await refusalCode(arrange(), "plt_os_not-a-real-token")).toBe("UNAUTHENTICATED");
  });

  it("REFUSES AN EXPIRED SESSION", async () => {
    const ports = arrange();
    ports.clock.set(at(8 * DAY_MS));
    expect(await refusalCode(ports)).toBe("SESSION_EXPIRED");
  });

  it("REFUSES A REVOKED SESSION", async () => {
    expect(await refusalCode(arrange({ revokedAt: at(-MINUTE_MS) }))).toBe("SESSION_REVOKED");
  });

  it("refuses when the actor row has been disabled since the session was minted", async () => {
    const ports = arrange();
    ports.repository.state.users.set(userId(), anOperatorUser({ disabledAt: T0 }));
    expect(await refusalCode(ports)).toBe("UNAUTHENTICATED");
  });

  it("demands the second factor once one is enrolled", async () => {
    const ports = arrange();
    ports.repository.state.totp.set(userId(), aTotpCredential());
    expect(await refusalCode(ports)).toBe("MFA_REQUIRED");
  });

  it("lets a session through once its second factor is verified", async () => {
    const ports = arrange({ mfaVerifiedAt: at(-MINUTE_MS) });
    ports.repository.state.totp.set(userId(), aTotpCredential());
    const result = await authenticateOperator(ports, { presentedToken: RAW });
    expect(result.ok).toBe(true);
  });
});

describe("revoking a session", () => {
  it("ends it and reports that this call was the one that did", async () => {
    const ports = arrange();
    const first = await revokeOperatorSession(ports, { presentedToken: RAW });
    expect(first.ok).toBe(true);
    expect(ports.repository.state.sessions.get(sessionId())?.revokedAt).toEqual(T0);
  });

  it("refuses the second revoke, so a double logout is distinguishable", async () => {
    const ports = arrange();
    await revokeOperatorSession(ports, { presentedToken: RAW });
    const second = await revokeOperatorSession(ports, { presentedToken: RAW });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    // THE CODE, NOT JUST THE FAILURE (WIN-267 W3). `.ok === false` was true both
    // before and after this use case started calling `domain/session.ts::revoked`,
    // which is why it did not notice that the already-ended branch answered
    // `UNAUTHENTICATED` — the SAME code as a token no row matches — while the
    // domain rule it duplicated answered `SESSION_REVOKED`.
    expect(second.error.code).toBe("SESSION_REVOKED");
  });

  it("does not re-stamp a session it did not end", async () => {
    // The revocation instant is evidence: an incident asks WHEN a session was
    // ended, and a second logout that moved `revokedAt` forward would answer with
    // the time of the retry.
    const ports = arrange();
    await revokeOperatorSession(ports, { presentedToken: RAW });
    ports.clock.set(at(MINUTE_MS));
    await revokeOperatorSession(ports, { presentedToken: RAW });
    expect(ports.repository.state.sessions.get(sessionId())?.revokedAt).toEqual(T0);
  });

  it("keeps an unknown token and an absent token under ONE code, on purpose", async () => {
    // The opposite decision from the case above, and it is not an inconsistency:
    // separating these two would let a caller confirm whether a guessed token
    // exists, which `unauthenticated`'s banner refuses. An already-ended session
    // tells the presenter nothing they did not already know.
    const ports = arrange();
    const unknown = await revokeOperatorSession(ports, { presentedToken: "plt_os_nope" });
    const absent = await revokeOperatorSession(ports, { presentedToken: null });
    expect(unknown.ok || absent.ok).toBe(false);
    if (unknown.ok || absent.ok) return;
    expect([unknown.error.code, absent.error.code]).toEqual(["UNAUTHENTICATED", "UNAUTHENTICATED"]);
  });

  it("no longer authenticates once revoked", async () => {
    const ports = arrange();
    await revokeOperatorSession(ports, { presentedToken: RAW });
    expect(await refusalCode(ports)).toBe("SESSION_REVOKED");
  });
});
