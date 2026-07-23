/**
 * IDENTITY-CORE §A.2 — the frozen resolver rule, as ONE shared source of truth.
 *
 * `{{endUserId}}` is the customer-meaningful external identity substituted into
 * a `connectionKind="mcp"` server's URL/headers at dispatch (Composio's
 * `user_id`). It is derived from a PlatosEndUser as:
 *
 *   endUserId = firstNonEmpty(linkedExternalId, externalUserId)
 *
 * where an empty / whitespace-only string is treated as UNSET. When the adopted
 * `linkedExternalId` is present it is PREFERRED (this is the whole point of
 * external-id adoption); otherwise we fall back to the opaque `externalUserId`,
 * reproducing pre-adoption behaviour byte-for-byte. When neither is usable the
 * result is `null` — the caller must then FAIL CLOSED (never substitute a
 * default, an org id, or `scope.userId`).
 *
 * Extracted as a pure function (mirroring `hasResidualEndUserTemplate`) so the
 * two resolvers — `resolveOriginEndUserId` (origin turn) and
 * `resolveEndUserIdForScope` (inbound MCP-as-server) — cannot drift.
 */
export function pickExternalId(
  linkedExternalId: string | null | undefined,
  externalUserId: string | null | undefined,
): string | null {
  return linkedExternalId?.trim() || externalUserId?.trim() || null;
}
