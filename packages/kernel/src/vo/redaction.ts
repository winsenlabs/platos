// Redaction — the one place a structured record is made safe to write down.
//
// WHY THIS FILE EXISTS. `ports/logger.ts` says redaction "is the adapter's
// contract, not the caller's discipline". Said and not supplied, that is a
// promise no code keeps: an adapter author reads the sentence, agrees with it,
// and then writes `JSON.stringify(fields)`. This is the supply — a pure function
// an adapter calls on the way out, so the port's promise has an implementation
// instead of a reader.
//
// WHAT MAKES IT MORE THAN DECORATION. A redactor that hides everything is as
// useless as one that hides nothing: a log with no `credentialId`, no
// `secretRevision` and no `rootKeyVersion` cannot answer the question an
// incident asks. So the classifier is TWO-SIDED and both sides are pinned
// against the canonical schema:
//
//   * every column the schema declares as secret MATERIAL must be hidden, and
//   * every identifier, counter and version beside it must SURVIVE.
//
// The canonical schema is not ours to move, which is what keeps the colocated
// suite from comparing two things the same author controls. The
// `pendingEncryptedSecret` column is what made the second arm of the key
// classifier necessary; the `inputTokens` counter is what made the numeric
// exemption necessary. Both arrived from the schema, not from taste.
//
// THE NUMERIC EXEMPTION, and why it is grounded rather than convenient. No
// material column in the canonical schema has a numeric type: `salt`, `nonce`,
// `ciphertext` and `authTag` are Bytes; `encryptedSecret`, `secretHash` and
// every `tokenHash` are String. The Int columns near them are counts and
// versions — `secretRevision`, `rootKeyVersion`, `inputTokens`. So a number is
// never material, and `inputTokens: 512` survives while `token: "..."` does not.
//
// THIS IS THE BACKSTOP, NOT THE PRIMARY GUARD. A key-name classifier is a guess
// about a name. The primary guard is that plaintext lives in a value that
// redacts itself and is not JSON at all, so it cannot reach a log field's type.
// This catches what is already a bare string by the time it gets here.

import type { JsonValue } from "./domain-event.js";

/** The literal every redaction path produces. Exported so a suite can pin it. */
export const REDACTED = "[REDACTED]";

/**
 * The last word of a key that makes the key's VALUE secret material.
 *
 * Matched against the final word only, so `secretRevision` (last word
 * `revision`) and `activeSecretVersionId` (last word `id`) are identifiers and
 * survive, while `secretHash`, `clientSecretHash` and `tokenHash` do not.
 * Plurals are matched too, so a `credentials` bag is hidden whole.
 */
export const MATERIAL_WORDS = [
  "secret",
  "password",
  "passphrase",
  "ciphertext",
  "authtag",
  "salt",
  "nonce",
  "token",
  "credential",
  "plaintext",
  "hash",
  "fingerprint",
  "signature",
  "cookie",
  "authorization",
  "bearer",
  "otp",
  "seed",
  "envelope",
] as const;

/**
 * `key` on its own is NOT material, and that is the whole difficulty.
 *
 * `EnvironmentVariable.key` is a variable NAME — `DATABASE_URL` — and it is
 * published by this system's own metadata projection, so hiding it would delete
 * the one field that makes an environment-variable log line legible.
 * `storageKey`, `artifactKey` and `idempotencyKey` are addresses in the same
 * way. A `key` is material only when the word before it says which kind of key
 * it is.
 */
export const KEY_QUALIFIERS = [
  "api",
  "secret",
  "private",
  "signing",
  "encryption",
  "encrypt",
  "access",
  "client",
  "root",
  "master",
  "session",
  "auth",
] as const;

/**
 * Value prefixes that are material whatever the key is called.
 *
 * This is the arm that catches a credential pasted into a field nobody thought
 * to name carefully. It is deliberately a short, high-precision list of issued
 * credential shapes rather than an entropy heuristic, because an entropy
 * heuristic hides identifiers — which is the failure the two-sided rule above
 * exists to refuse.
 */
export const MATERIAL_VALUE_PREFIXES = [
  "sk-",
  "sk_",
  "xoxb-",
  "xoxp-",
  "xapp-",
  "ghp_",
  "gho_",
  "bearer ",
] as const;

/**
 * A word that makes the WHOLE key material wherever in it the word appears.
 *
 * `encryptedReference` was found by the schema join in
 * apps/core-api/src/runtime/log-redaction.test.ts and is the reason this arm
 * exists: it names ciphertext, its last word is `reference`, and every rule
 * above let it through. `encrypted X` is ciphertext whatever X is.
 *
 * `sealed` is deliberately NOT here. The canonical schema declares `sealedAt`,
 * a DateTime, and a timestamp serialises to a string that no numeric exemption
 * would spare — so the word that reads as a synonym would in fact delete a
 * timestamp from every line it appears on.
 */
export const CIPHERTEXT_QUALIFIERS = ["encrypted", "ciphered"] as const;

/** How deep the walk goes before it stops describing and starts hiding. */
export const MAXIMUM_REDACTION_DEPTH = 12;

function words(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/**
 * Both spellings of a word, because English is not a rule.
 *
 * Stripping the trailing `s` unconditionally turns `access` into `acces` and
 * loses `accessKey`, so the singular is offered ALONGSIDE the word rather than
 * instead of it.
 */
function spellings(word: string): readonly string[] {
  return word.length > 1 && word.endsWith("s") ? [word, word.slice(0, -1)] : [word];
}

function anyMaterial(word: string): boolean {
  return spellings(word).some((form) => (MATERIAL_WORDS as readonly string[]).includes(form));
}

/**
 * Does this key name secret material?
 *
 * TWO ARMS, because a compound word does not always survive being split.
 * `authTag` splits into `auth` + `tag`, and neither half is material on its own
 * — the material name is the JOIN of them. The join arm is checked first for
 * exactly that column, which the canonical schema declares as Bytes beside
 * `salt`, `nonce` and `ciphertext`.
 */
export function isMaterialKey(key: string): boolean {
  const parts = words(key);
  if (parts.length === 0) return false;
  if (parts.some((part) => CIPHERTEXT_QUALIFIERS.includes(part as never))) return true;
  if (anyMaterial(parts.join(""))) return true;
  const last = parts[parts.length - 1] ?? "";
  if (anyMaterial(last)) return true;
  if (last !== "key") return false;
  const qualifier = parts[parts.length - 2] ?? "";
  return spellings(qualifier).some((form) => (KEY_QUALIFIERS as readonly string[]).includes(form));
}

/**
 * The numeric exemption, applied where the key decision is made.
 *
 * A material key whose value is a number or a boolean is a COUNT, a version or
 * a flag, never material: no material column in the canonical schema has a
 * numeric type. This is what keeps `inputTokens: 512` and `secretRevision: 4`
 * in a log line while `token: "..."` leaves it.
 */
function isExemptByType(value: JsonValue): boolean {
  return typeof value === "number" || typeof value === "boolean";
}

/** Does this VALUE look like an issued credential, whatever its key is called? */
export function isMaterialValue(value: JsonValue): boolean {
  if (typeof value !== "string") return false;
  const lowered = value.toLowerCase();
  return (MATERIAL_VALUE_PREFIXES as readonly string[]).some((prefix) => lowered.startsWith(prefix));
}

/**
 * Anything carrying a `reveal()` is a self-redacting holder from `secrets`, and
 * a holder that reached a log field has already gone somewhere it should not.
 * Hide it without calling anything on it.
 */
function isRevealable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { reveal?: unknown }).reveal === "function"
  );
}

function redactValue(value: JsonValue, depth: number): JsonValue {
  if (isRevealable(value)) return REDACTED;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return isMaterialValue(value) ? REDACTED : value;
  if (depth >= MAXIMUM_REDACTION_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = hide(key, entry) ? REDACTED : redactValue(entry, depth + 1);
  }
  return out;
}

function hide(key: string, value: JsonValue): boolean {
  return isMaterialKey(key) && !isExemptByType(value);
}

/**
 * Make one structured record safe to write down.
 *
 * Under a material key the WHOLE subtree goes, not just its string leaves: a
 * `credentials` bag holding an object is hidden as one value, because naming its
 * shape is already a description of the material inside it.
 */
export function redactLogFields(
  fields: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = hide(key, value) ? REDACTED : redactValue(value, 1);
  }
  return Object.freeze(out);
}
