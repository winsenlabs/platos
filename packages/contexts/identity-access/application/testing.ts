// Deterministic fakes for every port, and the bundle a use case takes.
//
// EVERY FAKE HERE IS DELIBERATELY UNFIT FOR PRODUCTION and obviously so at a
// glance: the hasher prepends a string, the minter counts, the cipher wraps. A
// test fake that LOOKED like real cryptography would eventually be copied into
// somewhere it must not be. These cannot be.
//
// What they do preserve is the property the code under test depends on: the
// hasher is deterministic and injective, so two different secrets never collide
// and the same secret always finds its row; the minter is unique per call, so
// two sessions never share a token; the TOTP fake produces a different code per
// counter, so the replay test is testing replay and not a constant.
//
// TIME AND IDENTITY ARE PINNED. `fixedClock` starts at `T0` and only moves when
// a test moves it. That is what lets "a session expired" be a one-line
// arrangement instead of a wait.

import { T0 } from "../domain/testing.js";
import {
  DEFAULT_POLICIES,
  identityStoreUnavailable,
  prefixOf,
  recordRequest,
  type RateLimitBucket,
  type RawToken,
  type TokenHash,
  type TokenKind,
} from "../domain/index.js";
import type { IdentityAccessPorts } from "./dependencies.js";
import {
  inMemoryIdentityAccessRepository,
  type InMemoryIdentityAccessRepository,
  type InMemoryState,
} from "./in-memory-repository.js";
import type { RateLimitConsumption, RateLimiter, SecretHasher } from "./ports/index.js";
import type { MfaSecretCipher, TokenMinter, TotpCodeVerifier } from "./ports/index.js";
import {
  asIdentifier,
  err,
  ok,
  type Clock,
  type IdGenerator,
  type Logger,
  type SafetyEventSink,
  type SafetyObservation,
  type Ulid,
  type Uuid,
} from "@platos/kernel";

export interface MutableClock extends Clock {
  set(instant: Date): void;
  advance(milliseconds: number): void;
}

export function fixedClock(start: Date = T0): MutableClock {
  let current = start;
  return {
    now: () => current,
    set: (instant) => {
      current = instant;
    },
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

export function sequentialIdGenerator(prefix = "id"): IdGenerator {
  let counter = 0;
  const next = (): string => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
  return {
    uuid: () => asIdentifier<Uuid>(next()),
    ulid: () => asIdentifier<Ulid>(next()),
  };
}

/**
 * Deterministic, injective, and unmistakably not a digest.
 *
 * `equals` still checks length before comparing, mirroring the requirement on
 * the real implementation — the constant-time primitive throws on unequal
 * lengths, so an implementation that forgets turns a mismatch into an exception.
 */
export function fakeSecretHasher(): SecretHasher {
  return {
    hash: (secret: RawToken | string) => asIdentifier<TokenHash>(`digest(${secret})`),
    equals: (left, right) => left.length === right.length && left === right,
    deriveCodeChallenge: (codeVerifier) => `challenge(${codeVerifier})`,
  };
}

export function fakeTokenMinter(): TokenMinter {
  let counter = 0;
  return {
    mint: (kind: TokenKind) => {
      counter += 1;
      return `${prefixOf(kind)}${counter}` as RawToken;
    },
    mintTotpSecret: () => "JBSWY3DPEHPK3PXP",
    mintRecoveryCodes: (count) =>
      Array.from({ length: count }, (_unused, index) => `CODE${index + 1}`),
  };
}

/**
 * Codes are `secret`-and-counter dependent, so a replayed code yields the SAME
 * counter and a fresh one yields a different counter. Nothing else about RFC
 * 6238 is simulated, because nothing else is what the replay rule depends on.
 */
export function fakeTotpCodeVerifier(): TotpCodeVerifier {
  const generate = (secret: string, counter: bigint): string =>
    String((Number(counter % 1000000n) + secret.length) % 1000000).padStart(6, "0");
  return {
    generate,
    verify: ({ secret, code, candidateCounters }) => {
      for (const counter of candidateCounters) {
        if (generate(secret, counter) === code) return counter;
      }
      return null;
    },
  };
}

export function fakeMfaSecretCipher(): MfaSecretCipher {
  const SEAL = "sealed:";
  return {
    seal: (plaintext) => `${SEAL}${plaintext}`,
    open: (sealed) => {
      if (!sealed.startsWith(SEAL)) throw new TypeError("envelope is not authentic");
      return sealed.slice(SEAL.length);
    },
  };
}

export interface FakeRateLimiter extends RateLimiter {
  /** Make every subsequent call report the limiter as unreachable. */
  breakLimiter(): void;
  readonly buckets: Map<string, RateLimitBucket>;
}

/** Real fixed-window arithmetic over a Map, plus a switch to simulate an outage. */
export function fakeRateLimiter(): FakeRateLimiter {
  const buckets = new Map<string, RateLimitBucket>();
  let broken = false;
  return {
    buckets,
    breakLimiter: () => {
      broken = true;
    },
    async consume(consumption: RateLimitConsumption) {
      if (broken) return err(identityStoreUnavailable());
      const key = `${consumption.action}:${consumption.identifierHash}`;
      const bucket = recordRequest(
        buckets.get(key) ?? null,
        consumption.action,
        consumption.identifierHash,
        consumption.at,
        consumption.policy,
      );
      buckets.set(key, bucket);
      return ok(bucket);
    },
  };
}

export interface RecordingSafetySink extends SafetyEventSink {
  readonly observations: SafetyObservation[];
}

export function recordingSafetySink(): RecordingSafetySink {
  const observations: SafetyObservation[] = [];
  return {
    observations,
    async record(observation) {
      observations.push(observation);
    },
  };
}

export function silentLogger(): Logger {
  const logger: Logger = {
    log: () => undefined,
    child: () => logger,
  };
  return logger;
}

export interface TestPorts extends IdentityAccessPorts {
  readonly repository: InMemoryIdentityAccessRepository;
  readonly rateLimiter: FakeRateLimiter;
  readonly clock: MutableClock;
  readonly safety: RecordingSafetySink;
}

/** One line of arrangement for a use case: seed the state, get the ports. */
export function testPorts(seed: Partial<InMemoryState> = {}): TestPorts {
  return {
    repository: inMemoryIdentityAccessRepository(seed),
    rateLimiter: fakeRateLimiter(),
    hasher: fakeSecretHasher(),
    minter: fakeTokenMinter(),
    totp: fakeTotpCodeVerifier(),
    cipher: fakeMfaSecretCipher(),
    clock: fixedClock(),
    ids: sequentialIdGenerator(),
    safety: recordingSafetySink(),
    logger: silentLogger(),
  };
}

export { DEFAULT_POLICIES };
