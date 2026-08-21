import { Inject, Injectable, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../../shared/database.provider";
import { env } from "../../shared/env";
import {
  validatePublicUrl,
  describeUrlValidationError,
} from "../../shared/url-validator";
import type { ScopeTuple } from "../../providers/scoped-env.service";
import { McpCredentialService } from "./mcp-credential.service";
import { McpConnectionPool } from "./mcp-client-pool.service";
import { ToolRegistryService, type ToolSchema } from "../tool-registry.service";

/**
 * EntityMcpDiscoveryService — tool discovery for `connectionKind == "mcp"`
 * entities (design Commit 3).
 *
 * This is the reparented survivor of Phase 1's `McpServerRegistryService`
 * discovery round-trip (`initialize` + `tools/list` over the pooled official
 * SDK client). Everything else of that service — CRUD, the parallel
 * `PlatosMCPServerTool` cache, the `PlatosAgentMCPBinding` matrix — is deleted;
 * discovery's OUTPUT is now `ToolRegistryService.registerTools`, i.e. the same
 * `Tool` + `EnvironmentEntityTool` matrix wire entities use.
 *
 * ── Environment scoping (design §1.5b — MIRROR the wire path) ──────────────
 * An `Entity` is project-scoped and has NO `environmentId`, but
 * `EnvironmentEntityTool` (and `registerTools`) require
 * one. A wire backend supplies it by opening one WS `/tools/sync` connection
 * PER env. Discovery is outbound (no inbound connection to carry an env), so we
 * replace "one connection per env" with "one discovery+registration pass per
 * env": `discover()` enumerates `environment.findMany({ projectId })` as the
 * SOLE supplier of `environmentId` (callers never pass one) and calls
 * declarative `registerTools` ONCE PER ENV. Both keep their
 * existing single-`environmentId` signatures — discovery loops; the registry
 * stays env-at-a-time exactly as the wire path drives it.
 *
 * Per-env credentials fall out for free: each env's pass resolves the linked
 * Credential's bare name through `ScopedEnvService` keyed on that env. Tool
 * definitions fan out across envs, secret material stays per-env, and the
 * entity can stay env-less. The pool key includes
 * the resolved URL + a hash of the resolved headers, so two envs (or two users
 * at dispatch time) never share a pooled session.
 *
 * Discovery is NOT per-user: `resolveUrl`/`resolveHeaders` run with no
 * `endUserId`, so a `{{endUserId}}`-templated discovery endpoint fails closed
 * here (surfaced as `discoveryError`) — you cannot enumerate a per-user server
 * without a user. The per-user substitution happens later, at dispatch.
 */

/** Minimal slice of an EntityMcpClient row the round-trip reads. */
interface McpClientSlice {
  transport: string;
  url?: string | null;
  /** `Json?` — { header: valueTemplate }; satisfies `CredentialServerSlice`. */
  headersTemplate?: unknown;
  credential?: { name: string } | null;
}

export interface DiscoveryResult {
  /** Number of project environments enumerated + registered into. */
  envs: number;
  /** Total tool registrations across all envs (sum of per-env `registered`). */
  registered: number;
  /** Total tool mappings pruned across all envs (sum of per-env `removed`). */
  pruned: number;
  /**
   * Present when at least one env failed. On a total failure this is the
   * failure reason (also stamped as `discoveryError`); on a partial failure it
   * is the first env's error (informational — `connectionStatus` is still
   * `connected` because some env succeeded).
   */
  error?: string;
}

@Injectable()
export class EntityMcpDiscoveryService {
  private readonly logger = new Logger(EntityMcpDiscoveryService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly credentials: McpCredentialService,
    private readonly pool: McpConnectionPool,
    private readonly registry: ToolRegistryService,
  ) {}

  /**
   * Discover + register the tools of a `connectionKind == "mcp"` entity into
   * every environment of its project. Idempotent-REPLACE: `registerTools`
   * atomically prunes anything the fresh `tools/list` no longer reports in
   * that Environment (AC1 + AC6). Stamps
   * `EntityMcpClient.lastDiscoveryAt` / `discoveryError` and the entity's
   * `connectionStatus` so census/list don't show every MCP entity disconnected
   * forever (design §1.5a).
   *
   * `environmentId` comes SOLELY from the canonical `Environment` lookup here — the
   * caller never passes one.
   */
  async discover(entityPk: string): Promise<DiscoveryResult> {
    const entity = await this.prisma.entity.findFirst({
      where: { id: entityPk },
      include: {
        project: { select: { organizationId: true } },
        mcpClient: { include: { credential: { select: { name: true } } } },
      },
    });
    if (!entity) throw new Error(`entity ${entityPk} not found`);
    if (entity.connectionKind !== "mcp") {
      throw new Error(
        `entity ${entityPk} is connectionKind="${entity.connectionKind}", not "mcp" — discovery is mcp-only`,
      );
    }

    const client: McpClientSlice | null = entity.mcpClient ?? null;
    if (!client) {
      const error = "mcp entity has no mcpClient transport config";
      await this.markEntityDisconnected(entityPk);
      return { envs: 0, registered: 0, pruned: 0, error };
    }

    // §1.5b — the SOLE environmentId supplier. All project envs, mirroring the
    // env set a wire backend could land in.
    const envs: Array<{ id: string }> =
      await this.prisma.environment.findMany({
        where: { projectId: entity.projectId },
        select: { id: true },
        orderBy: { id: "asc" },
      });

    if (envs.length === 0) {
      // Degenerate — nothing to register into. Not an error; record the sweep.
      await this.stampSuccess(entityPk);
      return { envs: 0, registered: 0, pruned: 0 };
    }

    let anySuccess = false;
    let registered = 0;
    let pruned = 0;
    let firstError: string | null = null;

    // One discovery + registration + prune pass per env (design §1.5b).
    for (const envRow of envs) {
      const scope: ScopeTuple = {
        organizationId: entity.project.organizationId,
        projectId: entity.projectId,
        environmentId: envRow.id,
      };
      try {
        const tools = await this.fetchToolsList(entity.id, client, scope);
        const res = await this.registry.registerTools(
          {
            organizationId: entity.project.organizationId,
            projectId: entity.projectId,
            environmentId: envRow.id,
            entityPk: entity.id,
            sourceEntityId: entity.externalId,
          },
          tools,
          // mcp is outbound — no callback URL. Persists as NULL; the cache
          // entry gets the "mcp:noop" sentinel (design §1.3 / §4).
          null,
        );
        registered += res.registered;
        pruned += res.removed;
        anySuccess = true;
      } catch (err: any) {
        const msg = err?.message
          ? String(err.message).slice(0, 500)
          : "discovery failed";
        if (!firstError) firstError = msg;
        this.registry.setEntityDispatchable(entity.id, false, envRow.id);
        // Redacted — resolveHeaders/pool never echo secret or header values.
        this.logger.warn(
          `MCP discovery failed for entity ${entity.id} env ${envRow.id}: ${msg}`,
        );
      }
    }

    if (anySuccess) {
      // At least one env connected → connected + clear discoveryError. Partial
      // failures are logged above; `error` is surfaced as an informational hint.
      await this.stampSuccess(entityPk);
      return {
        envs: envs.length,
        registered,
        pruned,
        ...(firstError ? { error: firstError } : {}),
      };
    }

    const error = firstError ?? "discovery failed in all environments";
    await this.stampFailure(entityPk, error);
    return { envs: envs.length, registered: 0, pruned: 0, error };
  }

  /**
   * The `initialize` + `tools/list` round-trip over the pooled SDK client for
   * one env. Mirrors the deleted `McpServerRegistryService.fetchToolsList`, with
   * the transport config read off the entity's 1:1 `mcpClient` and per-user
   * templating deferred to dispatch (no `endUserId` here).
   */
  private async fetchToolsList(
    entityId: string,
    client: McpClientSlice,
    scope: ScopeTuple,
  ): Promise<ToolSchema[]> {
    const transport = client.transport;

    if (transport === "remote-http" || transport === "remote-sse") {
      if (!client.url) {
        throw new Error("mcpClient.url missing for remote transport");
      }
      // Discovery is NOT per-user — resolveUrl runs with no endUserId, so a
      // `{{endUserId}}` discovery URL fails closed here (design §3.2).
      const resolvedUrl = this.credentials.resolveUrl(client.url);

      // Cheap early SSRF reject; the pool's fetch re-validates + address-pins
      // every hop of every request too (BUG-4 / BUG-15 defense-in-depth).
      const urlCheck = await validatePublicUrl(resolvedUrl);
      if (!urlCheck.ok) {
        throw new Error(
          `server url blocked by SSRF guard: ${describeUrlValidationError(urlCheck.error)}`,
        );
      }

      let resolvedHeaders: Record<string, string>;
      try {
        // No endUserId — a `{{endUserId}}` header template fails closed too.
        resolvedHeaders = await this.credentials.resolveHeaders(client, scope);
      } catch (err: any) {
        // resolveHeaders never echoes secret/header values — safe to surface.
        throw new Error(
          `credential resolution failed: ${err?.message ?? "unknown"}`,
        );
      }

      const sdkClient = await this.pool.getClient({
        server: { id: entityId },
        resolvedUrl,
        resolvedHeaders,
        transportKind: transport,
      });
      const listed = await sdkClient.listTools(
        {},
        { timeout: env.MCP_DISCOVERY_TIMEOUT_MS ?? 15_000 },
      );
      const raw = listed?.tools ?? [];
      return raw.map((t: any) => ({
        name: t.name,
        description: t.description ?? "",
        paramSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
    }

    if (transport.startsWith("hosted-")) {
      // Platos-hosted servers ship a static manifest (K.11 follow-up). Return
      // an empty list so discovery still succeeds (no tools registered yet).
      return [];
    }

    if (transport === "stdio") {
      // Dev-only; deferred to K.10 — MVP ships remote-http/sse + hosted-*.
      throw new Error("stdio transport discovery not yet implemented (K.10)");
    }

    throw new Error(`unknown transport: ${transport}`);
  }

  /** Stamp a successful discovery: connected + fresh timestamp, error cleared. */
  private async stampSuccess(entityPk: string): Promise<void> {
    const now = new Date();
    await this.prisma.entityMcpClient
      .update({
        where: { entityId: entityPk },
        data: { lastDiscoveryAt: now, discoveryError: null },
      })
      .catch(() => undefined);
    await this.prisma.entity
      .update({
        where: { id: entityPk },
        data: { connectionStatus: "connected", lastConnectedAt: now },
      })
      .catch(() => undefined);
  }

  /** Stamp a total discovery failure: disconnected + discoveryError. */
  private async stampFailure(entityPk: string, error: string): Promise<void> {
    await this.prisma.entityMcpClient
      .update({
        where: { entityId: entityPk },
        data: { lastDiscoveryAt: null, discoveryError: error.slice(0, 500) },
      })
      .catch(() => undefined);
    await this.markEntityDisconnected(entityPk);
  }

  private async markEntityDisconnected(entityPk: string): Promise<void> {
    await this.prisma.entity
      .update({
        where: { id: entityPk },
        data: { connectionStatus: "disconnected" },
      })
      .catch(() => undefined);
    this.registry.setEntityDispatchable(entityPk, false);
  }
}
