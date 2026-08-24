import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  HttpException,
  HttpStatus,
  Optional,
  Query,
} from "@nestjs/common";
import { type Request } from "express";
import { SkillRegistryService, SkillEnableError } from "./skill-registry.service";
import { SkillImporterService } from "./skill-importer.service";
import { OfficialSkillsSeederService } from "./official-skills-seeder.service";
import { SkillParseError } from "./skill-manifest.types";
import type { RequestScope } from "../auth/scope.guard";
import type { PromptCacheService } from "../agent-runtime/prompt-cache.service";
import { pageMetadata, parsePageRequest } from "../shared/pagination";

/**
 * Theme S — REST API for the Skills library.
 *
 * Endpoints (all scope-filtered via ScopeGuard):
 *   GET    /api/v1/agent/skills                      — list skills (lazy-seeds org on first call)
 *   GET    /api/v1/agent/skills/health               — skill health aggregate
 *   GET    /api/v1/agent/skills/:id                  — get one skill
 *   POST   /api/v1/agent/skills                      — register from raw source
 *   POST   /api/v1/agent/skills/import               — register from URL
 *   DELETE /api/v1/agent/skills/:id                  — delete a custom skill
 *   GET    /api/v1/agent/skills/agent/:agentId       — enabled skills for an agent
 *   POST   /api/v1/agent/skills/agent/:agentId/:id   — enable skill on agent
 *   DELETE /api/v1/agent/skills/agent/:agentId/:id   — remove skill from agent
 */
@Controller("api/v1/agent/skills")
export class SkillsController {
  constructor(
    private readonly registry: SkillRegistryService,
    private readonly importer: SkillImporterService,
    private readonly seeder: OfficialSkillsSeederService,
    // Optional: prompt cache invalidation so toggling a skill takes effect
    // on the very next turn instead of waiting for the 10-min TTL to expire.
    @Optional() private readonly promptCache?: PromptCacheService,
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

  private scopeTuple(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
  ) {
    const scope = this.scopeTuple(this.getScope(req));
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    let result = await this.registry.listPage(scope, {
      limit: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    // PIFSP-13 — lazy-seed: if no official skills exist for this org yet
    // (happens on fresh installs where the agent booted before the org was
    // created), trigger the seeder now and re-list.
    if (!result.items.some((s) => s.isOfficial)) {
      await this.seeder.seedForOrg(scope.organizationId).catch(() => {});
      result = await this.registry.listPage(scope, {
        limit: request.pageSize,
        offset: request.offset,
        search: request.search,
      });
    }
    return {
      skills: result.items,
      items: result.items,
      total: result.total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: request.offset + result.items.length < result.total,
      pagination: pageMetadata(result.total, request),
      filters: { search: request.search },
    };
  }

  // PIFSP-13 — Skill health aggregate for the Plato Central dashboard widget.
  @Get("health")
  async health(@Req() req: Request) {
    const scope = this.scopeTuple(this.getScope(req));
    const all = await this.registry.list(scope);
    const total = all.length;
    const official = all.filter((s) => s.isOfficial).length;
    const envReady = all.filter((s) => s.envReady === true).length;
    const broken = all.filter((s) => s.envReady === false && s.requiredEnv.length > 0).length;
    return { total, official, envReady, broken, fetchedAt: new Date().toISOString() };
  }

  @Get(":id")
  async getOne(@Req() req: Request, @Param("id") id: string) {
    const skill = await this.registry.get(this.scopeTuple(this.getScope(req)), id);
    if (!skill) throw new HttpException("Skill not found", HttpStatus.NOT_FOUND);
    return { skill };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      source: string;
      origin?: "community" | "custom";
      importedFrom?: string;
    },
  ) {
    try {
      const scope = this.scopeTuple(this.getScope(req));
      const regOpts: { importedFrom?: string; origin?: "community" | "custom" } = {};
      if (body.importedFrom !== undefined) regOpts.importedFrom = body.importedFrom;
      regOpts.origin = body.origin ?? "custom";
      const skill = await this.registry.registerFromSource(scope, body.source, regOpts);
      return { skill };
    } catch (err) {
      if (err instanceof SkillParseError) {
        throw new HttpException({ error: err.message, reason: err.reason }, HttpStatus.BAD_REQUEST);
      }
      throw err;
    }
  }

  @Post("import")
  async importFromUrl(@Req() req: Request, @Body() body: { url: string }) {
    try {
      if (!body?.url) {
        throw new HttpException("url is required", HttpStatus.BAD_REQUEST);
      }
      const parsed = await this.importer.importFromUrl(body.url);
      const skill = await this.registry.register(
        this.scopeTuple(this.getScope(req)),
        parsed,
        { origin: "community" },
      );
      return { skill };
    } catch (err) {
      if (err instanceof SkillParseError) {
        throw new HttpException(
          { error: err.message, reason: err.reason },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.registry.remove(this.scopeTuple(this.getScope(req)), id);
    return { removed: true };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-agent enablement
  // ──────────────────────────────────────────────────────────────────────────

  @Get("agent/:agentId")
  async listForAgent(@Req() req: Request, @Param("agentId") agentId: string) {
    const scope = this.scopeTuple(this.getScope(req));
    const skills = await this.registry.listForAgent(scope, agentId);
    return { skills };
  }

  @Post("agent/:agentId/:id")
  async enableForAgent(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("id") id: string,
  ) {
    try {
      const scope = this.scopeTuple(this.getScope(req));
      const skill = await this.registry.enableForAgent(scope, agentId, id);
      // Invalidate the prompt cache so the skill appears on the very next
      // turn instead of waiting up to 10 minutes for the TTL to expire.
      this.promptCache?.invalidate(agentId).catch(() => undefined);
      return { skill };
    } catch (err) {
      if (err instanceof SkillEnableError) {
        const httpStatus =
          err.reason === "missing_env"
            ? HttpStatus.PRECONDITION_FAILED
            : HttpStatus.BAD_REQUEST;
        throw new HttpException(
          { error: err.message, reason: err.reason, details: err.details },
          httpStatus,
        );
      }
      throw err;
    }
  }

  @Delete("agent/:agentId/:id")
  async removeFromAgent(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("id") id: string,
  ) {
    const scope = this.scopeTuple(this.getScope(req));
    await this.registry.removeFromAgent(scope, agentId, id);
    this.promptCache?.invalidate(agentId).catch(() => undefined);
    return { removed: true };
  }
}
