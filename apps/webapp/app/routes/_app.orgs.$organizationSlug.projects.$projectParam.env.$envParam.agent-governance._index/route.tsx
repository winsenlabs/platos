import { ShieldCheckIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { Link, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
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
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentBudgetsPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Governance | Platos" }];

// Theme H.10 — governance dashboard. Detector timeline + budget status +
// agent risk score. Pulls the full payload from the agent service's
// /monitoring/governance endpoint which composes BudgetService +
// SafetyEventService + agent-risk scoring.

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

type DetectorsSummary = {
  total: number;
  byDetector: Record<string, number>;
  byAction: Record<string, number>;
  bySeverity: Record<string, number>;
};

type RecentEvent = {
  id: string;
  detector: string;
  action: string;
  severity: "low" | "medium" | "high";
  detail: string | null;
  meta: any;
  agentId: string | null;
  threadId: string | null;
  userId: string | null;
  toolName: string | null;
  createdAt: string;
};

type BudgetStatus = {
  cap: {
    id: string;
    scopeType: "scope" | "agent" | "user";
    targetId: string;
    period: "day" | "week" | "month";
    limitCents: number;
    runsLimit: number;
    enabled: boolean;
  };
  windowKey: string;
  spentCents: number;
  runs: number;
  percent: number;
  runsPercent: number;
  blocked: boolean;
  overrideActive: boolean;
};

type AgentRiskRow = {
  agentId: string;
  agentName: string | null;
  turns: number;
  piiEvents: number;
  injectionEvents: number;
  toolErrors: number;
  approvalEvents: number;
  risk: number;
  band: "low" | "medium" | "high";
};

type GovernancePayload = {
  sinceDays: number;
  detectors: DetectorsSummary;
  recentEvents: RecentEvent[];
  budgets: BudgetStatus[];
  agentRisk: AgentRiskRow[];
  fetchedAt: string;
};

// PRELAUNCH-A3-3 (follow-up 2026-05-04) — breaches endpoint payload.
type BreachRow = {
  userId: string;
  capId: string;
  percent: number;
  period: "minute" | "hour" | "day" | "week" | "month";
};
type BreachesPayload = {
  breaches: BreachRow[];
  fetchedAt: string;
};

// PRELAUNCH-A1-11 (follow-up 2026-05-04) — per-user rows from
// /monitoring/users, aggregated into the token-mix panel.
type MonitoringUserRow = {
  userId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  /** WIN-134 — derived by the usage ledger on the agent, not here. */
  noCacheInputTokens?: number;
};

type TokenMix = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  noCacheInputTokens: number;
  totalInputCounted: number;
  cacheHitPercent: number;
  reasoningSharePercent: number;
};

type LoaderData = {
  agentReachable: boolean;
  payload: GovernancePayload | null;
  breaches: BreachesPayload | null;
  tokenMix: TokenMix | null;
  budgetsPath: string;
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
      signal: AbortSignal.timeout(15_000),
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

  // PRELAUNCH-A3-3 + A1-11 (follow-up 2026-05-04) — fan out to three
  // endpoints in parallel: governance dashboard, breaches list, and the
  // monitoring users list (for the token-mix aggregation panel). All are
  // fail-graceful — if any one returns null we still render the others.
  const [payload, breaches, usersList] = await Promise.all([
    agentGet<GovernancePayload>("/api/v1/agent/monitoring/governance?sinceDays=7", scope),
    agentGet<BreachesPayload>("/api/v1/agent/monitoring/breaches", scope),
    agentGet<{ users: MonitoringUserRow[] }>(
      "/api/v1/agent/monitoring/users?limit=500&sinceDays=7",
      scope,
    ),
  ]);

  // Aggregate the token-mix panel data from the monitoring users payload.
  let tokenMix: TokenMix | null = null;
  if (usersList && usersList.users) {
    const sum = (key: keyof MonitoringUserRow) =>
      usersList.users.reduce((a, u) => a + (Number(u[key]) || 0), 0);
    const inputTokens = sum("inputTokens");
    const outputTokens = sum("outputTokens");
    const cacheReadInputTokens = sum("cacheReadInputTokens");
    const cacheCreationInputTokens = sum("cacheCreationInputTokens");
    const reasoningTokens = sum("reasoningTokens");
    const totalInputCounted = inputTokens; // already includes cache slice on v6
    // WIN-134 — this used to subtract the cache lanes itself. The chat
    // inspector did the same subtraction per step and the runtime did it again
    // over turn totals, so one label carried three different numbers. The
    // agent's usage ledger derives it once and every surface sums the result.
    const noCacheInputTokens = sum("noCacheInputTokens");
    const cacheHitDenom = inputTokens > 0 ? inputTokens : 1;
    const cacheHitPercent = (cacheReadInputTokens / cacheHitDenom) * 100;
    const reasoningDenom = outputTokens > 0 ? outputTokens : 1;
    const reasoningSharePercent = (reasoningTokens / reasoningDenom) * 100;
    tokenMix = {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      reasoningTokens,
      noCacheInputTokens,
      totalInputCounted,
      cacheHitPercent: Number(cacheHitPercent.toFixed(2)),
      reasoningSharePercent: Number(reasoningSharePercent.toFixed(2)),
    };
  }

  const data: LoaderData = {
    agentReachable: payload !== null,
    payload,
    breaches,
    tokenMix,
    budgetsPath: agentBudgetsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
    ),
  };
  return typedjson(data);
}

function fmtCents(c: number): string {
  if (!c || c <= 0) return "$0.00";
  if (c < 100) return `$${(c / 100).toFixed(4)}`;
  return `$${(c / 100).toFixed(2)}`;
}

// PRELAUNCH-A1-11 (follow-up 2026-05-04) — token-mix card. Compact
// label/value with optional accent (emerald = good, amber = expensive).
function TokenMixCard({
  label,
  value,
  sublabel,
  accent = "default",
}: {
  label: string;
  value: number;
  sublabel?: string;
  accent?: "default" | "emerald" | "amber";
}) {
  const accentClass =
    accent === "emerald"
      ? "text-emerald-400"
      : accent === "amber"
        ? "text-amber-400"
        : "text-text-bright";
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
      <p className="mb-1 text-xs text-text-dimmed">{label}</p>
      <p className={`text-2xl font-semibold ${accentClass}`}>{value.toLocaleString()}</p>
      {sublabel && <p className="mt-0.5 text-[10px] text-text-dimmed">{sublabel}</p>}
    </div>
  );
}

// PRELAUNCH-A1-11 — percent bar for derived KPIs (cache hit rate,
// reasoning share). Bar color tunable per call site.
function PercentBar({
  label,
  percent,
  hint,
  color,
}: {
  label: string;
  percent: number;
  hint?: string;
  color: string;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-3">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-text-bright">{label}</span>
        <span className="font-mono text-text-dimmed">{percent.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-charcoal-700">
        <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
      {hint && <p className="mt-1 text-[10px] text-text-dimmed">{hint}</p>}
    </div>
  );
}

function severityVariant(
  sev: "low" | "medium" | "high",
): "success" | "outline-rounded" | "error" {
  if (sev === "high") return "error";
  if (sev === "medium") return "outline-rounded";
  return "success";
}

function riskVariant(band: "low" | "medium" | "high"): "success" | "outline-rounded" | "error" {
  if (band === "high") return "error";
  if (band === "medium") return "outline-rounded";
  return "success";
}

export default function Page() {
  const { agentReachable, payload, breaches, tokenMix, budgetsPath } =
    useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Governance" />
        <PageAccessories>
          <DocsLink slug="safety-and-pii" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        {!agentReachable ? (
          <div className="flex items-center gap-2 rounded-lg border border-yellow-800 bg-yellow-950/30 p-4">
            <ExclamationTriangleIcon className="h-5 w-5 text-yellow-500" />
            <Paragraph>
              Agent service unreachable — governance dashboard cannot render live
              signals. Check the agent container and reload.
            </Paragraph>
          </div>
        ) : payload === null ? (
          <Paragraph>Loading…</Paragraph>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Detector summary cards */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
                <p className="mb-1 text-xs text-text-dimmed">Events (7d)</p>
                <p className="text-2xl font-semibold text-text-bright">
                  {payload.detectors.total.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
                <p className="mb-1 text-xs text-text-dimmed">High severity</p>
                <p className="text-2xl font-semibold text-text-bright">
                  {(payload.detectors.bySeverity.high ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
                <p className="mb-1 text-xs text-text-dimmed">Blocks</p>
                <p className="text-2xl font-semibold text-text-bright">
                  {(payload.detectors.byAction.block ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
                <p className="mb-1 text-xs text-text-dimmed">PII flags</p>
                <p className="text-2xl font-semibold text-text-bright">
                  {(payload.detectors.byDetector.pii ?? 0).toLocaleString()}
                </p>
              </div>
            </div>

            {/* PRELAUNCH-A1-11 (follow-up 2026-05-04) — Token mix panel.
                Aggregates input / output / cache_read / cache_write /
                reasoning over the past 7 days. Cache-hit-rate +
                reasoning-share derived percentages give an at-a-glance
                read on how much spend is being saved by caching and how
                much is going to reasoning models. */}
            {tokenMix && (tokenMix.inputTokens > 0 || tokenMix.outputTokens > 0) && (
              <section>
                <h2 className="mb-2 text-sm font-semibold text-text-bright">
                  Token mix (7d)
                </h2>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <TokenMixCard
                    label="No-cache input"
                    value={tokenMix.noCacheInputTokens}
                    sublabel="billed at 1.0×"
                  />
                  <TokenMixCard
                    label="Cache reads"
                    value={tokenMix.cacheReadInputTokens}
                    sublabel="discounted (per provider)"
                    accent={tokenMix.cacheHitPercent >= 30 ? "emerald" : "default"}
                  />
                  <TokenMixCard
                    label="Cache writes"
                    value={tokenMix.cacheCreationInputTokens}
                    sublabel="surcharge"
                  />
                  <TokenMixCard
                    label="Reasoning"
                    value={tokenMix.reasoningTokens}
                    sublabel="output rate"
                    accent={tokenMix.reasoningTokens > 0 ? "amber" : "default"}
                  />
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <PercentBar
                    label="Cache hit rate"
                    percent={tokenMix.cacheHitPercent}
                    hint={`${tokenMix.cacheReadInputTokens.toLocaleString()} of ${tokenMix.inputTokens.toLocaleString()} input tokens`}
                    color={
                      tokenMix.cacheHitPercent >= 30
                        ? "bg-emerald-500"
                        : tokenMix.cacheHitPercent >= 10
                          ? "bg-amber-400"
                          : "bg-charcoal-500"
                    }
                  />
                  <PercentBar
                    label="Reasoning share of output"
                    percent={tokenMix.reasoningSharePercent}
                    hint={`${tokenMix.reasoningTokens.toLocaleString()} of ${tokenMix.outputTokens.toLocaleString()} output tokens`}
                    color={
                      tokenMix.reasoningSharePercent >= 30
                        ? "bg-amber-400"
                        : "bg-charcoal-500"
                    }
                  />
                </div>
              </section>
            )}

            {/* PRELAUNCH-A3-3 (follow-up 2026-05-04) — Currently breached
                users panel. Pulls from /api/v1/agent/monitoring/breaches
                — every (cap, userId) pair currently >= 100% utilisation. */}
            {breaches && breaches.breaches.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-text-bright">
                    Currently breached users
                  </h2>
                  <Badge variant="error">{breaches.breaches.length}</Badge>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>User</TableHeaderCell>
                      <TableHeaderCell>Cap</TableHeaderCell>
                      <TableHeaderCell>Period</TableHeaderCell>
                      <TableHeaderCell alignment="right">% used</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {breaches.breaches.map((b, i) => (
                      <TableRow key={`${b.capId}:${b.userId}:${i}`}>
                        <TableCell>
                          <span className="font-mono text-xs text-text-bright">
                            {b.userId === "*" ? "(scope-wide)" : b.userId}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs text-text-dimmed">{b.capId}</span>
                        </TableCell>
                        <TableCell>{b.period}</TableCell>
                        <TableCell alignment="right">
                          <span className="text-rose-400 font-semibold">
                            {b.percent.toFixed(1)}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            )}

            {/* Budgets */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-bright">
                  Budget usage
                </h2>
                <Link
                  to={budgetsPath}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Configure caps →
                </Link>
              </div>
              {payload.budgets.length === 0 ? (
                <Paragraph>
                  No budget caps configured yet. Create one from the{" "}
                  <Link to={budgetsPath} className="text-blue-400">
                    budgets page
                  </Link>
                  .
                </Paragraph>
              ) : (
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {payload.budgets.map((b) => {
                    const pct = Math.min(100, b.percent);
                    const colour =
                      b.percent >= 100
                        ? "bg-red-500"
                        : b.percent >= 80
                          ? "bg-amber-400"
                          : b.percent >= 50
                            ? "bg-yellow-400"
                            : "bg-emerald-500";
                    return (
                      <div
                        key={b.cap.id}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-3"
                      >
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="text-text-bright">
                            {b.cap.scopeType}
                            {b.cap.scopeType !== "scope" ? `: ${b.cap.targetId}` : ""}
                          </span>
                          <Badge variant={b.blocked ? "error" : "outline-rounded"}>
                            {b.blocked ? "blocked" : b.overrideActive ? "override" : "active"}
                          </Badge>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-sm bg-charcoal-800">
                          <div className={`${colour} h-full`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="mt-1 flex items-baseline justify-between text-[11px] text-text-dimmed">
                          <span>
                            {fmtCents(b.spentCents)} / {fmtCents(b.cap.limitCents)}
                          </span>
                          <span className="font-mono">{b.percent.toFixed(0)}%</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-charcoal-400">
                          {b.cap.period} · window {b.windowKey}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Agent risk */}
            <section>
              <h2 className="mb-2 text-sm font-semibold text-text-bright">Agent risk</h2>
              {payload.agentRisk.length === 0 ? (
                <Paragraph>No agents with tracked signals in the last 7 days.</Paragraph>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Agent</TableHeaderCell>
                      <TableHeaderCell alignment="right">Turns</TableHeaderCell>
                      <TableHeaderCell alignment="right">PII</TableHeaderCell>
                      <TableHeaderCell alignment="right">Injection</TableHeaderCell>
                      <TableHeaderCell alignment="right">Tool errors</TableHeaderCell>
                      <TableHeaderCell alignment="right">Approvals</TableHeaderCell>
                      <TableHeaderCell alignment="right">Risk</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payload.agentRisk.map((r) => (
                      <TableRow key={r.agentId}>
                        <TableCell>{r.agentName ?? r.agentId}</TableCell>
                        <TableCell alignment="right">{r.turns}</TableCell>
                        <TableCell alignment="right">{r.piiEvents}</TableCell>
                        <TableCell alignment="right">{r.injectionEvents}</TableCell>
                        <TableCell alignment="right">{r.toolErrors}</TableCell>
                        <TableCell alignment="right">{r.approvalEvents}</TableCell>
                        <TableCell alignment="right">
                          <Badge variant={riskVariant(r.band)}>{r.risk.toFixed(1)}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            {/* Recent events timeline */}
            <section>
              <h2 className="mb-2 text-sm font-semibold text-text-bright">
                <ShieldCheckIcon className="mr-1 inline-block h-4 w-4" />
                Recent detector events
              </h2>
              {payload.recentEvents.length === 0 ? (
                <Paragraph>No detector events in the last 7 days.</Paragraph>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Time</TableHeaderCell>
                      <TableHeaderCell>Detector</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                      <TableHeaderCell>Severity</TableHeaderCell>
                      <TableHeaderCell>Detail</TableHeaderCell>
                      <TableHeaderCell>Agent</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payload.recentEvents.slice(0, 50).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-[11px]">
                          {new Date(e.createdAt).toLocaleTimeString()}
                        </TableCell>
                        <TableCell>{e.detector}</TableCell>
                        <TableCell>{e.action}</TableCell>
                        <TableCell>
                          <Badge variant={severityVariant(e.severity)}>{e.severity}</Badge>
                        </TableCell>
                        <TableCell className="max-w-sm truncate">
                          {e.detail ?? "—"}
                        </TableCell>
                        <TableCell>{e.agentId ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}
