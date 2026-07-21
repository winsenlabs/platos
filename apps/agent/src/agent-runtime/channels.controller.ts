import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { type Request } from "express";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { requireOperator, type RequestScope } from "../auth/scope.guard";

/**
 * Connect reimagining — dashboard REST for messaging-channel doorways.
 * This is what the redesigned Connect page calls. It mirrors the channels.*
 * platform MCP tools (management surface only — the inbound webhook RUNTIME
 * that receives Slack/Telegram/etc. posts is a SEPARATE slice).
 *
 *   GET    /api/v1/agent/channels              — list channels in scope
 *   POST   /api/v1/agent/channels              — create a channel
 *   GET    /api/v1/agent/channels/:id          — get one channel
 *   PATCH  /api/v1/agent/channels/:id          — partial-patch a channel
 *   DELETE /api/v1/agent/channels/:id          — delete a channel
 *   POST   /api/v1/agent/channels/:id/rotate-secret — rotate the webhook secret
 *
 * Every handler is OPERATOR-ONLY (requireOperator) and ScopeGuard-scoped —
 * the same posture as the operator-only entity-management endpoints on
 * AgentController. `credentials` is stored ENCRYPTED via MessageCryptoService
 * (the same envelope entity test-credentials use) and is NEVER returned;
 * `webhookSecret` is redacted on every read. The full secret-bearing
 * `webhookPath` is returned ONLY on create + rotate (one-time reveal).
 */

const CHANNEL_PROVIDERS = new Set(["slack", "telegram", "whatsapp", "discord"]);
const WEBHOOK_BASE = "/api/v1/channels/inbound";

@Controller("api/v1/agent/channels")
export class ChannelsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly messageCrypto: MessageCryptoService,
  ) {}

  private getScope(req: Request): RequestScope {
    return (
      (req as any).scope || {
        organizationId: "unknown",
        projectId: "unknown",
        environmentId: "unknown",
        userId: "unknown",
      }
    );
  }

  private scopeWhere(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
  }

  /** Redact the two secret columns; expose only whether credentials are set. */
  private projectRow(row: any) {
    const { credentials, webhookSecret, ...rest } = row;
    void webhookSecret;
    return { ...rest, hasCredentials: credentials != null };
  }

  private webhookPathFull(id: string, webhookSecret: string): string {
    return `${WEBHOOK_BASE}/${id}/${webhookSecret}`;
  }

  private isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /** Encrypt a credentials object into the stored envelope, or null to clear. */
  private encryptCredentials(raw: unknown): string | null {
    if (!this.isPlainObject(raw)) return null;
    return JSON.stringify(this.messageCrypto.encryptJsonField(raw));
  }

  /** Forged-id guard — the agent must belong to this exact scope. */
  private async agentInScope(scope: RequestScope, agentId: string): Promise<boolean> {
    const agent = await this.prisma.platosAgent.findFirst({
      where: { id: agentId, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    return !!agent;
  }

  @Get()
  async list(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope); // operator-only — same posture as entity management
    const rows = await this.prisma.platosChannelConnection.findMany({
      where: this.scopeWhere(scope),
      orderBy: { createdAt: "desc" },
    });
    return { channels: (rows as any[]).map((r) => this.projectRow(r)) };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      provider: string;
      agentId: string;
      displayName?: string;
      credentials?: Record<string, unknown> | null;
      config?: Record<string, unknown> | null;
    },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const provider = String(body?.provider ?? "").trim().toLowerCase();
    const agentId = String(body?.agentId ?? "").trim();
    if (!CHANNEL_PROVIDERS.has(provider)) {
      throw new HttpException(
        {
          error: "invalid_provider",
          message: "provider must be one of slack | telegram | whatsapp | discord",
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!agentId) {
      throw new HttpException(
        { error: "invalid_params", message: "agentId is required" },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!(await this.agentInScope(scope, agentId))) {
      throw new HttpException(
        { error: "unknown_agent_id", message: `agent ${agentId} not found in scope`, agentId },
        HttpStatus.BAD_REQUEST,
      );
    }

    const displayName =
      typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
    const configJson = this.isPlainObject(body?.config) ? body.config : undefined;
    const encryptedCreds = this.encryptCredentials(body?.credentials);
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const row = await this.prisma.platosChannelConnection.create({
      data: {
        ...this.scopeWhere(scope),
        provider,
        agentId,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(encryptedCreds !== null ? { credentials: encryptedCreds } : {}),
        ...(configJson !== undefined ? { config: configJson } : {}),
        webhookSecret,
      },
    });

    // One-time reveal: full inbound path + plaintext secret (create only).
    return {
      channel: this.projectRow(row),
      webhookSecret,
      webhookPath: this.webhookPathFull(row.id, webhookSecret),
    };
  }

  @Get(":id")
  async getOne(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const row = await this.prisma.platosChannelConnection.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
    if (!row) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);
    return { channel: this.projectRow(row) };
  }

  @Patch(":id")
  async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body()
    body: {
      displayName?: string | null;
      enabled?: boolean;
      agentId?: string;
      config?: Record<string, unknown> | null;
      credentials?: Record<string, unknown> | null;
    },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const existing = await this.prisma.platosChannelConnection.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!existing) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);

    const data: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
      data.displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    }
    if (typeof body.enabled === "boolean") data.enabled = body.enabled;
    if (typeof body.agentId === "string") {
      const agentId = body.agentId.trim();
      if (!agentId) {
        throw new HttpException(
          { error: "invalid_params", message: "agentId must be non-empty" },
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!(await this.agentInScope(scope, agentId))) {
        throw new HttpException(
          { error: "unknown_agent_id", message: `agent ${agentId} not found in scope`, agentId },
          HttpStatus.BAD_REQUEST,
        );
      }
      data.agentId = agentId;
    }
    if (Object.prototype.hasOwnProperty.call(body, "config")) {
      data.config = this.isPlainObject(body.config) ? body.config : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "credentials")) {
      // object → re-encrypt; null (or anything non-object) → clear.
      data.credentials = this.encryptCredentials(body.credentials);
    }

    if (Object.keys(data).length === 0) {
      const row = await this.prisma.platosChannelConnection.findFirst({
        where: { id, ...this.scopeWhere(scope) },
      });
      // Raced a concurrent delete between the existence check and this
      // refetch — 404 instead of throwing on the null destructure.
      if (!row) throw new HttpException("channel connection not found", HttpStatus.NOT_FOUND);
      return { channel: this.projectRow(row) };
    }

    const updated = await this.prisma.platosChannelConnection.update({
      where: { id },
      data,
    });
    return { channel: this.projectRow(updated) };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const existing = await this.prisma.platosChannelConnection.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!existing) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);
    await this.prisma.platosChannelConnection.delete({ where: { id } });
    return { deleted: true, id };
  }

  @Post(":id/rotate-secret")
  async rotateSecret(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const existing = await this.prisma.platosChannelConnection.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!existing) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);

    const webhookSecret = crypto.randomBytes(32).toString("hex");
    const updated = await this.prisma.platosChannelConnection.update({
      where: { id },
      data: { webhookSecret },
    });
    // One-time reveal: full inbound path + plaintext secret (rotate only).
    return {
      channel: this.projectRow(updated),
      webhookSecret,
      webhookPath: this.webhookPathFull(updated.id, webhookSecret),
    };
  }
}
