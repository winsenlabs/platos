import { Injectable, Optional, Logger } from "@nestjs/common";
import { SkillRegistryService, type ScopeTuple, type AgentSkillRecord } from "./skill-registry.service";
import type { SkillProvidedTool } from "./skill-manifest.types";
import { OfficialSkillHandlers } from "./official/skill-handlers";
import { estimate as estimateSkillCost } from "./official/estimators";
import {
  CostService,
  type SkillUsageEvent,
  type SkillUsageOverride,
} from "../monitoring/cost.service";
import { BudgetService } from "../monitoring/budget.service";

/**
 * Theme SM.3 — Shape returned when a skill-tool call is blocked by a
 * budget cap. The skill runtime returns this as the tool's `result` so
 * the LLM sees a clear, structured refusal instead of a thrown error.
 */
export interface SkillBudgetBlocked {
  blocked: true;
  reason: string;
  capId?: string;
  limitCents?: number;
  currentCents?: number;
}

export interface SkillRuntimePayload {
  /** Active skills loaded at turn time (env-ready + enabled). */
  activeSkills: AgentSkillRecord[];
  /** Block of markdown to append to the system prompt. */
  promptBlock: string;
  /** Flat catalog of tools contributed by active skills (namespaced). */
  providedTools: Array<SkillProvidedTool & { skillId: string }>;
}

/**
 * Theme S.6 — Runtime skill merge.
 *
 * Loads active skills for an agent turn and produces:
 *   - A `systemPrompt` block that concatenates each skill's prompt-block
 *     under a header (so Anthropic caching stays stable per-skill-set).
 *   - A `providedTools` array the runtime can merge into its tool catalog.
 *
 * Invariants (THEME_S §6):
 *   - Total skill prompt-block size is capped at 16_000 chars (~4k tokens).
 *     Skills beyond the cap are dropped in registration order (with a
 *     `[truncated]` footer) so an accidental 50kb skill doesn't blow the
 *     context budget.
 *   - Tool names are always prefixed with the skill id (dotted form converted
 *     to underscore: `platos.web_search` → `platos_web_search__web_search`).
 *     This guarantees no collision with entity-provided tools.
 */
@Injectable()
export class SkillRuntimeService {
  private readonly MAX_PROMPT_CHARS = 16_000;
  private readonly logger = new Logger(SkillRuntimeService.name);

  constructor(
    private readonly registry: SkillRegistryService,
    /** SM.1 — skill tool dispatcher. Optional so unit tests that exercise
     *  `merge()` alone can boot without pulling the whole handler module. */
    @Optional() private readonly handlers?: OfficialSkillHandlers,
    /** SM.1 — cost-event recorder. Optional for the same reason. */
    @Optional() private readonly costService?: CostService,
    /** SM.3 — pre-dispatch budget gate. Optional + fail-open: if the
     *  service is unavailable or throws, skill tools dispatch normally. */
    @Optional() private readonly budgetService?: BudgetService,
  ) {}

  async loadForAgent(scope: ScopeTuple, agentId: string): Promise<SkillRuntimePayload> {
    const skills = await this.registry.loadActiveForAgent(scope, agentId);
    return this.merge(skills);
  }

  merge(skills: AgentSkillRecord[]): SkillRuntimePayload {
    const blocks: string[] = [];
    const providedTools: Array<SkillProvidedTool & { skillId: string }> = [];
    let total = 0;
    let truncated = false;

    for (const skill of skills) {
      if (!skill.promptBlock.trim()) continue;
      const header = `## Skill: ${skill.name} (${skill.skillId})`;
      const block = `${header}\n\n${skill.promptBlock.trim()}`;
      if (total + block.length > this.MAX_PROMPT_CHARS) {
        truncated = true;
        break;
      }
      blocks.push(block);
      total += block.length;
      for (const t of skill.providesTools) {
        providedTools.push({
          ...t,
          // namespaced name to avoid collision
          name: namespaceTool(skill.skillId, t.name),
          skillId: skill.skillId,
        });
      }
    }
    if (truncated) {
      blocks.push(
        `_[Some skills were omitted because the total skill prompt would exceed ${this.MAX_PROMPT_CHARS} characters.]_`,
      );
    }
    const promptBlock = blocks.length === 0
      ? ""
      : `## Enabled Skills\n\n${blocks.join("\n\n---\n\n")}`;

    return { activeSkills: skills, promptBlock, providedTools };
  }

  /** Convenience: merge a skill prompt block into an agent's existing system prompt. */
  composeSystemPrompt(baseSystemPrompt: string | null | undefined, skillBlock: string): string {
    const base = baseSystemPrompt?.trim() ?? "";
    if (!skillBlock.trim()) return base;
    if (!base) return skillBlock;
    return `${base}\n\n---\n\n${skillBlock}`;
  }

  /**
   * SM.1 — invoke a skill-provided tool + record a SkillUsageEvent.
   *
   * Wraps `OfficialSkillHandlers.dispatch`:
   *   1. Capture wall-clock start.
   *   2. Dispatch the handler.
   *   3. If the handler returned `{ _usage: {...} }`, forward those units
   *      to CostService + strip `_usage` from the result so the LLM never
   *      sees bookkeeping.
   *   4. Emit a SkillUsageEvent (scope-tagged). Emission is best-effort —
   *      ClickHouse/Redis outages log warn + continue so the skill call
   *      never fails because telemetry is down.
   *
   * Returns the (cleaned) tool result unchanged. Errors from the handler
   * propagate — we still record a zero-cost, latency-stamped event for
   * failed calls so the observability surface sees them.
   *
   * `provider` defaults to the first `requiredEnv` entry on the skill
   * record (e.g. `TAVILY_API_KEY` for platos.web_search). Call sites with
   * an explicit provider field on the manifest may pass it directly.
   */
  async invokeTool(
    scope: ScopeTuple & { userId?: string },
    tool: { skillSlug: string; toolName: string; handler: string; provider?: string | null },
    input: Record<string, unknown>,
    context: { agentId?: string | null; threadId?: string | null } = {},
  ): Promise<unknown> {
    if (!this.handlers) {
      throw new Error(
        "SkillRuntimeService.invokeTool called but OfficialSkillHandlers was not injected.",
      );
    }
    const startedAt = Date.now();
    const provider = (tool.provider ?? "").trim();

    // Theme SM.3 — pre-dispatch budget gate. Consult any skill-tier caps
    // BEFORE the handler runs so we don't pay the vendor cost just to
    // discover the cap later. Fail-open: if BudgetService is absent or
    // throws, we let the call through (logged) — availability failures
    // must not lock users out of skills mid-turn.
    if (this.budgetService) {
      try {
        // PRELAUNCH-A3-14 — pre-dispatch cost estimate. Without this the
        // cap only fires once spend is already at or past the limit,
        // which let one final tool call always squeeze through (the EOBD
        // skill cap of $5/day silently allowed up to $5 + one full call).
        // estimateSkillCost is the same per-tool cost-per-call estimator
        // used post-call to record actual spend; calling it here with
        // null result returns the input-shape-only estimate.
        let estimatedCents = 0;
        try {
          const e = estimateSkillCost(tool.skillSlug, tool.toolName, input, null);
          estimatedCents = Number.isFinite(e.costCents) ? Math.max(0, e.costCents) : 0;
        } catch {
          estimatedCents = 0;
        }
        const gate = await this.budgetService.checkCap(
          scope,
          {
            tier: "skill",
            skillSlug: tool.skillSlug,
            agentId: context.agentId ?? null,
          },
          estimatedCents,
        );
        if (!gate.allowed && gate.capHit) {
          const cap = gate.capHit;
          const blocked: SkillBudgetBlocked = {
            blocked: true,
            reason: `daily skill budget exceeded: ${cap.name}`,
            capId: cap.id,
            limitCents: cap.limitCents,
            currentCents: cap.currentCents,
          };
          // Still emit a zero-cost usage event with latencyMs=0 so the
          // observability surface sees blocked executions alongside successes.
          if (this.costService) {
            try {
              await this.costService.recordSkillUsage(scope, {
                skillSlug: tool.skillSlug,
                toolName: tool.toolName,
                provider: provider || "unknown",
                inputUnits: 0,
                outputUnits: 0,
                estimatedCostCents: 0,
                latencyMs: 0,
                agentId: context.agentId ?? null,
                threadId: context.threadId ?? null,
              });
            } catch (emitErr: any) {
              this.logger.warn(
                `SkillUsageEvent (blocked) emission failed for ${tool.skillSlug}.${tool.toolName}: ${emitErr?.message ?? emitErr}`,
              );
            }
          }
          return blocked;
        }
      } catch (gateErr: any) {
        // Fail-open — a BudgetService blip must not stall the skill pipe.
        this.logger.warn(
          `SkillRuntime budget gate failed for ${tool.skillSlug}.${tool.toolName} (fail-open): ${gateErr?.message ?? gateErr}`,
        );
      }
    }

    let result: unknown;
    let usage: SkillUsageOverride | undefined;
    /** SM.5 — set when the handler didn't self-report `_usage` and the
     *  per-skill estimator produced a fallback number. Kept separate from
     *  `usage` (the handler override) so the event-building block below
     *  preserves a clear precedence: handler → estimator → 0. */
    let estimated: SkillUsageOverride | undefined;
    let errored = false;

    try {
      // audit L5 — handlers read acting Agent and Thread from the widened
      // scope, just as they already read userId. Merge both canonical context
      // values here so attachment consumers cannot fall back to Environment-
      // only or cluster-wide ownership checks.
      const dispatchScope = {
        ...scope,
        ...(context.agentId != null ? { agentId: context.agentId } : {}),
        ...(context.threadId != null ? { threadId: context.threadId } : {}),
      } as ScopeTuple;
      result = await this.handlers.dispatch(dispatchScope, tool.handler, input);
      // Extract + strip the `_usage` bookkeeping key (non-enumerable-safe:
      // we clone with rest-destructuring when it's an object so the LLM
      // never sees it). Non-object results (strings, numbers, arrays) are
      // passed through untouched.
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const record = result as Record<string, unknown>;
        if ("_usage" in record) {
          const raw = record._usage;
          if (raw && typeof raw === "object") {
            const r = raw as Record<string, unknown>;
            usage = {
              inputUnits: typeof r.inputUnits === "number" ? r.inputUnits : undefined,
              outputUnits: typeof r.outputUnits === "number" ? r.outputUnits : undefined,
              costCents: typeof r.costCents === "number" ? r.costCents : undefined,
            };
          }
          // Rebuild without `_usage`. Don't mutate — handlers may share refs.
          const { _usage: _, ...cleaned } = record;
          void _;
          result = cleaned;
        }
      }
      return result;
    } catch (err) {
      errored = true;
      throw err;
    } finally {
      const latencyMs = Date.now() - startedAt;
      // SM.5 — if the handler did not self-report `_usage`, fall through to
      // the per-skill estimator registry. Estimators are pure, synchronous
      // and never throw — but defend in depth so a buggy constant never
      // blocks telemetry emission.
      if (!usage && !errored) {
        try {
          const e = estimateSkillCost(tool.skillSlug, tool.toolName, input, result);
          estimated = {
            inputUnits: e.inputUnits,
            outputUnits: e.outputUnits,
            costCents: e.costCents,
          };
        } catch (estErr: any) {
          this.logger.warn(
            `SkillEstimator failed for ${tool.skillSlug}.${tool.toolName}: ${estErr?.message ?? estErr}`,
          );
        }
      }
      const event: SkillUsageEvent = {
        skillSlug: tool.skillSlug,
        toolName: tool.toolName,
        provider: provider || "unknown",
        inputUnits: usage?.inputUnits ?? estimated?.inputUnits ?? 0,
        outputUnits: usage?.outputUnits ?? estimated?.outputUnits ?? 0,
        estimatedCostCents: usage?.costCents ?? estimated?.costCents ?? 0,
        latencyMs,
        agentId: context.agentId ?? null,
        threadId: context.threadId ?? null,
      };
      if (this.costService) {
        try {
          await this.costService.recordSkillUsage(scope, event);
        } catch (emitErr: any) {
          // Never fail the skill call because the stats pipe is down.
          this.logger.warn(
            `SkillUsageEvent emission failed for ${tool.skillSlug}.${tool.toolName}: ${emitErr?.message ?? emitErr}`,
          );
        }
      }
      // Ref so tsc doesn't whine about unused `errored` when we later
      // branch on it (e.g. to mark a distinct status on the event).
      void errored;
    }
  }
}

export function namespaceTool(skillId: string, toolName: string): string {
  const prefix = skillId.replace(/[.-]/g, "_");
  return `${prefix}__${toolName}`;
}
