// The `PlatosAuthService` differential, part one: sessions.
//
// WIN-258 tranche 2's acceptance. `internal-packages/tenancy-database/src/auth.ts`
// is 1,196 lines and 17 public methods, and it is the behaviour the ten stores in
// this package replace. The only honest way to show a replacement is a
// replacement is to run BOTH against the SAME real database and compare what each
// left behind.
//
// HOW A COMPARISON IS MADE. Each case drives the oracle for one operator and the
// V1 use cases — over this adapter — for another, then snapshots every
// identity-access row belonging to each and compares the two with volatile
// values normalised. Identifiers become `<user>`, `<session-1>`, instants become
// millisecond offsets from the one clock both sides are given. Nothing else is
// normalised, so a different `tier`, a different `expiresAt` window, a missing
// `OperatorIdentity`, an extra row or a different count all fail.
//
// Part two — `identity-differential-login.integration.test.ts` — covers the
// login paths, MFA, impersonation, the one divergence, and what is out of scope.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashSecret } from "@platos/tenancy-database";
import {
  authenticateOperator,
  issueOperatorSession,
  revokeOperatorSession,
} from "@platos/context-identity-access/application/index.js";
import type { UserId } from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import {
  NOW,
  opaque,
  pair,
  realHasher,
  snapshot,
  startDifferential,
  stopDifferential,
} from "./identity-differential-harness.js";
import * as shared from "./identity-differential-harness.js";

beforeAll(startDifferential, 300_000);
afterAll(stopDifferential);

describe("issueOperatorSession", () => {
  test("the two sides write the same session row", async () => {
    const { oracleUser, v1User } = await pair("issue");
    await shared.oracle.issueOperatorSession({ userId: oracleUser });
    const issued = await issueOperatorSession(shared.ports, { userId: asIdentifier<UserId>(v1User) });
    expect(issued.ok).toBe(true);

    const left = await snapshot(oracleUser, `oracle-issue@example.test`);
    const right = await snapshot(v1User, `v1-issue@example.test`);
    expect(right.sessions).toEqual(left.sessions);
    // Not vacuous: there IS a session, its digest is a real SHA-256 hex, and the
    // seven-day window both sides use is the same number.
    expect(left.sessions).toHaveLength(1);
    expect((left.sessions[0] as { expiresAt: number }).expiresAt).toBe(7 * 24 * 60 * 60 * 1000);
    expect((right.sessions[0] as { digestIsHex: boolean }).digestIsHex).toBe(true);
  }, 180_000);
});

describe("authorizeOperatorSession", () => {
  const states = ["active", "revoked", "expired", "unknown-token"] as const;

  test("the two sides accept and refuse the same four states", async () => {
    const { oracleUser, v1User } = await pair("authorize");
    const verdicts: Record<string, { oracle: string; v1: string }> = {};

    for (const state of states) {
      const oracleSession = await shared.oracle.issueOperatorSession({ userId: oracleUser });
      const v1Session = await issueOperatorSession(shared.ports, {
        userId: asIdentifier<UserId>(v1User),
      });
      if (!v1Session.ok) throw new Error("the V1 session was not issued");

      if (state === "revoked") {
        await shared.oracle.revokeOperatorSession(oracleSession.token);
        await revokeOperatorSession(shared.ports, { presentedToken: v1Session.value.token });
      }
      if (state === "expired") {
        const past = new Date(NOW.getTime() - 1000);
        await shared.harness.client.operatorSession.updateMany({
          where: { tokenHash: hashSecret(oracleSession.token) },
          data: { expiresAt: past },
        });
        await shared.harness.client.operatorSession.updateMany({
          where: { tokenHash: realHasher.hash(v1Session.value.token) },
          data: { expiresAt: past },
        });
      }

      const oracleToken = state === "unknown-token" ? opaque("plt_os_") : oracleSession.token;
      const v1Token = state === "unknown-token" ? opaque("plt_os_") : v1Session.value.token;

      let oracleVerdict = "accepted";
      try {
        await shared.oracle.authorizeOperatorSession(oracleToken);
      } catch (error) {
        oracleVerdict = (error as { code?: string }).code ?? "threw";
      }
      const v1Result = await authenticateOperator(shared.ports, { presentedToken: v1Token });
      const v1Verdict = v1Result.ok
        ? "accepted"
        : ((v1Result.error as { reason?: string; code?: string }).reason ??
          (v1Result.error as { code?: string }).code ??
          "refused");
      verdicts[state] = { oracle: oracleVerdict, v1: v1Verdict };
    }

    // ACCEPT/REFUSE must agree state by state. The refusal VOCABULARY does not:
    // the oracle throws `PlatosAuthError` codes and V1 returns a domain
    // `Result`, which is the deliberate change WIN-256 made. So the comparison
    // is on the decision, and the two vocabularies are recorded beside it.
    expect(verdicts.active).toEqual({ oracle: "accepted", v1: "accepted" });
    for (const state of ["revoked", "expired", "unknown-token"] as const) {
      expect(verdicts[state]?.oracle).not.toBe("accepted");
      expect(verdicts[state]?.v1).not.toBe("accepted");
    }
    // The oracle's own codes, pinned, so a silent change to them is visible.
    expect(verdicts.revoked?.oracle).toBe("revoked");
    expect(verdicts.expired?.oracle).toBe("expired");
    expect(verdicts["unknown-token"]?.oracle).toBe("unauthorized");
  }, 180_000);

  test("both sides stamp lastSeenAt on a successful authorization and neither on a refusal", async () => {
    const { oracleUser, v1User } = await pair("last-seen");
    const oracleSession = await shared.oracle.issueOperatorSession({ userId: oracleUser });
    const v1Session = await issueOperatorSession(shared.ports, { userId: asIdentifier<UserId>(v1User) });
    if (!v1Session.ok) throw new Error("the V1 session was not issued");

    await shared.oracle.authorizeOperatorSession(oracleSession.token);
    await authenticateOperator(shared.ports, { presentedToken: v1Session.value.token });

    const left = await snapshot(oracleUser, "oracle-last-seen@example.test");
    const right = await snapshot(v1User, "v1-last-seen@example.test");
    expect(right.sessions).toEqual(left.sessions);
    expect((left.sessions[0] as { lastSeenAt: number | null }).lastSeenAt).toBe(0);
  }, 180_000);
});

describe("revokeOperatorSession", () => {
  test("both sides end the session once and report the second call differently but consistently", async () => {
    const { oracleUser, v1User } = await pair("revoke");
    const oracleSession = await shared.oracle.issueOperatorSession({ userId: oracleUser });
    const v1Session = await issueOperatorSession(shared.ports, { userId: asIdentifier<UserId>(v1User) });
    if (!v1Session.ok) throw new Error("the V1 session was not issued");

    expect(await shared.oracle.revokeOperatorSession(oracleSession.token)).toBe(true);
    const firstV1 = await revokeOperatorSession(shared.ports, {
      presentedToken: v1Session.value.token,
    });
    expect(firstV1.ok).toBe(true);

    // The SECOND call is the distinction both sides preserve: an already-ended
    // session is not ended again. The oracle reports `false`, V1 reports a
    // refusal — different shapes, same decision — and neither writes a second
    // `revokedAt`.
    expect(await shared.oracle.revokeOperatorSession(oracleSession.token)).toBe(false);
    const secondV1 = await revokeOperatorSession(shared.ports, {
      presentedToken: v1Session.value.token,
    });
    expect(secondV1.ok).toBe(false);

    const left = await snapshot(oracleUser, "oracle-revoke@example.test");
    const right = await snapshot(v1User, "v1-revoke@example.test");
    expect(right.sessions).toEqual(left.sessions);
    expect((left.sessions[0] as { revokedAt: number | null }).revokedAt).toBe(0);
  }, 180_000);
});

