// The shutdown flush: drain the outbox to quiescence, or to a budget.
//
// WHY DRAINING IT AT SHUTDOWN IS NOT OPTIONAL.
//
// The outbox row is written INSIDE the transaction that wrote the state it
// describes, which is what makes emission atomic (ADR M0.3 §7 decision 8). The
// other half of that bargain is that the row is emitted LATER, by a drain. So at
// the moment a process is asked to stop, the rows written by the requests it has
// just finished draining are sitting in the table with nobody holding them. A
// process that exits there is CORRECT and it is SLOW: nothing is lost, but every
// event waits for whichever process next runs a drain, and during a rolling
// restart of a whole fleet that can be the far side of the restart. A budget
// alert, a webhook, an analytical projection — each arrives minutes late for no
// reason other than that shutdown did not spend its last second on them.
//
// WHY IT LIVES IN THIS PACKAGE RATHER THAN AT THE PROCESS EDGE. It was drafted
// there, under `apps/core-api/src/runtime/`, and `scripts/arch/composition-root.mjs`
// refused it: rule (C1) allows EXACTLY ONE importer of an adapter package, and
// that is `apps/core-api/src/composition/adapter-bindings.ts`. The refusal was
// right, and not only on the letter. Everything the loop below knows is
// outbox knowledge — that a cursor is a pair, that a SHORT page is not the end
// and only an EMPTY one is, that a null cursor accompanies an empty page. A copy
// of that at the process edge would be a second place to get the outbox's paging
// contract wrong. What the process edge owns is the BUDGET, and it hands that
// in.
//
// THE RESULT IS A `Drainable`, STRUCTURALLY. This package may not import
// `apps/core-api`, so the shape is declared here and the agreement is proven at
// the composition root — the same arrangement `OutboxEventStore` in `./store.js`
// uses, and for the same reason.
//
// ORDER IS THE CALLER'S, and it matters: this runs AFTER the in-flight request
// drain, because a request still running is still capable of appending to the
// outbox, and a flush that reached an empty page while a request was
// mid-transaction would have proved nothing.
//
// AT-LEAST-ONCE, SAID OUT LOUD. The handler is called with a page BEFORE the
// cursor advances past it, and the cursor lives only in this call. If the
// process dies between the handler returning and the next page, the next
// process's drain starts from ITS own stored position and re-delivers. That is
// the outbox contract, not a defect: `Event` has no `deliveredAt` and no
// `status` column, because §7 decision 8 chose one physical outbox behind
// several drains and each drain holds its own position. A shutdown flush
// claiming exactly-once would be claiming a column the table does not have.

import type { OutboxAdapter, OutboxDrainPage } from "./adapter.js";
import type { OutboxCursor } from "./store.js";

/** A page size or page cap that is not a positive whole number. */
export const FLUSH_PAGE_INVALID = "outbox.flush.page_invalid";

/** The flush stopped because the shutdown budget ran out mid-drain. */
export const FLUSH_BUDGET_SPENT = "outbox.flush.budget_spent";

/** The flush stopped because the source refused, faulted or answered nonsense. */
export const FLUSH_SOURCE_FAULTED = "outbox.flush.source_faulted";

export class OutboxFlushError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboxFlushError";
    this.code = code;
  }
}

/**
 * The narrow half of this adapter a flush needs.
 *
 * A PROPERTY, NOT A METHOD. TypeScript checks a method's parameters bivariantly
 * even under `strict`, so a source declaring a narrower cursor would still
 * satisfy a method-shaped seam and the proof below would pass while the two
 * halves disagreed about the cursor. Declared as a function-typed property,
 * `strictFunctionTypes` checks it contravariantly and that change fails the
 * build. `./store.js` records the same finding for the write half, which is
 * where it was first found.
 */
export interface OutboxFlushSource {
  readonly drain: (cursor: OutboxCursor | null, limit: number) => Promise<OutboxDrainPage>;
}

/** What the flush hands each page to. Resolves when the page is handed on. */
export type OutboxFlushHandler = (page: OutboxDrainPage) => Promise<void>;

/** One subsystem's shutdown drain, in the shape `apps/core-api` sequences. */
export interface OutboxFlushOutcome {
  /** True only at quiescence: an empty page came back. */
  readonly drained: boolean;
  /** Events handed to the handler during this flush. */
  readonly handled: number;
  /** Left behind. Null when the flush cannot cheaply say. */
  readonly remaining: number | null;
  /** Why it stopped, or null when it stopped because it was finished. */
  readonly stoppedBecause: string | null;
}

export interface OutboxFlush {
  readonly name: "outbox";
  drain(budgetMs: number, now: () => number): Promise<OutboxFlushOutcome>;
}

export interface OutboxFlushOptions {
  readonly source: OutboxFlushSource;
  readonly handler: OutboxFlushHandler;
  /** Rows per page. A positive whole number; `drain` refuses anything else. */
  readonly pageSize: number;
  /** Cap on pages, so a table still being written to cannot hold shutdown open. */
  readonly maxPages?: number;
}

/** Twenty pages is a bounded flush, not a backfill. */
export const DEFAULT_MAX_PAGES = 20;

/**
 * Build the shutdown flush.
 *
 * `pageSize` is validated HERE rather than left to `OutboxAdapter.drain`, and
 * with a code of its own. `DRAIN_LIMIT_INVALID` is raised at drain time, which
 * is during shutdown — the one moment there is no budget to spend on a
 * programming error, and the moment it is most likely to be read as "the outbox
 * could not be drained" rather than "this process was mis-wired".
 */
export function createOutboxFlush(options: OutboxFlushOptions): OutboxFlush {
  requireWholePositive(options.pageSize, "page size");
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  requireWholePositive(maxPages, "page cap");

  return {
    name: "outbox",
    async drain(budgetMs: number, now: () => number): Promise<OutboxFlushOutcome> {
      const startedAt = now();
      let cursor: OutboxCursor | null = null;
      let handled = 0;

      for (let page = 0; page < maxPages; page += 1) {
        // CHECKED BEFORE EACH READ, not after. Reading a page this flush has no
        // time to hand on is the one way it can lose an event: the row leaves
        // the table's unread tail, the handler never sees it, and the cursor
        // this call held goes out of scope with it.
        if (now() - startedAt >= budgetMs) {
          return { drained: false, handled, remaining: null, stoppedBecause: FLUSH_BUDGET_SPENT };
        }

        let read: OutboxDrainPage;
        try {
          read = await options.source.drain(cursor, options.pageSize);
        } catch (cause) {
          return { drained: false, handled, remaining: null, stoppedBecause: faulted(cause) };
        }

        // AN EMPTY PAGE IS QUIESCENCE, and it is the only thing that is. A SHORT
        // page is not: this adapter pages by cursor, so a page under the limit
        // still means "everything up to here", and stopping on one would leave
        // the tail behind on every uneven flush.
        if (read.events.length === 0) {
          return { drained: true, handled, remaining: 0, stoppedBecause: null };
        }

        await options.handler(read);
        handled += read.events.length;
        cursor = read.cursor;
        if (cursor === null) {
          // Unreachable through this package's own adapter, which returns a null
          // cursor only for an empty page. Handled because the seam is
          // STRUCTURAL: a source that answered rows and no cursor would
          // otherwise re-read the same page to the cap and hand the same events
          // on twenty times.
          return { drained: false, handled, remaining: null, stoppedBecause: FLUSH_SOURCE_FAULTED };
        }
      }

      return { drained: false, handled, remaining: null, stoppedBecause: FLUSH_BUDGET_SPENT };
    },
  };
}

function requireWholePositive(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new OutboxFlushError(
      FLUSH_PAGE_INVALID,
      `an outbox shutdown flush needs a positive whole ${what}; received ${String(value)}`,
    );
  }
}

function faulted(cause: unknown): string {
  return `${FLUSH_SOURCE_FAULTED}: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/**
 * The in-package proof that this adapter satisfies the seam above.
 *
 * ADR M0.3 §5.1 rule (j2) lets an adapter name its OWN modules, so the
 * obligation between two halves of this package is checkable here. The other
 * obligation — that `OutboxFlush` is the `Drainable` the process edge sequences
 * — cannot be, because this package may not import `apps/core-api`; it is proven
 * at the composition root instead, beside `OUTBOX_STORE_SATISFACTION`.
 */
type Satisfies<Candidate, Seam> = Candidate extends Seam ? true : never;

export const OUTBOX_FLUSH_SOURCE_SATISFACTION: Satisfies<OutboxAdapter, OutboxFlushSource> = true;
