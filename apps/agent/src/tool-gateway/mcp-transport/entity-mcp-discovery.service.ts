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

/**
 * WHAT ONE ENVIRONMENT'S PASS ACTUALLY DID — three outcomes, not two.
 *
 * WIN-269 (M4.3). The two-valued shape this replaces could not tell "the server
 * answered and offered nothing" from "no server was ever asked", and BOTH ended
 * at the same place: an empty tool list handed to `registerTools`, which is
 * idempotent-REPLACE and therefore DELETES every mapping the entity had in that
 * environment. Two live paths took it —
 *
 *   a `hosted-*` transport returned `[]` from the round-trip with the comment
 *   "so discovery still succeeds (no tools registered yet)", and
 *
 *   a project with zero environments stamped a SUCCESSFUL discovery, including
 *   `Entity.connectionStatus = "connected"` and a fresh `lastConnectedAt`,
 *   without opening a session to anything
 *
 * — and the refresh cron runs the whole thing every five minutes. So the wrong
 * answer was not merely indistinguishable from the right one; it was durable,
 * it destroyed the tool matrix, and it reported success while doing it.
 *
 * `skipped` is therefore its own outcome and not a flavour of either. It never
 * reaches `registerTools`, so nothing is pruned by a pass that asked nothing,
 * and it never reaches `stampSuccess`, so nothing claims a connection it did
 * not open.
 */
export type EnvironmentPassOutcome =
  | { readonly kind: "contacted"; readonly tools: ToolSchema[] }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface DiscoveryResult {
  /** Number of project environments enumerated. */
  envs: number;
  /**
   * Environments whose MCP server ANSWERED `tools/list`. Zero with `envs > 0`
   * means nothing was asked; `registered: 0` with `contacted > 0` means the
   * server was asked and offered nothing. That is the whole distinction this
   * field exists to make, and it is why a caller never has to read `error` to
   * find out whether the pass ran.
   */
  contacted: number;
  /** Environments where no session was attempted at all. */
  skipped: number;
  /** Environments where a session was attempted and did not produce an answer. */
  failed: number;
  /** Total tool registrations across all envs (sum of per-env `registered`). */
  registered: number;
  /** Total tool mappings pruned across all envs (sum of per-env `removed`). */
  pruned: number;
  /**
   * Present when at least one env failed OR was skipped. On a total failure
   * this is the failure reason (also stamped as `discoveryError`); on a partial
   * failure it is the first env's reason (informational — `connectionStatus` is
   * still `connected` because some env succeeded).
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
      // The client row IS the entity's transport: without it there is nothing
      // to open a session to, so the entity is genuinely undispatchable and the
      // status write stays. Nothing is pruned — the pass never reached
      // `registerTools` before this change either, and must not start to.
      const error = "mcp entity has no mcpClient transport config";
      await this.markEntityDisconnected(entityPk);
      return { envs: 0, contacted: 0, skipped: 1, failed: 0, registered: 0, pruned: 0, error };
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
      // WIN-269. A PROJECT WITH NO ENVIRONMENTS IS A SKIP, NOT A SUCCESS.
      //
      // This branch used to call `stampSuccess`, which writes
      // `EntityMcpClient.lastDiscoveryAt = now`, clears `discoveryError`, and
      // sets `Entity.connectionStatus = "connected"` with a fresh
      // `lastConnectedAt`. No session was opened, no server was asked, and the
      // upstream may have been unreachable for a week — an operator reading the
      // entity saw "connected, discovered just now, no error" either way. The
      // three stamps below are three DISTINGUISHABLE persisted states, which is
      // the property the two-state version could not have.
      const error = "the entity's project has no environments to register into";
      await this.stampSkipped(entityPk, error);
      return { envs: 0, contacted: 0, skipped: 1, failed: 0, registered: 0, pruned: 0, error };
    }

    let contacted = 0;
    let skipped = 0;
    let failed = 0;
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
      const outcome = await this.attemptToolsList(entity.id, client, scope);

      if (outcome.kind === "skipped") {
        skipped += 1;
        if (!firstError) firstError = outcome.reason;
        // NO `setEntityDispatchable(false)`: nothing was tried, so nothing was
        // learned about whether the backend is reachable. Saying it is not would
        // be the same lie in the other direction.
        this.logger.warn(
          `MCP discovery skipped for entity ${entity.id} env ${envRow.id}: ${outcome.reason}`,
        );
        continue;
      }

      if (outcome.kind === "failed") {
        failed += 1;
        if (!firstError) firstError = outcome.reason;
        this.registry.setEntityDispatchable(entity.id, false, envRow.id);
        // Redacted — resolveHeaders/pool never echo secret or header values.
        this.logger.warn(
          `MCP discovery failed for entity ${entity.id} env ${envRow.id}: ${outcome.reason}`,
        );
        continue;
      }

      // CONTACTED. The server answered, and `outcome.tools` is what it said —
      // which may be empty, and an empty ANSWER is a real answer: pruning the
      // environment's mappings is then the correct idempotent-replace outcome.
      // This is the only branch that may reach `registerTools`.
      try {
        const res = await this.registry.registerTools(
          {
            organizationId: entity.project.organizationId,
            projectId: entity.projectId,
            environmentId: envRow.id,
            entityPk: entity.id,
            sourceEntityId: entity.externalId,
          },
          outcome.tools,
          // mcp is outbound — no callback URL. Persists as NULL; the cache
          // entry gets the "mcp:noop" sentinel (design §1.3 / §4).
          null,
        );
        registered += res.registered;
        pruned += res.removed;
        contacted += 1;
      } catch (err: any) {
        // The server answered and the WRITE failed — a real failure, and not a
        // skip: the session was opened and the scope check or the transaction
        // refused. Reported as such so an operator is not sent looking at a
        // backend that answered perfectly well.
        const msg = err?.message
          ? String(err.message).slice(0, 500)
          : "registration failed";
        failed += 1;
        if (!firstError) firstError = msg;
        this.registry.setEntityDispatchable(entity.id, false, envRow.id);
        this.logger.warn(
          `MCP registration failed for entity ${entity.id} env ${envRow.id}: ${msg}`,
        );
      }
    }

    if (contacted > 0) {
      // At least one env's server ANSWERED → connected + clear discoveryError.
      // Partial failures and skips are logged above; `error` is surfaced as an
      // informational hint.
      await this.stampSuccess(entityPk);
      return {
        envs: envs.length,
        contacted,
        skipped,
        failed,
        registered,
        pruned,
        ...(firstError ? { error: firstError } : {}),
      };
    }

    if (failed > 0) {
      const error = firstError ?? "discovery failed in all environments";
      await this.stampFailure(entityPk, error);
      return { envs: envs.length, contacted: 0, skipped, failed, registered: 0, pruned: 0, error };
    }

    // Every environment was SKIPPED. Not a failure — nothing was asked — so the
    // entity's connection status is left exactly as it was, and no mapping is
    // touched. The reason is stamped so the skip is visible rather than silent.
    const error = firstError ?? "discovery was not attempted in any environment";
    await this.stampSkipped(entityPk, error);
    return { envs: envs.length, contacted: 0, skipped, failed: 0, registered: 0, pruned: 0, error };
  }

  /**
   * The `initialize` + `tools/list` round-trip over the pooled SDK client for
   * one env. Mirrors the deleted `McpServerRegistryService.fetchToolsList`, with
   * the transport config read off the entity's 1:1 `mcpClient` and per-user
   * templating deferred to dispatch (no `endUserId` here).
   *
   * IT NEVER THROWS AND IT NEVER RETURNS A BARE LIST. Both are the same
   * decision: a caller handed `ToolSchema[]` cannot tell an empty answer from a
   * transport this process does not speak, and a caller handed an exception
   * cannot tell "the server refused" from "we declined to ask". Every exit is a
   * tagged `EnvironmentPassOutcome`, and only `contacted` carries tools.
   */
  private async attemptToolsList(
    entityId: string,
    client: McpClientSlice,
    scope: ScopeTuple,
  ): Promise<EnvironmentPassOutcome> {
    const transport = client.transport;

    if (transport === "remote-http" || transport === "remote-sse") {
      if (!client.url) {
        return { kind: "failed", reason: "mcpClient.url missing for remote transport" };
      }
      // Discovery is NOT per-user — resolveUrl runs with no endUserId, so a
      // `{{endUserId}}` discovery URL fails closed here (design §3.2).
      let resolvedUrl: string;
      try {
        resolvedUrl = this.credentials.resolveUrl(client.url);
      } catch (err: any) {
        return {
          kind: "failed",
          reason: `url resolution failed: ${err?.message ?? "unknown"}`,
        };
      }

      // Cheap early SSRF reject; the pool's fetch re-validates + address-pins
      // every hop of every request too (BUG-4 / BUG-15 defense-in-depth).
      const urlCheck = await validatePublicUrl(resolvedUrl);
      if (!urlCheck.ok) {
        return {
          kind: "failed",
          reason: `server url blocked by SSRF guard: ${describeUrlValidationError(urlCheck.error)}`,
        };
      }

      let resolvedHeaders: Record<string, string>;
      try {
        // No endUserId — a `{{endUserId}}` header template fails closed too.
        resolvedHeaders = await this.credentials.resolveHeaders(client, scope);
      } catch (err: any) {
        // resolveHeaders never echoes secret/header values — safe to surface.
        return {
          kind: "failed",
          reason: `credential resolution failed: ${err?.message ?? "unknown"}`,
        };
      }

      try {
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
        // CONTACTED, and `tools` may legitimately be empty: a server that
        // publishes nothing has ANSWERED, and the prune that follows is the
        // correct idempotent-replace outcome rather than a data loss.
        return {
          kind: "contacted",
          tools: raw.map((t: any) => ({
            name: t.name,
            description: t.description ?? "",
            paramSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          })),
        };
      } catch (err: any) {
        return {
          kind: "failed",
          reason: err?.message ? String(err.message).slice(0, 500) : "discovery failed",
        };
      }
    }

    if (transport.startsWith("hosted-")) {
      // WIN-269. THIS USED TO `return []`, and the comment beside it said "so
      // discovery still succeeds (no tools registered yet)". It did not merely
      // succeed: the empty list went straight into `registerTools`, whose
      // `deleteMany` drops the `notIn` clause when nothing is active and
      // therefore DELETED EVERY `EnvironmentEntityTool` row the entity had in
      // that environment — then stamped the entity `connected` with a fresh
      // `lastDiscoveryAt`, on a five-minute cron, forever. Platos does not yet
      // fetch the static manifest these transports ship, so the honest answer
      // is that nothing was asked.
      return {
        kind: "skipped",
        reason: `Platos does not yet read the static manifest a ${transport} server ships; nothing was asked and nothing was pruned`,
      };
    }

    if (transport === "stdio") {
      // Dev-only; deferred to K.10 — MVP ships remote-http/sse + hosted-*. A
      // SKIP rather than a failure for the same reason as the branch above:
      // this process cannot speak the transport, which says nothing at all
      // about whether the backend is healthy, and marking the entity
      // disconnected on that basis is a claim nobody measured.
      return {
        kind: "skipped",
        reason: "stdio transport discovery not yet implemented (K.10)",
      };
    }

    // An unknown transport is NOT a skip. A `hosted-*` or `stdio` row is a
    // capability this process has not built yet; a transport nobody recognises
    // is a misconfigured row, and an operator has to see it and fix it.
    return { kind: "failed", reason: `unknown transport: ${transport}` };
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

  /**
   * Stamp a pass that WAS NOT ATTEMPTED: the reason, and nothing else.
   *
   * THE THIRD PERSISTED STATE, and the reason this method exists rather than
   * either of its neighbours being reused. `stampSuccess` would claim a
   * connection nobody opened; `stampFailure` would blame a backend nobody
   * asked, mark the entity disconnected and null out `lastDiscoveryAt` so the
   * one-minute cron re-skipped it forever. This writes `lastDiscoveryAt` — the
   * sweep DID run and should back off on its normal cadence — and a
   * `discoveryError` naming the skip, and it deliberately does not touch
   * `Entity.connectionStatus`, because a pass that asked nothing learned
   * nothing about liveness.
   *
   * So the three states are distinguishable by a reader of the two rows:
   *   contacted  lastDiscoveryAt set, discoveryError NULL, status connected
   *   skipped    lastDiscoveryAt set, discoveryError set,  status unchanged
   *   failed     lastDiscoveryAt NULL, discoveryError set, status disconnected
   */
  private async stampSkipped(entityPk: string, reason: string): Promise<void> {
    await this.prisma.entityMcpClient
      .update({
        where: { entityId: entityPk },
        data: { lastDiscoveryAt: new Date(), discoveryError: reason.slice(0, 500) },
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
