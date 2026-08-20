import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadataSet: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (definition: unknown) => definition,
  metadata: { set: mocks.metadataSet },
  logger: { info: vi.fn(), error: mocks.loggerError },
}));

import { budgetAlert, type BudgetAlertPayload } from "./budget-alert.task";

const payload: BudgetAlertPayload = {
  eventId: "event-a",
  capId: "budget-a",
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  scopeType: "scope",
  targetId: "",
  period: "month",
  threshold: 80,
  limitCents: 10_000,
  spentCents: 8_000,
  runs: 10,
  runsLimit: 0,
  windowKey: "2026-08",
  subjectLabel: "Scope-wide",
};

const originalUrl = process.env.PLATOS_AGENT_HTTP_URL;
const originalToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;

describe("budget alert Trigger callback shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadataSet.mockResolvedValue(undefined);
    process.env.PLATOS_AGENT_HTTP_URL = "https://agent.internal.example";
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "internal-auth-sentinel";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.PLATOS_AGENT_HTTP_URL;
    else process.env.PLATOS_AGENT_HTTP_URL = originalUrl;
    if (originalToken === undefined) delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    else process.env.PLATOS_INTERNAL_AUTH_TOKEN = originalToken;
  });

  it("delegates identifiers to the agent and returns the durable delivery summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ delivered: 1, failed: 0, skipped: 1, attempts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect((budgetAlert as any).run(payload)).resolves.toMatchObject({
      delivered: 1,
      failed: 0,
      skipped: 1,
    });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.internal.example/api/v1/agent/internal/budget-alert");
    expect(request.headers).toMatchObject({
      "X-Platos-Internal-Auth": "internal-auth-sentinel",
    });
    expect(JSON.parse(String(request.body))).toEqual(payload);
    expect(JSON.stringify(request.body)).not.toContain("internal-auth-sentinel");
  });

  it("fails the Trigger run on rejected delivery without serializing the response body", async () => {
    const sensitiveBody = "postgresql://writer:secret@db/internal sentinel-channel-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(sensitiveBody, { status: 503 })),
    );

    await expect((budgetAlert as any).run(payload)).rejects.toThrow(
      "budget_alert_callback_failed:CALLBACK_REJECTED",
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(sensitiveBody);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("sentinel-channel-secret");
  });
});
