import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { SpansService, type PlatosSpan } from "./spans.service";
import type { RequestScope } from "../auth/scope.guard";
import { CostService } from "./cost.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface TraceMessage {
  id: string;
  turnId: string;
  role: string;
  content: string | null;
  toolCalls: unknown;
  thinkingContent: string | null;
  responseJson: Record<string, unknown> | null;
  createdAt: string;
  attachments: Array<{
    id: string;
    kind: string;
    mimeType: string;
    bytes: number;
  }>;
}

export interface TraceTimelineItem {
  kind: "message" | "span";
  timestamp: string; // ISO
  data: TraceMessage | PlatosSpan;
}

export interface TraceSpanNode extends PlatosSpan {
  children: TraceSpanNode[];
}

export interface ThreadTraceResponse {
  threadId: string;
  thread: {
    id: string;
    agentId: string;
    title: string | null;
    status: string;
    turnCount: number;
    createdAt: string;
    updatedAt: string;
  } | null;
  messages: TraceMessage[];
  spans: PlatosSpan[];
  spanTree: TraceSpanNode[];
  timeline: TraceTimelineItem[];
  rollup: {
    totalMessages: number;
    totalSpans: number;
    totalCostCents: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    toolCallCount: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
  };
}

/**
 * TraceService — builds the `GET /monitoring/trace/:threadId` payload.
 * Projects clean Turns (with Steps, ToolCalls, and attachments) into the
 * message-shaped contract and joins the Redis-backed span log.
 * Scope-filtered: a thread from another (org, project, env) returns null.
 * Theme E.2.
 */
@Injectable()
export class TraceService {
  private readonly logger = new Logger(TraceService.name);
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly spansService: SpansService,
    @Optional() private readonly costService?: CostService,
  ) {
    this.prisma = prisma;
  }

  async buildThreadTrace(
    scope: ScopeTuple,
    threadId: string,
  ): Promise<ThreadTraceResponse | null> {
    // 1. Load the thread — scope-filtered. This is the cross-env leakage gate.
    const thread = await this.prisma.thread.findFirst({
      where: {
        id: threadId,
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
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { turns: true } },
      },
    });

    if (!thread) return null;

    // 2. Turns — ordered, with normalized steps/tool calls and attachments.
    const rawTurns: Array<{
      id: string;
      inputText: string | null;
      outputText: string | null;
      thinkingContent: string | null;
      createdAt: Date;
      completedAt: Date | null;
      steps: Array<{
        id: string;
        sequence: number;
        model: string;
        inputTokens: number | null;
        outputTokens: number | null;
        status: string;
        error: string | null;
        toolCalls: Array<{
          id: string;
          sequence: number;
          toolName: string;
          arguments: unknown;
          result: unknown;
          status: string;
          error: string | null;
          latencyMs: number | null;
        }>;
      }>;
      attachments: Array<{
        id: string;
        kind: string;
        mimeType: string;
        bytes: number;
      }>;
    }> = await this.prisma.turn.findMany({
      where: { threadId },
      orderBy: { sequence: "asc" },
      include: {
        steps: {
          orderBy: { sequence: "asc" },
          include: { toolCalls: { orderBy: { sequence: "asc" } } },
        },
        attachments: {
          select: { id: true, kind: true, mimeType: true, bytes: true },
        },
      },
    });

    // Preserve the trace viewer's message-shaped wire contract while deriving
    // it from the clean turn. The persisted identifier is the assistant-side
    // Turn id; the input projection gets a non-persisted suffix so it cannot be
    // mistaken for another database row.
    const messages: TraceMessage[] = rawTurns.flatMap((turn) => {
      const toolCalls = turn.steps.flatMap((step) =>
        step.toolCalls.map((call) => ({
          type: "call",
          toolCallId: call.id,
          toolName: call.toolName,
          args: call.arguments,
          result: call.result,
          status: call.status,
          error: call.error,
          latencyMs: call.latencyMs,
        })),
      );
      const usage = turn.steps.reduce(
        (total, step) => ({
          inputTokens: total.inputTokens + (step.inputTokens ?? 0),
          outputTokens: total.outputTokens + (step.outputTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 },
      );
      const projected: TraceMessage[] = [];
      if (turn.inputText !== null) {
        projected.push({
          id: `${turn.id}:input`,
          turnId: turn.id,
          role: "user",
          content: turn.inputText,
          toolCalls: [],
          thinkingContent: null,
          responseJson: null,
          createdAt: turn.createdAt.toISOString(),
          attachments: turn.attachments,
        });
      }
      if (
        turn.outputText !== null ||
        turn.thinkingContent !== null ||
        turn.steps.length > 0
      ) {
        projected.push({
          id: turn.id,
          turnId: turn.id,
          role: "assistant",
          content: turn.outputText,
          toolCalls,
          thinkingContent: turn.thinkingContent,
          responseJson: {
            model: turn.steps.at(-1)?.model ?? null,
            usage,
            stepCount: turn.steps.length,
          },
          createdAt: (turn.completedAt ?? turn.createdAt).toISOString(),
          attachments: [],
        });
      }
      return projected;
    });

    // 3. Spans — PPR-15: prefer ClickHouse when configured so traces survive
    //    the Redis 14-day TTL + LRU trim, fall back to Redis when the env var
    //    is unset or the CH read errors. The CH read is scope-filtered
    //    server-side so cross-env leakage is structurally impossible even if
    //    the Redis layer ever regresses.
    let spans: PlatosSpan[] = [];
    if (this.spansService.isClickhouseEnabled()) {
      try {
        const chSpans = await this.spansService.getThreadSpansFromClickhouse(scope, threadId);
        if (chSpans) spans = chSpans;
      } catch (err: any) {
        this.logger.warn(
          `[trace] ClickHouse read failed; falling back to Redis: ${err?.message ?? err}`,
        );
      }
    }
    if (spans.length === 0) {
      spans = await this.spansService.getThreadSpans(threadId);
    }

    // 4. Build span tree. Spans with no parent (or with a parent not in the
    //    set) become roots.
    const byId = new Map<string, TraceSpanNode>();
    for (const s of spans) byId.set(s.spanId, { ...s, children: [] });

    const roots: TraceSpanNode[] = [];
    for (const s of spans) {
      const node = byId.get(s.spanId)!;
      if (s.parentSpanId && byId.has(s.parentSpanId)) {
        byId.get(s.parentSpanId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    // Stable order inside each node
    const sortChildren = (n: TraceSpanNode) => {
      n.children.sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
      n.children.forEach(sortChildren);
    };
    roots.sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
    roots.forEach(sortChildren);

    // 5. Interleaved timeline — useful for the basic viewer that doesn't
    //    render a tree. Messages use createdAt, spans use startTimeUnixNano.
    const timeline: TraceTimelineItem[] = [];
    for (const m of messages) {
      timeline.push({ kind: "message", timestamp: m.createdAt, data: m });
    }
    for (const s of spans) {
      timeline.push({
        kind: "span",
        timestamp: new Date(Math.round(s.startTimeUnixNano / 1_000_000)).toISOString(),
        data: s,
      });
    }
    timeline.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

    // 6. Tokens and tool counts live on Step/ToolCall. Exact cost remains in
    // the full-fidelity Redis ledger written by CostService.recordUsage.
    let totalCostCents = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    for (const turn of rawTurns) {
      for (const step of turn.steps) {
        totalInputTokens += step.inputTokens ?? 0;
        totalOutputTokens += step.outputTokens ?? 0;
        toolCallCount += step.toolCalls.length;
      }
    }
    if (this.costService) {
      try {
        totalCostCents = (await this.costService.getThreadCost(threadId)).costCents;
      } catch (err: any) {
        this.logger.warn(
          `[trace] exact thread cost unavailable for ${threadId}: ${err?.message ?? err}`,
        );
      }
    } else {
      this.logger.warn(
        `[trace] CostService is not wired; exact thread cost is unavailable for ${threadId}`,
      );
    }
    if (totalCostCents === 0) {
      totalCostCents = spans.reduce(
        (sum, span) => sum + Number(span.attributes["platos.cost_cents"] ?? 0),
        0,
      );
    }
    if (
      totalCostCents === 0 &&
      (totalInputTokens > 0 || totalOutputTokens > 0)
    ) {
      this.logger.warn(
        `[trace] cost attribution is unavailable for token-bearing thread ${threadId}`,
      );
    }

    return {
      threadId,
      thread: {
        id: thread.id,
        agentId: thread.agentId,
        title: thread.title,
        status: thread.status,
        turnCount: thread._count.turns,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      },
      messages,
      spans,
      spanTree: roots,
      timeline,
      rollup: {
        totalMessages: messages.length,
        totalSpans: spans.length,
        totalCostCents: Math.round(totalCostCents * 100) / 100,
        totalInputTokens,
        totalOutputTokens,
        toolCallCount,
        firstMessageAt: messages[0]?.createdAt ?? null,
        lastMessageAt: messages[messages.length - 1]?.createdAt ?? null,
      },
    };
  }

  /**
   * MCPF-W6 — list traces (threads with cost rollups) for the operator
   * monitoring surface. Returns scope-filtered thread metadata + per-thread
   * cost / token / tool-call rollups derived from clean Turns and Steps.
   *
   * NOT a substitute for `buildThreadTrace` — this is the lightweight
   * sibling: one row per thread, no spans, no full message text. Useful
   * for "show me the most expensive threads in the last 24h" or
   * "list active threads for agent X" via MCP.
   */
  async listTraces(
    scope: ScopeTuple,
    opts: {
      agentId?: string;
      limit?: number;
      offset?: number;
      since?: Date;
    } = {},
  ): Promise<{
    traces: Array<{
      threadId: string;
      agentId: string;
      title: string | null;
      status: string;
      turnCount: number;
      messageCount: number;
      totalCostCents: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      toolCallCount: number;
      createdAt: string;
      updatedAt: string;
    }>;
    count: number;
  }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);

    const where: Record<string, unknown> = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
    };
    if (opts.agentId) where["agentId"] = opts.agentId;
    if (opts.since) where["createdAt"] = { gte: opts.since };

    const threads: Array<{
      id: string;
      agentId: string;
      title: string | null;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      turns: Array<{
        inputText: string | null;
        outputText: string | null;
        steps: Array<{
          inputTokens: number | null;
          outputTokens: number | null;
          toolCalls: Array<{ id: string }>;
        }>;
      }>;
    }> = await this.prisma.thread.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        agentId: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        turns: {
          select: {
            inputText: true,
            outputText: true,
            steps: {
              select: {
                inputTokens: true,
                outputTokens: true,
                toolCalls: { select: { id: true } },
              },
            },
          },
        },
      },
    });

    if (threads.length === 0) return { traces: [], count: 0 };

    const traces = await Promise.all(threads.map(async (t) => {
      const r = t.turns.reduce(
        (rollup, turn) => {
          if (turn.inputText !== null) rollup.messageCount += 1;
          if (turn.outputText !== null || turn.steps.length > 0) {
            rollup.messageCount += 1;
          }
          for (const step of turn.steps) {
            rollup.totalInputTokens += step.inputTokens ?? 0;
            rollup.totalOutputTokens += step.outputTokens ?? 0;
            rollup.toolCallCount += step.toolCalls.length;
          }
          return rollup;
        },
        {
          messageCount: 0,
          totalCostCents: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          toolCallCount: 0,
        },
      );
      if (this.costService) {
        try {
          r.totalCostCents = (await this.costService.getThreadCost(t.id)).costCents;
        } catch (err: any) {
          this.logger.warn(
            `[trace] exact thread cost unavailable for ${t.id}: ${err?.message ?? err}`,
          );
        }
      } else {
        this.logger.warn(
          `[trace] CostService is not wired; exact thread cost is unavailable for ${t.id}`,
        );
      }
      if (
        r.totalCostCents === 0 &&
        (r.totalInputTokens > 0 || r.totalOutputTokens > 0)
      ) {
        this.logger.warn(
          `[trace] cost attribution is unavailable for token-bearing thread ${t.id}`,
        );
      }
      return {
        threadId: t.id,
        agentId: t.agentId,
        title: t.title,
        status: t.status,
        turnCount: t.turns.length,
        messageCount: r.messageCount,
        totalCostCents: Math.round(r.totalCostCents * 100) / 100,
        totalInputTokens: r.totalInputTokens,
        totalOutputTokens: r.totalOutputTokens,
        toolCallCount: r.toolCallCount,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      };
    }));

    return { traces, count: traces.length };
  }
}
