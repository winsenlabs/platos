// The double's half of the conformance differential.
//
// It replays `conformance-scenario.json` against the in-memory store and
// compares the transcript to the `expected` block committed in that same file.
// `packages/adapters/postgres-tenancy` replays the SAME document against a real
// PostgreSQL and compares to the SAME block, so the two stores are measured
// against one written-down expectation rather than against each other's suites.
//
// THE TWO NEGATIVE CONTROLS AT THE BOTTOM are what stop this from being a
// tautology. A conformance run that only ever passes proves that the double
// agrees with itself. Each control breaks the double in one of the two ways the
// real defect took — a store outside the snapshot set, and a store that does not
// refuse a duplicate — and requires the transcript to STOP matching.

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { TransactionId, TransactionScope, UnitOfWork } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type { ConformanceScenario } from "./conformance.js";
import { runOutboxConformance } from "./conformance.js";
import { createInMemoryOutbox } from "./in-memory.js";
import type { OutboxCursor, OutboxEventStore, OutboxInsert, OutboxStoredRow } from "./store.js";

const SCENARIO = JSON.parse(
  readFileSync(new URL("../conformance-scenario.json", import.meta.url), "utf8"),
) as ConformanceScenario;

/** The seeded environments the scenario's KEYS stand for. */
export const CONFORMANCE_ENVIRONMENTS = {
  envA: "aaaaaaaa-0000-4000-8000-00000000000a",
  envB: "bbbbbbbb-0000-4000-8000-00000000000b",
};

describe("the committed scenario", () => {
  test("names an expected observation for every step", () => {
    expect(SCENARIO.steps.length).toBeGreaterThan(0);
    expect(SCENARIO.expected).toHaveLength(SCENARIO.steps.length);
    expect(SCENARIO.expected.map((observation) => observation["step"])).toEqual(
      SCENARIO.steps.map((step) => step.name),
    );
  });

  test("the in-memory store reproduces the committed transcript exactly", async () => {
    const memory = createInMemoryOutbox();
    const observed = await runOutboxConformance(
      memory.store,
      memory.unitOfWork,
      SCENARIO,
      CONFORMANCE_ENVIRONMENTS,
    );
    expect(observed).toEqual(SCENARIO.expected);
  });
});

/**
 * A unit of work that does NOT restore its store on a rollback.
 *
 * This is the `conversations` defect, rebuilt: `TestOutbox` was not in the
 * snapshot set, so a rolled-back transaction left its appended event behind.
 */
function leakyOutbox(): { readonly store: OutboxEventStore; readonly unitOfWork: UnitOfWork } {
  const rows: OutboxStoredRow[] = [];
  let counter = 0;
  const unitOfWork: UnitOfWork = {
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      counter += 1;
      return work({ transactionId: asIdentifier<TransactionId>(`leaky-${String(counter)}`) });
    },
  };
  const store: OutboxEventStore = {
    insertOutboxEvent: async (row: OutboxInsert): Promise<void> => {
      if (rows.some((existing) => existing.eventId === row.eventId)) {
        throw new Error("duplicate");
      }
      rows.push({
        eventId: row.eventId,
        environmentId: row.environmentId,
        eventType: row.eventType,
        subjectId: row.subjectId,
        payload: row.envelope as unknown,
        createdAt: row.createdAt,
      });
      return Promise.resolve();
    },
    readOutboxEventsAfter: (cursor: OutboxCursor | null, limit: number) =>
      Promise.resolve(
        [...rows]
          .sort((left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            (left.eventId < right.eventId ? -1 : 1),
          )
          .filter(
            (row) =>
              cursor === null ||
              row.createdAt.getTime() > cursor.createdAt.getTime() ||
              (row.createdAt.getTime() === cursor.createdAt.getTime() && row.eventId > cursor.eventId),
          )
          .slice(0, limit),
      ),
  };
  return { store, unitOfWork };
}

describe("the differential is not vacuous", () => {
  test("a store that does NOT roll back fails the scenario", async () => {
    const leaky = leakyOutbox();
    const observed = await runOutboxConformance(
      leaky.store,
      leaky.unitOfWork,
      SCENARIO,
      CONFORMANCE_ENVIRONMENTS,
    );
    expect(observed).not.toEqual(SCENARIO.expected);
    const step = SCENARIO.steps.findIndex((entry) => entry.name === "the rolled-back event is not in the outbox");
    expect(step).toBeGreaterThan(-1);
    const rows = observed[step]?.["rows"] as readonly { readonly eventId: string }[];
    // The event appended inside the rejected transaction is STILL THERE, which
    // is exactly what shipped in `conversations`.
    expect(rows.map((row) => row.eventId)).toContain("01926f9c-0000-7000-8000-000000000003");
  });

  test("a store whose transaction guards never refuse fails the scenario", async () => {
    const memory = createInMemoryOutbox();
    const permissive: OutboxEventStore = {
      insertOutboxEvent: (row: OutboxInsert) =>
        memory.unitOfWork.run((live) => memory.store.insertOutboxEvent(row, live)),
      readOutboxEventsAfter: memory.store.readOutboxEventsAfter,
    };
    const observed = await runOutboxConformance(
      permissive,
      memory.unitOfWork,
      SCENARIO,
      CONFORMANCE_ENVIRONMENTS,
    );
    expect(observed).not.toEqual(SCENARIO.expected);
  });
});
