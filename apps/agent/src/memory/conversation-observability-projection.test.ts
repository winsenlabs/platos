/**
 * The wiring assertion: a Turn's projection is queued by the same transaction
 * that committed the Turn, and nothing about the projection can cost a turn.
 *
 * This exercises the real ConversationService against a transaction double that
 * records the order calls arrive in — the point under test is placement, and
 * placement is only observable from the call site.
 *
 * THE DOUBLE MODELS POSTGRES ABORT SEMANTICS, AND IT HAS TO.
 *
 * The previous version let every other method keep succeeding after the outbox
 * upsert threw, so "the Turn survives a failed enqueue" passed vacuously — the
 * real transaction had already been poisoned by that error and the COMMIT that
 * followed was converted into a rollback, discarding the Turn, its Step and its
 * Tool Calls. `TransactionDouble` below implements the three rules that make
 * the difference observable: a failed statement aborts the transaction, every
 * statement after it fails, and COMMIT on an aborted transaction rolls back
 * instead. `ROLLBACK TO SAVEPOINT` is the one thing that clears the abort.
 */

import { describe, expect, it, vi } from "vitest";
import { ModelRateSource } from "@platos/tenancy-database";
import { ConversationService } from "./conversation.service";
import { ObservabilityService } from "../observability/observability.service";
import { resolveObservabilityConfig } from "../observability/observability-config";
import type { ObservabilitySink, ObservabilitySinkHealth } from "../observability/observability-sink";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  userId: "external-user",
  agentId: "agent",
} as any;

const observedAt = new Date("2026-08-15T00:00:00.000Z");
const rate = (usdPerToken: number) => ({
  usdPerToken,
  source: ModelRateSource.LITELLM,
  observedAt,
  sourceRef: "https://example.test/prices",
});
const pricing = {
  modelPriceId: "price-1",
  modelId: "model-1",
  modelKey: "anthropic:test",
  provider: "anthropic",
  modelName: "anthropic:test",
  effectiveFrom: observedAt,
  input: rate(0.000003),
  output: rate(0.000015),
  cacheRead: rate(0.0000003),
  cacheWrite: rate(0.00000375),
};

const idleSink: ObservabilitySink = {
  writeTurn: async () => {},
  writeStep: async () => {},
  writeToolCall: async () => {},
  writeUsage: async () => {},
  writeRows: async () => {},
  health: async (): Promise<ObservabilitySinkHealth> => ({
    configured: true,
    available: true,
    status: "ready",
    detail: "ready",
  }),
};

/**
 * A Postgres transaction's failure rules, as far as this test needs them.
 *
 * `aborted` is what a real backend enters when a statement errors: everything
 * after it fails with 25P02, and the COMMIT is downgraded to a ROLLBACK. Only
 * `ROLLBACK TO SAVEPOINT` clears it.
 */
class TransactionDouble {
  aborted = false;
  committed = false;
  readonly savepoints: string[] = [];

  /** Every statement in the transaction goes through here first. */
  statement<T>(run: () => T): T {
    if (this.aborted) {
      throw new Error("current transaction is aborted, commands ignored until end of transaction");
    }
    try {
      return run();
    } catch (err) {
      this.aborted = true;
      throw err;
    }
  }

  /** COMMIT. On an aborted transaction Postgres rolls back instead. */
  commit(): boolean {
    this.committed = !this.aborted;
    return this.committed;
  }

  async executeRawUnsafe(sql: string): Promise<number> {
    const savepoint = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) (\w+)$/.exec(sql);
    if (!savepoint) return this.statement(() => 0);
    const [, verb, name] = savepoint;
    if (verb === "ROLLBACK TO SAVEPOINT") {
      if (!this.savepoints.includes(name)) throw new Error(`no such savepoint: ${name}`);
      this.aborted = false;
      return 0;
    }
    // SAVEPOINT and RELEASE are ordinary statements: they fail on an aborted
    // transaction like everything else.
    return this.statement(() => {
      if (verb === "SAVEPOINT") this.savepoints.push(name);
      else this.savepoints.splice(this.savepoints.indexOf(name), 1);
      return 0;
    });
  }
}

function makeHarness(options: { configured?: boolean } = {}) {
  const calls: string[] = [];
  const postgres = new TransactionDouble();
  const openTurn = {
    id: "turn-1",
    threadId: "thread-1",
    agentVersionId: "version-1",
    status: "ACTIVE",
    externalRuntimeId: "run_abc",
    startedAt: new Date("2026-08-15T00:00:00.000Z"),
    inputTokens: null,
    outputTokens: null,
  };
  const upserts: any[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => postgres.statement(() => [{ id: "thread-1" }])),
    $executeRawUnsafe: vi.fn((sql: string) => postgres.executeRawUnsafe(sql)),
    turn: {
      findFirst: vi.fn(async () => postgres.statement(() => openTurn)),
      update: vi.fn(async ({ data }: any) =>
        postgres.statement(() => {
          calls.push("turn.update");
          return { ...openTurn, ...data };
        })),
    },
    step: {
      // Distinct ids, like the database's default: the projection derives one
      // usage-event id per Step id, and a double that reused an id would hide
      // a collision the real table cannot produce.
      create: vi.fn(async ({ data }: any) =>
        postgres.statement(() => {
          calls.push("step.create");
          return { id: `step-${data.sequence}`, ...data };
        })),
      upsert: vi.fn(async ({ create }: any) =>
        postgres.statement(() => {
          calls.push("step.upsert");
          return {
            id: "step-1",
            costCents: null,
            inputRate: null,
            outputRate: null,
            cacheReadRate: null,
            cacheWriteRate: null,
            modelPriceId: null,
            inputRateSource: null,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
            ...create,
          };
        })),
    },
    observabilityOutbox: {
      upsert: vi.fn(async (args: any) =>
        postgres.statement(() => {
          calls.push("observabilityOutbox.upsert");
          upserts.push(args);
          return { id: "outbox-1" };
        })),
    },
  };
  const prisma = {
    agentVersion: { findFirst: vi.fn(async () => ({ id: "version-1" })) },
    turn: { findFirst: vi.fn(async () => null) },
    observabilityOutbox: { upsert: tx.observabilityOutbox.upsert },
    // The callback's return value is only the caller's if COMMIT succeeds.
    $transaction: vi.fn(async (callback: any) => {
      const result = await callback(tx);
      if (!postgres.commit()) throw new Error("transaction rolled back at COMMIT");
      return result;
    }),
  };
  const observability = new ObservabilityService(prisma as any, idleSink, () =>
    resolveObservabilityConfig(
      options.configured === false
        ? {}
        : { PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "http://clickhouse:8123" },
    ));
  const service = new ConversationService(prisma as any, observability);
  (service as any).findScopedThread = vi.fn(async () => ({
    id: "thread-1",
    agentId: "agent",
    endUserId: "enduser-1",
    environmentId: "environment",
  }));
  return { service, tx, calls, upserts, postgres };
}

function assistantTurn() {
  return {
    role: "assistant" as const,
    turnId: "turn-1",
    content: "done",
    model: "anthropic:test",
    usage: {
      inputTokens: 40_000,
      outputTokens: 500,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 39_795,
      reasoningTokens: 20,
    },
    costCents: 1.25,
    pricing,
    latencyMs: 321,
    toolCalls: [
      { type: "call", name: "lookup", params: { id: 1 } },
      { type: "result", name: "lookup", result: "found" },
    ],
  };
}

describe("turn projection is queued with the Turn", () => {
  it("upserts the outbox row inside the same transaction, after the Turn and Step", async () => {
    // Either both commit or neither does. That is the entire guarantee.
    const { service, calls } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(calls).toEqual(["turn.update", "step.create", "observabilityOutbox.upsert"]);
  });

  it("keys the row on the Turn so a replayed finalize cannot duplicate it", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(upserts[0].where).toEqual({ turnId: "turn-1" });
    expect(upserts[0].create).toMatchObject({ turnId: "turn-1", organizationId: "org" });
  });

  it("projects the Turn, its Step, its Tool Call and its usage event", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    const payload = upserts[0].create.payload;
    expect(payload.turns_v1).toHaveLength(1);
    expect(payload.steps_v1).toHaveLength(1);
    expect(payload.tool_calls_v1).toHaveLength(1);
    expect(payload.usage_events_v1).toHaveLength(1);
    expect(payload.tool_calls_v1[0]).toMatchObject({ tool_name: "lookup", status: "completed" });
  });

  it("carries the cache lanes through unaltered and does not add them back to input", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    const turnRow = upserts[0].create.payload.turns_v1[0];
    expect(turnRow.total_input_tokens).toBe(40_000);
    expect(turnRow.cache_read_input_tokens).toBe(39_795);
    const stepRow = upserts[0].create.payload.steps_v1[0];
    expect(stepRow.fresh_input_tokens).toBe(105);
    expect(stepRow.calculated_cost_usd).toBe("0.012500000000");
  });

  it("freezes the rates the Step was priced with", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(upserts[0].create.payload.steps_v1[0]).toMatchObject({
      pricing_version: "price-1",
      fresh_input_usd_per_million: "3.000000000000",
      cache_read_usd_per_million: "0.300000000000",
    });
  });

  it("carries no prompt, tool argument or tool result anywhere in the payload", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    const serialized = JSON.stringify(upserts[0].create.payload);
    expect(serialized).not.toContain("done");
    expect(serialized).not.toContain("found");
  });

  it("records the durable-run id as a cross-reference only", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(upserts[0].create.payload.turns_v1[0]).toMatchObject({
      runtime_provider: "trigger",
      runtime_run_id: "run_abc",
    });
  });

  it("takes plaintext identity from the signed bag and from nowhere else", async () => {
    // By the time a turn finalizes, `scope.sessionContext` has been merged with
    // the Thread row AND with a base layer AgentService.stream reads out of the
    // Postgres `User` table so {{user.name}} always resolves. On the operator
    // path scope.userId IS a Platos User.id, so a projection sourced from that
    // bag stamped the OPERATOR'S real name and email onto every dashboard turn.
    const operatorBag = {
      ...scope,
      sessionContext: { user: { name: "Tejas", email: "operator@platos.test" } },
    };
    const merged = makeHarness();
    await merged.service.storeMessage("thread-1", operatorBag, assistantTurn());
    expect(merged.upserts[0].create.payload.turns_v1[0]).toMatchObject({
      user_display_name: null,
      user_email: null,
    });

    const signed = makeHarness();
    await signed.service.storeMessage(
      "thread-1",
      { ...operatorBag, signedUserMeta: { name: "Ada", email: "ada@example.test" } },
      assistantTurn(),
    );
    expect(signed.upserts[0].create.payload.turns_v1[0]).toMatchObject({
      user_display_name: "Ada",
      user_email: "ada@example.test",
    });
  });

  it("queues nothing at all when no sink is configured", async () => {
    const { service, tx, calls } = makeHarness({ configured: false });
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(calls).toEqual(["turn.update", "step.create"]);
    expect(tx.observabilityOutbox.upsert).not.toHaveBeenCalled();
  });

  it("completes the Turn even when queueing the projection throws", async () => {
    // Nothing about analytics may cost a turn. A JavaScript catch alone does
    // NOT achieve this: the failed upsert has already aborted the enclosing
    // Postgres transaction, so the COMMIT that follows is converted into a
    // rollback and the Turn, its Step and its Tool Calls are discarded — while
    // storeMessage returns a StoredMessage built from the in-memory objects and
    // the log line says the Turn was committed. Only the savepoint makes the
    // catch mean what it says.
    const { service, tx, postgres } = makeHarness();
    tx.observabilityOutbox.upsert = vi.fn(async () => {
      throw new Error("deadlock detected");
    });
    const stored = await service.storeMessage("thread-1", scope, assistantTurn());
    expect(stored.turnId).toBe("turn-1");
    expect(tx.turn.update).toHaveBeenCalled();
    // The assertion the old harness could not make: the transaction actually
    // committed, rather than being rolled back under a returned value.
    expect(postgres.aborted).toBe(false);
    expect(postgres.committed).toBe(true);
  });

  it("rolls the failed enqueue back to a savepoint rather than poisoning the transaction", async () => {
    const { service, tx, postgres } = makeHarness();
    tx.observabilityOutbox.upsert = vi.fn(async () => {
      throw new Error("deadlock detected");
    });
    await service.storeMessage("thread-1", scope, assistantTurn());
    const sql = tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement);
    expect(sql).toEqual([
      "SAVEPOINT platos_observability_projection",
      "ROLLBACK TO SAVEPOINT platos_observability_projection",
    ]);
    // Rolling back to a savepoint does not destroy it — it survives to the end
    // of the transaction, which is exactly as long as anything here needs it.
    expect(postgres.savepoints).toEqual(["platos_observability_projection"]);
  });

  it("releases the savepoint when the enqueue succeeds", async () => {
    const { service, tx, postgres } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).toEqual([
      "SAVEPOINT platos_observability_projection",
      "RELEASE SAVEPOINT platos_observability_projection",
    ]);
    expect(postgres.committed).toBe(true);
  });

  it("completes the Turn even when building the projection throws", async () => {
    // buildTurnProjection resolves the erasure salt, which throws in production
    // when unset. That throw must not land outside the guard.
    const { service, tx } = makeHarness();
    const brokenScope = { ...scope };
    Object.defineProperty(brokenScope, "signedUserMeta", {
      get() {
        throw new Error("signed identity unavailable");
      },
    });
    const stored = await service.storeMessage("thread-1", brokenScope, assistantTurn());
    expect(stored.turnId).toBe("turn-1");
    expect(tx.observabilityOutbox.upsert).not.toHaveBeenCalled();
  });
});

describe("further model calls reach the durable ledger", () => {
  /** One sub-agent delegation, priced at its own (cheaper) model. */
  function delegation() {
    return {
      model: "anthropic:haiku",
      provider: "anthropic",
      startedAt: new Date("2026-08-15T00:00:01.000Z"),
      completedAt: new Date("2026-08-15T00:00:02.000Z"),
      inputTokens: 900,
      outputTokens: 120,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
      costCents: 0.31,
      pricing,
    };
  }

  it("writes a Step per delegation, numbered after the primary one", async () => {
    // Sub-agent spend used to be fanned out to Redis and persisted nowhere:
    // the only Step writer is this method, one Step per assistant turn. So a
    // day Redis still held returned MORE money than the same day rebuilt from
    // the Step rows — the same function, two answers.
    const { service, tx } = makeHarness();
    await service.storeMessage("thread-1", scope, {
      ...assistantTurn(),
      additionalSteps: [delegation(), delegation()],
    });
    const sequences = tx.step.create.mock.calls.map(([args]) => args.data.sequence);
    expect(sequences).toEqual([1, 2, 3]);
    const [, second] = tx.step.create.mock.calls;
    expect(second[0].data).toMatchObject({
      model: "anthropic:haiku",
      inputTokens: 900,
      outputTokens: 120,
      costCents: 0.31,
    });
  });

  it("prices the Turn at what the whole unit of work cost", async () => {
    // `Turn.costCents` is what the canary panel reads. It carried the parent
    // model call only, so it reported less than the per-agent card on the
    // monitoring page for the same agent.
    const { service, tx } = makeHarness();
    await service.storeMessage("thread-1", scope, {
      ...assistantTurn(),
      additionalSteps: [delegation(), delegation()],
    });
    expect(tx.turn.update.mock.calls[0][0].data.costCents).toBeCloseTo(1.25 + 0.62, 6);
    // The primary Step keeps its own cost: summing the Steps and reading the
    // Turn must give the same number, or the two disagree again.
    expect(tx.step.create.mock.calls[0][0].data.costCents).toBe(1.25);
  });

  it("projects each delegation with its own model and its own frozen rates", async () => {
    const { service, upserts } = makeHarness();
    await service.storeMessage("thread-1", scope, {
      ...assistantTurn(),
      additionalSteps: [delegation()],
    });
    const payload = upserts[0].create.payload;
    expect(payload.steps_v1).toHaveLength(2);
    expect(payload.steps_v1[1]).toMatchObject({ model: "anthropic:haiku", sequence: 2 });
    // One usage event per Step, so the analytical per-model breakdown sees the
    // sub-agent's spend rather than folding it into the parent's model.
    expect(payload.usage_events_v1).toHaveLength(2);
    expect(payload.turns_v1[0].step_count).toBe(2);
  });

  it("leaves a turn with no delegations exactly as it was", async () => {
    const { service, tx } = makeHarness();
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(tx.step.create).toHaveBeenCalledTimes(1);
    expect(tx.turn.update.mock.calls[0][0].data.costCents).toBe(1.25);
  });
});

describe("failed turns are projected too", () => {
  it("queues a failed projection so cost stays visible and the turn is not billable", async () => {
    const { service, upserts, calls } = makeHarness();
    await service.failTurn("thread-1", "turn-1", scope, new Error("provider timed out"));
    expect(calls).toEqual(["turn.update", "step.upsert", "observabilityOutbox.upsert"]);
    const turnRow = upserts[0].create.payload.turns_v1[0];
    expect(turnRow.status).toBe("failed");
    expect(turnRow.error_class).toBe("Error");
  });

  it("keeps the provider's error message out of the projection", async () => {
    // A provider error body can quote the prompt that produced it.
    const { service, upserts } = makeHarness();
    await service.failTurn("thread-1", "turn-1", scope, new Error("prompt rejected: SECRET"));
    expect(JSON.stringify(upserts[0].create.payload)).not.toContain("SECRET");
  });
});
