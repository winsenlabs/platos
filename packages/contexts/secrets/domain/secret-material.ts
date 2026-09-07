// Plaintext, and the one type allowed to hold it.
//
// THE RULE THIS FILE ENFORCES: a plaintext secret never leaves the encryption
// boundary except as this value, and this value cannot be serialised,
// interpolated, logged, spread or enumerated into anything that records it.
//
// The extraction source proves the same property with a class holding a `#value`
// private field. This is the framework-free equivalent: the plaintext lives in a
// closure, so it is not an own property at all. That is strictly stronger than a
// private field, because a private field still shows up under a debugger's
// property inspection while a closure variable is reachable only through the one
// `reveal()` the caller must deliberately name.
//
// The redaction accessors are defined NON-ENUMERABLE, so `{ ...material }` is
// `{}` and `Object.keys(material)` is `[]` — the two accidental-capture paths a
// structured logger takes.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { invalidSecretMaterial, secretInputNotWriteOnly } from "./errors.js";

const REDACTED = "[REDACTED SecretMaterial]";

// The well-known symbol Node's `util.inspect` honours, obtained by description
// rather than by importing `node:util`. The domain imports the kernel and its own
// files, and no runtime module at all.
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export interface SecretMaterial {
  /** Deliberately verbose. Every call site that unwraps plaintext is greppable. */
  reveal(): string;
  toJSON(): string;
  toString(): string;
}

/**
 * Wrap plaintext. The caller is asserting it is already inside the boundary —
 * this is the return of an `open()`, or the input of a `seal()`, and nothing else.
 */
export function secretMaterial(plaintext: string): SecretMaterial {
  const holder: Partial<SecretMaterial> = {};
  const hidden = {
    value: false,
    writable: false,
    enumerable: false,
    configurable: false,
  } as const;
  Object.defineProperties(holder, {
    reveal: { ...hidden, value: () => plaintext },
    toJSON: { ...hidden, value: () => REDACTED },
    toString: { ...hidden, value: () => REDACTED },
    [INSPECT]: { ...hidden, value: () => REDACTED },
  });
  return Object.freeze(holder) as SecretMaterial;
}

/** The literal every redaction path produces. Exported so tests can pin it. */
export const REDACTED_SECRET_MATERIAL = REDACTED;

export function isSecretMaterial(value: unknown): value is SecretMaterial {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SecretMaterial).reveal === "function" &&
    typeof (value as SecretMaterial).toJSON === "function" &&
    (value as SecretMaterial).toJSON() === REDACTED
  );
}

/**
 * Accept plaintext from outside the boundary.
 *
 * Empty material is rejected rather than sealed: an empty envelope is
 * indistinguishable from a successful rotation that lost its input, and the
 * extraction source rejects it for the same reason.
 */
export function acceptPlaintext(input: string): Result<SecretMaterial> {
  if (typeof input !== "string" || input.length === 0) {
    return err(invalidSecretMaterial("plaintext_empty"));
  }
  return ok(secretMaterial(input));
}

/**
 * WIN-259 — the WRITE-ONLY INPUT check, and why it is a runtime guard and not
 * only a type.
 *
 * Every mutating command in this context used to take its plaintext as a bare
 * `string`. The type protected the RESULT of a read and nothing protected the
 * ARGUMENT of a write: `JSON.stringify(command)` on the way into a queue, a
 * retry buffer, a structured log or an error report recorded the secret
 * verbatim, and every one of those is a place a transport legitimately puts a
 * command.
 *
 * Changing the field's declared type moves the leak out of type-checked code.
 * It does not move it out of a transport that decoded a request body into
 * `unknown` and asserted its way here, which is what every transport does. So
 * the check is also made at run time, once, at the top of each mutating use
 * case, with its OWN code — a caller that gets this back learns that its
 * request path is writing secrets down, which is a different repair from a
 * secret this boundary would not accept.
 *
 * A value that arrived as DATA can never satisfy this, because `isSecretMaterial`
 * asks a function to answer with a literal only this module knows.
 *
 * TWO GUARDS, TWO CODES, ON PURPOSE. The wrapper is not a substitute for the
 * emptiness rule `acceptPlaintext` states above — a holder can hold "" — so the
 * emptiness rule is re-asserted here rather than lost with the bare string it
 * used to guard. They answer with different codes because they name different
 * repairs: `SECRET_INPUT_NOT_WRITE_ONLY` says the caller's request path writes
 * secrets down, `INVALID_SECRET_MATERIAL` says this one secret is unusable.
 */
export function requireWriteOnly(field: string, input: unknown): Result<SecretMaterial> {
  if (!isSecretMaterial(input)) return err(secretInputNotWriteOnly(field));
  if (input.reveal().length === 0) return err(invalidSecretMaterial("plaintext_empty"));
  return ok(input);
}
