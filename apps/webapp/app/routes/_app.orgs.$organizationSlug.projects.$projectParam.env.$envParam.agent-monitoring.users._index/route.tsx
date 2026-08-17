import {
  UserIcon,
  ExclamationTriangleIcon,
  ArrowTopRightOnSquareIcon,
  SparklesIcon,
  CpuChipIcon,
  HandThumbUpIcon,
  HandThumbDownIcon,
} from "@heroicons/react/20/solid";
import {
  Link,
  useFetcher,
  useNavigate,
  useSearchParams,
  type MetaFunction,
} from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
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
import {
  agentConversationsPath,
  agentMonitoringPath,
  agentMonitoringUsersPath,
  agentPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";


export const meta: MetaFunction = () => [{ title: "Monitoring — Users | Platos" }];

// ─── Types ─────────────────────────────────────────────────────────────────

// DOCS-DRIFT-004 — single shared shape for the rolling 7-day cost field.
// Previously declared inline on UserRow, AgentRow, and UserDetail; a future
// rename had to touch all three. Lifted into a typed helper so the field
// follows one source.
type WithCost7d = {
  cost7dCents: number;
};

type UserRow = WithCost7d & {
  userId: string;
  alias: string | null;
  totalConversations: number;
  agentsTouched: number;
  totalTurns: number;
  lastActiveAt: string;
  // PRELAUNCH-A1-10 — token breakdown columns. Default 0 on legacy rows.
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  riskFlagCount: number;
  score: number;
};

type AgentRow = WithCost7d & {
  agentId: string;
  agentName: string;
  model: string | null;
  totalConversations: number;
  uniqueUsers: number;
  totalTurns: number;
  lastActiveAt: string;
};

type UserDetail = WithCost7d & {
  userId: string;
  displayName: string | null;
  email: string | null;
  conversationsByAgent: Array<{
    agentId: string;
    agentName: string;
    threads: Array<{
      threadId: string;
      title: string | null;
      createdAt: string;
      lastActiveAt: string;
      status: string;
    }>;
  }>;
  profileMemories: Array<{ id: string; content: string; metadata: unknown; createdAt: string }>;
  riskEvents: Array<{ kind: string; at: string; detail: string | null; severity: string }>;
  cost30dCents: number;
  ratingsUps: number;
  ratingsDowns: number;
  memoryBreakdown: Record<string, number>;
  perAgentBreakdown: Array<{ agentId: string; agentName: string; conversations: number }>;
};

// PRELAUNCH-A3-1 (follow-up 2026-05-04) — drawer renders the consumption
// summary fetched from `/api/v1/agent/monitoring/users/:userId/consumption`.
// Mirrors `BudgetService.getUserConsumptionSummary` return shape.
type ConsumptionCapStatus = {
  cap: {
    id: string;
    scopeType: "scope" | "user" | "agent";
    targetId: string;
    period: "minute" | "hour" | "day" | "week" | "month";
    limitCents: number;
    runsLimit: number;
    tier: "llm" | "skill" | string;
    skillSlug: string | null;
    agentId: string | null;
  };
  windowKey: string;
  spentCents: number;
  runs: number;
  percent: number;
  runsPercent: number;
  blocked: boolean;
  overrideActive: boolean;
};

type UserConsumption = {
  userId: string;
  blocked: boolean;
  reason: string | null;
  caps: ConsumptionCapStatus[];
  rateLimit: { minute: number; hour: number; day: number } | null;
  rateLimited: boolean;
  fetchedAt: string;
};

// ─── Loader ────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const agentHeaders = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  const url = new URL(request.url);
  const detailUserId = url.searchParams.get("userId");
  const activeTab = (url.searchParams.get("tab") ?? "users") as "users" | "agents";

  let users: UserRow[] = [];
  let agentsList: AgentRow[] = [];
  let userDetail: UserDetail | null = null;
  let userConsumption: UserConsumption | null = null;

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      // Fetch users list
      const usersRes = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/users?limit=100&sinceDays=30`,
        { headers: agentHeaders, signal: AbortSignal.timeout(10000) },
      );
      if (usersRes.ok) {
        const data = (await usersRes.json()) as { users: UserRow[] };
        users = data.users ?? [];
      }

      // Fetch agents list when on agents tab
      if (activeTab === "agents") {
        const agentsRes = await fetch(
          `${AGENT_API_URL}/api/v1/agent/monitoring/agents?sinceDays=30`,
          { headers: agentHeaders, signal: AbortSignal.timeout(10000) },
        );
        if (agentsRes.ok) {
          const data = (await agentsRes.json()) as { agents: AgentRow[] };
          agentsList = data.agents ?? [];
        }
      }

      // Fetch user detail + consumption summary when userId is specified.
      // PRELAUNCH-A3-1 (follow-up) — parallel fetch the consumption
      // summary so the drawer can render per-cap progress bars + a
      // BREACHED badge inline. Failure of either fetch is non-fatal —
      // the drawer falls back to the existing static stat cards.
      if (detailUserId) {
        const [detailRes, consumptionRes] = await Promise.all([
          fetch(
            `${AGENT_API_URL}/api/v1/agent/monitoring/users/${encodeURIComponent(detailUserId)}`,
            { headers: agentHeaders, signal: AbortSignal.timeout(10000) },
          ),
          fetch(
            `${AGENT_API_URL}/api/v1/agent/monitoring/users/${encodeURIComponent(detailUserId)}/consumption`,
            { headers: agentHeaders, signal: AbortSignal.timeout(10000) },
          ),
        ]);
        if (detailRes.ok) {
          userDetail = (await detailRes.json()) as UserDetail;
        }
        if (consumptionRes.ok) {
          userConsumption = (await consumptionRes.json()) as UserConsumption;
        }
      }
    }
  } catch {
    // Agent service unavailable — render empty state
  }

  return typedjson({
    users,
    agentsList,
    userDetail,
    userConsumption,
    detailUserId,
    activeTab,
    org: { slug: organizationSlug },
    project: { slug: projectParam, id: project.id, organizationId: project.organizationId },
    environment: { slug: envParam, id: environment.id },
    agentApiUrl: AGENT_API_URL,
    scopeHeaders: {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
  });
}

// ─── Action (proxy AI summary to agent service) ────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "generate_summary") {
    const targetUserId = String(form.get("userId") || "");
    if (!targetUserId) {
      return typedjson({ error: "userId missing" }, { status: 400 });
    }
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/users/${encodeURIComponent(targetUserId)}/summary`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Organization-Id": project.organizationId,
            "X-Platos-Project-Id": project.id,
            "X-Platos-Environment-Id": environment.id,
            "X-Platos-User-Id": userId,
          },
        },
      );
      if (!res.ok) {
        return typedjson({ error: `Agent returned ${res.status}` }, { status: 502 });
      }
      const data = (await res.json()) as { summary?: string; generatedAt?: string; error?: string };
      return typedjson(data);
    } catch (err) {
      return typedjson(
        { error: err instanceof Error ? err.message : "fetch failed" },
        { status: 502 },
      );
    }
  }

  return typedjson({ error: "unknown intent" }, { status: 400 });
}

// ─── Score ring ────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const color =
    score >= 70 ? "text-emerald-400" : score >= 40 ? "text-amber-400" : "text-rose-400";
  const ring =
    score >= 70
      ? "border-emerald-500/40"
      : score >= 40
        ? "border-amber-500/40"
        : "border-rose-500/40";
  // LAUNCH-6 — wrap in a min-width flex container so the 32px ring doesn't
  // overflow when the table column shrinks under long usernames. Was the
  // "risk and all is not fit into the boxes" complaint.
  return (
    <div className="min-w-[44px] flex justify-center">
      <span
        title={`Score: ${score}/100`}
        className={`inline-flex items-center justify-center size-8 flex-shrink-0 rounded-full border-2 ${ring} text-xs font-semibold ${color}`}
      >
        {score}
      </span>
    </div>
  );
}

// ─── Memory kind badge colors ───────────────────────────────────────────────

const MEMORY_KIND_COLORS: Record<string, string> = {
  profile: "bg-violet-900/40 text-violet-300 border-violet-700/40",
  fact: "bg-blue-900/40 text-blue-300 border-blue-700/40",
  preference: "bg-amber-900/40 text-amber-300 border-amber-700/40",
  event: "bg-teal-900/40 text-teal-300 border-teal-700/40",
  relationship: "bg-rose-900/40 text-rose-300 border-rose-700/40",
};

function MemoryKindBadge({ kind, count }: { kind: string; count: number }) {
  const cls =
    MEMORY_KIND_COLORS[kind] ?? "bg-charcoal-700/40 text-text-dimmed border-charcoal-600/40";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${cls}`}
    >
      {kind}
      <span className="font-semibold">{count}</span>
    </span>
  );
}

// ─── Memory drill-down (LAUNCH-5) ──────────────────────────────────────────

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  agentId: string | null;
  createdAt: string;
}

function MemoryListSection({
  userId,
  totalCount,
  scope,
}: {
  userId: string;
  totalCount: number;
  scope: { organizationId: string; projectId: string; environmentId: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<string>("");
  const fetcher = useFetcher<{ memories?: MemoryRow[]; error?: string }>();
  const deleteFetcher = useFetcher<{ deleted?: boolean; error?: string }>();
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!expanded) return;
    if (fetcher.state !== "idle" || fetcher.data) return;
    // Use the existing agent-resource proxy which forwards to agent service.
    // resources.agent.ts requires the (organizationId, projectId, environmentId)
    // scope triple in the query string — passing only `path` returns a 400.
    const params = new URLSearchParams({
      path: `/api/v1/memory?userId=${encodeURIComponent(userId)}&limit=200`,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    });
    fetcher.load(`/resources/agent?${params.toString()}`);
  }, [expanded, userId, fetcher, scope.organizationId, scope.projectId, scope.environmentId]);

  const allMemories = fetcher.data?.memories ?? [];
  const visible = allMemories
    .filter((m) => !deletedIds.has(m.id))
    .filter((m) => !filter || m.kind === filter);

  const onDelete = (id: string) => {
    if (!confirm("Delete this memory? Embedding evicts from pgvector. Cannot be undone.")) return;
    // LAUNCH-9 follow-up — Remix forms only do GET/POST natively. The
    // `/resources/agent` proxy honors `_method=DELETE` as a query param
    // (see `routes/resources.agent.ts`) and retargets to a real DELETE
    // upstream. POST body with `_method` was the wrong shape and the
    // proxy silently forwarded as POST, so the @Delete() handler on the
    // agent never matched.
    const params = new URLSearchParams({
      path: `/api/v1/memory/${id}`,
      _method: "DELETE",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    });
    deleteFetcher.submit(
      {},
      { method: "post", action: `/resources/agent?${params.toString()}` },
    );
    setDeletedIds((prev) => new Set(prev).add(id));
  };

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-[11px] text-emerald-300 hover:text-emerald-200"
      >
        {expanded ? "▼ Hide memory rows" : `▶ View all ${totalCount} memories`}
      </button>

      {expanded && (
        <div className="rounded border border-charcoal-700 bg-charcoal-900/40 p-2 space-y-2">
          {/* Kind filter chips */}
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setFilter("")}
              className={`text-[10px] px-2 py-0.5 rounded border ${
                filter === "" ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-charcoal-700 text-text-dimmed"
              }`}
            >
              all
            </button>
            {Object.keys(MEMORY_KIND_COLORS).map((kind) => (
              <button
                type="button"
                key={kind}
                onClick={() => setFilter(filter === kind ? "" : kind)}
                className={`text-[10px] px-2 py-0.5 rounded border ${
                  filter === kind ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-charcoal-700 text-text-dimmed"
                }`}
              >
                {kind}
              </button>
            ))}
          </div>

          {fetcher.state !== "idle" && allMemories.length === 0 && (
            <div className="text-[11px] text-text-dimmed text-center py-3">Loading…</div>
          )}
          {fetcher.data?.error && (
            <div className="text-[11px] text-rose-300 text-center py-3">
              Failed to load memories: {fetcher.data.error}
            </div>
          )}
          {fetcher.state === "idle" && allMemories.length === 0 && !fetcher.data?.error && (
            <div className="text-[11px] text-text-dimmed text-center py-3">
              No memory rows for this user.
            </div>
          )}

          <ul className="space-y-1.5 max-h-[300px] overflow-y-auto">
            {visible.map((m) => (
              <li
                key={m.id}
                className="rounded border border-charcoal-700 bg-charcoal-850 p-2 flex items-start gap-2"
              >
                <MemoryKindBadge kind={m.kind} count={1} />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-text-bright break-words">{m.content}</p>
                  <p className="text-[10px] text-text-dimmed mt-1">
                    {m.agentId ? `agent: ${m.agentId.slice(0, 8)}…` : "agent: (cluster)"}
                    {" · "}
                    {new Date(m.createdAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(m.id)}
                  className="text-[10px] text-rose-400 hover:text-rose-300 px-1.5 py-0.5"
                  title="Delete this memory"
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Stat card ─────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-charcoal-800 rounded-lg px-3 py-2 flex flex-col gap-0.5 min-w-[80px]">
      <span className="text-[10px] uppercase tracking-wide text-text-dimmed">{label}</span>
      <span className="text-base font-semibold text-text-bright">{value}</span>
    </div>
  );
}

// PRELAUNCH-A1-10 (follow-up 2026-05-04) — token row in the drawer's
// Tokens (30d) section. Renders a compact label/value pair with optional
// hint (e.g. "discounted" / "output rate") so the operator sees the
// breakdown at a glance.
function TokenRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-1 bg-charcoal-800 rounded">
      <span className="text-text-bright">{label}</span>
      <span className="text-text-dimmed font-mono">
        {value.toLocaleString()}
        {hint && <span className="ml-1 text-[10px] text-text-dimmed">{hint}</span>}
      </span>
    </div>
  );
}

// ─── User detail drawer ────────────────────────────────────────────────────

function UserDetailDrawer({
  userDetail,
  userRow,
  userConsumption,
  org,
  project,
  environment,
  scope,
  onClose,
}: {
  userDetail: UserDetail;
  // PRELAUNCH-A1-10 (follow-up) — token breakdown comes from the listing
  // payload (UserRow), separate from UserDetail (which carries the rich
  // memory + conversations payload).
  userRow: UserRow | null;
  // PRELAUNCH-A3-1 (follow-up) — consumption summary fetched in the loader.
  userConsumption: UserConsumption | null;
  org: { slug: string };
  project: { slug: string };
  environment: { id: string };
  scope: { organizationId: string; projectId: string; environmentId: string };
  onClose: () => void;
}) {
  const summaryFetcher = useFetcher<{ summary?: string; generatedAt?: string; error?: string }>();
  const isGenerating = summaryFetcher.state !== "idle";
  const summaryResult = summaryFetcher.data;
  const totalMemories = Object.values(userDetail.memoryBreakdown ?? {}).reduce((a, b) => a + b, 0);
  const totalConversations = userDetail.conversationsByAgent.reduce(
    (sum, g) => sum + g.threads.length,
    0,
  );
  const totalTurns = userDetail.conversationsByAgent.reduce(
    (sum, g) => sum + g.threads.length,
    0,
  );
  const approvalRate =
    userDetail.ratingsUps + userDetail.ratingsDowns > 0
      ? Math.round(
          (userDetail.ratingsUps / (userDetail.ratingsUps + userDetail.ratingsDowns)) * 100,
        )
      : null;

  return (
    <div className="w-[560px] flex-shrink-0 overflow-y-auto border-l border-charcoal-700 pl-4 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between sticky top-0 bg-background-bright pt-1 pb-2 border-b border-charcoal-700/50 z-10">
        <div>
          {userDetail.displayName && (
            <p className="text-sm font-semibold text-text-bright">{userDetail.displayName}</p>
          )}
          {userDetail.email && <p className="text-xs text-emerald-400">{userDetail.email}</p>}
          <p
            className={`text-xs font-mono text-text-dimmed mt-0.5 ${userDetail.displayName ? "" : "font-semibold text-text-bright"}`}
          >
            {userDetail.userId}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-text-dimmed hover:text-text-bright text-xs px-2 py-1"
        >
          ✕
        </button>
      </div>

      {/* Stats cards */}
      <div>
        <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
          Overview
        </p>
        <div className="flex flex-wrap gap-2">
          <StatCard label="Conversations" value={totalConversations} />
          <StatCard
            label="Cost (7d)"
            value={
              userDetail.cost7dCents > 0
                ? `$${(userDetail.cost7dCents / 100).toFixed(4)}`
                : "$0"
            }
          />
          <StatCard
            label="Cost (30d)"
            value={
              userDetail.cost30dCents > 0
                ? `$${(userDetail.cost30dCents / 100).toFixed(4)}`
                : "$0"
            }
          />
          <StatCard label="Memories" value={totalMemories} />
          {approvalRate !== null && (
            <StatCard label="Approval rate" value={`${approvalRate}%`} />
          )}
        </div>
      </div>

      {/* PRELAUNCH-A1-10 (follow-up 2026-05-04) — Tokens (30d) breakdown */}
      {userRow &&
        ((userRow.inputTokens ?? 0) > 0 ||
          (userRow.outputTokens ?? 0) > 0 ||
          (userRow.cacheReadInputTokens ?? 0) > 0 ||
          (userRow.cacheCreationInputTokens ?? 0) > 0 ||
          (userRow.reasoningTokens ?? 0) > 0) && (
          <div>
            <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
              Tokens (30d)
            </p>
            <div className="space-y-1 text-xs">
              <TokenRow label="Input" value={userRow.inputTokens ?? 0} />
              <TokenRow label="Output" value={userRow.outputTokens ?? 0} />
              {(userRow.cacheReadInputTokens ?? 0) > 0 && (
                <TokenRow
                  label="Cache read"
                  value={userRow.cacheReadInputTokens ?? 0}
                  hint="discounted"
                />
              )}
              {(userRow.cacheCreationInputTokens ?? 0) > 0 && (
                <TokenRow
                  label="Cache creation"
                  value={userRow.cacheCreationInputTokens ?? 0}
                  hint="surcharge"
                />
              )}
              {(userRow.reasoningTokens ?? 0) > 0 && (
                <TokenRow
                  label="Reasoning"
                  value={userRow.reasoningTokens ?? 0}
                  hint="output rate"
                />
              )}
            </div>
          </div>
        )}

      {/* PRELAUNCH-A3-1 / A3-15 (follow-up 2026-05-04) — Cap consumption.
          Renders one progress bar per cap that applies to this user, with a
          BREACHED badge when blocked === true. Pulled from
          `/api/v1/agent/monitoring/users/:userId/consumption`. */}
      {userConsumption && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide">
              Caps
            </p>
            {userConsumption.blocked && (
              <Badge variant="error">BREACHED</Badge>
            )}
          </div>
          {userConsumption.caps.length === 0 ? (
            <p className="text-xs text-text-dimmed">No caps configured for this user.</p>
          ) : (
            <div className="space-y-2">
              {userConsumption.caps.map((s) => {
                const pctClamped = Math.min(100, Math.max(0, s.percent));
                const barColor =
                  s.percent >= 100
                    ? "bg-rose-500"
                    : s.percent >= 80
                      ? "bg-amber-400"
                      : "bg-emerald-400";
                const label =
                  s.cap.scopeType === "scope"
                    ? `Scope · ${s.cap.period}`
                    : s.cap.scopeType === "agent"
                      ? `Agent · ${s.cap.period}`
                      : s.cap.targetId === "*"
                        ? `Per-user · ${s.cap.period}`
                        : `User · ${s.cap.period}`;
                return (
                  <div key={s.cap.id} className="text-xs">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-text-bright">{label}</span>
                      <span className="text-text-dimmed">
                        {`$${(s.spentCents / 100).toFixed(4)} of $${(s.cap.limitCents / 100).toFixed(4)} (${s.percent.toFixed(1)}%)`}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-charcoal-700">
                      <div className={`h-full ${barColor}`} style={{ width: `${pctClamped}%` }} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 items-center">
                      {s.blocked && <Badge variant="error">BREACHED</Badge>}
                      {s.overrideActive && (
                        <span className="grid h-4 place-items-center whitespace-nowrap rounded-full border border-amber-800 bg-amber-950 px-1.5 text-[10px] uppercase tracking-wider text-amber-300">
                          override
                        </span>
                      )}
                      {s.cap.tier === "skill" && (
                        <Badge variant="outline-rounded">{`Skill: ${s.cap.skillSlug ?? "all"}`}</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {userConsumption.rateLimit && (
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-wide text-text-dimmed mb-1">
                Rate limit (current window){userConsumption.rateLimited ? " · throttled" : ""}
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-charcoal-800 rounded px-2 py-1">
                  <span className="text-text-dimmed">minute: </span>
                  <span className="text-text-bright font-mono">{userConsumption.rateLimit.minute}</span>
                </span>
                <span className="bg-charcoal-800 rounded px-2 py-1">
                  <span className="text-text-dimmed">hour: </span>
                  <span className="text-text-bright font-mono">{userConsumption.rateLimit.hour}</span>
                </span>
                <span className="bg-charcoal-800 rounded px-2 py-1">
                  <span className="text-text-dimmed">day: </span>
                  <span className="text-text-bright font-mono">{userConsumption.rateLimit.day}</span>
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ratings */}
      {(userDetail.ratingsUps > 0 || userDetail.ratingsDowns > 0) && (
        <div>
          <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
            Message ratings
          </p>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-sm text-emerald-400">
              <HandThumbUpIcon className="size-4" />
              {userDetail.ratingsUps}
            </span>
            <span className="flex items-center gap-1.5 text-sm text-rose-400">
              <HandThumbDownIcon className="size-4" />
              {userDetail.ratingsDowns}
            </span>
            {approvalRate !== null && (
              <div className="flex-1 h-1.5 bg-charcoal-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${approvalRate}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Memory breakdown */}
      {totalMemories > 0 && (
        <div>
          <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
            Memory breakdown
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(userDetail.memoryBreakdown ?? {}).map(([kind, count]) => (
              <MemoryKindBadge key={kind} kind={kind} count={count} />
            ))}
          </div>
          {/* LAUNCH-5 — drill-down list of individual memory rows */}
          <MemoryListSection userId={userDetail.userId} totalCount={totalMemories} scope={scope} />
        </div>
      )}

      {/* Per-agent breakdown */}
      {userDetail.perAgentBreakdown && userDetail.perAgentBreakdown.length > 0 && (
        <div>
          <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
            Agent usage
          </p>
          <div className="space-y-1">
            {userDetail.perAgentBreakdown.map((a) => (
              <div key={a.agentId} className="flex items-center justify-between text-xs">
                <span className="text-text-bright truncate max-w-[300px]">{a.agentName}</span>
                <span className="text-text-dimmed">
                  {a.conversations} conv.
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Profile memories */}
      {userDetail.profileMemories.length > 0 && (
        <div>
          <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
            Profile memories
          </p>
          <div className="space-y-1">
            {userDetail.profileMemories.map((m) => (
              <div
                key={m.id}
                className="text-xs text-text-bright bg-charcoal-800 rounded px-2 py-1"
              >
                {m.content}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Risk events */}
      {userDetail.riskEvents.length > 0 && (
        <div>
          <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
            Risk events
          </p>
          <div className="space-y-1">
            {userDetail.riskEvents.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <Badge variant={e.severity === "high" ? "error" : "outline-rounded"}>
                  {e.kind}
                </Badge>
                <span className="text-text-dimmed truncate">{e.detail ?? e.severity}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversations by agent */}
      <div>
        <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-2">
          Conversations
        </p>
        {userDetail.conversationsByAgent.map((group) => (
          <div key={group.agentId} className="mb-4">
            <p className="text-xs font-semibold text-text-bright mb-1">{group.agentName}</p>
            <div className="space-y-1">
              {group.threads.map((t) => (
                <div key={t.threadId} className="flex items-center gap-2">
                  <Link
                    to={`${agentConversationsPath(org, project, environment, group.agentId)}/${t.threadId}`}
                    target="_blank"
                    className="flex-1 text-xs text-emerald-400 hover:text-emerald-300 truncate"
                  >
                    {t.title ?? t.threadId.slice(0, 12)}…
                  </Link>
                  <span className="text-xs text-text-dimmed flex-shrink-0">
                    {new Date(t.lastActiveAt).toLocaleDateString()}
                  </span>
                  <ArrowTopRightOnSquareIcon className="size-3 text-text-dimmed flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* AI Summary section */}
      <div className="border-t border-charcoal-700/50 pt-4">
        <p className="text-xs font-medium text-text-dimmed uppercase tracking-wide mb-3">
          AI Summary
        </p>

        {summaryResult?.error && (
          <div className="text-xs text-rose-400 bg-rose-900/20 rounded px-3 py-2 mb-3">
            {summaryResult.error}
          </div>
        )}

        {summaryResult?.summary && (
          <div className="text-xs text-text-bright bg-charcoal-800 rounded px-3 py-3 mb-3 leading-relaxed whitespace-pre-wrap">
            {summaryResult.summary}
            {summaryResult.generatedAt && (
              <p className="text-[10px] text-text-dimmed mt-2">
                Generated {new Date(summaryResult.generatedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        )}

        <summaryFetcher.Form method="post">
          <input type="hidden" name="intent" value="generate_summary" />
          <input type="hidden" name="userId" value={userDetail.userId} />
          <button
            type="submit"
            disabled={isGenerating}
            className="flex items-center gap-2 text-xs bg-violet-800/30 hover:bg-violet-800/50 disabled:opacity-50 disabled:cursor-not-allowed text-violet-300 border border-violet-700/40 rounded px-3 py-1.5 transition-colors"
          >
            {isGenerating ? (
              <>
                <Spinner className="size-3" />
                Generating summary with Claude Haiku…
              </>
            ) : (
              <>
                <SparklesIcon className="size-3.5" />
                {summaryResult?.summary ? "Regenerate AI Summary" : "Generate AI Summary"}
              </>
            )}
          </button>
        </summaryFetcher.Form>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function MonitoringUsersPage() {
  const {
    users,
    agentsList,
    userDetail,
    userConsumption,
    detailUserId,
    activeTab,
    org,
    project,
    environment,
    scopeHeaders,
  } = useTypedLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  // PRELAUNCH-A1-10 (follow-up 2026-05-04) — token sort options. Lets the
  // operator find the heaviest cache / reasoning users at a glance.
  const [sort, setSort] = useState<
    | "score"
    | "turns"
    | "cost"
    | "last-active"
    | "input-tokens"
    | "output-tokens"
    | "cache-read"
    | "reasoning"
  >("score");
  const [agentsSort, setAgentsSort] = useState<"turns" | "cost" | "users" | "last-active">(
    "turns",
  );

  const monPath = agentMonitoringPath(org, project, environment);
  const usersPath = agentMonitoringUsersPath(org, project, environment);

  // ── Users tab filtering / sorting ──────────────────────────────────────
  const filteredUsers = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return u.userId.toLowerCase().includes(q) || (u.alias ?? "").toLowerCase().includes(q);
  });

  const sortedUsers = [...filteredUsers].sort((a, b) => {
    if (sort === "turns") return b.totalTurns - a.totalTurns;
    if (sort === "cost") return b.cost7dCents - a.cost7dCents;
    if (sort === "last-active") return b.lastActiveAt.localeCompare(a.lastActiveAt);
    // PRELAUNCH-A1-10 (follow-up) — token-based sorts.
    if (sort === "input-tokens") return (b.inputTokens ?? 0) - (a.inputTokens ?? 0);
    if (sort === "output-tokens") return (b.outputTokens ?? 0) - (a.outputTokens ?? 0);
    if (sort === "cache-read")
      return (b.cacheReadInputTokens ?? 0) - (a.cacheReadInputTokens ?? 0);
    if (sort === "reasoning") return (b.reasoningTokens ?? 0) - (a.reasoningTokens ?? 0);
    return b.score - a.score;
  });

  // ── Agents tab filtering / sorting ─────────────────────────────────────
  const filteredAgents = agentsList.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.agentId.toLowerCase().includes(q) ||
      a.agentName.toLowerCase().includes(q) ||
      (a.model ?? "").toLowerCase().includes(q)
    );
  });

  const sortedAgents = [...filteredAgents].sort((a, b) => {
    if (agentsSort === "cost") return b.cost7dCents - a.cost7dCents;
    if (agentsSort === "users") return b.uniqueUsers - a.uniqueUsers;
    if (agentsSort === "last-active") return b.lastActiveAt.localeCompare(a.lastActiveAt);
    return b.totalTurns - a.totalTurns;
  });

  const tabPath = (tab: "users" | "agents") => {
    const p = new URLSearchParams(searchParams);
    p.set("tab", tab);
    // Clear detail when switching tabs
    p.delete("userId");
    return `${usersPath}?${p.toString()}`;
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Monitoring" />
        <div className="flex gap-2 text-sm">
          <Link to={monPath} className="text-text-dimmed hover:text-text-bright px-3 py-1">
            Cost
          </Link>
          <Link
            to={tabPath("users")}
            className={
              activeTab === "users"
                ? "border-b-2 border-emerald-400 text-emerald-400 px-3 py-1 font-medium"
                : "text-text-dimmed hover:text-text-bright px-3 py-1"
            }
          >
            Users
          </Link>
          <Link
            to={tabPath("agents")}
            className={
              activeTab === "agents"
                ? "border-b-2 border-emerald-400 text-emerald-400 px-3 py-1 font-medium"
                : "text-text-dimmed hover:text-text-bright px-3 py-1"
            }
          >
            Agents
          </Link>
        </div>
        <div className="ml-auto">
          <DocsLink slug="monitoring" />
        </div>
      </NavBar>

      <PageBody>
        <div className="flex flex-col h-full gap-4 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <Input
              placeholder={activeTab === "users" ? "Search user ID or alias…" : "Search agent…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-72"
            />

            {activeTab === "users" ? (
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
                className="bg-charcoal-800 border border-charcoal-600 text-text-bright rounded px-3 py-1.5 text-sm"
              >
                <option value="score">Score ↓</option>
                <option value="last-active">Last active ↓</option>
                <option value="turns">Total turns ↓</option>
                <option value="cost">Cost (7d) ↓</option>
                {/* PRELAUNCH-A1-10 — token-based sorts so the operator
                    can find heavy cache / reasoning consumers fast. */}
                <option value="input-tokens">Input tokens ↓</option>
                <option value="output-tokens">Output tokens ↓</option>
                <option value="cache-read">Cache reads ↓</option>
                <option value="reasoning">Reasoning ↓</option>
              </select>
            ) : (
              <select
                value={agentsSort}
                onChange={(e) => setAgentsSort(e.target.value as typeof agentsSort)}
                className="bg-charcoal-800 border border-charcoal-600 text-text-bright rounded px-3 py-1.5 text-sm"
              >
                <option value="turns">Turns ↓</option>
                <option value="users">Unique users ↓</option>
                <option value="cost">Cost (7d) ↓</option>
                <option value="last-active">Last active ↓</option>
              </select>
            )}

            <Paragraph variant="small" className="ml-auto text-text-dimmed">
              {activeTab === "users"
                ? `${sortedUsers.length} user${sortedUsers.length !== 1 ? "s" : ""}`
                : `${sortedAgents.length} agent${sortedAgents.length !== 1 ? "s" : ""}`}
            </Paragraph>
          </div>

          <div className="flex flex-1 gap-4 overflow-hidden">
            {/* Main table */}
            <div className={`flex-1 overflow-auto ${detailUserId ? "min-w-0" : ""}`}>
              {activeTab === "users" ? (
                // ── Users table ──────────────────────────────────────────
                sortedUsers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-text-dimmed gap-3">
                    <UserIcon className="size-10 opacity-40" />
                    <Paragraph variant="small">No users found in the last 30 days.</Paragraph>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>User</TableHeaderCell>
                        <TableHeaderCell>Score</TableHeaderCell>
                        <TableHeaderCell>Conversations</TableHeaderCell>
                        <TableHeaderCell>Agents</TableHeaderCell>
                        <TableHeaderCell>Turns</TableHeaderCell>
                        {/* LAUNCH-6 — Memories column removed; the count is */}
                        {/* available + actionable in the per-user drawer. The */}
                        {/* row showed a literal `—` placeholder that meant nothing */}
                        {/* and was eating the score-ring's column space. */}
                        <TableHeaderCell>Cost (7d)</TableHeaderCell>
                        <TableHeaderCell>Last active</TableHeaderCell>
                        <TableHeaderCell>Risk</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedUsers.map((u) => (
                        <TableRow
                          key={u.userId}
                          className="cursor-pointer hover:bg-charcoal-800/50"
                          onClick={() =>
                            navigate(
                              `${usersPath}?tab=users&userId=${encodeURIComponent(u.userId)}`,
                            )
                          }
                        >
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              {u.alias && (
                                <span className="text-sm font-medium text-text-bright">
                                  {u.alias}
                                </span>
                              )}
                              <span className="text-xs text-text-dimmed font-mono truncate max-w-[200px]">
                                {u.userId}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <ScoreRing score={u.score} />
                          </TableCell>
                          <TableCell>{u.totalConversations}</TableCell>
                          <TableCell>{u.agentsTouched}</TableCell>
                          <TableCell>{u.totalTurns}</TableCell>
                          {/* Memories column removed (LAUNCH-6) — see drawer */}
                          <TableCell>
                            {u.cost7dCents > 0
                              ? `$${(u.cost7dCents / 100).toFixed(4)}`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-text-dimmed text-xs whitespace-nowrap">
                            {/* LAUNCH-6 — show date AND time (was just date) */}
                            {new Date(u.lastActiveAt).toLocaleString(undefined, {
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                          </TableCell>
                          <TableCell>
                            {u.riskFlagCount > 0 ? (
                              <Badge variant="error">
                                <ExclamationTriangleIcon className="size-3 mr-1" />
                                {u.riskFlagCount}
                              </Badge>
                            ) : (
                              <span className="text-text-dimmed text-xs">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : (
                // ── Agents table ─────────────────────────────────────────
                sortedAgents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-text-dimmed gap-3">
                    <CpuChipIcon className="size-10 opacity-40" />
                    <Paragraph variant="small">No agent activity in the last 30 days.</Paragraph>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Agent</TableHeaderCell>
                        <TableHeaderCell>Model</TableHeaderCell>
                        <TableHeaderCell>Conversations</TableHeaderCell>
                        <TableHeaderCell>Unique users</TableHeaderCell>
                        <TableHeaderCell>Total turns</TableHeaderCell>
                        <TableHeaderCell>Cost (7d)</TableHeaderCell>
                        <TableHeaderCell>Last active</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedAgents.map((a) => (
                        <TableRow
                          key={a.agentId}
                          className="cursor-pointer hover:bg-charcoal-800/50"
                          onClick={() =>
                            navigate(agentPath(org, project, environment, a.agentId))
                          }
                        >
                          <TableCell>
                            <span className="text-sm font-medium text-text-bright">
                              {a.agentName}
                            </span>
                          </TableCell>
                          <TableCell>
                            {a.model ? (
                              <span className="text-xs font-mono text-text-dimmed">
                                {a.model}
                              </span>
                            ) : (
                              <span className="text-text-dimmed text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell>{a.totalConversations}</TableCell>
                          <TableCell>{a.uniqueUsers}</TableCell>
                          <TableCell>{a.totalTurns}</TableCell>
                          <TableCell>
                            {a.cost7dCents > 0
                              ? `$${(a.cost7dCents / 100).toFixed(4)}`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-text-dimmed text-xs">
                            {new Date(a.lastActiveAt).toLocaleDateString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              )}
            </div>

            {/* User detail drawer — only on users tab */}
            {activeTab === "users" && userDetail && (
              <UserDetailDrawer
                userDetail={userDetail}
                userRow={users.find((u) => u.userId === userDetail.userId) ?? null}
                userConsumption={userConsumption}
                org={org}
                project={project}
                environment={environment}
                scope={scopeHeaders}
                onClose={() => navigate(`${usersPath}?tab=users`)}
              />
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
