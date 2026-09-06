// Stored row to domain aggregate, VALIDATED rather than cast.
//
// A read is where an expand/contract window becomes a defect. `ErasureOperation`
// and `ErasureTombstone` both carry values a NEWER binary may have written —
// a `WorkStatus` label this one has never heard of, a `stores` array holding an
// outcome shape this one does not know — and a cast would let each of them
// through as a value the domain's own predicates then reason about incorrectly.
// A `status` read as `"SUPERSEDED" as WorkStatus` flows straight into
// `receiptStatusFor`, whose four branches all miss it, and the receipt comes back
// `pending` for an operation that has finished.
//
// So every column with a vocabulary is checked, and a row this binary cannot
// read is an OUTCOME with its own code rather than a silent mis-projection.
// `privacy-refusal.ts` turns that into the context's `unavailable` error, which
// is the honest answer: this process cannot serve the row, and a newer one can.
//
// THE TWO COLUMNS THIS STORE NEVER WRITES ARE NEVER READ EITHER, and that is a
// finding rather than an omission. `ErasureOperation.inventory` and
// `ErasureOperation.resumePlan` are in the frozen baseline with their own
// `_json_root` CHECKs, and `PersistedErasureOperation` — the type the port reads
// and writes — has no field for either. Expand/contract's rule is to write only
// columns the baseline holds and to READ rows written without the newer ones, so
// they are left at SQL NULL by every write here and are absent from every
// `select` below. A store that invented a field for them would be publishing a
// column the aggregate cannot carry.
//
// `updatedAt` IS NOT READ EITHER, and for a different reason. It is `@updatedAt`,
// so the client stamps it on every write whatever the aggregate says; comparing
// it in the conformance transcript would measure the driver rather than the
// store, and the aggregate has no field to put it in.

import type {
  AliasHash,
  ErasureOperationId,
  ErasureTombstone,
  ErasureTombstoneId,
  IdempotencyKey,
  LeaseToken,
  PersistedErasureOperation,
  SubjectKeyHash,
  TargetOutcome,
  TenantScope,
  WorkStatus,
} from "@platos/context-privacy/application/ports/index.js";
import { asIdentifier } from "@platos/context-privacy/application/ports/index.js";

import { isStorableWorkStatus } from "./privacy-guards.js";

/** A stored `WorkStatus` this binary does not recognise. */
export const UNKNOWN_WORK_STATUS = "privacy.row.unknown_work_status";

/** A stored `scopes` or `stores` column whose JSON root is not an array. */
export const UNREADABLE_JSON_ARRAY = "privacy.row.unreadable_json_array";

/** A stored `stores` element that is not an object with a `target` name. */
export const UNREADABLE_TARGET_OUTCOME = "privacy.row.unreadable_target_outcome";

/** A stored `scopes` element that is not one of the kernel's three levels. */
export const UNREADABLE_TENANT_SCOPE = "privacy.row.unreadable_tenant_scope";

/** A row this binary cannot read. An outcome, not a defect: see the header. */
export class UnreadablePrivacyRow extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, detail: string) {
    super(`${code}: ${column} ${detail}`);
    this.name = "UnreadablePrivacyRow";
    this.code = code;
    this.column = column;
  }
}

function unreadable(code: string, column: string, detail: string): never {
  throw new UnreadablePrivacyRow(code, column, detail);
}

/** The three levels of `TenantScope`, as a total map over the kernel's union. */
const SCOPE_LEVELS: Record<TenantScope["level"], true> = {
  organization: true,
  project: true,
  environment: true,
};

/** The `ErasureOperation` columns every read selects. One place, so no read is wider. */
export const OPERATION_COLUMNS = {
  id: true,
  organizationId: true,
  idempotencyKey: true,
  subjectKeyHash: true,
  status: true,
  scopes: true,
  stores: true,
  policyVersion: true,
  legalHoldPolicyId: true,
  retryCount: true,
  nextRetryAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
} as const;

/** The `ErasureTombstone` columns every read selects. */
export const TOMBSTONE_COLUMNS = {
  id: true,
  organizationId: true,
  aliasHash: true,
  operationId: true,
  policyVersion: true,
  sealedAt: true,
  expiresAt: true,
} as const;

/** Exactly what `OPERATION_COLUMNS` selects, as this file's own shape. */
export interface OperationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly subjectKeyHash: string;
  readonly status: string;
  readonly scopes: unknown;
  readonly stores: unknown;
  readonly policyVersion: string;
  readonly legalHoldPolicyId: string | null;
  readonly retryCount: number;
  readonly nextRetryAt: Date | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

/** Exactly what `TOMBSTONE_COLUMNS` selects. */
export interface TombstoneRow {
  readonly id: string;
  readonly organizationId: string;
  readonly aliasHash: string;
  readonly operationId: string;
  readonly policyVersion: string;
  readonly sealedAt: Date;
  readonly expiresAt: Date;
}

function readWorkStatus(value: string): WorkStatus {
  if (!isStorableWorkStatus(value)) {
    unreadable(UNKNOWN_WORK_STATUS, "ErasureOperation.status", `holds ${value}`);
  }
  return value;
}

function readJsonArray(column: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) unreadable(UNREADABLE_JSON_ARRAY, column, "is not a JSON array");
  return value;
}

/**
 * One stored scope, checked for its DISCRIMINANT and its ids.
 *
 * The discriminant is what every kernel consumer switches on, so a stored level
 * outside the three would reach `resolvePath` and produce a key that silently
 * addresses the wrong subtree. The narrower ids are checked in the same pass
 * because a `project` scope missing its `projectId` is the same class of stored
 * defect and would otherwise be read as `undefined` inside a template string.
 */
function readTenantScope(value: unknown): TenantScope {
  const column = "ErasureOperation.scopes";
  if (typeof value !== "object" || value === null) {
    unreadable(UNREADABLE_TENANT_SCOPE, column, "holds an element that is not an object");
  }
  const scope = value as Record<string, unknown>;
  const level = scope["level"];
  if (typeof level !== "string" || !Object.hasOwn(SCOPE_LEVELS, level)) {
    unreadable(UNREADABLE_TENANT_SCOPE, column, `holds level ${String(level)}`);
  }
  if (typeof scope["organizationId"] !== "string") {
    unreadable(UNREADABLE_TENANT_SCOPE, column, "holds a scope with no organizationId");
  }
  if (level !== "organization" && typeof scope["projectId"] !== "string") {
    unreadable(UNREADABLE_TENANT_SCOPE, column, `holds a ${level} scope with no projectId`);
  }
  if (level === "environment" && typeof scope["environmentId"] !== "string") {
    unreadable(UNREADABLE_TENANT_SCOPE, column, "holds an environment scope with no environmentId");
  }
  return scope as unknown as TenantScope;
}

/**
 * One stored target outcome.
 *
 * Only `target` is checked, and that is a decision rather than laziness. The
 * outcome vocabulary — `TargetStatus`, `VerificationStatus` — is what a NEWER
 * binary is most likely to widen, and `deriveStatus` treats an unrecognised
 * status as "not settled", which keeps the operation OPEN. That is the safe
 * direction and it is the direction this whole context leans, so refusing the
 * row would turn a readable receipt into an outage for no gain. A missing
 * `target` is different: `mergeOutcomes` and `targetsNeedingRetry` both key on
 * it, so an outcome without one silently collapses into whichever other outcome
 * shares its `undefined`.
 */
function readTargetOutcome(value: unknown): TargetOutcome {
  const column = "ErasureOperation.stores";
  if (typeof value !== "object" || value === null) {
    unreadable(UNREADABLE_TARGET_OUTCOME, column, "holds an element that is not an object");
  }
  const outcome = value as Record<string, unknown>;
  if (typeof outcome["target"] !== "string" || outcome["target"] === "") {
    unreadable(UNREADABLE_TARGET_OUTCOME, column, "holds an outcome with no target name");
  }
  return outcome as unknown as TargetOutcome;
}

export function readOperationRow(row: OperationRow): PersistedErasureOperation {
  return {
    operationId: asIdentifier<ErasureOperationId>(row.id),
    organizationId: asIdentifier(row.organizationId),
    idempotencyKey: asIdentifier<IdempotencyKey>(row.idempotencyKey),
    subjectKeyHash: asIdentifier<SubjectKeyHash>(row.subjectKeyHash),
    workStatus: readWorkStatus(row.status),
    scopes: readJsonArray("ErasureOperation.scopes", row.scopes).map(readTenantScope),
    outcomes: readJsonArray("ErasureOperation.stores", row.stores).map(readTargetOutcome),
    policyVersion: row.policyVersion,
    legalHoldPolicyId: row.legalHoldPolicyId,
    retryCount: row.retryCount,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    nextRetryAt: row.nextRetryAt,
    leaseToken: row.leaseToken === null ? null : asIdentifier<LeaseToken>(row.leaseToken),
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

export function readTombstoneRow(row: TombstoneRow): ErasureTombstone {
  return {
    tombstoneId: asIdentifier<ErasureTombstoneId>(row.id),
    organizationId: asIdentifier(row.organizationId),
    aliasHash: asIdentifier<AliasHash>(row.aliasHash),
    operationId: asIdentifier<ErasureOperationId>(row.operationId),
    policyVersion: row.policyVersion,
    sealedAt: row.sealedAt,
    expiresAt: row.expiresAt,
  };
}
