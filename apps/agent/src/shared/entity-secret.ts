/**
 * Unwrap credential material that a migration stored as an envelope.
 *
 * The live mint path stores an entity's service secret as a bare string. The
 * clean-schema cutover wrote `{"serviceSecret":"…"}` (and legacy SecretStore
 * values are `{"secret":"…"}`) into the same slot while `Credential.secretHash`
 * kept the hash of the BARE secret — so one credential ends up with two
 * disagreeing representations.
 *
 * Readers that compare hashes keep working; readers that use the value as an
 * HMAC key silently sign with the JSON envelope. That is how a tool-sync
 * connection can be healthy while every session token and every signed
 * outbound tool call fails.
 *
 * Bare secrets pass through untouched, an unrecognised envelope is returned
 * as-is rather than guessed at, and the transform is idempotent.
 */
export function unwrapEntitySecretMaterial(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed.startsWith("{")) return plaintext;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return plaintext;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return plaintext;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["serviceSecret", "PlatosConnectedEntity.serviceSecret", "secret"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return plaintext;
}
