/**
 * Erasure orchestrator — runs the stores, keeps the receipt honest.
 *
 * Store executors are injected rather than imported. Two reasons, both about
 * being able to trust this code: the ordering and failure semantics are the part
 * that carries legal weight, so they must be testable without a database, a
 * Redis, a ClickHouse and an object store; and the executors themselves are then
 * free to be thin, which is where you want the untested surface to be.
 *
 * ORDERING IS NOT ARBITRARY
 *
 * MinIO runs BEFORE Postgres. Object keys are discovered from attachment
 * metadata rows, so deleting the rows first destroys the only map to the bytes,
 * leaving orphaned objects that no later sweep can find. The existing route
 * deletes metadata and relies on an expiry policy to eventually collect the
 * objects — which means the bytes outlive the erasure, and nothing detects it.
 *
 * Postgres runs LAST among the destructive stores for the same reason: it holds
 * the identifiers every other store is addressed by. Once the canonical
 * PlatosEndUser row is gone, a retry cannot rediscover the subject.
 *
 * FAILURE SEMANTICS
 *
 * Stores fail independently and are never rolled back. If MinIO succeeds and
 * Postgres fails, the objects stay deleted: restoring them to reach a tidy
 * all-or-nothing state would recreate personal data the subject asked to have
 * destroyed, in order to make a status field look neater. The operation sits at
 * partial_failure until every required store verifies, and a retry re-runs only
 * what did not settle.
 *
 * One store throwing must not abort the others. A crash in the Redis executor
 * that prevented Postgres from ever running would leave far more personal data
 * in place than it protected.
 */

import {
  deriveStatus,
  pendingStore,
  storesNeedingRetry,
  type ErasureReceipt,
  type StoreName,
  type StoreOutcome,
} from "./erasure-receipt";
import {
  demoteForCoverage,
  preserveVerificationFailure,
  type ResumeCoverage,
} from "./erasure-queue";
import { isEmptySubject, type SubjectKeys } from "./subject-graph";

/** One store's erasure implementation. Must be idempotent. */
export type StoreExecutor = (subject: SubjectKeys) => Promise<StoreOutcome>;

export type StoreExecutors = Partial<Record<StoreName, StoreExecutor>>;

/**
 * Destructive order. MinIO first because Postgres holds the key map; Postgres
 * last because it holds the identifiers everything else is addressed by.
 */
export const EXECUTION_ORDER: StoreName[] = ["minio", "redis", "clickhouse", "postgres"];

export interface RunOptions {
  /** Only run these stores. Used by retry to skip settled ones. */
  only?: StoreName[];
  /** Blocks the run entirely; the receipt records the policy id, not content. */
  legalHold?: { policyId: string } | null;
  /**
   * How much of the subject this pass can address. Defaults to `full`.
   *
   * A pass resumed from the persisted plan alone cannot see the rows keyed by
   * the subject's legacy external id, so it deletes over a narrower WHERE and
   * would then VERIFY over that same narrower WHERE — finding no survivors and
   * reporting a pass it never earned. `demoteForCoverage` refuses that; see
   * erasure-queue.ts.
   */
  coverage?: ResumeCoverage;
  now?: () => string;
}

/**
 * A store that threw rather than returning an outcome.
 *
 * Recorded as `failed` with verification `unknown` — NOT `failed` verification.
 * The distinction matters: a thrown executor proves nothing either way, whereas
 * a failed verification is positive evidence that data survived. Collapsing the
 * two would let a transient network error read as "we deleted and it is still
 * there", which is a materially different claim.
 */
function crashedOutcome(store: StoreName, err: unknown): StoreOutcome {
  const name = err instanceof Error ? err.name : "Error";
  return {
    ...pendingStore(store),
    status: "failed",
    failures: 1,
    verificationStatus: "unknown",
    // Error CLASS only. Messages routinely embed the identifiers being erased.
    note: `executor threw (${name})`,
  };
}

/**
 * Run the erasure and return the updated receipt.
 *
 * Never throws for store-level problems: an operation that crashes leaves no
 * receipt, and a missing receipt is indistinguishable from an erasure that was
 * never requested.
 */
export async function runErasure(
  receipt: ErasureReceipt,
  subject: SubjectKeys,
  executors: StoreExecutors,
  opts: RunOptions = {},
): Promise<ErasureReceipt> {
  const now = opts.now ?? (() => new Date().toISOString());

  if (opts.legalHold) {
    return {
      ...receipt,
      status: "blocked_legal_hold",
      legalHoldPolicyId: opts.legalHold.policyId,
      attempts: receipt.attempts + 1,
    };
  }

  // Discovery finding nothing is NOT success. It usually means the subject was
  // resolved by the wrong key -- exactly the defect this work exists to fix --
  // and reporting "completed, 0 deleted" would certify an erasure that never
  // looked in the right place.
  if (isEmptySubject(subject)) {
    return {
      ...receipt,
      status: "verification_failed",
      startedAt: receipt.startedAt ?? now(),
      attempts: receipt.attempts + 1,
      stores: receipt.stores.length ? receipt.stores : EXECUTION_ORDER.map(pendingStore),
    };
  }

  const targets = opts.only ?? EXECUTION_ORDER;
  const coverage = opts.coverage ?? "full";
  const byStore = new Map<StoreName, StoreOutcome>(receipt.stores.map((s) => [s.store, s]));

  for (const store of EXECUTION_ORDER) {
    if (!targets.includes(store)) continue;
    const exec = executors[store];
    if (!exec) {
      // No executor wired is not the same as nothing to erase. Say so rather
      // than letting an unimplemented store read as clean.
      byStore.set(store, {
        ...pendingStore(store),
        status: "failed",
        failures: 1,
        verificationStatus: "unknown",
        note: "no executor configured for this store",
      });
      continue;
    }
    // Held before the executor overwrites it: a retry must not be able to
    // replace positive evidence of survival with an absence of evidence.
    const previous = byStore.get(store);
    try {
      // Demoted on the way in, not on the way out of the whole run: only the
      // stores this pass actually ran are constrained by this pass's coverage.
      const outcome = demoteForCoverage(await exec(subject), coverage);
      byStore.set(store, preserveVerificationFailure(previous, outcome));
    } catch (err) {
      // Swallow deliberately: the remaining stores must still run.
      byStore.set(store, preserveVerificationFailure(previous, crashedOutcome(store, err)));
    }
  }

  const stores = EXECUTION_ORDER.map((s) => byStore.get(s) ?? pendingStore(s));
  const status = deriveStatus(stores, { started: true });

  return {
    ...receipt,
    stores,
    status,
    startedAt: receipt.startedAt ?? now(),
    completedAt: status === "completed" ? now() : receipt.completedAt,
    attempts: receipt.attempts + 1,
  };
}

/**
 * Retry: re-runs only the stores that did not settle.
 *
 * Re-running a settled store would re-issue deletes against data already gone.
 * Harmless, but the receipt would then report fresh deletion counts for work
 * that finished hours earlier, which misleads whoever reads it as evidence.
 */
export async function retryErasure(
  receipt: ErasureReceipt,
  subject: SubjectKeys,
  executors: StoreExecutors,
  opts: RunOptions = {},
): Promise<ErasureReceipt> {
  const only = storesNeedingRetry(receipt);
  if (only.length === 0) return receipt;
  return runErasure(receipt, subject, executors, { ...opts, only });
}
