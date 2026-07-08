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
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

/**
 * PIFSP-12 — Operator-authored custom tasks (PlatosTask CRUD + dispatch).
 *
 *   GET    /api/v1/agent/platos-tasks              — list all tasks in scope
 *   GET    /api/v1/agent/platos-tasks/:taskId      — get one task
 *   POST   /api/v1/agent/platos-tasks              — create task (compile + save)
 *   PATCH  /api/v1/agent/platos-tasks/:taskId      — update task
 *   DELETE /api/v1/agent/platos-tasks/:taskId      — delete task
 *   POST   /api/v1/agent/platos-tasks/:taskId/run  — manual trigger
 */
@Controller("api/v1/agent/platos-tasks")
export class PlatosTasksController {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  private getScope(req: Request): RequestScope {
    return (req as any).scope || {
      organizationId: "unknown",
      projectId: "unknown",
      environmentId: "unknown",
      userId: "unknown",
    };
  }

  private scopeWhere(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
  }

  /**
   * Attempt a lightweight "compile" of the handler source to catch obvious
   * syntax errors before saving. Uses Node's `new Function()` which checks
   * syntax without executing the code. Returns null on success, error string
   * on failure.
   */
  private checkSyntax(source: string): string | null {
    try {
      // eslint-disable-next-line no-new-func
      new Function("payload", "ctx", source);
      return null;
    } catch (err: any) {
      return err?.message ?? "Syntax error";
    }
  }

  @Get()
  async list(@Req() req: Request) {
    const scope = this.getScope(req);
    const tasks = await this.prisma.platosTask.findMany({
      where: this.scopeWhere(scope),
      orderBy: { createdAt: "desc" },
      select: {
        id: true, taskId: true, displayName: true, description: true,
        triggerType: true, isActive: true, handlerVersion: true,
        createdAt: true, updatedAt: true, lastRunAt: true,
      },
    });
    return { tasks };
  }

  @Get(":id")
  async getOne(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const task = await this.prisma.platosTask.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
    if (!task) throw new HttpException("Task not found", HttpStatus.NOT_FOUND);
    // Never leak compiledHandler to the client — it's a server-side artifact.
    const { compiledHandler: _, ...rest } = task;
    return { task: rest };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      taskId: string;
      displayName: string;
      description?: string;
      triggerType?: string;
      scheduleCron?: string;
      scheduleTimezone?: string;
      allowedAgentIds?: string[];
      payloadSchema?: Record<string, unknown>;
      handler: string;
      timeout?: number;
      maxRetries?: number;
    },
  ) {
    const scope = this.getScope(req);
    if (!body.taskId || !/^[a-z0-9-]{1,64}$/.test(body.taskId)) {
      throw new HttpException("taskId must be 1-64 lowercase alphanumeric + hyphens", HttpStatus.BAD_REQUEST);
    }
    if (!body.displayName?.trim()) {
      throw new HttpException("displayName is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.handler?.trim()) {
      throw new HttpException("handler source is required", HttpStatus.BAD_REQUEST);
    }

    const syntaxErr = this.checkSyntax(body.handler);
    const isActive = syntaxErr === null;

    const existing = await this.prisma.platosTask.findFirst({
      where: { taskId: body.taskId, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (existing) {
      throw new HttpException("A task with this taskId already exists in this scope", HttpStatus.CONFLICT);
    }

    const task = await this.prisma.platosTask.create({
      data: {
        ...this.scopeWhere(scope),
        taskId: body.taskId,
        displayName: body.displayName.trim(),
        description: body.description?.trim() ?? null,
        triggerType: body.triggerType ?? "manual",
        scheduleCron: body.scheduleCron ?? null,
        scheduleTimezone: body.scheduleTimezone ?? null,
        allowedAgentIds: body.allowedAgentIds ?? [],
        payloadSchema: body.payloadSchema ?? null,
        handler: body.handler,
        compiledHandler: isActive ? body.handler : null,
        isActive,
        timeout: body.timeout ?? 300,
        maxRetries: body.maxRetries ?? 3,
        createdBy: scope.userId,
      },
    });
    const { compiledHandler: _, ...rest } = task;
    return {
      task: rest,
      syntaxError: syntaxErr,
    };
  }

  @Patch(":id")
  async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body()
    body: {
      displayName?: string;
      description?: string;
      triggerType?: string;
      scheduleCron?: string;
      scheduleTimezone?: string;
      allowedAgentIds?: string[];
      payloadSchema?: Record<string, unknown>;
      handler?: string;
      timeout?: number;
      maxRetries?: number;
      isActive?: boolean;
    },
  ) {
    const scope = this.getScope(req);
    const existing = await this.prisma.platosTask.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true, handlerVersion: true, handler: true },
    });
    if (!existing) throw new HttpException("Task not found", HttpStatus.NOT_FOUND);

    const data: Record<string, unknown> = {};
    if (body.displayName !== undefined) data.displayName = body.displayName.trim();
    if (body.description !== undefined) data.description = body.description?.trim() ?? null;
    if (body.triggerType !== undefined) data.triggerType = body.triggerType;
    if (body.scheduleCron !== undefined) data.scheduleCron = body.scheduleCron;
    if (body.scheduleTimezone !== undefined) data.scheduleTimezone = body.scheduleTimezone;
    if (body.allowedAgentIds !== undefined) data.allowedAgentIds = body.allowedAgentIds;
    if (body.payloadSchema !== undefined) data.payloadSchema = body.payloadSchema;
    if (body.timeout !== undefined) data.timeout = body.timeout;
    if (body.maxRetries !== undefined) data.maxRetries = body.maxRetries;
    if (body.isActive !== undefined) data.isActive = body.isActive;

    let syntaxErr: string | null = null;
    if (body.handler !== undefined && body.handler !== existing.handler) {
      syntaxErr = this.checkSyntax(body.handler);
      data.handler = body.handler;
      data.compiledHandler = syntaxErr === null ? body.handler : null;
      data.isActive = syntaxErr === null;
      data.handlerVersion = existing.handlerVersion + 1;
    }

    const updated = await this.prisma.platosTask.update({
      where: { id },
      data,
    });
    const { compiledHandler: _, ...rest } = updated;
    return { task: rest, syntaxError: syntaxErr };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const existing = await this.prisma.platosTask.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!existing) throw new HttpException("Task not found", HttpStatus.NOT_FOUND);
    await this.prisma.platosTask.delete({ where: { id } });
    return { deleted: true };
  }

  @Post(":id/run")
  async run(@Req() req: Request, @Param("id") id: string, @Body() body: { payload?: Record<string, unknown> }) {
    const scope = this.getScope(req);
    const task = await this.prisma.platosTask.findFirst({
      where: { id, ...this.scopeWhere(scope), isActive: true },
      select: { id: true, taskId: true, displayName: true },
    });
    if (!task) throw new HttpException("Task not found or inactive", HttpStatus.NOT_FOUND);

    // Dispatch via trigger.dev if available; fall back to a no-op + warn.
    const triggerSecretKey = process.env.TRIGGER_SECRET_KEY;
    if (!triggerSecretKey) {
      return {
        queued: false,
        message: "TRIGGER_SECRET_KEY not configured — task execution unavailable. Set it in the docker-compose env to enable durable task dispatch.",
        taskId: task.taskId,
      };
    }

    try {
      // Lazy import trigger SDK — avoids top-level import that would fail if SDK not available.
      const { tasks } = await import("@trigger.dev/sdk");
      const run = await tasks.trigger("platos-custom-task", {
        taskRowId: id,
        payload: body.payload ?? {},
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: scope.userId,
        },
        invokedBy: "manual",
      });
      return { queued: true, runId: run.id, taskId: task.taskId };
    } catch (err: any) {
      throw new HttpException(`Dispatch failed: ${err?.message}`, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
