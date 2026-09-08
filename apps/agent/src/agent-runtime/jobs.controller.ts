import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { API_VERSION } from "../http/api-surface";
import { type Request } from "express";
import { AuthService } from "../auth/auth.service";
import { requireOperator, type RequestScope } from "../auth/scope.guard";
import { configureExternalTriggerSdk } from "../shared/external-trigger-config";
import { pageMetadata, parseEnumFilter, parsePageRequest } from "../shared/pagination";
import { type JobPatch, type JobRecord, JobStore } from "./job-store";

@Controller({ path: "agent/jobs", version: API_VERSION })
export class JobsController {
  constructor(
    private readonly jobs: JobStore,
    private readonly authService: AuthService,
  ) {}

  private getScope(req: Request): RequestScope {
    return (req as Request & { scope?: RequestScope }).scope ?? {
      organizationId: "unknown",
      projectId: "unknown",
      environmentId: "unknown",
      userId: "unknown",
    };
  }

  private async canonicalOperatorScope(
    scope: RequestScope,
    access: "metadata" | "secret:mutate",
  ): Promise<RequestScope> {
    const authorization = await this.authService.authorizeEnvironmentOperatorScope(scope, access);
    return {
      organizationId: authorization.organizationId,
      projectId: authorization.projectId,
      environmentId: authorization.environmentId,
      userId: authorization.effectiveUserId,
      principal: "operator",
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
    const requestedScope = this.getScope(req);
    requireOperator(requestedScope);
    const scope = await this.canonicalOperatorScope(requestedScope, "metadata");
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search: searchRaw });
    const status = parseEnumFilter(statusRaw?.trim().toUpperCase(), "status", [
      "PENDING",
      "ACTIVE",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
    ] as const);
    const { jobs, total } = await this.jobs.page(scope, {
      pageSize: request.pageSize,
      offset: request.offset,
      search: request.search,
      status,
    });
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
    const requestedScope = this.getScope(req);
    requireOperator(requestedScope);
    const scope = await this.canonicalOperatorScope(requestedScope, "metadata");
    const job = await this.jobs.findInScope(scope, id);
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
    const requestedScope = this.getScope(req);
    requireOperator(requestedScope);
    const scope = await this.canonicalOperatorScope(requestedScope, "secret:mutate");
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
    if (await this.jobs.externalIdTaken(scope, body.jobId)) {
      throw new HttpException(
        "A job with this jobId already exists in this scope",
        HttpStatus.CONFLICT,
      );
    }

    const job = await this.jobs.create(scope, {
      externalId: body.jobId,
      displayName: body.displayName.trim(),
      description: body.description?.trim() ?? null,
      invocationType: body.invocationType ?? "manual",
      scheduleCron: body.scheduleCron ?? null,
      scheduleTimezone: body.scheduleTimezone ?? null,
      allowedAgentIds: body.allowedAgentIds ?? [],
      payloadSchema: body.payloadSchema,
      handler: body.handler,
      // A handler that does not parse still LANDS, inactive. The row must
      // exist for the author to fix it; refusing the write would lose the
      // source they just typed.
      status: syntaxError === null ? "ACTIVE" : "FAILED",
      timeoutSeconds: body.timeout ?? 300,
      maxRetries: body.maxRetries ?? 3,
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
    const requestedScope = this.getScope(req);
    requireOperator(requestedScope);
    const scope = await this.canonicalOperatorScope(requestedScope, "secret:mutate");
    const existing = await this.jobs.findHandlerSource(scope, id);
    if (!existing) {
      throw new HttpException("Job not found", HttpStatus.NOT_FOUND);
    }

    const data: {
      -readonly [Key in keyof JobPatch]: JobPatch[Key];
    } = {};
    if (body.displayName !== undefined) {
      data.displayName = body.displayName.trim();
    }
    if (body.description !== undefined) {
      data.description = body.description.trim() || null;
    }
    if (body.invocationType !== undefined) data.invocationType = body.invocationType;
    if (body.scheduleCron !== undefined) data.scheduleCron = body.scheduleCron;
    if (body.scheduleTimezone !== undefined) {
      data.scheduleTimezone = body.scheduleTimezone;
    }
    if (body.allowedAgentIds !== undefined) {
      data.allowedAgentIds = body.allowedAgentIds;
    }
    if (body.payloadSchema !== undefined) {
      data.payloadSchema = body.payloadSchema;
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

    const updated = await this.jobs.update(existing.id, data);
    return { job: this.toJob(updated), syntaxError };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const requestedScope = this.getScope(req);
    requireOperator(requestedScope);
    const scope = await this.canonicalOperatorScope(requestedScope, "secret:mutate");
    if (!(await this.jobs.deleteInScope(scope, id))) {
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
    const requestedScope = this.getScope(req);
    requireOperator(requestedScope);
    const scope = await this.canonicalOperatorScope(requestedScope, "secret:mutate");
    const job = await this.jobs.findDispatchable(scope, id);
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

  /**
   * The wire shape. Takes a `JobRecord`, never a database row — this is the
   * only layer entitled to decide what a client sees, and it can no longer be
   * handed a row carrying columns nobody chose to publish.
   */
  private toJob(job: JobRecord) {
    return {
      id: job.id,
      jobId: job.externalId ?? job.id,
      displayName: job.displayName,
      description: job.description,
      invocationType: job.invocationType,
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
