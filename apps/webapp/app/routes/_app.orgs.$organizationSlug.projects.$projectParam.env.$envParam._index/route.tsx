/**
 * PIFSP-2 — Plato Central (landing).
 *
 * The default env-level overview. Rebuilt around operator-grade signal:
 *   NavBar     — PageTitle + range picker (24h|7d|30d as ?range=) + live badge.
 *   Row 1      — 6 hero KPI tiles (with intra-range momentum deltas where a
 *                per-day series exists): Conversations, Active users, Spend,
 *                Avg satisfaction, p95 turn latency, Error rate.
 *   Row 2      — recharts trends: Conversations/day, Spend/day, Tokens/day.
 *   Row 3      — per-agent performance table (agent-scorecard endpoint;
 *                degrades to the cost-by-agent composition on 404).
 *   Row 4      — Activity feed + Tool reliability / Incidents panel.
 *
 * Data is fetched server-side via scoped agentGet calls (Promise.all, each
 * fail-soft to null). Socket.IO provides ~1s live refresh on turn.completed;
 * the loader provides the initial snapshot. Dark-only.
 */
import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  BoltIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  CpuChipIcon,
  CurrencyDollarIcon,
  ExclamationTriangleIcon,
  FaceSmileIcon,
  ShieldExclamationIcon,
  SignalIcon,
  SignalSlashIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/20/solid";
import { Link, useNavigate, useRevalidator, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ClientOnly } from "remix-utils/client-only";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  agentEntitiesPath,
  agentMonitoringPath,
  agentPath,
  agentProvidersPath,
  agentsPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Plato Central | Platos" }];

type Scope = { organizationId: string; projectId: string; environmentId: string; userId: string };

type TimeRange = "24h" | "7d" | "30d";

const RANGE_OPTIONS: { label: string; value: TimeRange }[] = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

function parseRange(raw: string | null | undefined): TimeRange {
  if (raw === "1h" || raw === "1d") return "24h"; // legacy bookmarks
  if (raw === "24h" || raw === "7d" || raw === "30d") return raw;
  return "7d";
}

function rangeDays(range: TimeRange): number {
  if (range === "30d") return 30;
  if (range === "7d") return 7;
  return 1;
}

// ── Palette (charcoal-dark, matches app tokens; recharts needs raw hex) ──
const CHART = {
  emerald: "#34d399",
  blue: "#60a5fa",
  violet: "#a78bfa",
  amber: "#fbbf24",
  rose: "#fb7185",
  grid: "#2f2f37",
  axis: "#8a8a94",
};
const TOOLTIP_STYLE: React.CSSProperties = {
  background: "#17171c",
  border: "1px solid #3a3a42",
  borderRadius: 8,
  fontSize: 12,
  color: "#e5e5e9",
  padding: "6px 10px",
};

type AgentRow = { id: string; name: string; slug: string; model?: string };

type EntityRow = {
  entityId: string;
  connectionStatus?: string | null;
  liveConnected?: boolean;
  lastConnectedAt?: string | null;
};

type SummaryCard = { id: string; label: string; value: number; unit: string; details?: Record<string, number> };
type CostDay = {
  date: string;
  costCents: number;
  inputTokens?: number;
  outputTokens?: number;
  costWithCacheCents?: number;
};
type SummaryPayload = { cards: SummaryCard[]; costSeries: CostDay[]; fetchedAt: string };

type UtilizationPayload = {
  activeThreads: number;
  totalThreads: number;
  totalMessages: number;
  messagesByDay: Array<{ date: string; messages: number }>;
  newVsReturningUsers: { days: number; newUsers: number; returningUsers: number };
  topUsers: unknown[];
  fetchedAt: string;
};

type ActivityItem = {
  kind: string;
  at: string;
  agentId?: string;
  userId?: string;
  summary: string;
  severity?: "info" | "warn" | "error";
  payload?: Record<string, unknown>;
};

type CostByAgentRow = {
  agentId: string;
  agentName: string | null;
  costCents: number;
  threads: number;
  inputTokens?: number;
  outputTokens?: number;
};

type ToolMatrixRow = {
  toolId: string;
  toolName: string;
  entityId: string | null;
  health: {
    lastStatus: string | null;
    failCount: number;
    totalCalls: number;
    totalFailures: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    lastCalledAt: string | null;
  };
};

// NEW agent-scorecard endpoint (parallel slice). Loader degrades to the
// cost-by-agent composition when it 404s (endpoint not yet deployed).
type ScorecardAgent = {
  agentId: string;
  name: string;
  status: string | null;
  threads: number;
  messages: number;
  costCents: number;
  totalTokens: number;
  satisfaction: { ups: number; downs: number; score: number } | null;
  lastActiveAt: string | null;
};
type ScorecardPayload = { days: number; agents: ScorecardAgent[] };

type LoaderData = {
  agentReachable: boolean;
  range: TimeRange;
  agents: AgentRow[];
  entities: EntityRow[];
  summary: SummaryPayload | null;
  utilization: UtilizationPayload | null;
  activity: ActivityItem[];
  scorecard: ScorecardPayload | null;
  costByAgent: CostByAgentRow[];
  toolMatrix: ToolMatrixRow[];
  pendingApprovals: number;
  openSafetyEvents: number;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  agentWsUrl: string | null;
  agentWsPath: string | null;
};

async function agentGet<T>(path: string, scope: Scope): Promise<T | null> {
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
      signal: AbortSignal.timeout(5000),
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
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });

  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const days = rangeDays(range);

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
  let agentReachable = false;
  try {
    agentReachable = await isAgentServiceAvailable();
  } catch {}

  // Public WS URL for the live-refresh socket (operator-set env var; see git
  // blame for the single-domain vs subdomain path reasoning).
  const agentWsUrl = process.env.PLATOS_AGENT_PUBLIC_WS_URL ?? null;
  const agentWsPath = process.env.PLATOS_AGENT_WS_PATH ?? null;

  if (!agentReachable) {
    return typedjson<LoaderData>({
      agentReachable: false,
      range,
      agents: [],
      entities: [],
      summary: null,
      utilization: null,
      activity: [],
      scorecard: null,
      costByAgent: [],
      toolMatrix: [],
      pendingApprovals: 0,
      openSafetyEvents: 0,
      organizationSlug,
      projectParam,
      envParam,
      agentWsUrl,
      agentWsPath,
    });
  }

  const [
    agentsRes,
    entitiesRes,
    summary,
    utilization,
    activity,
    scorecard,
    costByAgentRes,
    toolMatrixRes,
    approvals,
    safety,
  ] = await Promise.all([
    agentGet<{ agents: AgentRow[] }>("/api/v1/agent/agents?limit=100", scope),
    agentGet<{ entities: EntityRow[] }>("/api/v1/agent/entities?limit=50", scope),
    agentGet<SummaryPayload>("/api/v1/agent/monitoring/summary", scope),
    agentGet<UtilizationPayload>(`/api/v1/agent/monitoring/utilization?days=${days}`, scope),
    agentGet<{ items: ActivityItem[] }>("/api/v1/agent/activity/recent?limit=15", scope),
    // NEW slice — resilient: 404 (not-yet-deployed) → null → cost-by-agent fallback.
    agentGet<ScorecardPayload>(`/api/v1/agent/monitoring/agent-scorecard?days=${days}`, scope),
    agentGet<{ rows: CostByAgentRow[] }>(
      `/api/v1/agent/monitoring/cost-by-agent?days=${days}&limit=20`,
      scope
    ),
    agentGet<{ rows: ToolMatrixRow[] }>("/api/v1/agent/tools/matrix", scope),
    agentGet<{ pendingCount?: number }>(
      "/api/v1/agent/monitoring/approvals?status=pending&limit=1",
      scope
    ),
    agentGet<{ total?: number }>(
      `/api/v1/agent/monitoring/safety-events?sinceDays=${days}&limit=1`,
      scope
    ),
  ]);

  return typedjson<LoaderData>({
    agentReachable: true,
    range,
    agents: agentsRes?.agents ?? [],
    entities: entitiesRes?.entities ?? [],
    summary: summary ?? null,
    utilization: utilization ?? null,
    activity: activity?.items ?? [],
    scorecard: scorecard ?? null,
    costByAgent: costByAgentRes?.rows ?? [],
    toolMatrix: toolMatrixRes?.rows ?? [],
    pendingApprovals: approvals?.pendingCount ?? 0,
    openSafetyEvents: safety?.total ?? 0,
    organizationSlug,
    projectParam,
    envParam,
    agentWsUrl,
    agentWsPath,
  });
}

// ══════════════════════════════════════════════════════════
// Formatters + small helpers
// ══════════════════════════════════════════════════════════

function fmtCents(cents: number | null | undefined): string {
  if (!cents || cents <= 0) return "$0.00";
  if (cents < 100) return `$${(cents / 100).toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "0";
  return n.toLocaleString();
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Intra-range momentum: newer half vs older half of a per-day series. Returns
// null when the series is too short (e.g. 24h → 1 bucket) to be meaningful.
function trendDelta(values: number[]): { pct: number; dir: "up" | "down" } | null {
  if (!values || values.length < 4) return null;
  const mid = Math.floor(values.length / 2);
  const older = values.slice(0, mid).reduce((a, b) => a + b, 0);
  const newer = values.slice(mid).reduce((a, b) => a + b, 0);
  if (older <= 0) {
    if (newer <= 0) return null;
    return { pct: 100, dir: "up" };
  }
  const pct = ((newer - older) / older) * 100;
  if (Math.abs(pct) < 1) return null;
  return { pct, dir: pct >= 0 ? "up" : "down" };
}

function satisfactionPct(sat: { ups: number; downs: number } | null | undefined): number | null {
  if (!sat) return null;
  const total = sat.ups + sat.downs;
  if (total <= 0) return null;
  return (sat.ups / total) * 100;
}

// ══════════════════════════════════════════════════════════
// Presentational components
// ══════════════════════════════════════════════════════════

function DeltaChip({
  delta,
  positiveIsGood = true,
}: {
  delta: { pct: number; dir: "up" | "down" } | null;
  positiveIsGood?: boolean;
}) {
  if (!delta) return null;
  const good = positiveIsGood ? delta.dir === "up" : delta.dir === "down";
  const color = good ? "text-emerald-400" : "text-rose-400";
  const Icon = delta.dir === "up" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", color)}
      title="Momentum vs earlier in this range"
    >
      <Icon className="size-3" />
      {Math.abs(delta.pct).toFixed(0)}%
    </span>
  );
}

function KpiTile({
  icon,
  label,
  value,
  sub,
  accent,
  delta,
  positiveIsGood,
  linkTo,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  delta?: { pct: number; dir: "up" | "down" } | null;
  positiveIsGood?: boolean;
  linkTo?: string;
}) {
  const inner = (
    <div
      className={cn(
        "flex h-full flex-col justify-between rounded-lg border border-charcoal-700 bg-charcoal-850 p-4",
        linkTo && "transition-colors hover:border-charcoal-600"
      )}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs text-text-dimmed">
        {icon}
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-2xl font-bold tabular-nums", accent ?? "text-text-bright")}>
          {value}
        </span>
        {delta !== undefined && <DeltaChip delta={delta ?? null} positiveIsGood={positiveIsGood} />}
      </div>
      <div className="mt-0.5 h-4 text-[11px] text-text-dimmed">{sub ?? ""}</div>
    </div>
  );
  return linkTo ? (
    <Link to={linkTo} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
}

type TrendDatum = { label: string } & Record<string, number | string>;

function AreaTrend({
  title,
  hint,
  data,
  dataKey,
  color,
  yFmt,
  tipFmt,
  empty,
}: {
  title: string;
  hint?: string;
  data: TrendDatum[];
  dataKey: string;
  color: string;
  yFmt: (v: number) => string;
  tipFmt: (v: number) => string;
  empty?: string;
}) {
  const gid = `grad-${dataKey}`;
  const hasData = data.length > 0 && data.some((d) => Number(d[dataKey]) > 0);
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-text-bright">{title}</h3>
        {hint && <span className="text-[11px] text-text-dimmed">{hint}</span>}
      </div>
      {!hasData ? (
        <div className="flex h-40 items-center justify-center text-xs text-text-dimmed">
          {empty ?? "No activity in this window."}
        </div>
      ) : (
        <ClientOnly fallback={<div className="h-40" />}>
          {() => (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: CHART.axis }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={20}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: CHART.axis }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tickFormatter={(v: number) => yFmt(v)}
                />
                <RTooltip
                  cursor={{ stroke: CHART.grid }}
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={{ color: CHART.axis }}
                  formatter={((v: any) => [tipFmt(Number(v)), title]) as any}
                />
                <Area
                  type="monotone"
                  dataKey={dataKey}
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#${gid})`}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ClientOnly>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-text-dimmed">—</span>;
  const s = status.toLowerCase();
  const variant =
    s === "active" || s === "live" || s === "published"
      ? ("success" as const)
      : s === "paused" || s === "disabled" || s === "archived"
      ? ("error" as const)
      : ("outline-rounded" as const);
  return <Badge variant={variant}>{status}</Badge>;
}

function SatBar({ pct, ups, downs }: { pct: number | null; ups?: number; downs?: number }) {
  if (pct === null) return <span className="text-text-dimmed">—</span>;
  const barColor = pct >= 66 ? CHART.emerald : pct >= 33 ? CHART.amber : CHART.rose;
  return (
    <div
      className="flex items-center gap-2"
      title={ups !== undefined ? `${ups} up · ${downs} down` : undefined}
    >
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-charcoal-700">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(3, pct)}%`, background: barColor }}
        />
      </div>
      <span className="tabular-nums text-[11px] text-text-dimmed">{pct.toFixed(0)}%</span>
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (!items.length) {
    return (
      <div className="py-6 text-center text-sm text-text-dimmed">
        No activity yet — send a message to an agent to see events here.
      </div>
    );
  }
  return (
    <div className="divide-y divide-charcoal-750">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 py-2">
          <span
            className={cn(
              "mt-1 inline-block size-2 flex-shrink-0 rounded-full",
              item.severity === "error"
                ? "bg-rose-500"
                : item.severity === "warn"
                ? "bg-amber-500"
                : "bg-emerald-500"
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-text-bright">{item.summary}</p>
            {item.agentId && (
              <p className="text-[10px] text-text-dimmed">
                agent {item.agentId.slice(0, 8)}
                {item.userId ? ` · user ${item.userId.slice(0, 8)}` : ""}
              </p>
            )}
          </div>
          <span className="flex-shrink-0 text-[10px] text-charcoal-400">{fmtRelative(item.at)}</span>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// Page
// ══════════════════════════════════════════════════════════

export default function PlatoCentral() {
  const data = useTypedLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [wsConnected, setWsConnected] = useState<boolean | null>(null);
  const socketRef = useRef<any>(null);
  const revalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trailing debounce (3s): bursts of turn.completed events collapse into one
  // loader re-run instead of re-running the full monitoring fan-out per event.
  const handleOverviewEvent = useCallback(() => {
    if (revalidateTimerRef.current) return;
    revalidateTimerRef.current = setTimeout(() => {
      revalidateTimerRef.current = null;
      revalidator.revalidate();
    }, 3000);
  }, [revalidator]);

  useEffect(() => {
    return () => {
      if (revalidateTimerRef.current) {
        clearTimeout(revalidateTimerRef.current);
        revalidateTimerRef.current = null;
      }
    };
  }, []);

  // Socket.IO live refresh. Fire-and-forget; failures don't break the page.
  useEffect(() => {
    if (!data.agentReachable || typeof window === "undefined") return;
    let socket: any;
    try {
      import("socket.io-client")
        .then(({ io }) => {
          const AGENT_WS_URL = (() => {
            if (typeof data.agentWsUrl === "string" && data.agentWsUrl) return data.agentWsUrl;
            if (typeof (window as any).__PLATOS_AGENT_WS_URL__ === "string") {
              return (window as any).__PLATOS_AGENT_WS_URL__;
            }
            return window.location.origin.replace(":3030", ":3100");
          })();
          socket = io(`${AGENT_WS_URL}/agent`, {
            transports: ["websocket"],
            reconnection: true,
            ...(data.agentWsPath ? { path: data.agentWsPath } : {}),
          });
          socketRef.current = socket;
          socket.on("connect", () => setWsConnected(true));
          socket.on("disconnect", () => setWsConnected(false));
          socket.on("overview.turn.completed", handleOverviewEvent);
          socket.on("overview.entity.status", handleOverviewEvent);
        })
        .catch(() => {});
    } catch {}
    return () => {
      try {
        socketRef.current?.disconnect();
      } catch {}
      socketRef.current = null;
    };
  }, [data.agentReachable, data.agentWsUrl, data.agentWsPath, handleOverviewEvent]);

  const organization = { slug: data.organizationSlug };
  const project = { slug: data.projectParam };
  const environment = { id: data.envParam };
  const days = rangeDays(data.range);
  const rangeLabel = data.range === "24h" ? "last 24h" : `last ${days}d`;

  const changeRange = useCallback(
    (value: string) => {
      const qs = new URLSearchParams();
      qs.set("range", value);
      navigate(`?${qs.toString()}`, { replace: true });
    },
    [navigate]
  );

  // ── Per-day series (oldest → newest for the charts) ──────────────────
  const convData = useMemo<TrendDatum[]>(
    () =>
      (data.utilization?.messagesByDay ?? []).map((d) => ({
        label: d.date.slice(5),
        messages: d.messages,
      })),
    [data.utilization]
  );
  // summary.costSeries is newest → oldest; reverse for a left-to-right axis.
  const costSeries = useMemo(
    () => [...(data.summary?.costSeries ?? [])].reverse(),
    [data.summary]
  );
  const spendData = useMemo<TrendDatum[]>(
    () => costSeries.map((d) => ({ label: d.date.slice(5), costCents: d.costCents })),
    [costSeries]
  );
  const tokenData = useMemo<TrendDatum[]>(
    () =>
      costSeries.map((d) => ({
        label: d.date.slice(5),
        tokens: (d.inputTokens ?? 0) + (d.outputTokens ?? 0),
      })),
    [costSeries]
  );

  // ── Unified per-agent rows: scorecard preferred, cost-by-agent fallback ──
  const usingScorecard = data.scorecard !== null;
  const agentRows = useMemo<ScorecardAgent[]>(() => {
    if (data.scorecard) return data.scorecard.agents;
    const nameById = new Map(data.agents.map((a) => [a.id, a.name]));
    return data.costByAgent.map((r) => ({
      agentId: r.agentId,
      name: r.agentName ?? nameById.get(r.agentId) ?? r.agentId.slice(0, 8),
      status: null,
      threads: r.threads,
      messages: -1, // sentinel → "—"
      costCents: r.costCents,
      totalTokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
      satisfaction: null,
      lastActiveAt: null,
    }));
  }, [data.scorecard, data.costByAgent, data.agents]);

  const sortedAgentRows = useMemo(
    () => [...agentRows].sort((a, b) => b.threads - a.threads || b.costCents - a.costCents),
    [agentRows]
  );

  // ── Hero KPI values ──────────────────────────────────────────────────
  const conversations = data.scorecard
    ? data.scorecard.agents.reduce((s, a) => s + a.threads, 0)
    : data.utilization?.activeThreads ?? data.costByAgent.reduce((s, a) => s + a.threads, 0);

  const activeUsers = data.utilization
    ? data.utilization.newVsReturningUsers.newUsers +
      data.utilization.newVsReturningUsers.returningUsers
    : null;

  const spendCents = data.scorecard
    ? data.scorecard.agents.reduce((s, a) => s + a.costCents, 0)
    : data.costByAgent.reduce((s, a) => s + a.costCents, 0);

  const satAgg = useMemo(() => {
    if (!data.scorecard) return null;
    let ups = 0;
    let downs = 0;
    for (const a of data.scorecard.agents) {
      if (a.satisfaction) {
        ups += a.satisfaction.ups;
        downs += a.satisfaction.downs;
      }
    }
    return ups + downs > 0 ? { ups, downs, pct: (ups / (ups + downs)) * 100 } : null;
  }, [data.scorecard]);

  const toolAgg = useMemo(() => {
    let calls = 0;
    let failures = 0;
    for (const t of data.toolMatrix) {
      calls += t.health.totalCalls;
      failures += t.health.totalFailures;
    }
    return { calls, failures, errorPct: calls > 0 ? (failures / calls) * 100 : null };
  }, [data.toolMatrix]);

  const convDelta = trendDelta(convData.map((d) => Number(d.messages)));
  const spendDelta = trendDelta(spendData.map((d) => Number(d.costCents)));

  // ── Tool reliability (top 8 by calls) ────────────────────────────────
  const topTools = useMemo(
    () =>
      [...data.toolMatrix]
        .filter((t) => t.health.totalCalls > 0)
        .sort((a, b) => b.health.totalCalls - a.health.totalCalls)
        .slice(0, 8),
    [data.toolMatrix]
  );

  const isEntityConnected = (e: EntityRow) =>
    e.liveConnected === true || e.connectionStatus === "connected";
  const connectedEntities = data.entities.filter(isEntityConnected).length;
  const incidents = data.pendingApprovals + data.openSafetyEvents;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Plato Central" icon={<CpuChipIcon className="size-5 text-emerald-500" />} />
        <div className="ml-auto flex items-center gap-3">
          <SegmentedControl
            name="range"
            value={data.range}
            options={RANGE_OPTIONS}
            variant="secondary/small"
            onChange={changeRange}
          />
          <Badge variant="outline-rounded">{data.envParam}</Badge>
          {wsConnected === true && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <SignalIcon className="size-3.5" /> live
            </span>
          )}
          {wsConnected === false && (
            <span className="flex items-center gap-1 text-[11px] text-text-dimmed">
              <SignalSlashIcon className="size-3.5" /> reconnecting…
            </span>
          )}
          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state === "loading"}
            className="rounded p-1 text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright disabled:opacity-50"
            aria-label="Refresh"
          >
            <ArrowPathIcon
              className={cn("size-4", revalidator.state === "loading" && "animate-spin")}
            />
          </button>
        </div>
      </NavBar>

      <PageBody>
        {!data.agentReachable && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            <ExclamationTriangleIcon className="mr-1.5 inline size-4" />
            Agent service unreachable. Stats may be stale.
          </div>
        )}

        {/* Empty-state onboarding */}
        {data.agentReachable && data.agents.length === 0 && (
          <div className="mb-6 rounded-lg border border-charcoal-700 bg-charcoal-850 p-8 text-center">
            <CpuChipIcon className="mx-auto mb-3 size-10 opacity-30" />
            <Paragraph variant="small" className="text-text-bright">
              No agents yet
            </Paragraph>
            <Paragraph variant="extra-small" className="mx-auto mt-1 max-w-md text-text-dimmed">
              Plato Central lights up once an agent is running. Create one, connect an entity, or
              link a model provider to get started.
            </Paragraph>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <Link
                to={agentsPath(organization, project, environment)}
                className="rounded border border-emerald-600 bg-emerald-600/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-600/20"
              >
                Create an agent →
              </Link>
              <Link
                to={agentEntitiesPath(organization, project, environment)}
                className="rounded border border-charcoal-600 px-3 py-1.5 text-xs text-text-dimmed hover:border-charcoal-500 hover:text-text-bright"
              >
                Connect an entity →
              </Link>
              <Link
                to={agentProvidersPath(organization, project, environment)}
                className="rounded border border-charcoal-600 px-3 py-1.5 text-xs text-text-dimmed hover:border-charcoal-500 hover:text-text-bright"
              >
                Link a provider →
              </Link>
            </div>
          </div>
        )}

        {/* ── Row 1: hero KPIs ─────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            icon={<ChatBubbleLeftRightIcon className="size-3.5" />}
            label="Conversations"
            value={fmtNum(conversations)}
            sub={rangeLabel}
            accent="text-text-bright"
            delta={convDelta}
            positiveIsGood
            linkTo={agentMonitoringPath(organization, project, environment)}
          />
          <KpiTile
            icon={<UsersIcon className="size-3.5" />}
            label="Active users"
            value={activeUsers === null ? "—" : fmtNum(activeUsers)}
            sub={
              data.utilization
                ? `${data.utilization.newVsReturningUsers.newUsers} new · ${data.utilization.newVsReturningUsers.returningUsers} returning`
                : rangeLabel
            }
            accent="text-blue-300"
          />
          <KpiTile
            icon={<CurrencyDollarIcon className="size-3.5" />}
            label="Spend"
            value={fmtCents(spendCents)}
            sub={rangeLabel}
            accent="text-amber-300"
            delta={spendDelta}
            positiveIsGood={false}
            linkTo={agentMonitoringPath(organization, project, environment)}
          />
          <KpiTile
            icon={<FaceSmileIcon className="size-3.5" />}
            label="Avg satisfaction"
            value={satAgg ? `${satAgg.pct.toFixed(0)}%` : "—"}
            sub={satAgg ? `${satAgg.ups} up · ${satAgg.downs} down` : "no ratings yet"}
            accent={satAgg && satAgg.pct >= 66 ? "text-emerald-300" : "text-text-bright"}
          />
          <KpiTile
            icon={<ClockIcon className="size-3.5" />}
            label="p95 turn latency"
            value="—"
            sub="awaiting backend"
            accent="text-text-dimmed"
          />
          <KpiTile
            icon={<ExclamationTriangleIcon className="size-3.5" />}
            label="Error rate"
            value={toolAgg.errorPct === null ? "—" : `${toolAgg.errorPct.toFixed(1)}%`}
            sub={
              toolAgg.calls > 0
                ? `${fmtNum(toolAgg.failures)} fail / ${fmtNum(toolAgg.calls)} calls`
                : "no tool calls"
            }
            accent={
              toolAgg.errorPct && toolAgg.errorPct >= 5 ? "text-rose-300" : "text-text-bright"
            }
            linkTo={agentMonitoringPath(organization, project, environment)}
          />
        </div>

        {/* ── Row 2: trends ────────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <AreaTrend
            title="Conversations / day"
            hint={rangeLabel}
            data={convData}
            dataKey="messages"
            color={CHART.emerald}
            yFmt={(v) => fmtCompact(v)}
            tipFmt={(v) => `${fmtNum(v)} messages`}
          />
          <AreaTrend
            title="Spend / day"
            hint="last 7d"
            data={spendData}
            dataKey="costCents"
            color={CHART.amber}
            yFmt={(v) => `$${(v / 100).toFixed(0)}`}
            tipFmt={(v) => fmtCents(v)}
          />
          <AreaTrend
            title="Tokens / day"
            hint="last 7d"
            data={tokenData}
            dataKey="tokens"
            color={CHART.violet}
            yFmt={(v) => fmtCompact(v)}
            tipFmt={(v) => `${fmtNum(v)} tokens`}
          />
        </div>

        {/* ── Row 3: per-agent performance ─────────────────────────── */}
        <div className="mt-4 rounded-lg border border-charcoal-700 bg-charcoal-850">
          <div className="flex items-baseline justify-between gap-2 px-4 pt-4">
            <div className="flex items-center gap-2">
              <BoltIcon className="size-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-text-bright">Agent performance</h3>
              <span className="text-[11px] text-text-dimmed">{rangeLabel}</span>
            </div>
            {!usingScorecard && agentRows.length > 0 && (
              <span
                className="text-[11px] text-amber-400/80"
                title="agent-scorecard endpoint unavailable — showing cost-by-agent composition"
              >
                limited metrics
              </span>
            )}
          </div>
          {sortedAgentRows.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-text-dimmed">
              No agent activity in this window yet.
            </div>
          ) : (
            <Table containerClassName="mt-3 border-t-0" showTopBorder={false}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell alignment="right">Conversations</TableHeaderCell>
                  <TableHeaderCell alignment="right">Msgs</TableHeaderCell>
                  <TableHeaderCell alignment="right">Spend</TableHeaderCell>
                  <TableHeaderCell alignment="right">Tokens</TableHeaderCell>
                  <TableHeaderCell>Satisfaction</TableHeaderCell>
                  <TableHeaderCell alignment="right">Last active</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedAgentRows.map((a) => {
                  const to = agentPath(organization, project, environment, a.agentId);
                  return (
                    <TableRow
                      key={a.agentId}
                      className="cursor-pointer"
                      onClick={() => navigate(to)}
                    >
                      <TableCell>
                        <span className="font-medium text-text-bright">{a.name}</span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell alignment="right">
                        <span className="tabular-nums">{fmtNum(a.threads)}</span>
                      </TableCell>
                      <TableCell alignment="right">
                        <span className="tabular-nums">
                          {a.messages < 0 ? "—" : fmtNum(a.messages)}
                        </span>
                      </TableCell>
                      <TableCell alignment="right">
                        <span className="tabular-nums text-amber-300">{fmtCents(a.costCents)}</span>
                      </TableCell>
                      <TableCell alignment="right">
                        <span className="tabular-nums">{fmtCompact(a.totalTokens)}</span>
                      </TableCell>
                      <TableCell>
                        <SatBar
                          pct={satisfactionPct(a.satisfaction)}
                          ups={a.satisfaction?.ups}
                          downs={a.satisfaction?.downs}
                        />
                      </TableCell>
                      <TableCell alignment="right">
                        <span className="text-text-dimmed">{fmtRelative(a.lastActiveAt)}</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {/* ── Row 4: activity + tool reliability / incidents ───────── */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <div className="mb-2 flex items-center gap-2">
              <ChartBarIcon className="size-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-text-bright">Recent activity</h3>
            </div>
            <ActivityFeed items={data.activity} />
          </div>

          <div className="flex flex-col gap-4">
            {/* Incidents */}
            <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
              <div className="mb-3 flex items-center gap-2">
                <ShieldExclamationIcon
                  className={cn("size-4", incidents > 0 ? "text-rose-400" : "text-emerald-400")}
                />
                <h3 className="text-sm font-semibold text-text-bright">Incidents</h3>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Link
                  to={agentMonitoringPath(organization, project, environment)}
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 p-3 transition-colors hover:border-charcoal-600"
                >
                  <div className="text-xs text-text-dimmed">Approvals pending</div>
                  <div
                    className={cn(
                      "mt-1 text-xl font-bold tabular-nums",
                      data.pendingApprovals > 0 ? "text-amber-300" : "text-text-bright"
                    )}
                  >
                    {data.pendingApprovals}
                  </div>
                </Link>
                <Link
                  to={agentMonitoringPath(organization, project, environment)}
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 p-3 transition-colors hover:border-charcoal-600"
                >
                  <div className="text-xs text-text-dimmed">Safety events ({rangeLabel})</div>
                  <div
                    className={cn(
                      "mt-1 text-xl font-bold tabular-nums",
                      data.openSafetyEvents > 0 ? "text-rose-300" : "text-text-bright"
                    )}
                  >
                    {data.openSafetyEvents}
                  </div>
                </Link>
              </div>
            </div>

            {/* Tool reliability */}
            <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
              <div className="mb-3 flex items-center gap-2">
                <WrenchScrewdriverIcon className="size-4 text-blue-400" />
                <h3 className="text-sm font-semibold text-text-bright">Tool reliability</h3>
                <span className="text-[11px] text-text-dimmed">top by calls</span>
              </div>
              {topTools.length === 0 ? (
                <p className="py-4 text-center text-xs text-text-dimmed">
                  No tool calls recorded yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {topTools.map((t) => {
                    const failPct =
                      t.health.totalCalls > 0
                        ? (t.health.totalFailures / t.health.totalCalls) * 100
                        : 0;
                    const failColor =
                      failPct >= 10
                        ? "text-rose-300"
                        : failPct > 0
                        ? "text-amber-300"
                        : "text-emerald-300";
                    return (
                      <div
                        key={`${t.toolId}:${t.entityId ?? ""}`}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-text-bright"
                          title={t.toolName}
                        >
                          {t.toolName}
                        </span>
                        <span className="tabular-nums text-text-dimmed">
                          {fmtNum(t.health.totalCalls)} calls
                        </span>
                        <span className="w-16 text-right tabular-nums text-text-dimmed">
                          {t.health.p95LatencyMs != null ? `${Math.round(t.health.p95LatencyMs)}ms` : "—"}
                        </span>
                        <span className={cn("w-12 text-right tabular-nums font-medium", failColor)}>
                          {failPct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Quick links ──────────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            { label: "Agents", to: agentsPath(organization, project, environment) },
            { label: "Monitoring", to: agentMonitoringPath(organization, project, environment) },
            { label: "Providers", to: agentProvidersPath(organization, project, environment) },
          ].map(({ label, to }) => (
            <Link
              key={label}
              to={to}
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2.5 text-center text-xs font-medium text-text-dimmed hover:border-charcoal-600 hover:text-text-bright"
            >
              {label}
            </Link>
          ))}
        </div>
      </PageBody>
    </PageContainer>
  );
}
