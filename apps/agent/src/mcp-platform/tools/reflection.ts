/**
 * Theme K.16 — MCP reflection tools.
 *
 * Debugging + prompt-engineering superpowers for operators. Read-mostly —
 * no new mutation surface. All three handlers are **auto_allow** at the
 * platform tier (see permission-gateway.service.ts: tools not listed in
 * `PLATFORM_TIER_MINIMUMS` default to auto_allow).
 *
 * Tools:
 *   - platos.explain_turn(threadId, messageId) — post-hoc analysis of one
 *     completed LLM turn. Joins PlatosAgentMessage + TraceService spans +
 *     ToolAuditService + MonitoringApprovalsService into a single view.
 *   - platos.simulate_turn(agentId, message, mockToolResults) — runs an
 *     LLM turn WITHOUT firing any real tools. Simplified inline variant:
 *     a single `generateText` call using the agent's resolved config, no
 *     tool dispatch, with a prompt hint that mocked results are available
 *     (callers should phrase their messages to land within one LLM hop).
 *     TODO(K.16.1) — swap-in a true mock ToolExecutorService + thread the
 *     full `streamTurn` pipeline so multi-hop simulations work.
 *   - platos.diff_agents(agentIdA, agentIdB) — structural diff of two
 *     agent rows in the same scope. Useful for canary vs primary audits.
 *
 * Scope is always taken from the verified MCP token — `agentId` / `threadId`
 * args are additionally scope-verified via the service layer (`AgentCrudService.findById`
 * and `ConversationService.getThread` both filter on the RequestScope tuple).
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import type { AgentCrudService, AgentRecord } from "../../agent-runtime/agent-crud.service";
import type { ConversationService } from "../../memory/conversation.service";
import type { SpansService, PlatosSpan } from "../../monitoring/spans.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { MonitoringApprovalsService } from "../../monitoring/approvals.service";
import type { CostService } from "../../monitoring/cost.service";
import { preflightModelPricing } from "../../monitoring/model-pricing-preflight";
import type { McpToolHandler } from "../mcp-router";
import type { ControlDatabaseClient } from "../../shared/database.provider";
import type { RequestScope } from "../../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export interface ReflectionDeps {
  agentCrud: AgentCrudService;
  conversation: ConversationService;
  spans: SpansService;
  toolAudit: ToolAuditService;
  approvals: MonitoringApprovalsService;
  /**
   * Phase-3 S3 — simulate_turn does a real `generateText` against the
   * agent's resolved model + provider API key. Without recording the spend
   * through CostService.recordAuxiliaryCost the dashboard undercounts
   * tokens (shadow-spend). Optional for unit tests / DI-less callers.
   */
  cost?: CostService;
  /**
   * Prisma client (already global via DatabaseModule). Needed for:
   *   - single-message lookup by id (ConversationService only exposes list)
   *   - tool matrix snapshot (PlatosEntityToolMapping + PlatosToolDefinition)
   *   - MCP feeder list (PlatosConnectedEntity)
   */
  prisma: ControlDatabaseClient;
}

// ── small line-diff helper ─────────────────────────────────────────────
/**
 * Return a compact per-line diff for two strings. Format mirrors `diff`'s
 * line-mode output: arrays of `{ kind, line }` entries. No dep — LCS via
 * a standard O(n*m) DP. Bounded to 500 lines per side so accidental
 * 10k-line paste doesn't blow up the response.
 */
function linewiseDiff(
  a: string | null,
  b: string | null,
): Array<{ kind: "same" | "add" | "remove"; line: string }> {
  const lhs = (a ?? "").split("\n").slice(0, 500);
  const rhs = (b ?? "").split("\n").slice(0, 500);
  const n = lhs.length;
  const m = rhs.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = lhs[i] === rhs[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const out: Array<{ kind: "same" | "add" | "remove"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lhs[i] === rhs[j]) {
      out.push({ kind: "same", line: lhs[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "remove", line: lhs[i]! });
      i++;
    } else {
      out.push({ kind: "add", line: rhs[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "remove", line: lhs[i++]! });
  while (j < m) out.push({ kind: "add", line: rhs[j++]! });
  return out;
}

/**
 * Shallow key-by-key diff for two objects. Returns a triple-split:
 * added (in b, not a), removed (in a, not b), changed (different values).
 */
function shallowObjectDiff(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Array<{ key: string; from: unknown; to: unknown }>;
} {
  const lhs = (a ?? {}) as Record<string, unknown>;
  const rhs = (b ?? {}) as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const k of Object.keys(rhs)) {
    if (!(k in lhs)) added[k] = rhs[k];
    else if (JSON.stringify(lhs[k]) !== JSON.stringify(rhs[k])) {
      changed.push({ key: k, from: lhs[k], to: rhs[k] });
    }
  }
  for (const k of Object.keys(lhs)) {
    if (!(k in rhs)) removed[k] = lhs[k];
  }
  return { added, removed, changed };
}

/**
 * Resolve an LLM handle for simulate_turn. Mirrors the provider prefix
 * contract AgentService uses (`anthropic:`, `openai:`, `google:`). API keys
 * come from process.env — the scoped-env resolver isn't threaded here
 * because simulate_turn runs a SINGLE LLM call, not a full scope-aware
 * turn. Fine for prompt-testing; for production-style parity use the real
 * runtime + a canary agent.
 */
function resolveModelForSimulation(modelString: string) {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  const modelName = colonIdx > 0 ? modelString.slice(colonIdx + 1) : modelString;
  switch (provider) {
    case "anthropic":
      return anthropic(modelName);
    case "openai":
      return openai(modelName);
    case "google":
    case "google-vertex":
      return google(modelName);
    default:
      throw new Error(
        `simulate_turn: unknown model provider "${provider}". ` +
        `Supported: anthropic:, openai:, google:.`,
      );
  }
}

export function buildReflectionToolHandlers(deps: ReflectionDeps): McpToolHandler[] {
  const { agentCrud, conversation, spans, toolAudit, approvals, prisma, cost } = deps;

  return [
    // ── platos.explain_turn ────────────────────────────────────────────
    {
      name: "platos.explain_turn",
      description:
        "Post-hoc explanation of a completed LLM turn. Returns: tools in scope " +
        "at turn time, tools the LLM picked (with stored annotations), MCP " +
        "feeders (entities), approvals fired, budget blocks, total cost, and a " +
        "span-derived timeline (turn start → first token → tool calls → last " +
        "token → end). Read-only.",
      inputSchema: {
        type: "object",
        required: ["threadId", "messageId"],
        properties: {
          threadId: { type: "string" },
          messageId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const threadId = String(params["threadId"]);
        const messageId = String(params["messageId"]);

        // 1. Scope-verify the thread. `getThread` returns null if the
        //    (org, project, env) tuple doesn't match, which blocks cross-
        //    tenant enumeration.
        const thread = await conversation.getThread(threadId, scope);
        if (!thread) {
          throw new Error(`thread ${threadId} not found in scope`);
        }

        // 2. Load the target message — bound to the verified threadId so a
        //    crafted messageId belonging to another scope's thread can't
        //    leak through. Prisma `findFirst` scoped by threadId short-circuits.
        const message = await prisma.turn.findFirst({
          where: { id: messageId, threadId },
          select: {
            id: true,
            output: true,
            costCents: true,
            steps: {
              select: {
                inputTokens: true,
                outputTokens: true,
                toolCalls: {
                  select: {
                    toolName: true,
                    arguments: true,
                    result: true,
                    status: true,
                  },
                },
              },
            },
            createdAt: true,
            status: true,
          },
        });
        if (!message) {
          throw new Error(`message ${messageId} not found in thread ${threadId}`);
        }

        const agentId = thread.agentId;
        const usage = message.steps.reduce(
          (total, step) => ({
            inputTokens: total.inputTokens + (step.inputTokens ?? 0),
            outputTokens: total.outputTokens + (step.outputTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0 },
        );
        const costCents = Number(message.costCents ?? 0) || 0;

        // 3. Tools-in-scope at turn time. Best-effort snapshot via the
        //    tool matrix — we don't store per-message tool lists, so this
        //    is the CURRENT matrix, not the historical one. Flagged as
        //    such in the response.
        const toolRows = await prisma.environmentEntityTool.findMany({
          where: { environmentId: scope.environmentId },
          select: {
            enabled: true,
            toolId: true,
            entity: { select: { externalId: true } },
            tool: { select: { name: true } },
          },
        });
        const toolsInScope = toolRows.map((row) => ({
          name: row.tool.name,
          enabled: row.enabled,
          entityId: row.entity.externalId,
          toolId: row.toolId,
        }));

        // 4. Tools the LLM actually picked — stored on the assistant
         //   message's toolCalls column as produced by the runtime.
        const pickedTools = message.steps.flatMap((step) => step.toolCalls).map((toolCall) => ({
          type: "tool",
          tool: toolCall.toolName,
          args: toolCall.arguments,
          result: toolCall.result,
          status: toolCall.status,
        }));

        // 5. MCP feeders — every connected entity in the project owns an
        //    `mcpUrls` list. These are the servers whose tools end up in
        //    the matrix via the tool-sync handshake.
        const entities = await prisma.entity.findMany({
          where: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
          select: { externalId: true, displayName: true, mcpUrls: true },
        });
        const mcpFeeders = entities.map((entity) => ({
          entityId: entity.externalId,
          displayName: entity.displayName,
          mcpUrls: entity.mcpUrls,
        }));

        // 6. Approvals in this thread. `list` is already scope-filtered
        //    server-side.
        const approvalPage = await approvals.list(tuple(scope), { threadId, limit: 200 });

        // 7. Budget blocks — canonical safety rows use detector="budget"
        //    with action="block" or "warn". Best-effort direct read; we don't import
        //    SafetyEventService here since the feature set is read-only.
        const budgetRows = await prisma.safetyEvent.findMany({
          where: {
            environmentId: scope.environmentId,
            threadId,
            detector: "budget",
            action: { in: ["block", "warn"] },
          },
          orderBy: { createdAt: "desc" },
          select: { action: true, detail: true, createdAt: true },
          take: 50,
        });
        const budgetBlocks = budgetRows.map((row) => ({
          kind: row.action === "block" ? "budget_block" : "budget_warning",
          reason: row.detail,
          createdAt: row.createdAt.toISOString(),
        }));

        // 8. Timeline — derive from the spans log. For the one-message
        //    detail we filter spans by time window (message.createdAt ±
        //    the turn duration baked into responseJson, falling back to
        //    the whole thread if either isn't available).
        let turnSpans: PlatosSpan[] = [];
        try {
          turnSpans = await spans.getThreadSpans(threadId);
        } catch {
          turnSpans = [];
        }
        const messageTime = new Date(message.createdAt).getTime();
        const windowStart = messageTime - 10 * 60_000; // 10-min lookback
        const windowEnd = messageTime + 5 * 60_000;
        const msToNs = (ms: number) => ms * 1_000_000;
        const scopedSpans = turnSpans.filter((s) => {
          const startMs = s.startTimeUnixNano / 1_000_000;
          return startMs >= windowStart - 1000 && startMs <= windowEnd + 1000;
        });
        scopedSpans.sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
        const toolCallEvents = scopedSpans
          .filter((s) => typeof s.attributes?.["platos.tool.name"] === "string")
          .map((s) => ({
            tool: String(s.attributes["platos.tool.name"]),
            status: String(s.attributes["platos.tool.status"] ?? s.status),
            atMs: Math.round(s.startTimeUnixNano / 1_000_000),
            durationMs: s.durationMs,
          }));
        const firstSpan = scopedSpans[0];
        const lastSpan = scopedSpans[scopedSpans.length - 1];
        const timeline = {
          turnStartedAtMs: firstSpan ? Math.round(firstSpan.startTimeUnixNano / 1_000_000) : null,
          firstTokenAtMs:
            scopedSpans.find((s) => s.name.includes("stream") || s.name.includes("llm"))
              ? Math.round(
                  scopedSpans.find((s) => s.name.includes("stream") || s.name.includes("llm"))!.startTimeUnixNano /
                    1_000_000,
                )
              : null,
          toolCalls: toolCallEvents,
          lastTokenAtMs: lastSpan ? Math.round(lastSpan.endTimeUnixNano / 1_000_000) : null,
          endAtMs: lastSpan ? Math.round(lastSpan.endTimeUnixNano / 1_000_000) : null,
        };
        void msToNs; // kept for future use — silences the 'declared-not-used' lint.

        // 9. Tool-audit rows — which dispatches actually happened for
        //    this thread around the turn (upper-bounded).
        const auditPage = await toolAudit.list(tuple(scope), {
          threadId,
          limit: 100,
        });

        return {
          thread: {
            id: thread.id,
            agentId,
            status: thread.status,
          },
          message: {
            id: message.id,
            role: "assistant",
            createdAt: new Date(message.createdAt).toISOString(),
            status: message.status,
          },
          toolsInScope: {
            note: "CURRENT tool matrix snapshot — historical per-turn matrix isn't persisted.",
            count: toolsInScope.length,
            enabledCount: toolsInScope.filter((t) => t.enabled).length,
            tools: toolsInScope,
          },
          pickedTools: {
            note: "From assistant message toolCalls annotations.",
            count: pickedTools.length,
            calls: pickedTools,
          },
          mcpFeeders,
          approvals: {
            count: approvalPage.total,
            pendingCount: approvalPage.pendingCount,
            rows: approvalPage.rows.map((r) => ({
              approvalId: r.approvalId,
              action: r.action,
              status: r.status,
              respondedBy: r.respondedBy,
              resolvedAt: r.resolvedAt,
            })),
          },
          budgetBlocks,
          cost: {
            totalCostCents: costCents,
            inputTokens: Number(usage.inputTokens ?? 0) || 0,
            outputTokens: Number(usage.outputTokens ?? 0) || 0,
          },
          timeline,
          toolAuditRows: {
            count: auditPage.total,
            sample: auditPage.rows.slice(0, 20).map((r) => ({
              id: r.id,
              toolName: r.toolName,
              status: r.status,
              latencyMs: r.latencyMs,
              createdAt: r.createdAt,
            })),
          },
        };
      },
    },

    // ── platos.simulate_turn ───────────────────────────────────────────
    {
      name: "platos.simulate_turn",
      description:
        "Run an agent turn in SIMULATION mode — no real tools fire. The LLM " +
        "receives the agent's system prompt + a mocked-tools hint block, and " +
        "returns its response directly. Useful for prompt testing + CI " +
        "regression. This simplified variant does NOT dispatch multi-hop tool " +
        "loops (see TODO(K.16.1)); if the LLM requests a tool, the request is " +
        "surfaced in `requestedButUnavailable` rather than mocked back into a " +
        "follow-up LLM call.",
      inputSchema: {
        type: "object",
        required: ["agentId", "message"],
        properties: {
          agentId: { type: "string" },
          message: { type: "string" },
          mockToolResults: {
            type: "object",
            additionalProperties: true,
            description:
              "Map of tool-name → canned result. Used as a prompt hint only in " +
              "this simplified variant (follow-up: thread through a mock " +
              "ToolExecutorService to enable true multi-hop simulation).",
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const userMessage = String(params["message"]);
        const mockToolResults =
          (params["mockToolResults"] as Record<string, unknown> | undefined) ?? {};

        // Scope-verified read — `findById` filters on the scope tuple.
        const agent = await agentCrud.findById(agentId, scope);
        if (!agent) {
          throw new Error(`agent ${agentId} not found in scope`);
        }

        const systemPrompt =
          agent.systemPrompt ??
          "You are a helpful AI assistant running in a Platos simulation — no tools are available.";
        const mockHint =
          Object.keys(mockToolResults).length > 0
            ? `\n\n--- SIMULATION MODE ---\nThe following tools are AVAILABLE BUT MOCKED. When you would normally call one of them, treat the mocked result as the tool's response and continue reasoning from there.\n\n${Object.entries(
                mockToolResults,
              )
                .map(([k, v]) => `* ${k} → ${JSON.stringify(v)}`)
                .join("\n")}\n--- END SIMULATION ---\n`
            : "\n\n--- SIMULATION MODE ---\nNo tools are available. Respond based on the user message alone.\n--- END SIMULATION ---\n";

        const model = resolveModelForSimulation(agent.model);
        let simulationPrice: Awaited<ReturnType<typeof preflightModelPricing>>;
        try {
          simulationPrice = await preflightModelPricing(cost, agent.model);
        } catch (err: any) {
          return {
            agentId,
            simulated: true,
            code: err?.code ?? "model_pricing_unavailable",
            error: err?.message ?? "Canonical model pricing is unavailable.",
            durationMs: 0,
          };
        }

        const startMs = Date.now();
        // PRELAUNCH-A2-2 — Vercel AI SDK v6 renamed `promptTokens` →
        // `inputTokens` and `completionTokens` → `outputTokens`. The v4
        // names resolve to undefined on v6 — the simulate_turn report
        // showed zeros for both fields since the v6 migration.
        // PRELAUNCH-A1-7 (follow-up) — also surface providerMetadata so
        // cache + reasoning attribution makes it onto recordAuxiliaryCost.
        let result: {
          text: string;
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
            inputTokenDetails?: Record<string, unknown> | null;
            outputTokenDetails?: Record<string, unknown> | null;
          };
          providerMetadata?: Record<string, any>;
        };
        try {
          // PRELAUNCH-A2-11 — propagate the AbortController signal that
          // wraps the simulate_turn dispatch when the MCP client cancels
          // mid-call. Cast through `unknown` because RequestScope doesn't
          // declare `abortSignal` in its public shape; the MCP transport
          // layer attaches it dynamically when a cancellation token is
          // present on the inbound request.
          const dynamicSignal = (scope as unknown as { abortSignal?: AbortSignal })
            ?.abortSignal;
          const generated = await generateText({
            model,
            system: systemPrompt + mockHint,
            prompt: userMessage,
            abortSignal: dynamicSignal,
          });
          result = {
            text: generated.text,
            usage: generated.usage as any,
            providerMetadata: (generated as any).providerMetadata,
          };
        } catch (err: any) {
          return {
            agentId,
            simulated: true,
            error: err?.message || String(err),
            durationMs: Date.now() - startMs,
          };
        }

        const durationMs = Date.now() - startMs;

        // Heuristic: the simplified variant doesn't truly detect tool-use
        // tokens (we passed no `tools` to generateText). If the LLM emitted
        // text that looks like a function-call block, surface it so callers
        // can iterate on their mock hints.
        const looksLikeToolRequest = /"tool"\s*:\s*"|call\s+\w+\(|tool:\s*\w+/i.test(result.text);
        const requestedButUnavailable = looksLikeToolRequest
          ? { note: "LLM output appears to reference a tool call — text-match heuristic only.", hint: "Add a mockToolResults entry keyed by the tool name to feed a canned result." }
          : null;

        // Resolve the exact canonical four-rate cost from the token counts.
        // PRELAUNCH-A2-2 — read v6 token field names.
        const promptTokens = Number(result.usage?.inputTokens ?? 0) || 0;
        const completionTokens = Number(result.usage?.outputTokens ?? 0) || 0;
        // PRELAUNCH-A1-7 (follow-up 2026-05-04) — extract cache + reasoning
        // tokens with provider fallbacks so simulate_turn cost attribution
        // captures cache_read / reasoning_tokens slices.
        const reflMeta = result.providerMetadata as Record<string, any> | undefined;
        const reflCacheRead =
          Number((result.usage?.inputTokenDetails as any)?.cacheReadTokens ?? 0) ||
          Number(reflMeta?.anthropic?.cacheReadInputTokens ?? 0) ||
          Number(reflMeta?.openai?.cachedPromptTokens ?? 0) ||
          Number(reflMeta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
          Number(reflMeta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
        const reflCacheCreation =
          Number((result.usage?.inputTokenDetails as any)?.cacheWriteTokens ?? 0) ||
          Number(reflMeta?.anthropic?.cacheCreationInputTokens ?? 0) ||
          Number(reflMeta?.vertex?.cacheCreationInputTokens ?? 0);
        const reflReasoning =
          Number((result.usage?.outputTokenDetails as any)?.reasoningTokens ?? 0) ||
          Number(reflMeta?.openai?.reasoningTokens ?? 0) ||
          Number(reflMeta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
          Number(reflMeta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);

        // Pricing was resolved before provider invocation. Attribution is
        // awaited so a successful response cannot silently lose its cost.
        let costEstimateCents: number | null = null;
        if (promptTokens > 0 || completionTokens > 0) {
          const pricingCost = cost!;
          const pricedUsage = pricingCost.priceUsageFromSnapshot(
            agent.model,
            simulationPrice,
            promptTokens,
            completionTokens,
            reflCacheCreation,
            reflCacheRead,
          );
          costEstimateCents = pricedUsage.costCents;
          if (pricedUsage.costCents > 0) {
            await pricingCost.recordAuxiliaryCost({
              scope: tuple(scope),
              kind: "mcp.simulate_turn",
              model: agent.model,
              costCents: pricedUsage.costCents,
              inputTokens: promptTokens,
              outputTokens: completionTokens,
              cacheReadInputTokens: reflCacheRead > 0 ? reflCacheRead : undefined,
              cacheCreationInputTokens:
                reflCacheCreation > 0 ? reflCacheCreation : undefined,
              reasoningTokens: reflReasoning > 0 ? reflReasoning : undefined,
              agentId: agent.id,
            });
          }
        }

        return {
          agentId,
          model: agent.model,
          simulated: true,
          messages: [
            { role: "system", content: systemPrompt + mockHint },
            { role: "user", content: userMessage },
            { role: "assistant", content: result.text },
          ],
          toolCallsAttempted: [],
          requestedButUnavailable,
          finalAssistantMessage: result.text,
          // PRELAUNCH-A2-2 — surface v6 token names on the simulate_turn
          // report so downstream consumers (UI, MCP clients) read consistent
          // field names with the rest of the agent surface.
          usage: {
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
          costEstimateCents,
          durationMs,
          // eslint-disable-next-line max-len
          note: "Simplified K.16 simulate_turn — single LLM hop, no tool dispatch. See TODO(K.16.1) for multi-hop mock-executor variant.",
        };
      },
    },

    // ── platos.diff_agents ─────────────────────────────────────────────
    {
      name: "platos.diff_agents",
      description:
        "Structural diff of two agents in the same scope. Useful for canary vs " +
        "primary comparisons. Returns per-field diffs (systemPrompt line-level, " +
        "metaTools / toolsBlockConfig / memoryConfig / contextMapping / " +
        "outputSchema key-level) plus version pointers. Read-only.",
      inputSchema: {
        type: "object",
        required: ["agentIdA", "agentIdB"],
        properties: {
          agentIdA: { type: "string" },
          agentIdB: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentIdA = String(params["agentIdA"]);
        const agentIdB = String(params["agentIdB"]);

        const [a, b] = await Promise.all([
          agentCrud.findById(agentIdA, scope),
          agentCrud.findById(agentIdB, scope),
        ]);
        if (!a) throw new Error(`agent A ${agentIdA} not found in scope`);
        if (!b) throw new Error(`agent B ${agentIdB} not found in scope`);

        // No canonical Agent or AgentVersion field maps to legacy contextMapping.
        const contextMappingA: Record<string, unknown> | null = null;
        const contextMappingB: Record<string, unknown> | null = null;

        const identity = {
          name: a.name === b.name ? null : { from: a.name, to: b.name },
          slug: a.slug === b.slug ? null : { from: a.slug, to: b.slug },
          model: a.model === b.model ? null : { from: a.model, to: b.model },
        };

        const systemPromptDiff = linewiseDiff(a.systemPrompt ?? null, b.systemPrompt ?? null);

        // Prompt blocks — array-of-objects, compared positionally. We compute
        // per-block equality + flag added / removed tail entries.
        // PIFSP-19 — Array.isArray, not `?? []`: promptBlocks is a Json? column
        // that can hold a string scalar (double-encoded write). `?? []` only
        // catches null/undefined, so a string would slip through and get
        // iterated character-by-character, producing a garbage diff.
        const pbA = (Array.isArray(a.promptBlocks) ? a.promptBlocks : []) as unknown as Array<Record<string, unknown>>;
        const pbB = (Array.isArray(b.promptBlocks) ? b.promptBlocks : []) as unknown as Array<Record<string, unknown>>;
        const maxBlocks = Math.max(pbA.length, pbB.length);
        const promptBlocksDiff = Array.from({ length: maxBlocks }, (_, i) => {
          const left = pbA[i] ?? null;
          const right = pbB[i] ?? null;
          if (left && right && JSON.stringify(left) === JSON.stringify(right)) {
            return { index: i, kind: "same" as const };
          }
          if (!left) return { index: i, kind: "added" as const, block: right };
          if (!right) return { index: i, kind: "removed" as const, block: left };
          return { index: i, kind: "changed" as const, from: left, to: right };
        });

        const metaToolsDiff = shallowObjectDiff(
          (a.metaTools ?? {}) as Record<string, unknown>,
          (b.metaTools ?? {}) as Record<string, unknown>,
        );
        const toolsBlockConfigDiff = shallowObjectDiff(
          (a.toolsBlockConfig ?? {}) as Record<string, unknown>,
          (b.toolsBlockConfig ?? {}) as Record<string, unknown>,
        );
        const memoryConfigDiff = shallowObjectDiff(
          (a.memoryConfig ?? {}) as Record<string, unknown>,
          (b.memoryConfig ?? {}) as Record<string, unknown>,
        );
        const outputSchemaDiff = shallowObjectDiff(
          ((a as AgentRecord).outputSchema ?? {}) as Record<string, unknown>,
          ((b as AgentRecord).outputSchema ?? {}) as Record<string, unknown>,
        );
        const contextMappingDiff = shallowObjectDiff(contextMappingA, contextMappingB);

        const versions = {
          currentVersionId:
            a.currentVersionId === b.currentVersionId
              ? null
              : { from: a.currentVersionId, to: b.currentVersionId },
          canaryVersionId:
            a.canaryVersionId === b.canaryVersionId
              ? null
              : { from: a.canaryVersionId, to: b.canaryVersionId },
          canaryPercent:
            a.canaryPercent === b.canaryPercent
              ? null
              : { from: a.canaryPercent, to: b.canaryPercent },
        };

        return {
          agentA: { id: a.id, name: a.name, slug: a.slug },
          agentB: { id: b.id, name: b.name, slug: b.slug },
          identity,
          systemPromptDiff,
          promptBlocksDiff,
          metaToolsDiff,
          toolsBlockConfigDiff,
          memoryConfigDiff,
          contextMappingDiff,
          outputSchemaDiff,
          versions,
        };
      },
    },
  ];
}
