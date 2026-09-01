// `InvitationTokenIssuer` — the invitation secret, kept out of the domain.
//
// `OrganizationInvitation.tokenHash` is `@unique` and carries a CHECK
// constraint `~ '^[0-9a-f]{64}$'`, so it is a hex SHA-256 digest and the raw
// token is never stored. Minting and digesting are cryptography and randomness:
// neither belongs in a pure layer, and neither is reproducible without a port.
//
// The raw token crosses this boundary exactly once, on issue, and is returned
// to the caller so it can be emailed. It is never persisted, never logged, and
// never re-derivable from the row: a lost invitation is re-issued, not
// recovered. Everything after issue works from the digest alone.

import type { TokenDigest } from "../../domain/index.js";

export interface MintedInvitationToken {
  /** The secret handed to the invitee. Not stored anywhere. */
  readonly token: string;
  /** What the row holds. */
  readonly digest: TokenDigest;
}

export interface InvitationTokenIssuer {
  mint(): MintedInvitationToken;

  /**
   * Digest a token presented on acceptance, so a lookup is by digest and the
   * raw value never reaches a query log. Must be the same function `mint` used.
   */
  digest(token: string): TokenDigest;
}
