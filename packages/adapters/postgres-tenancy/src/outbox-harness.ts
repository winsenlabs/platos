// The real-PostgreSQL harness the four outbox integration suites share.
//
// It builds on `startIdentityHarness`, which builds on `startTenancyHarness`,
// for the reason that one built on this one: `Event` lives in the SAME database
// behind the SAME client as every other canonical row, and a suite that started
// a container of its own would be measuring a different arrangement from the one
// that ships. It also needs a real tenant tree — `Event.environmentId` is
// `UUID NOT NULL` with a live foreign key to `Environment` — and `seedTenant`
// already makes one through the ports.
//
// TWO THINGS THIS ADDS. A SECOND CLIENT over the same database, because
// durability is not "the writer can see its row" but "somebody else can"; and a
// raw INSERT for a legacy-shaped row, because the pre-envelope rows this reader
// has to tolerate are written by a producer in the legacy tree that this package
// cannot call, and writing one through the outbox store would produce an
// envelope rather than the bare body the expand-and-contract case is about.

import type { OutboxReadRow } from "./outbox-store.js";
import type { PostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

export interface OutboxHarness {
  readonly adapter: PostgresTenancyAdapter;
  readonly client: TenancyDatabaseClient;
  /** A client over the same database that this adapter's pool never touched. */
  readonly onlooker: TenancyDatabaseClient;
  readonly first: SeededTenant;
  readonly second: SeededTenant;
  statements(): readonly string[];
  resetStatements(): void;
  freshId(kind: string): string;
  /** Every `Event` row, oldest first, READ THROUGH THE SECOND CLIENT. */
  durableRows(): Promise<readonly OutboxReadRow[]>;
  /** A row shaped the way the legacy producer writes one: a bare body. */
  seedLegacyRow(input: {
    readonly eventId: string;
    readonly environmentId: string;
    readonly eventType: string;
    readonly subjectId: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }): Promise<void>;
  seedTenant(slug: string): Promise<SeededTenant>;
  stop(): Promise<void>;
}

export async function startOutboxHarness(): Promise<OutboxHarness> {
  const base: IdentityHarness = await startIdentityHarness();
  const onlooker = createTenancyDatabaseClient({ databaseUrl: base.databaseUrl });
  const first = await base.seedTenant("outbox-first");
  const second = await base.seedTenant("outbox-second");

  return {
    adapter: base.adapter,
    client: base.client,
    onlooker,
    first,
    second,
    statements: base.statements,
    resetStatements: base.resetStatements,
    freshId: base.freshId,
    seedTenant: base.seedTenant,

    async durableRows(): Promise<readonly OutboxReadRow[]> {
      const rows = await onlooker.event.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return rows.map((row) => ({
        eventId: row.id,
        environmentId: row.environmentId,
        eventType: row.eventType,
        subjectId: row.subjectId,
        payload: row.payload as unknown,
        createdAt: row.createdAt,
      }));
    },

    async seedLegacyRow(input): Promise<void> {
      // Parameterised raw SQL through the ONLOOKER, deliberately. The legacy
      // producer is `apps/agent`, which this package cannot call, and the point
      // of the row is that it carries a bare body rather than an envelope — so
      // it cannot be written through the outbox store without becoming the thing
      // it is standing in for.
      await onlooker.$executeRaw`
        INSERT INTO "public"."Event" ("id", "environmentId", "eventType", "subjectId", "payload", "createdAt")
        VALUES (
          ${input.eventId}::uuid,
          ${input.environmentId}::uuid,
          ${input.eventType},
          ${input.subjectId},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.createdAt}
        )`;
    },

    async stop(): Promise<void> {
      await onlooker.$disconnect();
      await base.stop();
    },
  };
}
