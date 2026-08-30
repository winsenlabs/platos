import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPAN_DLQ_ACTIVE_KEY,
  SPAN_DLQ_PROCESSING_LEASE_MS,
  SPAN_DLQ_PROCESSING_RUNS_KEY,
  spanDlqProcessingKey,
} from "./span-dlq";

const mockEnv = vi.hoisted(() => ({
  PLATOS_OTEL_CLICKHOUSE_URL: "http://clickhouse.test:8123",
  PLATOS_OTEL_SAMPLE_RATE: 1,
  PLATOS_CLICKHOUSE_TIMEOUT_MS: 1000,
  PLATOS_OTEL_STDOUT: false,
}));
vi.mock("../shared/env", () => ({ env: mockEnv }));

// eslint-disable-next-line import/first
import { SpansService, type PlatosSpan } from "./spans.service";

const redisUrl = process.env["PLATOS_TEST_REDIS_URL"];
const describeRedis = redisUrl ? describe : describe.skip;
const SCOPE = { organizationId: "org_redis", projectId: "proj_redis", environmentId: "env_redis" };
const RECORD: PlatosSpan = {
  traceId: "c".repeat(32),
  spanId: "d".repeat(16),
  name: "redis.integration",
  kind: "internal",
  startTimeUnixNano: 1_000_000,
  endTimeUnixNano: 2_000_000,
  durationMs: 1,
  status: "ok",
  attributes: {},
};

function queuedRow(retryCount = 0): string {
  return JSON.stringify({ scope: SCOPE, record: RECORD, retryCount, enqueuedAt: Date.now() });
}

describeRedis("WIN-290 real Redis DLQ processing lifecycle", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.ping();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  function service(): SpansService {
    const spans = new SpansService(
      redis as unknown as ConstructorParameters<typeof SpansService>[0],
    );
    spans.emitClickhouseEvent = () => undefined;
    return spans;
  }

  async function processingKeys(): Promise<string[]> {
    const keys = await redis.keys("platos:dlq:spans:processing:*");
    return keys.filter((key) => key !== SPAN_DLQ_PROCESSING_RUNS_KEY);
  }

  it("atomically claims and acknowledges a successful ClickHouse write", async () => {
    const spans = service();
    let writes = 0;
    spans.fetchImpl = (async () => {
      writes++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await redis.lpush(SPAN_DLQ_ACTIVE_KEY, queuedRow());

    await expect(spans.drainDlq(1)).resolves.toEqual({ retried: 1, dead: 0 });

    expect(writes).toBe(1);
    expect(await redis.llen(SPAN_DLQ_ACTIVE_KEY)).toBe(0);
    expect(await processingKeys()).toEqual([]);
    expect(await redis.zcard(SPAN_DLQ_PROCESSING_RUNS_KEY)).toBe(0);
  });

  it("recovers a process-interrupted claim once for documented at-least-once replay", async () => {
    const spans = service();
    const raw = queuedRow(2);
    const runId = "22222222-2222-4222-8222-222222222222";
    const processingKey = spanDlqProcessingKey(runId);
    const now = Date.now();
    await redis.lpush(SPAN_DLQ_ACTIVE_KEY, raw);
    await redis.zadd(
      SPAN_DLQ_PROCESSING_RUNS_KEY,
      now - SPAN_DLQ_PROCESSING_LEASE_MS - 1,
      runId,
    );
    await redis.rpoplpush(SPAN_DLQ_ACTIVE_KEY, processingKey);

    await expect(spans.recoverAbandonedDlq(1, now)).resolves.toBe(1);
    expect(await redis.lrange(SPAN_DLQ_ACTIVE_KEY, 0, -1)).toEqual([raw]);
    expect(await redis.llen(processingKey)).toBe(0);
    expect(await redis.zscore(SPAN_DLQ_PROCESSING_RUNS_KEY, runId)).toBeNull();
    await expect(spans.recoverAbandonedDlq(1, now)).resolves.toBe(0);
    expect(await redis.lrange(SPAN_DLQ_ACTIVE_KEY, 0, -1)).toEqual([raw]);

    let replayWrites = 0;
    spans.fetchImpl = (async () => {
      replayWrites++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await expect(spans.drainDlq(1)).resolves.toEqual({ retried: 1, dead: 0 });
    expect(replayWrites).toBe(1);
    expect(await redis.llen(SPAN_DLQ_ACTIVE_KEY)).toBe(0);
    expect(await processingKeys()).toEqual([]);
  });

  it("retains the processing row when an atomic requeue write fails", async () => {
    const spans = service();
    let writes = 0;
    spans.fetchImpl = (async () => {
      writes++;
      await redis.set(SPAN_DLQ_ACTIVE_KEY, "force-wrong-type-transition-failure");
      return new Response("Code: 60.", { status: 400 });
    }) as typeof fetch;
    await redis.lpush(SPAN_DLQ_ACTIVE_KEY, queuedRow(1));

    await expect(spans.drainDlq(1)).resolves.toEqual({ retried: 0, dead: 0 });
    const [processingKey] = await processingKeys();
    expect(processingKey).toBeTruthy();
    expect(await redis.llen(processingKey!)).toBe(1);
    expect(await redis.zcard(SPAN_DLQ_PROCESSING_RUNS_KEY)).toBe(1);

    await redis.del(SPAN_DLQ_ACTIVE_KEY);
    await expect(
      spans.recoverAbandonedDlq(1, Date.now() + SPAN_DLQ_PROCESSING_LEASE_MS + 1),
    ).resolves.toBe(1);
    expect(await redis.llen(SPAN_DLQ_ACTIVE_KEY)).toBe(1);
    expect(await processingKeys()).toEqual([]);

    spans.fetchImpl = (async () => {
      writes++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await expect(spans.drainDlq(1)).resolves.toEqual({ retried: 1, dead: 0 });
    expect(writes).toBe(2);
    expect(await redis.llen(SPAN_DLQ_ACTIVE_KEY)).toBe(0);
    expect(await processingKeys()).toEqual([]);
  });
});
