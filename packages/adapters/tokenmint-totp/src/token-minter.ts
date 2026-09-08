// TokenMinter — the cryptographic randomness behind every secret this platform
// issues, at the widths the extraction source already issues them at.
//
// THE FORM IS THE ORACLE'S, NOT A CHOICE MADE HERE.
// `<prefix><randomBytes(n).toString("base64url")>` is what
// `apps/agent/src/oauth/oauth.service.ts:137` writes, what
// `internal-packages/tenancy-database/src/auth.ts:1117` writes, and what the two
// `apps/agent/src/mcp-platform/*` services write. All four are unedited by this
// tranche and all four are read back by `oracle-mint-widths.test.ts`, so this
// module's table cannot drift from them in silence.
//
// WHY THE WIDTH IS PER KIND AND NOT ONE CONSTANT. It is tempting to read the
// oracle as "32 bytes everywhere" — nine of the eleven kinds are — and that
// reading loses real entropy on one kind and invents it on another:
// `entityBearerToken` is minted at FORTY-EIGHT bytes and `oauthClientId` at
// SIXTEEN. A token minted narrower than production is a silent downgrade no
// downstream check can see, because a short token verifies exactly as well as a
// long one. So the widths are a table, the table is per kind, and the test that
// pins it reads the ORACLE's numbers rather than this file's.
//
// NO WIDTH HERE IS A MIGRATION. A stored credential is a SHA-256 hash of the raw
// string, and a hash does not care how many bytes went into it, so changing the
// width of a newly minted token cannot invalidate an issued one. The prefix is
// the part that IS load-bearing across the boundary — `classifyToken` routes a
// presented string by it — and the prefixes come from the domain registry
// (`domain/token.ts`), which records that it, and not the ADR, is the oracle.

import { randomBytes } from "node:crypto";

import type {
  RawToken,
  TokenKind,
  TokenMinter,
} from "@platos/context-identity-access/application/ports/index.js";
import { prefixOf } from "@platos/context-identity-access/application/ports/index.js";

import { encodeBase32 } from "./base32.js";

/**
 * How many random bytes each kind carries, from the extraction source.
 *
 * Each entry names the call site it was read from. `oracle-mint-widths.test.ts`
 * re-derives every one of them from those files' bytes and fails on a
 * disagreement, so these comments are checked rather than trusted.
 */
export const MINTED_TOKEN_BYTES: Readonly<Record<TokenKind, number>> = Object.freeze({
  /** tenancy-database `auth.ts:994` -> `generateOpaqueToken` (`:1117`). */
  operatorSession: 32,
  /** tenancy-database `auth.ts:501` -> `generateOpaqueToken` (`:1117`). */
  magicLink: 32,
  /** tenancy-database `auth.ts:796`, and `admin/organization.service.ts:224`. */
  invitation: 32,
  /** `oauth/oauth.service.ts:902` -> `randomId(prefix, 32)` (`:136`). */
  oauthAccessToken: 32,
  /** `oauth/oauth.service.ts:903`. */
  oauthRefreshToken: 32,
  /**
   * `oauth/oauth.service.ts:332` — SIXTEEN, and the only kind below 32.
   *
   * It is the one value in this table that is NOT a secret: `OAuthClient.clientId`
   * is public by RFC 6749 §2.2 and is stored in the clear, so its width buys
   * unguessability of an identifier rather than resistance to an offline search.
   * It is pinned at the oracle's number anyway, because a client id minted wider
   * here than in production is still a difference between two systems that must
   * agree on what a client id looks like.
   */
  oauthClientId: 16,
  /** `oauth/oauth.service.ts:334` and `:700`. */
  oauthClientSecret: 32,
  /** `oauth/oauth.service.ts:769`. */
  oauthAuthorizationCode: 32,
  /** `oauth/oauth.service.ts:448`. */
  oauthConsentTransaction: 32,
  /** `mcp-platform/token.service.ts:151`. */
  mcpToken: 32,
  /** `mcp-platform/mcp-bearer-token.service.ts:102` — FORTY-EIGHT. */
  entityBearerToken: 48,
});

/**
 * The TOTP shared secret's width, from `auth.ts:584` (`randomBytes(20)`).
 *
 * Twenty bytes is RFC 4226 §4 R6's recommendation and the SHA-1 block-size
 * argument the port's own comment repeats. It is 160 bits, which is 32 base32
 * characters with no padding.
 */
export const TOTP_SECRET_BYTES = 20;

/**
 * A recovery code's width, from `auth.ts:630` (`formatRecoveryCode(randomBytes(10))`).
 *
 * Ten bytes rendered as upper-case hex is twenty characters, which is what the
 * oracle's four groups of five consume exactly.
 */
export const RECOVERY_CODE_BYTES = 10;

/** The group size the display form uses, from `auth.ts:1125`. */
const RECOVERY_CODE_GROUP = 5;

function hexUpper(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

/**
 * `A1B2C-D3E4F-...` — the form the extraction source shows a human.
 *
 * The separators are cosmetic and the domain's `normalizeRecoveryCode` strips
 * them before hashing, which is exactly why they may be here: what is stored is
 * the stripped upper-case hex, so the grouping can change without invalidating an
 * issued code. It is the oracle's grouping because a code a human copied out of
 * the old system and retypes into this one must look like the same thing.
 */
function formatRecoveryCode(bytes: Uint8Array): string {
  const value = hexUpper(bytes);
  const groups: string[] = [];
  for (let start = 0; start < value.length; start += RECOVERY_CODE_GROUP) {
    groups.push(value.slice(start, start + RECOVERY_CODE_GROUP));
  }
  return groups.join("-");
}

/** The error a caller sees when it asks for a batch that is not a batch. */
export class RecoveryCodeCountError extends RangeError {
  constructor(count: number) {
    super(`recovery code count must be a positive integer, received ${String(count)}`);
    this.name = "RecoveryCodeCountError";
  }
}

/**
 * The real minter. `node:crypto`'s CSPRNG and nothing else.
 *
 * NO SEED, NO INJECTION POINT, NO TEST HOOK. `testing.ts` already publishes a
 * deterministic `fakeTokenMinter` for the use-case suites, so a seam here would
 * buy nothing and would be a way to reach a predictable generator in production —
 * which is the single failure the port's header says no downstream check
 * compensates for.
 */
export function createTokenMinter(): TokenMinter {
  return {
    mint(kind: TokenKind): RawToken {
      return `${prefixOf(kind)}${randomBytes(MINTED_TOKEN_BYTES[kind]).toString("base64url")}` as RawToken;
    },

    mintTotpSecret(): string {
      return encodeBase32(randomBytes(TOTP_SECRET_BYTES));
    },

    mintRecoveryCodes(count: number): readonly string[] {
      // A NON-COUNT IS REFUSED RATHER THAN ROUNDED. `Array.from({ length: -1 })`
      // is `[]` and `Array.from({ length: 2.5 })` is two entries, so a caller
      // that computed its count wrongly would get a SHORTER batch of recovery
      // codes than it displayed to the human and no error anywhere. There is no
      // upper bound because the oracle states none; the domain's
      // `RECOVERY_CODE_COUNT` is the only caller and it is nine.
      if (!Number.isSafeInteger(count) || count < 1) throw new RecoveryCodeCountError(count);
      return Object.freeze(
        Array.from({ length: count }, () => formatRecoveryCode(randomBytes(RECOVERY_CODE_BYTES))),
      );
    },
  };
}
