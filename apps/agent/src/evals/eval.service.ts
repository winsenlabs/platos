import { Injectable, Inject, Logger } from "@nestjs/common";
import { generateText } from "ai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ScopedEnvService } from "../providers/scoped-env.service";
import type { RequestScope } from "../auth/scope.guard";
import type { EvalCriterionRecord } from "./criterion.service";
import { CriterionService } from "./criterion.service";
import { CostService } from "../monitoring/cost.service";
import { preflightModelPricing } from "../monitoring/model-pricing-preflight";
import { isUuid } from "../shared/pagination";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface AgentEvalRecord {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  agentVersionId: string | null;
  threadId: string;
  messageId: string | null;
  criterionId: string;
  criterionSnapshot: Record<string, unknown>;
  judgeModel: string;
  judgePromptUsed: string;
  rawResponse: string | null;
  score: number;
  rationale: string | null;
  passed: boolean;
  runId: string | null;
  baselineVersionId: string | null;
  costCents: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface EvalListFilters {
  agentId?: string;
  agentVersionId?: string;
  criterionId?: string;
  threadId?: string;
  runId?: string;
  sinceDays?: number;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface JudgeRunInput {
  agentId: string;
  threadId: string;
  criterionId: string;
  /** Optional — sample a single message rather than the whole thread. */
  messageId?: string;
  /** Optional — group this eval with others into a regression run. */
  runId?: string;
  /** Optional — label the version we're comparing against in the UI. */
  baselineVersionId?: string;
}

/**
 * Judge-LLM self-evaluation guard.
 *
 * Theme J invariant §5 — the judge model MUST NOT be the same model that
 * produced the conversation being scored. If a criterion's `judgeModel` is
 * unset we fall back to Haiku; if it IS set and it matches the agent's model,
 * we throw. Callers should catch and surface as a validation error.
 */
export class SelfEvaluationError extends Error {
  constructor(judgeModel: string, agentModel: string) {
    super(
      `Self-evaluation blocked: judge model "${judgeModel}" is the same as the conversation's agent model "${agentModel}". Pick a different judge.`,
    );
    this.name = "SelfEvaluationError";
  }
}

export const DEFAULT_JUDGE_MODEL = "anthropic:claude-haiku-4-5-20251001";

function resolveJudgeModel(modelString: string, apiKey?: string) {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  const model = colonIdx > 0 ? modelString.slice(colonIdx + 1) : modelString;
  switch (provider) {
    case "anthropic":
      return apiKey ? createAnthropic({ apiKey })(model) : anthropic(model);
    case "openai":
      return apiKey ? createOpenAI({ apiKey })(model) : openai(model);
    case "google":
      return apiKey ? createGoogleGenerativeAI({ apiKey })(model) : google(model);
    default:
      throw new Error(`Unsupported judge provider "${provider}"`);
  }
}

function apiKeyEnvVarForJudge(modelString: string): string | undefined {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    default:
      return undefined;
  }
}

/**
 * Parse the judge's raw text output into { score, rationale, passed }.
 *
 * Expected shape is a JSON block the judge emits:
 *   { "score": 73, "rationale": "…", "passed": true }
 *
 * Accepts either a fenced code block or a raw JSON object anywhere in the
 * response. Falls back to a 0 score with the full raw text as rationale if
 * parsing fails — the pipeline never throws; the UI can surface the raw
 * response for debugging.
 */
function parseJudgeResponse(
  raw: string,
  criterion: EvalCriterionRecord,
): { score: number; rationale: string | null; passed: boolean } {
  const scoreMin = criterion.scoreScaleMin ?? 0;
  const scoreMax = criterion.scoreScaleMax ?? 100;
  const normalize = (s: number) => {
    const clamped = Math.max(scoreMin, Math.min(scoreMax, s));
    const range = scoreMax - scoreMin;
    if (range <= 0) return 0;
    return ((clamped - scoreMin) / range) * 100;
  };

  const tryParse = (text: string): unknown | null => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  // Strip markdown code fence if present.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  let parsed: any = fenceMatch ? tryParse(fenceMatch[1]) : null;
  if (!parsed) {
    // Try to locate the first {...} block.
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) parsed = tryParse(objMatch[0]);
  }
  if (!parsed) parsed = tryParse(raw);

  if (!parsed || typeof parsed !== "object") {
    return { score: 0, rationale: raw.slice(0, 2000), passed: false };
  }

  const rawScore = Number(parsed.score ?? parsed.rating ?? 0);
  const normalized = Number.isFinite(rawScore) ? normalize(rawScore) : 0;
  const rationale =
    typeof parsed.rationale === "string"
      ? parsed.rationale
      : typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : typeof parsed.explanation === "string"
          ? parsed.explanation
          : null;
  const passed =
    typeof parsed.passed === "boolean" ? parsed.passed : normalized >= 50;

  return { score: normalized, rationale, passed };
}

/**
 * Theme J.4 + J.5 — judge-LLM pipeline + eval persistence.
 *
 * `runJudge` is the core entry point — given (agentId, threadId, criterionId),
 * it loads the conversation transcript, resolves the criterion's judge model
 * (or falls back to Haiku), verifies the no-self-evaluation invariant, asks
 * the judge to score, and writes an `AgentEval` row.
 *
 * `list` / `getById` / `aggregate` cover the query API (J.5) and dashboard
 * rollups (J.6 / J.7).
 */
@Injectable()
export class EvalService {
  private readonly logger = new Logger(EvalService.name);

  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly scopedEnv: ScopedEnvService,
    private readonly criterionService: CriterionService,
    // EOBD.34 — inject optional CostService so judge-LLM cost flows
    // into the central cost table, not just AgentEval.costCents.
    private readonly costService: CostService,
  ) {
    this.prisma = prisma;
  }

  async runJudge(
    scope: RequestScope,
    input: JudgeRunInput,
    /** PRELAUNCH-A2-10 — abort signal for the eval-judge LLM call. */
    abortSignal?: AbortSignal,
  ): Promise<AgentEvalRecord> {
    // Resolve criterion (scope-gated).
    const criterion = await this.criterionService.findById(scope, input.criterionId);
    if (!criterion) throw new Error("Criterion not found");
    if (!criterion.isActive) throw new Error("Criterion is not active");

    // Resolve thread + agent to cross-check scope AND derive the agent's
    // model for self-evaluation guarding.
    const thread = await this.prisma.thread.findFirst({
      where: {
        id: input.threadId,
        environmentId: scope.environmentId,
        environment: {
          project: {
            id: scope.projectId,
            organizationId: scope.organizationId,
          },
        },
      },
      select: {
        id: true,
        agentId: true,
        agent: {
          select: {
            bindings: {
              where: { environmentId: scope.environmentId },
              take: 1,
              select: {
                activeAgentVersionId: true,
                activeAgentVersion: { select: { model: true } },
              },
            },
          },
        },
      },
    });
    if (!thread) throw new Error("Thread not found");
    if (thread.agentId !== input.agentId) {
      throw new Error("Thread does not belong to the specified agent");
    }

    const binding = thread.agent.bindings[0];
    if (!binding) throw new Error("Agent is not bound to this environment");

    const agent = await this.prisma.agent.findFirst({
      where: {
        id: input.agentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
        bindings: { some: { environmentId: scope.environmentId } },
      },
      select: { id: true },
    });
    if (!agent) throw new Error("Agent not found");

    if (input.runId || input.baselineVersionId) {
      // The clean AgentEval schema intentionally has no regression-run columns.
      // Failing loudly avoids claiming that a run was grouped when its identity
      // could not be persisted losslessly.
      throw new Error(
        "Eval run grouping is not supported by the clean AgentEval model",
      );
    }

    const judgeModelString = criterion.judgeModel || DEFAULT_JUDGE_MODEL;
    const judgePrice = await preflightModelPricing(this.costService, judgeModelString);

    // Theme J invariant §5 — no self-evaluation.
    const agentModel = binding.activeAgentVersion.model;
    if (judgeModelString === agentModel) {
      throw new SelfEvaluationError(judgeModelString, agentModel);
    }

    // A clean Turn is the complete user/assistant exchange. Do not recreate
    // legacy message rows or hide split semantics in JSON.
    const turnsWhere: Record<string, unknown> = {
      threadId: input.threadId,
      status: { not: "CANCELLED" },
    };
    if (input.messageId) turnsWhere.id = input.messageId;

    const turns: Array<{
      id: string;
      inputText: string | null;
      outputText: string | null;
      createdAt: Date;
    }> = await this.prisma.turn.findMany({
      where: turnsWhere,
      select: { id: true, inputText: true, outputText: true, createdAt: true },
      orderBy: { sequence: "asc" },
    });

    if (input.messageId && turns.length === 0) {
      throw new Error("Turn not found");
    }

    const transcript = turns
      .flatMap((turn) => [
        turn.inputText ? `USER: ${turn.inputText}` : null,
        turn.outputText ? `ASSISTANT: ${turn.outputText}` : null,
      ])
      .filter((line): line is string => line !== null)
      .join("\n\n");

    // Assemble judge prompt. `{conversation}` in judgePrompt is substituted.
    const judgePromptUsed = criterion.judgePrompt.includes("{conversation}")
      ? criterion.judgePrompt.replace("{conversation}", transcript)
      : `${criterion.judgePrompt}\n\n---\n\nConversation to score:\n\n${transcript}`;

    const rubricBlock = criterion.rubric
      ? `\n\nScoring rubric (${criterion.scoreScaleMin}..${criterion.scoreScaleMax}):\n${criterion.rubric}`
      : `\n\nScoring scale: ${criterion.scoreScaleMin}..${criterion.scoreScaleMax}.`;

    const systemPrompt =
      "You are a strict, impartial judge scoring an AI assistant's conversation against a single criterion. " +
      "Respond ONLY with a JSON object of the shape: " +
      '{"score": <number>, "rationale": "<one or two sentences>", "passed": <boolean>}. ' +
      "No prose outside the JSON.";

    const userPrompt = `Criterion: ${criterion.name}${
      criterion.description ? `\n\n${criterion.description}` : ""
    }${rubricBlock}\n\n${judgePromptUsed}`;

    // Resolve the judge model + API key via the scoped-env service.
    const envVar = apiKeyEnvVarForJudge(judgeModelString);
    const apiKey = envVar
      ? await this.scopedEnv.get(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          envVar,
        )
      : undefined;

    let rawText = "";
    let judgeError: string | null = null;
    let usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
    } = {};
    const started = Date.now();
    try {
      const judgeModel = resolveJudgeModel(judgeModelString, apiKey);
      // PRELAUNCH-A2-10 — propagate abort signal.
      const result = await generateText({
        model: judgeModel,
        instructions: systemPrompt,
        messages: [{ role: "user" as const, content: userPrompt }],
        abortSignal,
      });
      rawText = result.text;
      // PRELAUNCH-A2-1 — Vercel AI SDK v6 renamed `promptTokens` →
      // `inputTokens` and `completionTokens` → `outputTokens`. Reading the
      // v4 names returns undefined on v6, which made `costCents` null
      // unconditionally — silently zeroing out judge spend on the
      // governance dashboard since the v6 migration.
      // PRELAUNCH-A1-7 (follow-up 2026-05-04) — extract cache + reasoning
      // tokens from the judge result with provider fallbacks. Eval judges
      // typically run on Sonnet, so cache_read attribution is real money.
      const resultUsage = (result as any).usage;
      const meta = (result as any).providerMetadata;
      const cacheRead =
        Number(resultUsage?.inputTokenDetails?.cacheReadTokens ?? 0) ||
        Number(meta?.anthropic?.cacheReadInputTokens ?? 0) ||
        Number(meta?.openai?.cachedPromptTokens ?? 0) ||
        Number(meta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
        Number(meta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
      const cacheCreation =
        Number(resultUsage?.inputTokenDetails?.cacheWriteTokens ?? 0) ||
        Number(meta?.anthropic?.cacheCreationInputTokens ?? 0) ||
        Number(meta?.vertex?.cacheCreationInputTokens ?? 0);
      const reasoning =
        Number(resultUsage?.outputTokenDetails?.reasoningTokens ?? 0) ||
        Number(meta?.openai?.reasoningTokens ?? 0) ||
        Number(meta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
        Number(meta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
      usage = {
        inputTokens: resultUsage?.inputTokens,
        outputTokens: resultUsage?.outputTokens,
        cacheReadInputTokens: cacheRead > 0 ? cacheRead : undefined,
        cacheCreationInputTokens: cacheCreation > 0 ? cacheCreation : undefined,
        reasoningTokens: reasoning > 0 ? reasoning : undefined,
      };
    } catch (err: any) {
      judgeError = err?.message || "Judge call failed";
      rawText = `[judge-error] ${judgeError}`;
    }
    const latencyMs = Date.now() - started;

    const parsed = judgeError
      ? { score: 0, rationale: judgeError, passed: false }
      : parseJudgeResponse(rawText, criterion);

    let costCents: number | null = null;
    if ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0) {
        const pricedUsage = this.costService.priceUsageFromSnapshot(
          judgeModelString,
          judgePrice,
          usage.inputTokens ?? 0,
          usage.outputTokens ?? 0,
          usage.cacheCreationInputTokens ?? 0,
          usage.cacheReadInputTokens ?? 0,
        );
        costCents = pricedUsage.costCents;
    }

    // EOBD.34 — bump central cost table too so dashboards don't
    // understate spend by the judge budget. Best-effort; never fails
    // the eval.
    if (costCents && costCents > 0) {
      try {
        await this.costService.recordAuxiliaryCost({
          scope,
          kind: "eval-judge",
          model: judgeModelString,
          costCents,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          // PRELAUNCH-A1-7 — fan out cache + reasoning fields so the
          // governance dashboard's cache-hit-rate / reasoning-spend slices
          // pick up eval-judge spend.
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          reasoningTokens: usage.reasoningTokens,
          agentId: input.agentId,
        });
      } catch (error: any) {
        // AgentEval below still persists the exact cost, so attribution is not
        // lost when the rebuildable Redis rollup is temporarily unavailable.
        this.logger.warn(`[eval] auxiliary cost recording failed: ${error?.message ?? error}`);
      }
    }

    const row = await this.prisma.agentEval.create({
      data: {
        environmentId: scope.environmentId,
        agentId: input.agentId,
        agentVersionId: binding.activeAgentVersionId,
        threadId: input.threadId,
        turnId: input.messageId ?? null,
        criterionId: criterion.id,
        criterionSnapshot: {
          name: criterion.name,
          description: criterion.description,
          judgePrompt: criterion.judgePrompt,
          rubric: criterion.rubric,
          judgeModel: criterion.judgeModel,
          scoreScaleMin: criterion.scoreScaleMin,
          scoreScaleMax: criterion.scoreScaleMax,
        } as any,
        judgeModel: judgeModelString,
        judgePromptUsed,
        rawResponse: rawText,
        score: parsed.score,
        rationale: parsed.rationale,
        passed: parsed.passed,
        costCents,
        latencyMs,
      },
    });

    return this.toRecord(row, scope);
  }

  async list(
    scope: ScopeTuple,
    filters: EvalListFilters = {},
  ): Promise<{ rows: AgentEvalRecord[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const sinceDays = filters.sinceDays ?? 30;

    if (filters.runId) {
      throw new Error("Eval run filtering is not supported by the clean AgentEval model");
    }

    const where: Record<string, unknown> = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
    };
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.agentVersionId) where.agentVersionId = filters.agentVersionId;
    if (filters.criterionId) where.criterionId = filters.criterionId;
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.search) {
      where.OR = [
        ...(isUuid(filters.search) ? [{ id: { equals: filters.search } }] : []),
        { rationale: { contains: filters.search, mode: "insensitive" } },
        { judgeModel: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.agentEval.count({ where }),
      this.prisma.agentEval.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        skip: offset,
      }),
    ]);

    return {
      rows: (rows as any[]).map((r) => this.toRecord(r, scope)),
      total,
      limit,
      offset,
    };
  }

  async getById(scope: ScopeTuple, id: string): Promise<AgentEvalRecord | null> {
    const row = await this.prisma.agentEval.findFirst({
      where: {
        id,
        environmentId: scope.environmentId,
        environment: {
          project: {
            id: scope.projectId,
            organizationId: scope.organizationId,
          },
        },
      },
    });
    return row ? this.toRecord(row, scope) : null;
  }

  /**
   * Theme J.6 / J.7 — aggregate eval scores per (criterion, agentVersion).
   * Groups rows inside the scope for a given agent over the last N days and
   * returns one row per (criterionId, agentVersionId) with a mean score.
   */
  async aggregate(
    scope: ScopeTuple,
    agentId: string,
    options: { days?: number; versionIds?: string[] } = {},
  ): Promise<{
    days: number;
    rows: Array<{
      criterionId: string;
      criterionName: string;
      agentVersionId: string | null;
      versionNumber: number | null;
      sampleCount: number;
      meanScore: number;
      passRate: number;
    }>;
  }> {
    const days = Math.max(1, Math.min(365, Math.floor(options.days ?? 30)));
    const since = new Date(Date.now() - days * 86400_000);

    const where: Record<string, unknown> = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
      agentId,
      createdAt: { gte: since },
    };
    if (options.versionIds && options.versionIds.length > 0) {
      where.agentVersionId = { in: options.versionIds };
    }

    const rows: Array<{
      criterionId: string;
      agentVersionId: string | null;
      score: number;
      passed: boolean;
      criterion?: { name: string } | null;
    }> = await this.prisma.agentEval.findMany({
      where,
      select: {
        criterionId: true,
        agentVersionId: true,
        score: true,
        passed: true,
        criterion: { select: { name: true } },
      },
    });

    const versions: Array<{ id: string; versionNumber: number }> =
      await this.prisma.agentVersion.findMany({
        where: { agentId },
        select: { id: true, versionNumber: true },
      });
    const versionNumberById = new Map(versions.map((v) => [v.id, v.versionNumber]));

    interface Bucket {
      criterionName: string;
      scores: number[];
      passes: number;
    }
    const byKey = new Map<string, Bucket>();
    for (const r of rows) {
      const key = `${r.criterionId}::${r.agentVersionId ?? "null"}`;
      const b = byKey.get(key) ?? {
        criterionName: r.criterion?.name ?? "(deleted criterion)",
        scores: [],
        passes: 0,
      };
      b.scores.push(r.score);
      if (r.passed) b.passes += 1;
      byKey.set(key, b);
    }

    const out = Array.from(byKey.entries()).map(([key, b]) => {
      const [criterionId, versionKey] = key.split("::");
      const agentVersionId = versionKey === "null" ? null : versionKey;
      const mean =
        b.scores.length === 0 ? 0 : b.scores.reduce((a, s) => a + s, 0) / b.scores.length;
      return {
        criterionId,
        criterionName: b.criterionName,
        agentVersionId,
        versionNumber: agentVersionId ? versionNumberById.get(agentVersionId) ?? null : null,
        sampleCount: b.scores.length,
        meanScore: Math.round(mean * 100) / 100,
        passRate: b.scores.length === 0 ? 0 : b.passes / b.scores.length,
      };
    });

    out.sort((a, b) => {
      if (a.criterionName !== b.criterionName)
        return a.criterionName.localeCompare(b.criterionName);
      return (b.versionNumber ?? 0) - (a.versionNumber ?? 0);
    });

    return { days, rows: out };
  }

  private toRecord(r: any, scope: ScopeTuple): AgentEvalRecord {
    return {
      id: r.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: r.environmentId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId ?? null,
      threadId: r.threadId,
      messageId: r.turnId ?? null,
      criterionId: r.criterionId,
      criterionSnapshot: r.criterionSnapshot ?? {},
      judgeModel: r.judgeModel,
      judgePromptUsed: r.judgePromptUsed,
      rawResponse: r.rawResponse ?? null,
      score: r.score,
      rationale: r.rationale ?? null,
      passed: r.passed,
      runId: null,
      baselineVersionId: null,
      costCents: r.costCents ?? null,
      latencyMs: r.latencyMs ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    };
  }
}
