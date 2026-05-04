import {
  Body,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import * as crypto from "node:crypto";
import { AuthService } from "./auth.service";
import { PRISMA_TOKEN } from "../shared/database.provider";

/**
 * EOBD.95 — entity-scoped session-token mint endpoint.
 *
 * `POST /api/v1/entities/:entityId/session-tokens`
 *
 * The endpoint lives outside the usual `api/v1/agent` prefix so it can
 * be reached without ScopeGuard's session-token-or-headers auth —
 * because the CLIENT here IS an entity backend proving itself with the
 * `serviceSecret`. ScopeGuard allow-lists this path and the controller
 * performs its own auth.
 *
 * Wire format:
 *
 *   POST /api/v1/entities/my-entity/session-tokens
 *   Authorization: Bearer <serviceSecret>
 *   Content-Type: application/json
 *
 *   { "userId": "usr_123", "userToken": "...", "ttlSeconds": 3600, "claims": {...} }
 *
 *   → 200 { "token": "<jwt>", "expiresAt": 1730003600 }
 *   → 401 when the bearer secret doesn't match
 *   → 404 when the entity isn't registered for the org+project
 *
 * Intended callers: customer backends. Equivalent to what
 * `@platos/token-mint` does locally, but the agent here can validate
 * against the live entity row and audit the mint.
 */
@Controller("api/v1/entities")
export class SessionTokenController {
  constructor(
    private readonly authService: AuthService,
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
  ) {}

  @Post(":entityId/session-tokens")
  async mint(
    @Param("entityId") entityId: string,
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      userToken?: string;
      ttlSeconds?: number;
      /** PIFSP-1 — optional: scope the token to a specific agent. */
      agentId?: string;
      claims?: Record<string, unknown>;
    },
  ) {
    if (!entityId || !/^[A-Za-z0-9_\-]{1,64}$/.test(entityId)) {
      throw new HttpException("Invalid entityId", HttpStatus.BAD_REQUEST);
    }
    if (!body?.organizationId || !body?.projectId || !body?.environmentId) {
      throw new HttpException(
        "Body must include organizationId, projectId, environmentId",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!body.userId) {
      throw new HttpException("Body.userId is required", HttpStatus.BAD_REQUEST);
    }

    const secret =
      typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice(7).trim()
        : "";
    if (!secret) {
      throw new HttpException(
        "Authorization: Bearer <serviceSecret> required",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const entity = await this.prisma.platosConnectedEntity.findUnique({
      where: {
        organizationId_projectId_entityId: {
          organizationId: body.organizationId,
          projectId: body.projectId,
          entityId,
        },
      },
      select: { id: true, serviceSecret: true },
    });
    if (!entity) {
      throw new HttpException("Entity not found for scope", HttpStatus.NOT_FOUND);
    }

    const expected = Buffer.from(entity.serviceSecret, "utf8");
    const provided = Buffer.from(secret, "utf8");
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw new HttpException("Invalid service secret", HttpStatus.UNAUTHORIZED);
    }

    const ttlSeconds = Math.max(60, Math.min(86400 * 7, body.ttlSeconds ?? 3600));

    const token = await this.authService.createSessionToken(
      {
        organizationId: body.organizationId,
        projectId: body.projectId,
        environmentId: body.environmentId,
        userId: body.userId,
        entityId,
        ...(body.userToken ? { userToken: body.userToken } : {}),
        ...(body.agentId ? { agentId: body.agentId } : {}),
        ...(body.claims ?? {}),
      } as any,
      ttlSeconds,
    );
    if (!token) {
      throw new HttpException(
        "Mint failed — entity serviceSecret missing in store",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      token,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
  }
}
