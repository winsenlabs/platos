import { Injectable, Inject } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { EvalService } from "./eval.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface GoldenSetRecord {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  name: string;
  description: string | null;
  threadIds: string[];
  criterionIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGoldenSetDto {
  agentId: string;
  name: string;
  description?: string | null;
  threadIds: string[];
  criterionIds: string[];
}

export interface UpdateGoldenSetDto {
  name?: string;
  description?: string | null;
  threadIds?: string[];
  criterionIds?: string[];
}

export interface GoldenSetRunResult {
  runId: string;
  goldenSetId: string;
  pairCount: number; // threadIds * criterionIds
  completed: number;
  failed: number;
  baselineVersionId: string | null;
  regression: {
    regressed: boolean;
    perCriterion: Array<{
      criterionId: string;
      criterionName: string;
      baselineMean: number | null;
      candidateMean: number;
      delta: number;
      verdict: "regressed" | "neutral" | "improved" | "no-baseline";
    }>;
  };
  startedAt: string;
  finishedAt: string;
}

/**
 * Theme J.8 — golden-set + regression runner.
 *
 * A golden set pins a stable collection of (threadIds, criterionIds) so a
 * new agent version can be judged against the same conversations every
 * time. `run` fans out through the EvalService judge pipeline, stamps a
 * shared `runId` on every eval row, then compares the candidate version's
 * mean score per criterion against the baseline version.
 *
 * Regression verdict per criterion:
 *   - `no-baseline` — baseline version had no samples in this run window
 *   - `regressed`   — candidate mean is >= 5 points below baseline
 *   - `improved`    — candidate mean is >= 5 points above baseline
 *   - `neutral`     — otherwise
 *
 * Scope stamped on write; every read filters by the full tuple.
 */
@Injectable()
export class GoldenSetService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly evalService: EvalService,
  ) {
    this.prisma = prisma;
  }

  async create(scope: RequestScope, input: CreateGoldenSetDto): Promise<GoldenSetRecord> {
    if (!input.name?.trim()) throw new Error("name required");
    if (!input.agentId) throw new Error("agentId required");
    if (!Array.isArray(input.threadIds) || input.threadIds.length === 0) {
      throw new Error("threadIds must be a non-empty array");
    }
    if (!Array.isArray(input.criterionIds) || input.criterionIds.length === 0) {
      throw new Error("criterionIds must be a non-empty array");
    }

    const row = await this.prisma.platosGoldenSet.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: input.agentId,
        name: input.name.trim(),
        description: input.description ?? null,
        threadIds: input.threadIds,
        criterionIds: input.criterionIds,
        createdBy: scope.userId,
      },
    });
    return this.toRecord(row);
  }

  async list(
    scope: ScopeTuple,
    options: { agentId?: string } = {},
  ): Promise<GoldenSetRecord[]> {
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (options.agentId) where.agentId = options.agentId;
    const rows = await this.prisma.platosGoldenSet.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });
    return (rows as any[]).map((r) => this.toRecord(r));
  }

  async findById(scope: ScopeTuple, id: string): Promise<GoldenSetRecord | null> {
    const row = await this.prisma.platosGoldenSet.findFirst({
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
    scope: ScopeTuple,
    id: string,
    input: UpdateGoldenSetDto,
  ): Promise<GoldenSetRecord> {
    const existing = await this.findById(scope, id);
    if (!existing) throw new Error("Golden set not found");
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description;
    if (input.threadIds !== undefined) data.threadIds = input.threadIds;
    if (input.criterionIds !== undefined) data.criterionIds = input.criterionIds;
    const row = await this.prisma.platosGoldenSet.update({
      where: { id },
      data,
    });
    return this.toRecord(row);
  }

  async remove(scope: ScopeTuple, id: string): Promise<boolean> {
    const result = await this.prisma.platosGoldenSet.deleteMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return result.count > 0;
  }

  /**
   * Execute every (threadId × criterionId) pair and stamp each resulting
   * PlatosAgentEval row with a shared `runId`. Returns a regression report
   * comparing per-criterion mean scores against the baseline version.
   */
  async run(
    scope: RequestScope,
    id: string,
    options: { baselineVersionId?: string | null } = {},
  ): Promise<GoldenSetRunResult> {
    const gs = await this.findById(scope, id);
    if (!gs) throw new Error("Golden set not found");

    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const startedAt = new Date().toISOString();

    let completed = 0;
    let failed = 0;
    for (const threadId of gs.threadIds) {
      for (const criterionId of gs.criterionIds) {
        try {
          await this.evalService.runJudge(scope, {
            agentId: gs.agentId,
            threadId,
            criterionId,
            runId,
            baselineVersionId: options.baselineVersionId ?? undefined,
          });
          completed += 1;
        } catch {
          failed += 1;
        }
      }
    }

    const finishedAt = new Date().toISOString();

    const regression = await this.computeRegression(scope, {
      runId,
      agentId: gs.agentId,
      baselineVersionId: options.baselineVersionId ?? null,
    });

    return {
      runId,
      goldenSetId: gs.id,
      pairCount: gs.threadIds.length * gs.criterionIds.length,
      completed,
      failed,
      baselineVersionId: options.baselineVersionId ?? null,
      regression,
      startedAt,
      finishedAt,
    };
  }

  /**
   * Compare the candidate (this runId) mean scores against the baseline
   * version's mean scores for the same criteria, over the same 30-day window.
   */
  private async computeRegression(
    scope: RequestScope,
    input: { runId: string; agentId: string; baselineVersionId: string | null },
  ): Promise<GoldenSetRunResult["regression"]> {
    const runRows: Array<{
      criterionId: string;
      score: number;
      criterion: { name: string } | null;
    }> = await this.prisma.platosAgentEval.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        agentId: input.agentId,
        runId: input.runId,
      },
      select: {
        criterionId: true,
        score: true,
        criterion: { select: { name: true } },
      },
    });

    interface Agg {
      criterionName: string;
      scores: number[];
    }
    const candidateByCriterion = new Map<string, Agg>();
    for (const r of runRows) {
      const bucket =
        candidateByCriterion.get(r.criterionId) ?? {
          criterionName: r.criterion?.name ?? "(criterion removed)",
          scores: [],
        };
      bucket.scores.push(r.score);
      candidateByCriterion.set(r.criterionId, bucket);
    }

    let baselineByCriterion = new Map<string, number[]>();
    if (input.baselineVersionId) {
      const baselineRows: Array<{ criterionId: string; score: number }> =
        await this.prisma.platosAgentEval.findMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            agentId: input.agentId,
            agentVersionId: input.baselineVersionId,
            createdAt: { gte: new Date(Date.now() - 30 * 86400_000) },
          },
          select: { criterionId: true, score: true },
        });
      baselineByCriterion = new Map();
      for (const r of baselineRows) {
        const arr = baselineByCriterion.get(r.criterionId) ?? [];
        arr.push(r.score);
        baselineByCriterion.set(r.criterionId, arr);
      }
    }

    const REGRESSION_THRESHOLD = 5;
    let anyRegressed = false;
    const perCriterion = Array.from(candidateByCriterion.entries()).map(
      ([criterionId, bucket]) => {
        const candidateMean =
          bucket.scores.reduce((a, s) => a + s, 0) / bucket.scores.length;
        const baselineScores = baselineByCriterion.get(criterionId) ?? [];
        const baselineMean =
          baselineScores.length === 0
            ? null
            : baselineScores.reduce((a, s) => a + s, 0) / baselineScores.length;

        let verdict: "regressed" | "neutral" | "improved" | "no-baseline";
        let delta = 0;
        if (baselineMean === null) {
          verdict = "no-baseline";
        } else {
          delta = candidateMean - baselineMean;
          if (delta <= -REGRESSION_THRESHOLD) {
            verdict = "regressed";
            anyRegressed = true;
          } else if (delta >= REGRESSION_THRESHOLD) {
            verdict = "improved";
          } else {
            verdict = "neutral";
          }
        }
        return {
          criterionId,
          criterionName: bucket.criterionName,
          baselineMean: baselineMean === null ? null : Math.round(baselineMean * 100) / 100,
          candidateMean: Math.round(candidateMean * 100) / 100,
          delta: Math.round(delta * 100) / 100,
          verdict,
        };
      },
    );

    return { regressed: anyRegressed, perCriterion };
  }

  private toRecord(r: any): GoldenSetRecord {
    return {
      id: r.id,
      organizationId: r.organizationId,
      projectId: r.projectId,
      environmentId: r.environmentId,
      agentId: r.agentId,
      name: r.name,
      description: r.description ?? null,
      threadIds: r.threadIds ?? [],
      criterionIds: r.criterionIds ?? [],
      createdBy: r.createdBy,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    };
  }
}
