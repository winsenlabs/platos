// The token-prefix registry.
//
// Every bearer secret this context mints is opaque and self-identifying: a
// fixed prefix names what kind of credential it is, and the remainder is
// randomness. The prefix is what lets one verification entry point route a
// presented string to the right table without a probe of every token store.
//
// THE CODE IS THE ORACLE, NOT THE ADR. ADR M0.4 spells the MCP token prefix
// `pk_mcp_`. Every minting and verifying call site in the extraction source
// spells it `plt_mcp_`, and rows already exist under that prefix, so `plt_mcp_`
// is what is recorded here. Changing it is a data migration, not an edit.
//
// The registry is exhaustive by construction: `TOKEN_KINDS` is derived from the
// map, so adding a prefix without classifying it is not expressible.

import { invalidGrant } from "./errors.js";
import type { RawToken } from "./principal.js";
import { err, ok, type Result } from "@platos/kernel";

export const TOKEN_PREFIXES = {
  /** OperatorSession.tokenHash — the dashboard session cookie value. */
  operatorSession: "plt_os_",
  /** MagicLinkToken.tokenHash — single-use, 15 minutes. */
  magicLink: "plt_ml_",
  /** OrganizationInvitation.tokenHash — single-use, 7 days. */
  invitation: "plt_inv_",
  /** OAuthAccessToken.tokenHash. */
  oauthAccessToken: "plt_oa_",
  /** OAuthRefreshToken.tokenHash. */
  oauthRefreshToken: "plt_or_",
  /** OAuthClient.clientId — public, not a secret. */
  oauthClientId: "plt_oac_",
  /** OAuthClient.clientSecretHash. */
  oauthClientSecret: "plt_ocs_",
  /** OAuthAuthorizationCode.codeHash — single-use, 60 seconds. */
  oauthAuthorizationCode: "plt_ocd_",
  /** OAuthConsentTransaction.tokenHash — single-use, 600 seconds. */
  oauthConsentTransaction: "plt_octx_",
  /** McpToken.tokenHash. */
  mcpToken: "plt_mcp_",
  /** McpBearerToken.tokenHash — an entity-scoped bearer credential. */
  entityBearerToken: "plt_ent_",
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

export const TOKEN_KINDS = Object.keys(TOKEN_PREFIXES) as readonly TokenKind[];

export function prefixOf(kind: TokenKind): string {
  return TOKEN_PREFIXES[kind];
}

export function hasPrefix(raw: string, kind: TokenKind): boolean {
  return raw.startsWith(TOKEN_PREFIXES[kind]);
}

/**
 * Which kind of credential a presented string claims to be, or null.
 *
 * This is a routing hint and NOT authentication: it reads only the public
 * prefix. Nothing may be decided on the strength of it beyond which store to
 * ask. `noPrefixIsAmbiguous()` proves the map admits at most one answer.
 */
export function classifyToken(raw: string): TokenKind | null {
  for (const kind of TOKEN_KINDS) {
    if (raw.startsWith(TOKEN_PREFIXES[kind])) return kind;
  }
  return null;
}

/**
 * True when no prefix in the registry is a prefix of another.
 *
 * If one ever were, `classifyToken` would route by declaration order and a token
 * of one kind would be verified against another kind's store. The invariant is
 * asserted in the test suite rather than assumed.
 */
export function noPrefixIsAmbiguous(): boolean {
  for (const outer of TOKEN_KINDS) {
    for (const inner of TOKEN_KINDS) {
      if (outer === inner) continue;
      if (TOKEN_PREFIXES[inner].startsWith(TOKEN_PREFIXES[outer])) return false;
    }
  }
  return true;
}

/** Reject a presented string that does not even claim to be `kind`. */
export function requirePrefix(raw: string, kind: TokenKind): Result<RawToken> {
  if (!hasPrefix(raw, kind)) return err(invalidGrant("token is not of the expected kind"));
  return ok(raw as RawToken);
}
