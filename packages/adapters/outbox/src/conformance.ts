// One scenario, run against BOTH stores, with the two transcripts compared
// value by value.
//
// WHY THE SCENARIO IS DATA AND THE RUNNER IS CODE. The two stores live in two
// adapter packages and ADR M0.3 §5.1 rule (j2) forbids either from importing the
// other, so they cannot share a module. Two independently written suites would
// measure two things and agree by coincidence — which is the failure this file
// exists to prevent — so the SEQUENCE OF CALLS and the EXPECTED TRANSCRIPT are a
// committed JSON document, `conformance-scenario.json`, and each package holds a
// small runner over it. The runner is the only thing duplicated, and a runner
// that drifted would produce a transcript that no longer matches the committed
// one, which fails both suites rather than neither.
//
// WHY IT DRIVES THE STORE AND NOT THE ADAPTER. Everything above the store —
// the identifier, the instant, the envelope — is decided in this package and is
// the same code on both sides, so running it twice would compare it with itself.
// The seam where a double can be WRONG is lower down: whether a row survives a
// rolled-back transaction, whether a duplicate key is refused, whether a page
// comes back in append order. Rows in the scenario are therefore fully spelled
// out, with fixed identifiers and fixed instants, and nothing in a transcript
// depends on a clock or a random draw.

import type { TransactionId, TransactionScope, UnitOfWork } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type { OutboxCursor, OutboxEventStore, OutboxInsert } from "./store.js";

/** A row the scenario writes, with its environment named by KEY, not by id. */
export interface ScenarioRow {
  readonly eventId: string;
  readonly environment: string;
  readonly eventType: string;
  readonly subjectId: string | null;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type ScenarioStep =
  | { readonly op: "commit"; readonly name: string; readonly rows: readonly ScenarioRow[] }
  | { readonly op: "reject"; readonly name: string; readonly rows: readonly ScenarioRow[] }
  | { readonly op: "outside"; readonly name: string; readonly row: ScenarioRow }
  | { readonly op: "stale"; readonly name: string; readonly row: ScenarioRow }
  | { readonly op: "drain"; readonly name: string; readonly from: "start" | "cursor"; readonly limit: number };

export interface ConformanceScenario {
  readonly environments: readonly string[];
  readonly steps: readonly ScenarioStep[];
  readonly expected: readonly ConformanceObservation[];
}

/** What one step observed. Compared verbatim between the two stores. */
export type ConformanceObservation = Record<string, unknown>;

/** Real identifiers for the environment KEYS the scenario names. */
export type EnvironmentMap = Readonly<Record<string, string>>;

function refusalOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

function insertOf(row: ScenarioRow, environments: EnvironmentMap): OutboxInsert {
  const environmentId = environments[row.environment];
  if (environmentId === undefined) {
    throw new Error(`the scenario names environment "${row.environment}", which was not supplied`);
  }
  return {
    eventId: row.eventId,
    environmentId,
    eventType: row.eventType,
    subjectId: row.subjectId,
    envelope: row.envelope,
    createdAt: new Date(row.createdAt),
  };
}

/**
 * Replay `scenario` against `store` and record what happened.
 *
 * A REJECTED transaction is driven by making the LAST row of the step a
 * duplicate of one already committed, so the failure comes from the store's own
 * refusal rather than from a thrown marker: a double that never refuses a
 * duplicate would produce a committed transaction here and a transcript that
 * cannot match the real store's.
 */
export async function runOutboxConformance(
  store: OutboxEventStore,
  unitOfWork: UnitOfWork,
  scenario: ConformanceScenario,
  environments: EnvironmentMap,
): Promise<readonly ConformanceObservation[]> {
  const observed: ConformanceObservation[] = [];
  let cursor: OutboxCursor | null = null;
  // A HOLDER, not a bare `let`. The scope is assigned inside a callback, and a
  // narrowed `let` would be read back as `null` at every later use.
  const state: { finished: TransactionScope | null } = { finished: null };

  for (const step of scenario.steps) {
    if (step.op === "commit" || step.op === "reject") {
      const written: string[] = [];
      let refusal: string | null = null;
      try {
        await unitOfWork.run(async (transaction) => {
          state.finished = transaction;
          for (const row of step.rows) {
            await store.insertOutboxEvent(insertOf(row, environments), transaction);
            written.push(row.eventId);
          }
        });
      } catch (error) {
        refusal = refusalOf(error);
      }
      observed.push({ step: step.name, op: step.op, written, refusal });
      continue;
    }

    if (step.op === "outside") {
      const scope: TransactionScope = state.finished ?? {
        transactionId: asIdentifier<TransactionId>("never-opened"),
      };
      let refusal: string | null = null;
      try {
        await store.insertOutboxEvent(insertOf(step.row, environments), scope);
      } catch (error) {
        refusal = refusalOf(error);
      }
      observed.push({ step: step.name, op: step.op, refusal });
      continue;
    }

    if (step.op === "stale") {
      const stale = state.finished;
      let refusal: string | null = null;
      await unitOfWork.run(async (live) => {
        try {
          await store.insertOutboxEvent(insertOf(step.row, environments), stale ?? live);
        } catch (error) {
          refusal = refusalOf(error);
        }
      });
      observed.push({ step: step.name, op: step.op, refusal });
      continue;
    }

    const from = step.from === "start" ? null : cursor;
    const rows = await store.readOutboxEventsAfter(from, step.limit);
    const last = rows.at(-1);
    if (last !== undefined) cursor = { createdAt: last.createdAt, eventId: last.eventId };
    observed.push({
      step: step.name,
      op: step.op,
      rows: rows.map((row) => ({
        eventId: row.eventId,
        eventType: row.eventType,
        subjectId: row.subjectId,
        createdAt: row.createdAt.toISOString(),
        payload: row.payload,
      })),
    });
  }

  return observed;
}
