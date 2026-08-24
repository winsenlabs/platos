import type { LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope, agentPanel, agentRequest, PlatosAgentApiError } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
  agentPanel: vi.fn(),
  agentRequest: vi.fn(),
  PlatosAgentApiError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("../app/services/platosAgent.server", () => ({ agentPanel, agentRequest, PlatosAgentApiError }));

import { loadSurface } from "../app/services/m4Route.server";
import { loader as loadMonitoringUsers } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route";
import { loader as loadConversations } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations._index/route";
import { action as forkThread, loader as loadThread } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route";
import { loader as loadTrace } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId.trace/route";
import { loader as loadMemories } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route";
import { loader as loadMemoryGraph } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph/route";
import { loader as loadEvaluationAb } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route";

function args(url = "https://dashboard.example/entity"): LoaderFunctionArgs {
  return {
    request: new Request(url),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      agentId: "agent-1",
      entityId: "11111111-1111-4111-8111-111111111111",
      threadId: "thread-1",
    },
    context: {},
  };
}

describe("M4 route HTTP contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope: {} });
  });

  it("propagates an absent detail resource as a true HTTP 404", async () => {
    agentPanel.mockResolvedValue({
      ok: false,
      error: { status: 404, code: "AGENT_API_ERROR", message: "Entity not found" },
    });

    await expect(
      loadSurface(args(), {
        surface: "entities",
        title: "Entity",
        description: "Detail",
        endpoint: "/api/v1/agent/entities/:entityId",
        notFoundAsResponse: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(agentPanel).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-404 service failure isolated to a non-zero panel result", async () => {
    agentPanel.mockResolvedValue({
      ok: false,
      error: { status: 503, code: "AGENT_UNAVAILABLE", message: "Unavailable" },
    });

    const response = await loadSurface(args(), {
      surface: "entities",
      title: "Entity",
      description: "Detail",
      endpoint: "/api/v1/agent/entities/:entityId",
      notFoundAsResponse: true,
    });
    const payload = await response.json();

    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(payload.panel).toMatchObject({
      ok: false,
      error: { status: 503, code: "AGENT_UNAVAILABLE" },
    });
  });

  it("interpolates a route parameter alias into the canonical generated path", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { task: { id: "job-1" } } });
    const requestArgs = args();
    requestArgs.params = { ...requestArgs.params, taskId: "job-1" };

    await loadSurface(requestArgs, {
      surface: "jobs",
      title: "Job",
      description: "Detail",
      endpoint: "/api/v1/agent/platos-tasks/:id",
      parameterAliases: { id: "taskId" },
    });

    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(agentPanel).toHaveBeenCalledWith("/api/v1/agent/platos-tasks/job-1", expect.anything());
  });

  it("bounds monitoring-user pages and rejects unsafe cursors", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { users: [] } });

    await loadMonitoringUsers(args("https://dashboard.example/monitoring/users?limit=500&cursor=unsafe%2Fcursor"));

    expect(agentPanel).toHaveBeenCalledWith(
      "/api/v1/agent/monitoring/users?limit=100&sinceDays=7",
      expect.anything(),
    );

    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope: {} });
    agentPanel.mockResolvedValue({ ok: true, data: { users: [] } });

    await loadMonitoringUsers(args("https://dashboard.example/monitoring/users?limit=1&cursor=next_page-2"));

    expect(agentPanel).toHaveBeenCalledWith(
      "/api/v1/agent/monitoring/users?limit=10&sinceDays=7&cursor=next_page-2",
      expect.anything(),
    );
  });

  it("derives truthful conversation limit and offset from page controls", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { threads: [] } });

    await loadConversations(args("https://dashboard.example/threads?page=2&pageSize=100"));

    expect(agentPanel).toHaveBeenCalledWith(
      "/api/v1/agent/threads?agentId=agent-1&limit=100&offset=100",
      expect.anything(),
    );

    await expect(loadConversations(args("https://dashboard.example/threads?page=bad"))).rejects.toMatchObject({ status: 400 });
    await expect(loadConversations(args("https://dashboard.example/threads?pageSize=101"))).rejects.toMatchObject({ status: 400 });
    await expect(loadConversations(args("https://dashboard.example/threads?page=9007199254740991&pageSize=100"))).rejects.toMatchObject({ status: 400 });
  });

  it("preserves a canonical Thread 404 without fetching subordinate panels", async () => {
    agentPanel.mockResolvedValue({
      ok: false,
      error: { status: 404, code: "AGENT_API_ERROR", message: "Thread not found" },
    });

    await expect(loadThread(args())).rejects.toMatchObject({ status: 404 });

    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(agentPanel).toHaveBeenCalledWith(
      "/api/v1/agent/threads/thread-1",
      expect.anything(),
    );
  });

  it("keeps Thread message, artifact, trace, and audit failures subordinate", async () => {
    agentPanel.mockImplementation(async (path: string) => path === "/api/v1/agent/threads/thread-1"
      ? { ok: true, data: { id: "thread-1", turns: [] } }
      : { ok: false, error: { status: 503, code: "AGENT_UNAVAILABLE", message: path } });

    const response = await loadThread(args());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.panel.ok).toBe(true);
    expect(payload.panel.data.thread).toEqual({ id: "thread-1", turns: [] });
    expect(payload.panel.data.unavailable).toHaveLength(4);
  });

  it("pages Thread messages without allUsers and loads canonical artifacts", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { id: "thread-1" } });

    await loadThread(args("https://dashboard.example/threads/thread-1?page=3&pageSize=10"));

    expect(agentPanel).toHaveBeenNthCalledWith(1, "/api/v1/agent/threads/thread-1", expect.anything());
    expect(agentPanel).toHaveBeenNthCalledWith(2, "/api/v1/agent/threads/thread-1/messages?limit=10&offset=20", expect.anything());
    expect(agentPanel).toHaveBeenNthCalledWith(3, "/api/v1/agent/threads/thread-1/artifacts?limit=100", expect.anything());
    expect(agentPanel.mock.calls.flat().join(" ")).not.toContain("allUsers=true");
  });

  it("reads back a persisted fork and redirects to the canonical child Thread", async () => {
    agentRequest
      .mockResolvedValueOnce({ id: "thread-child", parentThreadId: "thread-1" })
      .mockResolvedValueOnce({ id: "thread-child", parentThreadId: "thread-1" });
    const requestArgs = args("https://dashboard.example/threads/thread-1");
    requestArgs.request = new Request(requestArgs.request.url, {
      method: "POST",
      body: new URLSearchParams({ intent: "fork", upToMessageId: "turn-2", title: "Child" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const response = await forkThread(requestArgs as any);

    expect(agentRequest).toHaveBeenNthCalledWith(1, "/api/v1/agent/threads/thread-1/fork", expect.anything(), {
      method: "POST",
      body: { upToMessageId: "turn-2", title: "Child" },
    });
    expect(agentRequest).toHaveBeenNthCalledWith(2, "/api/v1/agent/threads/thread-child", expect.anything());
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/threads/thread-child");
  });

  it("preserves a canonical Trace 404 before fetching tool audit", async () => {
    agentPanel.mockResolvedValue({
      ok: false,
      error: { status: 404, code: "AGENT_API_ERROR", message: "Trace not found" },
    });

    await expect(loadTrace(args())).rejects.toMatchObject({ status: 404 });
    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(agentPanel).toHaveBeenCalledWith(
      "/api/v1/agent/monitoring/trace/thread-1",
      expect.anything(),
    );
  });

  it("pins Memory reads while independently paging selector options and hydrating the selected Agent", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { memories: [] } });

    await loadMemories(args("https://dashboard.example/memories?userId=end-user-1&agentId=agent-40&agentPage=2&agentPageSize=10&agentSearch=deep"));

    expect(agentPanel).toHaveBeenNthCalledWith(
      1,
      "/api/v1/memory?userId=end-user-1&limit=50&offset=0",
      expect.objectContaining({ agentId: "agent-40" }),
    );
    expect(agentPanel).toHaveBeenNthCalledWith(
      2,
      "/api/v1/agent/agents?limit=10&offset=10&search=deep",
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
    expect(agentPanel).toHaveBeenNthCalledWith(
      3,
      "/api/v1/agent/agents/agent-40",
      expect.not.objectContaining({ agentId: expect.anything() }),
    );

    await loadMemoryGraph(args("https://dashboard.example/memories/graph?userId=end-user-1&agentId=agent-40&agentPage=2&agentPageSize=10"));
    expect(agentPanel).toHaveBeenNthCalledWith(7, "/api/v1/agent/agents/agent-40", expect.anything());
  });

  it("bounds Memory pagination and forwards canonical kind, source, and archive filters", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { memories: [] } });

    await loadMemories(args("https://dashboard.example/memories?userId=end-user-1&agentId=agent-1&kind=profile&source=imported&archiveState=archived&limit=999&offset=-5"));

    expect(agentPanel).toHaveBeenNthCalledWith(
      1,
      "/api/v1/memory?userId=end-user-1&kind=profile&source=imported&archiveState=archived&limit=100&offset=0",
      expect.objectContaining({ agentId: "agent-1" }),
    );
  });

  it("bounds graph entity pages and forwards the entity type in the selected Agent scope", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { entities: [] } });

    await loadMemoryGraph(args("https://dashboard.example/memories/graph?userId=end-user-1&agentId=agent-1&entityType=person&entityQ=ada&entityLimit=500&entityOffset=123"));

    expect(agentPanel).toHaveBeenNthCalledWith(
      1,
      "/api/v1/memory/graph/entities?userId=end-user-1&entityType=person&q=ada&limit=100&offset=123",
      expect.objectContaining({ agentId: "agent-1" }),
    );
  });

  it("loads a graph operation independently without replacing the current entity page", async () => {
    agentPanel.mockImplementation(async (path: string) => {
      if (path.includes("/graph/entities?")) {
        return { ok: true, data: { entities: [{ id: "entity-page-2" }], total: 141, offset: 100 } };
      }
      if (path.includes("/graph/path?")) {
        return { ok: true, data: { path: [{ entity: { id: "entity-cross-page" } }] } };
      }
      return { ok: true, data: { agents: [] } };
    });

    const response = await loadMemoryGraph(args(
      "https://dashboard.example/memories/graph?userId=end-user-1&agentId=agent-1&entityLimit=100&entityOffset=100&from=person%3Agrace&to=company%3Aplatos&maxHops=6",
    ));
    const payload = await response.json();

    expect(agentPanel).toHaveBeenNthCalledWith(
      1,
      "/api/v1/memory/graph/entities?userId=end-user-1&limit=100&offset=100",
      expect.objectContaining({ agentId: "agent-1" }),
    );
    expect(agentPanel).toHaveBeenNthCalledWith(
      3,
      "/api/v1/memory/graph/path?userId=end-user-1&from=person%3Agrace&to=company%3Aplatos&maxHops=6",
      expect.objectContaining({ agentId: "agent-1" }),
    );
    expect(payload.panel.data).toMatchObject({ total: 141, offset: 100 });
    expect(payload.supporting.data.path[0].entity.id).toBe("entity-cross-page");
  });

  it("does not call Memory without an explicit Agent pin in a potentially multi-Agent Environment", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { agents: [] } });

    const response = await loadMemories(args("https://dashboard.example/memories?userId=end-user-1"));
    const payload = await response.json();

    expect(payload.panel).toEqual({ ok: true, data: { requiresAgentContext: true } });
    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(agentPanel).toHaveBeenCalledWith("/api/v1/agent/agents?limit=25&offset=0", expect.anything());
  });

  it("forwards Evaluation A/B page controls using the AgentVersion take contract", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { versions: [] } });

    await loadEvaluationAb(args("https://dashboard.example/agents/agent-1/evals-ab?page=2&pageSize=10"));

    expect(agentPanel).toHaveBeenCalledWith(
      "/api/v1/agent/agents/agent-1/versions?take=10&offset=10",
      expect.anything(),
    );
  });
});
