/**
 * EOBD.15 — scoped Redis namespace for approval decisions.
 *
 * Approval IDs used to key a global Redis namespace (`approval:${id}`).
 * Any caller with a known approvalId could rpush to that key and wake
 * a blpop in another scope — cross-tenant approval injection.
 *
 * The new key includes the full scope tuple so a blpop in scope A
 * cannot be woken by an rpush from scope B, even if the HTTP/WS
 * resolvers' scope checks are ever bypassed.
 */
export interface ApprovalScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

/** Canonical Redis key for an approval decision. */
export function approvalRedisKey(scope: ApprovalScope, approvalId: string): string {
  return `approval:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${approvalId}`;
}

/** Redis key for cross-scope approval broadcast events (unchanged). */
export const APPROVAL_EVENT_CHANNEL = "approval:event";
