// The invariants PostgreSQL enforces on `secrets`' four rows that the port's
// TYPES cannot, checked on the way in so each refusal has a name.
//
// WHY THIS FILE EXISTS, and it is the argument `identity-guards.ts` and
// `cost-guards.ts` make one context over. Every rule restated below lives in
// `internal-packages/tenancy-database/prisma/migrations/`. NOT ONE of them is in
// `schema.prisma`, so not one is in the generated client's types; and not one is
// in `inMemorySecretsStore`, the double this context ships, so not one is in any
// use-case suite in the tree.
//
// THE DOUBLE PROVES THE POINT. `inMemorySecretsStore.upsert` writes whatever
// `EnvironmentVariableUpsert` carries: a lowercase key, a PLAIN row with a null
// value, a SECRET row holding both a value and a credential. All three
// type-check, all three satisfy the fake, and PostgreSQL refuses all three —
// `EnvironmentVariable_key_check`, `EnvironmentVariable_value_shape_check`. The
// same is true of an envelope: the fake cipher happens to mint 32/12/16-byte
// fields, so the three `octet_length` checks have never been exercised by
// anything, and a real cipher that changed a width would be caught by the
// database and by nothing else.
//
// THE DATABASE REMAINS AUTHORITATIVE. These do not replace the constraints and
// may not disagree with them: `secrets-constraints.integration.test.ts` removes
// each guard and shows PostgreSQL refusing the same input, so a guard that
// drifted looser is caught there, and one that drifted tighter is caught by the
// conformance run going red on a value the database accepts. What the guard buys
// is a NAMED refusal at the call site instead of a driver error carrying a
// constraint name and a SQLSTATE.
//
// NINE REFUSALS, NINE CODES. A shared code would make "this identifier is not a
// uuid", "this envelope's nonce is the wrong width" and "this variable is a
// SECRET carrying a plaintext value" indistinguishable in a log, and they have
// nine causes and nine fixes. `secrets`' own `domain/errors.ts` cannot carry the
// distinction at all: it collapses every store refusal into
// `CREDENTIAL_UNAVAILABLE` ON PURPOSE, because a caller able to tell a missing
// credential from a tampered envelope has a probing oracle. That collapse is
// right for a caller and useless for an operator, so the distinction is carried
// here, as a thrown refusal — which is what the port's "a rejected promise is a
// defect, not an outcome" leaves room for.

/** A column declared `@db.Uuid` was handed something that is not one. */
export const IDENTIFIER_NOT_UUID = "secrets.write.identifier_not_uuid";

/**
 * One of `CredentialSecretVersion`'s three `> 0` CHECKs, or the INTEGER column
 * under it: `_revision_check`, `_format_check`, `_root_key_check`.
 */
export const ENVELOPE_ORDINAL_OUT_OF_RANGE = "secrets.write.envelope_ordinal_out_of_range";

/**
 * One of the three `octet_length` CHECKs on the envelope: 32-byte salt, 12-byte
 * nonce, 16-byte authentication tag. Exact widths, not maxima.
 */
export const ENVELOPE_BYTES_MISWIDTH = "secrets.write.envelope_bytes_miswidth";

/**
 * `CredentialAudit`'s three nullable ordinals exceed the INTEGER column.
 *
 * DELIBERATELY NOT the envelope's code, and deliberately NOT its predicate. The
 * audit table carries no `> 0` CHECK at all, so a guard demanding positivity
 * here would be STRICTER than the database — the drift the conformance run
 * exists to catch, pointing the wrong way.
 */
export const AUDIT_ORDINAL_OUT_OF_RANGE = "secrets.write.audit_ordinal_out_of_range";

/** `EnvironmentVariable_key_check`: `"key" ~ '^[A-Z][A-Z0-9_]{0,63}$'`. */
export const VARIABLE_KEY_INVALID = "secrets.write.variable_key_invalid";

/** `EnvironmentVariable_value_shape_check`: PLAIN and SECRET carry opposite halves. */
export const VARIABLE_SHAPE_INCOHERENT = "secrets.write.variable_shape_incoherent";

/** `EnvironmentVariable_value_length_check`: `length("value") <= 8192`. */
export const VARIABLE_VALUE_TOO_LONG = "secrets.write.variable_value_too_long";

/** The bound interpolated into a raw `LIMIT` is not a positive whole number. */
export const PURGE_LIMIT_INVALID = "secrets.write.purge_limit_invalid";

/** A `Date` the `TIMESTAMP(3)` column cannot hold — `Invalid Date`, or out of range. */
export const INSTANT_NOT_REPRESENTABLE = "secrets.write.instant_not_representable";

export class SecretsWriteRefused extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, message: string) {
    super(message);
    this.name = "SecretsWriteRefused";
    this.code = code;
    this.column = column;
  }
}

/**
 * Every identifier column on these four rows is `@db.Uuid`, and PostgreSQL
 * PARSES the value rather than storing the bytes it was given.
 *
 * The pattern is the canonical 8-4-4-4-12 hexadecimal form, case-insensitively.
 * `uuid_in` also accepts a braced and a `urn:uuid:` form, and both are refused
 * here deliberately: the column would store the UNWRAPPED value, so a later read
 * would not compare equal to the string the caller wrote, and `findCredential`
 * would miss a row it had just inserted.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function requireUuid(column: string, value: string): string {
  if (!UUID.test(value)) {
    throw new SecretsWriteRefused(
      IDENTIFIER_NOT_UUID,
      column,
      `${column} is a uuid column; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The same check where the column is nullable. */
export function requireUuidOrNull(column: string, value: string | null): string | null {
  return value === null ? null : requireUuid(column, value);
}

/** PostgreSQL `INTEGER`. Every ordinal on these four rows is one. */
const INTEGER_MAX = 2_147_483_647;
const INTEGER_MIN = -2_147_483_648;

/**
 * An envelope ordinal: `secretRevision`, `formatVersion` or `rootKeyVersion`.
 *
 * `domain/ids.ts` brands all three and its constructors do check positivity — but
 * a brand is an assertion, and `asSecretsIdentifier`'s own header says so. The
 * adapter is handed the branded value, not the constructor, and the ordinals on
 * a purge candidate came back OUT of the database. So the check is made again
 * here, against the column rather than against the brand.
 */
export function requireEnvelopeOrdinal(column: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > INTEGER_MAX) {
    throw new SecretsWriteRefused(
      ENVELOPE_ORDINAL_OUT_OF_RANGE,
      column,
      `${column} must be a whole number in 1..${INTEGER_MAX}; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * An audit ordinal, which is nullable and carries NO positivity rule.
 *
 * The audit table records what happened, including what happened to a row whose
 * own ordinals were refused, so it is looser than the envelope on purpose.
 */
export function requireAuditOrdinal(column: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < INTEGER_MIN || value > INTEGER_MAX) {
    throw new SecretsWriteRefused(
      AUDIT_ORDINAL_OUT_OF_RANGE,
      column,
      `${column} must be a whole number the INTEGER column can hold; received ${String(value)}`,
    );
  }
  return value;
}

/** The three exact widths the envelope's `octet_length` CHECKs demand. */
export const ENVELOPE_SALT_BYTES = 32;
export const ENVELOPE_NONCE_BYTES = 12;
export const ENVELOPE_AUTH_TAG_BYTES = 16;

/**
 * An envelope field of an EXACT width.
 *
 * `octet_length(x) = N` is an equality, so a short field and a long one are the
 * same refusal, and neither is a truncation the database will perform for you.
 */
export function requireEnvelopeBytes(column: string, value: Uint8Array, width: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== width) {
    throw new SecretsWriteRefused(
      ENVELOPE_BYTES_MISWIDTH,
      column,
      `${column} must be exactly ${width} bytes; received ${
        value instanceof Uint8Array ? String(value.byteLength) : "a non-byte value"
      }`,
    );
  }
  return value;
}

/** `EnvironmentVariable_key_check`, spelled exactly as the migration spells it. */
const VARIABLE_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function requireVariableKey(value: string): string {
  if (!VARIABLE_KEY.test(value)) {
    throw new SecretsWriteRefused(
      VARIABLE_KEY_INVALID,
      "key",
      `key must match ^[A-Z][A-Z0-9_]{0,63}$; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** `EnvironmentVariable_value_length_check`. */
export const VARIABLE_VALUE_MAX_LENGTH = 8192;

/**
 * The variable's two halves, judged together because the CHECK judges them
 * together.
 *
 * A PLAIN row carries a value and no credential; a SECRET row carries a
 * credential and no value. There is no third state, and in particular there is
 * no "SECRET with a value" — which is the shape that would put plaintext in a
 * column a table dump reads.
 */
export function requireVariableShape(
  kind: string,
  value: string | null,
  credentialId: string | null,
): void {
  const coherent =
    (kind === "PLAIN" && value !== null && credentialId === null) ||
    (kind === "SECRET" && value === null && credentialId !== null);
  if (!coherent) {
    throw new SecretsWriteRefused(
      VARIABLE_SHAPE_INCOHERENT,
      "value",
      `a ${kind} variable must carry ${
        kind === "PLAIN" ? "a value and no credential" : "a credential and no value"
      }`,
    );
  }
  if (value !== null && value.length > VARIABLE_VALUE_MAX_LENGTH) {
    throw new SecretsWriteRefused(
      VARIABLE_VALUE_TOO_LONG,
      "value",
      `value must be at most ${VARIABLE_VALUE_MAX_LENGTH} characters; received ${String(value.length)}`,
    );
  }
}

/**
 * The batch bound a purge sweep interpolates into `LIMIT`.
 *
 * It is checked rather than trusted because it reaches raw SQL. The use case
 * clamps it to `PURGE_RETIRED_HARD_LIMIT` before it gets here, and that is
 * exactly why the check belongs here too: a second caller of the port has no
 * such clamp, and the port's signature says `number`.
 */
export function requirePurgeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SecretsWriteRefused(
      PURGE_LIMIT_INVALID,
      "limit",
      `limit must be a positive whole number; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * A `Date` the column can hold.
 *
 * `new Date("nonsense")` is a `Date`, satisfies the port's type, is stored by
 * the in-memory double without complaint, and reaches the driver as `NaN`. The
 * check names the column, so an operator reading the refusal knows which of a
 * rotation's three instants was the bad one.
 */
export function requireInstant(column: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SecretsWriteRefused(
      INSTANT_NOT_REPRESENTABLE,
      column,
      `${column} must be a valid instant; received ${String(value)}`,
    );
  }
  return value;
}

/** The same check where the column is nullable. */
export function requireInstantOrNull(column: string, value: Date | null): Date | null {
  return value === null ? null : requireInstant(column, value);
}
