// WIN-293 clause 4 — cryptographic workload identity for service-to-service calls.
//
// Replaces the shared bearer secret (PLATOS_INTERNAL_AUTH_TOKEN) with a
// short-lived, asymmetric, request-bound workload credential in the shape of a
// SPIFFE JWT-SVID plus DPoP-style (RFC 9449) request binding.
//
// WHY THIS IS WORKLOAD IDENTITY AND NOT A RELABELLED BEARER TOKEN
//   * Asymmetric (Ed25519/EdDSA): the agent holds ONLY public keys. Compromising
//     the verifier cannot mint a credential. A shared secret fails this.
//   * Per-request, short-lived (default 60s, hard cap 300s): a captured token is
//     useless outside a tiny window, unlike a static secret valid forever.
//   * Bound to the exact request (htm/htu, optional body hash): a token captured
//     for one endpoint cannot be replayed against another.
//   * Bound to the caller identity (iss/sub pinned to the signing kid): a stolen
//     worker key cannot mint webapp-identity tokens.
//   * Bound to audience (aud) and to the tenant tuple (org/prj/env).
//   * Single-use (jti) when the caller supplies a replay store.
//   * Revocable by removing a kid from the verifier keyset; rotatable by serving
//     two kids during an overlap window.
//
// This module is PURE: node:crypto only, no I/O, no Redis, no framework. That
// keeps it importable by the webapp (signer), the durable worker tasks (signer),
// and the agent guard (verifier) — including lightweight test harnesses. Replay
// state is deliberately the caller's concern (see `jti` in the result).
import * as crypto from "node:crypto";

export const WORKLOAD_TOKEN_HEADER = "x-platos-workload-token";
export const WORKLOAD_AUDIENCE = "platos-agent";
export const WORKLOAD_JWT_TYP = "workload+jwt";
export const WORKLOAD_ALG = "EdDSA";

/** Default credential lifetime and the absolute ceiling we will ever accept. */
export const DEFAULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 300;
/** Tolerance for clock drift between workloads (seconds). */
export const CLOCK_SKEW_SECONDS = 30;

/** Canonical workload identities. `sub` is a SPIFFE-style workload id. */
export const WORKLOAD_IDENTITIES = {
  webapp: { iss: "platos-webapp", sub: "spiffe://platos/webapp" },
  worker: { iss: "platos-worker", sub: "spiffe://platos/worker" },
} as const;
export type WorkloadName = keyof typeof WORKLOAD_IDENTITIES;

/**
 * Stable, enumerated verification outcomes. These are a telemetry contract:
 * dashboards, alerts and tests match on them, so values must remain stable and
 * new members are APPENDED, never renamed.
 */
export enum WorkloadVerifyReason {
  OK = "OK",
  MALFORMED = "MALFORMED",
  BAD_ALG = "BAD_ALG",
  BAD_TYP = "BAD_TYP",
  UNKNOWN_KID = "UNKNOWN_KID",
  BAD_SIGNATURE = "BAD_SIGNATURE",
  WRONG_AUDIENCE = "WRONG_AUDIENCE",
  WRONG_ISSUER = "WRONG_ISSUER",
  WRONG_WORKLOAD = "WRONG_WORKLOAD",
  EXPIRED = "EXPIRED",
  NOT_YET_VALID = "NOT_YET_VALID",
  TTL_TOO_LONG = "TTL_TOO_LONG",
  WRONG_METHOD = "WRONG_METHOD",
  WRONG_PATH = "WRONG_PATH",
  WRONG_TENANT = "WRONG_TENANT",
  BODY_MISMATCH = "BODY_MISMATCH",
  MISSING_JTI = "MISSING_JTI",
}

export interface WorkloadClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  htm: string;
  htu: string;
  org?: string;
  prj?: string;
  env?: string;
  bh?: string;
}

export interface KeysetEntry {
  /** PEM SPKI public key. */
  pub: string;
  /** The identity this key is allowed to assert — pins iss/sub to the kid. */
  iss: string;
  sub: string;
}
export type Keyset = Record<string, KeysetEntry>;

const b64u = (buf: Buffer | string): string =>
  Buffer.from(buf as never).toString("base64url");

const jsonB64u = (o: unknown): string => b64u(Buffer.from(JSON.stringify(o), "utf8"));

/** base64url(sha256(rawBody)) — bind a request body into the credential. */
export function bodyHash(raw: string | Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

/** Normalise a URL to the path used for `htu` binding: no origin, no query. */
export function canonicalPath(url: string): string {
  const noOrigin = url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  return (noOrigin.split("?", 1)[0] || "/") as string;
}

export interface SignInput {
  privateKeyPem: string;
  kid: string;
  workload: WorkloadName;
  method: string;
  /** Full URL or path; normalised to a path for `htu`. */
  path: string;
  tenant?: { org?: string; prj?: string; env?: string };
  /** Pass the exact raw body string/buffer to bind it (callback surfaces). */
  body?: string | Buffer;
  ttlSeconds?: number;
  /** Injectable clock (seconds) for deterministic tests. */
  nowSeconds?: number;
}

/**
 * Mint a workload credential. Throws rather than emitting a weak token: a
 * refusal is always safer than a long-lived or unbound credential.
 */
export function signWorkloadJwt(input: SignInput): string {
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("workload token ttl must be positive");
  if (ttl > MAX_TTL_SECONDS)
    throw new Error(`workload token ttl ${ttl}s exceeds the ${MAX_TTL_SECONDS}s cap`);
  const identity = WORKLOAD_IDENTITIES[input.workload];
  if (!identity) throw new Error(`unknown workload ${String(input.workload)}`);

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: WORKLOAD_ALG, typ: WORKLOAD_JWT_TYP, kid: input.kid };
  const payload: WorkloadClaims = {
    iss: identity.iss,
    sub: identity.sub,
    aud: WORKLOAD_AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + ttl,
    jti: crypto.randomBytes(16).toString("hex"),
    htm: input.method.toUpperCase(),
    htu: canonicalPath(input.path),
    ...(input.tenant?.org ? { org: input.tenant.org } : {}),
    ...(input.tenant?.prj ? { prj: input.tenant.prj } : {}),
    ...(input.tenant?.env ? { env: input.tenant.env } : {}),
    ...(input.body !== undefined ? { bh: bodyHash(input.body) } : {}),
  };
  const signingInput = `${jsonB64u(header)}.${jsonB64u(payload)}`;
  const sig = crypto.sign(
    null,
    Buffer.from(signingInput, "utf8"),
    crypto.createPrivateKey(input.privateKeyPem)
  );
  return `${signingInput}.${sig.toString("base64url")}`;
}

export interface VerifyInput {
  keyset: Keyset;
  /** The identity this SURFACE requires (defence in depth over the kid pin). */
  expectedWorkloads?: WorkloadName[];
  method: string;
  path: string;
  /** When provided, the credential's tenant claims must match exactly. */
  tenant?: { org?: string; prj?: string; env?: string };
  /** When provided, the credential must carry a matching body hash. */
  body?: string | Buffer;
  nowSeconds?: number;
  requireJti?: boolean;
}

export type VerifyResult =
  | { ok: true; reason: WorkloadVerifyReason.OK; claims: WorkloadClaims; kid: string; jti: string }
  | { ok: false; reason: WorkloadVerifyReason; claims?: WorkloadClaims };

/**
 * Verify a workload credential. STATELESS by design — replay single-use is
 * enforced by the caller using the returned `jti`, so this stays usable where no
 * Redis handle exists. Fails CLOSED: every path returns ok:false with a reason.
 */
export function verifyWorkloadJwt(token: unknown, opts: VerifyInput): VerifyResult {
  if (typeof token !== "string" || token.length === 0)
    return { ok: false, reason: WorkloadVerifyReason.MALFORMED };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: WorkloadVerifyReason.MALFORMED };
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  let claims: WorkloadClaims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
      kid?: unknown;
    };
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as WorkloadClaims;
  } catch {
    return { ok: false, reason: WorkloadVerifyReason.MALFORMED };
  }
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object")
    return { ok: false, reason: WorkloadVerifyReason.MALFORMED };

  // Algorithm is pinned BEFORE any signature work: no "none", no alg confusion,
  // no downgrade to a symmetric algorithm the verifier could be tricked into
  // running with a public key as the HMAC secret.
  if (header.alg !== WORKLOAD_ALG) return { ok: false, reason: WorkloadVerifyReason.BAD_ALG };
  if (header.typ !== WORKLOAD_JWT_TYP) return { ok: false, reason: WorkloadVerifyReason.BAD_TYP };
  const kid = typeof header.kid === "string" ? header.kid : "";
  const entry = Object.prototype.hasOwnProperty.call(opts.keyset, kid)
    ? opts.keyset[kid]
    : undefined;
  if (!entry) return { ok: false, reason: WorkloadVerifyReason.UNKNOWN_KID };

  // Signature first — nothing in the payload is trusted until it verifies.
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      null,
      Buffer.from(`${h}.${p}`, "utf8"),
      crypto.createPublicKey(entry.pub),
      Buffer.from(s, "base64url")
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: WorkloadVerifyReason.BAD_SIGNATURE };

  if (claims.aud !== WORKLOAD_AUDIENCE)
    return { ok: false, reason: WorkloadVerifyReason.WRONG_AUDIENCE, claims };
  // The kid pins the identity: a key may only assert the iss/sub it was
  // registered for, so a stolen worker key cannot mint webapp credentials.
  if (claims.iss !== entry.iss)
    return { ok: false, reason: WorkloadVerifyReason.WRONG_ISSUER, claims };
  if (claims.sub !== entry.sub)
    return { ok: false, reason: WorkloadVerifyReason.WRONG_WORKLOAD, claims };
  // And the surface may additionally narrow which workloads it accepts.
  if (opts.expectedWorkloads && opts.expectedWorkloads.length > 0) {
    const allowed = opts.expectedWorkloads.map((w) => WORKLOAD_IDENTITIES[w]);
    if (!allowed.some((a) => a.iss === claims.iss && a.sub === claims.sub))
      return { ok: false, reason: WorkloadVerifyReason.WRONG_WORKLOAD, claims };
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number")
    return { ok: false, reason: WorkloadVerifyReason.MALFORMED, claims };
  if (claims.exp - claims.iat > MAX_TTL_SECONDS)
    return { ok: false, reason: WorkloadVerifyReason.TTL_TOO_LONG, claims };
  if (now >= claims.exp + CLOCK_SKEW_SECONDS)
    return { ok: false, reason: WorkloadVerifyReason.EXPIRED, claims };
  const nbf = typeof claims.nbf === "number" ? claims.nbf : claims.iat;
  if (now + CLOCK_SKEW_SECONDS < nbf)
    return { ok: false, reason: WorkloadVerifyReason.NOT_YET_VALID, claims };

  // Request binding (DPoP-style): a credential captured for one call cannot be
  // replayed against a different method, path, body or tenant.
  if (claims.htm !== opts.method.toUpperCase())
    return { ok: false, reason: WorkloadVerifyReason.WRONG_METHOD, claims };
  if (claims.htu !== canonicalPath(opts.path))
    return { ok: false, reason: WorkloadVerifyReason.WRONG_PATH, claims };
  if (opts.tenant) {
    const t = opts.tenant;
    if (
      (t.org !== undefined && claims.org !== t.org) ||
      (t.prj !== undefined && claims.prj !== t.prj) ||
      (t.env !== undefined && claims.env !== t.env)
    )
      return { ok: false, reason: WorkloadVerifyReason.WRONG_TENANT, claims };
  }
  if (opts.body !== undefined) {
    const expected = bodyHash(opts.body);
    if (typeof claims.bh !== "string" || claims.bh.length !== expected.length)
      return { ok: false, reason: WorkloadVerifyReason.BODY_MISMATCH, claims };
    if (!crypto.timingSafeEqual(Buffer.from(claims.bh), Buffer.from(expected)))
      return { ok: false, reason: WorkloadVerifyReason.BODY_MISMATCH, claims };
  }
  if (opts.requireJti !== false && (typeof claims.jti !== "string" || claims.jti.length < 16))
    return { ok: false, reason: WorkloadVerifyReason.MISSING_JTI, claims };

  return { ok: true, reason: WorkloadVerifyReason.OK, claims, kid, jti: claims.jti };
}

/**
 * Parse the verifier keyset from its env representation (JSON: kid -> entry).
 * Returns an empty keyset on anything malformed — an empty keyset rejects every
 * credential (fail CLOSED), it never falls back to accepting one.
 */
export function parseKeyset(raw: string | undefined | null): Keyset {
  if (!raw || typeof raw !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Keyset = {};
  for (const [kid, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    if (typeof e.pub !== "string" || typeof e.iss !== "string" || typeof e.sub !== "string")
      continue;
    out[kid] = { pub: e.pub, iss: e.iss, sub: e.sub };
  }
  return out;
}

/** Generate an Ed25519 workload keypair (used by tests and the ops helper). */
export function generateWorkloadKeypair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
