// THE ORACLE, READ AS SOURCE AND EXECUTED — not transcribed.
//
// WHY THIS FILE EXISTS. This repository has paid for the lesson that "an
// assertion comparing two things you control cannot fail". A suite that pinned
// this adapter's window boundary against a `60_000` written in the suite would
// be the module against itself: change both and it stays green. So every number
// and every operator the differential below compares against is LIFTED OUT OF
// THE EXTRACTION SOURCE'S OWN TEXT at run time and then EVALUATED, so the
// comparison is against code this tranche does not own and cannot edit.
//
// WHICH SOURCE, AND WHY IT IS THE RIGHT ONE.
// `internal-packages/tenancy-database/src/auth.ts` is the module the running
// system authenticates through, and `#consumeRateLimit` at the bottom of it is
// the authentication rate limiter this port was extracted from —
// `domain/rate-limit.ts` says so ("The extraction source's defaults, unchanged")
// and the schema's unique index `(action, identifierHash, windowStart)` is that
// function's `where` clause. Both files this module reads are byte-identical to
// `origin/main`, which is the frozen oracle; `git diff origin/main -- <path>` is
// empty for each, and a tranche that edited either would be editing the thing it
// is measured against.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not import the oracle. `auth.ts`
// carries a Prisma client and a whole authentication service, and an adapter
// package that imported it would acquire the ORM edge `tenancy-prisma-only`
// gives to exactly one directory, which is not this one. Reading four
// expressions and evaluating them is what gets the oracle's arithmetic without
// the oracle's dependencies.
//
// FALSIFIABLE IN BOTH DIRECTIONS. Change `>` to `>=` in `auth.ts` line 1035, or
// `60_000` in line 290, and the differential goes red. Delete or rename either
// expression and `readOracleRateLimiter()` throws rather than quietly returning
// a default — an extractor that fell back to a literal would be the vacuous
// assertion this file exists to avoid.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `internal-packages/tenancy-database/src/auth.ts`, relative to the root. */
export const ORACLE_PATH = "internal-packages/tenancy-database/src/auth.ts";

/** The context module whose header claims to have copied the oracle's defaults. */
export const EXTRACTION_PATH = "packages/contexts/identity-access/domain/rate-limit.ts";

/**
 * The repository root, found by walking up for the workspace manifest.
 *
 * Not `process.cwd()`: `pnpm --filter` runs a package's suite from the package
 * directory and a root `vitest` run does not, so a cwd-relative path would
 * resolve differently depending on how the suite was invoked — and the failure
 * would look like "the oracle changed".
 */
export function repositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"), "utf8");
      return directory;
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error("could not locate the repository root above " + import.meta.url);
}

function read(relative: string): string {
  return readFileSync(join(repositoryRoot(), relative), "utf8");
}

/** One capture, or a throw naming what was not found. Never a fallback. */
function capture(text: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error(`${what} is no longer present in ${ORACLE_PATH}; the differential cannot run`);
  }
  return match[1].trim();
}

/** Evaluate an expression lifted from the oracle, under named parameters. */
function evaluate<Signature>(expression: string, parameters: readonly string[]): Signature {
  // eslint-disable-next-line no-new-func -- the whole point: the ORACLE's text runs.
  return new Function(...parameters, `return (${expression});`) as Signature;
}

export interface OracleLimit {
  readonly requests: number;
  readonly windowMs: number;
}

export interface OracleRateLimiter {
  /** The oracle's own `Math.floor(now / windowMs) * windowMs`. */
  windowStartMs(now: Date, limit: OracleLimit): number;
  /** The oracle's own `windowStartMs + limit.windowMs`. */
  expiresAtMs(windowStartMs: number, limit: OracleLimit): number;
  /** The oracle's own `bucket.requestCount > limit.requests`. */
  isRefused(bucket: { readonly requestCount: number }, limit: OracleLimit): boolean;
  /** The three defaults `PlatosAuthService`'s constructor falls back to. */
  readonly defaults: {
    readonly LOGIN: OracleLimit;
    readonly INVITE_ACCEPT: OracleLimit;
    readonly MFA_VERIFY: OracleLimit;
  };
  /** The literal text each piece came from, for a failure message worth reading. */
  readonly evidence: Readonly<Record<string, string>>;
}

export function readOracleRateLimiter(): OracleRateLimiter {
  const text = read(ORACLE_PATH);

  const windowStart = capture(
    text,
    /const windowStartMs\s*=\s*([^;]+);/u,
    "the window-start expression",
  );
  const expiresAt = capture(
    text,
    /const expiresAt\s*=\s*new Date\(([^)]+)\);/u,
    "the window-expiry expression",
  );
  const refusal = capture(
    text,
    /if \((bucket\.requestCount\s*\S+\s*limit\.requests)\)/u,
    "the limit comparison",
  );
  const login = capture(
    text,
    /options\.loginRateLimit\s*\?\?\s*(\{[^}]*\})/u,
    "the LOGIN default",
  );
  const invite = capture(
    text,
    /options\.inviteAcceptRateLimit\s*\?\?\s*(\{[^}]*\})/u,
    "the INVITE_ACCEPT default",
  );
  const mfa = capture(
    text,
    /options\.mfaVerifyRateLimit\s*\?\?\s*(\{[^}]*\})/u,
    "the MFA_VERIFY default",
  );

  const asLimit = (source: string): OracleLimit => evaluate<() => OracleLimit>(source, [])();

  return {
    windowStartMs: evaluate(windowStart, ["now", "limit"]),
    expiresAtMs: evaluate(expiresAt, ["windowStartMs", "limit"]),
    isRefused: evaluate(refusal, ["bucket", "limit"]),
    defaults: {
      LOGIN: asLimit(login),
      INVITE_ACCEPT: asLimit(invite),
      MFA_VERIFY: asLimit(mfa),
    },
    evidence: Object.freeze({ windowStart, expiresAt, refusal, login, invite, mfa }),
  };
}

/**
 * The same three defaults, lifted from the CONTEXT's own text.
 *
 * A source-against-source comparison, and its limits are worth stating: it
 * proves the extraction's LITERALS still equal the oracle's, which is exactly
 * the claim `domain/rate-limit.ts` makes in its header and nothing more. It
 * says nothing about this adapter — the policy arrives on the consumption — and
 * it is here rather than in the context's own suite because a context test
 * reading files off disk would be the first of its kind in the tree.
 */
export function readExtractionDefaults(): Record<string, OracleLimit> {
  const text = read(EXTRACTION_PATH);
  const entries: [string, OracleLimit][] = [];
  for (const name of ["LOGIN", "INVITE_ACCEPT", "MFA_VERIFY"]) {
    const source = capture(
      text,
      new RegExp(`DEFAULT_${name}_POLICY: RateLimitPolicy\\s*=\\s*(\\{[^}]*\\})`, "u"),
      `the extraction's DEFAULT_${name}_POLICY`,
    );
    entries.push([name, evaluate<() => OracleLimit>(source, [])()]);
  }
  return Object.fromEntries(entries);
}
