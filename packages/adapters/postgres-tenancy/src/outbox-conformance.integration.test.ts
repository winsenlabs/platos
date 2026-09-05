// The real store's half of the conformance differential.
//
// It replays `packages/adapters/outbox/conformance-scenario.json` against a REAL
// PostgreSQL and compares the transcript to the `expected` block committed in
// that same document — the block the in-memory double is measured against in its
// own package. So the two stores are held to ONE written-down expectation rather
// than to each other's suites, and a divergence names a step and a value.
//
// WHY THE SCENARIO IS READ AND NOT IMPORTED. ADR M0.3 §5.1 rule (j2) forbids one
// adapter importing another, so this package cannot import the outbox's runner.
// The document is DATA — a list of calls and the transcript they must produce —
// and the runner below is the second copy of about forty lines of replay. A copy
// that drifted would produce a transcript that no longer matches the committed
// one, which fails this suite rather than silently measuring something else.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { TransactionId, TransactionScope } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { OutboxHarness } from "./outbox-harness.js";
import { startOutboxHarness } from "./outbox-harness.js";
import type { OutboxReadCursor } from "./outbox-store.js";

interface ScenarioRow {
  readonly eventId: string;
  readonly environment: string;
  readonly eventType: string;
  readonly subjectId: string | null;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

type ScenarioStep =
  | { readonly op: "commit"; readonly name: string; readonly rows: readonly ScenarioRow[] }
  | { readonly op: "reject"; readonly name: string; readonly rows: readonly ScenarioRow[] }
  | { readonly op: "outside"; readonly name: string; readonly row: ScenarioRow }
  | { readonly op: "stale"; readonly name: string; readonly row: ScenarioRow }
  | { readonly op: "drain"; readonly name: string; readonly from: "start" | "cursor"; readonly limit: number };

interface Scenario {
  readonly steps: readonly ScenarioStep[];
  readonly expected: readonly Record<string, unknown>[];
}

const SCENARIO = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../outbox/conformance-scenario.json"),
    "utf8",
  ),
) as Scenario;

let harness: OutboxHarness;
let environments: Record<string, string>;

beforeAll(async () => {
  harness = await startOutboxHarness();
  environments = { envA: harness.first.environmentId, envB: harness.second.environmentId };
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

function refusalOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

function insertOf(row: ScenarioRow): Parameters<OutboxHarness["adapter"]["insertOutboxEvent"]>[0] {
  const environmentId = environments[row.environment];
  if (environmentId === undefined) throw new Error(`unmapped environment ${row.environment}`);
  return {
    eventId: row.eventId,
    environmentId,
    eventType: row.eventType,
    subjectId: row.subjectId,
    envelope: row.envelope,
    createdAt: new Date(row.createdAt),
  };
}

async function replay(): Promise<readonly Record<string, unknown>[]> {
  const { adapter } = harness;
  const observed: Record<string, unknown>[] = [];
  let cursor: OutboxReadCursor | null = null;
  const state: { finished: TransactionScope | null } = { finished: null };

  for (const step of SCENARIO.steps) {
    if (step.op === "commit" || step.op === "reject") {
      const written: string[] = [];
      let refusal: string | null = null;
      try {
        await adapter.unitOfWork.run(async (transaction) => {
          state.finished = transaction;
          for (const row of step.rows) {
            await adapter.insertOutboxEvent(insertOf(row), transaction);
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
      const scope: TransactionScope =
        state.finished ?? { transactionId: asIdentifier<TransactionId>("never-opened") };
      let refusal: string | null = null;
      try {
        await adapter.insertOutboxEvent(insertOf(step.row), scope);
      } catch (error) {
        refusal = refusalOf(error);
      }
      observed.push({ step: step.name, op: step.op, refusal });
      continue;
    }

    if (step.op === "stale") {
      const stale = state.finished;
      let refusal: string | null = null;
      await adapter.unitOfWork.run(async (live) => {
        try {
          await adapter.insertOutboxEvent(insertOf(step.row), stale ?? live);
        } catch (error) {
          refusal = refusalOf(error);
        }
      });
      observed.push({ step: step.name, op: step.op, refusal });
      continue;
    }

    const from = step.from === "start" ? null : cursor;
    const rows = await adapter.readOutboxEventsAfter(from, step.limit);
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

describe("the PostgreSQL outbox store against the committed scenario", () => {
  test("its transcript matches the in-memory double's, observation for observation", async () => {
    const observed = await replay();
    expect(observed).toEqual(SCENARIO.expected);
  });

  test("the rows the scenario committed are on disk, seen from a SEPARATE connection", async () => {
    // The transcript above was read through the adapter's own client. This asks
    // a client that pool never touched, which is what durable means.
    const durable = await harness.durableRows();
    expect(durable.map((row) => row.eventId)).toEqual([
      "01926f9c-0000-7000-8000-000000000001",
      "01926f9c-0000-7000-8000-000000000002",
      "01926f9c-0001-7000-8000-000000000004",
      "01926f9c-0002-7000-8000-000000000005",
    ]);
  });

  test("the event the rejected transaction wrote is on no connection at all", async () => {
    const durable = await harness.durableRows();
    expect(durable.map((row) => row.eventId)).not.toContain(
      "01926f9c-0000-7000-8000-000000000003",
    );
  });
});
