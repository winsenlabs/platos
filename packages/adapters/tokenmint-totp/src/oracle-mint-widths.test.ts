// Every width in `MINTED_TOKEN_BYTES`, re-derived from the code that mints
// tokens in production, and compared against it.
//
// WHY THIS SUITE READS FILES RATHER THAN IMPORTING THEM. The same reason
// `packages/adapters/postgres-tenancy/src/json-columns.test.ts` does: a table
// that imported the thing it describes would be describing whatever that thing
// happens to export, and the five modules below export none of these numbers —
// they are arguments at call sites inside private methods. The join has to be
// against the TEXT on disk, and the text on disk is byte-identical between `v1`
// and `origin/main`, which is what makes it the oracle rather than a copy of it.
//
// WHY A WIDTH IS WORTH A SUITE THIS SIZE. A token minted one byte narrower than
// production is a silent loss of eight bits of entropy that NOTHING downstream
// can notice: the stored artefact is a SHA-256 hash, and a hash of a 31-byte
// secret is indistinguishable from a hash of a 32-byte one. There is no failing
// request, no log line and no migration — just a credential that is 256 times
// easier to guess. The only place that can be caught is here, against the
// numbers the running system actually uses.
//
// IT IS NOT A COMPARISON OF THIS MODULE WITH ITSELF, which is the mistake this
// programme has paid for more than once. The left-hand side is parsed out of
// five files this tranche does not edit and cannot edit; the right-hand side is
// `token-minter.ts`. Change one and the other does not move.
//
// THE EXTRACTOR IS ITSELF CHECKED, because a regex that silently matched nothing
// would make every comparison below vacuous. `the extraction finds every mint
// site` pins the SITE COUNT and `covers every prefix in the domain registry`
// pins the prefix set against `TOKEN_PREFIXES`, so a broken pattern fails loudly
// instead of passing quietly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { TokenKind } from "@platos/context-identity-access/application/ports/index.js";
import { prefixOf, TOKEN_KINDS } from "@platos/context-identity-access/application/ports/index.js";

import { MINTED_TOKEN_BYTES, RECOVERY_CODE_BYTES, TOTP_SECRET_BYTES } from "./token-minter.js";

const repositoryRoot = resolve(process.cwd(), "../../..");

const AUTH = "internal-packages/tenancy-database/src/auth.ts";
const OAUTH = "apps/agent/src/oauth/oauth.service.ts";
const MCP_TOKEN = "apps/agent/src/mcp-platform/token.service.ts";
const MCP_BEARER = "apps/agent/src/mcp-platform/mcp-bearer-token.service.ts";
const ORGANIZATION = "apps/agent/src/admin/organization.service.ts";

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

/** One place the extraction source mints a prefixed opaque token. */
interface MintSite {
  readonly file: string;
  readonly prefix: string;
  readonly bytes: number;
}

/** `const SESSION_PREFIX = "plt_os_";` — every prefix constant in one file. */
function prefixConstants(source: string): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*"(plt_[a-z]+_)";/gu)) {
    constants.set(match[1] as string, match[2] as string);
  }
  return constants;
}

/**
 * The randomness expression, wherever it appears: `randomBytes(N)` or
 * `crypto.randomBytes(N)`, rendered `base64url`.
 *
 * `NAME` is the token that supplies the prefix — a constant's name, an inline
 * `plt_` literal, or a function parameter.
 */
const MINT_TEMPLATE = /`(?:\$\{(\w+)\}|(plt_[a-z]+_))\$\{(?:crypto\.)?randomBytes\((\w+)\)\.toString\("base64url"\)\}`/gu;

/**
 * `internal-packages/tenancy-database/src/auth.ts` — the operator session, the
 * magic link and the invitation.
 *
 * All three go through ONE helper, so the width is read once from the helper and
 * the prefixes are read from the three call sites. The helper is reached because
 * it is the DEFAULT of an injectable generator (`options.tokenGenerator ??
 * generateOpaqueToken`), and that fallback is asserted rather than assumed: if a
 * future edit made the generator required, these three widths would be whatever
 * the caller supplied and this file's claim about them would be false.
 */
function authSites(): readonly MintSite[] {
  const source = read(AUTH);
  const constants = prefixConstants(source);
  // THESE THROW RATHER THAN ASSERT, because they run while the module is being
  // imported and there is no case in scope yet. A throw at collection time is a
  // hard failure of the whole file, which is the right severity: if the oracle
  // can no longer be read, nothing below it means anything.
  if (!source.includes("options.tokenGenerator ?? generateOpaqueToken")) {
    throw new Error(`${AUTH}: generateOpaqueToken is no longer the generator's default`);
  }
  const helper = /function generateOpaqueToken\(prefix: string\): string \{\s*return\s*`\$\{prefix\}\$\{randomBytes\((\d+)\)\.toString\("base64url"\)\}`;/u.exec(
    source,
  );
  if (helper === null) throw new Error(`${AUTH}: generateOpaqueToken no longer mints a base64url token`);
  const bytes = Number(helper[1]);
  const sites: MintSite[] = [];
  for (const call of source.matchAll(/this\.#tokenGenerator\((\w+)\)/gu)) {
    const prefix = constants.get(call[1] as string);
    if (prefix === undefined) throw new Error(`${AUTH}: ${String(call[1])} is not a plt_ prefix constant`);
    sites.push({ file: AUTH, prefix, bytes });
  }
  return sites;
}

/**
 * `apps/agent/src/oauth/oauth.service.ts` — the six OAuth prefixes.
 *
 * `randomId(prefix, bytes = 32)` has a DEFAULT, so a call that omits the second
 * argument still has a width; it is read from the signature rather than written
 * down here. `oauthClientId` is the reason this matters: it is the one call site
 * that passes something other than the default.
 */
function oauthSites(): readonly MintSite[] {
  const source = read(OAUTH);
  const constants = prefixConstants(source);
  const signature = /private randomId\(prefix: string, bytes = (\d+)\): string \{/u.exec(source);
  if (signature === null) throw new Error(`${OAUTH}: randomId no longer carries a default width`);
  const fallback = Number(signature[1]);
  const sites: MintSite[] = [];
  for (const call of source.matchAll(/this\.randomId\((\w+)(?:,\s*(\d+))?\)/gu)) {
    const prefix = constants.get(call[1] as string);
    if (prefix === undefined) throw new Error(`${OAUTH}: ${String(call[1])} is not a plt_ prefix constant`);
    sites.push({
      file: OAUTH,
      prefix,
      bytes: call[2] === undefined ? fallback : Number(call[2]),
    });
  }
  return sites;
}

/** A file that mints inline, with either a constant or a literal prefix. */
function inlineSites(path: string): readonly MintSite[] {
  const source = read(path);
  const constants = prefixConstants(source);
  const sites: MintSite[] = [];
  for (const match of source.matchAll(MINT_TEMPLATE)) {
    const [, name, literal, width] = match;
    // The helper form (`${prefix}`) belongs to `authSites`/`oauthSites`; an
    // inline site names a constant or writes the prefix out.
    const prefix = literal ?? (name === undefined ? undefined : constants.get(name));
    if (prefix === undefined) continue;
    if (width === undefined || !/^\d+$/u.test(width)) {
      throw new Error(`${path}: an inline mint of ${prefix} has no literal width`);
    }
    sites.push({ file: path, prefix, bytes: Number(width) });
  }
  return sites;
}

const SITES: readonly MintSite[] = [
  ...authSites(),
  ...oauthSites(),
  ...inlineSites(MCP_TOKEN),
  ...inlineSites(MCP_BEARER),
  ...inlineSites(ORGANIZATION),
];

/** `plt_os_` -> every width the extraction source mints it at. */
const ORACLE_WIDTHS = ((): ReadonlyMap<string, ReadonlySet<number>> => {
  const widths = new Map<string, Set<number>>();
  for (const site of SITES) {
    const existing = widths.get(site.prefix) ?? new Set<number>();
    existing.add(site.bytes);
    widths.set(site.prefix, existing);
  }
  return widths;
})();

describe("the extraction is not vacuous", () => {
  it("finds every mint site across the five extraction-source files", () => {
    // THIRTEEN, and the number is the control on the patterns above rather than a
    // fact about this adapter: three `#tokenGenerator` calls in auth.ts, seven
    // `randomId` calls in oauth.service.ts, and one inline template in each of
    // the three remaining files. A regex that stopped matching would drop below
    // it; a new mint site in the extraction source would push above it, and
    // either is a thing a reader must look at.
    expect(SITES).toHaveLength(13);
  });

  it("covers every prefix in the domain registry, and invents none", () => {
    const registry = new Set(TOKEN_KINDS.map((kind) => prefixOf(kind)));
    expect(new Set(ORACLE_WIDTHS.keys())).toEqual(registry);
    expect(registry.size).toBe(11);
  });

  it("reads more than one width, so the comparison can distinguish them", () => {
    // A POSITIVE CONTROL FOR THE WHOLE FILE. If the extractor collapsed every
    // width to one number, every case below would still pass while proving
    // nothing. Three distinct widths is what says it is reading real arguments.
    const distinct = new Set(SITES.map((site) => site.bytes));
    expect([...distinct].sort((left, right) => left - right)).toEqual([16, 32, 48]);
  });

  it("never mints one prefix at two different widths", () => {
    // `plt_inv_` and `plt_ocs_` are each minted at TWO sites. If those sites
    // disagreed, "the oracle's width" would not be a well-defined thing and every
    // comparison below would be picking one arbitrarily.
    for (const [prefix, widths] of ORACLE_WIDTHS) {
      expect(widths.size, `${prefix} is minted at ${widths.size} different widths`).toBe(1);
    }
  });
});

describe("MINTED_TOKEN_BYTES equals the extraction source, kind by kind", () => {
  it.each([
    { kind: "operatorSession" as const },
    { kind: "magicLink" as const },
    { kind: "invitation" as const },
    { kind: "oauthAccessToken" as const },
    { kind: "oauthRefreshToken" as const },
    { kind: "oauthClientId" as const },
    { kind: "oauthClientSecret" as const },
    { kind: "oauthAuthorizationCode" as const },
    { kind: "oauthConsentTransaction" as const },
    { kind: "mcpToken" as const },
    { kind: "entityBearerToken" as const },
  ])("mints $kind at the width production mints it at", ({ kind }) => {
    const widths = ORACLE_WIDTHS.get(prefixOf(kind));
    expect(widths, `${kind} has no mint site in the extraction source`).toBeDefined();
    expect([...(widths as ReadonlySet<number>)]).toEqual([MINTED_TOKEN_BYTES[kind]]);
  });

  it("names every kind the domain registry declares, and no other", () => {
    // The literal list above cannot go stale: it is compared against the
    // registry, so a twelfth kind fails here rather than being minted at an
    // unpinned width.
    expect(Object.keys(MINTED_TOKEN_BYTES).sort()).toEqual([...TOKEN_KINDS].sort());
  });

  it("keeps the two kinds that are not thirty-two bytes", () => {
    // THE CASE THAT REFUSES THE TEMPTING SIMPLIFICATION. Nine of eleven kinds are
    // 32 bytes and a reader will eventually propose one constant. These two say
    // what that would cost: sixteen bytes invented for a client id, and sixteen
    // bytes of entropy DELETED from every entity bearer token.
    expect(MINTED_TOKEN_BYTES.oauthClientId).toBe(16);
    expect(MINTED_TOKEN_BYTES.entityBearerToken).toBe(48);
  });
});

describe("the two widths that are not token widths", () => {
  it("mints a TOTP secret at the extraction source's twenty bytes", () => {
    const source = read(AUTH);
    const match = /const secretBytes = randomBytes\((\d+)\);/u.exec(source);
    expect(match, "beginTotpEnrollment must still draw its secret here").not.toBeNull();
    expect(Number((match as RegExpExecArray)[1])).toBe(TOTP_SECRET_BYTES);
  });

  it("mints a recovery code at the extraction source's ten bytes", () => {
    const source = read(AUTH);
    const match = /formatRecoveryCode\(randomBytes\((\d+)\)\)/u.exec(source);
    expect(match, "confirmTotpEnrollment must still draw its codes here").not.toBeNull();
    expect(Number((match as RegExpExecArray)[1])).toBe(RECOVERY_CODE_BYTES);
  });

  it("mints as many recovery codes per enrolment as the extraction source does", () => {
    // The COUNT is the domain's `RECOVERY_CODE_COUNT` and the caller's argument,
    // not this adapter's, so what is checked here is that the domain and the
    // extraction source still agree on nine.
    const source = read(AUTH);
    expect(source).toContain("const RECOVERY_CODE_COUNT = 9;");
  });
});

/** Guards the cast in the kind list above against a registry rename. */
const _kindsAreExhaustive: readonly TokenKind[] = TOKEN_KINDS;
void _kindsAreExhaustive;
