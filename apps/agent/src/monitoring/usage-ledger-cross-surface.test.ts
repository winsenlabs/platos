import { ModelRateSource, Prisma } from "@platos/tenancy-database";
import { beforeEach, describe, expect, it } from "vitest";
import { BudgetService } from "./budget.service";
import { CostService } from "./cost.service";
import { billableCostFromRollup, USAGE_LANES, usageFromRollup } from "./usage-ledger";

/**
 * CROSS-SURFACE EQUALITY.
 *
 * The failure this suite exists to catch is not "one surface is wrong" — every
 * surface was arithmetically defensible on its own terms, which is why nobody
 * caught it. The failure is that they DISAGREED. So each assertion here
 * compares surfaces against each other over one recorded window, not against a
 * hand-written expectation.
 *
 * Redis is faked in memory because it is a dependency of the system under test,
 * not the system itself: the CostService, BudgetService and ledger arithmetic
 * under test are the real implementations, and the fake implements the exact
 * hash semantics they rely on (hincrby is integer, hincrbyfloat is not, hgetall
 * returns strings, SET NX returns null when the key exists).
 */

class InMemoryRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  private readonly strings = new Map<string, string>();

  private hash(key: string): Map<string, string> {
    let existing = this.hashes.get(key);
    if (!existing) {
      existing = new Map<string, string>();
      this.hashes.set(key, existing);
    }
    return existing;
  }

  hincrby(key: string, field: string, amount: number): void {
    const hash = this.hash(key);
    // Redis stores integer counters as integers and rejects a float here.
    hash.set(field, String(Math.trunc(Number(hash.get(field) ?? "0")) + Math.trunc(amount)));
  }

  hincrbyfloat(key: string, field: string, amount: number): void {
    const hash = this.hash(key);
    hash.set(field, String(Number(hash.get(field) ?? "0") + amount));
  }

  hset(key: string, field: string, value: string): void {
    this.hash(key).set(field, value);
  }

  expire(): void {
    // TTL is irrelevant inside one test run; the reads never consult it.
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async del(key: string): Promise<void> {
    this.hashes.delete(key);
  }

  async set(key: string, value: string, _ex: string, _ttl: number, nx: string): Promise<"OK" | null> {
    if (nx === "NX" && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }

  async scan(cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    void cursor;
    const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
    return ["0", [...this.hashes.keys()].filter((key) => regex.test(key))];
  }

  pipeline(): InMemoryPipeline {
    return new InMemoryPipeline(this);
  }
}

function escapeRegex(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class InMemoryPipeline {
  private readonly queued: Array<() => Promise<unknown>> = [];

  constructor(private readonly redis: InMemoryRedis) {}

  hincrby(key: string, field: string, amount: number): this {
    this.queued.push(async () => this.redis.hincrby(key, field, amount));
    return this;
  }

  hincrbyfloat(key: string, field: string, amount: number): this {
    this.queued.push(async () => this.redis.hincrbyfloat(key, field, amount));
    return this;
  }

  hset(key: string, field: string, value: string): this {
    this.queued.push(async () => this.redis.hset(key, field, value));
    return this;
  }

  expire(): this {
    this.queued.push(async () => this.redis.expire());
    return this;
  }

  hgetall(key: string): this {
    this.queued.push(() => this.redis.hgetall(key));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    const out: Array<[Error | null, unknown]> = [];
    for (const op of this.queued) out.push([null, await op()]);
    return out;
  }
}

const OBSERVED_AT = new Date("2026-08-01T00:00:00.000Z");

/** A four-rate canonical card, the WIN-125 shape the ledger prices against. */
function priceRow() {
  return {
    id: "price-id",
    modelId: "model-id",
    effectiveFrom: OBSERVED_AT,
    // 200c / 1200c / 20c / 250c per million tokens.
    inputRate: new Prisma.Decimal("0.000002"),
    outputRate: new Prisma.Decimal("0.000012"),
    cacheReadRate: new Prisma.Decimal("0.0000002"),
    cacheWriteRate: new Prisma.Decimal("0.0000025"),
    inputSource: ModelRateSource.VERIFIED_PROVIDER,
    outputSource: ModelRateSource.VERIFIED_PROVIDER,
    cacheReadSource: ModelRateSource.VERIFIED_PROVIDER,
    cacheWriteSource: ModelRateSource.VERIFIED_PROVIDER,
    inputObservedAt: OBSERVED_AT,
    outputObservedAt: OBSERVED_AT,
    cacheReadObservedAt: OBSERVED_AT,
    cacheWriteObservedAt: OBSERVED_AT,
    inputSourceRef: "https://example.test/pricing",
    outputSourceRef: "https://example.test/pricing",
    cacheReadSourceRef: "https://example.test/pricing",
    cacheWriteSourceRef: "https://example.test/pricing",
    model: { key: "sonnet-test", provider: "anthropic", name: "sonnet-test" },
  };
}

const SCOPE = {
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
};
const AGENT_ID = "agent-walle";
const USER_ID = "user-1";
const THREAD_ID = "thread-1";
const MODEL = "anthropic:sonnet-test";

/** Prisma stand-in: pricing is real, the Step fallback is deliberately empty. */
function prismaStub(budgets: unknown[] = []) {
  return {
    modelPrice: { findMany: async () => [priceRow()] },
    // Every rollup read in this suite has live Redis days, so the Postgres
    // fallback must contribute nothing — otherwise a surface would be summing
    // two sources and the equality assertions would pass for the wrong reason.
    step: { findMany: async () => [] },
    agent: { findMany: async () => [{ id: AGENT_ID, name: "Walle" }] },
    budget: { findMany: async () => budgets },
  } as any;
}

/**
 * One turn: N tool calls, one completed unit of work.
 *
 * 40,000 input tokens of which 36,000 were served from cache and 2,000 written
 * to it — the shape that made the naive figure a tenth of the real one.
 */
async function recordTurn(cost: CostService, overrides: { threadId?: string } = {}) {
  return cost.recordUsage(
    SCOPE,
    overrides.threadId ?? THREAD_ID,
    AGENT_ID,
    MODEL,
    40_000,
    500,
    {
      cacheReadInputTokens: 36_000,
      cacheCreationInputTokens: 2_000,
      reasoningTokens: 120,
      userId: USER_ID,
    },
  );
}

describe("every surface reports the same window", () => {
  let redis: InMemoryRedis;
  let cost: CostService;

  beforeEach(async () => {
    redis = new InMemoryRedis();
    cost = new CostService(prismaStub(), redis as any);
    // Three turns of agent work, plus the auxiliary spend the runtime incurs
    // on their behalf. Every one of these is real spend and every surface must
    // account for all of it.
    await recordTurn(cost);
    await recordTurn(cost, { threadId: "thread-2" });
    await recordTurn(cost, { threadId: "thread-3" });
    await cost.recordAuxiliaryCost({
      scope: SCOPE,
      kind: "embedding",
      model: MODEL,
      costCents: 0.4,
      inputTokens: 2_000,
      agentId: AGENT_ID,
      userId: USER_ID,
    });
    await cost.recordAuxiliaryCost({
      scope: SCOPE,
      kind: "extraction",
      model: MODEL,
      costCents: 1.1,
      inputTokens: 5_000,
      outputTokens: 200,
      agentId: AGENT_ID,
      userId: USER_ID,
    });
    await cost.recordSkillUsage(SCOPE, {
      skillSlug: "web-search",
      toolName: "search",
      provider: "TAVILY_API_KEY",
      inputUnits: 1,
      outputUnits: 1,
      estimatedCostCents: 0.75,
      latencyMs: 400,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });
  });

  it("agrees on scope cost across the window, daily and range surfaces", async () => {
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    const daily = await cost.getScopeDailyCost(SCOPE);
    const range = await cost.getScopeCostRange(SCOPE, 7);

    expect(window.costCents).toBeCloseTo(daily.costCents, 6);
    expect(range.costCents).toBeCloseTo(window.costCents, 6);
    // The naive/with-cache pair that four surfaces summed differently is now
    // one number wearing two names.
    expect(range.costWithCacheCents).toBe(range.costCents);
  });

  it("agrees on the task count across every surface", async () => {
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    const daily = await cost.getScopeDailyCost(SCOPE);
    const byAgent = await cost.getCostByAgent(SCOPE, { days: 7 });
    const byUser = await cost.getCostByUser(SCOPE, { days: 7 });
    const byModel = await cost.getCostByModel(SCOPE, { days: 7 });
    const perAgent = await cost.getAgentDailyCost(SCOPE, AGENT_ID);
    const perUser = await cost.getUserDailyCost(SCOPE, USER_ID);

    // Three turns. Six model calls plus a skill dispatch happened alongside
    // them; none of those is a task.
    expect(window.tasks).toBe(3);
    for (const surface of [
      daily.tasks,
      byAgent[0]!.tasks,
      byUser[0]!.tasks,
      byModel[0]!.tasks,
      perAgent.tasks,
      perUser.tasks,
    ]) {
      expect(surface).toBe(window.tasks);
    }
    // The model-call counter is genuinely higher, and is reported separately.
    expect(perAgent.calls).toBeGreaterThan(perAgent.tasks);
  });

  it("agrees on token totals across every surface", async () => {
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    const range = await cost.getScopeCostRange(SCOPE, 7);
    const byAgent = await cost.getCostByAgent(SCOPE, { days: 7 });
    const byUser = await cost.getCostByUser(SCOPE, { days: 7 });
    const cacheRange = await cost.getAgentCacheRange(SCOPE, AGENT_ID, 7);

    expect(range.inputTokens).toBe(window.inputTokens);
    expect(byAgent[0]!.inputTokens).toBe(window.inputTokens);
    expect(byUser[0]!.inputTokens).toBe(window.inputTokens);
    expect(cacheRange.inputTokens).toBe(window.inputTokens);
    expect(byAgent[0]!.cacheReadInputTokens).toBe(window.cacheReadTokens);
    expect(byUser[0]!.cacheReadInputTokens).toBe(window.cacheReadTokens);
  });

  it("derives the fresh-token slice identically wherever it appears", async () => {
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    const range = await cost.getScopeCostRange(SCOPE, 7);
    const byUser = await cost.getCostByUser(SCOPE, { days: 7 });
    const cacheRange = await cost.getAgentCacheRange(SCOPE, AGENT_ID, 7);

    // The label that read 3 on one panel and 9 on another.
    expect(range.noCacheInputTokens).toBe(window.freshInputTokens);
    expect(byUser[0]!.noCacheInputTokens).toBe(window.freshInputTokens);
    expect(cacheRange.noCacheInputTokens).toBe(window.freshInputTokens);
  });

  it("splits spend into lanes that sum back to the headline total", async () => {
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    const summed = USAGE_LANES.reduce((total, lane) => total + window.byLane[lane], 0);
    expect(summed).toBeCloseTo(window.costCents, 4);
    expect(window.byLane.embedding).toBeCloseTo(0.4, 6);
    expect(window.byLane.extraction).toBeCloseTo(1.1, 6);
    expect(window.byLane.skill).toBeCloseTo(0.75, 6);
    // Turn spend dominates and is the residual, not a separately-summed field.
    expect(window.byLane.inference).toBeGreaterThan(window.byLane.embedding);
  });

  it("counts auxiliary and skill spend in the billable total, not only the naive one", async () => {
    // Auxiliary and skill writers used to bump `cost_cents` alone, so the
    // cache-aware total that budgets read excluded every embedding, extraction
    // and skill call in the window.
    const raw = await redis.hgetall(
      `cost:scope:${SCOPE.organizationId}:${SCOPE.projectId}:${SCOPE.environmentId}:${today()}`,
    );
    expect(billableCostFromRollup(raw)).toBeCloseTo(Number(raw.cost_cents), 6);
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    expect(window.costCents).toBeGreaterThan(window.byLane.inference);
  });

  it("does not double-count the per-user charge", async () => {
    // CostService and BudgetService both wrote cost to the SAME per-user key
    // for the same charge, so the per-user naive total ran at exactly 2x.
    const budget = new BudgetService(prismaStub() as any, redis as any);
    await budget.recordUserSpend(SCOPE, USER_ID, 12.3);

    const perUser = await cost.getUserDailyCost(SCOPE, USER_ID);
    const byUser = await cost.getCostByUser(SCOPE, { days: 7 });
    const window = await cost.getScopeUsageWindow(SCOPE, 7);

    expect(perUser.costCents).toBeCloseTo(byUser[0]!.costCents, 4);
    // One user did all the LLM work in this window, so their total is the
    // scope's minus the skill lane — `recordSkillUsage` carries an agent and a
    // thread but no user, so skill spend has no per-user attribution to give.
    // Asserting the exact gap keeps that a known shortfall rather than a
    // mystery the next person has to rediscover.
    expect(perUser.costCents).toBeCloseTo(window.costCents - window.byLane.skill, 4);
    expect(window.byLane.skill).toBeCloseTo(0.75, 6);
  });
});

describe("cache reads and writes are priced at their own rates", () => {
  it("prices each lane at its own canonical rate, not a multiplier of input", () => {
    const cost = new CostService(prismaStub(), new InMemoryRedis() as any);
    // One million tokens through each lane in turn, so each rate is isolated.
    return Promise.all([
      cost.priceUsage(MODEL, 1_000_000, 0, 0, 0),
      cost.priceUsage(MODEL, 0, 1_000_000, 0, 0),
      cost.priceUsage(MODEL, 1_000_000, 0, 0, 1_000_000),
      cost.priceUsage(MODEL, 1_000_000, 0, 1_000_000, 0),
    ]).then(([input, output, cacheRead, cacheWrite]) => {
      expect(input.costCents).toBeCloseTo(200, 6);
      expect(output.costCents).toBeCloseTo(1200, 6);
      // A cache READ is billed at the cache-read rate, not at input.
      expect(cacheRead.costCents).toBeCloseTo(20, 6);
      // A cache WRITE is billed at the cache-write rate.
      expect(cacheWrite.costCents).toBeCloseTo(250, 6);
      // The four rates are independent inputs from the WIN-125 catalogue, not
      // derived from one another.
      expect(cacheRead.price.cacheRead.source).toBe(ModelRateSource.VERIFIED_PROVIDER);
      expect(cacheWrite.price.cacheWrite.source).toBe(ModelRateSource.VERIFIED_PROVIDER);
    });
  });

  it("bills the cache slice once — inputTokens already contains it", async () => {
    const cost = new CostService(prismaStub(), new InMemoryRedis() as any);
    // 1M input of which 900k was a cache read and 100k a cache write.
    const priced = await cost.priceUsage(MODEL, 1_000_000, 0, 100_000, 900_000);
    // 0 fresh × 200c + 900k read × 20c/M + 100k write × 250c/M.
    expect(priced.costCents).toBeCloseTo(18 + 25, 6);
    // Billing the cache tokens at full input rate on top would give 243c.
    expect(priced.costCents).toBeLessThan(200);
  });

  it("records the same figure the pricing call returned", async () => {
    const redis = new InMemoryRedis();
    const cost = new CostService(prismaStub(), redis as any);
    const priced = await cost.priceUsage(MODEL, 40_000, 500, 2_000, 36_000);
    await recordTurn(cost);
    const window = await cost.getScopeUsageWindow(SCOPE, 7);
    expect(window.costCents).toBeCloseTo(priced.costCents, 4);
  });
});

describe("budget enforcement reads the cache-aware figure", () => {
  const CAP = {
    id: "cap-1",
    environmentId: SCOPE.environmentId,
    scope: JSON.stringify({ scopeType: "user", targetId: USER_ID, tier: "llm" }),
    period: "day",
    limitCents: 10,
    turnsLimit: 0,
    alertThresholds: [50, 80, 100],
    overrideUntil: null,
    enabled: true,
    agentId: null,
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
  };

  it("trips on a cap the naive figure would have left open", async () => {
    const redis = new InMemoryRedis();
    const budget = new BudgetService(prismaStub([CAP]) as any, redis as any);
    // The measured live shape: 2.47c naive against 25.70c actually billed.
    // Enforcement against the naive number could not trip a 10c cap.
    redis.hincrbyfloat(userKey(), "cost_cents", 2.47);
    redis.hincrbyfloat(userKey(), "cost_with_cache_cents", 25.7);

    const result = await budget.evaluate(SCOPE, { userId: USER_ID, agentId: AGENT_ID });
    expect(result.blocked).toBe(true);
    expect(result.caps[0]!.spentCents).toBeCloseTo(25.7, 6);
  });

  it("stays open when the cache-aware figure is genuinely under the cap", async () => {
    const redis = new InMemoryRedis();
    const budget = new BudgetService(prismaStub([CAP]) as any, redis as any);
    redis.hincrbyfloat(userKey(), "cost_cents", 2.47);
    redis.hincrbyfloat(userKey(), "cost_with_cache_cents", 4.1);

    const result = await budget.evaluate(SCOPE, { userId: USER_ID, agentId: AGENT_ID });
    expect(result.blocked).toBe(false);
    expect(result.caps[0]!.spentCents).toBeCloseTo(4.1, 6);
  });

  it("enforces against the same number the usage page shows", async () => {
    const redis = new InMemoryRedis();
    const cost = new CostService(prismaStub(), redis as any);
    const budget = new BudgetService(prismaStub([{ ...CAP, limitCents: 100_000 }]) as any, redis as any);
    await recordTurn(cost);
    await recordTurn(cost);

    const usagePage = await cost.getUserDailyCost(SCOPE, USER_ID);
    const enforcement = await budget.evaluate(SCOPE, { userId: USER_ID, agentId: AGENT_ID });
    // A budget the operator cannot reconcile against the usage page is a
    // budget they will not trust.
    expect(enforcement.caps[0]!.spentCents).toBeCloseTo(usagePage.costCents, 4);
  });

  it("counts a run limit in completed turns, not model calls", async () => {
    const redis = new InMemoryRedis();
    const cost = new CostService(prismaStub(), redis as any);
    const budget = new BudgetService(
      prismaStub([{ ...CAP, limitCents: 0, turnsLimit: 5 }]) as any,
      redis as any,
    );
    await recordTurn(cost);
    await recordTurn(cost);
    // Six auxiliary model calls on those two turns' behalf. A runs-cap that
    // counted `calls` would already be at 8 of 5 and would block the user for
    // work they never asked for.
    for (let i = 0; i < 6; i++) {
      await cost.recordAuxiliaryCost({
        scope: SCOPE,
        kind: "embedding",
        model: MODEL,
        costCents: 0.01,
        agentId: AGENT_ID,
        userId: USER_ID,
      });
    }

    const result = await budget.evaluate(SCOPE, { userId: USER_ID, agentId: AGENT_ID });
    expect(result.caps[0]!.runs).toBe(2);
    expect(result.blocked).toBe(false);
    const raw = await redis.hgetall(userKey());
    expect(usageFromRollup(raw).tasks).toBe(2);
    expect(Number(raw.calls)).toBe(8);
  });

  it("includes in-flight reservations at the cache-aware rate", async () => {
    const redis = new InMemoryRedis();
    const cost = new CostService(prismaStub(), redis as any);
    const budget = new BudgetService(prismaStub([CAP]) as any, redis as any);
    // Two concurrent turns must not both see "under cap" and proceed.
    await cost.beginReservation(SCOPE, 9, USER_ID);
    redis.hincrbyfloat(userKey(), "cost_with_cache_cents", 4);

    const result = await budget.evaluate(SCOPE, { userId: USER_ID, agentId: AGENT_ID });
    expect(result.caps[0]!.spentCents).toBeCloseTo(13, 6);
    expect(result.blocked).toBe(true);
  });
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function userKey(): string {
  return `cost:user:${SCOPE.organizationId}:${SCOPE.projectId}:${SCOPE.environmentId}:${USER_ID}:${today()}`;
}
