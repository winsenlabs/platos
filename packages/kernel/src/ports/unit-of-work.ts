// ADR M0.3 §4 kernel port: UnitOfWork, and the ONE sanctioned way to end one
// with a failure.
//
// ADR M0.3 §3 names the leaked-Prisma-transaction outbox as one of the two
// self-introduced cycles this design pre-empts: "No context passes a Prisma txn
// handle across a port." `TransactionScope` is therefore opaque — it carries an
// identifier and nothing else. The adapter keeps the real handle in its own
// side table keyed by that identifier, so a context can enlist the outbox in its
// transaction without ever naming a vendor type.
//
// ---------------------------------------------------------------------------
// WHY `runResult` EXISTS, AND WHY IT IS NOT A CONVENIENCE.
//
// `run` commits when its callback RESOLVES and rolls back when it REJECTS. That
// is the only contract a transaction can have, and it collides with the way
// every use case in this tree reports failure: a `Result` value, deliberately
// not a thrown class (see vo/error.ts). A callback that returns
// `{ ok: false, error }` has RESOLVED. It therefore COMMITS.
//
// `cost-monitoring` shipped exactly that. `detect-crossings` wrote a threshold
// event, fanned out one alert delivery per recipient, and returned the fan-out's
// error `Result` from inside `UnitOfWork.run`. The callback resolved, the
// transaction committed, and the crossing was left in the database with nothing
// to send it — a budget alert that had fired and would never be delivered. The
// suite was green, because in-memory doubles have no commit to observe.
//
// The shape is not a mistake anyone makes once. It is what the ordinary reading
// of both contracts produces: "return the error" is right everywhere else in the
// codebase, and it is wrong here and only here. So the fix is not vigilance, it
// is a second entry point whose signature says a `Result` is what it takes and
// whose implementation REJECTS on the failing branch. Inside `runResult` there
// is no way to spell "commit with an error", because the failing branch never
// reaches a `return`.
//
// WHAT THE GUARANTEE IS, EXACTLY, INCLUDING THE NESTED CASE.
//
//   * Outermost frame: an `err` returned by `work` rolls the transaction back
//     and comes out of `runResult` as the same `err`. Nothing it wrote lands.
//   * JOINED frame (a `runResult` inside another open transaction): `run` joins
//     rather than opening a second transaction, so there is no inner boundary to
//     roll back to and the abort unwinds to the joined callback's caller, which
//     receives the `err` as a value. If that caller propagates it, the outer
//     `runResult` aborts the real transaction and everything is discarded. If it
//     deliberately swallows it and returns `ok`, the outer transaction commits —
//     which is a decision taken in the open, at a call site a reader can see,
//     and is the only behaviour that leaves room for a use case that genuinely
//     tolerates a partial failure.
//
//   The property that holds unconditionally is the one that was violated:
//   AN ERROR RESULT NEVER COMMITS THE FRAME THAT PRODUCED IT.
//
// WHY THE ABORT IS A BRANDED PLAIN OBJECT RATHER THAN AN ERROR SUBCLASS.
// ADR M0.3 §5.3 forbids the kernel from declaring a class with a non-empty
// constructor, and a carrier for the `DomainError` is exactly that. A frozen
// branded object is thrown instead, `isTransactionAbort` is the only reader, and
// anything that is NOT an abort is rethrown untouched — so a genuine defect
// underneath a use case is never relabelled as a business failure.
// ---------------------------------------------------------------------------

import type { DomainError, Result } from "../vo/error.js";
import { err, ok } from "../vo/error.js";
import type { TransactionId } from "../vo/identifier.js";

/**
 * A handle to the open transaction. Deliberately carries no vendor object: it is
 * a token that adapters correlate on, not a database session.
 */
export interface TransactionScope {
  readonly transactionId: TransactionId;
}

export interface UnitOfWork {
  /**
   * Run `work` inside one transaction. It commits when `work` resolves and rolls
   * back when it rejects. Nesting joins the outer transaction rather than opening
   * a second one, so a use case composed of two smaller ones stays atomic.
   *
   * A callback that resolves with a failing `Result` COMMITS. Use `runResult`
   * whenever the callback's answer is a `Result`; the header of this file says
   * what happens when you do not.
   */
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}

/**
 * The type-level statement of the same rule.
 *
 * `NotResult<Value>` is `never` when `Value` is a `Result`. It is the shape a
 * future signature can use to refuse the mistake outright; today it is the
 * machine-checkable spelling of "this value must not be a Result", which the
 * kernel's own suite uses to prove the discrimination is exact rather than a
 * guess about the structural shape of `Result`.
 */
export type NotResult<Value> = Value extends { readonly ok: boolean } ? never : Value;

/**
 * The brand on the thrown abort.
 *
 * A string rather than a symbol so the check survives two copies of this module
 * in one process — the ordinary state of a workspace mid-migration. A
 * symbol-identity check would fail OPEN there, rethrowing a business abort as if
 * it were a defect and turning a rolled-back use case into a 500.
 */
export const TRANSACTION_ABORT_BRAND = "platos.kernel.unit-of-work.abort";

/** The carrier thrown to force a rollback. It never crosses a port. */
export interface TransactionAbort {
  readonly brand: typeof TRANSACTION_ABORT_BRAND;
  readonly error: DomainError;
}

/**
 * True only for the abort this module throws. Everything else is a defect.
 *
 * The `error.code` check is not belt-and-braces. Without it any object carrying
 * the brand string — a decoded row, a parsed body, a fixture — would be accepted
 * and `err(undefined)` returned, which crashes at the caller's first
 * `error.code` read with a stack that points nowhere near the cause.
 */
export function isTransactionAbort(value: unknown): value is TransactionAbort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { brand?: unknown; error?: unknown };
  if (candidate.brand !== TRANSACTION_ABORT_BRAND) return false;
  const carried = candidate.error as { code?: unknown } | null | undefined;
  return typeof carried === "object" && carried !== null && typeof carried.code === "string";
}

/**
 * Run `work` in one transaction and let its `Result` decide the outcome.
 *
 * `ok` commits. `err` ROLLS BACK and is returned unchanged — the same error
 * value, not a copy carrying a different code, because a caller matching on
 * `error.code` must see what the repository actually said.
 */
export async function runResult<Value>(
  unitOfWork: UnitOfWork,
  work: (transaction: TransactionScope) => Promise<Result<Value>>,
): Promise<Result<Value>> {
  try {
    const value = await unitOfWork.run<Value>(async (transaction) => {
      const outcome = await work(transaction);
      // THE WHOLE MECHANISM IS THIS BRANCH ORDER. The failing branch throws
      // before any `return` is reachable, so "resolve with an error" cannot be
      // written here at all.
      if (outcome.ok) return outcome.value;
      throw Object.freeze({ brand: TRANSACTION_ABORT_BRAND, error: outcome.error });
    });
    return ok(value);
  } catch (cause) {
    if (isTransactionAbort(cause)) return err(cause.error);
    throw cause;
  }
}
