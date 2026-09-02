// Legal holds — the check that must run before anything is destroyed.
//
// A hold register is written by a human who knows a subject's evidence must
// survive. The erasure API also carries a caller-supplied hold id, but that
// protects a subject only when whoever fires the request already knows about the
// hold — which is precisely the knowledge a register exists because people do
// not reliably have. So the register is consulted server-side, on every request,
// and a caller-supplied id only ADDS to what it finds.
//
// MATCHING IS OVER EVERY ALIAS, NOT THE REQUESTED ID
//
// A hold naming a Slack handle must also stop an erasure requested by email when
// both resolve to the same person. Checking only the requested identifier would
// leave every held subject erasable through any alias they were not registered
// under — the same hole the alias set exists to close for deletion, reopened one
// layer up.
//
// WHAT THE REFUSAL IS ALLOWED TO SAY
//
// The match itself never leaves this module. A register's entries ARE the
// subject's handles — a Slack id, an email address — and the erasure record is
// forbidden to carry one. Writing the matched entry into the operation row would
// persist, indefinitely and in the very record that documents a person's
// destruction, the one value that record must not hold.
//
// So a match reports WHERE it was found rather than WHAT was found, and
// `legalHoldReference` renders that as a register position plus a truncated
// digest of the entry. An operator can find the line of their own register that
// stopped the erasure; nobody can read the handle back out of the receipt.

/** Prefix every stored hold reference carries, so its shape is recognizable. */
export const LEGAL_HOLD_REFERENCE_PREFIX = "legal-hold-register#";

/**
 * How much of the entry digest a reference shows.
 *
 * An identifier to recognize, not a secret to compare in constant time. Long
 * enough that two entries in one register do not collide in practice, short
 * enough that the reference stays readable in a log line.
 */
export const LEGAL_HOLD_REFERENCE_DIGEST_LENGTH = 12;

/** The register entry that stopped an erasure, and where in the register it sits. */
export interface LegalHoldMatch {
  /**
   * The entry as the operator wrote it.
   *
   * The subject's own handle, so it stays in memory: it is what gets hashed,
   * never what gets stored. See `legalHoldReference`.
   */
  readonly value: string;
  /** 1-based position in the register, as the operator reads it. */
  readonly position: number;
}

/**
 * Parse an operator's hold register.
 *
 * Comma-separated, whitespace-tolerant, case-insensitive on match. Empty and
 * blank entries are dropped so a trailing comma cannot produce an empty-string
 * entry that matches a subject with no aliases.
 */
export function parseLegalHoldList(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The entry that placed this subject on hold, or null if none did.
 *
 * Returns the MATCH rather than a boolean so the refusal can name which register
 * entry stopped it: an operator seeing "blocked" with no reason cannot tell a
 * hold from a bug.
 *
 * `handles` is the subject's full alias set plus the id the caller named. Blank
 * candidates are dropped rather than compared — an empty handle would match an
 * empty register entry, and `parseLegalHoldList` is only one of the two places
 * that could produce one.
 */
export function findLegalHold(
  handles: readonly string[],
  register: readonly string[],
): LegalHoldMatch | null {
  if (register.length === 0) return null;

  const candidates = new Set(
    handles.filter((handle) => handle.length > 0).map((handle) => handle.toLowerCase()),
  );
  if (candidates.size === 0) return null;

  for (const [index, entry] of register.entries()) {
    if (candidates.has(entry.toLowerCase())) return { value: entry, position: index + 1 };
  }
  return null;
}

/**
 * How a matched hold is NAMED in the receipt, the operation row and the event
 * trail — everywhere the raw entry is forbidden, which is everywhere durable.
 *
 * Two parts, because either alone is too weak. The POSITION is what an operator
 * actually navigates by, but a register is configuration somebody will reorder.
 * The DIGEST is stable and verifiable — the same salted, organization-scoped
 * primitive the receipt identifies its subject by — but on its own it names
 * nothing a human can find.
 */
export function legalHoldReference(match: LegalHoldMatch, entryDigest: string): string {
  const truncated = entryDigest.slice(0, LEGAL_HOLD_REFERENCE_DIGEST_LENGTH);
  return `${LEGAL_HOLD_REFERENCE_PREFIX}${match.position}:${truncated}`;
}

/** True when a value is a reference this module minted rather than a raw entry. */
export function isLegalHoldReference(value: string): boolean {
  return value.startsWith(LEGAL_HOLD_REFERENCE_PREFIX);
}
