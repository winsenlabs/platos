// SHA-256 hex, base64url for PKCE, and a length check that runs BEFORE the
// constant-time primitive — the identity-access `SecretHasher`, and the first
// implementation of it in this tree.
//
// UNTIL THIS FILE THE ONLY IMPLEMENTATION WAS A TEST DOUBLE.
// `identity-access/application/testing.ts` publishes `fakeSecretHasher`, whose
// `hash` is `` `digest(${secret})` `` and whose `equals` is `===`. Every use case
// in the context — `authenticate-operator`, `magic-link-login`,
// `exchange-oauth-refresh-token`, `consume-rate-limit`, `enrol-totp`,
// `verify-mfa` — has passed against it since M2.1. Those suites prove the RULES.
// None of them has ever produced a digest a stored row would match, which is the
// whole reason this directory exists.
//
// ---------------------------------------------------------------------------
// THE DIGEST IS NOT A CHOICE. IF IT MOVES, IT IS A MIGRATION.
//
// `OperatorSession.tokenHash`, `MagicLinkToken.tokenHash`, `AccessKey.keyHash`,
// `OAuthAccessToken.tokenHash`, `OAuthClient.clientSecretHash`,
// `OperatorMfaRecoveryCode.codeHash` and `AuthRateLimitBucket.identifierHash`
// are columns already populated in every live database, and every one of them
// holds the output of ONE expression, written twice in the extraction source:
//
//   internal-packages/tenancy-database/src/auth.ts   `hashSecret`
//     createHash("sha256").update(value, "utf8").digest("hex")
//
//   apps/agent/src/oauth/oauth.service.ts:124        `sha256`
//     crypto.createHash("sha256").update(raw).digest("hex")
//
// The two differ by an argument that changes nothing — `update(string)` already
// defaults to utf8 — and agree on everything that does: SHA-256, of the UTF-8
// bytes, rendered as LOWER-CASE hex. An adapter that chose uppercase hex, or
// base64, or a salt, or a work factor would not fail a test. It would return a
// digest no unique index matches, and every operator in the installation would
// be told their credential was wrong.
//
// SYNCHRONOUS, AND THAT IS THE PORT'S DECISION RATHER THAN THIS FILE'S.
// `SecretHasher.hash` returns `TokenHash` and not `Promise<TokenHash>`, which
// rules out argon2 and bcrypt at the type level. The port says why, and the
// reason is not performance: "there are no passwords in this system... these are
// high-entropy random tokens, not human-chosen secrets, and a slow KDF here
// would only make every request slower." A 256-bit random token has no
// dictionary to search.
//
// THE PKCE CHALLENGE IS THE SAME DIGEST UNDER A DIFFERENT ALPHABET, and the
// difference is fixed by RFC 7636 §4.2 rather than by us:
//
//   apps/agent/src/oauth/oauth.service.ts:820-823    (the S256 verification)
//   apps/agent/src/oauth/oauth.controller.ts:1189-1192, 1421-1424
//     crypto.createHash("sha256").update(verifier).digest("base64url")
//
// A hex challenge is one no compliant client ever computes, so it would not
// merely mismatch this server's own rows — it would mismatch the world's.
// `oracle-vectors.ts` pins RFC 7636 Appendix B's published pair for exactly that
// reason: it is ground truth nothing in this repository can edit into agreement.
// ---------------------------------------------------------------------------

import { createHash, timingSafeEqual } from "node:crypto";

import type {
  SecretHasher,
  TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

/** The one digest this boundary computes. Named once so nothing can drift from it. */
const DIGEST = "sha256";

/**
 * The encoding every stored verifier column is written in.
 *
 * Node's `hex` is lower-case and always has been. The constant exists so the
 * hash and the challenge read as one decision with two outputs rather than as
 * two independent literals that could be edited apart.
 */
const VERIFIER_ENCODING = "hex";

/** RFC 7636 §4.2's `code_challenge_method=S256` encoding. */
const CHALLENGE_ENCODING = "base64url";

export function createSecretHasher(): SecretHasher {
  return {
    // `string` and not `RawToken | string`, which is what the port writes.
    // `RawToken` is a branded `string`, so the union IS `string` and the two
    // signatures are the same type — and `application/ports/index.js` does not
    // re-export the brand, deliberately: nothing outside the context needs to
    // MINT one. Widening here rather than reaching into `domain/` is what keeps
    // `cross-context-contracts-only` satisfied for a package that is not the
    // context.
    hash(secret: string): TokenHash {
      // `update(secret, "utf8")` names the encoding because `hashSecret` in the
      // extraction source names it, and a reader comparing the two lines should
      // not have to know that Node's default is the same thing.
      return asIdentifier<TokenHash>(
        createHash(DIGEST).update(secret, "utf8").digest(VERIFIER_ENCODING),
      );
    },

    equals(left: string, right: string): boolean {
      // THE LENGTH CHECK IS FIRST AND IT IS NOT AN OPTIMISATION.
      // `crypto.timingSafeEqual` THROWS on buffers of unequal length, and a
      // throw is observable in a way a `false` is not: a caller could time the
      // difference between a rejected comparison and an exception unwinding out
      // through the use case, and learn the width of the stored verifier.
      //
      // Comparing `.length` on two already-materialised buffers is one integer
      // comparison that does not read the CONTENTS of either, so the only thing
      // it can leak is a length — and when the lengths DO match, every byte goes
      // through `timingSafeEqual` and nothing short-circuits.
      //
      // This is `safeEqual` in `internal-packages/tenancy-database/src/auth.ts`
      // clause for clause, including the UTF-8 decoding: that function compares
      // every TOTP code and every recovery code in the extraction source, and it
      // is the one the port's contract paragraph describes.
      const leftBytes = Buffer.from(left, "utf8");
      const rightBytes = Buffer.from(right, "utf8");
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
    },

    deriveCodeChallenge(codeVerifier: string): string {
      return createHash(DIGEST).update(codeVerifier, "utf8").digest(CHALLENGE_ENCODING);
    },
  };
}
