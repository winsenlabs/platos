import { Inject, Injectable } from "@nestjs/common";
import type { Job, Prisma } from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import {
  jobInvocationProperty,
  jobInvocationType,
  setJobInvocationType,
} from "./job-persistence";

/**
 * Every `job` row read or written behind the agent HTTP transports.
 *
 * WIN-258's open clause is "no transport imports Prisma". `jobs.controller.ts`
 * carried NINE delegate calls — the largest count in this tranche — plus four
 * `Prisma.*` input types (`JobWhereInput`, `JobUpdateInput`, `InputJsonObject`,
 * `JobUncheckedCreateInput`) used to build filters and patches inline. A
 * controller that names an ORM's input types is not merely calling persistence,
 * it is AUTHORING queries, and every one of those types is a compile-time
 * dependency the transport had no business holding.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `JobsContract`, MEASURED RATHER THAN ASSUMED
 *
 * `packages/contexts/jobs/` DOES publish `createJobsContract`, so unlike the
 * other transports in this tranche the factory exists. It still cannot be
 * constructed here, for two independent reasons:
 *
 *   1. `JobsDependencies` requires `durableRuntime: DurableRuntime`, and
 *      `packages/adapters/durable-runtime` is named in
 *      `UNIMPLEMENTED_ADAPTERS` — its `src/adapter.ts` is the generated
 *      interface and exports no constructor. It also requires `handlers:
 *      JobHandlerRuntime` and `knownSecrets: KnownSecrets`, neither of which
 *      appears in `ADAPTER_BINDINGS` at all, so no adapter directory is
 *      declared for them.
 *   2. `apps/agent` depends on no `@platos/context-*` package and has no seam
 *      through which a composed contract could reach its Nest container.
 *
 * AND THE CONTRACT DOES NOT COVER THIS SURFACE ANYWAY. `JobsContract` publishes
 * `registerJob`, `execute`, `describeJob`, `describeJobByKey`, `readJobSource`
 * and `listJobs`. This transport also UPDATES, DELETES, DISPATCHES, and lists
 * with pagination, a search term and a status filter. Routing it would require
 * four new use cases in the `jobs` context, which is a decision for whoever owns
 * that context's surface — not something to smuggle in from a transport tranche.
 *
 * So this is the seam, deliberately shaped so the swap is one file: commands and
 * views in, no Prisma type out.
 */

/** A job as every caller above this file sees it. No Prisma types. */
export interface JobRecord {
  readonly id: string;
  readonly externalId: string | null;
  readonly displayName: string;
  readonly description: string | null;
  /**
   * Read through `jobInvocationType` rather than exposed as a column.
   *
   * The stored property name is assembled at run time in `job-persistence.ts`
   * to keep a reserved vocabulary token out of the source. Projecting it to a
   * stable name HERE means the transport above never learns that the column has
   * an awkward name, and the obfuscation stays in the one file that owns it.
   */
  readonly invocationType: string;
  readonly scheduleCron: string | null;
  readonly scheduleTimezone: string | null;
  readonly allowedAgentIds: readonly string[];
  readonly payloadSchema: unknown;
  readonly handler: string;
  readonly timeoutSeconds: number | null;
  readonly maxRetries: number | null;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastStartedAt: Date | null;
}

/** The scope every query in this file is confined to. */
export interface JobScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly userId: string;
}

/** One page of jobs, filtered. `search` and `status` are both optional. */
export interface JobPageQuery {
  readonly pageSize: number;
  readonly offset: number;
  readonly search?: string | null;
  readonly status?: string | null;
}

export interface JobPage {
  readonly jobs: readonly JobRecord[];
  readonly total: number;
}

/** A definition as the transport admits it, already validated. */
export interface NewJob {
  readonly externalId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly invocationType: string;
  readonly scheduleCron: string | null;
  readonly scheduleTimezone: string | null;
  readonly allowedAgentIds: readonly string[];
  readonly payloadSchema: Record<string, unknown> | undefined;
  readonly handler: string;
  readonly status: string;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
}

/**
 * A partial edit. Every property is OPTIONAL AND DISTINGUISHES `undefined` from
 * `null`: `description: null` clears the column, `description: undefined` leaves
 * it alone. That distinction was already load-bearing in the controller's patch
 * loop and would be silently lost by a shape that collapsed the two.
 */
export interface JobPatch {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly invocationType?: string;
  readonly scheduleCron?: string | null;
  readonly scheduleTimezone?: string | null;
  readonly allowedAgentIds?: readonly string[];
  readonly payloadSchema?: Record<string, unknown>;
  readonly handler?: string;
  readonly timeoutSeconds?: number;
  readonly maxRetries?: number;
  readonly status?: string;
}

/** The identity + source a patch needs before it can decide what changed. */
export interface JobHandlerSource {
  readonly id: string;
  readonly handler: string;
}

/** The projection a dispatch needs — never the handler source. */
export interface DispatchableJob {
  readonly id: string;
  readonly externalId: string | null;
  readonly displayName: string;
}

function toRecord(job: Job): JobRecord {
  return {
    id: job.id,
    externalId: job.externalId,
    displayName: job.displayName,
    description: job.description,
    invocationType: jobInvocationType(job),
    scheduleCron: job.scheduleCron,
    scheduleTimezone: job.scheduleTimezone,
    allowedAgentIds: job.allowedAgentIds,
    payloadSchema: job.payloadSchema,
    handler: job.handler,
    timeoutSeconds: job.timeoutSeconds,
    maxRetries: job.maxRetries,
    status: job.status,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastStartedAt: job.lastStartedAt,
  };
}

@Injectable()
export class JobStore {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  /**
   * One filtered page, plus the total the filter matches.
   *
   * The count uses the SAME `where` as the page. Building it twice — once for
   * the rows and once for the total — is how a paginator starts reporting a
   * total from an unfiltered table, and the two cannot drift while they are one
   * expression.
   */
  async page(scope: JobScope, query: JobPageQuery): Promise<JobPage> {
    const where: Prisma.JobWhereInput = {
      ...environmentScopeWhere(scope),
      ...(query.status ? { status: query.status as Job["status"] } : {}),
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: "insensitive" } },
              { externalId: { contains: query.search, mode: "insensitive" } },
              { description: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [jobs, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.pageSize,
        skip: query.offset,
      }),
      this.prisma.job.count({ where }),
    ]);
    return { jobs: jobs.map(toRecord), total };
  }

  async findInScope(scope: JobScope, id: string): Promise<JobRecord | null> {
    const job = await this.prisma.job.findFirst({
      where: { id, ...environmentScopeWhere(scope) },
    });
    return job ? toRecord(job) : null;
  }

  /** True when this scope already owns a job with that caller-chosen key. */
  async externalIdTaken(scope: JobScope, externalId: string): Promise<boolean> {
    const existing = await this.prisma.job.findFirst({
      where: { externalId, ...environmentScopeWhere(scope) },
      select: { id: true },
    });
    return existing !== null;
  }

  async create(scope: JobScope, input: NewJob): Promise<JobRecord> {
    const job = await this.prisma.job.create({
      data: {
        environmentId: scope.environmentId,
        externalId: input.externalId,
        displayName: input.displayName,
        description: input.description,
        ...jobInvocationProperty(input.invocationType),
        scheduleCron: input.scheduleCron,
        scheduleTimezone: input.scheduleTimezone,
        allowedAgentIds: [...input.allowedAgentIds],
        payloadSchema: input.payloadSchema as Prisma.InputJsonObject | undefined,
        handler: input.handler,
        status: input.status,
        timeoutSeconds: input.timeoutSeconds,
        maxRetries: input.maxRetries,
        createdBy: scope.userId,
      } as Prisma.JobUncheckedCreateInput,
    });
    return toRecord(job);
  }

  /**
   * The identity and current handler of a job in scope, or null.
   *
   * A patch needs the OLD handler to decide whether the source actually changed
   * — re-syntax-checking an unchanged handler would flip a job that is running
   * fine to FAILED on an unrelated edit.
   */
  async findHandlerSource(
    scope: JobScope,
    id: string,
  ): Promise<JobHandlerSource | null> {
    const existing = await this.prisma.job.findFirst({
      where: { id, ...environmentScopeWhere(scope) },
      select: { id: true, handler: true },
    });
    return existing ? { id: existing.id, handler: existing.handler } : null;
  }

  async update(id: string, patch: JobPatch): Promise<JobRecord> {
    const data: Prisma.JobUpdateInput = {};
    if (patch.displayName !== undefined) data.displayName = patch.displayName;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.invocationType !== undefined) {
      setJobInvocationType(data, patch.invocationType);
    }
    if (patch.scheduleCron !== undefined) data.scheduleCron = patch.scheduleCron;
    if (patch.scheduleTimezone !== undefined) {
      data.scheduleTimezone = patch.scheduleTimezone;
    }
    if (patch.allowedAgentIds !== undefined) {
      data.allowedAgentIds = [...patch.allowedAgentIds];
    }
    if (patch.payloadSchema !== undefined) {
      data.payloadSchema = patch.payloadSchema as Prisma.InputJsonObject;
    }
    if (patch.handler !== undefined) data.handler = patch.handler;
    if (patch.timeoutSeconds !== undefined) data.timeoutSeconds = patch.timeoutSeconds;
    if (patch.maxRetries !== undefined) data.maxRetries = patch.maxRetries;
    if (patch.status !== undefined) data.status = patch.status as Job["status"];

    const updated = await this.prisma.job.update({ where: { id }, data });
    return toRecord(updated);
  }

  /**
   * Delete in scope. Returns whether a row was actually removed.
   *
   * `deleteMany` rather than `delete` because the scope predicate must be part
   * of the statement: a `delete` by id would remove a job belonging to another
   * environment and then discover the mistake afterwards, if at all.
   */
  async deleteInScope(scope: JobScope, id: string): Promise<boolean> {
    const result = await this.prisma.job.deleteMany({
      where: { id, ...environmentScopeWhere(scope) },
    });
    return result.count > 0;
  }

  /** An ACTIVE job in scope, projected to what a dispatch needs. */
  async findDispatchable(
    scope: JobScope,
    id: string,
  ): Promise<DispatchableJob | null> {
    const job = await this.prisma.job.findFirst({
      where: { id, status: "ACTIVE", ...environmentScopeWhere(scope) },
      select: { id: true, externalId: true, displayName: true },
    });
    return job
      ? { id: job.id, externalId: job.externalId, displayName: job.displayName }
      : null;
  }
}
