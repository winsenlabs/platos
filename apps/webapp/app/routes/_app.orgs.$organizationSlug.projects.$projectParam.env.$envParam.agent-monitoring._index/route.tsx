import {
  ArrowPathIcon,
  ChartBarIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/20/solid";
import {
  useFetcher,
  useNavigate,
  useRevalidator,
  type MetaFunction,
} from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useEffect, useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentMonitoringUsersPath,
  agentTracePath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Monitoring | Platos" }];

// NOTE: `process.env.PLATOS_AGENT_API_URL` is resolved INSIDE `loader` — keeping
// it at module scope throws `ReferenceError: process is not defined` during
// Remix's client-side route-module evaluation on SPA navigation (nav-bounce bug).
const POLL_INTERVAL_MS = 15_000;

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

// PPR-22 — dropped "1h" + "1d" toggle options because the backend
// endpoints (cost-by-model, top-users, utilization) quantize at the day
// level. Offering sub-day filters was cosmetic and generated confused
// support tickets ("my 1h number is wrong"). Re-add when backends gain
// real sub-day aggregation buckets (tracked under a Theme E follow-up).
type TimeRange = "24h" | "7d" | "30d";

const TIME_RANGES: { id: TimeRange; label: string; days: number }[] = [
  { id: "24h", label: "Last 24h", days: 1 },
  { id: "7d", label: "Last 7d", days: 7 },
  { id: "30d", label: "Last 30d", days: 30 },
];

// Shared headline-card payload from `/monitoring/summary` (B.9, kept for E.8).
type Card = {
  id: string;
  label: string;
  value: number;
  unit: string;
  details?: Record<string, number>;
};

type SummaryPayload = {
  cards: Card[];
  // MC.3 — `costSeries` rows now also carry `cacheCreationInputTokens` +
  // `cacheReadInputTokens` + `costWithCacheCents`. Backend (CostService.
  // getScopeCostRange) emits them unconditionally as of MC.2; on pre-MC
  // days they are 0 / equal to naive costCents.
  costSeries: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    costWithCacheCents?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  }>;
  fetchedAt: string;
};

type CostByModelRow = {
  model: string;
  costCents: number;
  costWithCacheCents?: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  messages: number;
};

type CostByAgentRow = {
  agentId: string;
  agentName: string | null;
  costCents: number;
  costWithCacheCents?: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  threads: number;
};

type CostByUserRow = {
  userId: string;
  costCents: number;
  messages: number;
  threads: number;
};

type UtilizationPayload = {
  activeThreads: number;
  totalThreads: number;
  totalMessages: number;
  messagesByDay: Array<{ date: string; messages: number }>;
  newVsReturningUsers: { days: number; newUsers: number; returningUsers: number };
  topUsers: Array<{
    userId: string;
    messages: number;
    threads: number;
    costCents: number;
    lastActiveAt: string | null;
  }>;
  fetchedAt: string;
};

type ApprovalRow = {
  id: string;
  approvalId: string;
  source: string;
  agentId: string | null;
  threadId: string | null;
  requestedBy: string | null;
  action: string;
  details: string | null;
  status: string;
  timeoutSeconds: number;
  createdAt: string;
  resolvedAt: string | null;
  respondedBy: string | null;
  comment: string | null;
  deadlineAt: string | null;
  secondsRemaining: number | null;
  expired: boolean;
};

type ApprovalsPayload = {
  rows: ApprovalRow[];
  total: number;
  pendingCount: number;
  limit: number;
  offset: number;
  fetchedAt: string;
};

type ToolAuditRow = {
  id: string;
  toolName: string;
  entityId: string | null;
  agentId: string | null;
  threadId: string | null;
  status: string;
  latencyMs: number;
  error: string | null;
  createdAt: string;
  traceId: string | null;
  spanId: string | null;
};

type ToolAuditPayload = {
  rows: ToolAuditRow[];
  total: number;
  fetchedAt: string;
};

type AgentListRow = {
  id: string;
  name: string;
  slug: string;
  model: string;
};

// SM.2 — skill usage payloads. `SkillCostRangePayload` carries the aggregated
// breakdowns + the per-day time series for a sparkline.
type SkillRow = {
  slug: string;
  totalCents: number;
  calls: number;
  inputUnits: number;
  outputUnits: number;
  latencyMsTotal: number;
};

type SkillToolRow = {
  slug: string;
  tool: string;
  calls: number;
  latencyMsTotal: number;
};

type SkillAgentRow = {
  agentId: string;
  agentName: string | null;
  totalCents: number;
  calls: number;
};

type SkillProviderRow = {
  provider: string;
  totalCents: number;
  calls: number;
};

type SkillUsagePayload = {
  from: string;
  to: string;
  totalCostCents: number;
  totalCalls: number;
  perDay: Array<{ date: string; totalCostCents: number; totalCalls: number }>;
  bySkill: SkillRow[];
  byTool: SkillToolRow[];
  byAgent: SkillAgentRow[];
  byProvider: SkillProviderRow[];
  fetchedAt: string;
};

// PIFSP-10 — Memory extraction health per-agent aggregation.
type MemoryExtractionAgentRow = {
  agentId: string;
  agentName: string | null;
  totalExtracted: number;
  byKind: Record<string, number>;
  lastRunAt: string | null;
};

type MemoryExtractionHealthPayload = {
  rows: MemoryExtractionAgentRow[];
  windowHours: number;
  fetchedAt: string;
};

type MonitoringTab = "overview" | "skills" | "users";

type LoaderData = {
  agentReachable: boolean;
  range: TimeRange;
  tab: MonitoringTab;
  agentId: string | null;
  agents: AgentListRow[];
  summary: SummaryPayload | null;
  costByModel: CostByModelRow[];
  costByAgent: CostByAgentRow[];
  costByUser: CostByUserRow[];
  utilization: UtilizationPayload | null;
  approvals: ApprovalsPayload | null;
  toolFailures: ToolAuditPayload | null;
  skillUsage: SkillUsagePayload | null;
  memoryExtractionHealth: MemoryExtractionHealthPayload | null;
  actionMessage: string | null;
};

function parseRange(raw: string | null | undefined): TimeRange {
  // PPR-22 — accept legacy "1h"/"1d" query params by remapping to "24h" so
  // bookmarked URLs don't break while we migrate.
  if (raw === "1h" || raw === "1d") return "24h";
  if (raw === "24h" || raw === "7d" || raw === "30d") return raw;
  return "7d";
}

function parseTab(raw: string | null | undefined): MonitoringTab {
  return raw === "skills" ? "skills" : "overview";
}

// SM.2 — derive the inclusive [from,to] window for the skill-usage range
// endpoint from the existing TimeRange filter. Reuses the 1 / 7 / 30 day
// bucketing the rest of the dashboard uses; no new picker.
function rangeToSkillWindow(range: TimeRange): { from: string; to: string } {
  const today = new Date();
  const days = rangeDays(range);
  const fromDate = new Date(today.getTime() - (days - 1) * 86400_000);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

function rangeDays(range: TimeRange): number {
  // PPR-22 — ranges map 1:1 to `sinceDays` on the backend endpoints.
  // Sub-day buckets (1h) were dropped because every backend aggregates at
  // day granularity; returning the same number for both 1h and 1d lied
  // to the user.
  if (range === "30d") return 30;
  if (range === "7d") return 7;
  return 1; // "24h"
}

async function agentGet<T>(
  path: string,
  scope: Scope,
  opts: { timeoutMs?: number } = {}
): Promise<T | null> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      },
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const tab = parseTab(url.searchParams.get("tab"));
  const agentIdFilter = url.searchParams.get("agentId") || null;
  const days = rangeDays(range);

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const { isAgentServiceAvailable, listAgents } = await import(
    "~/services/platosAgent.server"
  );
  let agentReachable = false;
  try {
    agentReachable = await isAgentServiceAvailable();
  } catch {
    agentReachable = false;
  }

  if (!agentReachable) {
    const payload: LoaderData = {
      agentReachable: false,
      range,
      tab,
      agentId: agentIdFilter,
      agents: [],
      summary: null,
      costByModel: [],
      costByAgent: [],
      costByUser: [],
      utilization: null,
      approvals: null,
      toolFailures: null,
      skillUsage: null,
      memoryExtractionHealth: null,
      actionMessage: null,
    };
    return typedjson(payload);
  }

  const agentFilterQuery = agentIdFilter ? `&agentId=${encodeURIComponent(agentIdFilter)}` : "";
  const skillWindow = rangeToSkillWindow(range);

  const [
    agentsResp,
    summary,
    costByModelResp,
    costByAgentResp,
    costByUserResp,
    utilization,
    approvals,
    toolFailures,
    skillUsage,
    memoryExtractionHealth,
  ] = await Promise.all([
    listAgents(scope).catch(() => ({ agents: [] as any[] })),
    agentGet<SummaryPayload>("/api/v1/agent/monitoring/summary", scope),
    agentGet<{ rows: CostByModelRow[] }>(
      `/api/v1/agent/monitoring/cost-by-model?days=${days}&limit=8`,
      scope
    ),
    agentGet<{ rows: CostByAgentRow[] }>(
      `/api/v1/agent/monitoring/cost-by-agent?days=${days}&limit=8`,
      scope
    ),
    agentGet<{ rows: CostByUserRow[] }>(
      `/api/v1/agent/monitoring/cost-by-user?days=${days}&limit=8`,
      scope
    ),
    agentGet<UtilizationPayload>(
      `/api/v1/agent/monitoring/utilization?days=${days}`,
      scope
    ),
    agentGet<ApprovalsPayload>(
      `/api/v1/agent/monitoring/approvals?sinceDays=${days}&limit=20${agentFilterQuery}`,
      scope
    ),
    agentGet<ToolAuditPayload>(
      `/api/v1/agent/monitoring/tool-audit?sinceDays=${days}&status=failed&limit=20${agentFilterQuery}`,
      scope
    ),
    // SM.2 — skill usage range payload. Fetched on every load so the tab
    // switch is instant; the Redis SCAN cost is negligible for 1–30 days.
    agentGet<SkillUsagePayload>(
      `/api/v1/agent/monitoring/cost/skills/range?from=${skillWindow.from}&to=${skillWindow.to}`,
      scope
    ),
    // PIFSP-10 — memory extraction health (last 24h window, top 20 agents).
    agentGet<MemoryExtractionHealthPayload>(
      `/api/v1/agent/monitoring/memory-extraction/health${agentIdFilter ? `?agentId=${encodeURIComponent(agentIdFilter)}` : ""}`,
      scope
    ),
  ]);

  const agents: AgentListRow[] = (agentsResp?.agents ?? []).map((a: any) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    model: a.model,
  }));

  const filterByAgent = <T extends { agentId?: string | null }>(rows: T[]): T[] => {
    if (!agentIdFilter) return rows;
    return rows.filter((r) => r.agentId === agentIdFilter);
  };

  // SM.2 — when an agent filter is active, narrow the skill-usage breakdowns
  // to that agent too (keeps the tab in sync with the global scope filter).
  const filteredSkillUsage: SkillUsagePayload | null = skillUsage
    ? {
        ...skillUsage,
        byAgent: agentIdFilter
          ? skillUsage.byAgent.filter((r) => r.agentId === agentIdFilter)
          : skillUsage.byAgent,
      }
    : null;

  const payload: LoaderData = {
    agentReachable,
    range,
    tab,
    agentId: agentIdFilter,
    agents,
    summary,
    // cost-by-model has no agent dimension — show as-is regardless of filter.
    costByModel: costByModelResp?.rows ?? [],
    costByAgent: agentIdFilter
      ? (costByAgentResp?.rows ?? []).filter((r) => r.agentId === agentIdFilter)
      : costByAgentResp?.rows ?? [],
    costByUser: costByUserResp?.rows ?? [],
    utilization,
    approvals,
    toolFailures: toolFailures
      ? { ...toolFailures, rows: filterByAgent(toolFailures.rows) }
      : null,
    skillUsage: filteredSkillUsage,
    memoryExtractionHealth,
    actionMessage: null,
  };
  return typedjson(payload);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "resolve_approval") {
    const approvalId = String(form.get("approvalId") || "");
    const approved = form.get("decision") === "approve";
    const comment = (form.get("comment") as string | null) || undefined;
    if (!approvalId) {
      return typedjson({ ok: false, error: "approvalId missing" }, { status: 400 });
    }
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/approvals/${approvalId}/resolve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Organization-Id": project.organizationId,
            "X-Platos-Project-Id": project.id,
            "X-Platos-Environment-Id": environment.id,
            "X-Platos-User-Id": userId,
          },
          body: JSON.stringify({ approved, comment }),
        }
      );
      if (!res.ok) {
        return typedjson(
          { ok: false, error: `agent returned ${res.status}` },
          { status: 502 }
        );
      }
      return typedjson({ ok: true, approvalId, approved });
    } catch (err) {
      return typedjson(
        { ok: false, error: err instanceof Error ? err.message : "fetch failed" },
        { status: 502 }
      );
    }
  }

  return typedjson({ ok: false, error: "unknown intent" }, { status: 400 });
}

// ══════════════════════════════════════════════════════════
// Formatters / small components
// ══════════════════════════════════════════════════════════

function fmtCents(cents: number | null | undefined): string {
  if (!cents || cents <= 0) return "$0.00";
  if (cents < 100) return `$${(cents / 100).toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtCard(card: Card): string {
  if (card.unit === "cents") return fmtCents(card.value);
  return card.value.toLocaleString();
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "0";
  return n.toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtUpdatedAgo(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function fmtSlaClock(row: ApprovalRow): string {
  if (row.status !== "pending") {
    return row.status;
  }
  if (row.expired) return "expired";
  if (row.secondsRemaining === null) return "—";
  const s = row.secondsRemaining;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function slaBadgeVariant(row: ApprovalRow): "success" | "error" | "outline-rounded" {
  if (row.status === "approved") return "success";
  if (row.status === "rejected" || row.status === "timed_out" || row.expired) return "error";
  return "outline-rounded";
}

function StatCard({ card }: { card: Card }) {
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
      <p className="mb-1 text-xs text-text-dimmed">{card.label}</p>
      <p className="text-2xl font-semibold text-text-bright">{fmtCard(card)}</p>
      {card.details && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-text-dimmed">
          {Object.entries(card.details).map(([k, v]) => (
            <span key={k}>
              <span className="font-mono">{v.toLocaleString()}</span>{" "}
              {k.replace(/Tokens$/, " tokens")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function HBar({
  label,
  sublabel,
  value,
  maxValue,
  colour,
  rightLabel,
}: {
  label: string;
  sublabel?: string;
  value: number;
  maxValue: number;
  colour: string;
  rightLabel: string;
}) {
  const pct = maxValue > 0 ? Math.max(2, Math.round((value / maxValue) * 100)) : 2;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-text-bright" title={label}>
          {label}
        </span>
        <span className="font-mono text-text-dimmed">{rightLabel}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-sm bg-charcoal-800">
        <div className={`${colour} h-full`} style={{ width: `${pct}%` }} />
      </div>
      {sublabel && (
        <span className="text-[10px] text-charcoal-400">{sublabel}</span>
      )}
    </div>
  );
}

function MessagesTrend({ data }: { data: UtilizationPayload["messagesByDay"] }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-xs text-text-dimmed">
        No message activity in this window.
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.messages));
  return (
    <div className="flex h-16 items-end gap-1">
      {data.map((d) => {
        const h = Math.max(2, Math.round((d.messages / max) * 60));
        return (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-sm bg-emerald-500/60 hover:bg-emerald-400"
              style={{ height: `${h}px` }}
              title={`${d.date}: ${d.messages}`}
            />
            <span className="text-[9px] text-text-dimmed">{d.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function CostSparkline({ series }: { series: SummaryPayload["costSeries"] }) {
  if (!series || series.length === 0) return null;
  const days = [...series].reverse(); // oldest → newest
  const maxCost = Math.max(1, ...days.map((d) => d.costCents));
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
      <p className="mb-2 text-xs text-text-dimmed">Spend last 7 days (cents / day)</p>
      <div className="flex h-16 items-end gap-1">
        {days.map((d) => {
          const h = Math.max(2, Math.round((d.costCents / maxCost) * 60));
          return (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-sm bg-rose-500/60 hover:bg-rose-400"
                style={{ height: `${h}px` }}
                title={`${d.date}: ${fmtCents(d.costCents)}`}
              />
              <span className="text-[9px] text-text-dimmed">{d.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PanelHeading({
  icon,
  title,
  hint,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-2">
      <div className="flex items-center gap-2">
        <span>{icon}</span>
        <h3 className="text-sm font-semibold text-text-bright">{title}</h3>
        {hint && <span className="text-[11px] text-text-dimmed">{hint}</span>}
      </div>
      {right}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// Page
// ══════════════════════════════════════════════════════════

export default function AgentMonitoringPage() {
  const data = useTypedLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const resolveFetcher = useFetcher<{ ok?: boolean; error?: string; approvalId?: string; approved?: boolean }>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const applyFilters = (patch: {
    range?: TimeRange;
    agentId?: string | null;
    tab?: MonitoringTab;
  }) => {
    const nextRange = patch.range ?? data.range;
    const nextAgent = patch.agentId === undefined ? data.agentId : patch.agentId;
    const nextTab = patch.tab ?? data.tab;
    const qs = new URLSearchParams();
    qs.set("range", nextRange);
    if (nextAgent) qs.set("agentId", nextAgent);
    if (nextTab && nextTab !== "overview") qs.set("tab", nextTab);
    navigate(`?${qs.toString()}`, { replace: true });
  };

  const [lastUpdated, setLastUpdated] = useState<number>(() => Date.now());
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    setLastUpdated(Date.now());
  }, [data]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (revalidator.state === "loading") return;
      revalidator.revalidate();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [revalidator]);

  useEffect(() => {
    const tick = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // After a resolve fetch lands, refresh the whole dashboard so the approval
  // row moves to its terminal status and the pending-count card drops.
  useEffect(() => {
    if (resolveFetcher.state === "idle" && resolveFetcher.data?.ok) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveFetcher.state, resolveFetcher.data?.ok]);

  const updatedAgoSeconds = Math.max(0, Math.floor((nowTick - lastUpdated) / 1000));
  const isRevalidating = revalidator.state === "loading";

  const cards = data.summary?.cards ?? [];
  const costSeries = data.summary?.costSeries ?? [];

  // MC.3 — aggregate cache token + savings totals from the per-day series.
  // Savings = cache_read_tokens * 0.9 * average_input_rate (the user's
  // avoided spend vs paying full input price). We back into the average
  // input rate from the naive costCents + inputTokens totals rather than
  // calling LiteLLM from the browser. Zero when no cache activity.
  const cacheStats = useMemo(() => {
    let created = 0;
    let read = 0;
    let naiveCents = 0;
    let withCacheCents = 0;
    let inputTokens = 0;
    for (const d of costSeries) {
      created += d.cacheCreationInputTokens ?? 0;
      read += d.cacheReadInputTokens ?? 0;
      naiveCents += d.costCents ?? 0;
      withCacheCents += d.costWithCacheCents ?? d.costCents ?? 0;
      inputTokens += d.inputTokens ?? 0;
    }
    // Back-of-napkin: per-million-token input rate (cents) derived from
    // historical rows in the window. Falls back to 200c/M (rough Sonnet
    // rate) if we somehow have cache tokens without any paid input.
    const inputRateCentsPerMillion =
      inputTokens > 0 ? (naiveCents / inputTokens) * 1_000_000 : 200;
    const savingsCents = (read / 1_000_000) * inputRateCentsPerMillion * 0.9;
    return {
      created,
      read,
      savingsCents: Math.max(0, Math.round(savingsCents * 100) / 100),
      withCacheCents,
      naiveCents,
    };
  }, [costSeries]);
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of data.agents) map.set(a.id, a.name);
    return map;
  }, [data.agents]);

  const maxModelCost = data.costByModel.reduce((m, r) => Math.max(m, r.costCents), 0);
  const maxAgentCost = data.costByAgent.reduce((m, r) => Math.max(m, r.costCents), 0);
  const maxUserCost = data.costByUser.reduce((m, r) => Math.max(m, r.costCents), 0);

  const pendingApprovals = data.approvals?.rows.filter((r) => r.status === "pending") ?? [];

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Agent Monitoring"
          icon={<ShieldCheckIcon className="size-5 text-rose-500" />}
        />
        <PageAccessories>
          <div className="flex items-center gap-2 text-xs text-text-dimmed">
            {isRevalidating ? (
              <Badge variant="outline-rounded">Refreshing…</Badge>
            ) : (
              <span>Updated {fmtUpdatedAgo(updatedAgoSeconds)}</span>
            )}
            <button
              type="button"
              onClick={() => revalidator.revalidate()}
              className="inline-flex items-center gap-1 rounded-sm border border-charcoal-700 bg-charcoal-850 px-2 py-1 text-[11px] text-text-bright hover:border-charcoal-600"
            >
              <ArrowPathIcon className="size-3" />
              Refresh
            </button>
          </div>
          <DocsLink slug="monitoring" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        {/* SM.2 — Overview vs Skill-usage tab switcher. Mirrors the range-
            filter chip group styling so the two look of a piece. */}
        <div className="mb-4 flex items-center gap-2 border-b border-charcoal-800">
          {([
            { id: "overview" as MonitoringTab, label: "Overview" },
            { id: "skills" as MonitoringTab, label: "Skill usage" },
          ]).map((t) => {
            const active = data.tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => applyFilters({ tab: t.id })}
                className={`border-b-2 px-3 py-2 text-sm ${
                  active
                    ? "border-rose-500 text-text-bright"
                    : "border-transparent text-text-dimmed hover:text-text-bright"
                }`}
              >
                {t.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => navigate(agentMonitoringUsersPath(organization, project, environment))}
            className="border-b-2 border-transparent px-3 py-2 text-sm text-text-dimmed hover:text-text-bright"
          >
            Users
          </button>
        </div>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex overflow-hidden rounded-md border border-charcoal-700">
            {TIME_RANGES.map((r) => {
              const active = data.range === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => applyFilters({ range: r.id })}
                  className={`px-3 py-1 text-xs ${
                    active
                      ? "bg-charcoal-750 text-text-bright"
                      : "bg-charcoal-900 text-text-dimmed hover:bg-charcoal-800"
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-text-dimmed">
            Agent
            <select
              value={data.agentId ?? ""}
              className="rounded-sm border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
              onChange={(e) => applyFilters({ agentId: e.currentTarget.value || null })}
            >
              <option value="">All agents</option>
              {data.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Scope: {organization.slug} / {project.slug} / {environment.slug}
          </Paragraph>
        </div>

        {!data.agentReachable && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            Agent service is not reachable. Panels are frozen until it comes back online.
          </div>
        )}

        {data.tab === "overview" && (
          <>
        {/* Row 1: headline stat cards */}
        <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          {cards.length === 0 ? (
            <div className="col-span-full rounded-lg border border-charcoal-700 bg-charcoal-850 p-4 text-xs text-text-dimmed">
              No activity yet — send a message to any agent to populate headline counters.
            </div>
          ) : (
            cards.map((card) => <StatCard key={card.id} card={card} />)
          )}
          {data.approvals && (
            <StatCard
              card={{
                id: "pending_approvals",
                label: "Pending approvals",
                value: data.approvals.pendingCount,
                unit: "approvals",
              }}
            />
          )}
          {data.toolFailures && (
            <StatCard
              card={{
                id: "tool_failures",
                label: `Tool failures (last ${rangeDays(data.range)}d)`,
                value: data.toolFailures.total,
                unit: "calls",
              }}
            />
          )}
        </div>

        {/* MC.3 — Anthropic prompt-cache tiles. Only render when cache
            activity has been recorded in the window; on non-Anthropic
            providers or fresh scopes these all read 0, and showing
            three empty tiles is noise. */}
        {(cacheStats.created > 0 || cacheStats.read > 0) && (
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <StatCard
              card={{
                id: "cache_tokens_written",
                label: "Cached tokens written",
                value: cacheStats.created,
                unit: "tokens",
              }}
            />
            <StatCard
              card={{
                id: "cache_tokens_read",
                label: "Cached tokens read",
                value: cacheStats.read,
                unit: "tokens",
              }}
            />
            <StatCard
              card={{
                id: "cache_savings",
                label: "Cache savings (USD)",
                value: cacheStats.savingsCents,
                unit: "cents",
                details: {
                  naiveSpendCents: Math.round(cacheStats.naiveCents * 100) / 100,
                  billedCents: Math.round(cacheStats.withCacheCents * 100) / 100,
                },
              }}
            />
          </div>
        )}

        {/* Row 2: cost sparkline + messages-per-day trend */}
        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <CostSparkline series={costSeries} />
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <PanelHeading
              icon={<ChartBarIcon className="size-4 text-emerald-400" />}
              title="Messages per day"
              hint={`last ${rangeDays(data.range)}d`}
            />
            <MessagesTrend data={data.utilization?.messagesByDay ?? []} />
            {data.utilization && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-dimmed">
                <span>
                  Active threads{" "}
                  <span className="font-mono text-text-bright">
                    {fmtNum(data.utilization.activeThreads)}
                  </span>
                </span>
                <span>
                  Total messages{" "}
                  <span className="font-mono text-text-bright">
                    {fmtNum(data.utilization.totalMessages)}
                  </span>
                </span>
                <span>
                  New users{" "}
                  <span className="font-mono text-text-bright">
                    {fmtNum(data.utilization.newVsReturningUsers.newUsers)}
                  </span>
                </span>
                <span>
                  Returning{" "}
                  <span className="font-mono text-text-bright">
                    {fmtNum(data.utilization.newVsReturningUsers.returningUsers)}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Row 3: three cost-breakdown panels side by side */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <PanelHeading
              icon={<ChartBarIcon className="size-4 text-rose-400" />}
              title="Cost by model"
              hint={`last ${rangeDays(data.range)}d`}
            />
            {data.costByModel.length === 0 ? (
              <Paragraph variant="extra-small" className="text-text-dimmed">
                No assistant messages in this window.
              </Paragraph>
            ) : (
              <div className="flex flex-col gap-3">
                {data.costByModel.map((row) => (
                  <HBar
                    key={row.model}
                    label={row.model}
                    sublabel={`${fmtNum(row.inputTokens)} in / ${fmtNum(row.outputTokens)} out · ${row.messages} msg`}
                    value={row.costCents}
                    maxValue={maxModelCost}
                    colour="bg-rose-500/60"
                    rightLabel={fmtCents(row.costCents)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <PanelHeading
              icon={<ChartBarIcon className="size-4 text-blue-400" />}
              title="Cost by agent"
              hint={`last ${rangeDays(data.range)}d`}
            />
            {data.costByAgent.length === 0 ? (
              <Paragraph variant="extra-small" className="text-text-dimmed">
                No per-agent cost recorded yet.
              </Paragraph>
            ) : (
              <div className="flex flex-col gap-3">
                {data.costByAgent.map((row) => (
                  <HBar
                    key={row.agentId}
                    label={row.agentName ?? row.agentId.slice(0, 8)}
                    sublabel={`${row.threads} thread(s) · ${fmtNum(row.inputTokens + row.outputTokens)} tokens`}
                    value={row.costCents}
                    maxValue={maxAgentCost}
                    colour="bg-blue-500/60"
                    rightLabel={fmtCents(row.costCents)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <PanelHeading
              icon={<ChartBarIcon className="size-4 text-amber-400" />}
              title="Cost by user"
              hint={`last ${rangeDays(data.range)}d`}
            />
            {data.costByUser.length === 0 ? (
              <Paragraph variant="extra-small" className="text-text-dimmed">
                No user activity in this window.
              </Paragraph>
            ) : (
              <div className="flex flex-col gap-3">
                {data.costByUser.map((row) => (
                  <HBar
                    key={row.userId}
                    label={row.userId}
                    sublabel={`${row.messages} msg · ${row.threads} thread(s)`}
                    value={row.costCents}
                    maxValue={maxUserCost}
                    colour="bg-amber-500/60"
                    rightLabel={fmtCents(row.costCents)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Row 4: top users */}
        {data.utilization && data.utilization.topUsers.length > 0 && (
          <div className="mb-4 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <PanelHeading
              icon={<ChartBarIcon className="size-4 text-emerald-400" />}
              title="Top users"
              hint={`last ${rangeDays(data.range)}d · by message count`}
            />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>User ID</TableHeaderCell>
                  <TableHeaderCell>Messages</TableHeaderCell>
                  <TableHeaderCell>Threads</TableHeaderCell>
                  <TableHeaderCell>Spend</TableHeaderCell>
                  <TableHeaderCell>Last active</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.utilization.topUsers.map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell>
                      <span className="font-mono text-xs">{u.userId}</span>
                    </TableCell>
                    <TableCell>{fmtNum(u.messages)}</TableCell>
                    <TableCell>{fmtNum(u.threads)}</TableCell>
                    <TableCell>{fmtCents(u.costCents)}</TableCell>
                    <TableCell>
                      {u.lastActiveAt
                        ? new Date(u.lastActiveAt).toLocaleString()
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Row 5: approvals queue */}
        <div className="mb-4 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
          <PanelHeading
            icon={<ClockIcon className="size-4 text-amber-400" />}
            title="Approval queue"
            hint={
              data.approvals
                ? `${data.approvals.pendingCount} pending · ${data.approvals.total} total (last ${rangeDays(data.range)}d)`
                : undefined
            }
          />
          {!data.approvals || data.approvals.rows.length === 0 ? (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              No approval requests in this window.
            </Paragraph>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Action</TableHeaderCell>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Thread</TableHeaderCell>
                  <TableHeaderCell>Opened</TableHeaderCell>
                  <TableHeaderCell>SLA</TableHeaderCell>
                  <TableHeaderCell>Trace</TableHeaderCell>
                  <TableHeaderCell>Decision</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.approvals.rows.map((row) => {
                  const isPending = row.status === "pending" && !row.expired;
                  const agentName =
                    row.agentId && agentNameById.get(row.agentId)
                      ? agentNameById.get(row.agentId)!
                      : row.agentId?.slice(0, 8) ?? "—";
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span
                            className="max-w-[20rem] truncate font-mono text-xs"
                            title={row.action}
                          >
                            {row.action}
                          </span>
                          <span className="text-[10px] text-text-dimmed">
                            {row.source}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{agentName}</TableCell>
                      <TableCell>
                        {row.threadId && row.agentId ? (
                          <a
                            href={agentTracePath(
                              organization,
                              project,
                              environment,
                              row.agentId,
                              row.threadId
                            )}
                            className="font-mono text-xs text-blue-400 hover:underline"
                          >
                            {row.threadId.slice(0, 8)}
                          </a>
                        ) : (
                          <span className="font-mono text-xs text-text-dimmed">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-text-dimmed">
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={slaBadgeVariant(row)}>{fmtSlaClock(row)}</Badge>
                      </TableCell>
                      <TableCell>
                        {/* PPR-62 — explicit deep-link to the per-thread trace so
                            reviewers can see why the agent asked for approval
                            without having to hunt through conversations first. */}
                        {row.threadId && row.agentId ? (
                          <a
                            href={agentTracePath(
                              organization,
                              project,
                              environment,
                              row.agentId,
                              row.threadId
                            )}
                            className="text-[11px] text-blue-400 hover:underline"
                          >
                            View trace
                          </a>
                        ) : (
                          <span className="text-[11px] text-text-dimmed">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isPending ? (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={resolveFetcher.state !== "idle"}
                              onClick={() =>
                                resolveFetcher.submit(
                                  {
                                    intent: "resolve_approval",
                                    approvalId: row.approvalId,
                                    decision: "approve",
                                  },
                                  { method: "post" }
                                )
                              }
                              className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={resolveFetcher.state !== "idle"}
                              onClick={() =>
                                resolveFetcher.submit(
                                  {
                                    intent: "resolve_approval",
                                    approvalId: row.approvalId,
                                    decision: "reject",
                                  },
                                  { method: "post" }
                                )
                              }
                              className="rounded-sm border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-text-dimmed">
                            {row.respondedBy ? `by ${row.respondedBy.slice(0, 8)}` : "—"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {pendingApprovals.length === 0 && (data.approvals?.rows.length ?? 0) > 0 && (
            <Paragraph variant="extra-small" className="mt-2 text-text-dimmed">
              No pending approvals — showing recent resolved entries.
            </Paragraph>
          )}
          {resolveFetcher.data && !resolveFetcher.data.ok && (
            <Paragraph variant="extra-small" className="mt-2 text-rose-400">
              Resolve failed: {resolveFetcher.data.error}
            </Paragraph>
          )}
        </div>

        {/* Row 6: tool failures */}
        <div className="mb-4 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
          <PanelHeading
            icon={<ExclamationTriangleIcon className="size-4 text-rose-400" />}
            title="Tool failures"
            hint={
              data.toolFailures
                ? `${data.toolFailures.rows.length} shown of ${data.toolFailures.total} (last ${rangeDays(data.range)}d)`
                : undefined
            }
          />
          {!data.toolFailures || data.toolFailures.rows.length === 0 ? (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              No failed tool calls in this window. Nice.
            </Paragraph>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Tool</TableHeaderCell>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Thread</TableHeaderCell>
                  <TableHeaderCell>Error</TableHeaderCell>
                  <TableHeaderCell>Latency</TableHeaderCell>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Trace</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.toolFailures.rows.map((row) => {
                  const agentName =
                    row.agentId && agentNameById.get(row.agentId)
                      ? agentNameById.get(row.agentId)!
                      : row.agentId?.slice(0, 8) ?? "—";
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <span className="font-mono text-xs">{row.toolName}</span>
                      </TableCell>
                      <TableCell>{agentName}</TableCell>
                      <TableCell>
                        {row.threadId && row.agentId ? (
                          <a
                            href={agentTracePath(
                              organization,
                              project,
                              environment,
                              row.agentId,
                              row.threadId
                            )}
                            className="font-mono text-xs text-blue-400 hover:underline"
                          >
                            {row.threadId.slice(0, 8)}
                          </a>
                        ) : (
                          <span className="font-mono text-xs text-text-dimmed">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className="block max-w-[22rem] truncate text-xs text-rose-300"
                          title={row.error ?? ""}
                        >
                          {row.error ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell>{fmtDuration(row.latencyMs)}</TableCell>
                      <TableCell>
                        <span className="text-xs text-text-dimmed">
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        {/* PPR-62 — explicit "View trace" link per failure row so
                            oncall can pivot straight from the failure list to
                            the span tree. */}
                        {row.threadId && row.agentId ? (
                          <a
                            href={agentTracePath(
                              organization,
                              project,
                              environment,
                              row.agentId,
                              row.threadId
                            )}
                            className="text-[11px] text-blue-400 hover:underline"
                          >
                            View trace
                          </a>
                        ) : (
                          <span className="text-[11px] text-text-dimmed">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
          </>
        )}

        {/* PIFSP-10 — Memory extraction health widget */}
        {data.tab === "overview" && data.memoryExtractionHealth && (
          <MemoryExtractionHealthPanel payload={data.memoryExtractionHealth} agentNameById={agentNameById} />
        )}

        {data.tab === "skills" && (
          <SkillUsageTab
            payload={data.skillUsage}
            range={data.range}
            agentNameById={agentNameById}
          />
        )}
      </PageBody>
    </PageContainer>
  );
}

// ══════════════════════════════════════════════════════════
// PIFSP-10 — Memory extraction health panel
// ══════════════════════════════════════════════════════════

function MemoryExtractionHealthPanel({
  payload,
  agentNameById,
}: {
  payload: MemoryExtractionHealthPayload;
  agentNameById: Map<string, string>;
}) {
  if (!payload || payload.rows.length === 0) {
    return (
      <div className="mb-4 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
        <PanelHeading
          icon={<ClockIcon className="size-4 text-teal-400" />}
          title="Memory extraction health"
          hint="Last 24h"
        />
        <Paragraph variant="extra-small" className="text-text-dimmed">
          No memory extraction events in the last 24 hours.
        </Paragraph>
      </div>
    );
  }

  const maxExtracted = Math.max(1, ...payload.rows.map((r) => r.totalExtracted));

  return (
    <div className="mb-4 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
      <PanelHeading
        icon={<ClockIcon className="size-4 text-teal-400" />}
        title="Memory extraction health"
        hint={`Last ${payload.windowHours}h · ${payload.rows.length} agent(s)`}
      />
      <div className="flex flex-col gap-3">
        {payload.rows.map((row) => {
          const name =
            row.agentName ?? agentNameById.get(row.agentId) ?? row.agentId.slice(0, 8);
          const kinds = Object.entries(row.byKind)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ");
          const lastRun = row.lastRunAt
            ? new Date(row.lastRunAt).toLocaleString()
            : "never";
          return (
            <HBar
              key={row.agentId}
              label={name}
              sublabel={`${kinds || "no kinds"} · last run ${lastRun}`}
              value={row.totalExtracted}
              maxValue={maxExtracted}
              colour="bg-teal-500/60"
              rightLabel={fmtNum(row.totalExtracted)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// SM.2 — Skill usage tab
// ══════════════════════════════════════════════════════════

function SkillSpendSparkline({ series }: { series: SkillUsagePayload["perDay"] }) {
  if (!series || series.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-xs text-text-dimmed">
        No skill usage in this window.
      </div>
    );
  }
  const maxCost = Math.max(1, ...series.map((d) => d.totalCostCents));
  return (
    <div className="flex h-16 items-end gap-1">
      {series.map((d) => {
        const h = Math.max(2, Math.round((d.totalCostCents / maxCost) * 60));
        return (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-sm bg-violet-500/60 hover:bg-violet-400"
              style={{
                height: `${h}px`,
              }}
              title={`${d.date}: ${fmtCents(d.totalCostCents)} · ${d.totalCalls} call(s)`}
            />
            <span className="text-[9px] text-text-dimmed">{d.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function SkillUsageTab({
  payload,
  range,
  agentNameById,
}: {
  payload: SkillUsagePayload | null;
  range: TimeRange;
  agentNameById: Map<string, string>;
}) {
  // Fail-graceful empty state — SM.1 may not have recorded anything yet
  // (new scope, skills not enabled, or Redis flushed). The loader returns
  // null on a non-2xx from the agent; we render the same placeholder in
  // that case.
  if (!payload || (payload.bySkill.length === 0 && payload.byTool.length === 0)) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-6 text-center">
          <ChartBarIcon className="mx-auto mb-2 size-6 text-text-dimmed" />
          <p className="text-sm text-text-bright">No skill usage in this window</p>
          <p className="mt-1 text-xs text-text-dimmed">
            Invoke a skill tool from any agent to populate this tab. Usage events are
            written by <span className="font-mono">SkillRuntimeService</span> to Redis
            with 90-day TTL (SM.1).
          </p>
        </div>
      </div>
    );
  }

  const topSkill = payload.bySkill[0];
  const topTool = payload.byTool[0];
  const maxSkillCost = payload.bySkill.reduce((m, r) => Math.max(m, r.totalCents), 0);
  const maxToolCalls = payload.byTool.reduce((m, r) => Math.max(m, r.calls), 0);
  const maxAgentCost = payload.byAgent.reduce((m, r) => Math.max(m, r.totalCents), 0);
  const maxProviderCost = payload.byProvider.reduce((m, r) => Math.max(m, r.totalCents), 0);
  const rangeDaysLabel = `last ${rangeDays(range)}d`;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          card={{
            id: "skill_total_spend",
            label: "Total skill spend",
            value: payload.totalCostCents,
            unit: "cents",
          }}
        />
        <StatCard
          card={{
            id: "skill_tool_calls",
            label: "Tool calls",
            value: payload.totalCalls,
            unit: "calls",
          }}
        />
        <StatCard
          card={{
            id: "skill_top_skill",
            label: "Top skill",
            value: topSkill?.totalCents ?? 0,
            unit: "cents",
            details: topSkill ? { [topSkill.slug]: topSkill.calls } : undefined,
          }}
        />
        <StatCard
          card={{
            id: "skill_top_tool",
            label: "Top tool",
            value: topTool?.calls ?? 0,
            unit: "calls",
            details: topTool ? { [`${topTool.slug}/${topTool.tool}`]: topTool.calls } : undefined,
          }}
        />
      </div>

      {/* Spend sparkline */}
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
        <PanelHeading
          icon={<ChartBarIcon className="size-4 text-violet-400" />}
          title="Skill spend per day"
          hint={rangeDaysLabel}
        />
        <SkillSpendSparkline series={payload.perDay} />
      </div>

      {/* Row: by skill + by provider */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
          <PanelHeading
            icon={<ChartBarIcon className="size-4 text-violet-400" />}
            title="By skill"
            hint={rangeDaysLabel}
          />
          {payload.bySkill.length === 0 ? (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              No skill calls in this window.
            </Paragraph>
          ) : (
            <div className="flex flex-col gap-3">
              {payload.bySkill.map((row) => (
                <HBar
                  key={row.slug}
                  label={row.slug}
                  sublabel={`${fmtNum(row.calls)} call(s) · ${fmtNum(row.inputUnits)} in / ${fmtNum(row.outputUnits)} out`}
                  value={row.totalCents}
                  maxValue={maxSkillCost}
                  colour="bg-violet-500/60"
                  rightLabel={fmtCents(row.totalCents)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
          <PanelHeading
            icon={<ChartBarIcon className="size-4 text-amber-400" />}
            title="By provider"
            hint={rangeDaysLabel}
          />
          {payload.byProvider.length === 0 ? (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              No provider attribution recorded.
            </Paragraph>
          ) : (
            <div className="flex flex-col gap-3">
              {payload.byProvider.map((row) => (
                <HBar
                  key={row.provider}
                  label={row.provider}
                  sublabel={`${fmtNum(row.calls)} call(s)`}
                  value={row.totalCents}
                  maxValue={maxProviderCost}
                  colour="bg-amber-500/60"
                  rightLabel={fmtCents(row.totalCents)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* By tool */}
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
        <PanelHeading
          icon={<ChartBarIcon className="size-4 text-emerald-400" />}
          title="By tool"
          hint={rangeDaysLabel}
        />
        {payload.byTool.length === 0 ? (
          <Paragraph variant="extra-small" className="text-text-dimmed">
            No tool invocations recorded in this window.
          </Paragraph>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Skill</TableHeaderCell>
                <TableHeaderCell>Tool</TableHeaderCell>
                <TableHeaderCell>Calls</TableHeaderCell>
                <TableHeaderCell>Avg latency</TableHeaderCell>
                <TableHeaderCell>Share</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payload.byTool.map((row) => {
                const avgLatency = row.calls > 0 ? row.latencyMsTotal / row.calls : 0;
                const pct = maxToolCalls > 0 ? (row.calls / maxToolCalls) * 100 : 0;
                return (
                  <TableRow key={`${row.slug}::${row.tool}`}>
                    <TableCell>
                      <span className="font-mono text-xs">{row.slug}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{row.tool}</span>
                    </TableCell>
                    <TableCell>{fmtNum(row.calls)}</TableCell>
                    <TableCell>{fmtDuration(avgLatency)}</TableCell>
                    <TableCell>
                      <div className="h-2 w-24 overflow-hidden rounded-sm bg-charcoal-800">
                        <div
                          className="h-full bg-emerald-500/60"
                          style={{ width: `${Math.max(2, Math.round(pct))}%` }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* By agent */}
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
        <PanelHeading
          icon={<ChartBarIcon className="size-4 text-blue-400" />}
          title="By agent"
          hint={rangeDaysLabel}
        />
        {payload.byAgent.length === 0 ? (
          <Paragraph variant="extra-small" className="text-text-dimmed">
            No per-agent skill spend recorded yet.
          </Paragraph>
        ) : (
          <div className="flex flex-col gap-3">
            {payload.byAgent.map((row) => {
              const label =
                row.agentName ?? agentNameById.get(row.agentId) ?? row.agentId.slice(0, 8);
              return (
                <HBar
                  key={row.agentId}
                  label={label}
                  sublabel={`${fmtNum(row.calls)} call(s)`}
                  value={row.totalCents}
                  maxValue={maxAgentCost}
                  colour="bg-blue-500/60"
                  rightLabel={fmtCents(row.totalCents)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
