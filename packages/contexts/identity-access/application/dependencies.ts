// What a use case is handed.
//
// WIN-256's acceptance criterion is that a use case is INVOKABLE IN MEMORY, so
// every one of them takes its dependencies as an argument and reaches for no
// module-level state. There is no container, no decorator and no injection
// framework: ADR M0.3 §2 bans `@nestjs/*` from this layer outright, and the
// composition root in `apps/core-api` is where wiring belongs.
//
// The bundle is deliberately not one god-object per context. Each use case
// declares the SLICE it needs — `Pick<IdentityAccessPorts, "clock" | "hasher">`
// — so a signature tells a reader what the use case can reach, and a test
// supplies three fakes rather than eleven.

import type { Clock, IdGenerator, Logger, SafetyEventSink } from "@platos/kernel";
import type {
  IdentityAccessRepository,
  MagicLinkDelivery,
  MfaSecretCipher,
  RateLimiter,
  SecretHasher,
  TokenMinter,
  TotpCodeVerifier,
} from "./ports/index.js";

export interface IdentityAccessPorts {
  readonly repository: IdentityAccessRepository;
  readonly rateLimiter: RateLimiter;
  readonly hasher: SecretHasher;
  readonly minter: TokenMinter;
  readonly totp: TotpCodeVerifier;
  readonly cipher: MfaSecretCipher;
  /**
   * D20 — where a sign-in link is sent. OPTIONAL, AND THE ABSENCE IS AN ANSWER.
   *
   * Every other slot is required because nothing in this context works without
   * it. This one gates exactly one use case: an install with no email relay can
   * still authenticate sessions, mint bearers and rate-limit, and making the slot
   * required would have made the whole context uncomposable for want of SMTP.
   * `startMagicLinkLogin` refuses with `MAGIC_LINK_DELIVERY_UNAVAILABLE` when it is
   * absent, before a token exists, and `/readyz` reports the unbound binding.
   */
  readonly magicLinks?: MagicLinkDelivery;
  /** Kernel ports. Time and identity are inputs, never ambient. */
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * ADR M0.3 §3: the replacement for the deleted `auth -> monitoring` edge.
   * A denial is reported here; `governance` implements the sink.
   */
  readonly safety: SafetyEventSink;
  readonly logger: Logger;
}

/** The slice a use case declares. */
export type PortsOf<Keys extends keyof IdentityAccessPorts> = Pick<IdentityAccessPorts, Keys>;
