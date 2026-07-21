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
 * `@platosdev/token-mint` does locally, but the agent here can validate
 * against the live entity row and audit the mint.
 */

/**
 * Sanitize caller-supplied verified-identity claims for a minted session
 * token. The mint endpoint is authed by the entity's serviceSecret, but the
 * body is still untrusted input — bound the claim shape so a compromised /
 * buggy backend can't stuff arbitrary or oversized identity rows into the
 * signed token (which `ConversationService.resolveEndUser` later trusts to
 * link the session to a canonical person).
 *
 * Contract (shared): max 8 entries; `channel` trimmed + lowercased and must
 * match /^[a-z0-9_-]{1,32}$/; `handle` trimmed with control chars stripped,
 * length 1..256; invalid entries are dropped SILENTLY. Returns undefined when
 * nothing survives (so the caller omits the claim entirely).
 */
function sanitizeUserIdentities(
  raw: unknown,
): Array<{ channel: string; handle: string; verified?: boolean }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ channel: string; handle: string; verified?: boolean }> = [];
  for (const entry of raw) {
    if (out.length >= 8) break;
    if (!entry || typeof entry !== "object") continue;
    const channelRaw = (entry as Record<string, unknown>).channel;
    const handleRaw = (entry as Record<string, unknown>).handle;
    if (typeof channelRaw !== "string" || typeof handleRaw !== "string") continue;
    const channel = channelRaw.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(channel)) continue;
    // Strip C0/C1 control chars + DEL (codepoints <=0x1F and 0x7F..0x9F),
    // then trim surrounding whitespace. Done via codePointAt (not a regex
    // literal) so no raw control bytes ever appear in source.
    const handle = Array.from(handleRaw)
      .filter((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f));
      })
      .join("")
      .trim();
    if (handle.length < 1 || handle.length > 256) continue;
    const verified = (entry as Record<string, unknown>).verified === true;
    out.push({ channel, handle, ...(verified ? { verified: true } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

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
      /**
       * M2 — typed passthrough for display-identity hints ({{user.name}} /
       * {{user.email}}). This is the CONTROLLED channel for `userMeta`: it is
       * stripped from the free-form `claims` bag (it's a RESERVED key) so it
       * can never be smuggled alongside a tenancy/identity override, but it is
       * cosmetic (not an authz boundary), so a caller may still set it here.
       */
      userMeta?: { name?: string; email?: string };
      /**
       * Channel-native identity claims the entity backend asserts for this
       * user (email addr, E.164 phone, Slack/Teams user id, ...). A typed
       * passthrough like `userMeta`: RESERVED in the free-form `claims` bag so
       * it can't be smuggled, but settable here. Sanitized (max 8; channel
       * /^[a-z0-9_-]{1,32}$/; handle 1..256, control chars stripped) before it
       * enters the signed token; `resolveEndUser` links `verified` claims to a
       * canonical PlatosEndUser downstream.
       */
      userIdentities?: Array<{ channel: string; handle: string; verified?: boolean }>;
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

    // M2 — sanitize caller-supplied extra claims. `body.claims` is a
    // free-form bag from an untrusted request body; strip every key the
    // verifier trusts (tenancy, identity, entity/secret-lookup, agent pin,
    // guest/operator flag, permissions, issuer, timing) so a caller holding
    // one entity's serviceSecret cannot mint a token for another scope,
    // impersonate another user, or defeat the PIFSP-1 agent pin. Merge the
    // sanitized bag FIRST so the typed fields below always win — mirroring
    // the safe ordering in AuthService.createPlatformSessionToken.
    const RESERVED_CLAIM_KEYS = new Set([
      "iss",
      "iat",
      "exp",
      "organizationId",
      "projectId",
      "environmentId",
      "entityId",
      "userId",
      "userToken",
      "agentId",
      "isGuest",
      "permissions",
      "userMeta",
      "userIdentities",
    ]);
    const safeClaims: Record<string, unknown> = {};
    if (
      body.claims &&
      typeof body.claims === "object" &&
      !Array.isArray(body.claims)
    ) {
      for (const [key, value] of Object.entries(body.claims)) {
        if (!RESERVED_CLAIM_KEYS.has(key)) safeClaims[key] = value;
      }
    }

    // Sanitize the typed identity-claim passthrough before it enters the
    // signed token. undefined when nothing survives, so the claim is omitted.
    const userIdentities = sanitizeUserIdentities(body.userIdentities);

    const token = await this.authService.createSessionToken(
      {
        ...safeClaims,
        organizationId: body.organizationId,
        projectId: body.projectId,
        environmentId: body.environmentId,
        userId: body.userId,
        entityId,
        ...(body.userToken ? { userToken: body.userToken } : {}),
        ...(body.agentId ? { agentId: body.agentId } : {}),
        // M2 — restore the display-identity passthrough via the typed field
        // (Fable regression catch: userMeta was previously only settable
        // through the now-sanitized claims bag).
        ...(body.userMeta ? { userMeta: body.userMeta } : {}),
        // Verified-identity claims (sanitized) — RESERVED in the claims bag,
        // settable only through this typed field.
        ...(userIdentities ? { userIdentities } : {}),
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
