import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { ToolExecutorService } from "../tool-executor.service";
import type { OrgToolEntry, ToolSchema } from "../tool-registry.service";
import { EntityMcpDiscoveryService } from "./entity-mcp-discovery.service";

const SCOPE: RequestScope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "operator-1",
  agentId: "agent-1",
};

const entry: OrgToolEntry = {
  toolId: "tool-1",
  toolName: "github.create_issue",
  description: "Create an issue",
  paramSchema: { type: "object" },
  category: "github",
  callbackUrl: "",
  sourceEntityId: "github",
  entityPk: "entity-1",
  environmentId: "env-1",
  enabled: true,
  dispatchable: true,
  connectionKind: "mcp",
  allowedAgentIds: ["agent-1"],
  entityMcpInjectContext: false,
};

function makeExecutor(options: {
  credentialName?: string;
  resolvedSecret?: string;
  url?: string;
  entries?: OrgToolEntry[];
  persistedRoute?: boolean;
} = {}) {
  const healthWrites: any[] = [];
  const prisma: any = {
    entity: {
      findFirst: async ({ where }: any) => ({
        id: where.id,
        externalId: where.id === "entity-2" ? "other" : "github",
        projectId: "project-1",
        connectionKind: "mcp",
        mcpClient: {
          transport: "remote-http",
          url: options.url ?? "https://mcp.example/tools",
          headersTemplate: { Authorization: "Bearer {{secret}}" },
          credential: options.credentialName
            ? { name: options.credentialName }
            : null,
        },
      }),
    },
    environmentEntityTool: {
      findFirst: vi.fn(async () =>
        options.persistedRoute === false ? null : {
          id: "mapping-1",
          callbackUrl: options.url ?? "https://entity.example/tools",
          tool: {
            name: "github.create_issue",
            description: "Create issue",
            paramSchema: { type: "object" },
            category: null,
          },
        },
      ),
    },
    toolHealth: {
      upsert: async (args: any) => {
        healthWrites.push(args);
        return args.create;
      },
    },
  };
  const registry = {
    getScopedTools: () => options.entries ?? [entry],
  };
  const resolvedHeaders: Array<Record<string, string>> = [];
  const credentials = {
    resolveUrl: (url: string, endUserId?: string | null) =>
      url.replace("{{endUserId}}", endUserId ?? "{{endUserId}}"),
    resolveHeaders: async (server: any) => {
      const secret = options.resolvedSecret;
      if (server.credential && !secret) throw new Error("credential unavailable");
      const headers: Record<string, string> = secret
        ? { Authorization: `Bearer ${secret}` }
        : {};
      resolvedHeaders.push(headers);
      return headers;
    },
  };
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const getClient = vi.fn(async () => ({ callTool }));
  const pool = { getClient };
  const executor = new ToolExecutorService(
    prisma,
    registry as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    credentials as any,
    pool as any,
  );
  return { executor, healthWrites, resolvedHeaders, getClient, callTool };
}

function makeWireExecutor(
  injectMcpContext: boolean,
  options: { connected?: boolean; persistedCallbackUrl?: string } = {},
) {
  const wireEntry: OrgToolEntry = {
    ...entry,
    connectionKind: "wire",
    entityMcpInjectContext: injectMcpContext,
  };
  const prisma: any = {
    environmentEntityTool: { findFirst: vi.fn().mockResolvedValue({
      id: "mapping-1",
      callbackUrl: options.persistedCallbackUrl ?? "https://entity.example/tools",
      tool: {
        name: "github.create_issue",
        description: "Create issue",
        paramSchema: { type: "object" },
        category: null,
      },
    }) },
    entity: {
      findFirst: vi.fn().mockResolvedValue({
        id: "entity-1",
        externalId: "github",
        projectId: "project-1",
        connectionKind: "wire",
        mcpConfig: { injectMcpContext },
        mcpClient: null,
      }),
    },
    credential: { findFirst: vi.fn().mockResolvedValue({ name: "github" }) },
    toolHealth: { upsert: vi.fn().mockResolvedValue({}) },
    mcpOidcSession: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const registry = { getScopedTools: () => [wireEntry] };
  const ws = {
    isEntityConnected: vi.fn().mockReturnValue(options.connected ?? true),
    dispatchToolCall: vi.fn().mockResolvedValue({ result: "ok" }),
  };
  const credentials = {
    resolveCredentialReference: vi.fn().mockResolvedValue("service-secret"),
  };
  const executor = new ToolExecutorService(
    prisma,
    registry as any,
    ws as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    credentials as any,
    undefined,
  );
  return { executor, ws };
}

describe("clean EntityMcpClient discovery", () => {
  it("discovers every project Environment in deterministic order and registers complete declarations", async () => {
    const registrations: Array<{ environmentId: string; tools: ToolSchema[] }> = [];
    const prisma: any = {
      entity: {
        findFirst: async () => ({
          id: "entity-1",
          externalId: "github",
          projectId: "project-1",
          connectionKind: "mcp",
          project: { organizationId: "org-1" },
          mcpClient: {
            transport: "remote-http",
            url: "https://mcp.example/tools",
            headersTemplate: {},
            credential: null,
          },
        }),
        update: async () => ({}),
      },
      environment: {
        findMany: async () => [{ id: "env-1" }, { id: "env-2" }],
      },
      entityMcpClient: { update: async () => ({}) },
    };
    const credentials = {
      resolveUrl: (url: string) => url,
      resolveHeaders: async () => ({}),
    };
    const pool = {
      getClient: async () => ({
        listTools: async () => ({
          tools: [
            {
              name: "github.create_issue",
              description: "Create an issue",
              inputSchema: { type: "object" },
            },
          ],
        }),
      }),
    };
    const registry = {
      registerTools: async (params: any, tools: ToolSchema[]) => {
        registrations.push({ environmentId: params.environmentId, tools });
        return {
          registered: tools.length,
          updated: 0,
          newTools: tools.length,
          removed: 0,
        };
      },
      setEntityDispatchable: (_entityId: string, _value: boolean) => {
        return 0;
      },
    };

    const discovery = new EntityMcpDiscoveryService(
      prisma,
      credentials as any,
      pool as any,
      registry as any,
    );
    await expect(discovery.discover("entity-1")).resolves.toEqual({
      envs: 2,
      registered: 2,
      pruned: 0,
    });
    expect(registrations.map((call) => call.environmentId)).toEqual([
      "env-1",
      "env-2",
    ]);
    expect(registrations.flatMap((call) => call.tools.map((tool) => tool.name))).toEqual([
      "github.create_issue",
      "github.create_issue",
    ]);
  });
});

describe("clean MCP entity dispatch", () => {
  it("dispatches through EntityMcpClient and writes clean ToolHealth identity", async () => {
    const { executor, getClient, callTool, healthWrites } = makeExecutor();
    const result = await executor.execute(
      { tool: "github.create_issue", params: { title: "hello" } },
      SCOPE,
      { source: "agent_turn", endUserId: "user-1" },
    );

    expect(result.status).toBe("success");
    expect(getClient).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(
      { name: "github.create_issue", arguments: { title: "hello" } },
      undefined,
      expect.any(Object),
    );
    expect(healthWrites[0].where).toEqual({
      environmentId_toolId_entityExternalId: {
        environmentId: "env-1",
        toolId: "tool-1",
        entityExternalId: "github",
      },
    });
  });

  it("strips caller-owned reserved envelopes before outbound MCP transport", async () => {
    const { executor, callTool } = makeExecutor();
    const result = await executor.execute(
      {
        tool: "github.create_issue",
        params: {
          title: "hello",
          _context: { mcpUserId: "attacker" },
          __platos: { organizationId: "attacker" },
          _platos: { environmentId: "attacker" },
          platosContext: { source: "attacker" },
        },
      },
      SCOPE,
      { source: "mcp_client", mcpUserId: "mcp:pat:pat-1" },
      { entityPk: "entity-1", entityId: "github", toolId: "tool-1" },
    );

    expect(result.status).toBe("success");
    expect(callTool).toHaveBeenCalledWith(
      { name: "github.create_issue", arguments: { title: "hello" } },
      undefined,
      expect.any(Object),
    );
  });

  it("dispatches the exact preflighted entity when another entity has the same tool name", async () => {
    const otherEntry: OrgToolEntry = {
      ...entry,
      entityPk: "entity-2",
      sourceEntityId: "other",
      toolId: "tool-2",
    };
    const { executor, getClient } = makeExecutor({ entries: [otherEntry, entry] });

    const result = await executor.execute(
      { tool: "github.create_issue", params: { title: "hello" } },
      SCOPE,
      { source: "mcp_client", endUserId: "user-1" },
      { entityPk: "entity-1", entityId: "github", toolId: "tool-1" },
    );

    expect(result.status).toBe("success");
    expect(getClient).toHaveBeenCalledWith(
      expect.objectContaining({ server: { id: "entity-1" } }),
    );
  });

  it("denies a stale entity-pinned wire route before either wire transport", async () => {
    const wireEntry: OrgToolEntry = { ...entry, connectionKind: "wire" };
    const { executor, getClient } = makeExecutor({
      entries: [wireEntry],
      persistedRoute: false,
    });

    const result = await executor.execute(
      { tool: "github.create_issue", params: {} },
      SCOPE,
      { source: "mcp_client" },
      { entityPk: "entity-1", entityId: "github", toolId: "tool-1" },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/route is no longer valid/i);
    expect(getClient).not.toHaveBeenCalled();
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    "injectMcpContext=%s controls the inbound MCP wire envelope",
    async (injectMcpContext, expectsContext) => {
      const { executor, ws } = makeWireExecutor(injectMcpContext);
      const result = await executor.execute(
        {
          tool: "github.create_issue",
          params: {
            title: "hello",
            _context: { source: "attacker" },
            __platos: { organizationId: "attacker" },
            platos_context: { source: "attacker" },
          },
        },
        SCOPE,
        {
          source: "mcp_client",
          mcpUserId: "mcp:pat:pat-1",
          mcpClientId: "pat",
        },
        { entityPk: "entity-1", entityId: "github", toolId: "tool-1" },
      );

      expect(result.status).toBe("success");
      const dispatchedParams = ws.dispatchToolCall.mock.calls[0]![3];
      expect(dispatchedParams).not.toHaveProperty("platos_context");
      if (expectsContext) {
        expect(dispatchedParams._context).toEqual({
          source: "mcp_client",
          mcpUserId: "mcp:pat:pat-1",
          mcpClientId: "pat",
        });
      } else {
        expect(dispatchedParams).not.toHaveProperty("_context");
      }
      expect(dispatchedParams.__platos.organizationId).toBe(SCOPE.organizationId);
    },
  );

  it("uses the current persisted callback URL when the registry cache is stale", async () => {
    const currentUrl = "https://8.8.8.8/current-callback";
    const { executor } = makeWireExecutor(false, {
      connected: false,
      persistedCallbackUrl: currentUrl,
    });

    const result = await executor.execute(
      { tool: "github.create_issue", params: { title: "hello" } },
      SCOPE,
      { source: "mcp_client" },
      { entityPk: "entity-1", entityId: "github", toolId: "tool-1" },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("/current-callback");
    expect(result.error).not.toContain("entity.example/tools");
  });

  it("fails closed before transport when an end-user template is unresolved", async () => {
    const { executor, getClient } = makeExecutor({
      url: "https://mcp.example/users/{{endUserId}}/tools",
    });
    const result = await executor.execute(
      { tool: "github.create_issue", params: {} },
      SCOPE,
      { source: "agent_turn", endUserId: null },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/linked user/i);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("uses only the credential reference and never emits secret material in result", async () => {
    const sentinel = "super-secret-sentinel";
    const { executor, resolvedHeaders, getClient } = makeExecutor({
      credentialName: "GITHUB_MCP_TOKEN",
      resolvedSecret: sentinel,
    });
    const result = await executor.execute(
      { tool: "github.create_issue", params: {} },
      SCOPE,
      { source: "agent_turn", endUserId: "user-1" },
    );
    expect(result.status).toBe("success");
    expect(resolvedHeaders).toEqual([{ Authorization: `Bearer ${sentinel}` }]);
    expect(getClient).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
