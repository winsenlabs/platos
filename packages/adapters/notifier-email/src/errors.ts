// The notifier-email adapter's refusals — one code per distinct failure.
//
// `scripts/error-taxonomy.mjs` scans `packages/adapters` and holds every code here
// to `docs/error-taxonomy.json`; its rule is the reason there are five and not
// one: an operator told "the relay refused" must be able to tell a relay that
// never answered from one that answered no, and both from a message this adapter
// would not write.
//
// NOTHING HERE CARRIES A VALUE A LOG MUST NOT HOLD. The relay URL carries its
// password, a recipient address is personal data, and `details` is rendered into
// logs — so a refusal names the STAGE and the SMTP reply CODE, never the reply
// text, the address or the URL.

import { domainError } from "@platos/context-identity-access/application/ports/index.js";
import type { DomainError } from "@platos/context-identity-access/application/ports/index.js";

/** The relay could not be reached, or stopped answering: connect, TLS, timeout, EOF. */
export function relayUnreachable(stage: string, cause: string): DomainError {
  return domainError("NOTIFIER_EMAIL_RELAY_UNREACHABLE", "unavailable", "The email relay could not be reached", {
    retryAfterSeconds: 5,
    details: { stage, cause },
  });
}

/** The relay answered, and the answer was a 4xx or 5xx at `stage`. */
export function relayRefused(stage: string, replyCode: number): DomainError {
  return domainError("NOTIFIER_EMAIL_RELAY_REFUSED", "unavailable", "The email relay refused the message", {
    details: { stage, replyCode },
  });
}

/**
 * Credentials were configured and the relay offered no TLS to send them over.
 *
 * Refused rather than sent. `smtp://user:pass@host` on a relay that does not
 * advertise STARTTLS would put the password on the wire in clear, and "the
 * message arrived" is not worth that. Use `smtps://`, or a relay that offers
 * STARTTLS.
 */
export function insecureAuthenticationRefused(): DomainError {
  return domainError(
    "NOTIFIER_EMAIL_INSECURE_AUTH_REFUSED",
    "unavailable",
    "The email relay offered no TLS, so its credentials were not sent",
  );
}

/**
 * A header value this adapter will not write: a CR or LF (header injection), a
 * non-ASCII address (no SMTPUTF8 support is claimed), or no `@`.
 */
export function messageRefused(field: string, reason: string): DomainError {
  return domainError("NOTIFIER_EMAIL_MESSAGE_REFUSED", "invalid_input", "The message could not be written safely", {
    fields: [{ field, code: "NOTIFIER_EMAIL_MESSAGE_REFUSED", message: reason }],
    details: { field, reason },
  });
}

/** The options the composition root handed over cannot make a working relay client. */
export function configurationInvalid(option: string, reason: string): DomainError {
  return domainError(
    "NOTIFIER_EMAIL_CONFIGURATION_INVALID",
    "invalid_input",
    "The email notifier configuration is unusable",
    { details: { option, reason } },
  );
}
