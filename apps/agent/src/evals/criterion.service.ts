import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface EvalCriterionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string | null;
  name: string;
  description: string | null;
  judgePrompt: string;
  rubric: string | null;
  judgeModel: string | null;
  scoreScaleMin: number;
  scoreScaleMax: number;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCriterionDto {
  agentId?: string | null;
  name: string;
  description?: string | null;
  judgePrompt: string;
  rubric?: string | null;
  judgeModel?: string | null;
  scoreScaleMin?: number;
  scoreScaleMax?: number;
}

export interface UpdateCriterionDto {
  name?: string;
  description?: string | null;
  judgePrompt?: string;
  rubric?: string | null;
  judgeModel?: string | null;
  scoreScaleMin?: number;
  scoreScaleMax?: number;
  isActive?: boolean;
  agentId?: string | null;
}

/**
 * Theme J.3 — eval criterion CRUD.
 *
 * Criteria are scoped to (org, project, env) and optionally to a specific
 * agentId. A null agentId = shared across every agent in the env.
 *
 * Changes write a new `updatedAt`; historic `PlatosAgentEval` rows freeze
 * their `criterionSnapshot` at scoring time so edits don't retroactively
 * shift scores (Theme J.4 wire-up).
 */
@Injectable()
export class CriterionService {
  private prisma: any;

  constructor(@Inject(PRISMA_TOKEN) prisma: any) {
    this.prisma = prisma;
  }

  async create(
    scope: RequestScope,
    input: CreateCriterionDto,
  ): Promise<EvalCriterionRecord> {
    if (!input.name?.trim()) throw new Error("name required");
    if (!input.judgePrompt?.trim()) throw new Error("judgePrompt required");

    const row = await this.prisma.platosEvalCriterion.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: input.agentId ?? null,
        name: input.name.trim(),
        description: input.description ?? null,
        judgePrompt: input.judgePrompt,
        rubric: input.rubric ?? null,
        judgeModel: input.judgeModel ?? null,
        scoreScaleMin: input.scoreScaleMin ?? 0,
        scoreScaleMax: input.scoreScaleMax ?? 100,
        isActive: true,
        createdBy: scope.userId,
      },
    });
    return this.toRecord(row);
  }

  async list(
    scope: ScopeTuple,
    options: { agentId?: string | null; activeOnly?: boolean } = {},
  ): Promise<EvalCriterionRecord[]> {
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (options.activeOnly) where.isActive = true;
    if (options.agentId !== undefined) {
      // null matches shared criteria; a concrete agentId matches agent-specific
      // PLUS shared criteria (the "applies to this agent" view).
      if (options.agentId === null) {
        where.agentId = null;
      } else {
        where.OR = [{ agentId: options.agentId }, { agentId: null }];
      }
    }
    const rows = await this.prisma.platosEvalCriterion.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    });
    return (rows as any[]).map((r) => this.toRecord(r));
  }

  async findById(
    scope: ScopeTuple,
    id: string,
  ): Promise<EvalCriterionRecord | null> {
    const row = await this.prisma.platosEvalCriterion.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return row ? this.toRecord(row) : null;
  }

  async update(
    scope: RequestScope,
    id: string,
    input: UpdateCriterionDto,
  ): Promise<EvalCriterionRecord> {
    const existing = await this.findById(scope, id);
    if (!existing) throw new Error("Criterion not found");

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description;
    if (input.judgePrompt !== undefined) data.judgePrompt = input.judgePrompt;
    if (input.rubric !== undefined) data.rubric = input.rubric;
    if (input.judgeModel !== undefined) data.judgeModel = input.judgeModel;
    if (input.scoreScaleMin !== undefined) data.scoreScaleMin = input.scoreScaleMin;
    if (input.scoreScaleMax !== undefined) data.scoreScaleMax = input.scoreScaleMax;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.agentId !== undefined) data.agentId = input.agentId;

    const row = await this.prisma.platosEvalCriterion.update({
      where: { id },
      data,
    });
    return this.toRecord(row);
  }

  async remove(scope: ScopeTuple, id: string): Promise<boolean> {
    const result = await this.prisma.platosEvalCriterion.deleteMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return result.count > 0;
  }

  private toRecord(r: any): EvalCriterionRecord {
    return {
      id: r.id,
      organizationId: r.organizationId,
      projectId: r.projectId,
      environmentId: r.environmentId,
      agentId: r.agentId ?? null,
      name: r.name,
      description: r.description ?? null,
      judgePrompt: r.judgePrompt,
      rubric: r.rubric ?? null,
      judgeModel: r.judgeModel ?? null,
      scoreScaleMin: r.scoreScaleMin,
      scoreScaleMax: r.scoreScaleMax,
      isActive: r.isActive,
      createdBy: r.createdBy,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    };
  }
}
