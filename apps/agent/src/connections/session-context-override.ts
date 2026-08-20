/**
 * What a WebSocket client may put on `scope.sessionContext`, and what it may not.
 *
 * `handleMessage` accepts a `sessionContextOverride` bag off the socket payload
 * — Postman mode, for an operator exercising their own agent against a
 * different per-turn context. It is merged into the scope, and the merged bag is
 * what the prompt resolver substitutes `{{user.name}}` from, what
 * `SpansService.record` copies into `platos_spans_v1.user_display_name`, and
 * what a turn's identity used to be read out of altogether.
 *
 * The sibling knob on the same payload, `postmanUserId`, has always required an
 * OWNER/ADMIN OrgMember lookup. The identity half of this one sat outside that
 * gate, so any authenticated socket could assert a name and an email for
 * somebody else — keyed to the ATTACKER'S end-user id, which means erasing the
 * person actually named in the row never reaches it.
 *
 * So identity keys are held to the same bar as `postmanUserId`. Everything else
 * in the bag — `user_timezone`, `entity_ids`, whatever the operator declared in
 * their context mapping — passes through untouched, because none of it is a
 * claim about who somebody is.
 *
 * This is NOT the signed channel. Even an admin's override is a simulation:
 * `RequestScope.signedUserMeta` is set only from a validated
 * `SessionPayload.userMeta`, and that is the only thing the analytical
 * projection reads plaintext identity from.
 *
 * Pure and dependency-free so the rule is testable without a socket.
 */

/** Flat dotted keys that assert who the turn is for. */
const FLAT_IDENTITY_KEYS = ["user.name", "user.email"] as const;

/** Fields inside a nested `user` object that assert who the turn is for. */
const NESTED_IDENTITY_FIELDS = ["name", "email"] as const;

/** Whether the bag claims a name or an email, in either spelling. */
export function assertsIdentity(override: Record<string, unknown> | undefined | null): boolean {
  if (!override) return false;
  for (const key of FLAT_IDENTITY_KEYS) {
    if (override[key] !== undefined) return true;
  }
  const user = override.user;
  if (!user || typeof user !== "object") return false;
  return NESTED_IDENTITY_FIELDS.some(
    (field) => (user as Record<string, unknown>)[field] !== undefined,
  );
}

/**
 * The bag with every identity claim removed, plus the keys that were dropped.
 *
 * A `user` object emptied by the strip is removed entirely rather than left as
 * `{}`, so an unauthorized override cannot blank out the JWT-supplied
 * `sessionContext.user` it was merged on top of.
 */
export function stripAssertedIdentity(
  override: Record<string, unknown>,
): { sanitized: Record<string, unknown>; removed: string[] } {
  const sanitized: Record<string, unknown> = { ...override };
  const removed: string[] = [];
  for (const key of FLAT_IDENTITY_KEYS) {
    if (sanitized[key] === undefined) continue;
    delete sanitized[key];
    removed.push(key);
  }
  const user = sanitized.user;
  if (user && typeof user === "object") {
    const kept: Record<string, unknown> = { ...(user as Record<string, unknown>) };
    for (const field of NESTED_IDENTITY_FIELDS) {
      if (kept[field] === undefined) continue;
      delete kept[field];
      removed.push(`user.${field}`);
    }
    if (Object.keys(kept).length === 0) delete sanitized.user;
    else sanitized.user = kept;
  }
  return { sanitized, removed };
}
