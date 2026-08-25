import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PerformanceEvidenceService } from "./performance-evidence.service";

const TOKEN = "performance-evidence-token-for-tests";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const previousEnabled = process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
const previousToken = process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;

describe("PerformanceEvidenceService", () => {
  let service: PerformanceEvidenceService;

  beforeEach(() => {
    process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = "1";
    process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN = TOKEN;
    service = new PerformanceEvidenceService();
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
    else process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = previousEnabled;
    if (previousToken === undefined) delete process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;
    else process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN = previousToken;
  });

  it("requires both the explicit enable flag and timing-safe evidence token", () => {
    expect(service.authorize({ "x-platos-performance-evidence-token": TOKEN })).toBe(true);
    expect(service.authorize({ "x-platos-performance-evidence-token": "wrong" })).toBe(false);
    delete process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
    expect(service.authorize({ "x-platos-performance-evidence-token": TOKEN })).toBe(false);
    process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = "1";
    delete process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;
    expect(service.enabled()).toBe(false);
  });

  it("binds query evidence to one allow-listed candidate request at Prisma invocation", async () => {
    await service.runRequest(
      {
        requestId: REQUEST_ID,
        method: "GET",
        path: "/api/v1/memory?userId=11111111-1111-4111-8111-111111111112&limit=50",
      },
      () =>
        service.runQueryInvocation(async () => {
          await Promise.resolve();
          service.recordQueryEvent({
            query: ' SELECT "id" FROM "Memory" WHERE "environmentId" = $1 LIMIT $2; ',
            params: '["11111111-1111-4111-8111-111111111113",50]',
            duration: 3,
          });
        })
    );
    service.complete(REQUEST_ID, 200);

    expect(service.consume(REQUEST_ID)).toMatchObject({
      requestId: REQUEST_ID,
      method: "GET",
      statusCode: 200,
      correlationStatus: "bound",
      queryCount: 1,
      queries: [
        {
          sequence: 1,
          durationMs: 3,
          parameters: ["11111111-1111-4111-8111-111111111113", 50],
          replayable: true,
          correlation: "request-bound-prisma-extension",
        },
      ],
    });
    expect(service.consume(REQUEST_ID)).toBeNull();
  });

  it("redacts unsupported string parameters and makes them non-replayable", async () => {
    await service.runRequest(
      { requestId: REQUEST_ID, method: "GET", path: "/api/v1/agent/agents" },
      () =>
        service.runQueryInvocation(async () => {
          service.recordQueryEvent({
            query: 'SELECT "id" FROM "Agent" WHERE "name" = $1',
            params: '["sk-secret-sentinel"]',
            duration: 1,
          });
        })
    );
    service.complete(REQUEST_ID, 200);
    const evidence = service.consume(REQUEST_ID)!;
    expect(evidence.queries[0]).toMatchObject({ parameters: [null], replayable: false });
    expect(JSON.stringify(evidence)).not.toContain("sk-secret-sentinel");
  });

  it("fails closed when a request-bound query overlaps an uncorrelated invocation", async () => {
    let releaseUncorrelated!: () => void;
    const uncorrelated = service.runQueryInvocation(
      () =>
        new Promise<void>((resolve) => {
          releaseUncorrelated = resolve;
        })
    );
    await service.runRequest(
      { requestId: REQUEST_ID, method: "GET", path: "/api/v1/agent/agents" },
      () =>
        service.runQueryInvocation(async () => {
          service.recordQueryEvent({
            query: 'SELECT "id" FROM "Agent"',
            params: "[]",
            duration: 1,
          });
        })
    );
    releaseUncorrelated();
    await uncorrelated;
    service.complete(REQUEST_ID, 200);

    expect(service.consume(REQUEST_ID)).toMatchObject({
      correlationStatus: "ambiguous",
      queryCount: 0,
    });
  });

  it("keeps concurrent Prisma invocations bound when they belong to the same request", async () => {
    await service.runRequest(
      { requestId: REQUEST_ID, method: "GET", path: "/api/v1/agent/agents" },
      async () => {
        let releaseFirst!: () => void;
        const first = service.runQueryInvocation(
          () =>
            new Promise<void>((resolve) => {
              releaseFirst = resolve;
            })
        );
        await service.runQueryInvocation(async () => {
          service.recordQueryEvent({
            query: 'SELECT "id" FROM "Agent"',
            params: "[]",
            duration: 1,
          });
        });
        releaseFirst();
        await first;
      }
    );
    service.complete(REQUEST_ID, 200);

    expect(service.consume(REQUEST_ID)).toMatchObject({
      correlationStatus: "bound",
      queryCount: 1,
    });
  });

  it("rejects mutation and non-contract request paths before capture", () => {
    expect(() =>
      service.runRequest(
        { requestId: REQUEST_ID, method: "POST", path: "/api/v1/memory" },
        () => undefined
      )
    ).toThrow("only permits GET");
    expect(() =>
      service.runRequest(
        { requestId: REQUEST_ID, method: "GET", path: "/api/v1/agent/secrets/status" },
        () => undefined
      )
    ).toThrow("path is not allowed");
  });
});
