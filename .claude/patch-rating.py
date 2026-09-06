import re

B = "packages/adapters/postgres-tenancy/src/"

# ---------------------------------------------------------------- guards
p = B + "governance-guards.ts"
s = open(p).read()

s = s.replace(
    '''//   `MessageRating_rating_check CHECK ("rating" BETWEEN 1 AND 5)`. See
//   `RATING_OUTSIDE_SCHEMA_RANGE` below; this is the one guard that refuses a
//   value the DOMAIN considers valid, and it is reported rather than encoded
//   around.''',
    '''//   `MessageRating_rating_check`, whose text this file had to read TWICE. See
//   `RATING_NOT_THUMBS` below: the initial migration installs one constraint on
//   that column and then, 1,000 lines later in the SAME FILE, drops it and
//   installs a different one. An adapter written against the first would refuse
//   every thumbs-down the product emits.
//
//   `MessageRating_revision_check CHECK ("revision" > 0)`, installed by the same
//   later block, on a column added by the same later block.''',
)

s = s.replace(
    '''/**
 * A rating the canonical CHECK constraint does not admit.
 *
 * THIS IS THE ONE PLACE THE PORT'S CONTRACT AND THE DATABASE DISAGREE, and the
 * disagreement is reported rather than encoded around. `domain/rating.ts`
 * declares `RatingValue = 1 | -1` and calls the pair "the only two values the
 * column may hold"; the migration declares
 * `CHECK ("rating" BETWEEN 1 AND 5)`, which admits `1` and refuses `-1`. So a
 * thumbs-UP stores and a thumbs-DOWN cannot, and there is no honest way for an
 * adapter to make one fit: mapping `-1` onto some value in `1..5` would put a
 * number in the column that `domain/rating.ts`'s own `tally` counts as
 * `discarded`, and would make the stored row disagree with the vote that
 * produced it. The refusal is named, returned as a `Result`, and reported.
 */
export const RATING_OUTSIDE_SCHEMA_RANGE = "governance.write.rating_outside_schema_range";''',
    '''/**
 * A rating that is not a thumb.
 *
 * *** READ THE MIGRATION TO ITS END, AND THIS IS WHY. *** The initial migration
 * installs `MessageRating_rating_check CHECK ("rating" BETWEEN 1 AND 5)` at line
 * 2799 — a five-star scale — and then at line 3802, in the SAME FILE, DROPS that
 * constraint and installs `CHECK ("rating" IN (-1, 1))` in its place, behind a
 * preflight block that REFUSES TO BUILD THE DATABASE AT ALL if any existing row
 * holds 2, 3, 4 or 5. The migration's own comment says why: "MessageRating has
 * always been exposed by the product as thumbs feedback... repository history
 * defines no safe star-scale interpretation for those values."
 *
 * So the deployed column admits exactly `domain/rating.ts`'s `RatingValue`, and
 * an adapter written against the FIRST reading of that file would have refused
 * every thumbs-down the product emits while storing four values no database
 * this migration builds can hold. The guard below restates the constraint that
 * actually ships.
 */
export const RATING_NOT_THUMBS = "governance.write.rating_not_thumbs";''',
)

s = s.replace(
    '''/** `MessageRating.revision` is not a positive int4. */''',
    '''/**
 * `MessageRating.revision` is not a positive int4.
 *
 * `MessageRating_revision_check CHECK ("revision" > 0)` is installed by the same
 * later block that corrects the rating constraint, on a column that block adds.
 * The int4 half is the column TYPE and has no CHECK of its own.
 */''',
)

s = s.replace(
    '''/**
 * The rating value guard.
 *
 * The bound is the CHECK's, not the domain's, because the CHECK is what the
 * write meets. A caller handing `3` — a legacy five-star value the domain does
 * not mint but the column holds — is therefore ADMITTED, which is what keeps the
 * adapter able to write a row an older binary could also have written.
 */
export function requireStorableRating(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new GovernanceWriteRefused(
      RATING_OUTSIDE_SCHEMA_RANGE,
      `MessageRating.rating must satisfy CHECK (rating BETWEEN 1 AND 5); received ${String(value)}`,
    );
  }
}''',
    '''/**
 * The rating value guard, which restates the constraint the migration ENDS with.
 *
 * A caller handing `3` — the five-star value the FIRST constraint in that file
 * admitted — is refused here, before a statement is sent, because the deployed
 * column refuses it too and a raised CHECK would take the caller's transaction
 * with the answer.
 */
export function requireStorableRating(value: number): void {
  if (value !== 1 && value !== -1) {
    throw new GovernanceWriteRefused(
      RATING_NOT_THUMBS,
      `MessageRating.rating must satisfy CHECK (rating IN (-1, 1)); received ${String(value)}`,
    );
  }
}''',
)

s = s.replace(
    '''  if (!isInt4(value) || value < 1) {
    throw new GovernanceWriteRefused(
      RATING_REVISION_INVALID,
      `MessageRating.revision must be a positive int4; received ${String(value)}`,
    );''',
    '''  if (!isInt4(value) || value < 1) {
    throw new GovernanceWriteRefused(
      RATING_REVISION_INVALID,
      `MessageRating.revision must satisfy CHECK (revision > 0) and fit int4; received ${String(value)}`,
    );''',
)
open(p, "w").write(s)

# ---------------------------------------------------------------- rows
p = B + "governance-rows.ts"
s = open(p).read()
s = s.replace(
    '''/**
 * A stored rating, carried through as the domain's `RatingValue`.
 *
 * NOT VALIDATED, and that is the one place in this file the asymmetry is
 * deliberate. `domain/rating.ts` declares `RatingValue = 1 | -1` and its own
 * `tally` counts anything else as `discarded` rather than refusing it, because
 * the source's five-star rows are real history — and `MessageRating_rating_check`
 * in the migrations admits exactly `1..5`, so those rows are the ONLY ones an
 * install can have. Refusing them here would make a satisfaction rollup
 * unreadable for exactly the installs that have data.
 */''',
    '''/**
 * A stored rating, carried through as the domain's `RatingValue`.
 *
 * NOT VALIDATED, and that is the one place in this file the asymmetry is
 * deliberate. The deployed `MessageRating_rating_check CHECK ("rating" IN
 * (-1, 1))` admits exactly the domain's two values, so a row outside them is
 * not a row an older binary wrote — it is a row no database this migration
 * builds can hold. `domain/rating.ts`'s own `tally` nonetheless counts anything
 * else as `discarded` rather than dropping it, and refusing the row HERE would
 * take that defence away: an unreadable row would make the whole rollup
 * unreadable, where a discarded one is visible beside the total it is not in.
 */''',
)
open(p, "w").write(s)

# ---------------------------------------------------------------- ratings store
p = B + "governance-ratings.ts"
s = open(p).read()
s = s.replace(
    '''// *** THE PORT'S CONTRACT AND THE DATABASE DISAGREE HERE, AND IT IS REPORTED ***
// `domain/rating.ts` declares `RatingValue = 1 | -1` — "the only two values the
// column may hold" — and `admitRatingValue` refuses everything else. The
// migrations declare `MessageRating_rating_check CHECK ("rating" BETWEEN 1 AND
// 5)`. `1` satisfies both. `-1` satisfies the domain and is REFUSED BY THE
// DATABASE, so a thumbs-DOWN cannot be stored by any adapter over this schema.
//
// It is refused by name in `governance-guards.ts` rather than encoded around.
// Mapping `-1` onto some value inside `1..5` would put a number in the column
// that `domain/rating.ts`'s own `tally` counts as `discarded`, would make
// `readVersionSatisfaction` — the rollup a canary decision is taken on — disagree
// with the votes that produced it, and would be exactly the "invent a plausible
// value" the acceptance forbids. The refusal is a named case in
// `governance-constraints.integration.test.ts` and is reported to the
// integrator.''',
    '''// *** THE MIGRATION CHANGES ITS OWN MIND ABOUT THIS COLUMN, AND THAT IS THE
// FINDING. *** `00000000000000_initial/migration.sql` installs
// `MessageRating_rating_check CHECK ("rating" BETWEEN 1 AND 5)` at line 2799,
// and at line 3802 — in the SAME FILE, 1,000 lines later — DROPS it and installs
// `CHECK ("rating" IN (-1, 1))`, behind a preflight block that refuses to build
// the database at all if any row holds 2, 3, 4 or 5. It adds `revision` and
// `CHECK ("revision" > 0)` in the same breath.
//
// A reader who stopped at the first constraint would have written an adapter
// that refused every thumbs-DOWN the product emits and accepted four values no
// database this migration builds can hold. `governance-guards.ts` restates the
// constraint the file ENDS with, and the pair of named cases in
// `governance-constraints.integration.test.ts` stands both halves side by side:
// `-1` is stored, `3` is refused.''',
)
s = s.replace(
    '''import {
  requireStorableRating,''',
    '''import {
  requireStorableRating,''',
)
open(p, "w").write(s)

# ---------------------------------------------------------------- entry point
p = B + "index.ts"
s = open(p).read()
s = s.replace("  RATING_OUTSIDE_SCHEMA_RANGE,\n", "  RATING_NOT_THUMBS,\n")
s = s.replace(
    "  GOVERNANCE_IDENTIFIER_NOT_UUID,\n  GovernanceWriteRefused,\n  RATING_NOT_THUMBS,\n  RATING_REVISION_INVALID,",
    "  GOVERNANCE_IDENTIFIER_NOT_UUID,\n  GovernanceWriteRefused,\n  RATING_NOT_THUMBS,\n  RATING_REVISION_INVALID,",
)
open(p, "w").write(s)
print("patched guards, rows, ratings, index")
