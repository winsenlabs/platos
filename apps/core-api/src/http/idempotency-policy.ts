// WHICH OPERATIONS THE `Idempotency-Key` CONTRACT BINDS, AND HOW TIGHTLY.
//
// M0.4 §2, in one sentence: "**Idempotency-Key** on all side-effecting
// `POST/PATCH/DELETE`; one-time-secret mints (token/PAT/MCP-token/wire-secret)
// **require** it → `400 IDEMPOTENCY_KEY_REQUIRED`, replay returns same secret +
// `Idempotency-Replayed:true`." That sentence names three classes and this file
// is the three, as DATA rather than as a condition buried in a middleware:
//
//   REQUIRED   the one-time-secret mints. No key, no execution.
//   ACCEPTED   every other side-effecting operation. A key is honoured when one
//              is sent and nothing is refused when one is not.
//   EXEMPT     side-effecting operations the rule CANNOT bind, each named with
//              the reason. An unnamed exemption is a hole; a named one is a
//              decision somebody has to read.
//
// THE TABLE IS JOINED TO A FILE THIS DIMENSION DOES NOT CONTROL.
// `apps/agent/src/control-plane/operation-manifest.generated.json` is the frozen
// surface's own inventory of 300 REST operations, generated from the controllers
// by a different gate. `idempotency-policy.test.ts` asserts that every template
// here names an operation that EXISTS there with that method, and — the half
// that actually bites — that every side-effecting operation there whose path
// speaks of a token, a secret or a key is either REQUIRED here or EXEMPT here
// with a reason. A new secret-minting route on the oracle therefore fails this
// gate until somebody classifies it, which is the only version of this table
// worth having.
//
// WHY TEMPLATES AND NOT PREFIXES. `/api/v1/agent/access-key` is a mint and
// `/api/v1/agent/access-key/origins` is not; a prefix rule would bind both and a
// suffix rule neither. The manifest states templates, so this table states
// templates, and the two are compared as strings.

/** What the contract asks of one operation. */
export type IdempotencyClass = "required" | "accepted" | "exempt" | "not-applicable";

export interface OperationPolicy {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** The manifest's own template, `:param` segments included, compared verbatim. */
  readonly template: string;
  readonly class: "required" | "exempt";
  /**
   * For REQUIRED, which of M0.4 §2's four families this mint belongs to. For
   * EXEMPT, why the rule cannot bind it. Never empty: the table's whole value is
   * that a reader can see why each row is here.
   */
  readonly reason: string;
}

/**
 * The methods that can have a side effect, and therefore a reservation.
 *
 * M0.4 §2 names `POST/PATCH/DELETE`. `PUT` is here as well because the frozen
 * surface has PUT operations that replace a resource, and an idempotency
 * contract that skipped them would be a contract with a hole the ADR's prose did
 * not intend — the sentence enumerates the methods the surface HAD, and the
 * class of the rule is "side-effecting". A GET, HEAD or OPTIONS is
 * `not-applicable`: it has no effect to repeat, and reserving one would make a
 * read fail because a read was already in flight.
 */
export const SIDE_EFFECTING_METHODS: readonly string[] = Object.freeze([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * The one-time-secret mints, and the exemptions.
 *
 * EVERY REQUIRED ROW HANDS THE CALLER A SECRET IT CAN NEVER SEE AGAIN. That is
 * the property M0.4 §2 is protecting: a mint that ran twice on one retry would
 * leave a live credential nobody knows about, and a mint whose response was lost
 * in a timeout would leave the caller unable to recover the one it did create.
 * The key is what makes the retry safe and the recovery possible, which is why
 * this is the one class where its ABSENCE is a refusal.
 */
export const OPERATION_POLICIES: readonly OperationPolicy[] = Object.freeze([
  {
    method: "POST",
    template: "/api/v1/agent/access-key",
    class: "required",
    reason: "PAT — mints the environment access key, returned once and never readable again.",
  },
  {
    method: "POST",
    template: "/api/v1/entities/:entityId/session-tokens",
    class: "required",
    reason: "token — mints a bearer session token for an entity.",
  },
  {
    method: "POST",
    template: "/api/v1/public/guest-token",
    class: "required",
    reason: "token — mints a guest bearer token on the public transport.",
  },
  {
    method: "POST",
    template: "/mcp/platform/tokens",
    class: "required",
    reason: "MCP-token — mints a platform MCP token.",
  },
  {
    method: "POST",
    template: "/mcp/entity/:entityId/tokens",
    class: "required",
    reason: "MCP-token — mints an entity-scoped MCP token.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/entities/:entityId/regenerate-secret",
    class: "required",
    reason: "wire-secret — rotates the entity signing secret and returns the new value once.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/channels/:id/rotate-secret",
    class: "required",
    reason: "wire-secret — rotates a channel's webhook secret and returns the new value once.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/providers/keys/:id/rotate-secret",
    class: "required",
    reason: "wire-secret — rotates a provider key and returns the new value once.",
  },
  // ------------------------------------------------------------------
  // EXEMPT. Each of these is side-effecting AND speaks of a token or a secret,
  // so each would otherwise be caught by the join in the suite. They are here
  // because the rule genuinely cannot bind them, not because binding them was
  // inconvenient.
  // ------------------------------------------------------------------
  {
    method: "POST",
    template: "/oauth/token",
    class: "exempt",
    reason:
      "RFC 6749 §3.2 fixes this request: the parameters are the grant, and a server that refused a token request for a missing vendor header would not be an OAuth server. Replay protection here is the grant's own single-use rule, which the authorization-code exchange already enforces.",
  },
  {
    method: "POST",
    template: "/oauth/entity/:entityId/token",
    class: "exempt",
    reason:
      "The same RFC 6749 exchange, scoped to one entity. Exempt for the same reason and no other.",
  },
  {
    method: "POST",
    template: "/api/v1/channels/inbound/:connectionId/:webhookSecret",
    class: "exempt",
    reason:
      "Inbound webhook ingress. The caller is a third-party platform that will never send a Platos header, and the secret in the path is the CALLER proving itself to us rather than a secret we mint. Its replay defence is the per-provider signature and delivery id the channel adapter checks.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/durable-approvals/:token/resolve",
    class: "exempt",
    reason:
      "The durable token in the path IS the idempotency key: M0.4 §1 freezes it across all majors and the resolve is single-use by construction, so a second header would be a second key for one decision.",
  },
  {
    method: "POST",
    template: "/mcp/platform/tokens/:id/revoke",
    class: "exempt",
    reason:
      "Revocation, not a mint. It is naturally idempotent — a token revoked twice is revoked — and it returns no secret, so there is nothing a replay could hand back that a re-execution would not.",
  },
  {
    method: "DELETE",
    template: "/mcp/entity/:entityId/tokens/:tokenId",
    class: "exempt",
    reason:
      "Deletion of a named token. Idempotent by identity — the second call addresses a row that is already gone — and it returns no secret.",
  },
  {
    method: "DELETE",
    template: "/api/v1/agent/access-key",
    class: "exempt",
    reason:
      "Revocation of the access key. Idempotent by identity and returns no secret; only the POST that MINTS one is required.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/access-key/origins",
    class: "exempt",
    reason:
      "Sets the allowed origins of an existing key. It mints nothing and returns no secret; the path shares a prefix with the mint and nothing else.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/providers/keys",
    class: "exempt",
    reason:
      "Stores a provider key the CALLER supplies (BYOK). The secret travels inbound and is never returned, so a replay has no secret to hand back — the caller already holds it.",
  },
  {
    method: "POST",
    template: "/api/v1/agent/providers/keys/byok",
    class: "exempt",
    reason: "The same inbound BYOK write under its explicit path. Exempt for the same reason.",
  },
  {
    method: "PATCH",
    template: "/api/v1/agent/providers/keys/:id",
    class: "exempt",
    reason: "Edits a stored provider key's metadata. Mints nothing and returns no secret.",
  },
  {
    method: "DELETE",
    template: "/api/v1/agent/providers/keys/:id",
    class: "exempt",
    reason: "Deletes a stored provider key. Idempotent by identity and returns no secret.",
  },
]);

/** A manifest template compiled to a matcher over a concrete request path. */
export interface CompiledPolicy extends OperationPolicy {
  readonly pattern: RegExp;
}

/**
 * Compile `:param` templates to anchored patterns.
 *
 * A parameter matches one segment and never a slash, so
 * `/api/v1/agent/access-key` cannot be matched by the `access-key/origins`
 * template and vice versa. Everything else is escaped: a template is DATA from
 * this file and from the manifest, and treating it as a pattern would make a dot
 * in a future route silently match any character.
 */
export function compileTemplate(template: string): RegExp {
  const source = template
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`),
    )
    .join("/");
  return new RegExp(`^${source}/?$`, "u");
}

export const COMPILED_POLICIES: readonly CompiledPolicy[] = Object.freeze(
  OPERATION_POLICIES.map((policy) => Object.freeze({ ...policy, pattern: compileTemplate(policy.template) })),
);

/**
 * The class of one concrete request.
 *
 * TAKES A PATHNAME, NOT A URL. The query string is not part of an operation's
 * identity — `?ttl=300` on a session-token mint is still that mint — and a
 * matcher that saw it would fail to classify every request that carried one.
 * The caller strips it, because the caller is the one holding the raw URL.
 */
export function classifyRequest(method: string, pathname: string): IdempotencyClass {
  const normalized = method.toUpperCase();
  if (!SIDE_EFFECTING_METHODS.includes(normalized)) return "not-applicable";
  for (const policy of COMPILED_POLICIES) {
    if (policy.method !== normalized) continue;
    if (policy.pattern.test(pathname)) return policy.class;
  }
  // THE DEFAULT IS `accepted`, NOT `required`, AND NOT `exempt`. M0.4 §2 puts the
  // header on ALL side-effecting operations and requires it on a named few, so a
  // route nobody has classified still honours a key a caller sends. Defaulting to
  // `required` would refuse three hundred operations the ADR does not refuse;
  // defaulting to `exempt` would silently drop a key a caller sent in good faith.
  return "accepted";
}

/** The operation identity a reservation is scoped by. The TEMPLATE where one
 * matches, so two ids of the same operation share a scope and two different
 * operations never do; the concrete path otherwise, which is the narrowest
 * honest answer for a route this table has not seen. */
export function operationScope(method: string, pathname: string): string {
  const normalized = method.toUpperCase();
  for (const policy of COMPILED_POLICIES) {
    if (policy.method !== normalized) continue;
    if (policy.pattern.test(pathname)) return `${normalized} ${policy.template}`;
  }
  return `${normalized} ${pathname}`;
}
