import {
  ArrowUturnLeftIcon,
  ScaleIcon,
} from "@heroicons/react/20/solid";
import { useSearchParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentPath as agentDetailPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent A/B — Evals | Platos" }];

interface AggregateRow {
  criterionId: string;
  criterionName: string;
  agentVersionId: string | null;
  versionNumber: number | null;
  sampleCount: number;
  meanScore: number;
  passRate: number;
}

interface AgentVersion {
  id: string;
  versionNumber: number;
  createdAt: string;
}

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
  const agentId = params.agentId!;
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
  const versionA = url.searchParams.get("versionA");
  const versionB = url.searchParams.get("versionB");

  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

  let versions: AgentVersion[] = [];
  let aggregate: { days: number; rows: AggregateRow[] } | null = null;
  let agentName = agentId;
  try {
    const [versionsRes, agentRes] = await Promise.all([
      fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}/versions`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (versionsRes.ok) {
      const body = (await versionsRes.json()) as { versions?: AgentVersion[] };
      versions = body.versions ?? [];
    }
    if (agentRes.ok) {
      const agent = (await agentRes.json()) as { name?: string };
      agentName = agent.name || agentId;
    }
    if (versionA && versionB) {
      const aggRes = await fetch(
        `${AGENT_API_URL}/api/v1/agent/agents/${agentId}/evals/aggregate?days=${days}&versionIds=${versionA},${versionB}`,
        { headers: scopeHeaders(scope), signal: AbortSignal.timeout(8000) },
      );
      if (aggRes.ok) aggregate = (await aggRes.json()) as typeof aggregate;
    }
  } catch {
    // empty state
  }

  const backPath = agentDetailPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
    agentId,
  );

  const payload: {
    agentId: string;
    agentName: string;
    versions: AgentVersion[];
    aggregate: { days: number; rows: AggregateRow[] } | null;
    days: number;
    versionA: string | null;
    versionB: string | null;
    backPath: string;
  } = { agentId, agentName, versions, aggregate, days, versionA, versionB, backPath };
  return typedjson(payload);
}

/**
 * Two-proportion z-test for pass rate difference at rough thresholds. Used to
 * label the "winning" version with a confidence percentage. Returns null when
 * either sample is empty — the UI shows "insufficient data" instead.
 */
function significance(
  a: { passes: number; total: number },
  b: { passes: number; total: number },
): { winner: "A" | "B" | "tie"; confidencePct: number } | null {
  if (a.total === 0 || b.total === 0) return null;
  const pA = a.passes / a.total;
  const pB = b.passes / b.total;
  const p = (a.passes + b.passes) / (a.total + b.total);
  const se = Math.sqrt(p * (1 - p) * (1 / a.total + 1 / b.total));
  if (se === 0) return { winner: "tie", confidencePct: 0 };
  const z = Math.abs(pA - pB) / se;
  // Normal CDF approximation (Abramowitz-Stegun).
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  const d =
    0.3989422804014327 * Math.exp((-absZ * absZ) / 2);
  const cdf =
    1 -
    d *
      (0.319381530 * t -
        0.356563782 * t * t +
        1.781477937 * t * t * t -
        1.821255978 * t * t * t * t +
        1.330274429 * t * t * t * t * t);
  // Two-sided to one-sided: take cdf directly for the winning side.
  const confidencePct = Math.round(cdf * 1000) / 10;
  const winner: "A" | "B" | "tie" =
    Math.abs(pA - pB) < 0.01 ? "tie" : pA > pB ? "A" : "B";
  return { winner, confidencePct };
}

export default function AgentEvalsABPage() {
  const { agentId, agentName, versions, aggregate, days, versionA, versionB, backPath } =
    useTypedLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Group aggregate rows per criterion then by version key.
  const perCriterion = new Map<string, { a: AggregateRow | null; b: AggregateRow | null }>();
  for (const r of aggregate?.rows ?? []) {
    const bucket = perCriterion.get(r.criterionName) ?? { a: null, b: null };
    if (r.agentVersionId === versionA) bucket.a = r;
    else if (r.agentVersionId === versionB) bucket.b = r;
    perCriterion.set(r.criterionName, bucket);
  }

  const totalA = (aggregate?.rows ?? [])
    .filter((r) => r.agentVersionId === versionA)
    .reduce(
      (acc, r) => ({
        passes: acc.passes + Math.round(r.passRate * r.sampleCount),
        total: acc.total + r.sampleCount,
      }),
      { passes: 0, total: 0 },
    );
  const totalB = (aggregate?.rows ?? [])
    .filter((r) => r.agentVersionId === versionB)
    .reduce(
      (acc, r) => ({
        passes: acc.passes + Math.round(r.passRate * r.sampleCount),
        total: acc.total + r.sampleCount,
      }),
      { passes: 0, total: 0 },
    );
  const sig = significance(totalA, totalB);

  return (
    <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text-dimmed">
            Version A
            <select
              value={versionA ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                if (e.target.value) next.set("versionA", e.target.value);
                else next.delete("versionA");
                setSearchParams(next, { replace: true });
              }}
              className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-sm text-text-bright"
            >
              <option value="">— pick —</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-text-dimmed">
            Version B
            <select
              value={versionB ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                if (e.target.value) next.set("versionB", e.target.value);
                else next.delete("versionB");
                setSearchParams(next, { replace: true });
              }}
              className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-sm text-text-bright"
            >
              <option value="">— pick —</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber}
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
              <option value={7}>Last 7d</option>
              <option value={30}>Last 30d</option>
              <option value={90}>Last 90d</option>
            </select>
          </label>
        </div>

        {(!versionA || !versionB) && (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/40 px-4 py-10 text-center text-sm text-text-dimmed">
            Pick two versions above to compare their eval scores side-by-side.
          </div>
        )}

        {versionA && versionB && (
          <>
            <section className="mb-6">
              <Header3>Overall pass-rate significance</Header3>
              <Paragraph variant="small" className="mt-1 text-text-dimmed">
                Pooled across every criterion sampled in the last {days} day{days === 1 ? "" : "s"}.
              </Paragraph>
              <div className="mt-2 rounded-lg border border-charcoal-700 bg-charcoal-900/40 px-4 py-3 text-sm">
                {sig === null ? (
                  <span className="text-text-dimmed">
                    Insufficient samples — run more evals before drawing conclusions.
                  </span>
                ) : sig.winner === "tie" ? (
                  <span className="text-text-bright">Tied — no meaningful difference detected.</span>
                ) : (
                  <span className="text-text-bright">
                    Version <b>{sig.winner}</b> is winning with{" "}
                    <span className="font-mono text-emerald-400">{sig.confidencePct}%</span> confidence.
                  </span>
                )}
                <div className="mt-1 font-mono text-xs text-text-dimmed">
                  A: {totalA.passes}/{totalA.total} passes · B: {totalB.passes}/{totalB.total} passes
                </div>
              </div>
            </section>

            <section>
              <Header3>Per-criterion comparison</Header3>
              {perCriterion.size === 0 ? (
                <div className="mt-2 rounded-md border border-charcoal-700 bg-charcoal-900/40 px-3 py-4 text-sm text-text-dimmed">
                  No eval data for the selected versions yet.
                </div>
              ) : (
                <div className="mt-2 overflow-hidden rounded-lg border border-charcoal-700">
                  <table className="w-full text-sm">
                    <thead className="bg-charcoal-800">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Criterion</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">A score</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">B score</th>
                        <th className="px-3 py-2 text-left text-xs uppercase text-text-dimmed">Δ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-charcoal-700/60">
                      {Array.from(perCriterion.entries()).map(([name, { a, b }]) => {
                        const aScore = a?.meanScore ?? null;
                        const bScore = b?.meanScore ?? null;
                        const delta =
                          aScore != null && bScore != null ? bScore - aScore : null;
                        const deltaColor =
                          delta == null
                            ? "text-text-dimmed"
                            : delta > 2
                              ? "text-emerald-400"
                              : delta < -2
                                ? "text-red-400"
                                : "text-text-dimmed";
                        return (
                          <tr key={name} className="bg-charcoal-900/60">
                            <td className="px-3 py-2 text-text-bright">{name}</td>
                            <td className="px-3 py-2 font-mono text-text-bright">
                              {aScore == null ? "—" : aScore.toFixed(1)}
                              {a && (
                                <span className="ml-2 text-xs text-text-dimmed">
                                  (n={a.sampleCount})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-text-bright">
                              {bScore == null ? "—" : bScore.toFixed(1)}
                              {b && (
                                <span className="ml-2 text-xs text-text-dimmed">
                                  (n={b.sampleCount})
                                </span>
                              )}
                            </td>
                            <td className={`px-3 py-2 font-mono ${deltaColor}`}>
                              {delta == null ? "—" : (delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
    </PageBody>
  );
}
