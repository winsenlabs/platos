import { describe, expect, it } from "vitest";

import {
  MINUTE_MS,
  T0,
  anOperatorSession,
  anOperatorUser,
  at,
  sessionId,
  userId,
} from "../domain/testing.js";
import { authenticateOperator } from "./authenticate-operator.js";
import { startImpersonation, stopImpersonation } from "./impersonation.js";
import { testPorts, type TestPorts } from "./testing.js";

const ORIGIN_RAW = "plt_os_origin-token";
const OPERATOR = userId("platform-operator");
const TARGET = userId("target");

function arrange(options: { readonly platformOperator?: boolean } = {}): TestPorts {
  const ports = testPorts();
  ports.repository.state.users.set(
    OPERATOR,
    anOperatorUser({ userId: OPERATOR, platformOperator: options.platformOperator ?? true }),
  );
  ports.repository.state.users.set(TARGET, anOperatorUser({ userId: TARGET }));
  const origin = anOperatorSession({
    sessionId: sessionId("origin"),
    userId: OPERATOR,
    tokenHash: ports.hasher.hash(ORIGIN_RAW),
  });
  ports.repository.state.sessions.set(origin.sessionId, origin);
  return ports;
}

describe("starting impersonation", () => {
  it("mints a session naming both the actor and the target", async () => {
    const ports = arrange();
    const started = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const authorized = await authenticateOperator(ports, {
      presentedToken: started.value.token,
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.value.actorUserId).toBe(OPERATOR);
    expect(authorized.value.effectiveUserId).toBe(TARGET);
  });

  it("inherits the origin's expiry rather than extending the operator's day", async () => {
    const ports = arrange();
    const started = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    const origin = ports.repository.state.sessions.get(sessionId("origin"));
    expect(started.ok && started.value.expiresAt).toEqual(origin?.expiresAt);
  });

  it("AUDITS THE START, naming the real human", async () => {
    const ports = arrange();
    await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
      ipAddress: "198.51.100.7",
    });
    const entry = ports.repository.state.impersonationAudit.at(-1);
    expect(entry?.action).toBe("START");
    expect(entry?.actorUserId).toBe(OPERATOR);
    expect(entry?.targetUserId).toBe(TARGET);
    expect(entry?.ipAddress).toBe("198.51.100.7");
  });
});

describe("negative controls", () => {
  it("REFUSES A USER WHO IS NOT A PLATFORM OPERATOR", async () => {
    const ports = arrange({ platformOperator: false });
    const refused = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("IMPERSONATION_FORBIDDEN");
    expect(ports.repository.state.impersonationAudit).toHaveLength(0);
  });

  it("refuses a disabled target", async () => {
    const ports = arrange();
    ports.repository.state.users.set(TARGET, anOperatorUser({ userId: TARGET, disabledAt: T0 }));
    const refused = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("IMPERSONATION_FORBIDDEN");
  });

  it("refuses an unknown target without confirming whether it exists", async () => {
    const refused = await startImpersonation(arrange(), {
      sessionToken: ORIGIN_RAW,
      targetUserId: userId("nobody"),
    });
    expect(refused.ok).toBe(false);
  });

  it("REFUSES TO CHAIN: starting from a session that is already impersonating", async () => {
    const ports = arrange();
    const first = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const chained = await startImpersonation(ports, {
      sessionToken: first.value.token,
      targetUserId: userId("someone-else"),
    });
    expect(chained.ok).toBe(false);
    if (chained.ok) return;
    expect(chained.error.code).toBe("IMPERSONATION_FORBIDDEN");
  });
});

describe("stopping impersonation", () => {
  it("revokes the impersonation session and returns a plain operator session", async () => {
    const ports = arrange();
    const started = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    if (!started.ok) return;

    ports.clock.advance(MINUTE_MS);
    const stopped = await stopImpersonation(ports, { sessionToken: started.value.token });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;

    expect(ports.repository.state.sessions.get(started.value.sessionId)?.revokedAt).toEqual(
      at(MINUTE_MS),
    );
    const returned = await authenticateOperator(ports, { presentedToken: stopped.value.token });
    expect(returned.ok).toBe(true);
    if (!returned.ok) return;
    expect(returned.value.impersonation).toBeNull();
    expect(returned.value.effectiveUserId).toBe(OPERATOR);
  });

  it("AUDITS THE STOP as well as the start", async () => {
    const ports = arrange();
    const started = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    if (!started.ok) return;
    await stopImpersonation(ports, { sessionToken: started.value.token });
    expect(ports.repository.state.impersonationAudit.map((entry) => entry.action)).toEqual([
      "START",
      "STOP",
    ]);
  });

  it("refuses to stop a session that is not impersonating", async () => {
    const refused = await stopImpersonation(arrange(), { sessionToken: ORIGIN_RAW });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("IMPERSONATION_FORBIDDEN");
  });

  it("REFUSES TO RETURN TO AN ORIGIN THAT WAS REVOKED MEANWHILE", async () => {
    const ports = arrange();
    const started = await startImpersonation(ports, {
      sessionToken: ORIGIN_RAW,
      targetUserId: TARGET,
    });
    if (!started.ok) return;

    const origin = ports.repository.state.sessions.get(sessionId("origin"));
    expect(origin).toBeDefined();
    if (origin === undefined) return;
    ports.repository.state.sessions.set(origin.sessionId, { ...origin, revokedAt: T0 });

    const refused = await stopImpersonation(ports, { sessionToken: started.value.token });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("SESSION_REVOKED");
  });
});
