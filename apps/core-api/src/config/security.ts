// The SECURITY section — the operator session contract and the credential root.
//
// TWO GROUPS, AND THEY ARE INDEPENDENT ON PURPOSE. An install that serves the
// operator surface needs a session secret; an install that stores a provider
// credential needs an encryption root. A headless install that does neither
// needs neither, and one that does both must not be able to satisfy the gate by
// setting one of them.
//
// THE ENCRYPTION KEY CARRIES A VERSION, AND THE VERSION IS REQUIRED WITH IT.
// WIN-258 made every credential row in the canonical store carry the version of
// the root it was sealed under, because rotation without a version is a
// migration you cannot roll back: the old rows are unreadable the moment the new
// key is in place. The compose stack already passes
// `PLATOS_CREDENTIAL_ROOT_KEY_VERSION` beside its roots for that reason. Pairing
// them here means an install cannot rotate a key and forget to say so.
//
// THE SESSION SECRET IS 32 CHARACTERS MINIMUM AND THE ROOT KEY IS EXACTLY 64
// HEX. They are different kinds of value and the difference is enforced rather
// than described: a session secret is an HMAC key of any shape, while a root key
// is 32 bytes of entropy in hexadecimal, and a 63-character root is not a short
// key but a typo that would seal every future credential under something the
// cipher rejects at first use.
//
// WHAT THIS SECTION DOES NOT DECIDE. It holds no policy — no session lifetime
// rule that a context should own, no per-organisation setting, no list of who
// may do what. Those are `identity-access` and `tenancy` decisions and they are
// rows. A cookie's name, its SameSite mode and whether it carries the Secure
// attribute ARE process configuration, because they are properties of how this
// deployable is fronted rather than of who is signed in.

import type { ConfigFieldSpec, ConfigSectionSpec } from "./schema.js";
import type { GroupPresence, SectionReader } from "./stores.js";

const sessionSecret: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_SECURITY_SESSION_SECRET",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the key operator session cookies are signed with",
  minimumLength: 32,
});

const encryptionKey: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_SECURITY_ENCRYPTION_KEY",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the active credential root, 32 bytes as 64 hexadecimal characters",
  pattern: "[0-9a-fA-F]{64}",
  patternDescribe: "exactly 64 hexadecimal characters",
  minimumLength: 64,
});

export const SECURITY_SECTION: ConfigSectionSpec = Object.freeze({
  id: "security",
  describe: "the operator session contract and the credential encryption root",
  groups: Object.freeze([
    Object.freeze({
      id: "session",
      describe: "the operator session cookie",
      anchor: sessionSecret,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_SECURITY_SESSION_COOKIE_NAME",
          kind: "string",
          required: false,
          defaultValue: "platos_session",
          secret: false,
          describe: "the cookie the operator session is carried in",
          // The cookie-name grammar, not a general string. A space or a
          // semicolon here produces a Set-Cookie header the client silently
          // discards, and a silently discarded session cookie presents as
          // "sign-in does nothing", which is a long afternoon.
          pattern: "[A-Za-z0-9!#$%&'*+._|~-]+",
          patternDescribe: "a valid cookie name: letters, digits and !#$%&'*+._|~-",
          minimumLength: 1,
        }),
        Object.freeze({
          name: "PLATOS_SECURITY_SESSION_TTL_S",
          kind: "integer",
          required: false,
          // Twelve hours: longer than a working day is a session that outlives
          // the laptop it was opened on, shorter is a sign-in every lunch break.
          defaultValue: "43200",
          secret: false,
          describe: "how long an operator session stays valid",
          minimum: 60,
          maximum: 2592000,
        }),
        Object.freeze({
          name: "PLATOS_SECURITY_SESSION_SAME_SITE",
          kind: "enum",
          required: false,
          defaultValue: "lax",
          secret: false,
          describe: "the SameSite attribute on the session cookie",
          allowed: Object.freeze(["strict", "lax", "none"]),
        }),
        Object.freeze({
          name: "PLATOS_SECURITY_SESSION_COOKIE_SECURE",
          kind: "boolean",
          required: false,
          // Defaults to TRUE, and the awkward direction is the right one. An
          // install that has to serve the operator surface over plain HTTP must
          // say so out loud; the alternative default sends a session cookie in
          // clear over any link that was not deliberately secured.
          defaultValue: "true",
          secret: false,
          describe: "whether the session cookie carries the Secure attribute",
        }),
      ]),
    }),
    Object.freeze({
      id: "encryption",
      describe: "the credential encryption root",
      anchor: encryptionKey,
      requiredWithAnchor: Object.freeze([
        Object.freeze({
          name: "PLATOS_SECURITY_ENCRYPTION_KEY_VERSION",
          kind: "integer",
          required: false,
          defaultValue: null,
          secret: false,
          describe: "the version stamped on every credential sealed under the active root",
          minimum: 1,
          maximum: 1000000,
        }),
      ]),
      optional: Object.freeze([]),
    }),
  ]),
});

export type SameSiteMode = "strict" | "lax" | "none";

export interface SessionConfiguration {
  readonly secret: string;
  readonly cookieName: string;
  readonly ttlSeconds: number;
  readonly sameSite: SameSiteMode;
  readonly cookieSecure: boolean;
}

export interface EncryptionConfiguration {
  readonly rootKey: string;
  readonly rootKeyVersion: number;
}

export interface SecurityConfiguration {
  readonly session: SessionConfiguration | null;
  readonly encryption: EncryptionConfiguration | null;
}

export function assembleSecurity(read: SectionReader, declared: GroupPresence): SecurityConfiguration {
  return Object.freeze({
    session: !declared("session")
      ? null
      : Object.freeze({
          secret: read("PLATOS_SECURITY_SESSION_SECRET") ?? "",
          cookieName: read("PLATOS_SECURITY_SESSION_COOKIE_NAME") ?? "",
          ttlSeconds: Number(read("PLATOS_SECURITY_SESSION_TTL_S")),
          sameSite: (read("PLATOS_SECURITY_SESSION_SAME_SITE") ?? "lax") as SameSiteMode,
          cookieSecure: read("PLATOS_SECURITY_SESSION_COOKIE_SECURE") === "true",
        }),
    encryption: !declared("encryption")
      ? null
      : Object.freeze({
          rootKey: read("PLATOS_SECURITY_ENCRYPTION_KEY") ?? "",
          rootKeyVersion: Number(read("PLATOS_SECURITY_ENCRYPTION_KEY_VERSION")),
        }),
  });
}
