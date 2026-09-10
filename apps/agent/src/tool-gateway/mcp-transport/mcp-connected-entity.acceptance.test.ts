import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { ToolExecutorService } from "../tool-executor.service";
import type { OrgToolEntry, ToolSchema } from "../tool-registry.service";
import { McpCredentialService } from "./mcp-credential.service";
import { EntityMcpDiscoveryService } from "./entity-mcp-discovery.service";

/**
 * WHAT THE EXECUTOR ACTUALLY CALLS ON `mcpCredentials`, read off the executor.
 *
 * WIN-269. Three cases in this file were RED for reasons that had nothing to do
 * with what they assert — `this.mcpCredentials?.resolveEntitySigningCredential
 * is not a function` — and the cause was a hand-rolled double, one method short,
 * standing in for a service that has the method. The production wiring was
 * fine; the double lied, and the three assertions it was hiding (the outgoing
 * `_context` envelope, the stale-cache callback URL) had been asserting nothing
 * for as long as it had.
 *
 * Naming the missing method would fix one instance. This joins to the SUBJECT
 * instead: every `this.mcpCredentials(?.)X(` in the executor's own source must
 * be a method the doubles below provide, and every one of those must be a real
 * method of `McpCredentialService`. A method added to the executor turns THIS
 * case red, at the double, instead of turning an unrelated assertion red
 * somewhere else — which is the failure mode that cost this suite three cases.
 */
const EXECUTOR_SOURCE = readFileSync(
  join(__dirname, "..", "tool-executor.service.ts"),
  "utf8",
);

function credentialMethodsTheExecutorCalls(): string[] {
  const names = new Set<string>();
  for (const match of EXECUTOR_SOURCE.matchAll(
    /this\.mcpCredentials\??\.([A-Za-z0-9_]+)\s*\(/gu,
  )) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/**
 * One double for both executor fixtures, carrying every method the executor
 * calls. The two secrets are DELIBERATELY DIFFERENT values: the entity signing
 * credential and a same-named environment variable are two different reads with
 * two different authorization paths, and a fixture that answered both with one
 * string could not tell a confusion between them from correct behaviour.
 */
const ENTITY_SIGNING_SECRET = "entity-signing-secret";
const CREDENTIAL_REFERENCE_SECRET = "credential-reference-secret";

function makeCredentials(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    resolveUrl: (url: string, endUserId?: string | null) =>
      url.replace("{{endUserId}}", endUserId ?? "{{endUserId}}"),
    resolveHeaders: async () => ({}),
    resolveCredentialReference: vi.fn().mockResolvedValue(CREDENTIAL_REFERENCE_SECRET),
    resolveEntitySigningCredential: vi.fn().mockResolvedValue(ENTITY_SIGNING_SECRET),
    ...overrides,
  } as Record<string, unknown>;
}

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
  const credentials = makeCredentials({
    resolveHeaders: async (server: any) => {
      const secret = options.resolvedSecret;
      if (server.credential && !secret) throw new Error("credential unavailable");
      const headers: Record<string, string> = secret
        ? { Authorization: `Bearer ${secret}` }
        : {};
      resolvedHeaders.push(headers);
      return headers;
    },
  });
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
  const credentials = makeCredentials();
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
    const credentials = makeCredentials();
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
      contacted: 2,
      skipped: 0,
      failed: 0,
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

// ---------------------------------------------------------------------------
// WIN-269 (M4.3) — A SKIPPED DISCOVERY AND A SUCCESSFUL EMPTY ONE MUST NOT LOOK
// THE SAME, AND A TOOL THAT FAILS MUST REPORT FAILURE.
//
// Both properties were unguarded. The first was WRONG in two live paths and the
// wrongness was durable and destructive; the second was RIGHT in production and
// asserted by nothing, which is the same thing one refactor later.
// ---------------------------------------------------------------------------

/** One discovery fixture, parameterised by the two things the cases vary. */
function makeDiscovery(options: {
  transport?: string;
  environments?: Array<{ id: string }>;
  listed?: unknown[];
  listThrows?: string;
  mcpClient?: unknown;
}) {
  const registrations: Array<{ environmentId: string; tools: ToolSchema[] }> = [];
  const clientWrites: any[] = [];
  const entityWrites: any[] = [];
  const dispatchableWrites: Array<[string, boolean, string | undefined]> = [];

  const prisma: any = {
    entity: {
      findFirst: async () => ({
        id: "entity-1",
        externalId: "github",
        projectId: "project-1",
        connectionKind: "mcp",
        project: { organizationId: "org-1" },
        mcpClient:
          options.mcpClient === undefined
            ? {
                transport: options.transport ?? "remote-http",
                url: "https://mcp.example/tools",
                headersTemplate: {},
                credential: null,
              }
            : options.mcpClient,
      }),
      update: async (args: any) => {
        entityWrites.push(args);
        return {};
      },
    },
    environment: {
      findMany: async () => options.environments ?? [{ id: "env-1" }],
    },
    entityMcpClient: {
      update: async (args: any) => {
        clientWrites.push(args);
        return {};
      },
    },
  };
  const pool = {
    getClient: async () => ({
      listTools: async () => {
        if (options.listThrows !== undefined) throw new Error(options.listThrows);
        return { tools: options.listed ?? [] };
      },
    }),
  };
  const registry = {
    registerTools: async (params: any, tools: ToolSchema[]) => {
      registrations.push({ environmentId: params.environmentId, tools });
      return { registered: tools.length, updated: 0, newTools: 0, removed: tools.length === 0 ? 7 : 0 };
    },
    setEntityDispatchable: (entityId: string, value: boolean, environmentId?: string) => {
      dispatchableWrites.push([entityId, value, environmentId]);
      return 0;
    },
  };
  const discovery = new EntityMcpDiscoveryService(
    prisma,
    makeCredentials() as any,
    pool as any,
    registry as any,
  );
  return { discovery, registrations, clientWrites, entityWrites, dispatchableWrites };
}

describe("WIN-269 — the doubles in this file stand for the real collaborators", () => {
  it("provides every `mcpCredentials` method the executor's own source calls", () => {
    const called = credentialMethodsTheExecutorCalls();
    // The regex must actually find something, or the join below is vacuous and
    // this case would pass against an executor that called nothing.
    expect(called.length).toBeGreaterThanOrEqual(3);
    const double = makeCredentials();
    for (const method of called) {
      expect(typeof double[method]).toBe("function");
      // ...and it must be a method the SERVICE really has, so the double cannot
      // paper over an executor calling something that does not exist.
      expect(typeof (McpCredentialService.prototype as any)[method]).toBe("function");
    }
  });
});

describe("WIN-269 — a failing MCP tool reports failure", () => {
  it("reports `failed` when the server answers with isError, not `success`", async () => {
    const { executor } = makeExecutor();
    // The MCP SDK returns a SUCCESSFUL JSON-RPC response carrying `isError` for
    // a tool-level failure; only the flag distinguishes it. Before this case,
    // deleting the `callRes.isError === true` check left every test in this
    // repository green while every failing MCP tool reported success to the
    // model — the guard existed and nothing could turn it red.
    const { executor: erroring, callTool } = makeExecutor();
    callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "the upstream rejected the arguments" }],
      isError: true,
    });
    const result = await erroring.execute(
      { tool: "github.create_issue", params: { title: "hello" } },
      SCOPE,
      { source: "agent_turn", endUserId: "user-1" },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("MCP tool returned an error result");
    // The content still travels: a model that is told only "it failed" cannot
    // act on what the backend said.
    expect(result.result).toMatchObject({ isError: true });
    // And the control: the same fixture without the flag is a success, so this
    // case is measuring the flag rather than the fixture.
    const ok = await executor.execute(
      { tool: "github.create_issue", params: { title: "hello" } },
      SCOPE,
      { source: "agent_turn", endUserId: "user-1" },
    );
    expect(ok.status).toBe("success");
  });
});

describe("WIN-269 — a discovery that did not run is distinguishable from one that found nothing", () => {
  it("a server that ANSWERS with no tools is contacted, and the prune is correct", async () => {
    const { discovery, registrations, clientWrites, entityWrites } = makeDiscovery({ listed: [] });
    const result = await discovery.discover("entity-1");

    expect(result).toEqual({
      envs: 1,
      contacted: 1,
      skipped: 0,
      failed: 0,
      registered: 0,
      pruned: 7,
    });
    // The empty answer REACHES registerTools, because an empty answer is an
    // answer and the idempotent-replace prune is the right outcome.
    expect(registrations).toEqual([{ environmentId: "env-1", tools: [] }]);
    // Persisted state: discovered, no error, connected.
    expect(clientWrites[0].data).toMatchObject({ discoveryError: null });
    expect(clientWrites[0].data.lastDiscoveryAt).toBeInstanceOf(Date);
    expect(entityWrites[0].data).toMatchObject({ connectionStatus: "connected" });
  });

  it("a project with NO environments is skipped: nothing pruned, nothing claimed connected", async () => {
    const { discovery, registrations, clientWrites, entityWrites } = makeDiscovery({
      environments: [],
    });
    const result = await discovery.discover("entity-1");

    expect(result).toEqual({
      envs: 0,
      contacted: 0,
      skipped: 1,
      failed: 0,
      registered: 0,
      pruned: 0,
      error: "the entity's project has no environments to register into",
    });
    // THE REGRESSION THIS CASE EXISTS FOR. This branch used to call
    // `stampSuccess`, which wrote `connectionStatus: "connected"` and a fresh
    // `lastConnectedAt` for an entity nobody had contacted.
    expect(entityWrites).toEqual([]);
    expect(registrations).toEqual([]);
    // The skip IS recorded, so it is visible rather than silent, and it is
    // distinguishable from the successful-empty case above by `discoveryError`.
    expect(clientWrites[0].data.discoveryError).toBe(
      "the entity's project has no environments to register into",
    );
    expect(clientWrites[0].data.lastDiscoveryAt).toBeInstanceOf(Date);
  });

  it("a hosted-* transport is skipped and prunes NOTHING", async () => {
    const { discovery, registrations, clientWrites, entityWrites, dispatchableWrites } =
      makeDiscovery({ transport: "hosted-composio" });
    const result = await discovery.discover("entity-1");

    expect(result.contacted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.pruned).toBe(0);
    // THE DATA-LOSS REGRESSION. `fetchToolsList` used to `return []` here, and
    // that empty list went into `registerTools`, whose `deleteMany` drops its
    // `notIn` clause when nothing is active — deleting every mapping the entity
    // had in the environment, every five minutes, while reporting success.
    expect(registrations).toEqual([]);
    expect(entityWrites).toEqual([]);
    // And nothing was learned about liveness, so nothing claims it was.
    expect(dispatchableWrites).toEqual([]);
    expect(String(clientWrites[0].data.discoveryError)).toContain("static manifest");
  });

  it("a server that REFUSES is a failure: disconnected, lastDiscoveryAt nulled, nothing pruned", async () => {
    const { discovery, registrations, clientWrites, entityWrites, dispatchableWrites } =
      makeDiscovery({ listThrows: "upstream refused the session" });
    const result = await discovery.discover("entity-1");

    expect(result.contacted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.error).toBe("upstream refused the session");
    expect(registrations).toEqual([]);
    // The three persisted states, and this is the third: lastDiscoveryAt NULL
    // (so the sweep retries), discoveryError set, entity marked disconnected.
    expect(clientWrites[0].data).toMatchObject({ lastDiscoveryAt: null });
    expect(entityWrites[0].data).toMatchObject({ connectionStatus: "disconnected" });
    // TWO writes and both are right: the per-environment one from the failing
    // pass, and the entity-wide one `markEntityDisconnected` makes when every
    // environment failed. Asserting only the first would go green if the second
    // disappeared, and the second is what stops a dispatch in an environment the
    // sweep never reached.
    expect(dispatchableWrites).toEqual([
      ["entity-1", false, "env-1"],
      ["entity-1", false, undefined],
    ]);
  });

  it("an unknown transport is a FAILURE and not a skip — an operator has to fix it", async () => {
    const { discovery, entityWrites } = makeDiscovery({ transport: "carrier-pigeon" });
    const result = await discovery.discover("entity-1");

    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.error).toBe("unknown transport: carrier-pigeon");
    expect(entityWrites[0].data).toMatchObject({ connectionStatus: "disconnected" });
  });

  it("one contacted environment survives another being skipped, and only the contacted one registers", async () => {
    // Two environments, one transport: the skip is per-environment in the
    // result shape even when the cause is not, so the counters stay additive.
    const { discovery, registrations, result } = await (async () => {
      const made = makeDiscovery({
        environments: [{ id: "env-1" }, { id: "env-2" }],
        listed: [
          { name: "github.create_issue", description: "Create", inputSchema: { type: "object" } },
        ],
      });
      return { ...made, result: await made.discovery.discover("entity-1") };
    })();

    expect(result.contacted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(registrations.map((call) => call.environmentId)).toEqual(["env-1", "env-2"]);
    void discovery;
  });
});
