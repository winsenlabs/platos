import {
  ArrowLeftIcon,
  ArrowPathIcon,
  BoltIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction, useFetcher } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentConversationsPath,
  agentMonitoringPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Trace | Platos" }];

// Mirrors apps/agent/src/monitoring/spans.service.ts:PlatosSpan + the tree
// wrapper from trace.service.ts:TraceSpanNode. Keeping a local copy so the
// webapp doesn't gain a direct import dependency on `@platos/agent`.
interface SpanAttributes {
  [key: string]: string | number | boolean;
}

interface SpanEvent {
  name: string;
  timeUnixNano: number;
  attributes?: Record<string, unknown>;
}

interface SpanNode {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "client" | "server";
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  durationMs: number;
  status: "ok" | "error";
  errorMessage?: string;
  attributes: SpanAttributes;
  events?: SpanEvent[];
  children: SpanNode[];
}

interface TraceRollup {
  totalMessages: number;
  totalSpans: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

interface ThreadTraceResponse {
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
  messages: unknown[];
  spans: SpanNode[];
  spanTree: SpanNode[];
  timeline: unknown[];
  rollup: TraceRollup;
}

// The agent endpoint returns `{ error, status: 404 }` when the thread is out
// of scope (see apps/agent/src/agent-runtime/agent.controller.ts:761). We
// normalise that into `null` + a reason string the UI can render.
type LoadedTrace =
  | { trace: ThreadTraceResponse; reason: null }
  | { trace: null; reason: "not_found" | "agent_unavailable" | "fetch_failed" };

async function fetchTrace(
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
  },
  threadId: string
): Promise<LoadedTrace> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (!(await isAgentServiceAvailable())) {
      return { trace: null, reason: "agent_unavailable" };
    }

    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/monitoring/trace/${threadId}`, {
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      },
    });
    if (!res.ok) {
      return { trace: null, reason: "fetch_failed" };
    }
    const body = (await res.json()) as ThreadTraceResponse | { error: string; status: number };
    if ("error" in body) {
      return { trace: null, reason: "not_found" };
    }
    return { trace: body, reason: null };
  } catch {
    return { trace: null, reason: "fetch_failed" };
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const agentId = params.agentId!;
  const threadId = params.threadId!;
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const loaded = await fetchTrace(scope, threadId);

  return typedjson({
    agentId,
    threadId,
    ...loaded,
  });
}

/**
 * PPR-66 — tiny action that proxies the tool-audit replay request to the agent
 * service. Keeping it in this route (instead of a dedicated API route) lets
 * the span modal submit against `?index` and stay on the trace page. The agent
 * endpoint enforces scope + rate-limits per (scope, user), so there's no
 * additional gating needed here beyond authenticating the session.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent !== "replay_tool_audit") {
    return typedjson({ ok: false, error: "unknown intent" }, { status: 400 });
  }
  // The span modal knows only the span id + thread id. The replay endpoint
  // keys off the audit-row id (`callId`), so we look it up first by hitting
  // the scoped list endpoint with a threadId filter and matching spanId.
  const spanId = String(form.get("spanId") || "");
  const threadId = String(form.get("threadId") || "");
  const callIdDirect = String(form.get("callId") || "");
  if (!callIdDirect && (!spanId || !threadId)) {
    return typedjson(
      { ok: false, error: "callId or (spanId + threadId) required" },
      { status: 400 },
    );
  }

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const agentHeaders = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": project.organizationId,
    "X-Platos-Project-Id": project.id,
    "X-Platos-Environment-Id": environment.id,
    "X-Platos-User-Id": userId,
  };

  try {
    let callId = callIdDirect;
    if (!callId) {
      // Resolve spanId → callId within this scope.
      const listRes = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/tool-audit?threadId=${encodeURIComponent(
          threadId,
        )}&limit=200`,
        { headers: agentHeaders },
      );
      if (!listRes.ok) {
        return typedjson(
          { ok: false, error: `audit lookup failed (${listRes.status})` },
          { status: 502 },
        );
      }
      const page = (await listRes.json()) as {
        rows: Array<{ id: string; spanId: string | null }>;
      };
      const match = page.rows.find((r) => r.spanId === spanId);
      if (!match) {
        return typedjson(
          { ok: false, error: "No audit row found for this span" },
          { status: 404 },
        );
      }
      callId = match.id;
    }

    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/monitoring/tool-audit/${encodeURIComponent(callId)}/replay`,
      { method: "POST", headers: agentHeaders },
    );
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      return typedjson(
        { ok: false, error: body?.error || `agent returned ${res.status}` },
        { status: res.status === 429 ? 429 : 502 },
      );
    }
    return typedjson({ ok: true, callId, result: body });
  } catch (err) {
    return typedjson(
      { ok: false, error: err instanceof Error ? err.message : "fetch failed" },
      { status: 502 },
    );
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCents(cents: number | null | undefined): string {
  if (!cents || cents <= 0) return "$0.0000";
  return `$${(cents / 100).toFixed(4)}`;
}

function spanColor(span: SpanNode): string {
  if (span.status === "error") return "border-rose-600/40 bg-rose-600/5";
  const name = span.name.toLowerCase();
  if (name.includes("llm") || name.includes("model")) return "border-blue-600/30 bg-blue-600/5";
  if (name.includes("tool")) return "border-amber-600/30 bg-amber-600/5";
  return "border-charcoal-700 bg-charcoal-850";
}

function spanBadgeVariant(span: SpanNode): "success" | "error" | "outline-rounded" {
  if (span.status === "error") return "error";
  return span.status === "ok" ? "success" : "outline-rounded";
}

// Attribute key used by cost instrumentation. If present we surface the
// number as an inline chip on the span header.
const COST_ATTR = "platos.cost_cents";
const MODEL_ATTR = "platos.model";
const TOOL_ATTR = "platos.tool.name";
const INPUT_TOKENS_ATTR = "platos.input_tokens";
const OUTPUT_TOKENS_ATTR = "platos.output_tokens";

function isToolSpan(span: SpanNode): boolean {
  if (span.name.toLowerCase().includes("tool")) return true;
  return Boolean(span.attributes[TOOL_ATTR]);
}

interface SpanRowProps {
  span: SpanNode;
  depth: number;
  filter: string;
  onOpenToolAudit: (span: SpanNode) => void;
}

function matchesFilter(span: SpanNode, filter: string): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  if (span.name.toLowerCase().includes(needle)) return true;
  for (const v of Object.values(span.attributes)) {
    if (String(v).toLowerCase().includes(needle)) return true;
  }
  return span.children.some((c) => matchesFilter(c, filter));
}

function SpanRow({ span, depth, filter, onOpenToolAudit }: SpanRowProps) {
  const [expanded, setExpanded] = useState<boolean>(depth <= 1);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);

  if (!matchesFilter(span, filter)) return null;

  const cost = span.attributes[COST_ATTR];
  const model = span.attributes[MODEL_ATTR];
  const toolName = span.attributes[TOOL_ATTR];
  const inputTokens = span.attributes[INPUT_TOKENS_ATTR];
  const outputTokens = span.attributes[OUTPUT_TOKENS_ATTR];
  const hasChildren = span.children.length > 0;

  return (
    <div>
      <div
        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${spanColor(span)}`}
        style={{ marginLeft: `${depth * 16}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`mt-0.5 flex size-4 items-center justify-center rounded text-text-dimmed hover:text-text-bright ${
            hasChildren ? "" : "invisible"
          }`}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-text-bright truncate">{span.name}</span>
            <Badge variant={spanBadgeVariant(span)}>{span.status}</Badge>
            <span className="text-xs text-text-dimmed">{fmtDuration(span.durationMs)}</span>
            {typeof cost === "number" && cost > 0 && (
              <span className="text-xs text-rose-400">{fmtCents(cost)}</span>
            )}
            {model && (
              <span className="text-[11px] text-blue-400 font-mono">
                {String(model)}
              </span>
            )}
            {toolName && (
              <span className="text-[11px] text-amber-400 font-mono">{String(toolName)}</span>
            )}
            {typeof inputTokens === "number" && inputTokens > 0 && (
              <span className="text-[11px] text-text-dimmed">
                in {Number(inputTokens).toLocaleString()}
              </span>
            )}
            {typeof outputTokens === "number" && outputTokens > 0 && (
              <span className="text-[11px] text-text-dimmed">
                out {Number(outputTokens).toLocaleString()}
              </span>
            )}
            <span className="text-[11px] text-charcoal-400">{span.kind}</span>
          </div>
          {span.errorMessage && (
            <div className="mt-1 text-xs text-rose-400 truncate" title={span.errorMessage}>
              {span.errorMessage}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-dimmed">
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="hover:text-text-bright underline underline-offset-2"
            >
              {detailsOpen ? "Hide detail" : "Show detail"}
            </button>
            {isToolSpan(span) && (
              <button
                type="button"
                onClick={() => onOpenToolAudit(span)}
                className="hover:text-text-bright underline underline-offset-2"
              >
                Open tool-audit
              </button>
            )}
            <span className="font-mono opacity-60">
              {span.spanId.slice(0, 8)}
              {span.parentSpanId ? ` · parent ${span.parentSpanId.slice(0, 8)}` : ""}
            </span>
          </div>
          {detailsOpen && (
            <div className="mt-2 space-y-2 rounded border border-charcoal-700 bg-charcoal-900 p-2">
              <div>
                <p className="text-[11px] text-text-dimmed mb-1">Attributes</p>
                <pre className="text-[11px] text-text-bright whitespace-pre-wrap break-all font-mono">
                  {JSON.stringify(span.attributes, null, 2)}
                </pre>
              </div>
              {span.events && span.events.length > 0 && (
                <div>
                  <p className="text-[11px] text-text-dimmed mb-1">Events</p>
                  <pre className="text-[11px] text-text-bright whitespace-pre-wrap break-all font-mono">
                    {JSON.stringify(span.events, null, 2)}
                  </pre>
                </div>
              )}
              <div className="text-[11px] text-text-dimmed font-mono">
                trace: {span.traceId} · span: {span.spanId}
              </div>
            </div>
          )}
        </div>
      </div>
      {expanded && hasChildren && (
        <div className="mt-1 space-y-1">
          {span.children.map((child) => (
            <SpanRow
              key={child.spanId}
              span={child}
              depth={depth + 1}
              filter={filter}
              onOpenToolAudit={onOpenToolAudit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// The tool-audit modal shows the matched span's core metadata + an inline
// Replay button (PPR-66). The replay submits to this route's action, which
// resolves the spanId to an audit-row callId and fires
// `POST /api/v1/agent/monitoring/tool-audit/:callId/replay`. Successful
// replays render the result summary inline so the user can eyeball it
// alongside the original status without leaving the trace page. Also exposes
// a deep-link to the scope-filtered tool-audit view in agent-monitoring
// (PPR-62) so the span can be opened alongside the full audit log.
interface ToolAuditDrawerProps {
  span: SpanNode | null;
  threadId: string;
  toolAuditDeepLink: string;
  onClose: () => void;
}

type ReplayActionResult =
  | { ok: true; callId: string; result: { original: unknown; replay: unknown; replayedAt: string } }
  | { ok: false; error: string };

function ToolAuditDrawer({ span, threadId, toolAuditDeepLink, onClose }: ToolAuditDrawerProps) {
  const fetcher = useFetcher<ReplayActionResult>();
  if (!span) return null;
  const toolName =
    span.attributes[TOOL_ATTR] !== undefined ? String(span.attributes[TOOL_ATTR]) : span.name;
  const isReplaying = fetcher.state !== "idle";
  const lastResult = fetcher.data;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-charcoal-700 bg-charcoal-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <BoltIcon className="size-4 text-amber-400" />
          <h2 className="text-text-bright font-medium">Tool call</h2>
          <Badge variant={spanBadgeVariant(span)}>{span.status}</Badge>
        </div>
        <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
          <dt className="text-text-dimmed">Tool</dt>
          <dd className="font-mono text-text-bright">{toolName}</dd>
          <dt className="text-text-dimmed">Duration</dt>
          <dd className="text-text-bright">{fmtDuration(span.durationMs)}</dd>
          <dt className="text-text-dimmed">Span id</dt>
          <dd className="font-mono text-text-bright break-all">{span.spanId}</dd>
          <dt className="text-text-dimmed">Trace id</dt>
          <dd className="font-mono text-text-bright break-all">{span.traceId}</dd>
          <dt className="text-text-dimmed">Thread id</dt>
          <dd className="font-mono text-text-bright break-all">{threadId}</dd>
        </dl>
        <p className="mt-3 text-xs text-text-dimmed">
          Replay re-invokes the tool with the same args via the scoped executor. Billable — the
          replay endpoint rate-limits to 10 per minute per user. Result lands alongside a fresh
          audit row.
        </p>
        {lastResult && !lastResult.ok && (
          <div className="mt-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            Replay failed: {lastResult.error}
          </div>
        )}
        {lastResult && lastResult.ok && (
          <div className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
            <p className="mb-1">
              Replay dispatched at{" "}
              <span className="font-mono">
                {new Date(lastResult.result.replayedAt).toLocaleTimeString()}
              </span>
              .
            </p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
              {JSON.stringify(lastResult.result.replay, null, 2)}
            </pre>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <a
            href={toolAuditDeepLink}
            className="rounded border border-charcoal-600 bg-charcoal-800 px-3 py-1.5 text-xs text-text-bright hover:bg-charcoal-700"
          >
            Open in tool-audit
          </a>
          <button
            type="button"
            disabled={isReplaying}
            onClick={() =>
              fetcher.submit(
                {
                  intent: "replay_tool_audit",
                  spanId: span.spanId,
                  threadId,
                },
                { method: "post" },
              )
            }
            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
          >
            <ArrowPathIcon className={`size-3.5 ${isReplaying ? "animate-spin" : ""}`} />
            {isReplaying ? "Replaying..." : "Replay"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-charcoal-600 bg-charcoal-800 px-3 py-1.5 text-xs text-text-bright hover:bg-charcoal-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RollupBar({ rollup }: { rollup: TraceRollup }) {
  const cells: Array<{ label: string; value: string }> = [
    { label: "Messages", value: rollup.totalMessages.toLocaleString() },
    { label: "Spans", value: rollup.totalSpans.toLocaleString() },
    { label: "Tool calls", value: rollup.toolCallCount.toLocaleString() },
    { label: "Input tokens", value: rollup.totalInputTokens.toLocaleString() },
    { label: "Output tokens", value: rollup.totalOutputTokens.toLocaleString() },
    { label: "Cost", value: fmtCents(rollup.totalCostCents) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-md border border-charcoal-700 bg-charcoal-850 px-3 py-2"
        >
          <p className="text-[11px] text-text-dimmed">{c.label}</p>
          <p className="text-text-bright font-medium">{c.value}</p>
        </div>
      ))}
    </div>
  );
}

export default function TraceViewerPage() {
  const data = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const [filter, setFilter] = useState("");
  const [auditSpan, setAuditSpan] = useState<SpanNode | null>(null);

  const spanTree = useMemo<SpanNode[]>(
    () => (data.trace?.spanTree ?? []) as SpanNode[],
    [data.trace]
  );

  const backToConversation = data.trace?.thread
    ? `${agentConversationsPath(
        organization,
        project,
        environment,
        data.agentId
      )}/${data.threadId}`
    : agentConversationsPath(organization, project, environment, data.agentId);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={data.trace?.thread?.title || "Trace"}
          icon={<BoltIcon className="size-5 text-amber-500" />}
        />
        <PageAccessories>
          <LinkButton
            to={backToConversation}
            variant="tertiary/small"
            LeadingIcon={ArrowLeftIcon}
          >
            Back to Conversation
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        {data.reason === "agent_unavailable" && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            Agent service is not reachable. Trace data is frozen until it comes back online.
          </div>
        )}

        {data.reason === "not_found" && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <BoltIcon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="text-center max-w-md">
              No trace found for this thread in the current scope.
            </Paragraph>
            <p className="text-xs text-text-dimmed font-mono">thread: {data.threadId}</p>
          </div>
        )}

        {data.reason === "fetch_failed" && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
            Failed to load trace. Check the agent logs.
          </div>
        )}

        {data.trace && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-text-dimmed">
              <Badge variant={data.trace.thread?.status === "active" ? "success" : "outline-rounded"}>
                {data.trace.thread?.status ?? "unknown"}
              </Badge>
              <span>Turns: {data.trace.thread?.turnCount ?? 0}</span>
              {data.trace.rollup.firstMessageAt && (
                <span>
                  Started: {new Date(data.trace.rollup.firstMessageAt).toLocaleString()}
                </span>
              )}
              <span className="font-mono">thread {data.threadId.slice(0, 8)}</span>
            </div>

            <div className="mb-4">
              <RollupBar rollup={data.trace.rollup} />
            </div>

            <div className="mb-3 flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 size-4 text-text-dimmed" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter spans by name or attribute..."
                  className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 pl-7 pr-3 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>
              <span className="text-xs text-text-dimmed">
                {spanTree.length} root {spanTree.length === 1 ? "span" : "spans"}
              </span>
            </div>

            {spanTree.length === 0 ? (
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-4 py-10 text-center">
                <Paragraph variant="small" className="text-text-dimmed">
                  No spans recorded for this thread yet.
                </Paragraph>
                <p className="mt-1 text-[11px] text-text-dimmed">
                  Spans appear once the next turn runs with OTel sampling enabled.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {spanTree.map((root) => (
                  <SpanRow
                    key={root.spanId}
                    span={root}
                    depth={0}
                    filter={filter}
                    onOpenToolAudit={(s) => setAuditSpan(s)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <ToolAuditDrawer
          span={auditSpan}
          threadId={data.threadId}
          toolAuditDeepLink={`${agentMonitoringPath(
            organization,
            project,
            environment,
          )}?agentId=${encodeURIComponent(data.agentId)}`}
          onClose={() => setAuditSpan(null)}
        />
      </PageBody>
    </PageContainer>
  );
}
