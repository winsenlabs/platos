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
} = {}) {
  const healthWrites: any[] = [];
  const prisma: any = {
    entity: {
      findFirst: async () => ({
        id: "entity-1",
        externalId: "github",
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
    toolHealth: {
      upsert: async (args: any) => {
        healthWrites.push(args);
        return args.create;
      },
    },
  };
  const registry = {
    getScopedTools: () => [entry],
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
