import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadataSet: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (definition: unknown) => definition,
  metadata: { set: mocks.metadataSet },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

import { platosCustomTask, type PlatosCustomTaskPayload } from "./platos-custom-task";

const payload: PlatosCustomTaskPayload = {
  jobId: "job-row-a",
  payload: { input: "safe-input" },
  scope: {
    organizationId: "org-a",
    projectId: "project-a",
    environmentId: "env-a",
    userId: "user-a",
  },
  invokedBy: "agent",
  agentId: "agent-a",
};

const originalAgentUrl = process.env.PLATOS_AGENT_HTTP_URL;
const originalAgentApiUrl = process.env.PLATOS_AGENT_API_URL;
const originalToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
const triggerContext = { ctx: { run: { id: "run-callback-a" } } };

describe("platos custom task callback shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadataSet.mockResolvedValue(undefined);
    process.env.PLATOS_AGENT_HTTP_URL = "https://agent.internal.example/";
    delete process.env.PLATOS_AGENT_API_URL;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "internal-auth-sentinel";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAgentUrl === undefined) delete process.env.PLATOS_AGENT_HTTP_URL;
    else process.env.PLATOS_AGENT_HTTP_URL = originalAgentUrl;
    if (originalAgentApiUrl === undefined) delete process.env.PLATOS_AGENT_API_URL;
    else process.env.PLATOS_AGENT_API_URL = originalAgentApiUrl;
    if (originalToken === undefined) delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    else process.env.PLATOS_INTERNAL_AUTH_TOKEN = originalToken;
  });

  it("authenticates in a header while keeping the callback payload secret-free", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "completed", result: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await (platosCustomTask as any).run(payload, triggerContext);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.internal.example/api/v1/agent/internal/jobs/execute");
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Platos-Internal-Auth": "internal-auth-sentinel",
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);

    const callbackPayload = JSON.parse(String(request.body));
    expect(callbackPayload).toEqual({ requestId: "run-callback-a", ...payload });
    expect(JSON.stringify(callbackPayload)).not.toContain("internal-auth-sentinel");
    expect(JSON.stringify(callbackPayload)).not.toContain("DATABASE_URL");
    expect(result).toMatchObject({ status: "completed", result: { ok: true } });
  });

  it("fails the Trigger run with a stable safe code and discards a rejected callback body", async () => {
    const sensitiveFailure =
      "postgresql://writer:secret@db.internal/platos ANTHROPIC_API_KEY=sentinel";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(sensitiveFailure, { status: 503 }))
    );

    let failure: Error | undefined;
    try {
      await (platosCustomTask as any).run(payload, triggerContext);
    } catch (error) {
      failure = error as Error;
    }
    const serialized = JSON.stringify({
      failure: failure?.message,
      logs: mocks.loggerError.mock.calls,
    });

    expect(failure?.message).toBe("CALLBACK_REJECTED");
    expect(serialized).not.toContain(sensitiveFailure);
    expect(serialized).not.toContain("writer:secret");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
  });

  it("fails closed without callback authentication and never sends a request", async () => {
    delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect((platosCustomTask as any).run(payload, triggerContext)).rejects.toThrow(
      "CALLBACK_NOT_CONFIGURED"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the bounded request timeout to a stable code", async () => {
    const timeout = new Error("upstream timeout contained sensitive diagnostics");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    await expect((platosCustomTask as any).run(payload, triggerContext)).rejects.toThrow(
      "CALLBACK_TIMEOUT"
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(timeout.message);
  });

  it("redacts thrown transport errors", async () => {
    const sensitiveFailure = new Error(
      "connect ECONNREFUSED postgresql://trigger-role:password@db.internal/platos"
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(sensitiveFailure));

    let failure: Error | undefined;
    try {
      await (platosCustomTask as any).run(payload, triggerContext);
    } catch (error) {
      failure = error as Error;
    }
    const serialized = JSON.stringify({
      failure: failure?.message,
      logs: mocks.loggerError.mock.calls,
    });

    expect(failure?.message).toBe("CALLBACK_UNAVAILABLE");
    expect(serialized).not.toContain(sensitiveFailure.message);
    expect(serialized).not.toContain("password");
  });

  it("fails closed when Trigger does not supply a run id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect((platosCustomTask as any).run(payload, { ctx: { run: {} } })).rejects.toThrow(
      "CALLBACK_INVALID_CONTEXT"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
