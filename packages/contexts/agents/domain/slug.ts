// Slugs, and the one collision rule the running system uses.
//
// Two rows in this context carry a slug inside a uniqueness constraint —
// `Agent` (unique per PROJECT) and `AgentCluster` (unique per ENVIRONMENT) —
// and both derive it the same way from a display name.
//
// THE DERIVATION IS TRANSCRIBED, INCLUDING WHAT IT DROPS. Lower-case, then every
// run of characters outside `[a-z0-9]` becomes one hyphen, then leading and
// trailing hyphens are trimmed. A name written entirely outside that alphabet
// therefore derives to the EMPTY string, which is a legal `String` column value
// and an illegible slug. The source writes it; `deriveSlug` returns it; and
// `admitSlug` is the separate, explicit call a use case makes when it wants that
// case refused instead. Keeping them apart is what lets the projection of an
// existing row stay faithful while a new row is held to a rule.
//
// THE COLLISION RULE IS A PARAMETER, NOT A CLOCK READ. The source appends
// `Date.now().toString(36)` to a taken slug. That is a wall-clock read inside a
// write path, so it is hoisted out: `disambiguateSlug` takes the token, and the
// use case supplies one derived from the kernel `Clock`. The FORMAT is
// preserved exactly — base-36 milliseconds — so a slug minted here is
// indistinguishable from one the running system minted.

import { err, ok, type Result } from "@platos/kernel";

import { agentMetadataInvalid } from "./errors.js";
import { asAgentsIdentifier, type Slug } from "./identifiers.js";

/** Ceiling on a derived or supplied slug. The column is unbounded; a name is not. */
export const MAX_SLUG_LENGTH = 200;

const OUTSIDE_ALPHABET = /[^a-z0-9]+/gu;
const EDGE_HYPHENS = /^-|-$/gu;

/**
 * Derive a slug from a display name.
 *
 * Total by construction: every string has a derivation, and the empty one is a
 * legitimate answer that `admitSlug` — not this function — decides about.
 */
export function deriveSlug(name: string): string {
  return name.toLowerCase().replace(OUTSIDE_ALPHABET, "-").replace(EDGE_HYPHENS, "");
}

/**
 * Admit a slug for a NEW row: derived from the name, or supplied verbatim.
 *
 * A supplied slug is trimmed and length-checked and otherwise passes through
 * unchanged, which is what the source does — it never re-derives an
 * operator-supplied slug. That is preserved deliberately: re-deriving would
 * silently rewrite a slug an operator typed and, with it, the URL of an agent
 * they had already shared.
 */
export function admitSlug(name: string, supplied: string | null | undefined): Result<Slug> {
  const candidate = supplied === undefined || supplied === null || supplied.trim() === ""
    ? deriveSlug(name)
    : supplied.trim();
  if (candidate === "") {
    return err(
      agentMetadataInvalid("slug could not be derived from the name", [
        { field: "slug", code: "required", message: "name must contain at least one letter or digit" },
      ]),
    );
  }
  if (candidate.length > MAX_SLUG_LENGTH) {
    return err(
      agentMetadataInvalid(`slug must be at most ${MAX_SLUG_LENGTH} characters`, [
        { field: "slug", code: "too_long", message: `slug must be at most ${MAX_SLUG_LENGTH} characters` },
      ]),
    );
  }
  return ok(asAgentsIdentifier<Slug>(candidate));
}

/**
 * The token appended to a taken slug: base-36 milliseconds, exactly as the
 * source spells it. An input before the epoch has no base-36 form the source
 * would produce, so it is clamped to zero rather than emitting a `-` sign into
 * the middle of a slug.
 */
export function collisionToken(at: Date): string {
  return Math.max(0, at.getTime()).toString(36);
}

/** `<base>-<token>`. Separated from the token so the format is testable alone. */
export function disambiguateSlug(base: Slug, token: string): Slug {
  return asAgentsIdentifier<Slug>(`${base}-${token}`);
}

/**
 * Resolve the slug a new row should carry, given the slugs already taken in the
 * constraint's scope.
 *
 * ONE ROUND, NOT A LOOP, because that is what the source does: if the base is
 * taken it appends the token and writes. Two rows created in the same
 * millisecond with the same base would collide again and the store's unique
 * index — not this function — is what refuses the second. Making that explicit
 * is the point: a caller reading this cannot believe the collision is fully
 * handled here.
 */
export function resolveSlug(base: Slug, taken: readonly string[], at: Date): Slug {
  return taken.includes(base) ? disambiguateSlug(base, collisionToken(at)) : base;
}
