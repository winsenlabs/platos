import { Injectable, Inject } from "@nestjs/common";
import * as crypto from "node:crypto";
import type { GoldenSet, Prisma } from "@platos/database";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
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
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    private readonly evalService: EvalService,
  ) {}

  async create(scope: RequestScope, input: CreateGoldenSetDto): Promise<GoldenSetRecord> {
    if (!input.name?.trim()) throw new Error("name required");
    if (!input.agentId) throw new Error("agentId required");
    if (!Array.isArray(input.threadIds) || input.threadIds.length === 0) {
      throw new Error("threadIds must be a non-empty array");
    }
    if (!Array.isArray(input.criterionIds) || input.criterionIds.length === 0) {
      throw new Error("criterionIds must be a non-empty array");
    }

    const row = await this.prisma.goldenSet.create({
      data: {
        environmentId: scope.environmentId,
        agentId: input.agentId,
        name: input.name.trim(),
        description: input.description ?? null,
        threadIds: input.threadIds,
        criterionIds: input.criterionIds,
        createdBy: scope.userId,
      },
    });
    return this.toRecord(scope, row);
  }

  async list(
    scope: ScopeTuple,
    options: { agentId?: string } = {},
  ): Promise<GoldenSetRecord[]> {
    const where: Record<string, unknown> = {
      ...environmentScopeWhere(scope),
    };
    if (options.agentId) where.agentId = options.agentId;
    const rows = await this.prisma.goldenSet.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => this.toRecord(scope, row));
  }

  async findById(scope: ScopeTuple, id: string): Promise<GoldenSetRecord | null> {
    const row = await this.prisma.goldenSet.findFirst({
      where: {
        id,
        ...environmentScopeWhere(scope),
      },
    });
    return row ? this.toRecord(scope, row) : null;
  }

  async update(
    scope: ScopeTuple,
    id: string,
    input: UpdateGoldenSetDto,
  ): Promise<GoldenSetRecord> {
    const existing = await this.findById(scope, id);
    if (!existing) throw new Error("Golden set not found");
    const data: Prisma.GoldenSetUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description;
    if (input.threadIds !== undefined) data.threadIds = input.threadIds;
    if (input.criterionIds !== undefined) data.criterionIds = input.criterionIds;
    const row = await this.prisma.goldenSet.update({
      where: { id },
      data,
    });
    return this.toRecord(scope, row);
  }

  async remove(scope: ScopeTuple, id: string): Promise<boolean> {
    const result = await this.prisma.goldenSet.deleteMany({
      where: {
        id,
        ...environmentScopeWhere(scope),
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
    const evalIds: string[] = [];
    for (const threadId of gs.threadIds) {
      for (const criterionId of gs.criterionIds) {
        try {
          const result = await this.evalService.runJudge(scope, {
            agentId: gs.agentId,
            threadId,
            criterionId,
          });
          evalIds.push(result.id);
          completed += 1;
        } catch {
          failed += 1;
        }
      }
    }

    const finishedAt = new Date().toISOString();

    const regression = await this.computeRegression(scope, {
      runId,
      evalIds,
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
    input: {
      runId: string;
      evalIds: string[];
      agentId: string;
      baselineVersionId: string | null;
    },
  ): Promise<GoldenSetRunResult["regression"]> {
    const runRows: Array<{
      criterionId: string;
      score: number;
      criterion: { name: string } | null;
    }> = await this.prisma.agentEval.findMany({
      where: {
        ...environmentScopeWhere(scope),
        id: { in: input.evalIds },
        agentId: input.agentId,
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
        await this.prisma.agentEval.findMany({
          where: {
            ...environmentScopeWhere(scope),
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

  private toRecord(scope: ScopeTuple, r: GoldenSet): GoldenSetRecord {
    return {
      id: r.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
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
