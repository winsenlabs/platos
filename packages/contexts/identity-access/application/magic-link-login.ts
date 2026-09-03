// Passwordless operator login.
//
// Two use cases, one credential. `startMagicLinkLogin` mints and mails-out a
// single-use token; `completeMagicLinkLogin` spends it and returns a session.
//
// THE RATE LIMIT IS ON THE START, NOT THE COMPLETE. Minting is the unauthenticated,
// address-addressable half — the half somebody can point at any inbox in the
// world — so that is where the LOGIN budget is consumed. Completing needs the
// secret, which is its own proof of work.
//
// LOGIN IS REGISTRATION. `upsertByEmail` mints the User on first successful
// proof of an address. There is no separate sign-up, so there is no window in
// which an address is provably controlled but has no account, and no second code
// path that could create one under different rules.
//
// THE START PATH NEVER REVEALS WHETHER THE ADDRESS EXISTS. It returns the same
// shape for a known and an unknown address. Anything else turns the login form
// into a membership oracle for the whole installation.

import {
  consumed,
  issuedMagicLink,
  normalizeEmail,
  unauthenticated,
  type EmailAddress,
  type MagicLinkTokenRecord,
  type OperatorIdentityRecord,
  type RawToken,
  type UserId,
} from "../domain/index.js";
import { consumeRateLimit, type ConsumeRateLimitPorts } from "./consume-rate-limit.js";
import type { PortsOf } from "./dependencies.js";
import {
  issueOperatorSession,
  type IssuedOperatorSession,
  type IssueOperatorSessionPorts,
} from "./issue-operator-session.js";
import { asIdentifier, err, ok, type Result, type TenantScope } from "@platos/kernel";

export type StartMagicLinkLoginPorts = ConsumeRateLimitPorts &
  PortsOf<"repository" | "minter" | "hasher" | "clock">;

export interface StartMagicLinkLoginInput {
  readonly email: string;
  /** The bucket key for the LOGIN budget — typically the client address. */
  readonly rateLimitIdentifier: string;
  readonly scope: TenantScope;
  readonly expiresAt?: Date;
}

export interface StartedMagicLinkLogin {
  readonly token: RawToken;
  readonly email: EmailAddress;
  readonly expiresAt: Date;
}

export async function startMagicLinkLogin(
  ports: StartMagicLinkLoginPorts,
  input: StartMagicLinkLoginInput,
): Promise<Result<StartedMagicLinkLogin>> {
  const limited = await consumeRateLimit(ports, {
    action: "LOGIN",
    identifier: input.rateLimitIdentifier,
    scope: input.scope,
    principalId: null,
  });
  if (!limited.ok) return err(limited.error);

  const now = ports.clock.now();
  const email = normalizeEmail(input.email);
  const token = ports.minter.mint("magicLink");
  const link: MagicLinkTokenRecord = issuedMagicLink({
    tokenHash: ports.hasher.hash(token),
    email,
    now,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });

  await ports.repository.magicLinks.save(link);
  return ok({ token, email, expiresAt: link.expiresAt });
}

export type CompleteMagicLinkLoginPorts = IssueOperatorSessionPorts;

export interface CompleteMagicLinkLoginInput {
  readonly presentedToken: string;
}

export interface CompletedMagicLinkLogin {
  readonly userId: UserId;
  readonly session: IssuedOperatorSession;
}

/**
 * Spend a link and return a session.
 *
 * The consume is a CONDITIONAL write and its result is checked. Reading
 * `consumedAt === null` and then writing it would let two simultaneous clicks
 * both pass the read and both mint a session — one link, two credentials.
 */
export async function completeMagicLinkLogin(
  ports: CompleteMagicLinkLoginPorts,
  input: CompleteMagicLinkLoginInput,
): Promise<Result<CompletedMagicLinkLogin>> {
  const now = ports.clock.now();
  const tokenHash = ports.hasher.hash(input.presentedToken);
  const link = await ports.repository.magicLinks.findByTokenHash(tokenHash);
  if (link === null) return err(unauthenticated({ reason: "magic-link-unknown" }));

  const spendable = consumed(link, now);
  if (!spendable.ok) return err(spendable.error);
  if (!(await ports.repository.magicLinks.consume(tokenHash, now))) {
    return err(unauthenticated({ reason: "magic-link-race-lost" }));
  }

  const email = normalizeEmail(link.email);
  const user = await ports.repository.users.upsertByEmail(
    email,
    asIdentifier<UserId>(ports.ids.uuid()),
  );
  if (user.disabledAt !== null) return err(unauthenticated({ reason: "actor-disabled" }));

  // MAGIC_LINK identities key on the address itself: there is no external
  // provider to supply a stable subject, and the address IS what was proved.
  const identity: OperatorIdentityRecord = {
    userId: user.userId,
    provider: "MAGIC_LINK",
    subject: email,
    providerEmail: email,
  };
  await ports.repository.operatorIdentities.upsert(identity);

  const session = await issueOperatorSession(ports, { userId: user.userId });
  if (!session.ok) return err(session.error);
  return ok({ userId: user.userId, session: session.value });
}
