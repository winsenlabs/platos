// An in-memory `ObservabilitySink`.
//
// It exists so every rule in this context is provable without a column store. It
// is framework-free and vendor-free by construction — it is an array of rows and
// a predicate evaluator — which is the point: if a use case can be driven to its
// conclusion against this, then no rule in it secretly depends on a client's
// behaviour.
//
// THE PREDICATE EVALUATOR IS THE INTERESTING PART. `SubjectPredicate` is a
// vendor-free value the domain builds, and this fake evaluates it exactly as the
// real adapter's SQL must: organization AND (any locator) AND (any residue
// column still non-empty). That is what makes the residue rule — without which
// negative verification is a tautology — testable at all, rather than a property
// of a string an adapter builds where no test can reach it.
//
// It records every call, because several of this context's guarantees are
// NEGATIVE ("the store is never asked when the sink is unavailable"), and a
// negative is only provable against a double that remembers what it was asked.

import { err, ok, type Result } from "@platos/kernel";

import {
  PROJECTION_TABLES,
  sinkHealth,
  sinkRejectedBatch,
  sinkUnreachable,
  type ProjectionRow,
  type ProjectionRows,
  type ProjectionTable,
  type SinkHealth,
  type SubjectPredicate,
} from "../../domain/index.js";
import type {
  ClearSubjectColumnsReceipt,
  ClearSubjectColumnsRequest,
  CountSubjectRowsRequest,
  InsertReceipt,
  ObservabilitySink,
} from "../ports/index.js";

export type SinkCall =
  | { readonly call: "insert"; readonly rows: number }
  | { readonly call: "probe" }
  | { readonly call: "countSubjectRows"; readonly table: ProjectionTable }
  | { readonly call: "clearSubjectColumns"; readonly table: ProjectionTable };

type Stored = { [Table in ProjectionTable]: Record<string, string | number | null>[] };

function emptyStored(): Stored {
  return { turns_v1: [], steps_v1: [], tool_calls_v1: [], usage_events_v1: [] };
}

function cellText(row: Record<string, string | number | null>, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** `organization AND (any locator) AND (any residue column non-empty)`. */
export function rowMatchesPredicate(
  row: Record<string, string | number | null>,
  predicate: SubjectPredicate,
): boolean {
  if (cellText(row, "organization_id") !== predicate.organizationId) return false;
  const located = predicate.locators.some((locator) =>
    locator.values.includes(cellText(row, locator.column)),
  );
  if (!located) return false;
  if (predicate.residue.length === 0) return true;
  return predicate.residue.some((column) => cellText(row, column.name) !== "");
}

export class InMemoryObservabilitySink implements ObservabilitySink {
  private readonly stored: Stored = emptyStored();
  readonly calls: SinkCall[] = [];

  /** What the next probe reports. Default is a working store. */
  health: SinkHealth = sinkHealth("ready", "in-memory sink");
  /** Set to make the next probe THROW, proving the caller's guard. */
  probeThrows = false;
  /** Set to make every insert refuse. */
  insertFails = false;
  /** Set to make every count refuse — the unverifiable-erasure path. */
  countFails = false;
  /** Set to make every clear refuse. */
  clearFails = false;
  /** Set to make a clear report ACCEPTED-BUT-UNCONFIRMED rather than confirmed. */
  clearUnconfirmed = false;
  /** Set to make a clear silently do nothing, so the re-count finds residue. */
  clearIsANoOp = false;

  rows(table: ProjectionTable): readonly ProjectionRow[] {
    return this.stored[table];
  }

  get size(): number {
    return PROJECTION_TABLES.reduce((total, table) => total + this.stored[table].length, 0);
  }

  callsTo(call: SinkCall["call"]): readonly SinkCall[] {
    return this.calls.filter((entry) => entry.call === call);
  }

  /** Seed rows without going through an insert, for arranging a test. */
  seed(table: ProjectionTable, rows: readonly ProjectionRow[]): void {
    for (const row of rows) this.stored[table].push({ ...row });
  }

  async insert(rows: ProjectionRows): Promise<Result<InsertReceipt>> {
    let accepted = 0;
    for (const table of PROJECTION_TABLES) accepted += rows[table].length;
    this.calls.push({ call: "insert", rows: accepted });
    if (this.insertFails) return err(sinkRejectedBatch("insert refused"));
    for (const table of PROJECTION_TABLES) {
      for (const row of rows[table]) this.stored[table].push({ ...row });
    }
    return ok({ rowsAccepted: accepted });
  }

  async probe(): Promise<SinkHealth> {
    this.calls.push({ call: "probe" });
    if (this.probeThrows) throw new TypeError("probe exploded");
    return this.health;
  }

  async countSubjectRows(request: CountSubjectRowsRequest): Promise<Result<number>> {
    this.calls.push({ call: "countSubjectRows", table: request.table });
    if (this.countFails) return err(sinkUnreachable("count refused"));
    return ok(this.stored[request.table].filter((row) => rowMatchesPredicate(row, request.predicate)).length);
  }

  async clearSubjectColumns(
    request: ClearSubjectColumnsRequest,
  ): Promise<Result<ClearSubjectColumnsReceipt>> {
    this.calls.push({ call: "clearSubjectColumns", table: request.table });
    if (this.clearFails) return err(sinkUnreachable("clear refused"));
    if (!this.clearIsANoOp) {
      for (const row of this.stored[request.table]) {
        if (!rowMatchesPredicate(row, request.predicate)) continue;
        for (const column of request.cleared) {
          row[column.name] = column.to === "null" ? null : "";
        }
      }
    }
    return ok({
      confirmed: !this.clearUnconfirmed,
      detail: this.clearUnconfirmed ? "accepted, not yet applied" : "applied",
    });
  }
}
