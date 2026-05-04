import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { SpansService, type PlatosSpan } from "./spans.service";
import type { RequestScope } from "../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface TraceMessage {
  id: string;
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
 * Joins PlatosAgentMessage (messages + attachments) with the Redis-backed
 * span log to produce a single interleaved timeline for the trace viewer.
 * Scope-filtered: a thread from another (org, project, env) returns null.
 * Theme E.2.
 */
@Injectable()
export class TraceService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly spansService: SpansService,
  ) {
    this.prisma = prisma;
  }

  async buildThreadTrace(
    scope: ScopeTuple,
    threadId: string,
  ): Promise<ThreadTraceResponse | null> {
    // 1. Load the thread — scope-filtered. This is the cross-env leakage gate.
    const thread = await this.prisma.platosAgentThread.findFirst({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      select: {
        id: true,
        agentId: true,
        title: true,
        status: true,
        turnCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!thread) return null;

    // 2. Messages — ordered, with attachments joined.
    const rawMessages: Array<{
      id: string;
      role: string;
      content: string | null;
      toolCalls: unknown;
      thinkingContent: string | null;
      responseJson: unknown;
      createdAt: Date;
      attachments: Array<{
        id: string;
        kind: string;
        mimeType: string;
        bytes: number;
      }>;
    }> = await this.prisma.platosAgentMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
      include: {
        attachments: {
          select: { id: true, kind: true, mimeType: true, bytes: true },
        },
      },
    });

    const messages: TraceMessage[] = rawMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      thinkingContent: m.thinkingContent,
      responseJson: (m.responseJson as Record<string, unknown> | null) ?? null,
      createdAt: m.createdAt.toISOString(),
      attachments: m.attachments,
    }));

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
      } catch (err) {
        console.warn("[Platos TraceService] clickhouse read failed, falling back to Redis:", err);
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

    // 6. Rollup from responseJson (authoritative) + span attributes.
    let totalCostCents = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    for (const m of messages) {
      const rj = m.responseJson as { usage?: { inputTokens?: number; outputTokens?: number }; cost_cents?: number } | null;
      if (rj?.cost_cents) totalCostCents += Number(rj.cost_cents) || 0;
      if (rj?.usage?.inputTokens) totalInputTokens += rj.usage.inputTokens;
      if (rj?.usage?.outputTokens) totalOutputTokens += rj.usage.outputTokens;
      if (Array.isArray(m.toolCalls)) {
        toolCallCount += (m.toolCalls as Array<{ type?: string }>).filter((t) => t.type === "call").length;
      }
    }

    return {
      threadId,
      thread: {
        id: thread.id,
        agentId: thread.agentId,
        title: thread.title,
        status: thread.status,
        turnCount: thread.turnCount,
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
   * cost / token / tool-call rollups derived from message responseJson.
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
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (opts.agentId) where["agentId"] = opts.agentId;
    if (opts.since) where["createdAt"] = { gte: opts.since };

    const threads: Array<{
      id: string;
      agentId: string;
      title: string | null;
      status: string;
      turnCount: number;
      createdAt: Date;
      updatedAt: Date;
    }> = await this.prisma.platosAgentThread.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        agentId: true,
        title: true,
        status: true,
        turnCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (threads.length === 0) return { traces: [], count: 0 };

    const threadIds = threads.map((t) => t.id);
    const messages: Array<{
      threadId: string;
      toolCalls: unknown;
      responseJson: unknown;
    }> = await this.prisma.platosAgentMessage.findMany({
      where: { threadId: { in: threadIds }, status: "active" },
      select: { threadId: true, toolCalls: true, responseJson: true },
    });

    // Per-thread aggregation.
    const rollups = new Map<
      string,
      {
        messageCount: number;
        totalCostCents: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        toolCallCount: number;
      }
    >();
    for (const id of threadIds) {
      rollups.set(id, {
        messageCount: 0,
        totalCostCents: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        toolCallCount: 0,
      });
    }
    for (const m of messages) {
      const r = rollups.get(m.threadId);
      if (!r) continue;
      r.messageCount += 1;
      const rj = m.responseJson as
        | {
            usage?: { inputTokens?: number; outputTokens?: number };
            cost_cents?: number;
          }
        | null;
      if (rj?.cost_cents) r.totalCostCents += Number(rj.cost_cents) || 0;
      if (rj?.usage?.inputTokens) r.totalInputTokens += rj.usage.inputTokens;
      if (rj?.usage?.outputTokens) r.totalOutputTokens += rj.usage.outputTokens;
      if (Array.isArray(m.toolCalls)) {
        r.toolCallCount += (m.toolCalls as Array<{ type?: string }>).filter(
          (t) => t.type === "call",
        ).length;
      }
    }

    const traces = threads.map((t) => {
      const r = rollups.get(t.id) ?? {
        messageCount: 0,
        totalCostCents: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        toolCallCount: 0,
      };
      return {
        threadId: t.id,
        agentId: t.agentId,
        title: t.title,
        status: t.status,
        turnCount: t.turnCount,
        messageCount: r.messageCount,
        totalCostCents: Math.round(r.totalCostCents * 100) / 100,
        totalInputTokens: r.totalInputTokens,
        totalOutputTokens: r.totalOutputTokens,
        toolCallCount: r.toolCallCount,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      };
    });

    return { traces, count: traces.length };
  }
}
