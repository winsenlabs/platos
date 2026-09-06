// What the real database refuses on `privacy`'s two rows, checked BEFORE the
// statement is sent.
//
// WHY BEFORE. On PostgreSQL a statement that violates a constraint ABORTS the
// enclosing transaction: every later statement fails with 25P02 until the block
// ends. Every mutation on this port takes the CALLER's `TransactionScope`, and
// `request-erasure.ts` writes the operation row and appends the INTENT event in
// ONE unit of work — so a store that let `22P02` raise on a malformed id would
// have reported the refusal correctly and left the caller unable to append the
// event that says the erasure was asked for. `cost-guards.ts`,
// `governance-guards.ts` and `memory-guards.ts` found the same thing on the same
// database; the answer is the same. Refuse in TypeScript, send nothing, keep the
// transaction.
//
// EVERY GUARD BELOW IS A CONSTRAINT THAT EXISTS ONLY IN THE MIGRATIONS OR ONLY
// IN THE COLUMN TYPE, AND THAT THE CONTEXT'S OWN IN-MEMORY DOUBLE DOES NOT HOLD.
//
//   `@db.Uuid` on `ErasureOperation.id`, `ErasureOperation.organizationId`,
//   `ErasureTombstone.id`, `ErasureTombstone.organizationId` and
//   `ErasureTombstone.operationId`. `application/testing/fixtures.ts` mints
//   `org-1` for the organization and `SequenceIdGenerator` mints `id-0001` for
//   every uuid the context asks the kernel for. Every one is accepted by
//   `InMemoryPrivacyRepository` and refused by PostgreSQL, and every use-case
//   suite in the context passes with them.
//
//   `ErasureOperation_scopes_json_root` and `ErasureOperation_stores_json_root`,
//   both `jsonb_typeof(...) = 'array'`. The aggregate types `scopes` as
//   `readonly TenantScope[]` and `outcomes` as `readonly TargetOutcome[]`, so
//   these two stand for the value that arrives through a transport boundary with
//   the type assertion already spent.
//
//   `WorkStatus` — a PostgreSQL ENUM with exactly five labels. The domain's own
//   `toWorkStatus` only ever produces those five, and `OperationProgressWrite`
//   nonetheless carries a `workStatus` field a caller assembles by hand.
//
//   TIMESTAMP(3). Every instant column on both rows is millisecond-precision, and
//   an `Invalid Date` reaches the driver as a value it cannot serialise.
//   `backoffMs` caps its exponent precisely so `nextRetryAt` never becomes one,
//   which is a rule this store must not quietly discard.
//
//   NEGATIVE `take`. `listDueOperations(asOf, limit)` is the queue's page. The
//   double clamps with `Math.max(0, limit)`; Prisma REVERSES the order on a
//   negative `take` and returns rows, so the queue would re-drive the furthest
//   FUTURE operations first with nothing failing.
//
//   A MIXED-TENANT SEAL. `sealTombstones` takes `readonly TombstoneDraft[]` and
//   each draft carries its own `organizationId`. `draftTombstones` builds them
//   all from one organization, so a mixed batch is unreachable from the domain
//   and is a defect at any other caller — and it is the one shape that would make
//   this store's own single-tenant read-then-split unsound.
//
// EVERY REFUSAL HAS ITS OWN CODE. Two guards sharing one code cannot be told
// apart in a log, which is how two defects hid behind one code in this very
// context before WIN-258.

import type {
  PersistedErasureOperation,
  TenantScope,
  TombstoneDraft,
  WorkStatus,
} from "@platos/context-privacy/application/ports/index.js";

/** An identifier bound for a `@db.Uuid` column that is not a uuid. */
export const PRIVACY_IDENTIFIER_NOT_UUID = "privacy.write.identifier_not_uuid";

/** A `Date` that is not a representable instant. Every column is `timestamp(3)`. */
export const PRIVACY_INSTANT_NOT_REPRESENTABLE = "privacy.write.instant_not_representable";

/** `ErasureOperation_scopes_json_root`: the root is not a JSON array. */
export const PRIVACY_SCOPES_NOT_ARRAY = "privacy.write.scopes_not_array";

/** `ErasureOperation_stores_json_root`: the root is not a JSON array. */
export const PRIVACY_OUTCOMES_NOT_ARRAY = "privacy.write.outcomes_not_array";

/** A `status` outside the five labels of the `WorkStatus` enum. */
export const PRIVACY_WORK_STATUS_UNKNOWN = "privacy.write.work_status_unknown";

/** `retryCount` is an `Int4` column: a non-integer or an out-of-range count. */
export const PRIVACY_RETRY_COUNT_INVALID = "privacy.write.retry_count_invalid";

/** A lease with a token and no expiry, or an expiry and no token. */
export const PRIVACY_LEASE_INCOHERENT = "privacy.write.lease_incoherent";

/** `listDueOperations`' page size. Prisma reverses the order on a negative take. */
export const PRIVACY_PAGE_LIMIT_INVALID = "privacy.write.page_limit_invalid";

/** One `sealTombstones` batch naming more than one organization. */
export const PRIVACY_SEAL_SPANS_TENANTS = "privacy.write.seal_spans_tenants";

/** A tombstone whose retention window ends before it begins. */
export const PRIVACY_TOMBSTONE_WINDOW_INVERTED = "privacy.write.tombstone_window_inverted";

/** Fewer minted ids than drafts to seal, so a row would be written without one. */
export const PRIVACY_SEAL_IDS_MISSING = "privacy.write.seal_ids_missing";

/** A value the canonical schema will not hold, refused before any statement. */
export class PrivacyWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PrivacyWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code: string, detail: string): never {
  throw new PrivacyWriteRefused(code, detail);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `Int4`, which is what `retryCount` is. Wider than the domain will ever
 * produce, and narrower than `number`.
 */
const INT32_MAX = 2_147_483_647;

/**
 * The five labels of the `WorkStatus` enum, as a TOTAL map over the domain's own
 * union rather than as a list beside it.
 *
 * `Record<WorkStatus, true>` is what makes this a link instead of a copy: the day
 * the domain adds a sixth status this object stops type-checking, and this file
 * is where the omission surfaces. A `readonly string[]` would have gone on
 * compiling and would have refused the new label at runtime, in production,
 * inside somebody's transaction.
 */
const WORK_STATUSES: Record<WorkStatus, true> = {
  PENDING: true,
  ACTIVE: true,
  SUCCEEDED: true,
  FAILED: true,
  CANCELLED: true,
};

/** True for one of the enum's five labels. */
export function isStorableWorkStatus(value: string): value is WorkStatus {
  return Object.hasOwn(WORK_STATUSES, value);
}

export function requireUuid(label: string, value: string): string {
  if (!UUID.test(value)) refuse(PRIVACY_IDENTIFIER_NOT_UUID, `${label} is not a uuid`);
  return value;
}

export function requireInstant(label: string, value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    refuse(PRIVACY_INSTANT_NOT_REPRESENTABLE, `${label} is not a representable instant`);
  }
  return value;
}

function requireNullableInstant(label: string, value: Date | null): Date | null {
  return value === null ? null : requireInstant(label, value);
}

/** `listDueOperations`' page size, refused rather than clamped. */
export function requirePageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0 || limit > INT32_MAX) {
    refuse(PRIVACY_PAGE_LIMIT_INVALID, `limit ${String(limit)} is not a non-negative int32`);
  }
  return limit;
}

/**
 * A lease is a PAIR. A token with no expiry can never be reclaimed and an expiry
 * with no token names no holder, and the column pair permits both because
 * neither is `NOT NULL`.
 */
function requireLeasePair(token: string | null, expiresAt: Date | null): void {
  if ((token === null) !== (expiresAt === null)) {
    refuse(
      PRIVACY_LEASE_INCOHERENT,
      "leaseToken and leaseExpiresAt must be set together or not at all",
    );
  }
}

function requireArray(code: string, label: string, value: unknown): void {
  if (!Array.isArray(value)) refuse(code, `${label} must be a JSON array at its root`);
}

/**
 * The columns one destructive pass advances, and nothing else.
 *
 * Separate from `guardStorableOperation` because `updateProgress` writes only
 * these: the port makes the identity columns unwritable by construction, so a
 * guard that demanded them on an update would be asking a caller for values it is
 * deliberately not allowed to supply.
 */
export function guardOperationProgress(progress: {
  readonly workStatus: WorkStatus;
  readonly outcomes: unknown;
  readonly retryCount: number;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly nextRetryAt: Date | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
}): void {
  if (!isStorableWorkStatus(progress.workStatus)) {
    refuse(PRIVACY_WORK_STATUS_UNKNOWN, `${String(progress.workStatus)} is not a WorkStatus label`);
  }
  requireArray(PRIVACY_OUTCOMES_NOT_ARRAY, "ErasureOperation.stores", progress.outcomes);
  if (
    !Number.isInteger(progress.retryCount) ||
    progress.retryCount < 0 ||
    progress.retryCount > INT32_MAX
  ) {
    refuse(
      PRIVACY_RETRY_COUNT_INVALID,
      `retryCount ${String(progress.retryCount)} is not a non-negative int32`,
    );
  }
  requireNullableInstant("ErasureOperation.startedAt", progress.startedAt);
  requireNullableInstant("ErasureOperation.completedAt", progress.completedAt);
  requireNullableInstant("ErasureOperation.nextRetryAt", progress.nextRetryAt);
  requireNullableInstant("ErasureOperation.leaseExpiresAt", progress.leaseExpiresAt);
  requireLeasePair(progress.leaseToken, progress.leaseExpiresAt);
}

/** Everything `ErasureOperation` will not hold, checked in one place. */
export function guardStorableOperation(operation: PersistedErasureOperation): void {
  requireUuid("ErasureOperation.id", operation.operationId);
  requireUuid("ErasureOperation.organizationId", operation.organizationId);
  requireInstant("ErasureOperation.requestedAt", operation.requestedAt);
  requireArray(PRIVACY_SCOPES_NOT_ARRAY, "ErasureOperation.scopes", operation.scopes);
  for (const scope of operation.scopes as readonly TenantScope[]) {
    requireUuid("ErasureOperation.scopes[].organizationId", scope.organizationId);
  }
  guardOperationProgress(operation);
}

/**
 * Everything one seal will not hold, plus the one shape that would make this
 * store's read-then-split unsound.
 *
 * Returns the organization every draft shares, because the caller needs it for
 * the scoped read and computing it twice is one more place the two could
 * disagree. An EMPTY batch has no organization and is answered before this runs.
 */
export function guardSealBatch(drafts: readonly TombstoneDraft[], ids: readonly string[]): string {
  const [first] = drafts;
  if (first === undefined) {
    refuse(PRIVACY_SEAL_SPANS_TENANTS, "an empty seal has no organization to be scoped by");
  }
  const organizationId = requireUuid("ErasureTombstone.organizationId", first.organizationId);
  if (drafts.length > ids.length) {
    refuse(
      PRIVACY_SEAL_IDS_MISSING,
      `${String(drafts.length)} drafts and ${String(ids.length)} minted ids`,
    );
  }
  for (const draft of drafts) {
    if (draft.organizationId !== organizationId) {
      refuse(PRIVACY_SEAL_SPANS_TENANTS, "one seal may not span two organizations");
    }
    requireUuid("ErasureTombstone.operationId", draft.operationId);
    requireInstant("ErasureTombstone.sealedAt", draft.sealedAt);
    requireInstant("ErasureTombstone.expiresAt", draft.expiresAt);
    if (draft.expiresAt.getTime() < draft.sealedAt.getTime()) {
      refuse(PRIVACY_TOMBSTONE_WINDOW_INVERTED, "expiresAt precedes sealedAt");
    }
  }
  for (const id of ids.slice(0, drafts.length)) requireUuid("ErasureTombstone.id", id);
  return organizationId;
}
