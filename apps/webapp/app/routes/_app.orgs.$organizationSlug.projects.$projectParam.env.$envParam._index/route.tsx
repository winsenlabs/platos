/**
 * PIFSP-2 — Plato Central.
 *
 * Replaces the trigger.dev Tasks landing as the default env-level view.
 * Aggregates 6 stat cards, entity strip, activity feed, and cost breakdown
 * into a single live overview page. Socket.IO provides ~1s live refresh
 * on turn.completed events; loader provides the initial snapshot.
 *
 * The previous Tasks content moved to /tasks → redirects to /runs.
 */
import {
  ArrowPathIcon,
  BoltIcon,
  BuildingOffice2Icon,
  ChartBarIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  SignalIcon,
  SignalSlashIcon,
} from "@heroicons/react/20/solid";
import { Link, useRevalidator, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentEntitiesPath,
  agentMonitoringPath,
  agentProvidersPath,
  agentsPath,
  EnvironmentParamSchema,
  v3RunsPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Plato Central | Platos" }];

type Scope = { organizationId: string; projectId: string; environmentId: string; userId: string };

type AgentRow = { id: string; name: string; slug: string; model: string };

// Mirrors AuthService.ENTITY_SAFE_SELECT + the `liveConnected` field stamped
// by AgentController.listEntities. `connectionStatus` is the persisted state
// ("connected" | "disconnected"); `liveConnected` is the live websocket
// presence. Either is a valid signal of "is this entity online?" — we treat
// the union as connected so a transient WS reconnect doesn't flip the dot.
type EntityRow = {
  entityId: string;
  connectionStatus?: string | null;
  liveConnected?: boolean;
  lastConnectedAt?: string | null;
};

// Uses the existing /monitoring/summary endpoint shape (same as agent-monitoring._index).
type SummaryCard = { id: string; label: string; value: number; unit: string };
type SummaryPayload = {
  cards: SummaryCard[];
  costSeries: Array<{ date: string; costCents: number; costWithCacheCents?: number }>;
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

type SkillHealthPayload = { total: number; official: number; envReady: number; broken: number };

type LoaderData = {
  agentReachable: boolean;
  agents: AgentRow[];
  entities: EntityRow[];
  summary: SummaryPayload | null;
  activity: ActivityItem[];
  skillHealth: SkillHealthPayload | null;
  pendingApprovals: number;
  openSafetyEvents: number;
  costByAgent: Array<{
    agentId: string;
    agentName: string | null;
    costCents: number;
    threads: number;
  }>;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  agentWsUrl: string | null;
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
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
  let agentReachable = false;
  try { agentReachable = await isAgentServiceAvailable(); } catch {}

  // Public WS URL for the live-refresh socket. The previous fallback
  // (window.location.origin.replace(":3030", ":3100")) only worked on a
  // local dev box; on prod the host has no port so it returned the page
  // origin itself and the socket failed to connect, leaving the header
  // permanently stuck in "reconnecting…". Forward the operator-set env
  // var to the client.
  const agentWsUrl = process.env.PLATOS_AGENT_PUBLIC_WS_URL ?? null;

  if (!agentReachable) {
    return typedjson<LoaderData>({
      agentReachable: false, agents: [], entities: [], summary: null,
      activity: [], skillHealth: null, pendingApprovals: 0, openSafetyEvents: 0,
      costByAgent: [], organizationSlug, projectParam, envParam, agentWsUrl,
    });
  }

  const [
    agentsRes,
    entitiesRes,
    summary,
    activity,
    skillHealth,
    approvals,
    costByAgentRes,
  ] = await Promise.all([
    agentGet<{ agents: AgentRow[] }>("/api/v1/agent/agents?limit=50", scope),
    agentGet<{ entities: EntityRow[] }>("/api/v1/agent/entities?limit=50", scope),
    // Use the existing /monitoring/summary endpoint — same as the monitoring dashboard.
    agentGet<SummaryPayload>("/api/v1/agent/monitoring/summary", scope),
    agentGet<{ items: ActivityItem[] }>("/api/v1/agent/activity/recent?limit=15", scope),
    agentGet<SkillHealthPayload>("/api/v1/agent/skills/health", scope),
    agentGet<{ pendingCount?: number }>("/api/v1/agent/monitoring/approvals?status=pending&limit=1", scope),
    agentGet<{ rows: LoaderData["costByAgent"] }>("/api/v1/agent/monitoring/cost-by-agent?days=7&limit=10", scope),
  ]);

  return typedjson<LoaderData>({
    agentReachable: true,
    agents: agentsRes?.agents ?? [],
    entities: entitiesRes?.entities ?? [],
    summary: summary ?? null,
    activity: activity?.items ?? [],
    skillHealth: skillHealth ?? null,
    pendingApprovals: (approvals as any)?.pendingCount ?? 0,
    openSafetyEvents: 0,
    costByAgent: costByAgentRes?.rows ?? [],
    organizationSlug,
    projectParam,
    envParam,
    agentWsUrl,
  });
}

function fmtCents(cents: number): string {
  if (cents <= 0) return "$0.00";
  if (cents < 100) return `$${(cents / 100).toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtRelative(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
  linkTo,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  linkTo?: string;
}) {
  const inner = (
    <div className={`rounded-lg border border-charcoal-700 bg-charcoal-850 p-4 ${linkTo ? "cursor-pointer hover:border-charcoal-600 transition-colors" : ""}`}>
      <div className="mb-2 flex items-center gap-1.5 text-xs text-text-dimmed">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-bold ${accent ?? "text-text-bright"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-dimmed">{sub}</div>}
    </div>
  );
  if (linkTo) return <Link to={linkTo}>{inner}</Link>;
  return inner;
}

function Sparkline({ series }: { series: Array<{ date: string; costCents: number }> }) {
  if (!series?.length) return <div className="flex h-10 items-center text-xs text-text-dimmed italic">No data</div>;
  const max = Math.max(1, ...series.map((d) => d.costCents));
  return (
    <div className="flex h-10 items-end gap-0.5">
      {series.map((d) => (
        <div
          key={d.date}
          className="flex-1 rounded-sm bg-emerald-500/50"
          style={{ height: `${Math.max(4, (d.costCents / max) * 40)}px` }}
          title={`${d.date}: ${fmtCents(d.costCents)}`}
        />
      ))}
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
          <div className="mt-0.5 flex-shrink-0">
            <span className={`inline-block size-2 rounded-full ${
              item.severity === "error" ? "bg-rose-500" :
              item.severity === "warn" ? "bg-amber-500" : "bg-emerald-500"
            }`} />
          </div>
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

export default function PlatoCentral() {
  const data = useTypedLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [wsConnected, setWsConnected] = useState<boolean | null>(null);
  const socketRef = useRef<any>(null);

  const handleOverviewEvent = useCallback(() => {
    revalidator.revalidate();
  }, [revalidator]);

  // PIFSP-2 — Socket.IO live refresh. Fire-and-forget; failures don't break the page.
  useEffect(() => {
    if (!data.agentReachable || typeof window === "undefined") return;
    let socket: any;
    try {
      // Dynamic import so the module never runs server-side.
      import("socket.io-client").then(({ io }) => {
        const AGENT_WS_URL = (() => {
          // 1. Loader-provided operator URL (PLATOS_AGENT_PUBLIC_WS_URL).
          if (typeof data.agentWsUrl === "string" && data.agentWsUrl) return data.agentWsUrl;
          // 2. Window override (legacy / test harnesses).
          if (typeof (window as any).__PLATOS_AGENT_WS_URL__ === "string") {
            return (window as any).__PLATOS_AGENT_WS_URL__;
          }
          // 3. Local dev fallback — ports differ between webapp (3030) and agent (3100).
          return window.location.origin.replace(":3030", ":3100");
        })();
        socket = io(`${AGENT_WS_URL}/agent`, { transports: ["websocket"], reconnection: true });
        socketRef.current = socket;
        socket.on("connect", () => setWsConnected(true));
        socket.on("disconnect", () => setWsConnected(false));
        socket.on("overview.turn.completed", handleOverviewEvent);
        socket.on("overview.entity.status", handleOverviewEvent);
      }).catch(() => {});
    } catch {}
    return () => {
      try { socketRef.current?.disconnect(); } catch {}
      socketRef.current = null;
    };
  }, [data.agentReachable, data.agentWsUrl, handleOverviewEvent]);

  const organization = { slug: data.organizationSlug };
  const project = { slug: data.projectParam };
  const environment = { slug: data.envParam };

  const isEntityConnected = (e: EntityRow) =>
    e.liveConnected === true || e.connectionStatus === "connected";
  const connectedEntities = data.entities.filter(isEntityConnected);
  const threadsCard = data.summary?.cards.find((c) => c.id === "threads_24h");
  const costCard = data.summary?.cards.find((c) => c.id === "cost_7d");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Plato Central" icon={<CpuChipIcon className="size-5 text-emerald-500" />} />
        <div className="ml-auto flex items-center gap-2">
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
          >
            <ArrowPathIcon className={`size-4 ${revalidator.state === "loading" ? "animate-spin" : ""}`} />
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

        {/* Empty state */}
        {data.agents.length === 0 && (
          <div className="mb-6 rounded-lg border border-charcoal-700 bg-charcoal-850 p-6 text-center">
            <CpuChipIcon className="mx-auto mb-3 size-10 opacity-30" />
            <Paragraph variant="small" className="text-text-bright">No agents yet</Paragraph>
            <Paragraph variant="extra-small" className="mt-1 text-text-dimmed">
              Get started by creating an agent, connecting an entity, or linking a provider.
            </Paragraph>
            <div className="mt-4 flex justify-center gap-3">
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

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            icon={<CpuChipIcon className="size-3.5" />}
            label="Agents"
            value={data.agents.length}
            sub={`${data.entities.length} entities`}
            accent="text-emerald-300"
            linkTo={agentsPath(organization, project, environment)}
          />
          <StatCard
            icon={<BoltIcon className="size-3.5" />}
            label="Conversations (24h)"
            value={threadsCard?.value ?? "—"}
            sub={threadsCard !== undefined ? "conversations" : undefined}
            linkTo={agentMonitoringPath(organization, project, environment)}
          />
          <StatCard
            icon={<ChartBarIcon className="size-3.5" />}
            label="Spend (7d)"
            value={costCard ? fmtCents(costCard.value) : "—"}
            accent="text-amber-300"
            linkTo={agentMonitoringPath(organization, project, environment)}
          />
          <StatCard
            icon={<BuildingOffice2Icon className="size-3.5" />}
            label="Connected"
            value={`${connectedEntities.length}/${data.entities.length}`}
            sub="entities live"
            accent={connectedEntities.length > 0 ? "text-blue-300" : undefined}
            linkTo={agentEntitiesPath(organization, project, environment)}
          />
          <StatCard
            icon={<ExclamationTriangleIcon className="size-3.5" />}
            label="Incidents"
            value={data.pendingApprovals + data.openSafetyEvents}
            sub={`${data.pendingApprovals} approvals pending`}
            accent={data.pendingApprovals + data.openSafetyEvents > 0 ? "text-rose-300" : undefined}
            linkTo={agentMonitoringPath(organization, project, environment)}
          />
          <StatCard
            icon={<ShieldCheckIcon className="size-3.5" />}
            label="Skills ready"
            value={data.skillHealth?.envReady ?? "—"}
            sub={data.skillHealth ? `${data.skillHealth.total} total` : undefined}
            accent={data.skillHealth?.broken ? "text-amber-300" : "text-emerald-300"}
          />
        </div>

        {/* Sparkline + entity strip */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <p className="mb-2 text-xs text-text-dimmed">Cost (7 days)</p>
            <Sparkline series={data.summary?.costSeries ?? []} />
            <p className="mt-1 text-xs font-medium text-text-bright">
              {costCard ? fmtCents(costCard.value) : "—"} total · 7d
            </p>
          </div>
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <p className="mb-2 text-xs text-text-dimmed">Entities</p>
            {data.entities.length === 0 ? (
              <p className="text-xs text-text-dimmed italic">None registered.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {data.entities.slice(0, 12).map((e) => {
                  const connected = isEntityConnected(e);
                  return (
                    <span
                      key={e.entityId}
                      title={e.lastConnectedAt ? `Last seen ${fmtRelative(e.lastConnectedAt)}` : "Never connected"}
                      className="flex items-center gap-1.5 rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-xs"
                    >
                      <span className={`inline-block size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-charcoal-500"}`} />
                      {e.entityId}
                    </span>
                  );
                })}
                {data.entities.length > 12 && (
                  <span className="text-xs text-text-dimmed">+{data.entities.length - 12} more</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Activity + cost breakdown */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <p className="mb-2 text-xs text-text-dimmed">Recent activity</p>
            <ActivityFeed items={data.activity} />
          </div>

          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <p className="mb-2 text-xs text-text-dimmed">Cost by agent (7d)</p>
            {data.costByAgent.length === 0 ? (
              <p className="text-xs text-text-dimmed italic">No cost data yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-text-dimmed">
                    <th className="pb-1.5 pr-3">Agent</th>
                    <th className="pb-1.5 pr-3 text-right">Threads</th>
                    <th className="pb-1.5 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal-750">
                  {data.costByAgent.slice(0, 8).map((r) => (
                    <tr key={r.agentId}>
                      <td className="truncate py-1 pr-3 text-text-bright" style={{ maxWidth: 120 }} title={r.agentName ?? r.agentId}>
                        {r.agentName ?? r.agentId.slice(0, 8)}
                      </td>
                      <td className="py-1 pr-3 text-right text-text-dimmed">{r.threads}</td>
                      <td className="py-1 text-right font-mono text-amber-300">{fmtCents(r.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-2">
              <Link to={agentMonitoringPath(organization, project, environment)} className="text-[11px] text-blue-400 hover:underline">
                Full monitoring →
              </Link>
            </div>
          </div>
        </div>

        {/* Quick links */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "Agents", to: agentsPath(organization, project, environment) },
            { label: "Runs", to: v3RunsPath(organization, project, environment) },
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
