/**
 * Legal holds — the check that must run before anything is destroyed.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * `docs/gdpr.md` told operators that `PLATOS_LEGAL_HOLD_USER_IDS` "is checked
 * by the delete route and rejects the request for any user on the list". No
 * code read that variable. An operator who set it believed held subjects were
 * protected and would have been wrong at exactly the moment it mattered — the
 * erasure is irreversible, so the failure is discovered only after the evidence
 * is gone.
 *
 * The erasure API did carry a `legalHoldPolicyId`, but the CALLER supplies it.
 * That protects a subject only when whoever fires the request already knows
 * about the hold, which is precisely the knowledge a hold register exists
 * because people do not reliably have.
 *
 * MATCHING IS OVER EVERY ALIAS, NOT THE REQUESTED ID
 *
 * A hold naming `slack:U08JTN5FX39` must also stop an erasure requested as
 * `user@example.com` when both resolve to the same person. Checking only the
 * requested identifier would leave every held subject erasable through any
 * alias they were not registered under, which is the same hole the subject
 * graph exists to close for deletion.
 *
 * WHAT THE REFUSAL IS ALLOWED TO SAY
 *
 * The match itself never leaves this module. A register is written by a human,
 * so its entries ARE the subject's handles — a Slack id, an email address — and
 * the erasure record is forbidden to carry one. Writing the matched entry into
 * the operation row would persist, indefinitely and in the very record that
 * documents a person's destruction, the one value that record must not hold.
 *
 * So a match reports WHERE it was found rather than WHAT was found, and
 * `legalHoldReference` renders that as a register position plus a salted hash
 * of the entry. An operator can find the line of their own register that
 * stopped the erasure; nobody can read the handle back out of the receipt.
 *
 * Pure and dependency-free, like the subject graph: this is a security
 * boundary, so it is testable without a database or an environment.
 */

import type { SubjectKeys } from "./subject-graph";

/**
 * Parse the operator's hold register.
 *
 * Comma-separated, whitespace-tolerant, case-insensitive on match. Empty and
 * blank entries are dropped so a trailing comma cannot produce an empty-string
 * identifier that matches a subject with no aliases.
 */
export function parseLegalHoldList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The register entry that stopped an erasure, and where in the register it sits. */
export interface LegalHoldMatch {
  /**
   * The entry as the operator wrote it.
   *
   * The subject's own handle, so it stays in memory: it is what gets hashed,
   * never what gets stored. See `legalHoldReference`.
   */
  value: string;
  /** 1-based position in the register, as the operator reads it. */
  position: number;
}

/** Prefix every stored hold reference carries, so its shape is recognizable. */
export const LEGAL_HOLD_REFERENCE_PREFIX = "legal-hold-register#";

/**
 * The entry that placed this subject on hold, or null if none did.
 *
 * Returns the match rather than a boolean so the refusal can name which
 * register entry stopped it — an operator seeing "blocked" with no reason
 * cannot tell a hold from a bug.
 */
export function findLegalHold(
  subject: SubjectKeys,
  requestedExternalUserId: string,
  holdList: string[],
): LegalHoldMatch | null {
  if (holdList.length === 0) return null;

  const aliases = new Set(
    [requestedExternalUserId, ...subject.legacyUserIds, ...subject.platosEndUserIds]
      .filter((a): a is string => typeof a === "string" && a.length > 0)
      .map((a) => a.toLowerCase()),
  );

  for (const [index, held] of holdList.entries()) {
    if (aliases.has(held.toLowerCase())) return { value: held, position: index + 1 };
  }
  return null;
}

/**
 * How a matched hold is NAMED in the receipt, the operation row and the audit
 * trail — everywhere the raw entry is forbidden, which is everywhere durable.
 *
 * Two parts, because either alone is too weak. The POSITION is what an operator
 * actually navigates by, but a register is an environment variable somebody
 * will reorder. The HASH is stable and verifiable — the same salted,
 * organization-scoped primitive the receipt identifies its subject by — but on
 * its own it names nothing a human can find. Truncated because this is an
 * identifier to recognize, not a secret to compare in constant time.
 */
export function legalHoldReference(match: LegalHoldMatch, entryHash: string): string {
  return `${LEGAL_HOLD_REFERENCE_PREFIX}${match.position}:${entryHash.slice(0, 12)}`;
}
