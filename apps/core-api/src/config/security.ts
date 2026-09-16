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
          // THE NAME THE LEGACY TREE MINTS, AND THE DEFAULT IS WHY D19 HOLDS.
          // This default used to be `platos_session`, a name nothing issued and
          // nothing read. Consumed, it would have made every cookie the Remix
          // tree already put in a browser invisible to core-api, which is the
          // forced re-login D19 refuses. It is the BASE name: on a secure install
          // the transport asks for the `__Host-` form of it, so the default is
          // `__Host-platos_operator_session` there, exactly what the legacy tree
          // sets in production.
          defaultValue: "platos_operator_session",
          secret: false,
          describe: "the base name of the operator session cookie; a secure install adds the __Host- prefix itself",
          // The cookie-name grammar, not a general string. A space or a
          // semicolon here produces a Set-Cookie header the client silently
          // discards, and a silently discarded session cookie presents as
          // "sign-in does nothing", which is a long afternoon. A leading `__` is
          // refused too: the `__Host-` and `__Secure-` prefixes are the
          // TRANSPORT's decision, and a configured prefix would either double
          // one or claim a guarantee the Secure setting does not give.
          pattern: "(?!__)[A-Za-z0-9!#$%&'*+._|~-]+",
          patternDescribe: "a valid cookie name without a leading __ prefix: letters, digits and !#$%&'*+._|~-",
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
          // `none` WAS ACCEPTED HERE AND IS REFUSED NOW, AT STARTUP. The session
          // contract refuses it on every mint (`identity-access`
          // `checkSessionCookieShape`: it would send the credential on
          // cross-site requests, which is the CSRF the attribute exists to stop),
          // so a process that booted with it would refuse every sign-in instead.
          allowed: Object.freeze(["strict", "lax"]),
        }),
        Object.freeze({
          name: "PLATOS_SECURITY_SESSION_COOKIE_SECURE",
          kind: "boolean",
          required: false,
          // Defaults to TRUE, and the awkward direction is the right one. An
          // install that has to serve the operator surface over plain HTTP must
          // say so out loud; the alternative default sends a session cookie in
          // clear over any link that was not deliberately secured.
          //
          // WHAT TRUE MEANS, NOW THAT SOMETHING READS IT (D-COOKIE). The cookie
          // is `Secure` and `__Host-` prefixed, and core-api issues or clears it
          // only on a request that reached it over TLS — directly, or through
          // the ONE proxy `PLATOS_CORE_API_TRUSTED_PROXY` names. Any other
          // request is refused rather than handed a credential in a cookie a
          // browser would drop. FALSE is the plain-HTTP install: the unprefixed
          // name and no `Secure`, whatever any header claims.
          defaultValue: "true",
          secret: false,
          describe: "whether the session cookie is Secure and __Host- prefixed, and so issued only over TLS",
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

export type SameSiteMode = "strict" | "lax";

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

/**
 * How the operator session cookie is shaped on this install, as the transport
 * asks for it.
 *
 * NEVER NULL, EVEN WHEN THE SESSION GROUP IS UNDECLARED. `identity-access`
 * composes from the encryption root and the stores; the session secret is not one
 * of its inputs, so an install can serve operator routes with this group absent.
 * Such an install still gets a cookie policy, and it is the one the field table
 * promises by default — read from the field specs above rather than written
 * again here, so a changed default cannot leave a second copy behind.
 */
export interface SessionCookiePolicy {
  /** `PLATOS_SECURITY_SESSION_COOKIE_SECURE`. */
  readonly secure: boolean;
  /** `PLATOS_SECURITY_SESSION_COOKIE_NAME`, the base name without any prefix. */
  readonly cookieName: string;
  /** `PLATOS_SECURITY_SESSION_SAME_SITE`. */
  readonly sameSite: SameSiteMode;
}

function sessionFieldDefault(name: string): string {
  const group = SECURITY_SECTION.groups.find((candidate) => candidate.id === "session");
  const field = group?.optional.find((candidate) => candidate.name === name);
  if (field?.defaultValue === null || field?.defaultValue === undefined) {
    throw new Error(`the security.session group declares no default for ${name}`);
  }
  return field.defaultValue;
}

export function sessionCookiePolicy(security: SecurityConfiguration): SessionCookiePolicy {
  const session = security.session;
  if (session !== null) {
    return Object.freeze({ secure: session.cookieSecure, cookieName: session.cookieName, sameSite: session.sameSite });
  }
  return Object.freeze({
    secure: sessionFieldDefault("PLATOS_SECURITY_SESSION_COOKIE_SECURE") === "true",
    cookieName: sessionFieldDefault("PLATOS_SECURITY_SESSION_COOKIE_NAME"),
    sameSite: sessionFieldDefault("PLATOS_SECURITY_SESSION_SAME_SITE") as SameSiteMode,
  });
}
