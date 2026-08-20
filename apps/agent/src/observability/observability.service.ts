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
  CANONICAL_ALIAS_CHANNEL,
  aliasKeyHash,
  erasedAliasHashes,
  erasureHashSalt,
  normalizeAlias,
} from "../privacy/erasure-register";
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

/**
 * Savepoint name for the best-effort enqueue. A fixed identifier, never
 * interpolated from anything: it is spliced into SQL text, and the only safe
 * value to splice is a constant.
 */
const PROJECTION_SAVEPOINT = "platos_observability_projection";

/**
 * Wall clock a single drain may spend delivering.
 *
 * Under the HTTP client's 60s timeout, so the caller gets a summary rather than
 * an aborted request — a pass that stops early leaves its remaining rows PENDING
 * and reports the depth, which is a state; a timed-out request is not.
 */
const DRAIN_DEADLINE_MS = 45_000;

/** Placeholder for `status({ sink: false })`, where the probe was deliberately skipped. */
const SINK_NOT_PROBED: ObservabilitySinkHealth = {
  configured: true,
  available: true,
  status: "ready",
  detail: "health not probed for this report",
};

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
   *
   * A JAVASCRIPT `catch` IS NOT ENOUGH, AND THAT IS WHY THE SAVEPOINT IS HERE.
   *
   * This runs inside the caller's interactive transaction. A Prisma error
   * raised by the upsert has ALREADY aborted the enclosing Postgres
   * transaction: every subsequent statement fails with "current transaction is
   * aborted", and the COMMIT the engine then issues is converted by Postgres
   * into a rollback. Catching the rejection in JS does not undo any of that,
   * and Prisma wraps no savepoint around individual interactive-transaction
   * queries. So the previous version discarded the Turn, its Step and its Tool
   * Calls while `storeMessage` returned a StoredMessage built from the
   * in-memory objects — and logged a line saying the exact opposite.
   *
   * `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` is the one thing that makes the catch
   * mean what it says: the failed upsert is undone, the enclosing transaction is
   * back in a good state, and the work it was describing still commits.
   */
  async enqueueTurnBestEffort(
    tx: ObservabilityTransaction,
    projection: TurnProjection,
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      await tx.$executeRawUnsafe(`SAVEPOINT ${PROJECTION_SAVEPOINT}`);
    } catch (err) {
      // No savepoint means no way to fail safely, so do not attempt the write
      // at all: a lost projection is recoverable from Postgres, a lost Turn is
      // not.
      this.logger.error(
        `[observability] could not open a savepoint for turn ${projection.turn.turnId}` +
          ` (${errorClass(err)}); the projection is skipped and the Turn is unaffected`,
      );
      return false;
    }
    try {
      const queued = await this.enqueueTurn(tx, projection);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${PROJECTION_SAVEPOINT}`);
      return queued;
    } catch (err) {
      this.logger.error(
        `[observability] failed to queue projection for turn ${projection.turn.turnId}` +
          ` (${errorClass(err)}); the Turn is committed and its projection is lost`,
      );
      // If this throws too, the transaction is unrecoverable by any means
      // available here and the caller SHOULD see it — a silent success on a
      // transaction Postgres is about to roll back is the worse outcome.
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${PROJECTION_SAVEPOINT}`);
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
   *
   * A LOOP, BECAUSE A SINGLE READ IS A THROUGHPUT CEILING.
   *
   * One `findMany` of `drainBatchSize` per scheduled run caps steady-state
   * delivery at that many projections per run regardless of turn volume. At the
   * old hourly cron and a 500-row read, a deployment completing more than about
   * eight turns a minute accumulated a PENDING backlog it could never work off
   * even with a perfectly healthy ClickHouse — and `prune` only deletes
   * DELIVERED rows, so the table grew without bound while nothing reported the
   * depth. The pass now keeps reading until the queue is empty, the row budget
   * is spent or the wall clock runs out, and it reports the depth either way.
   */
  async drain(limit?: number): Promise<DrainSummary> {
    const config = this.readConfig();
    if (!config.configured) {
      return this.withQueueDepth(emptyDrainSummary("no observability sink configured"));
    }
    const health = await this.sink.health().catch(() => null);
    if (!health?.available) {
      // Nothing is claimed and nothing is lost; the rows stay PENDING.
      const detail = health?.detail ?? "health probe threw";
      this.logger.warn(`[observability] drain skipped: sink is not available (${detail})`);
      return this.withQueueDepth(emptyDrainSummary(`sink unavailable: ${health?.status ?? "unknown"}`));
    }

    const now = new Date();
    const summary = emptyDrainSummary();
    const budget = Math.max(1, Math.min(config.drainMaxRows, limit ?? config.drainMaxRows));
    const deadline = Date.now() + DRAIN_DEADLINE_MS;

    while (summary.claimed < budget) {
      const take = Math.min(config.drainBatchSize, budget - summary.claimed);
      const claimed = await this.claim(take, now);
      if (claimed.length === 0) break;
      summary.claimed += claimed.length;
      summary.passes++;
      await this.deliverBatch(claimed, config, summary);
      // A short read means the queue is empty; anything else means keep going
      // until one of the two budgets stops us.
      if (claimed.length < take) break;
      if (Date.now() >= deadline) {
        summary.skipped = `drain deadline reached after ${summary.claimed} rows`;
        break;
      }
    }
    if (summary.claimed >= budget && !summary.skipped) {
      summary.skipped = `drain row budget (${budget}) reached`;
    }

    summary.pruned = await this.prune(now);
    return this.withQueueDepth(summary);
  }

  /** One page of due rows, oldest first. */
  private async claim(take: number, now: Date): Promise<OutboxRow[]> {
    const pending = await this.prisma.observabilityOutbox.findMany({
      where: { status: "PENDING", availableAt: { lte: now } },
      orderBy: { availableAt: "asc" },
      take,
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
    return pending.map((row) => ({
      ...row,
      status: row.status as OutboxStatus,
      payload: row.payload as unknown,
    }));
  }

  private async deliverBatch(
    claimed: OutboxRow[],
    config: ObservabilityConfig,
    summary: DrainSummary,
  ): Promise<void> {
    const decoded = claimed.map((row) => ({
      row,
      rows: isDeliverableVersion(row) ? decodeRows(row.payload) : null,
    }));
    const erased = await this.erasedRowIds(decoded);
    if (erased.size > 0) {
      // Destroyed rather than delivered, and destroyed rather than parked: the
      // subject's identity was legally erased, and this row would put it back.
      const ids = [...erased];
      const { count } = await this.prisma.observabilityOutbox.deleteMany({
        where: { id: { in: ids } },
      });
      summary.discarded += count;
      this.logger.warn(
        `[observability] discarded ${count} queued projection(s) for erased subjects;` +
          " an undelivered projection must never re-insert an erased identity",
      );
    }

    for (const { row, rows } of decoded) {
      if (erased.has(row.id)) continue;
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
  }

  /**
   * Rows in this batch whose subject the organization has erased.
   *
   * THE OUTBOX IS A WRITER THE ERASURE SWEEP DOES NOT WAIT FOR. The FK from
   * `ObservabilityOutbox.turnId` to `Turn` cascades, but the cascade only fires
   * when the POSTGRES executor runs — and the execution order is minio, redis,
   * clickhouse, postgres. ClickHouse is mutated, polled to `is_done` and
   * negatively verified BEFORE Postgres deletes the Turns these rows hang off,
   * so a drain landing in that window re-inserts `end_user_id`,
   * `user_display_name` and `user_email` for the subject whose receipt already
   * says "clickhouse: done, verification passed". It is not only a race: when
   * the Postgres transaction fails, the cascade never runs at all and retry
   * re-runs Postgres only, never re-sweeping ClickHouse.
   *
   * FAIL CLOSED, like every other consultation of this register: a lookup that
   * cannot run refuses the whole pass rather than delivering blind. Rows stay
   * PENDING, which costs a delay; the alternative costs an erasure.
   */
  private async erasedRowIds(
    decoded: Array<{ row: OutboxRow; rows: ObservabilityRows | null }>,
  ): Promise<Set<string>> {
    // Which rows address which subject, keyed by the same canonical alias the
    // sweep seals: (platos:end-user, <EndUser uuid>).
    const addressed = decoded.flatMap(({ row, rows }) => {
      const endUserId = rows?.turns_v1[0]?.end_user_id;
      const alias =
        typeof endUserId === "string"
          ? normalizeAlias({ channel: CANONICAL_ALIAS_CHANNEL, subject: endUserId })
          : null;
      return alias ? [{ rowId: row.id, organizationId: row.organizationId, alias }] : [];
    });
    // Resolved only when there is something to ask about: the salt is mandatory
    // in production and throwing here on a batch with no subjects would fail a
    // pass that had nothing to check.
    if (addressed.length === 0) return new Set();
    const salt = erasureHashSalt();

    // Grouped by organization, because the register is organization-scoped and
    // one drain pass spans every tenant with queued work.
    const rowsByOrgHash = new Map<string, string[]>();
    const aliasesByOrg = new Map<string, typeof addressed[number]["alias"][]>();
    for (const { rowId, organizationId, alias } of addressed) {
      const hash = aliasKeyHash(alias, organizationId, salt);
      const key = `${organizationId} ${hash}`;
      rowsByOrgHash.set(key, [...(rowsByOrgHash.get(key) ?? []), rowId]);
      aliasesByOrg.set(organizationId, [...(aliasesByOrg.get(organizationId) ?? []), alias]);
    }

    const erased = new Set<string>();
    for (const [organizationId, aliases] of aliasesByOrg) {
      const hits = await erasedAliasHashes(this.prisma, { organizationId, aliases, salt });
      for (const hash of hits) {
        for (const rowId of rowsByOrgHash.get(`${organizationId} ${hash}`) ?? []) {
          erased.add(rowId);
        }
      }
    }
    return erased;
  }

  /**
   * Attach the queue depth to a summary.
   *
   * Every pass, including the ones that did nothing: a parked row is a number
   * someone has to explain, and it was previously announced exactly once — by
   * the pass that parked it — after which every later pass reported zero
   * because the claim query filters on PENDING.
   */
  private async withQueueDepth(summary: DrainSummary): Promise<DrainSummary> {
    const status = await this.status({ sink: false });
    if (!status.queueError) summary.queue = status.queue;
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

  /**
   * Sink health plus queue depth, for the monitoring surface.
   *
   * `options.sink: false` skips the health probe — the drain has already made
   * one and does not need a second network round trip to report its depth.
   */
  async status(options: { sink?: boolean } = {}): Promise<ObservabilityStatusReport> {
    const sink =
      options.sink === false
        ? SINK_NOT_PROBED
        : await this.sink.health().catch(
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
