/**
 * The wiring assertion: a Turn's projection is queued by the same transaction
 * that committed the Turn, and nothing about the projection can cost a turn.
 *
 * This exercises the real ConversationService against a transaction stub that
 * records the order calls arrive in — the point under test is placement, and
 * placement is only observable from the call site.
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

function makeHarness(options: { configured?: boolean } = {}) {
  const calls: string[] = [];
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
    $queryRaw: vi.fn(async () => [{ id: "thread-1" }]),
    turn: {
      findFirst: vi.fn(async () => openTurn),
      update: vi.fn(async ({ data }: any) => {
        calls.push("turn.update");
        return { ...openTurn, ...data };
      }),
    },
    step: {
      create: vi.fn(async ({ data }: any) => {
        calls.push("step.create");
        return { id: "step-1", ...data };
      }),
      upsert: vi.fn(async ({ create }: any) => {
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
      }),
    },
    observabilityOutbox: {
      upsert: vi.fn(async (args: any) => {
        calls.push("observabilityOutbox.upsert");
        upserts.push(args);
        return { id: "outbox-1" };
      }),
    },
  };
  const prisma = {
    agentVersion: { findFirst: vi.fn(async () => ({ id: "version-1" })) },
    turn: { findFirst: vi.fn(async () => null) },
    observabilityOutbox: { upsert: tx.observabilityOutbox.upsert },
    $transaction: vi.fn(async (callback: any) => callback(tx)),
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
  return { service, tx, calls, upserts };
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

  it("queues nothing at all when no sink is configured", async () => {
    const { service, tx, calls } = makeHarness({ configured: false });
    await service.storeMessage("thread-1", scope, assistantTurn());
    expect(calls).toEqual(["turn.update", "step.create"]);
    expect(tx.observabilityOutbox.upsert).not.toHaveBeenCalled();
  });

  it("completes the Turn even when queueing the projection throws", async () => {
    // Nothing about analytics may cost a turn.
    const { service, tx } = makeHarness();
    tx.observabilityOutbox.upsert = vi.fn(async () => {
      throw new Error("deadlock detected");
    });
    const stored = await service.storeMessage("thread-1", scope, assistantTurn());
    expect(stored.turnId).toBe("turn-1");
    expect(tx.turn.update).toHaveBeenCalled();
  });

  it("completes the Turn even when building the projection throws", async () => {
    // buildTurnProjection resolves the erasure salt, which throws in production
    // when unset. That throw must not land outside the guard.
    const { service, tx } = makeHarness();
    const brokenScope = { ...scope };
    Object.defineProperty(brokenScope, "sessionContext", {
      get() {
        throw new Error("session context unavailable");
      },
    });
    const stored = await service.storeMessage("thread-1", brokenScope, assistantTurn());
    expect(stored.turnId).toBe("turn-1");
    expect(tx.observabilityOutbox.upsert).not.toHaveBeenCalled();
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
