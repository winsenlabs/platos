// THE OTHER HALF OF THE DIFFERENTIAL: the oracle has not moved.
//
// `secret-hasher.test.ts` proves this adapter reproduces digests the extraction
// source produced. That is a statement about bytes captured at ONE moment. This
// file is the standing join: it reads the extraction source OFF DISK on every
// run and asserts that the expressions those bytes came from are still the
// expressions there.
//
// WHY BOTH ARE NEEDED. A frozen vector cannot notice that the oracle changed —
// it would keep passing while the two implementations diverged, and the first
// symptom would be operators being told their credentials were wrong. An anchor
// alone cannot notice that THIS adapter changed. Together they close the loop
// in both directions, and neither side is a file this package owns: everything
// asserted below lives under `internal-packages/` and `apps/agent/`, which this
// issue does not edit and `origin/main` freezes.
//
// THESE ARE NOT IMPORTS. The files are READ, not loaded: `apps/agent` is a Nest
// application and `internal-packages/tenancy-database` needs a generated Prisma
// client, so importing either would make this package's unit suite depend on a
// build. An `fs.readFileSync` of a path creates no module edge, so
// `adapters-only-from-core` and `adapter-is-self-contained` are untouched — and
// the assertion is over source TEXT, which is what a reviewer would compare
// anyway.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The repository root, from this file rather than from the working directory. */
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function oracle(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

const AUTH = "internal-packages/tenancy-database/src/auth.ts";
const OAUTH_SERVICE = "apps/agent/src/oauth/oauth.service.ts";
const OAUTH_CONTROLLER = "apps/agent/src/oauth/oauth.controller.ts";

describe(`the stored-verifier digest in ${AUTH}`, () => {
  const source = oracle(AUTH);

  it("is still SHA-256 of the UTF-8 bytes, rendered as hex", () => {
    // `hashSecret` is the function behind `OperatorSession.tokenHash`,
    // `MagicLinkToken.tokenHash`, `OperatorMfaRecoveryCode.codeHash` and
    // `AuthRateLimitBucket.identifierHash`. Its whole body is pinned, not a
    // fragment of it, so a wrapper added around the digest moves this too.
    expect(source).toContain(
      [
        "export function hashSecret(value: string): string {",
        '  return createHash("sha256").update(value, "utf8").digest("hex");',
        "}",
      ].join("\n"),
    );
  });

  it("still has exactly one definition of it", () => {
    // A second definition would mean two answers to the same question, which is
    // how `secrets/domain/envelope.ts` came to catalogue three incompatible
    // envelope formats written by three modules that never agreed.
    expect(source.match(/function hashSecret\b/gu)).toHaveLength(1);
  });
});

describe(`the constant-time comparison in ${AUTH}`, () => {
  const source = oracle(AUTH);

  it("still checks the length BEFORE the primitive, over UTF-8 buffers", () => {
    // The clause `SecretHasher.equals` is required to mirror, quoted in full.
    // `Buffer.from(left)` with no encoding argument is UTF-8; that absence is
    // what makes `equals("AB","ab")` false, and it is why this adapter follows
    // this function rather than `timingSafeEqualHex` next door.
    expect(source).toContain(
      [
        "function safeEqual(left: string, right: string): boolean {",
        "  const leftBuffer = Buffer.from(left);",
        "  const rightBuffer = Buffer.from(right);",
        "  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);",
        "}",
      ].join("\n"),
    );
  });
});

describe(`the digest and the PKCE challenge in ${OAUTH_SERVICE}`, () => {
  const source = oracle(OAUTH_SERVICE);

  it("still hashes OAuth client secrets and codes the same way", () => {
    // The SECOND writer of the same columns' shape, and the one the task brief
    // named. It omits the `"utf8"` argument `hashSecret` spells; `update` on a
    // string defaults to utf8, so the two agree — and pinning both texts is what
    // makes that agreement checkable rather than assumed.
    expect(source).toContain(
      [
        "  private sha256(raw: string): string {",
        '    return crypto.createHash("sha256").update(raw).digest("hex");',
        "  }",
      ].join("\n"),
    );
  });

  it("still derives the S256 challenge as base64url", () => {
    expect(source).toContain(
      [
        "    const expectedChallenge = crypto",
        '      .createHash("sha256")',
        "      .update(input.codeVerifier)",
        '      .digest("base64url");',
      ].join("\n"),
    );
  });
});

describe(`the PKCE challenge in ${OAUTH_CONTROLLER}`, () => {
  const source = oracle(OAUTH_CONTROLLER);

  it("still derives the outbound challenge as base64url", () => {
    expect(source).toContain(
      [
        "    const entityPkceChallenge = crypto",
        '      .createHash("sha256")',
        "      .update(entityPkceVerifier)",
        '      .digest("base64url");',
      ].join("\n"),
    );
  });

  it("uses base64url for every challenge it derives and hex for every identity it keys", () => {
    // The two encodings are not interchangeable and the file uses both. This
    // counts them so that a future edit which "tidied" one into the other has to
    // move a number here as well: `deriveCodeChallenge` returning hex would be a
    // server no compliant client could complete a flow against, and `hash`
    // returning base64url would be a digest no index matches.
    //
    // THREE base64url and ONE hex, measured rather than guessed: one challenge
    // derivation and two HMAC state signatures on the base64url side, and the
    // external-identity digest at :1421 on the hex side.
    expect(source.match(/\.digest\("base64url"\)/gu)).toHaveLength(3);
    expect(source.match(/\.digest\("hex"\)/gu)).toHaveLength(1);
  });
});
