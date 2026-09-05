// Rules the `Event` row carries that neither `schema.prisma` nor an in-memory
// double knows about.
//
// EVERY ONE OF THEM WAS READ OUT OF THE MIGRATIONS OR OUT OF THE LIVE CATALOGUE,
// not out of the schema file. Tranche 1 was refused on its first integration run
// by a CHECK that exists only in `migrations/00000000000000_initial/migration.sql`,
// and tranche 2 found sixteen more of the same kind. The four here are the
// outbox's share, plus three facts about the table that are not constraints at
// all and change what a correct writer and a correct drain have to do.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { OutboxInsertRow } from "./outbox-store.js";
import { ENVIRONMENT_UNKNOWN } from "./outbox-store.js";
import type { OutboxHarness } from "./outbox-harness.js";
import { startOutboxHarness } from "./outbox-harness.js";

let harness: OutboxHarness;
let sequence = 0;

beforeAll(async () => {
  harness = await startOutboxHarness();
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

const AT = new Date("2026-05-01T09:00:00.000Z");

function eventId(): string {
  sequence += 1;
  const tail = sequence.toString(16).padStart(4, "0");
  return `01926f9d-${tail}-7000-8000-0000000${tail}0`;
}

function row(overrides: Partial<OutboxInsertRow> = {}): OutboxInsertRow {
  return {
    eventId: eventId(),
    environmentId: harness.first.environmentId,
    eventType: "tenancy.invitation.issued",
    subjectId: null,
    envelope: { outboxEnvelope: 1, schemaVersion: 1, requestId: null, scope: {}, payload: {} },
    createdAt: AT,
    ...overrides,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("constraints that live only in the migrations", () => {
  test("Event_payload_json_root refuses a payload that is not a JSON OBJECT", async () => {
    // `ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_payload_json_root"
    //  CHECK (jsonb_typeof("payload") = 'object')` — migration only. The kernel's
    // JsonValue admits an array, a string and a number, so a producer appending
    // `payload: [1, 2]` is legal at the type level and would be refused HERE if
    // the outbox adapter did not wrap every body in an envelope. The cast below
    // is what a store without that envelope would send.
    const bare = row();
    const refused = await harness.adapter.unitOfWork
      .run((transaction) =>
        harness.adapter.insertOutboxEvent(
          { ...bare, envelope: [1, 2] as unknown as Readonly<Record<string, unknown>> },
          transaction,
        ),
      )
      .catch(messageOf);
    expect(String(refused)).toMatch(/Event_payload_json_root|violates check constraint/u);
    expect((await harness.durableRows()).map((event) => event.eventId)).not.toContain(bare.eventId);
  });

  test("a bare string and a bare number are refused by the same CHECK", async () => {
    for (const payload of ["text", 7]) {
      const bare = row();
      const refused = await harness.adapter.unitOfWork
        .run((transaction) =>
          harness.adapter.insertOutboxEvent(
            { ...bare, envelope: payload as unknown as Readonly<Record<string, unknown>> },
            transaction,
          ),
        )
        .catch(messageOf);
      expect(String(refused)).toMatch(/Event_payload_json_root|violates check constraint/u);
    }
  });

  test("Event_environmentId_fkey refuses an event whose environment does not exist", async () => {
    const orphan = row({ environmentId: "00000000-0000-4000-8000-000000000000" });
    const refusal = await harness.adapter.unitOfWork
      .run((transaction) => harness.adapter.insertOutboxEvent(orphan, transaction))
      .catch((error: unknown) => (error as { readonly code?: string }).code);
    expect(refusal).toBe(ENVIRONMENT_UNKNOWN);
  });

  test("the identifier column is UUID, so a readable placeholder is refused", async () => {
    // The in-memory double takes any string, and so does every unit test in the
    // tree. `Event.id` is `UUID NOT NULL`, so "event-1" never reaches a row.
    const refused = await harness.adapter.unitOfWork
      .run((transaction) => harness.adapter.insertOutboxEvent(row({ eventId: "event-1" }), transaction))
      .catch(messageOf);
    expect(String(refused)).toMatch(/uuid|Inconsistent column data|invalid input syntax/iu);
  });

  test("ON DELETE CASCADE takes the events with the environment", async () => {
    // Not a refusal — a DELETION. The foreign key is
    // `ON DELETE CASCADE ON UPDATE CASCADE`, so removing an Environment removes
    // every event ever appended for it, including ones no drain has read. A
    // drain therefore cannot treat "the row is gone" as "I already read it".
    const tenant = await harness.seedTenant("outbox-cascade");
    const doomed = row({ environmentId: tenant.environmentId });
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.insertOutboxEvent(doomed, transaction),
    );
    expect((await harness.durableRows()).map((event) => event.eventId)).toContain(doomed.eventId);

    await harness.onlooker.environment.delete({ where: { id: tenant.environmentId } });
    expect((await harness.durableRows()).map((event) => event.eventId)).not.toContain(
      doomed.eventId,
    );
  });
});

describe("facts about the table that change what a correct writer must do", () => {
  test("createdAt is TIMESTAMP(3): two events of one millisecond TIE on it", async () => {
    const precision = await harness.onlooker.$queryRaw<{ readonly datetime_precision: number }[]>`
      SELECT datetime_precision FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Event' AND column_name = 'createdAt'`;
    expect(precision[0]?.datetime_precision).toBe(3);

    const tenant = await harness.seedTenant("outbox-tie");
    const first = row({ environmentId: tenant.environmentId });
    const second = row({ environmentId: tenant.environmentId });
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.insertOutboxEvent(first, transaction);
      await harness.adapter.insertOutboxEvent(second, transaction);
    });
    const stored = (await harness.durableRows()).filter((event) =>
      [first.eventId, second.eventId].includes(event.eventId),
    );
    expect(stored).toHaveLength(2);
    expect(stored[0]?.createdAt.getTime()).toBe(stored[1]?.createdAt.getTime());
    // Which is why the identifier is a UUIDv7 and the cursor is a PAIR: ordering
    // by the timestamp alone would leave these two to the planner.
    expect(first.eventId < second.eventId).toBe(true);
  });

  test("the id column carries NO database default, so every writer must supply one", async () => {
    // `schema.prisma` says `@default(uuid())`, which is generated CLIENT-side.
    // The migration created the column with no DEFAULT at all, so a raw INSERT
    // that omits the identifier fails — and this adapter always supplies one.
    const columns = await harness.onlooker.$queryRaw<{ readonly column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Event' AND column_name = 'id'`;
    expect(columns[0]?.column_default).toBeNull();
  });

  test("eventType is unconstrained TEXT: the name rule is the adapter's alone", async () => {
    // A negative control for the envelope's `NAME_INVALID`. PostgreSQL accepts
    // any string here, so a drain routing on the first dotted segment is relying
    // entirely on the outbox adapter having refused the ones that are not names.
    const checks = await harness.onlooker.$queryRaw<{ readonly count: bigint }[]>`
      SELECT count(*) AS count FROM information_schema.check_constraints c
      JOIN information_schema.constraint_column_usage u
        ON u.constraint_name = c.constraint_name
      WHERE u.table_name = 'Event' AND u.column_name = 'eventType'
        AND c.check_clause NOT LIKE '%IS NOT NULL%'`;
    expect(Number(checks[0]?.count ?? 0)).toBe(0);

    const tenant = await harness.seedTenant("outbox-any-name");
    const shouty = row({ environmentId: tenant.environmentId, eventType: "NOT A NAME" });
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.insertOutboxEvent(shouty, transaction),
    );
    expect((await harness.durableRows()).map((event) => event.eventType)).toContain("NOT A NAME");
  });

  test("no index covers the drain's ordering, and this is recorded rather than assumed", async () => {
    // The only index on the table is
    // `Event_environmentId_eventType_createdAt_idx`, which a drain reading ALL
    // environments in `(createdAt, id)` order cannot use as a leading key. The
    // drain is one statement and stays one statement whatever the row count —
    // `outbox-statements.integration.test.ts` measures that — but its scan is
    // not index-backed, and adding the index is a migration this tranche did not
    // take. Pinned here so the day somebody adds it, this case says so.
    const indexes = await harness.onlooker.$queryRaw<{ readonly indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Event'`;
    const definitions = indexes.map((index) => index.indexdef);
    expect(definitions.some((definition) => /\("createdAt", "?id"?\)/u.test(definition))).toBe(false);
    expect(definitions.some((definition) => /environmentId.*eventType.*createdAt/u.test(definition))).toBe(
      true,
    );
  });

  test("an organization-scoped event has no row: environmentId is NOT NULL", async () => {
    // The refusal the envelope raises is a fact about THIS schema, and here is
    // the schema saying it. `privacy` emits organization-scoped erasure events
    // today, and until an ordered migration widens this table they cannot be
    // stored — which is reported, not absorbed.
    const nullable = await harness.onlooker.$queryRaw<{ readonly is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Event' AND column_name = 'environmentId'`;
    expect(nullable[0]?.is_nullable).toBe("NO");

    const columns = await harness.onlooker.$queryRaw<{ readonly column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Event'`;
    const names = columns.map((column) => column.column_name);
    expect(names).not.toContain("organizationId");
    expect(names).not.toContain("projectId");
    expect(names.sort()).toEqual(
      ["createdAt", "environmentId", "eventType", "id", "payload", "subjectId"].sort(),
    );
  });

  test("a row written BEFORE the envelope existed is still readable", async () => {
    // Expand and contract: `Event` has a live writer in the legacy tree that
    // stores a bare body with a real `subjectId`. The store hands it back
    // unchanged and the outbox adapter's decoder reports it as scopeless.
    const tenant = await harness.seedTenant("outbox-legacy");
    const legacy = eventId();
    await harness.seedLegacyRow({
      eventId: legacy,
      environmentId: tenant.environmentId,
      eventType: "mcp.platform.emitted",
      subjectId: "subject-42",
      payload: { channel: "slack", messageId: "m-1" },
      createdAt: new Date(AT.getTime() + 5),
    });
    const stored = (await harness.durableRows()).find((event) => event.eventId === legacy);
    expect(stored?.subjectId).toBe("subject-42");
    expect(stored?.payload).toEqual({ channel: "slack", messageId: "m-1" });

    const page = await harness.adapter.readOutboxEventsAfter(
      { createdAt: new Date(AT.getTime() + 4), eventId: "00000000-0000-4000-8000-000000000000" },
      10,
    );
    expect(page.map((event) => event.eventId)).toContain(legacy);
  });

  test("the tenant tree the events hang off is the one the ports built", async () => {
    // A guard against a fixture that seeded rows PostgreSQL would not have
    // accepted from the adapter: every environment used above resolves.
    const environment = await harness.onlooker.environment.findUnique({
      where: { id: harness.first.environmentId },
    });
    expect(environment).not.toBeNull();
    expect(asIdentifier(environment?.projectId ?? "")).toBe(harness.first.projectId);
  });
});
