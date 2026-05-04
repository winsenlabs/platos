import { ChartBarIcon, Cog8ToothIcon } from "@heroicons/react/20/solid";
import { Link, useSearchParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Evals | Platos" }];

interface AggregateRow {
  criterionId: string;
  criterionName: string;
  agentVersionId: string | null;
  versionNumber: number | null;
  sampleCount: number;
  meanScore: number;
  passRate: number;
}

interface SatisfactionRow {
  agentVersionId: string | null;
  versionNumber: number | null;
  ups: number;
  downs: number;
  total: number;
  score: number;
}

interface AgentRef {
  id: string;
  name: string;
  model: string;
}

type LoaderData = {
  agents: AgentRef[];
  selectedAgentId: string | null;
  aggregate: { days: number; rows: AggregateRow[] } | null;
  satisfaction: { days: number; total: number; rows: SatisfactionRow[] } | null;
  days: number;
  criteriaPath: string;
};

function scopeHeaders(scope: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "30", 10)));
  const selectedAgentId = url.searchParams.get("agentId");

  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

  let agents: AgentRef[] = [];
  let aggregate: { days: number; rows: AggregateRow[] } | null = null;
  let satisfaction: { days: number; total: number; rows: SatisfactionRow[] } | null = null;
  try {
    const agentsRes = await fetch(`${AGENT_API_URL}/api/v1/agent/agents`, {
      headers: scopeHeaders(scope),
      signal: AbortSignal.timeout(5000),
    });
    if (agentsRes.ok) {
      const body = (await agentsRes.json()) as { agents?: AgentRef[] };
      agents = body.agents ?? [];
    }
    if (selectedAgentId) {
      const [aggRes, satRes] = await Promise.all([
        fetch(
          `${AGENT_API_URL}/api/v1/agent/agents/${selectedAgentId}/evals/aggregate?days=${days}`,
          { headers: scopeHeaders(scope), signal: AbortSignal.timeout(8000) },
        ),
        fetch(
          `${AGENT_API_URL}/api/v1/agent/agents/${selectedAgentId}/satisfaction?days=${days}`,
          { headers: scopeHeaders(scope), signal: AbortSignal.timeout(5000) },
        ),
      ]);
      if (aggRes.ok) aggregate = (await aggRes.json()) as typeof aggregate;
      if (satRes.ok) satisfaction = (await satRes.json()) as typeof satisfaction;
    }
  } catch {
    // empty state
  }

  const criteriaPath = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  )}/eval-criteria`;

  const payload: LoaderData = {
    agents,
    selectedAgentId,
    aggregate,
    satisfaction,
    days,
    criteriaPath,
  };
  return typedjson(payload);
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function colorForScore(score: number): string {
  if (score >= 80) return "text-emerald-400";
  if (score >= 60) return "text-sky-400";
  if (score >= 40) return "text-amber-400";
  return "text-red-400";
}

export default function AgentEvalsPage() {
  const { agents, selectedAgentId, aggregate, satisfaction, days, criteriaPath } =
    useTypedLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const rowsByCriterion = new Map<string, AggregateRow[]>();
  for (const r of aggregate?.rows ?? []) {
    const arr = rowsByCriterion.get(r.criterionName) ?? [];
    arr.push(r);
    rowsByCriterion.set(r.criterionName, arr);
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Agent Evals"
          icon={<ChartBarIcon className="size-5 text-emerald-500" />}
        />
        <PageAccessories>
          <DocsLink slug="evals" />
          <LinkButton to={criteriaPath} variant="tertiary/small" LeadingIcon={Cog8ToothIcon}>
            Manage criteria
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text-dimmed">
            Agent
            <select
              value={selectedAgentId ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                if (e.target.value) next.set("agentId", e.target.value);
                else next.delete("agentId");
                setSearchParams(next, { replace: true });
              }}
              className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-sm text-text-bright"
            >
              <option value="">— select agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-text-dimmed">
            Window
            <select
              value={days}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                next.set("days", e.target.value);
                setSearchParams(next, { replace: true });
              }}
              className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-sm text-text-bright"
            >
              <option value={1}>Last 24h</option>
              <option value={7}>Last 7d</option>
              <option value={30}>Last 30d</option>
              <option value={90}>Last 90d</option>
            </select>
          </label>
        </div>

        {!selectedAgentId && (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/40 px-4 py-10 text-center text-sm text-text-dimmed">
            Pick an agent above to see its eval scoreboard.
          </div>
        )}

        {selectedAgentId && (
          <>
            <section className="mb-6">
              <Header3>Satisfaction (thumbs ratings)</Header3>
              <Paragraph variant="small" className="mt-1 text-text-dimmed">
                Per-version thumbs-up rate over the last {days} day{days === 1 ? "" : "s"}.
                Theme J.2. Ratings are anonymized — userId never surfaces here.
              </Paragraph>
              {!satisfaction || satisfaction.total === 0 ? (
                <div className="mt-2 rounded-md border border-charcoal-700 bg-charcoal-900/40 px-3 py-4 text-sm text-text-dimmed">
                  No ratings collected yet.
                </div>
              ) : (
                <div className="mt-2 overflow-hidden rounded-lg border border-charcoal-700">
                  <table className="w-full text-sm">
                    <thead className="bg-charcoal-800">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Version</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Total</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Up</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Down</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-charcoal-700/60">
                      {satisfaction.rows.map((r) => (
                        <tr key={r.agentVersionId ?? "none"} className="bg-charcoal-900/60">
                          <td className="px-3 py-2 font-mono text-xs text-text-bright">
                            {r.versionNumber != null ? `v${r.versionNumber}` : "(unversioned)"}
                          </td>
                          <td className="px-3 py-2 text-text-bright">{r.total}</td>
                          <td className="px-3 py-2 text-emerald-400">{r.ups}</td>
                          <td className="px-3 py-2 text-red-400">{r.downs}</td>
                          <td className="px-3 py-2 font-mono text-text-bright">
                            {formatPct(r.score)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <Header3>LLM-judge scoreboard</Header3>
              <Paragraph variant="small" className="mt-1 text-text-dimmed">
                Mean judge score per (criterion, version). Theme J.6.
              </Paragraph>
              {!aggregate || aggregate.rows.length === 0 ? (
                <div className="mt-2 rounded-md border border-charcoal-700 bg-charcoal-900/40 px-3 py-4 text-sm text-text-dimmed">
                  No judge evals recorded yet. Create a criterion and run evals
                  from the agent detail page.
                </div>
              ) : (
                <div className="mt-2 overflow-hidden rounded-lg border border-charcoal-700">
                  <table className="w-full text-sm">
                    <thead className="bg-charcoal-800">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Criterion</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Version</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Samples</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Mean score</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Pass rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-charcoal-700/60">
                      {Array.from(rowsByCriterion.entries()).flatMap(([criterionName, rows]) =>
                        rows.map((r, idx) => (
                          <tr key={`${criterionName}-${r.agentVersionId ?? "none"}`} className="bg-charcoal-900/60">
                            <td className="px-3 py-2 text-text-bright">
                              {idx === 0 ? criterionName : <span className="text-text-dimmed">↳</span>}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-text-bright">
                              {r.versionNumber != null ? `v${r.versionNumber}` : "(unversioned)"}
                            </td>
                            <td className="px-3 py-2 text-text-bright">{r.sampleCount}</td>
                            <td className={`px-3 py-2 font-mono ${colorForScore(r.meanScore)}`}>
                              {r.meanScore.toFixed(1)}
                            </td>
                            <td className="px-3 py-2 text-text-bright">{formatPct(r.passRate)}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </PageBody>
    </PageContainer>
  );
}
