// The `ObservabilitySink` port — OWNED AND PUBLISHED BY THIS CONTEXT.
//
// ADR M0.3 §13: an adapter-facing port belongs to the context whose capability
// it serves; it does not move into the kernel because its implementation happens
// to live under `packages/adapters/`. `observability` is the sole holder of a
// column-store client (§1, row 12), and this interface is the only thing the
// rest of the system sees of it.
//
// FOUR PROPERTIES THIS INTERFACE MUST HAVE:
//
// 1. IT NAMES NO VENDOR. No endpoint, no credential, no database handle, no
//    statement text. Every operation addresses a table this context owns and a
//    predicate this context built. The same interface is satisfiable by any
//    column store, or by the in-memory fake this package ships.
//
// 2. FAILURE IS A VALUE. Every method but `probe` returns `Promise<Result<T>>`,
//    and an implementation MUST map its client's errors onto the
//    `OBSERVABILITY_SINK_*` domain errors. A rejected promise is a defect in the
//    adapter, not a business outcome — and it matters more here than almost
//    anywhere, because a rejection during a drain aborts the pass and leaves
//    every envelope behind it queued.
//
// 3. `probe` REPORTS, IT DOES NOT FAIL. Every way a store can be broken is
//    already a `SinkStatus`, so there is no failure left for a `Result` to
//    carry. It must never reject; the drain still guards it, because "the probe
//    threw" and "the store is down" have to be the same outcome to a caller and
//    only one of them is the adapter behaving.
//
// 4. ERASURE IS SUBMIT-AND-CONFIRM, AND VERIFICATION IS THE CALLER'S. A column
//    store's erasure is asynchronous: the statement returning means the work was
//    ACCEPTED, not that the rows changed. `clearColumns` therefore reports
//    whether it saw its own change confirmed, and the application re-counts
//    afterwards. The adapter is trusted for store mechanics; it is not trusted
//    for the claim on the receipt.

import type { Result } from "@platos/kernel";

import type {
  ClearedColumn,
  ProjectionRows,
  ProjectionTable,
  SinkHealth,
  SubjectPredicate,
} from "../../domain/index.js";

export interface InsertReceipt {
  /** Rows the store accepted. Equal to the batch's row count on success. */
  readonly rowsAccepted: number;
}

export interface CountSubjectRowsRequest {
  readonly table: ProjectionTable;
  readonly predicate: SubjectPredicate;
}

export interface ClearSubjectColumnsRequest {
  readonly table: ProjectionTable;
  readonly predicate: SubjectPredicate;
  /**
   * Columns to empty. Always `predicate.residue`; passed explicitly so the
   * statement an adapter builds and the clause verification counts on cannot be
   * derived from two different places.
   */
  readonly cleared: readonly ClearedColumn[];
}

export interface ClearSubjectColumnsReceipt {
  /**
   * The adapter saw its own change reported complete by the store.
   *
   * False is NOT a failure: an accepted-but-unfinished change is the store's
   * normal behaviour. It means the caller may not count this table as erased on
   * this pass, which is exactly what the re-count is for.
   */
  readonly confirmed: boolean;
  /** One line, safe to log. Never a statement body: they quote the subject. */
  readonly detail: string;
}

export interface ObservabilitySink {
  /**
   * Insert one committed Turn's rows.
   *
   * Batched, never row-at-a-time: a per-row insert is the access pattern a
   * column store is worst at, and the queue exists precisely to avoid it. The
   * insert is idempotent at the store — ids are application-generated and stable
   * across retries — so a redelivered batch collapses rather than double-counts.
   */
  insert(rows: ProjectionRows): Promise<Result<InsertReceipt>>;

  /** Configuration, reachability and schema, as one report. Never rejects. */
  probe(): Promise<SinkHealth>;

  /** Rows still matching the predicate. The evidence a receipt rests on. */
  countSubjectRows(request: CountSubjectRowsRequest): Promise<Result<number>>;

  /** Empty the named columns for every row the predicate matches. */
  clearSubjectColumns(request: ClearSubjectColumnsRequest): Promise<Result<ClearSubjectColumnsReceipt>>;
}
