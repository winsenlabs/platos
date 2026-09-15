// `MagicLinkDelivery` — how a sign-in link leaves this context.
//
// D20 (2026-09-15): "core-api sends it through the notifier-email adapter. A
// login-capable token is never returned to the BFF." This port is how that
// sentence is made structural rather than a promise a transport keeps. The raw
// magic-link token is minted in `startMagicLinkLogin`, handed to THIS port, and
// returned to nobody: the published contract method answers with the address and
// the expiry, so there is no response a route could put the token in.
//
// THE ADAPTER OWNS THE LINK'S SHAPE AND THE MESSAGE, NOT THE TOKEN'S. Which page
// the link opens is install configuration (the relay adapter is told it), and the
// body of an email is a rendering decision. What the token IS, how long it lives
// and whether it may be spent twice are decided here and nowhere else.
//
// FAILURE IS A VALUE. A relay that is unreachable or refuses the message answers
// `err`; the use case turns that into `MAGIC_LINK_DELIVERY_FAILED` so a caller
// branches on one identity-access code while the adapter's own code survives in
// `details` for the operator.

import type { Result } from "@platos/kernel";

import type { EmailAddress, RawToken } from "../../domain/index.js";

export interface MagicLinkMessage {
  /** Normalized. The address the link was asked for, and the only recipient. */
  readonly email: EmailAddress;
  /** The single-use secret. Put into the link and into nothing else. */
  readonly token: RawToken;
  readonly expiresAt: Date;
}

export interface MagicLinkDelivery {
  /**
   * Deliver one sign-in link. Resolves `ok` only once the relay ACCEPTED the
   * message; a caller told `ok` may tell the operator to check their inbox.
   */
  deliverMagicLink(message: MagicLinkMessage): Promise<Result<void>>;
}
