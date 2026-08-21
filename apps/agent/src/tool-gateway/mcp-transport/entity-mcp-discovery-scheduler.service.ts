import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../../shared/database.provider";
import { REDIS_TOKEN } from "../../shared/redis.provider";
import { env } from "../../shared/env";
import { EntityMcpDiscoveryService } from "./entity-mcp-discovery.service";

/**
 * EntityMcpDiscoverySchedulerService — periodic discovery refresh sweep for
 * `connectionKind == "mcp"` entities (design Commit 5 / §5).
 *
 * The cron fires every minute; each tick re-discovers the mcp entities whose
 * `EntityMcpClient.lastDiscoveryAt` is older than
 * `PLATOS_MCP_DISCOVERY_INTERVAL_SEC` (default 300s) — the same "reuse the old
 * cache-TTL constant" cadence Phase 1 used. This mirrors a wire backend
 * re-registering its tools on reconnect: `EntityMcpDiscoveryService.discover`
 * loops the entity's existing `(entity, env)` mappings' env set (via
 * canonical `Environment` lookup — §1.5b) and re-runs `tools/list` +
 * reconcile-prune per env, re-stamping `connectionStatus` so census/list stay
 * accurate. A never-yet-discovered entity (`lastDiscoveryAt == null`) is picked
 * up too, so a transient discovery failure at register-time self-heals.
 *
 * A NEW `RuntimeEnvironment` is picked up by a full `discover(entityPk)` pass,
 * which every sweep tick IS — so new envs also fold in over one interval,
 * matching a wire backend that would open a connection to the new env.
 *
 * A single-flight Redis lock keeps only one agent replica sweeping per tick
 * (identical pattern to `MemorySchedulerService`).
 */
@Injectable()
export class EntityMcpDiscoverySchedulerService {
  private readonly logger = new Logger(EntityMcpDiscoverySchedulerService.name);

  /** Cap per tick so a large fleet doesn't stampede the upstream servers. */
  private static readonly BATCH = 50;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: any,
    private readonly discovery: EntityMcpDiscoveryService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runRefreshSweep(): Promise<void> {
    const LOCK_KEY = "lock:mcp-discovery-refresh-cron";
    const LOCK_TTL_SEC = 120;
    const lockToken = crypto.randomBytes(16).toString("hex");

    let acquired = false;
    try {
      const setRes = await this.redis.set(
        LOCK_KEY,
        lockToken,
        "EX",
        LOCK_TTL_SEC,
        "NX",
      );
      acquired = setRes === "OK";
    } catch {
      this.logger.warn(
        "MCP discovery refresh cron: Redis lock unavailable — skipping tick",
      );
      return;
    }
    if (!acquired) {
      this.logger.debug(
        "MCP discovery refresh cron: already running — skipping tick",
      );
      return;
    }

    const startedAt = Date.now();
    const intervalSec = env.PLATOS_MCP_DISCOVERY_INTERVAL_SEC ?? 300;
    const staleBefore = new Date(Date.now() - intervalSec * 1000);
    let swept = 0;
    let failed = 0;

    try {
      // §5 selection: connectionKind="mcp" entities whose last successful
      // discovery is stale (or never happened). The client row carries
      // lastDiscoveryAt; the relation filter guards the kind (mcpClient rows
      // only ever exist for mcp entities, but belt-and-suspenders).
      const staleClients: Array<{ entityId: string }> =
        await this.prisma.entityMcpClient.findMany({
          where: {
            OR: [
              { lastDiscoveryAt: null },
              { lastDiscoveryAt: { lt: staleBefore } },
            ],
            entity: { connectionKind: "mcp" },
          },
          select: { entityId: true },
          orderBy: { lastDiscoveryAt: { sort: "asc", nulls: "first" } },
          take: EntityMcpDiscoverySchedulerService.BATCH,
        });

      for (const row of staleClients) {
        try {
          // discover() loops the entity's project envs (the existing
          // (entity, env) mapping set) and re-stamps status on its own.
          await this.discovery.discover(row.entityId);
          swept += 1;
        } catch (err: any) {
          failed += 1;
          this.logger.warn(
            `MCP discovery refresh failed for entity ${row.entityId}: ` +
              `${err?.message ?? err}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `MCP discovery refresh sweep query failed: ${err?.message ?? err}`,
      );
    } finally {
      try {
        const held = await this.redis.get(LOCK_KEY);
        if (held === lockToken) await this.redis.del(LOCK_KEY);
      } catch {
        // best-effort release — TTL cleans up on next tick
      }
      if (swept > 0 || failed > 0) {
        this.logger.log(
          `MCP discovery refresh sweep done in ${Date.now() - startedAt}ms — ` +
            `swept=${swept} failed=${failed} staleThresholdSec=${intervalSec}`,
        );
      }
    }
  }
}
