import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import type { RequestScope } from "../auth/scope.guard";
import { McpServerRegistryService, type RegisterServerInput } from "./server-registry.service";

/**
 * Theme K.6 — Agent MCP registry REST surface.
 *
 * `/api/v1/agent/mcp/servers` — org-scope + per-agent server CRUD.
 * `/api/v1/agent/mcp/agents/:agentId/bindings` — per-agent binding
 * toggle matrix.
 *
 * Scope-gated by the normal ScopeGuard. Webapp calls these from the
 * Settings → MCP Servers + agent-editor MCP-tab pages.
 */
@Controller("api/v1/agent/mcp")
export class McpAgentController {
  constructor(private readonly registry: McpServerRegistryService) {}

  private scope(req: Request): RequestScope {
    const scope = (req as any).scope as RequestScope | undefined;
    if (!scope) throw new HttpException("unauthenticated", HttpStatus.UNAUTHORIZED);
    return scope;
  }

  // ── Servers ─────────────────────────────────────────────────────

  @Get("servers")
  async listServers(
    @Req() req: Request,
    @Query("agentId") agentId?: string,
  ) {
    const scope = this.scope(req);
    const servers = await this.registry.list(
      scope,
      agentId !== undefined ? { agentId: agentId || null } : {},
    );
    return { servers };
  }

  @Post("servers")
  async registerServer(
    @Req() req: Request,
    @Body() body: RegisterServerInput,
  ) {
    const scope = this.scope(req);
    const created = await this.registry.register(scope, body);
    // Kick off discovery in the background — don't block the response.
    this.registry
      .syncDiscovery(scope, created.id)
      .catch(() => undefined);
    return { server: created };
  }

  @Post("servers/:id/resync")
  async resyncServer(@Req() req: Request, @Param("id") id: string) {
    const scope = this.scope(req);
    const result = await this.registry.syncDiscovery(scope, id);
    return result;
  }

  @Get("servers/:id/tools")
  async listServerTools(@Req() req: Request, @Param("id") id: string) {
    const scope = this.scope(req);
    const server = await this.registry.get(scope, id);
    if (!server) throw new HttpException("not found", HttpStatus.NOT_FOUND);
    const tools = await this.registry.getServerTools(id);
    return { tools };
  }

  @Delete("servers/:id")
  async deleteServer(@Req() req: Request, @Param("id") id: string) {
    const scope = this.scope(req);
    const ok = await this.registry.delete(scope, id);
    if (!ok) throw new HttpException("not found", HttpStatus.NOT_FOUND);
    return { ok: true };
  }

  // ── Agent bindings ──────────────────────────────────────────────

  @Get("agents/:agentId/bindings")
  async listBindings(
    @Req() req: Request,
    @Param("agentId") agentId: string,
  ) {
    const scope = this.scope(req);
    const bindings = await this.registry.listBindings(scope, agentId);
    return { bindings };
  }

  @Put("agents/:agentId/bindings/:serverId")
  async upsertBinding(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("serverId") serverId: string,
    @Body() body: { enabledTools?: string[]; allToolsEnabled?: boolean },
  ) {
    const scope = this.scope(req);
    const binding = await this.registry.upsertBinding(scope, {
      agentId,
      serverId,
      ...(body?.enabledTools !== undefined ? { enabledTools: body.enabledTools } : {}),
      ...(body?.allToolsEnabled !== undefined
        ? { allToolsEnabled: body.allToolsEnabled }
        : {}),
    });
    return { binding };
  }

  @Delete("agents/:agentId/bindings/:serverId")
  async removeBinding(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("serverId") serverId: string,
  ) {
    const scope = this.scope(req);
    const ok = await this.registry.removeBinding(scope, agentId, serverId);
    return { ok };
  }

  @Get("agents/:agentId/tool-matrix")
  async resolveAgentTools(
    @Req() req: Request,
    @Param("agentId") agentId: string,
  ) {
    const scope = this.scope(req);
    const tools = await this.registry.resolveEnabledTools(scope, agentId);
    return {
      tools: tools.map((t) => ({
        qualifiedName: t.qualifiedName,
        serverId: t.server.id,
        serverSlug: t.server.slug,
        toolName: t.tool.name,
        description: t.tool.description,
        inputSchema: t.tool.inputSchema,
      })),
    };
  }
}
