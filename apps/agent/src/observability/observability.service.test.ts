/**
 * ObservabilityService against a real in-memory outbox.
 *
 * The store below is a working implementation of the four Prisma calls the
 * service makes — not a mock of the service. It enforces the same invariants
 * the migration does (unique turnId, and the DELIVERED/deliveredAt pairing),
 * so a test that passes here would not be passing against a database that
 * rejects the write.
 */

import { describe, expect, test } from "vitest";
import {
  ObservabilityService,
  type ObservabilityTransaction,
} from "./observability.service";
import type { ControlDatabaseClient } from "../shared/database.provider";
import { resolveObservabilityConfig, type ObservabilityConfig } from "./observability-config";
import { emptyRows, type ObservabilityRows } from "./observability-event";
import { OBSERVABILITY_PAYLOAD_VERSION, retryDelayMs } from "./observability-outbox";
import { buildTurnProjection } from "./turn-projection";
import type { ObservabilitySink, ObservabilitySinkHealth } from "./observability-sink";

interface StoredRow {
  id: string;
  turnId: string;
  organizationId: string;
  payloadVersion: number;
  payload: unknown;
  status: string;
  attempts: number;
  availableAt: Date;
  lastErrorCode: string | null;
  deliveredAt: Date | null;
}

/** An outbox table that enforces what the migration enforces. */
class OutboxStore {
  readonly rows = new Map<string, StoredRow>();
  private sequence = 0;

  private assertDeliveryInvariant(row: StoredRow): void {
    // ObservabilityOutbox_delivery_check
    if ((row.status === "DELIVERED") !== (row.deliveredAt !== null)) {
      throw new Error("ObservabilityOutbox_delivery_check violated");
    }
    // ObservabilityOutbox_status_check
    if (!["PENDING", "DELIVERED", "FAILED"].includes(row.status)) {
      throw new Error("ObservabilityOutbox_status_check violated");
    }
  }

  readonly observabilityOutbox = {
    upsert: async (args: {
      where: { turnId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = [...this.rows.values()].find((r) => r.turnId === args.where.turnId);
      if (existing) {
        Object.assign(existing, args.update);
        this.assertDeliveryInvariant(existing);
        return existing;
      }
      // Column defaults, exactly as the migration declares them, with the
      // create payload layered on top.
      const created = args.create as Partial<StoredRow>;
      const row: StoredRow = {
        id: created.id ?? `outbox-${++this.sequence}`,
        turnId: created.turnId!,
        organizationId: created.organizationId!,
        payloadVersion: created.payloadVersion ?? 1,
        payload: created.payload,
        status: created.status ?? "PENDING",
        attempts: created.attempts ?? 0,
        availableAt: created.availableAt ?? new Date(),
        lastErrorCode: created.lastErrorCode ?? null,
        deliveredAt: created.deliveredAt ?? null,
      };
      this.assertDeliveryInvariant(row);
      this.rows.set(row.id, row);
      return row;
    },
    findMany: async (args: {
      where: { status: string; availableAt: { lte: Date } };
      take: number;
    }) =>
      [...this.rows.values()]
        .filter(
          (r) => r.status === args.where.status && r.availableAt <= args.where.availableAt.lte,
        )
        .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
        .slice(0, args.take),
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.rows.get(args.where.id);
      if (!row) throw new Error("row not found");
      Object.assign(row, args.data);
      this.assertDeliveryInvariant(row);
      return row;
    },
    deleteMany: async (args: {
      where: { status: string; deliveredAt: { lt: Date } };
    }) => {
      let count = 0;
      for (const [id, row] of this.rows) {
        if (row.status !== args.where.status) continue;
        if (!row.deliveredAt || row.deliveredAt >= args.where.deliveredAt.lt) continue;
        this.rows.delete(id);
        count++;
      }
      return { count };
    },
    count: async (args: { where: { status: string } }) =>
      [...this.rows.values()].filter((r) => r.status === args.where.status).length,
  };

  asPrisma(): ControlDatabaseClient {
    return this as unknown as ControlDatabaseClient;
  }

  asTransaction(): ObservabilityTransaction {
    return this as unknown as ObservabilityTransaction;
  }
}

/** A sink that records what it was handed and answers however the test says. */
class RecordingSink implements ObservabilitySink {
  readonly written: ObservabilityRows[] = [];
  failures = 0;
  health_: ObservabilitySinkHealth = {
    configured: true,
    available: true,
    status: "ready",
    detail: "ready",
  };

  async writeTurn(): Promise<void> {}
  async writeStep(): Promise<void> {}
  async writeToolCall(): Promise<void> {}
  async writeUsage(): Promise<void> {}

  async writeRows(rows: ObservabilityRows): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("ObservabilityWriteError");
    }
    this.written.push(rows);
  }

  async health(): Promise<ObservabilitySinkHealth> {
    return this.health_;
  }
}

const CONFIGURED = { PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "http://clickhouse:8123" };

function service(
  store: OutboxStore,
  sink: ObservabilitySink,
  overrides: Partial<ObservabilityConfig> = {},
): ObservabilityService {
  return new ObservabilityService(store.asPrisma(), sink, () => ({
    ...resolveObservabilityConfig(CONFIGURED),
    ...overrides,
  }));
}

const TURN_ID = "11111111-1111-4111-8111-111111111111";

function projection(turnId = TURN_ID) {
  return buildTurnProjection({
    scope: {
      organizationId: "org-1",
      projectId: "proj-1",
      environmentId: "env-1",
      userId: "user-1",
    },
    thread: { id: "thread-1", agentId: "agent-1", endUserId: "enduser-1" },
    turn: {
      id: turnId,
      status: "completed",
      acceptedAt: new Date("2026-08-20T10:00:00.000Z"),
      completedAt: new Date("2026-08-20T10:00:01.000Z"),
      costCents: 1,
    },
    salt: "test-salt",
  });
}

describe("enqueue", () => {
  test("queues nothing when no sink is configured", async () => {
    // Postgres already holds every fact the projection contains, so queueing
    // for a store that does not exist would accumulate rows in exchange for
    // nothing. This is the one case where not writing is honest.
    const store = new OutboxStore();
    const svc = new ObservabilityService(store.asPrisma(), new RecordingSink(), () =>
      resolveObservabilityConfig({}));
    expect(svc.isEnabled()).toBe(false);
    await expect(svc.enqueueTurn(store.asTransaction(), projection())).resolves.toBe(false);
    expect(store.rows.size).toBe(0);
  });

  test("queues one row per Turn when a sink is configured", async () => {
    const store = new OutboxStore();
    const svc = service(store, new RecordingSink());
    await expect(svc.enqueueTurn(store.asTransaction(), projection())).resolves.toBe(true);
    expect(store.rows.size).toBe(1);
    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({
      turnId: TURN_ID,
      organizationId: "org-1",
      payloadVersion: OBSERVABILITY_PAYLOAD_VERSION,
      status: "PENDING",
    });
  });

  test("a replayed finalize leaves one row, not a constraint violation", async () => {
    // The projection must never be the reason a turn fails.
    const store = new OutboxStore();
    const svc = service(store, new RecordingSink());
    await svc.enqueueTurn(store.asTransaction(), projection());
    await svc.enqueueTurn(store.asTransaction(), projection());
    expect(store.rows.size).toBe(1);
  });

  test("re-arms a parked row when the Turn is projected again", async () => {
    const store = new OutboxStore();
    const svc = service(store, new RecordingSink());
    await svc.enqueueTurn(store.asTransaction(), projection());
    const [row] = [...store.rows.values()];
    Object.assign(row, { status: "FAILED", attempts: 10, lastErrorCode: "old" });

    await svc.enqueueTurn(store.asTransaction(), projection());
    expect(row).toMatchObject({ status: "PENDING", attempts: 0, lastErrorCode: null });
  });

  test("a failing enqueue never propagates into the caller's transaction", async () => {
    const store = new OutboxStore();
    store.observabilityOutbox.upsert = async () => {
      throw new Error("deadlock detected");
    };
    const svc = service(store, new RecordingSink());
    await expect(svc.enqueueTurnBestEffort(store.asTransaction(), projection()))
      .resolves.toBe(false);
  });
});

describe("drain", () => {
  test("delivers a queued row and marks it acknowledged", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    const svc = service(store, sink);
    await svc.enqueueTurn(store.asTransaction(), projection());

    const summary = await svc.drain();
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retried: 0, parked: 0 });
    expect(sink.written).toHaveLength(1);
    expect(sink.written[0].turns_v1[0]).toMatchObject({ organization_id: "org-1" });

    const [row] = [...store.rows.values()];
    expect(row.status).toBe("DELIVERED");
    expect(row.deliveredAt).toBeInstanceOf(Date);
  });

  test("leaves rows queued and claims nothing when the sink is unavailable", async () => {
    // Configured and unreachable: events remain in the outbox, and no write is
    // discarded or reported as delivered.
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.health_ = {
      configured: true,
      available: false,
      status: "unreachable",
      detail: "endpoint did not answer",
    };
    const svc = service(store, sink);
    await svc.enqueueTurn(store.asTransaction(), projection());

    const summary = await svc.drain();
    expect(summary.claimed).toBe(0);
    expect(summary.skipped).toContain("unreachable");
    expect([...store.rows.values()][0].status).toBe("PENDING");
    expect(sink.written).toHaveLength(0);
  });

  test("reschedules a failed delivery with back-off instead of losing it", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.failures = 1;
    const svc = service(store, sink);
    await svc.enqueueTurn(store.asTransaction(), projection());

    const summary = await svc.drain();
    expect(summary).toMatchObject({ claimed: 1, delivered: 0, retried: 1, parked: 0 });
    const [row] = [...store.rows.values()];
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + retryDelayMs(1) - 5_000);
    expect(row.lastErrorCode).toBe("Error");
  });

  test("parks a row that exhausts its attempts, and never deletes it", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.failures = 1;
    const svc = service(store, sink, { maxAttempts: 1 });
    await svc.enqueueTurn(store.asTransaction(), projection());

    const summary = await svc.drain();
    expect(summary).toMatchObject({ delivered: 0, retried: 0, parked: 1 });
    const [row] = [...store.rows.values()];
    expect(row.status).toBe("FAILED");
    expect(store.rows.size).toBe(1);
  });

  test("parks a payload it cannot interpret rather than burning ten attempts", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    const svc = service(store, sink);
    await svc.enqueueTurn(store.asTransaction(), projection());
    // The Json column has repeatedly been found holding a string scalar.
    [...store.rows.values()][0].payload = "not an object";

    const summary = await svc.drain();
    expect(summary.parked).toBe(1);
    expect([...store.rows.values()][0].lastErrorCode).toContain("row shape");
    expect(sink.written).toHaveLength(0);
  });

  test("parks a payload written by a newer writer rather than mangling it", async () => {
    const store = new OutboxStore();
    const svc = service(store, new RecordingSink());
    await svc.enqueueTurn(store.asTransaction(), projection());
    [...store.rows.values()][0].payloadVersion = OBSERVABILITY_PAYLOAD_VERSION + 1;

    const summary = await svc.drain();
    expect(summary.parked).toBe(1);
    expect([...store.rows.values()][0].lastErrorCode).toContain("newer than this writer");
  });

  test("does nothing at all when no sink is configured", async () => {
    const store = new OutboxStore();
    const svc = new ObservabilityService(store.asPrisma(), new RecordingSink(), () =>
      resolveObservabilityConfig({}));
    const summary = await svc.drain();
    expect(summary.skipped).toContain("no observability sink configured");
    expect(summary.claimed).toBe(0);
  });

  test("prunes acknowledged rows past retention and never an undelivered one", async () => {
    const store = new OutboxStore();
    const svc = service(store, new RecordingSink());
    const old = new Date(Date.now() - 30 * 86_400_000);
    store.rows.set("stale-delivered", {
      id: "stale-delivered",
      turnId: "t-1",
      organizationId: "org-1",
      payloadVersion: OBSERVABILITY_PAYLOAD_VERSION,
      payload: emptyRows(),
      status: "DELIVERED",
      attempts: 1,
      availableAt: old,
      lastErrorCode: null,
      deliveredAt: old,
    });
    store.rows.set("stale-parked", {
      id: "stale-parked",
      turnId: "t-2",
      organizationId: "org-1",
      payloadVersion: OBSERVABILITY_PAYLOAD_VERSION,
      payload: emptyRows(),
      status: "FAILED",
      attempts: 10,
      availableAt: old,
      lastErrorCode: "gone",
      deliveredAt: null,
    });

    const summary = await svc.drain();
    expect(summary.pruned).toBe(1);
    expect(store.rows.has("stale-delivered")).toBe(false);
    // An undelivered projection ageing out is the silent loss the outbox
    // replaced; a parked row stays until a human deals with it.
    expect(store.rows.has("stale-parked")).toBe(true);
  });
});

describe("status", () => {
  test("reports sink health alongside queue depth", async () => {
    const store = new OutboxStore();
    const svc = service(store, new RecordingSink());
    await svc.enqueueTurn(store.asTransaction(), projection());
    const status = await svc.status();
    expect(status.sink.status).toBe("ready");
    expect(status.queue).toEqual({ pending: 1, failed: 0 });
  });

  test("reports an unreadable queue as unknown, not as empty", async () => {
    // Zero would read as "nothing queued", which is the opposite of what an
    // unreadable queue means.
    const store = new OutboxStore();
    store.observabilityOutbox.count = async () => {
      throw new Error("connection terminated");
    };
    const svc = service(store, new RecordingSink());
    const status = await svc.status();
    expect(status.queue).toEqual({ pending: -1, failed: -1 });
    expect(status.queueError).toBe("Error");
  });
});

describe("startup check", () => {
  test("boots without complaint when nothing is configured", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.health_ = { configured: false, available: false, status: "disabled", detail: "none set" };
    const svc = new ObservabilityService(store.asPrisma(), sink, () =>
      resolveObservabilityConfig({}));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  test("boots — loudly — when a configured sink is missing its schema", async () => {
    // The product must run with no analytical store. A missing schema is said
    // out loud and does not refuse traffic.
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.health_ = {
      configured: true,
      available: false,
      status: "schema_missing",
      detail: "missing 4 of 4 tables",
    };
    const svc = service(store, sink);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  test("refuses to boot when the operator asked for fail-closed", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.health_ = {
      configured: true,
      available: false,
      status: "schema_missing",
      detail: "missing 4 of 4 tables",
    };
    const svc = service(store, sink, { requireSink: true });
    await expect(svc.onApplicationBootstrap()).rejects.toThrow(/schema_missing/);
  });

  test("survives a health probe that throws, and treats it as unreachable", async () => {
    const store = new OutboxStore();
    const sink = new RecordingSink();
    sink.health = async () => {
      throw new Error("boom");
    };
    const svc = service(store, sink);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
