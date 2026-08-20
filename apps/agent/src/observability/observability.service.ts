/**
 * The runtime's entry point to the observability projection.
 *
 * WHERE THE OUTBOX ROW IS WRITTEN, AND WHY THERE
 *
 * `enqueueTurn` takes the CALLER'S transaction. It is invoked from
 * ConversationService.storeMessage, inside the same `$transaction` that updates
 * the Turn and creates its Step and ToolCall rows. That placement is the whole
 * guarantee: the projection commits with the work it describes, or neither
 * commits. Attaching it to the span path instead would put it behind
 * `PLATOS_OTEL_SAMPLE_RATE`, and a sampled projection reconciled against an
 * unsampled ledger never agrees.
 *
 * WHY NOTHING IS ENQUEUED WHEN NO SINK IS CONFIGURED
 *
 * Postgres already holds every fact the projection contains. Queueing for a
 * store that does not exist would accumulate rows forever in exchange for
 * nothing — the same rows can be rebuilt from Turn/Step/ToolCall the day a
 * store is provisioned. So "no sink" means no queue, not an unbounded one. This
 * is the one case where not writing is honest rather than lossy, and it is why
 * the disabled path costs a boolean instead of a table.
 */

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Prisma } from "@platos/tenancy-database";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import {
  ClickhouseObservabilitySink,
  errorClass,
  healthLogLevel,
} from "./clickhouse-observability-sink";
import {
  OBSERVABILITY_TABLES,
  resolveObservabilityConfig,
  type ObservabilityConfig,
} from "./observability-config";
import {
  decodeRows,
  projectTurn,
  rowCount,
  type ObservabilityRows,
  type TurnProjection,
} from "./observability-event";
import {
  DELIVERED_RETENTION_DAYS,
  OBSERVABILITY_PAYLOAD_VERSION,
  deliveryFailed,
  deliverySucceeded,
  deliveryUndeliverable,
  emptyDrainSummary,
  isDeliverableVersion,
  type DeliveryOutcome,
  type DrainSummary,
  type OutboxRow,
  type OutboxStatus,
} from "./observability-outbox";
import type { ObservabilitySink, ObservabilitySinkHealth } from "./observability-sink";

/** A Prisma transaction client, so enqueue can join a caller's transaction. */
export type ObservabilityTransaction = Prisma.TransactionClient;

/** Nest token for the sink, so a test can supply one without a ClickHouse. */
export const OBSERVABILITY_SINK_TOKEN = "OBSERVABILITY_SINK";

export interface ObservabilityStatusReport {
  sink: ObservabilitySinkHealth;
  queue: { pending: number; failed: number };
  /** Set when the queue could not be read; the counts above are then unknown. */
  queueError?: string;
}

@Injectable()
export class ObservabilityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ObservabilityService.name);

  private readonly sink: ObservabilitySink;
  private readonly readConfig: () => ObservabilityConfig;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Optional() @Inject(OBSERVABILITY_SINK_TOKEN) sink?: ObservabilitySink,
    // Resolved per call, never captured, so rotating a credential does not
    // require a restart.
    @Optional() readConfig?: () => ObservabilityConfig,
  ) {
    this.sink = sink ?? new ClickhouseObservabilitySink();
    this.readConfig = readConfig ?? (() => resolveObservabilityConfig());
  }

  /**
   * The check whose absence is the reason this milestone exists.
   *
   * It never throws by default: the product must boot and complete turns with
   * no analytical store at all, and a store being missing is not a reason to
   * refuse traffic. It DOES say so at error level, every boot, naming the file
   * that fixes it — because the previous failure mode was not that the pipeline
   * broke, it was that nothing said so.
   *
   * `PLATOS_OBSERVABILITY_REQUIRE_SINK=true` converts it to a boot failure for
   * a deployment that has decided losing analytics is not acceptable.
   */
  async onApplicationBootstrap(): Promise<void> {
    const health = await this.sink.health().catch(
      (err): ObservabilitySinkHealth => ({
        configured: true,
        available: false,
        status: "unreachable",
        detail: `observability health probe threw (${errorClass(err)})`,
      }),
    );
    const message = `[observability] sink=${health.status} ${health.detail}`;
    this.logger[healthLogLevel(health.status)](message);

    if (health.available) return;
    if (this.readConfig().requireSink) {
      // Fail-closed, opt-in. The error carries the status word so the crash
      // says which of the four not-working states this is.
      throw new Error(`observability sink required but ${health.status}: ${health.detail}`);
    }
    if (health.configured) {
      this.logger.warn(
        "[observability] turns will complete and projections will queue in ObservabilityOutbox" +
          " until the sink recovers; no write is discarded",
      );
    }
  }

  /** Whether a projection should be queued at all. */
  isEnabled(): boolean {
    return this.readConfig().configured;
  }

  /**
   * Queue one committed Turn's projection, inside the caller's transaction.
   *
   * Upsert rather than create: a Turn finalizes once, but a retried finalize —
   * a durable run replayed, an idempotent re-delivery — must leave one row, not
   * a unique-constraint violation that rolls back the Turn it was describing.
   * The projection must never be the reason a turn fails.
   */
  async enqueueTurn(
    tx: ObservabilityTransaction,
    projection: TurnProjection,
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const rows = projectTurn(projection);
    const payload = rows as unknown as Prisma.InputJsonValue;
    await tx.observabilityOutbox.upsert({
      where: { turnId: projection.turn.turnId },
      create: {
        turnId: projection.turn.turnId,
        organizationId: projection.turn.scope.organizationId,
        payloadVersion: OBSERVABILITY_PAYLOAD_VERSION,
        payload,
      },
      update: {
        organizationId: projection.turn.scope.organizationId,
        payloadVersion: OBSERVABILITY_PAYLOAD_VERSION,
        payload,
        // Re-arm a row that had been parked: the payload is new, so the reason
        // the old one failed may no longer apply.
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(),
        lastErrorCode: null,
        deliveredAt: null,
      },
    });
    return true;
  }

  /**
   * Enqueue without failing the caller.
   *
   * ConversationService uses this: a projection that cannot be queued must not
   * roll back a Turn that already happened. The failure is logged at error
   * level rather than swallowed, because a persistently failing enqueue is
   * silent telemetry loss and that is the thing being fixed here.
   */
  async enqueueTurnBestEffort(
    tx: ObservabilityTransaction,
    projection: TurnProjection,
  ): Promise<boolean> {
    try {
      return await this.enqueueTurn(tx, projection);
    } catch (err) {
      this.logger.error(
        `[observability] failed to queue projection for turn ${projection.turn.turnId}` +
          ` (${errorClass(err)}); the Turn is committed and its projection is lost`,
      );
      return false;
    }
  }

  /**
   * Deliver queued projections. Driven by the observability DLQ drain task.
   *
   * Claims rows by id and updates each one individually rather than holding a
   * lease: the queue is one row per Turn and a redelivered row is collapsed by
   * ReplacingMergeTree, so the cost of two drainers overlapping is a duplicate
   * insert that dedupes — not a double charge.
   */
  async drain(limit?: number): Promise<DrainSummary> {
    const config = this.readConfig();
    if (!config.configured) {
      return emptyDrainSummary("no observability sink configured");
    }
    const health = await this.sink.health().catch(() => null);
    if (!health?.available) {
      // Nothing is claimed and nothing is lost; the rows stay PENDING.
      const detail = health?.detail ?? "health probe threw";
      this.logger.warn(`[observability] drain skipped: sink is not available (${detail})`);
      return emptyDrainSummary(`sink unavailable: ${health?.status ?? "unknown"}`);
    }

    const now = new Date();
    const pending = await this.prisma.observabilityOutbox.findMany({
      where: { status: "PENDING", availableAt: { lte: now } },
      orderBy: { availableAt: "asc" },
      take: Math.min(config.drainBatchSize, Math.max(1, limit ?? config.drainBatchSize)),
      select: {
        id: true,
        turnId: true,
        organizationId: true,
        payloadVersion: true,
        payload: true,
        status: true,
        attempts: true,
      },
    });
    const claimed: OutboxRow[] = pending.map((row) => ({
      ...row,
      status: row.status as OutboxStatus,
      payload: row.payload as unknown,
    }));

    const summary = emptyDrainSummary();
    summary.claimed = claimed.length;

    for (const row of claimed) {
      const rows = isDeliverableVersion(row) ? decodeRows(row.payload) : null;
      if (!rows) {
        const reason = isDeliverableVersion(row)
          ? "payload is not the expected row shape"
          : `payload version ${row.payloadVersion} is newer than this writer`;
        await this.settle(row, deliveryUndeliverable(row, reason));
        summary.parked++;
        this.logger.error(`[observability] parked outbox row ${row.id}: ${reason}`);
        continue;
      }
      try {
        await this.sink.writeRows(rows);
        await this.settle(row, deliverySucceeded(row, new Date()));
        summary.delivered++;
      } catch (err) {
        const outcome = deliveryFailed(row, new Date(), config.maxAttempts, errorClass(err));
        await this.settle(row, outcome);
        if (outcome.status === "FAILED") {
          summary.parked++;
          this.logger.error(
            `[observability] parked outbox row ${row.id} after ${outcome.attempts} attempts` +
              ` (${outcome.lastErrorCode}); the projection for this turn is not delivered`,
          );
        } else {
          summary.retried++;
        }
      }
    }

    summary.pruned = await this.prune(now);
    return summary;
  }

  private async settle(row: OutboxRow, outcome: DeliveryOutcome): Promise<void> {
    await this.prisma.observabilityOutbox.update({
      where: { id: row.id },
      data: {
        status: outcome.status,
        attempts: outcome.attempts,
        // A settled or parked row keeps its last availableAt rather than
        // gaining a null: the column is NOT NULL, and "when it was last due" is
        // more useful to an operator than a reset clock.
        ...(outcome.availableAt ? { availableAt: outcome.availableAt } : {}),
        deliveredAt: outcome.deliveredAt,
        lastErrorCode: outcome.lastErrorCode,
      },
    });
  }

  /**
   * Drop acknowledged rows past their retention window.
   *
   * Only DELIVERED rows. A PENDING or FAILED row is never pruned by age — an
   * undelivered projection ageing out is exactly the silent loss the outbox
   * replaced.
   */
  private async prune(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - DELIVERED_RETENTION_DAYS * 86_400_000);
    const { count } = await this.prisma.observabilityOutbox.deleteMany({
      where: { status: "DELIVERED", deliveredAt: { lt: cutoff } },
    });
    return count;
  }

  /** Sink health plus queue depth, for the monitoring surface. */
  async status(): Promise<ObservabilityStatusReport> {
    const sink = await this.sink.health().catch(
      (err): ObservabilitySinkHealth => ({
        configured: true,
        available: false,
        status: "unreachable",
        detail: `health probe threw (${errorClass(err)})`,
      }),
    );
    try {
      const [pending, failed] = await Promise.all([
        this.prisma.observabilityOutbox.count({ where: { status: "PENDING" } }),
        this.prisma.observabilityOutbox.count({ where: { status: "FAILED" } }),
      ]);
      return { sink, queue: { pending, failed } };
    } catch (err) {
      // Zero would read as "nothing queued", which is the opposite of what an
      // unreadable queue means.
      return { sink, queue: { pending: -1, failed: -1 }, queueError: errorClass(err) };
    }
  }

  /** Tables this projection owns, for diagnostics that have to name them. */
  tables(): readonly string[] {
    return OBSERVABILITY_TABLES;
  }

  /** Rows one projection would produce, without queueing it. Used by tests. */
  preview(projection: TurnProjection): { rows: ObservabilityRows; count: number } {
    const rows = projectTurn(projection);
    return { rows, count: rowCount(rows) };
  }
}
