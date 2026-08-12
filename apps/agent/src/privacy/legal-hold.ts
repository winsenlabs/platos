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

/**
 * The identifier that placed this subject on hold, or null if none did.
 *
 * Returns the held identifier rather than a boolean so the refusal can name
 * which registry entry stopped it — an operator seeing "blocked" with no
 * reason cannot tell a hold from a bug.
 */
export function findLegalHold(
  subject: SubjectKeys,
  requestedExternalUserId: string,
  holdList: string[],
): string | null {
  if (holdList.length === 0) return null;

  const aliases = new Set(
    [requestedExternalUserId, ...subject.legacyUserIds, ...subject.platosEndUserIds]
      .filter((a): a is string => typeof a === "string" && a.length > 0)
      .map((a) => a.toLowerCase()),
  );

  for (const held of holdList) {
    if (aliases.has(held.toLowerCase())) return held;
  }
  return null;
}
