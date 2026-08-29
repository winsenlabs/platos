// WIN-293 clause 4 — adversarial tests for the workload credential.
//
// Every test below is an ATTACK that must fail closed, plus the positive
// controls proving the attacks are discriminating (i.e. the same request
// succeeds when the attack is removed).
import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  WORKLOAD_AUDIENCE,
  WorkloadVerifyReason,
  bodyHash,
  canonicalPath,
  generateWorkloadKeypair,
  parseKeyset,
  signWorkloadJwt,
  verifyWorkloadJwt,
  type Keyset,
} from "./index";

const webapp = generateWorkloadKeypair();
const worker = generateWorkloadKeypair();
const attacker = generateWorkloadKeypair();

const KEYSET: Keyset = {
  wa_1: { pub: webapp.publicKeyPem, iss: "platos-webapp", sub: "spiffe://platos/webapp" },
  wk_1: { pub: worker.publicKeyPem, iss: "platos-worker", sub: "spiffe://platos/worker" },
};

const NOW = 1_800_000_000;
const REQ = { method: "POST", path: "/api/v1/agent/threads" };
const TENANT = { org: "org_1", prj: "proj_1", env: "env_1" };

const mintWebapp = (over: Partial<Parameters<typeof signWorkloadJwt>[0]> = {}) =>
  signWorkloadJwt({
    privateKeyPem: webapp.privateKeyPem,
    kid: "wa_1",
    workload: "webapp",
    method: REQ.method,
    path: REQ.path,
    tenant: TENANT,
    nowSeconds: NOW,
    ...over,
  });

const verify = (token: string, over: Partial<Parameters<typeof verifyWorkloadJwt>[1]> = {}) =>
  verifyWorkloadJwt(token, {
    keyset: KEYSET,
    method: REQ.method,
    path: REQ.path,
    tenant: TENANT,
    nowSeconds: NOW,
    ...over,
  });

describe("positive control — a correctly minted credential verifies", () => {
  it("accepts and returns bound claims + a jti for single-use enforcement", () => {
    const r = verify(mintWebapp());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reason).toBe(WorkloadVerifyReason.OK);
    expect(r.claims.aud).toBe(WORKLOAD_AUDIENCE);
    expect(r.claims.iss).toBe("platos-webapp");
    expect(r.claims.sub).toBe("spiffe://platos/webapp");
    expect(r.claims.exp - r.claims.iat).toBe(DEFAULT_TTL_SECONDS);
    expect(r.jti).toHaveLength(32);
    expect(r.kid).toBe("wa_1");
  });

  it("mints a DISTINCT jti per call, so single-use enforcement is possible", () => {
    const a = verify(mintWebapp());
    const b = verify(mintWebapp());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.jti).not.toBe(b.jti);
  });
});

describe("ATTACK: stolen / forged signing key", () => {
  it("rejects a credential signed by an attacker key under a known kid", () => {
    const forged = signWorkloadJwt({
      privateKeyPem: attacker.privateKeyPem,
      kid: "wa_1", // claims to be the webapp
      workload: "webapp",
      method: REQ.method,
      path: REQ.path,
      tenant: TENANT,
      nowSeconds: NOW,
    });
    expect(verify(forged).reason).toBe(WorkloadVerifyReason.BAD_SIGNATURE);
  });

  it("rejects an unknown kid (revocation = remove the kid from the keyset)", () => {
    const t = mintWebapp({ kid: "wa_revoked" });
    expect(verify(t).reason).toBe(WorkloadVerifyReason.UNKNOWN_KID);
  });

  it("REVOCATION: a credential valid under the full keyset is rejected once its kid is removed", () => {
    const t = mintWebapp();
    expect(verify(t).ok).toBe(true);
    const revoked: Keyset = { wk_1: KEYSET.wk_1! };
    expect(verify(t, { keyset: revoked }).reason).toBe(WorkloadVerifyReason.UNKNOWN_KID);
  });
});

describe("ATTACK: wrong workload (a stolen worker key must not become the webapp)", () => {
  it("rejects when the worker key signs webapp identity claims (kid pins iss/sub)", () => {
    // Sign with the WORKER key but under the worker kid, asserting webapp identity
    // is impossible via signWorkloadJwt (identity derives from `workload`), so we
    // hand-forge the mismatch: worker key + worker kid, but the surface demands webapp.
    const t = signWorkloadJwt({
      privateKeyPem: worker.privateKeyPem,
      kid: "wk_1",
      workload: "worker",
      method: REQ.method,
      path: REQ.path,
      tenant: TENANT,
      nowSeconds: NOW,
    });
    const r = verify(t, { expectedWorkloads: ["webapp"] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(WorkloadVerifyReason.WRONG_WORKLOAD);
  });

  it("accepts the worker on a surface that allows the worker (discrimination control)", () => {
    const t = signWorkloadJwt({
      privateKeyPem: worker.privateKeyPem,
      kid: "wk_1",
      workload: "worker",
      method: REQ.method,
      path: REQ.path,
      tenant: TENANT,
      nowSeconds: NOW,
    });
    expect(verify(t, { expectedWorkloads: ["worker"] }).ok).toBe(true);
  });

  it("rejects a credential whose iss/sub do not match the kid's registered identity", () => {
    // Keyset entry mis-registered: the webapp public key registered as the worker.
    const swapped: Keyset = {
      wa_1: { pub: webapp.publicKeyPem, iss: "platos-worker", sub: "spiffe://platos/worker" },
    };
    const r = verify(mintWebapp(), { keyset: swapped });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(WorkloadVerifyReason.WRONG_ISSUER);
  });
});

describe("ATTACK: algorithm confusion / unsigned tokens", () => {
  it('rejects alg:"none"', () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "workload+jwt", kid: "wa_1" })
    ).toString("base64url");
    const payload = mintWebapp().split(".")[1]!;
    expect(verify(`${header}.${payload}.`).reason).toBe(WorkloadVerifyReason.BAD_ALG);
  });

  it("rejects a symmetric alg (HS256) even with a valid-looking body", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "workload+jwt", kid: "wa_1" })
    ).toString("base64url");
    const payload = mintWebapp().split(".")[1]!;
    expect(verify(`${header}.${payload}.deadbeef`).reason).toBe(WorkloadVerifyReason.BAD_ALG);
  });

  it("rejects a wrong typ (a session token cannot be replayed as a workload token)", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "wa_1" })
    ).toString("base64url");
    const payload = mintWebapp().split(".")[1]!;
    expect(verify(`${header}.${payload}.x`).reason).toBe(WorkloadVerifyReason.BAD_TYP);
  });

  it("rejects malformed input (empty, non-string, wrong segment count)", () => {
    expect(verify("").reason).toBe(WorkloadVerifyReason.MALFORMED);
    expect(verifyWorkloadJwt(undefined, { keyset: KEYSET, ...REQ }).reason).toBe(
      WorkloadVerifyReason.MALFORMED
    );
    expect(verify("a.b").reason).toBe(WorkloadVerifyReason.MALFORMED);
  });

  it("rejects a tampered payload (signature covers the claims)", () => {
    const [h, p, s] = mintWebapp().split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    claims.org = "org_ATTACKER";
    const tampered = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(verify(`${h}.${tampered}.${s}`).reason).toBe(WorkloadVerifyReason.BAD_SIGNATURE);
  });
});

describe("ATTACK: replay against a different request (DPoP-style binding)", () => {
  it("rejects replay against a different PATH", () => {
    const t = mintWebapp();
    expect(verify(t, { path: "/api/v1/agent/access-key" }).reason).toBe(
      WorkloadVerifyReason.WRONG_PATH
    );
  });

  it("rejects replay against a different METHOD", () => {
    expect(verify(mintWebapp(), { method: "DELETE" }).reason).toBe(
      WorkloadVerifyReason.WRONG_METHOD
    );
  });

  it("rejects replay against a different TENANT (cross-environment)", () => {
    const t = mintWebapp();
    expect(verify(t, { tenant: { ...TENANT, env: "env_OTHER" } }).reason).toBe(
      WorkloadVerifyReason.WRONG_TENANT
    );
    expect(verify(t, { tenant: { ...TENANT, org: "org_OTHER" } }).reason).toBe(
      WorkloadVerifyReason.WRONG_TENANT
    );
  });

  it("rejects a swapped BODY when the credential binds one", () => {
    const raw = JSON.stringify({ amount: 1 });
    const t = mintWebapp({ body: raw });
    expect(verify(t, { body: raw }).ok).toBe(true);
    expect(verify(t, { body: JSON.stringify({ amount: 1000 }) }).reason).toBe(
      WorkloadVerifyReason.BODY_MISMATCH
    );
  });

  it("rejects a credential with NO body binding on a surface that requires one", () => {
    const t = mintWebapp(); // no body bound
    expect(verify(t, { body: "{}" }).reason).toBe(WorkloadVerifyReason.BODY_MISMATCH);
  });

  it("query strings do not affect binding (htu is path-only, canonically)", () => {
    expect(canonicalPath("https://agent.internal/api/v1/x?y=1")).toBe("/api/v1/x");
    expect(verify(mintWebapp(), { path: `${REQ.path}?cursor=2` }).ok).toBe(true);
  });
});

describe("expiry, TTL ceiling and rotation overlap", () => {
  it("rejects an EXPIRED credential (beyond ttl + skew)", () => {
    const t = mintWebapp();
    const past = NOW + DEFAULT_TTL_SECONDS + CLOCK_SKEW_SECONDS + 1;
    expect(verify(t, { nowSeconds: past }).reason).toBe(WorkloadVerifyReason.EXPIRED);
  });

  it("still accepts inside the skew window (clock drift tolerance)", () => {
    const t = mintWebapp();
    expect(verify(t, { nowSeconds: NOW + DEFAULT_TTL_SECONDS + 1 }).ok).toBe(true);
  });

  it("rejects a NOT-YET-VALID credential from a badly skewed signer", () => {
    const t = mintWebapp({ nowSeconds: NOW + 600 });
    expect(verify(t, { nowSeconds: NOW }).reason).toBe(WorkloadVerifyReason.NOT_YET_VALID);
  });

  it("refuses to MINT a credential exceeding the TTL cap", () => {
    expect(() => mintWebapp({ ttlSeconds: MAX_TTL_SECONDS + 1 })).toThrow(/exceeds/);
    expect(() => mintWebapp({ ttlSeconds: 0 })).toThrow(/positive/);
  });

  it("rejects a hand-forged over-long TTL at VERIFY time too (defence in depth)", () => {
    // Forge a long-lived credential by signing claims directly.
    const header = { alg: "EdDSA", typ: "workload+jwt", kid: "wa_1" };
    const claims = {
      iss: "platos-webapp",
      sub: "spiffe://platos/webapp",
      aud: WORKLOAD_AUDIENCE,
      iat: NOW,
      nbf: NOW,
      exp: NOW + 86_400, // a day — a de-facto static secret
      jti: "a".repeat(32),
      htm: REQ.method,
      htu: REQ.path,
      ...TENANT,
      org: TENANT.org,
      prj: TENANT.prj,
      env: TENANT.env,
    };
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const si = `${b(header)}.${b(claims)}`;
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const sig = crypto
      .sign(null, Buffer.from(si), crypto.createPrivateKey(webapp.privateKeyPem))
      .toString("base64url");
    expect(verify(`${si}.${sig}`).reason).toBe(WorkloadVerifyReason.TTL_TOO_LONG);
  });

  it("ROTATION OVERLAP: both the old and the new kid verify while both are served", () => {
    const next = generateWorkloadKeypair();
    const overlap: Keyset = {
      ...KEYSET,
      wa_2: { pub: next.publicKeyPem, iss: "platos-webapp", sub: "spiffe://platos/webapp" },
    };
    const oldTok = mintWebapp();
    const newTok = signWorkloadJwt({
      privateKeyPem: next.privateKeyPem,
      kid: "wa_2",
      workload: "webapp",
      method: REQ.method,
      path: REQ.path,
      tenant: TENANT,
      nowSeconds: NOW,
    });
    expect(verify(oldTok, { keyset: overlap }).ok).toBe(true);
    expect(verify(newTok, { keyset: overlap }).ok).toBe(true);
    // After the overlap window closes, the old kid stops verifying.
    const rotated: Keyset = { wa_2: overlap.wa_2!, wk_1: KEYSET.wk_1! };
    expect(verify(oldTok, { keyset: rotated }).reason).toBe(WorkloadVerifyReason.UNKNOWN_KID);
    expect(verify(newTok, { keyset: rotated }).ok).toBe(true);
  });
});

describe("keyset parsing fails CLOSED", () => {
  it("returns an empty keyset for malformed input, which rejects everything", () => {
    for (const bad of [undefined, null, "", "not json", "[]", '"str"', "{}"]) {
      expect(Object.keys(parseKeyset(bad as never))).toHaveLength(0);
    }
    expect(verify(mintWebapp(), { keyset: parseKeyset(undefined) }).reason).toBe(
      WorkloadVerifyReason.UNKNOWN_KID
    );
  });

  it("skips entries missing pub/iss/sub rather than trusting them", () => {
    const ks = parseKeyset(JSON.stringify({ a: { pub: "x" }, b: { pub: "p", iss: "i", sub: "s" } }));
    expect(Object.keys(ks)).toEqual(["b"]);
  });

  it("ignores prototype-polluting keys", () => {
    const r = verify(mintWebapp(), { keyset: parseKeyset('{"__proto__":{"pub":"x"}}') });
    expect(r.ok).toBe(false);
  });
});

describe("body hashing", () => {
  it("is stable and distinguishes different bodies", () => {
    expect(bodyHash("a")).toBe(bodyHash("a"));
    expect(bodyHash("a")).not.toBe(bodyHash("b"));
  });
});
