import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Job, Prisma } from "@platos/tenancy-database";
import { type Request } from "express";
import type { RequestScope } from "../auth/scope.guard";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { configureExternalTriggerSdk } from "../shared/external-trigger-config";
import { pageMetadata, parseEnumFilter, parsePageRequest } from "../shared/pagination";
import {
  jobInvocationProperty,
  jobInvocationType,
  setJobInvocationType,
} from "./job-persistence";

@Controller("api/v1/agent/jobs")
export class JobsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  private getScope(req: Request): RequestScope {
    return (req as Request & { scope?: RequestScope }).scope ?? {
      organizationId: "unknown",
      projectId: "unknown",
      environmentId: "unknown",
      userId: "unknown",
    };
  }

  private checkSyntax(source: string): string | null {
    try {
      // eslint-disable-next-line no-new-func
      new Function("payload", "ctx", source);
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : "Syntax error";
    }
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("search") searchRaw?: string,
    @Query("status") statusRaw?: string,
  ) {
    const scope = this.getScope(req);
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const status = parseEnumFilter(statusRaw?.trim().toUpperCase(), "status", [
      "PENDING",
      "ACTIVE",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
    ] as const);
    const where: Prisma.JobWhereInput = {
      ...environmentScopeWhere(scope),
      ...(status ? { status } : {}),
      ...(request.search
        ? {
            OR: [
              { displayName: { contains: request.search, mode: "insensitive" } },
              { externalId: { contains: request.search, mode: "insensitive" } },
              { description: { contains: request.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [jobs, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: request.pageSize,
        skip: request.offset,
      }),
      this.prisma.job.count({ where }),
    ]);
    const items = jobs.map((job) => this.toJob(job));
    const pagination = pageMetadata(total, request);
    return {
      jobs: items,
      items,
      total,
      limit: request.pageSize,
      offset: request.offset,
      hasMore: pagination.hasNext,
      pagination,
      filters: { search: request.search, status },
    };
  }

  @Get(":id")
  async getOne(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const job = await this.prisma.job.findFirst({
      where: { id, ...environmentScopeWhere(scope) },
    });
    if (!job) throw new HttpException("Job not found", HttpStatus.NOT_FOUND);
    return { job: this.toJob(job) };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      jobId: string;
      displayName: string;
      description?: string;
      invocationType?: string;
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
    if (!body.jobId || !/^[a-z0-9-]{1,64}$/.test(body.jobId)) {
      throw new HttpException(
        "jobId must be 1-64 lowercase alphanumeric + hyphens",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!body.displayName?.trim()) {
      throw new HttpException(
        "displayName is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!body.handler?.trim()) {
      throw new HttpException(
        "handler source is required",
        HttpStatus.BAD_REQUEST,
      );
    }

    const syntaxError = this.checkSyntax(body.handler);
    const existing = await this.prisma.job.findFirst({
      where: {
        externalId: body.jobId,
        ...environmentScopeWhere(scope),
      },
      select: { id: true },
    });
    if (existing) {
      throw new HttpException(
        "A job with this jobId already exists in this scope",
        HttpStatus.CONFLICT,
      );
    }

    const job = await this.prisma.job.create({
      data: {
        environmentId: scope.environmentId,
        externalId: body.jobId,
        displayName: body.displayName.trim(),
        description: body.description?.trim() ?? null,
        ...jobInvocationProperty(body.invocationType ?? "manual"),
        scheduleCron: body.scheduleCron ?? null,
        scheduleTimezone: body.scheduleTimezone ?? null,
        allowedAgentIds: body.allowedAgentIds ?? [],
        payloadSchema: body.payloadSchema as
          | Prisma.InputJsonObject
          | undefined,
        handler: body.handler,
        status: syntaxError === null ? "ACTIVE" : "FAILED",
        timeoutSeconds: body.timeout ?? 300,
        maxRetries: body.maxRetries ?? 3,
        createdBy: scope.userId,
      } as Prisma.JobUncheckedCreateInput,
    });
    return { job: this.toJob(job), syntaxError };
  }

  @Patch(":id")
  async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body()
    body: {
      displayName?: string;
      description?: string;
      invocationType?: string;
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
    const existing = await this.prisma.job.findFirst({
      where: { id, ...environmentScopeWhere(scope) },
      select: { id: true, handler: true },
    });
    if (!existing) {
      throw new HttpException("Job not found", HttpStatus.NOT_FOUND);
    }

    const data: Prisma.JobUpdateInput = {};
    if (body.displayName !== undefined) {
      data.displayName = body.displayName.trim();
    }
    if (body.description !== undefined) {
      data.description = body.description.trim() || null;
    }
    if (body.invocationType !== undefined) setJobInvocationType(data, body.invocationType);
    if (body.scheduleCron !== undefined) data.scheduleCron = body.scheduleCron;
    if (body.scheduleTimezone !== undefined) {
      data.scheduleTimezone = body.scheduleTimezone;
    }
    if (body.allowedAgentIds !== undefined) {
      data.allowedAgentIds = body.allowedAgentIds;
    }
    if (body.payloadSchema !== undefined) {
      data.payloadSchema = body.payloadSchema as Prisma.InputJsonObject;
    }
    if (body.timeout !== undefined) data.timeoutSeconds = body.timeout;
    if (body.maxRetries !== undefined) data.maxRetries = body.maxRetries;
    if (body.isActive !== undefined) {
      data.status = body.isActive ? "ACTIVE" : "CANCELLED";
    }

    let syntaxError: string | null = null;
    if (body.handler !== undefined && body.handler !== existing.handler) {
      syntaxError = this.checkSyntax(body.handler);
      data.handler = body.handler;
      data.status = syntaxError === null ? "ACTIVE" : "FAILED";
    }

    const updated = await this.prisma.job.update({ where: { id }, data });
    return { job: this.toJob(updated), syntaxError };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    const result = await this.prisma.job.deleteMany({
      where: { id, ...environmentScopeWhere(scope) },
    });
    if (result.count === 0) {
      throw new HttpException("Job not found", HttpStatus.NOT_FOUND);
    }
    return { deleted: true };
  }

  @Post(":id/dispatch")
  async dispatch(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { payload?: Record<string, unknown> },
  ) {
    const scope = this.getScope(req);
    const job = await this.prisma.job.findFirst({
      where: {
        id,
        status: "ACTIVE",
        ...environmentScopeWhere(scope),
      },
      select: { id: true, externalId: true, displayName: true },
    });
    if (!job) {
      throw new HttpException(
        "Job not found or inactive",
        HttpStatus.NOT_FOUND,
      );
    }

    const triggerSdk = await import("@trigger.dev/sdk");
    if (configureExternalTriggerSdk(triggerSdk).status !== "configured") {
      return {
        accepted: false,
        message: "The durable Job runtime is not configured.",
        jobId: job.externalId ?? job.id,
      };
    }

    try {
      await triggerSdk.tasks.trigger(
        "platos-custom-task",
        {
          jobId: id,
          payload: body.payload ?? {},
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
          },
          invokedBy: "manual",
        },
        {
          tags: [
            `org:${scope.organizationId}`,
            `project:${scope.projectId}`,
            `env:${scope.environmentId}`,
            `user:${scope.userId}`,
          ],
          metadata: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
          },
        },
      );
      return { accepted: true, jobId: job.externalId ?? job.id };
    } catch {
      throw new HttpException(
        "The Job could not be dispatched.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private toJob(job: Job) {
    return {
      id: job.id,
      jobId: job.externalId ?? job.id,
      displayName: job.displayName,
      description: job.description,
      invocationType: jobInvocationType(job),
      scheduleCron: job.scheduleCron,
      scheduleTimezone: job.scheduleTimezone,
      allowedAgentIds: job.allowedAgentIds,
      payloadSchema: job.payloadSchema,
      handler: job.handler,
      timeout: job.timeoutSeconds,
      maxRetries: job.maxRetries,
      isActive: job.status === "ACTIVE",
      handlerVersion: 1,
      createdBy: job.createdBy,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastStartedAt: job.lastStartedAt,
    };
  }
}
