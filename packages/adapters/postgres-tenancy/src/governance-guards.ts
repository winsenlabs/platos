// What the real database refuses, checked BEFORE the statement is sent.
//
// WHY BEFORE. On PostgreSQL a statement that violates a constraint ABORTS the
// enclosing transaction: every later statement fails with 25P02 until the block
// ends. Four of this context's five ports take the CALLER's `TransactionScope`,
// and `rate-turn.ts` writes a rating inside the same unit of work that reads the
// turn back — so a store that let the `MessageRating_rating_check` raise would
// have reported the refusal correctly and left the caller unable to write
// anything else. `cost-guards.ts` found the same thing on the same database; the
// answer is the same. Refuse in TypeScript, send nothing, keep the transaction.
//
// EVERY GUARD BELOW IS A CONSTRAINT THAT EXISTS ONLY IN THE MIGRATIONS OR ONLY
// IN THE COLUMN TYPE, AND THAT NO IN-MEMORY DOUBLE IN THIS CONTEXT HOLDS.
//
//   `@db.Uuid` on all five primary keys and on every foreign key they carry.
//   `InMemorySafetyLedger` mints `safety-0001`, `InMemoryRatingsRepository`
//   mints `rating-0001`, `InMemoryCriteriaRepository` `criterion-0001`,
//   `InMemoryEvalsRepository` `eval-0001` and `InMemoryGoldenSetsRepository`
//   `golden-0001`. Every one of those is accepted by its double and refused by
//   PostgreSQL, and every use-case suite in the context passes with them.
//
//   `MessageRating_rating_check`, whose text this file had to read TWICE. See
//   `RATING_NOT_THUMBS` below: the initial migration installs one constraint on
//   that column and then, 1,000 lines later in the SAME FILE, drops it and
//   installs a different one. An adapter written against the first would refuse
//   every thumbs-down the product emits.
//
//   `MessageRating_revision_check CHECK ("revision" > 0)`, installed by the same
//   later block, on a column added by the same later block.
//
//   `Int` is int4. `revision`, `latencyMs`, `scoreScaleMin` and `scoreScaleMax`
//   are all `Int`, and JavaScript hands the driver a `number` that may be 2^53.
//
//   `Float` is double precision, which stores `NaN` — so `AgentEval.score` would
//   accept one, and every mean taken over that column afterwards would be `NaN`
//   with no error anywhere. Refused here rather than stored.
//
//   `Decimal(18, 6)` on `AgentEval.costCents`. Eighteen significant digits with
//   six after the point; a larger magnitude is a numeric field overflow, and a
//   longer fraction is silently ROUNDED by the database rather than refused,
//   which is worse.
//
//   `SafetyEvent_metadata_json_root CHECK (jsonb_typeof = 'object')`, plus the
//   envelope's own reserved marker.
//
// EVERY REFUSAL HAS ITS OWN CODE. Two guards sharing one code cannot be told
// apart in a log, which is how two defects hid behind one code in `privacy` and
// in `identity-access`.

import type {
  AdmittedEval,
  AdmittedSafetyEvent,
  JsonValue,
} from "@platos/context-governance/application/ports/index.js";

import { SAFETY_METADATA_MARKER } from "./governance-rows.js";

/**
 * An identifier bound for a `@db.Uuid` column that is not a uuid.
 *
 * Prefixed, unlike its eight siblings, because `cost-guards.ts` publishes an
 * `IDENTIFIER_NOT_UUID` of its own from the same package entry point. The two
 * are different guards over different tables and their CODE strings already
 * differ; the exported names have to as well, or the entry point would publish
 * one name for two refusals — which is the thing distinct codes exist to
 * prevent, one layer up.
 */
export const GOVERNANCE_IDENTIFIER_NOT_UUID = "governance.write.identifier_not_uuid";

/**
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
export const RATING_NOT_THUMBS = "governance.write.rating_not_thumbs";

/**
 * `MessageRating.revision` is not a positive int4.
 *
 * `MessageRating_revision_check CHECK ("revision" > 0)` is installed by the same
 * later block that corrects the rating constraint, on a column that block adds.
 * The int4 half is the column TYPE and has no CHECK of its own.
 */
export const RATING_REVISION_INVALID = "governance.write.rating_revision_invalid";

/** A producer's metadata object carries the envelope's reserved marker. */
export const SAFETY_METADATA_RESERVED = "governance.write.safety_metadata_reserved";

/** `AgentEval.score` is not a finite double. */
export const EVAL_SCORE_NOT_FINITE = "governance.write.eval_score_not_finite";

/** `AgentEval.costCents` does not fit `Decimal(18, 6)` without being rounded. */
export const EVAL_COST_NOT_REPRESENTABLE = "governance.write.eval_cost_not_representable";

/** `AgentEval.latencyMs` is not a non-negative int4. */
export const EVAL_LATENCY_INVALID = "governance.write.eval_latency_invalid";

/** A criterion scale bound is not an int4. */
export const CRITERION_SCALE_NOT_REPRESENTABLE = "governance.write.criterion_scale_not_representable";

export class GovernanceWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "GovernanceWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The canonical uuid shape, as the database itself parses it.
 *
 * Deliberately the same expression `PostmanExecution_contextHandle_check` uses
 * in the migrations rather than a looser hex-and-dashes pattern: PostgreSQL's
 * `uuid` input accepts several spellings, and a guard that admitted one the
 * `@db.Uuid` column then rejected would be a guard that does not guard.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Refuse a value bound for a `@db.Uuid` column. `null` is always allowed. */
export function requireUuid(column: string, value: string | null): void {
  if (value === null) return;
  if (!isUuid(value)) {
    throw new GovernanceWriteRefused(GOVERNANCE_IDENTIFIER_NOT_UUID, `${column} is not a uuid: ${JSON.stringify(value)}`);
  }
}

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

function isInt4(value: number): boolean {
  return Number.isInteger(value) && value >= INT4_MIN && value <= INT4_MAX;
}

/**
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
}

export function requireStorableRevision(value: number): void {
  if (!isInt4(value) || value < 1) {
    throw new GovernanceWriteRefused(
      RATING_REVISION_INVALID,
      `MessageRating.revision must satisfy CHECK (revision > 0) and fit int4; received ${String(value)}`,
    );
  }
}

/**
 * Refuse a producer's metadata that carries the envelope marker.
 *
 * Only the ROOT is inspected. A nested `__governance` is a detector attribute
 * that happens to share a name and reads back unchanged, because
 * `readSafetyEnvelope` only ever looks at the root.
 */
export function requireUnreservedMetadata(metadata: Readonly<Record<string, JsonValue>> | null): void {
  if (metadata === null) return;
  if (Object.prototype.hasOwnProperty.call(metadata, SAFETY_METADATA_MARKER)) {
    throw new GovernanceWriteRefused(
      SAFETY_METADATA_RESERVED,
      `SafetyEvent.metadata may not carry the reserved key ${SAFETY_METADATA_MARKER} at its root`,
    );
  }
}

/** Everything a safety append must satisfy before a statement is sent. */
export function guardSafetyAppend(event: AdmittedSafetyEvent): void {
  requireUuid("SafetyEvent.agentId", event.agentId);
  requireUuid("SafetyEvent.threadId", event.threadId);
  requireUuid("SafetyEvent.turnId", event.turnId);
  requireUnreservedMetadata(event.metadata);
}

/**
 * `Decimal(18, 6)`: eighteen significant digits, six of them after the point.
 *
 * The fraction is checked as well as the magnitude because PostgreSQL ROUNDS a
 * longer fraction rather than refusing it. A cost of `0.0000005` would be stored
 * as `0.000001`, read back as a different number than was written, and no error
 * would be raised at any layer — which is the silent kind of wrong this
 * programme refuses to ship.
 */
export function requireStorableCost(value: number | null): void {
  if (value === null) return;
  if (!Number.isFinite(value)) {
    throw new GovernanceWriteRefused(
      EVAL_COST_NOT_REPRESENTABLE,
      `AgentEval.costCents must be finite; received ${String(value)}`,
    );
  }
  if (Math.abs(value) >= 1e12) {
    throw new GovernanceWriteRefused(
      EVAL_COST_NOT_REPRESENTABLE,
      `AgentEval.costCents exceeds Decimal(18, 6); received ${String(value)}`,
    );
  }
  const rendered = value.toFixed(6);
  if (Number(rendered) !== value) {
    throw new GovernanceWriteRefused(
      EVAL_COST_NOT_REPRESENTABLE,
      `AgentEval.costCents would be rounded by Decimal(18, 6); received ${String(value)}`,
    );
  }
}

export function guardEvalAppend(admitted: AdmittedEval): void {
  requireUuid("AgentEval.agentId", admitted.agentId);
  requireUuid("AgentEval.agentVersionId", admitted.agentVersionId);
  requireUuid("AgentEval.threadId", admitted.threadId);
  requireUuid("AgentEval.turnId", admitted.turnId);
  requireUuid("AgentEval.criterionId", admitted.criterionId);
  if (!Number.isFinite(admitted.score)) {
    throw new GovernanceWriteRefused(
      EVAL_SCORE_NOT_FINITE,
      `AgentEval.score must be finite; received ${String(admitted.score)}`,
    );
  }
  if (!isInt4(admitted.latencyMs) || admitted.latencyMs < 0) {
    throw new GovernanceWriteRefused(
      EVAL_LATENCY_INVALID,
      `AgentEval.latencyMs must be a non-negative int4; received ${String(admitted.latencyMs)}`,
    );
  }
  requireStorableCost(admitted.costCents);
  requireStorableScale(admitted.criterionSnapshot.scoreScaleMin, admitted.criterionSnapshot.scoreScaleMax);
}

export function requireStorableScale(minimum: number, maximum: number): void {
  if (!isInt4(minimum) || !isInt4(maximum)) {
    throw new GovernanceWriteRefused(
      CRITERION_SCALE_NOT_REPRESENTABLE,
      `EvalCriterion score scale must be int4; received ${String(minimum)}..${String(maximum)}`,
    );
  }
}
