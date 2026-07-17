import { Inject, Injectable, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { validatePublicUrl, describeUrlValidationError, fetchWithValidatedRedirects } from "../shared/url-validator";

/**
 * Theme K.6 — MCP server registry.
 *
 * CRUD for `PlatosMCPServer` + `PlatosAgentMCPBinding` + cached
 * `tools/list` discovery (`PlatosMCPServerTool`). Discovery runs at
 * registration time + refreshes every 5 min via an internal admin
 * endpoint (wired into the same scheduled-task pattern as the
 * observability DLQ drain).
 *
 * Surface 2 tool matrix is built by `resolveEnabledTools(scope,
 * agentId)` — returns the flat list of `{ server, tool }` the agent
 * should see during a turn. The LLM calls tools via the
 * `McpToolExecutor` which dispatches per-transport.
 */

export interface RegisterServerInput {
  slug: string;
  displayName: string;
  transport: "remote-http" | "remote-sse" | "stdio" | `hosted-${string}`;
  url?: string;
  command?: string;
  args?: unknown;
  envVars?: Record<string, string>;
  /** When set, server is a per-agent install; null = org-scope. */
  agentId?: string | null;
  /** SecretStore key for API credentials (raw secret never stored here). */
  credsSecretKey?: string | null;
}

export interface ServerRow {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string | null;
  slug: string;
  displayName: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: unknown;
  envVars: unknown;
  credsSecretKey: string | null;
  lastDiscoveryAt: Date | null;
  discoveryError: string | null;
}

export interface ServerToolRow {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface BindingRow {
  id: string;
  agentId: string;
  serverId: string;
  enabledTools: string[];
  allToolsEnabled: boolean;
}

@Injectable()
export class McpServerRegistryService {
  private readonly logger = new Logger(McpServerRegistryService.name);
  private static readonly TOOLS_CACHE_TTL_SEC = 300;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  // ── Server CRUD ────────────────────────────────────────────────

  async register(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    input: RegisterServerInput,
  ): Promise<ServerRow> {
    if (!input.slug || !/^[a-z0-9][a-z0-9\-_]{0,63}$/.test(input.slug)) {
      throw new Error("slug must match ^[a-z0-9][a-z0-9\\-_]{0,63}$");
    }
    if (!input.displayName || input.displayName.length > 200) {
      throw new Error("displayName required, ≤200 chars");
    }
    if (!this.isValidTransport(input.transport)) {
      throw new Error(`unknown transport: ${input.transport}`);
    }
    if ((input.transport === "remote-http" || input.transport === "remote-sse") && !input.url) {
      throw new Error(`${input.transport} requires url`);
    }
    if (input.transport === "stdio" && !input.command) {
      throw new Error("stdio transport requires command");
    }

    // BUG-4: validate server URL at registration time to prevent SSRF.
    // Defense-in-depth: the executor also validates before every fetch call.
    if ((input.transport === "remote-http" || input.transport === "remote-sse") && input.url) {
      const urlCheck = await validatePublicUrl(input.url);
      if (!urlCheck.ok) {
        throw new Error(`server url blocked by SSRF guard: ${describeUrlValidationError(urlCheck.error)}`);
      }
    }

    const created = await this.prisma.platosMCPServer.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: input.agentId ?? null,
        slug: input.slug,
        displayName: input.displayName,
        transport: input.transport,
        url: input.url ?? null,
        command: input.command ?? null,
        args: (input.args ?? null) as any,
        envVars: (input.envVars ?? null) as any,
        credsSecretKey: input.credsSecretKey ?? null,
      },
    });
    return created as ServerRow;
  }

  async list(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    options: { agentId?: string | null } = {},
  ): Promise<ServerRow[]> {
    const where: any = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (options.agentId !== undefined) where.agentId = options.agentId;
    return this.prisma.platosMCPServer.findMany({
      where,
      orderBy: [{ slug: "asc" }],
    });
  }

  async get(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    serverId: string,
  ): Promise<ServerRow | null> {
    return this.prisma.platosMCPServer.findFirst({
      where: {
        id: serverId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
  }

  async delete(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    serverId: string,
  ): Promise<boolean> {
    const existing = await this.get(scope, serverId);
    if (!existing) return false;
    await this.prisma.platosMCPServer.delete({ where: { id: serverId } });
    await this.redis.del(`mcp:tools:${serverId}`).catch(() => undefined);
    return true;
  }

  // ── Tool discovery ──────────────────────────────────────────────

  /**
   * Sync `tools/list` for a server. Writes fresh PlatosMCPServerTool
   * rows + updates discovery timestamps. Idempotent — re-running
   * replaces the tool set (old entries deleted, new entries inserted).
   */
  async syncDiscovery(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    serverId: string,
  ): Promise<{ tools: ServerToolRow[]; error?: string }> {
    const server = await this.get(scope, serverId);
    if (!server) throw new Error("server not found in scope");

    let tools: ServerToolRow[] = [];
    let error: string | null = null;
    try {
      tools = await this.fetchToolsList(server);
    } catch (err: any) {
      error = err?.message?.slice(0, 500) ?? "discovery failed";
    }

    // Replace-set semantics inside a transaction so the cache is
    // always consistent with the row set.
    await this.prisma.$transaction([
      this.prisma.platosMCPServerTool.deleteMany({ where: { serverId } }),
      ...tools.map((t) =>
        this.prisma.platosMCPServerTool.create({
          data: {
            serverId,
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema ?? {}) as any,
          },
        }),
      ),
      this.prisma.platosMCPServer.update({
        where: { id: serverId },
        data: {
          lastDiscoveryAt: error ? null : new Date(),
          discoveryError: error,
        },
      }),
    ]);

    // Cache the tool list for fast matrix builds.
    await this.redis
      .set(
        `mcp:tools:${serverId}`,
        JSON.stringify(tools),
        "EX",
        McpServerRegistryService.TOOLS_CACHE_TTL_SEC,
      )
      .catch(() => undefined);

    return { tools, ...(error ? { error } : {}) };
  }

  private async fetchToolsList(server: ServerRow): Promise<ServerToolRow[]> {
    if (server.transport === "remote-http" || server.transport === "remote-sse") {
      if (!server.url) throw new Error("server.url missing");
      // BUG-4/15: defense-in-depth — validate before discovery fetch too.
      const urlCheck = await validatePublicUrl(server.url);
      if (!urlCheck.ok) {
        throw new Error(`server url blocked by SSRF guard: ${describeUrlValidationError(urlCheck.error)}`);
      }
      const body = {
        jsonrpc: "2.0",
        id: `discovery-${Date.now()}`,
        method: "tools/list",
        params: {},
      };
      const res = await fetchWithValidatedRedirects(server.url, 3, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`tools/list returned ${res.status}`);
      const json = (await res.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            description?: string;
            inputSchema?: unknown;
          }>;
        };
      };
      const raw = json?.result?.tools ?? [];
      return raw.map((t) => ({
        name: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ?? {},
      }));
    }
    if (server.transport.startsWith("hosted-")) {
      // Platos-hosted servers ship with a static manifest embedded
      // in their handler file. The handlers themselves are tracked
      // as K.11 follow-ups; for now we return an empty list so
      // registration still succeeds.
      return [];
    }
    if (server.transport === "stdio") {
      // Dev-only; spawn subprocess + read JSON-RPC over stdout.
      // Deferred to K.10 — MVP v1 ships without stdio transport.
      throw new Error("stdio transport discovery not yet implemented (K.10)");
    }
    throw new Error(`unknown transport: ${server.transport}`);
  }

  async getServerTools(serverId: string): Promise<ServerToolRow[]> {
    const cached = await this.redis.get(`mcp:tools:${serverId}`).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as ServerToolRow[];
      } catch {
        /* fall through to DB */
      }
    }
    const rows = (await this.prisma.platosMCPServerTool.findMany({
      where: { serverId },
      orderBy: [{ name: "asc" }],
      select: { name: true, description: true, inputSchema: true },
    })) as ServerToolRow[];
    // Warm the cache best-effort.
    await this.redis
      .set(
        `mcp:tools:${serverId}`,
        JSON.stringify(rows),
        "EX",
        McpServerRegistryService.TOOLS_CACHE_TTL_SEC,
      )
      .catch(() => undefined);
    return rows;
  }

  // ── Bindings (per-agent toggle matrix) ──────────────────────────

  async listBindings(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    agentId: string,
  ): Promise<BindingRow[]> {
    return this.prisma.platosAgentMCPBinding.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId,
      },
    });
  }

  async upsertBinding(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    input: {
      agentId: string;
      serverId: string;
      enabledTools?: string[];
      allToolsEnabled?: boolean;
    },
  ): Promise<BindingRow> {
    const existing = await this.prisma.platosAgentMCPBinding.findFirst({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: input.agentId,
        serverId: input.serverId,
      },
      select: { id: true },
    });
    const data = {
      enabledTools: input.enabledTools ?? [],
      allToolsEnabled: input.allToolsEnabled ?? true,
    };
    if (existing) {
      return this.prisma.platosAgentMCPBinding.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.platosAgentMCPBinding.create({
      data: {
        ...data,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: input.agentId,
        serverId: input.serverId,
      },
    });
  }

  async removeBinding(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    agentId: string,
    serverId: string,
  ): Promise<boolean> {
    const existing = await this.prisma.platosAgentMCPBinding.findFirst({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId,
        serverId,
      },
      select: { id: true },
    });
    if (!existing) return false;
    await this.prisma.platosAgentMCPBinding.delete({ where: { id: existing.id } });
    return true;
  }

  // ── Tool matrix resolution (K.13 integration point) ────────────

  /**
   * Return the union of (a) every org-scope server bound to this
   * agent via PlatosAgentMCPBinding, and (b) every per-agent install
   * (PlatosMCPServer with agentId = this agent). Emits flat entries
   * the prompt-builder injects into the LLM's tool list.
   *
   * Tool-name key: `<server.slug>.<tool.name>` so the LLM sees
   * e.g. `linear.create_issue` / `my_slack.post_message`.
   */
  async resolveEnabledTools(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    agentId: string,
  ): Promise<
    Array<{
      server: ServerRow;
      tool: ServerToolRow;
      /** Fully-qualified name surfaced to the LLM. */
      qualifiedName: string;
    }>
  > {
    // Per-agent installs — every tool enabled automatically.
    const perAgentServers = await this.prisma.platosMCPServer.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId,
      },
    });

    // Org-scope servers bound to this agent via binding table.
    const bindings = await this.listBindings(scope, agentId);
    const boundServerIds = bindings
      .map((b) => b.serverId)
      .filter((id): id is string => typeof id === "string");
    const orgScopeBound = boundServerIds.length
      ? await this.prisma.platosMCPServer.findMany({
          where: {
            id: { in: boundServerIds },
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        })
      : [];

    const out: Array<{
      server: ServerRow;
      tool: ServerToolRow;
      qualifiedName: string;
    }> = [];

    for (const server of perAgentServers as ServerRow[]) {
      const tools = await this.getServerTools(server.id);
      for (const tool of tools) {
        out.push({
          server,
          tool,
          qualifiedName: `${server.slug}.${tool.name}`,
        });
      }
    }

    for (const server of orgScopeBound as ServerRow[]) {
      const binding = bindings.find((b) => b.serverId === server.id);
      if (!binding) continue;
      const tools = await this.getServerTools(server.id);
      for (const tool of tools) {
        if (!binding.allToolsEnabled && !binding.enabledTools.includes(tool.name)) {
          continue;
        }
        out.push({
          server,
          tool,
          qualifiedName: `${server.slug}.${tool.name}`,
        });
      }
    }

    return out;
  }

  private isValidTransport(t: string): boolean {
    return (
      t === "remote-http" ||
      t === "remote-sse" ||
      t === "stdio" ||
      t.startsWith("hosted-")
    );
  }
}
