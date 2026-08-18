export interface LegacyFeedbackMetadataState {
  blocksRecall: boolean;
  decryptUnavailable: boolean;
  flagged: boolean;
}

export function isEncryptedMetadataEnvelope(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { __platos_enc?: unknown }).__platos_enc === 1
  );
}

export function hasLegacyNegativeRatingFlag(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return !!(value as Record<string, unknown>).flaggedByRating;
}

/**
 * Legacy encrypted metadata is fail-closed until it can be decrypted or the
 * scoped backfill completion marker proves every historical row was scanned.
 */
export function legacyFeedbackMetadataState(
  storedMetadata: unknown,
  decryptedMetadata: unknown
): LegacyFeedbackMetadataState {
  const encrypted = isEncryptedMetadataEnvelope(storedMetadata);
  const decryptUnavailable = encrypted && isEncryptedMetadataEnvelope(decryptedMetadata);
  const flagged = !decryptUnavailable && hasLegacyNegativeRatingFlag(decryptedMetadata);
  return {
    blocksRecall: decryptUnavailable || flagged,
    decryptUnavailable,
    flagged,
  };
}
