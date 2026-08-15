import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import { type Request } from "express";
import * as crypto from "node:crypto";
import { AuthService } from "./auth.service";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { env } from "../shared/env";

/**
 * EOBD.89 companion — `POST /api/v1/public/guest-token`.
 *
 * Unauthenticated (obviously — the whole point is anonymous chat).
 * Mints a short-lived session token for a public-guest agent. The
 * `userId` claim is a random `guest-<hex>` string; the `isGuest: true`
 * flag rides in the payload so downstream cost/rate-limit layers can
 * apply tighter policy.
 *
 * Rate-limit:
 *   Per-IP bucket — default 20 tokens / 5 min. Per-agent global bucket
 *   — default 500 tokens / 5 min. Both configurable via env. A raw IP
 *   bucket alone lets a single distributed attacker burn through
 *   guest tokens; a per-agent bucket protects the agent budget.
 *
 * Agent must have `visibility: "public-guest"`; anything else 404s
 * (private) so we don't leak the existence of private agents.
 */

const WINDOW_SECONDS = 300;

function extractClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}

@Controller("api/v1/public")
export class PublicGuestTokenController {
  constructor(
    private readonly authService: AuthService,
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  @Post("guest-token")
  async mint(@Req() req: Request, @Body() body: { agentId: string }) {
    if (!body?.agentId || typeof body.agentId !== "string") {
      throw new HttpException("agentId is required", HttpStatus.BAD_REQUEST);
    }

    // Scope the agent lookup to a single row by primary key. If the
    // agent's visibility isn't `public-guest`, surface 404 (not 403)
    // so an attacker can't enumerate private agent ids.
    const agent = await this.prisma.platosAgent.findUnique({
      where: { id: body.agentId },
      select: {
        id: true,
        organizationId: true,
        projectId: true,
        environmentId: true,
        visibility: true,
        isActive: true,
      },
    });
    if (!agent || agent.visibility !== "public-guest" || !agent.isActive) {
      throw new HttpException("Agent not found", HttpStatus.NOT_FOUND);
    }

    const clientIp = extractClientIp(req);
    const ipLimit = env.PLATOS_PUBLIC_GUEST_IP_LIMIT ?? 20;
    const agentLimit = env.PLATOS_PUBLIC_GUEST_AGENT_LIMIT ?? 500;

    try {
      const nowBucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
      const ipKey = `guest_tok:ip:${clientIp}:${nowBucket}`;
      const agentKey = `guest_tok:agent:${agent.id}:${nowBucket}`;
      const [ipCount, agentCount] = await Promise.all([
        this.redis.incr(ipKey),
        this.redis.incr(agentKey),
      ]);
      if (ipCount === 1) await this.redis.expire(ipKey, WINDOW_SECONDS).catch(() => undefined);
      if (agentCount === 1)
        await this.redis.expire(agentKey, WINDOW_SECONDS).catch(() => undefined);
      if (ipCount > ipLimit) {
        throw new HttpException(
          `Too many guest tokens from this address. Retry in a few minutes.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (agentCount > agentLimit) {
        throw new HttpException(
          "This public agent is currently rate-limited. Retry in a few minutes.",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      // Redis hiccup — fail open, same policy as EOBD.12.
    }

    const guestId = `guest-${crypto.randomBytes(9).toString("hex")}`;
    const ttlSeconds = env.PLATOS_PUBLIC_GUEST_TOKEN_TTL_SECONDS ?? 1800;

    // EOBD.102 — use the shared AuthService mint helper instead of
    // inlining HMAC. `extraClaims` stamps `isGuest: true` + `agentId`
    // onto the platform-signed JWT so rate-limit + cost-attribution
    // layers can treat guest traffic separately.
    const iat = Math.floor(Date.now() / 1000);
    const token = await this.authService.createPlatformSessionToken(
      {
        organizationId: agent.organizationId,
        projectId: agent.projectId,
        environmentId: agent.environmentId,
        userId: guestId,
        extraClaims: {
          agentId: agent.id,
          isGuest: true,
        },
      },
      ttlSeconds,
    );
    if (!token) {
      throw new HttpException(
        "Guest tokens require SESSION_SECRET to be configured.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      token,
      guestId,
      expiresAt: iat + ttlSeconds,
      agentId: agent.id,
    };
  }
}
