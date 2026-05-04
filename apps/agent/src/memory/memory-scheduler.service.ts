import { Injectable, Inject, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import { MemoryExtractionService } from "./memory-extraction.service";

/**
 * NestJS cron scheduler for memory extraction.
 *
 * Runs the same sweep logic as the admin HTTP endpoint, but driven by
 * the NestJS scheduler so no external cron / trigger.dev worker is needed.
 * Fires every hour at minute 0.
 */
@Injectable()
export class MemorySchedulerService {
  private readonly logger = new Logger(MemorySchedulerService.name);

  constructor(
    private readonly extraction: MemoryExtractionService,
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: any,
  ) {}

  @Cron("0 * * * *")
  async runExtractionSweep(): Promise<void> {
    const LOCK_KEY = "lock:memory-extraction-cron";
    const LOCK_TTL_SEC = 300;
    const lockToken = crypto.randomBytes(16).toString("hex");

    let acquired = false;
    try {
      const setRes = await this.redis.set(LOCK_KEY, lockToken, "EX", LOCK_TTL_SEC, "NX");
      acquired = setRes === "OK";
    } catch {
      this.logger.warn("Memory extraction cron: Redis lock unavailable — skipping tick");
      return;
    }
    if (!acquired) {
      this.logger.debug("Memory extraction cron: already running — skipping tick");
      return;
    }

    const startedAt = Date.now();
    const stats = {
      threadsScanned: 0,
      threadsExtracted: 0,
      memoriesCreated: 0,
      entitiesCreated: 0,
      relationshipsCreated: 0,
      skipped: 0,
      errors: 0,
    };

    try {
      const since = new Date(Date.now() - 90 * 60_000);
      const threads: Array<{
        id: string;
        organizationId: string;
        projectId: string;
        environmentId: string;
      }> = await this.prisma.platosAgentThread.findMany({
        where: {
          updatedAt: { gte: since },
          turnCount: { gte: 2 },
        },
        select: {
          id: true,
          organizationId: true,
          projectId: true,
          environmentId: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
      });
      stats.threadsScanned = threads.length;

      for (const t of threads) {
        try {
          const out = await this.extraction.extractFromThread(
            {
              organizationId: t.organizationId,
              projectId: t.projectId,
              environmentId: t.environmentId,
            },
            { threadId: t.id },
          );
          if (out.memoriesCreated > 0 || out.entitiesCreated > 0 || out.relationshipsCreated > 0) {
            stats.threadsExtracted += 1;
          }
          stats.memoriesCreated += out.memoriesCreated;
          stats.entitiesCreated += out.entitiesCreated;
          stats.relationshipsCreated += out.relationshipsCreated;
          stats.skipped += out.skipped;
        } catch {
          stats.errors += 1;
        }
      }
    } finally {
      try {
        const held = await this.redis.get(LOCK_KEY);
        if (held === lockToken) await this.redis.del(LOCK_KEY);
      } catch {
        // best-effort release — TTL cleans up on next tick
      }
      this.logger.log(
        `Memory extraction sweep done in ${Date.now() - startedAt}ms — ` +
        `scanned=${stats.threadsScanned} extracted=${stats.threadsExtracted} ` +
        `memories=${stats.memoriesCreated} errors=${stats.errors}`,
      );
    }
  }
}
