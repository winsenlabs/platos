// Reading `PLATOS_CHANNELS_EMAIL_SMTP_URL` into the handful of facts a session
// needs, and refusing a URL that cannot make one.
//
// `config/channels.ts` has already refused anything that is not `smtp:` or
// `smtps:`. What is left to decide is what each scheme MEANS, and it is decided
// once, here:
//
//   smtps://host[:465]   implicit TLS from the first byte (RFC 8314 §3.3)
//   smtp://host[:25]     plaintext, upgraded with STARTTLS — REQUIRED unless the
//                        install sets `PLATOS_CHANNELS_EMAIL_REQUIRE_TLS=false`,
//                        and credentials are NEVER sent without it either way
//
// THE CREDENTIALS ARE PERCENT-DECODED, ONCE. A URL is the only place this
// install carries them, and a password containing `@` or `:` has to be encoded to
// survive in one; handing the encoded form to AUTH would fail on exactly the
// passwords a generator produces.

import { err, ok, type Result } from "@platos/context-identity-access/application/ports/index.js";

import { configurationInvalid } from "./errors.js";

export interface RelayEndpoint {
  /** Implicit TLS (`smtps:`). */
  readonly implicitTls: boolean;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

export function parseRelayUrl(value: string): Result<RelayEndpoint> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(configurationInvalid("smtpUrl", "not a URL"));
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    return err(configurationInvalid("smtpUrl", "scheme must be smtp: or smtps:"));
  }
  if (url.hostname === "") return err(configurationInvalid("smtpUrl", "no host"));
  const implicitTls = url.protocol === "smtps:";
  const port = url.port === "" ? (implicitTls ? 465 : 25) : Number(url.port);
  const username = url.username === "" ? null : decodeURIComponent(url.username);
  const password = url.password === "" ? null : decodeURIComponent(url.password);
  if ((username === null) !== (password === null)) {
    return err(configurationInvalid("smtpUrl", "a username and a password come together or not at all"));
  }
  // `URL` keeps IPv6 hosts bracketed; a socket wants them bare.
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return ok({ implicitTls, host, port, username, password });
}
