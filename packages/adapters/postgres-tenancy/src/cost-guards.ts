// The invariants PostgreSQL enforces on `cost-monitoring`'s six rows that the
// port's TYPES cannot, checked on the way in so each refusal has a name.
//
// WHY THIS FILE EXISTS, and it is the same argument `identity-guards.ts` makes
// one context over. Every constraint restated below lives in
// `internal-packages/tenancy-database/prisma/migrations/`. NONE of them is in
// `schema.prisma`, so none is in the generated client's types; and none is in
// `InMemoryBudgetRepository`, the double this context ships, so none is in any
// use-case suite in the tree. The double's own fixtures prove the point:
// `testBudget` mints `budget-1` for a column that is `@db.Uuid`, and
// `SequenceIdGenerator.uuid()` mints `id-0001`. Both type-check, both satisfy
// the fake, and PostgreSQL refuses both.
//
// THE DATABASE REMAINS AUTHORITATIVE. These are not a replacement for the
// constraints and may not disagree with them:
// `cost-constraints.integration.test.ts` removes each guard and shows PostgreSQL
// refusing the same input, so a guard that drifted looser is caught there, and
// one that drifted tighter is caught by the conformance run going red on a value
// the database accepts. What the guard buys is a NAMED refusal at the call site
// instead of a driver error carrying a constraint name and a SQLSTATE.
//
// ELEVEN REFUSALS, ELEVEN CODES. A shared code would make "this identifier is
// not a uuid", "this cap exceeds an INTEGER", "this channel subscribes to
// nothing" and "this settled delivery still carries a failure token"
// indistinguishable in a log, and they have eleven causes and eleven fixes. That
// is `cost-monitoring`'s own lesson: `domain/errors.ts` publishes ONE code —
// `COST_REPOSITORY_UNAVAILABLE` — for every way a store can refuse, so a
// `Result` cannot carry this distinction at all. It is carried here instead, as
// a thrown refusal, which is what the port's "a rejected promise is a defect,
// not an outcome" leaves room for: an identifier that is not a uuid is a defect
// in the caller, not a business outcome the caller is entitled to see as data.

/** A column declared `@db.Uuid` was handed something that is not one. */
export const IDENTIFIER_NOT_UUID = "cost.write.identifier_not_uuid";

/** A cap's cent or turn ceiling is outside the INTEGER column that holds it. */
export const BUDGET_LIMIT_OUT_OF_RANGE = "cost.write.budget_limit_out_of_range";

/** `Budget.alertThresholds` is not an array of admissible whole percentages. */
export const BUDGET_THRESHOLDS_INVALID = "cost.write.budget_thresholds_invalid";

/** `BudgetThresholdEvent_values_check`: threshold, spend, runs or window key. */
export const CROSSING_VALUES_INVALID = "cost.write.crossing_values_invalid";

/** A crossing's exact `Money` spend would not survive a DOUBLE PRECISION column. */
export const CROSSING_SPEND_NOT_REPRESENTABLE = "cost.write.crossing_spend_not_representable";

/** `AlertChannel_name_check`: `length(btrim(name)) BETWEEN 1 AND 200`. */
export const CHANNEL_NAME_INVALID = "cost.write.channel_name_invalid";

/** `AlertChannel_alert_types_check`: `cardinality(alertTypes) > 0`. */
export const CHANNEL_TOPICS_EMPTY = "cost.write.channel_topics_empty";

/** `AlertChannel_dedupe_check`: the key and its operator-supplied flag disagree. */
export const CHANNEL_DEDUPE_SHAPE_INVALID = "cost.write.channel_dedupe_shape_invalid";

/** `AlertDelivery_kind_shape_check`: a `TEST` names a crossing, or a `BUDGET` does not. */
export const DELIVERY_KIND_SHAPE_INVALID = "cost.write.delivery_kind_shape_invalid";

/** `AlertDelivery_state_check`: status, delivery instant and failure token disagree. */
export const DELIVERY_STATE_INCOHERENT = "cost.write.delivery_state_incoherent";

/** The append-only send record's own state check, as this context spells it. */
export const RETRY_RECORD_INVALID = "cost.write.retry_record_invalid";

export class CostWriteRefused extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, message: string) {
    super(message);
    this.name = "CostWriteRefused";
    this.code = code;
    this.column = column;
  }
}

/**
 * Every id column on these six rows is `@db.Uuid`, and PostgreSQL PARSES the
 * value rather than storing the bytes it was given.
 *
 * The pattern is the canonical 8-4-4-4-12 hexadecimal form, case-insensitively.
 * `uuid_in` also accepts a braced and a `urn:uuid:` form, and both are refused
 * here deliberately: the column would store the UNWRAPPED value, so a later read
 * would not compare equal to the string the caller wrote, and `findBudget` would
 * miss a row it had just inserted.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function requireUuid(column: string, value: string): string {
  if (!UUID.test(value)) {
    throw new CostWriteRefused(
      IDENTIFIER_NOT_UUID,
      column,
      `${column} is a uuid column; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The same check where the column is nullable. */
export function requireUuidOrNull(column: string, value: string | null): string | null {
  return value === null ? null : requireUuid(column, value);
}

/** PostgreSQL `INTEGER`. `Budget.limitCents` and `Budget.turnsLimit` are both one. */
const INTEGER_MAX = 2_147_483_647;

/**
 * A cap's two ceilings.
 *
 * `domain/budget.ts` admits any non-negative whole number, and says so: its
 * `admitLimit` checks `Number.isInteger(value) && value >= 0` and stops. A
 * ten-trillion-cent cap therefore passes admission, satisfies the double, and is
 * refused by the column with SQLSTATE 22003 — which arrives as a driver error
 * naming neither the cap nor the field.
 */
export function requireIntegerLimit(column: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > INTEGER_MAX) {
    throw new CostWriteRefused(
      BUDGET_LIMIT_OUT_OF_RANGE,
      column,
      `${column} must be a whole number between 0 and ${INTEGER_MAX}; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * `Budget_alertThresholds_json_root` constrains only the JSON ROOT — the column
 * must hold an array, and nothing more is asserted.
 *
 * So the ELEMENTS are checked here, and that is the interesting half: a
 * threshold written as `null`, as a string, or as `50.5` satisfies the CHECK,
 * lands in the column, and is read back as something `crossedThresholds` will
 * compare a percentage against. The ceiling is the domain's
 * `MAX_ALERT_THRESHOLD` of 200 and the floor is exclusive of zero, for the
 * reason `domain/budget.ts` gives: a 0% threshold crosses the instant the window
 * opens, on every window, forever.
 */
export function requireThresholds(values: readonly number[]): readonly number[] {
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || value > 200) {
      throw new CostWriteRefused(
        BUDGET_THRESHOLDS_INVALID,
        "Budget.alertThresholds",
        `every alert threshold is a whole percentage in (0, 200]; received ${String(value)}`,
      );
    }
  }
  return values;
}

/**
 * `BudgetThresholdEvent_values_check`, restated:
 *
 *   threshold > 0 AND spentCents >= 0 AND runs >= 0 AND length(windowKey) > 0
 *
 * The row is also IMMUTABLE — the migrations reject UPDATE, DELETE and TRUNCATE
 * on it and revoke all three from PUBLIC — so a crossing refused by the database
 * cannot be corrected in place afterwards. There is no repair path, which is why
 * this check happens before the insert rather than after it.
 */
export function requireCrossingValues(crossing: {
  readonly threshold: number;
  readonly spentCents: number;
  readonly runs: number;
  readonly windowKey: string;
}): void {
  if (!Number.isInteger(crossing.threshold) || crossing.threshold <= 0) {
    throw new CostWriteRefused(
      CROSSING_VALUES_INVALID,
      "BudgetThresholdEvent.threshold",
      `a crossing's threshold is a whole percentage above zero; received ${String(crossing.threshold)}`,
    );
  }
  if (!Number.isFinite(crossing.spentCents) || crossing.spentCents < 0) {
    throw new CostWriteRefused(
      CROSSING_VALUES_INVALID,
      "BudgetThresholdEvent.spentCents",
      `a crossing's spend is a finite figure at or above zero; received ${String(crossing.spentCents)}`,
    );
  }
  if (!Number.isInteger(crossing.runs) || crossing.runs < 0 || crossing.runs > INTEGER_MAX) {
    throw new CostWriteRefused(
      CROSSING_VALUES_INVALID,
      "BudgetThresholdEvent.runs",
      `a crossing's run count is a whole number the column can hold; received ${String(crossing.runs)}`,
    );
  }
  if (crossing.windowKey.length === 0) {
    throw new CostWriteRefused(
      CROSSING_VALUES_INVALID,
      "BudgetThresholdEvent.windowKey",
      "a crossing's window key is what makes it unique per budget per period, and may not be empty",
    );
  }
}

/** Micro-cents per cent. The kernel's `Money` scale, restated for the conversion. */
const MICRO_CENTS_PER_CENT = 1_000_000n;

/**
 * The one place this adapter refuses because a COLUMN TYPE is NARROWER than the
 * domain type it holds — and it is reported rather than rounded away.
 *
 * `ThresholdEvent.spent` is `Money`: an exact integer count of micro-cents in a
 * `bigint`, the kernel's representation of `Decimal(18, 6)`.
 * `BudgetThresholdEvent.spentCents` is `DOUBLE PRECISION`. A binary float
 * carries about fifteen significant decimal digits, so an eighteen-digit amount
 * does not round-trip: the alert an operator reads would state a spend that is
 * not the spend that was measured, and the row is immutable, so nothing can
 * correct it later.
 *
 * The refusal is therefore a CONTRACT FINDING, not a defensive check. The caller
 * is handed the fact that this crossing's spend cannot be recorded exactly,
 * rather than a row that looks exact and is not.
 */
export function requireRepresentableSpend(microCents: bigint, asDouble: number): number {
  if (!Number.isFinite(asDouble)) {
    throw new CostWriteRefused(
      CROSSING_SPEND_NOT_REPRESENTABLE,
      "BudgetThresholdEvent.spentCents",
      `a crossing's spend of ${microCents} micro-cents has no finite DOUBLE PRECISION form`,
    );
  }
  const roundTripped = BigInt(Math.round(asDouble * Number(MICRO_CENTS_PER_CENT)));
  if (roundTripped !== microCents) {
    throw new CostWriteRefused(
      CROSSING_SPEND_NOT_REPRESENTABLE,
      "BudgetThresholdEvent.spentCents",
      `a crossing's spend of ${microCents} micro-cents does not survive the DOUBLE PRECISION column, which reads it back as ${roundTripped}`,
    );
  }
  return asDouble;
}

/**
 * `AlertChannel_name_check`, restated: `length(btrim(name)) BETWEEN 1 AND 200`.
 *
 * `btrim` is PostgreSQL's, and it strips the ASCII space only by default — not
 * every whitespace character JavaScript's `String.trim` strips. The check here
 * is deliberately the STRICTER of the two readings (a name that is empty after
 * `trim` is refused), because a name that survives `btrim` and vanishes under
 * `trim` is a channel an operator cannot pick out of a list.
 */
export function requireChannelName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > 200) {
    throw new CostWriteRefused(
      CHANNEL_NAME_INVALID,
      "AlertChannel.name",
      `a channel's name is between 1 and 200 characters once trimmed; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * `AlertChannel_alert_types_check`: `cardinality(alertTypes) > 0`.
 *
 * THE COLUMN'S OWN DEFAULT VIOLATES THIS CHECK. `alertTypes TEXT[] NOT NULL
 * DEFAULT ARRAY[]::TEXT[]` and the constraint demands at least one element, so
 * an INSERT that omits the column is refused by the row it just defaulted. That
 * is not a fault to route around — a channel subscribed to nothing would never
 * fire, and `domain/alert-topic.ts` refuses the same empty list for the same
 * reason — but it does mean this adapter must always name the column, and a
 * future migration that let it default would produce a table whose default
 * cannot be used.
 */
export function requireTopics(values: readonly string[]): readonly string[] {
  if (values.length === 0) {
    throw new CostWriteRefused(
      CHANNEL_TOPICS_EMPTY,
      "AlertChannel.alertTypes",
      "a channel subscribes to at least one topic; the column's own default of an empty array is refused by its CHECK",
    );
  }
  return values;
}

/**
 * `AlertChannel_dedupe_check`, restated:
 *
 *   (deduplicationKey IS NULL AND NOT userProvidedDeduplicationKey)
 *   OR (deduplicationKey IS NOT NULL AND length(deduplicationKey) BETWEEN 1 AND 200)
 *
 * The half that surprises is the FIRST clause: a row with no key may not claim
 * the key was operator-supplied. `domain/alert-channel.ts`'s `retireChannel`
 * clears both together and its `admitAlertChannel` sets both together, so the
 * pair is only ever separable by a caller assembling an `AlertChannel` by hand —
 * which the double accepts and the database does not.
 */
export function requireDeduplication(key: string | null, operatorSupplied: boolean): void {
  if (key === null) {
    if (operatorSupplied) {
      throw new CostWriteRefused(
        CHANNEL_DEDUPE_SHAPE_INVALID,
        "AlertChannel.userProvidedDeduplicationKey",
        "a channel with no deduplication key may not record that an operator supplied one",
      );
    }
    return;
  }
  if (key.length === 0 || key.length > 200) {
    throw new CostWriteRefused(
      CHANNEL_DEDUPE_SHAPE_INVALID,
      "AlertChannel.deduplicationKey",
      `a deduplication key is between 1 and 200 characters; received ${JSON.stringify(key)}`,
    );
  }
}

/**
 * `AlertDelivery_kind_shape_check`, restated:
 *
 *   (kind = 'TEST' AND budgetThresholdEventId IS NULL)
 *   OR (kind = 'BUDGET' AND budgetThresholdEventId IS NOT NULL)
 *
 * The port's `AlertDelivery` carries `eventId: ThresholdEventId | null` and
 * `kind: DeliveryKind` as independent fields, so all four combinations
 * type-check. Two of them are rows the table will not hold, and the pair that is
 * refused is exactly the pair that would make the ledger unreadable: a `BUDGET`
 * row belonging to no crossing, and a `TEST` row claiming one.
 */
export function requireDeliveryKindShape(kind: string, eventId: string | null): void {
  const coherent = kind === "TEST" ? eventId === null : eventId !== null;
  if (!coherent) {
    throw new CostWriteRefused(
      DELIVERY_KIND_SHAPE_INVALID,
      "AlertDelivery.budgetThresholdEventId",
      `a ${kind} delivery ${kind === "TEST" ? "belongs to no crossing" : "belongs to exactly one crossing"}; received ${JSON.stringify(eventId)}`,
    );
  }
}

/**
 * `AlertDelivery_state_check`, restated in this context's vocabulary:
 *
 *   retry count >= 0 AND claimGeneration >= 0 AND
 *   ((status = 'SUCCEEDED' AND deliveredAt IS NOT NULL AND lastErrorCode IS NULL)
 *    OR (status <> 'SUCCEEDED' AND deliveredAt IS NULL))
 *
 * THIS IS THE ONE THAT CATCHES A REAL DOMAIN PATH. `domain/alert-delivery.ts`'s
 * `settle` writes `status: outcome.ok ? "SUCCEEDED" : "FAILED"` beside
 * `lastErrorCode: outcome.errorCode`, copying the outcome's failure token
 * whatever the outcome says about success. `delivered()` always nulls that
 * token, so the two shipped constructors are safe; but `finaliseClaim` and
 * `finaliseDirect` take ANY `DeliveryOutcome`, and one assembled with
 * `ok: true` and a failure token produces a row PostgreSQL refuses. The double
 * writes it without comment.
 */
export function requireDeliveryState(delivery: {
  readonly status: string;
  readonly retryCount: number;
  readonly claimGeneration: number;
  readonly deliveredAt: Date | null;
  readonly lastErrorCode: string | null;
}): void {
  if (!Number.isInteger(delivery.retryCount) || delivery.retryCount < 0) {
    throw new CostWriteRefused(
      DELIVERY_STATE_INCOHERENT,
      "AlertDelivery.retryCount",
      `a delivery's retry count is a whole number at or above zero; received ${String(delivery.retryCount)}`,
    );
  }
  if (!Number.isInteger(delivery.claimGeneration) || delivery.claimGeneration < 0) {
    throw new CostWriteRefused(
      DELIVERY_STATE_INCOHERENT,
      "AlertDelivery.claimGeneration",
      `a delivery's claim generation is a whole number at or above zero; received ${String(delivery.claimGeneration)}`,
    );
  }
  if (delivery.status === "SUCCEEDED") {
    if (delivery.deliveredAt === null) {
      throw new CostWriteRefused(
        DELIVERY_STATE_INCOHERENT,
        "AlertDelivery.deliveredAt",
        "a SUCCEEDED delivery records the instant it was delivered",
      );
    }
    if (delivery.lastErrorCode !== null) {
      throw new CostWriteRefused(
        DELIVERY_STATE_INCOHERENT,
        "AlertDelivery.lastErrorCode",
        `a SUCCEEDED delivery carries no failure token; received ${JSON.stringify(delivery.lastErrorCode)}`,
      );
    }
    return;
  }
  if (delivery.deliveredAt !== null) {
    throw new CostWriteRefused(
      DELIVERY_STATE_INCOHERENT,
      "AlertDelivery.deliveredAt",
      `a ${delivery.status} delivery has not been delivered and records no instant for it`,
    );
  }
}

/**
 * The send record's own state check, restated in this context's vocabulary:
 *
 *   retryNumber > 0 AND status IN ('SUCCEEDED', 'FAILED') AND finishedAt IS NOT NULL
 *   AND ((status = 'SUCCEEDED' AND errorCode IS NULL) OR status = 'FAILED')
 *
 * TWO OF THE FOUR ARE REACHABLE FROM THE PORT'S OWN TYPES. `AlertDeliveryRetry
 * .finishedAt` is `Date | null` in the domain and NOT NULL in the column, and
 * `retryNumber` is a bare `number` while the column demands a positive one —
 * which is what the claim's "increment at claim time, not at finalisation"
 * ordering exists to guarantee, and what an unclaimed synchronous send has to
 * remember to do for itself. The row is append-only and immutable, so a record
 * written wrong stays wrong.
 */
export function requireRetryRecord(retry: {
  readonly retryNumber: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly finishedAt: Date | null;
}): Date {
  if (!Number.isInteger(retry.retryNumber) || retry.retryNumber <= 0) {
    throw new CostWriteRefused(
      RETRY_RECORD_INVALID,
      "AlertDeliveryRetry.retryNumber",
      `a send record is numbered from one; received ${String(retry.retryNumber)}`,
    );
  }
  if (retry.status !== "SUCCEEDED" && retry.status !== "FAILED") {
    throw new CostWriteRefused(
      RETRY_RECORD_INVALID,
      "AlertDeliveryRetry.status",
      `a send record is SUCCEEDED or FAILED and nothing else; received ${JSON.stringify(retry.status)}`,
    );
  }
  if (retry.finishedAt === null) {
    throw new CostWriteRefused(
      RETRY_RECORD_INVALID,
      "AlertDeliveryRetry.finishedAt",
      "a send record is written once the send has finished, and records when",
    );
  }
  if (retry.status === "SUCCEEDED" && retry.errorCode !== null) {
    throw new CostWriteRefused(
      RETRY_RECORD_INVALID,
      "AlertDeliveryRetry.errorCode",
      `a SUCCEEDED send record carries no failure token; received ${JSON.stringify(retry.errorCode)}`,
    );
  }
  // Returned rather than merely checked, so the NOT NULL column is filled from
  // the value this guard proved present. A caller that narrowed with `?? now`
  // would have written an instant nothing observed on the row that records when
  // a send finished, and the row is immutable.
  return retry.finishedAt;
}
