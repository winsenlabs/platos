// `InvitationTokenIssuer` — the one port in this tranche with no database in it.
//
// It is an adapter and not a domain function because both halves are things a
// pure layer cannot be: `mint` needs cryptographic randomness and `digest` needs
// a hash. Neither is reproducible, and a use case that called them directly
// would be untestable at a fixed instant with a fixed token, which is the whole
// reason tenancy's dependencies are ports.
//
// THE DIGEST IS THE CONSTRAINT, AND THE IN-MEMORY DOUBLE VIOLATES IT. The
// migrations carry `OrganizationInvitation_tokenHash_check` — `~ '^[0-9a-f]{64}$'`
// — on the column this port fills, and the context's own fake mints
// `digest:plt_inv_1`, which no PostgreSQL will accept. That fake satisfies every
// unit test in the tree. `sha256(token)` rendered as lowercase hex is 64
// characters by construction, so the shape is not asserted here so much as
// produced; `invitation-token.test.ts` pins it anyway, because "by construction"
// is exactly the claim that stops being true when somebody changes the encoding
// to base64url for the same reason they would change any encoding.
//
// THE RAW TOKEN IS NEVER STORED AND NEVER RE-DERIVABLE. `mint` returns it once,
// the caller emails it, and everything after that works from the digest. A lost
// invitation is re-issued, not recovered — which is why there is no `verify`
// here and no reverse of any kind.

import { createHash, randomBytes } from "node:crypto";

import type {
  InvitationTokenIssuer,
  MintedInvitationToken,
  TokenDigest,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

/**
 * `TOKEN_PREFIXES.invitation` in identity-access's published contract.
 *
 * Restated here rather than imported, because a tenancy adapter reaching into
 * another context to mint its own row's secret is a dependency that buys
 * nothing at run time. It is not left to drift: `invitation-token.test.ts`
 * imports the published constant and asserts the two are equal, so a change on
 * either side is a red suite rather than two prefixes that disagree.
 */
export const INVITATION_TOKEN_PREFIX = "plt_inv_";

/**
 * 32 bytes, which is the extraction source's `generateOpaqueToken` exactly.
 *
 * Not a tuned number: it is 256 bits, the digest is SHA-256, and a token with
 * less entropy than its own digest would make the digest the cheaper thing to
 * attack.
 */
const TOKEN_BYTES = 32;

export function createInvitationTokenIssuer(): InvitationTokenIssuer {
  const digest = (token: string): TokenDigest =>
    asIdentifier<TokenDigest>(createHash("sha256").update(token, "utf8").digest("hex"));

  return {
    mint(): MintedInvitationToken {
      // `base64url`, so the token survives a URL and an email client without
      // being re-encoded. The PREFIX is outside the random part on purpose: it
      // is what `classifyToken` routes on, and a caller presenting an invitation
      // token where a session token belongs is refused by kind rather than by
      // failing to match any row.
      const token = `${INVITATION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
      return { token, digest: digest(token) };
    },

    // THE SAME FUNCTION `mint` USED, and it is the same closure rather than a
    // second call site, because the port's contract is precisely that these two
    // agree. A separately written digest that normalised, trimmed or lowercased
    // its input would make every issued invitation unacceptable and no test that
    // used one function for both halves would notice.
    digest,
  };
}
