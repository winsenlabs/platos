import {
  ArrowUturnLeftIcon,
  ChartBarIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentPath as agentDetailPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Canary Metrics | Platos" }];

interface CanaryMetricsRow {
  versionId: string | null;
  versionNumber: number | null;
  isCurrent: boolean;
  isCanary: boolean;
  messageCount: number;
  totalCostCents: number;
  avgLatencyMs: number | null;
  errorCount: number;
  errorRate: number;
}

interface CanaryMetricsPayload {
  hours: number;
  currentVersionId: string | null;
  canaryVersionId: string | null;
  canaryPercent: number;
  perVersion: CanaryMetricsRow[];
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

  // Parse ?hours query param; defaults to 24 on the server if absent.
  const url = new URL(request.url);
  const hoursParam = url.searchParams.get("hours") || "24";
  const hours = Math.max(1, Math.min(720, parseInt(hoursParam, 10) || 24));

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  let metrics: CanaryMetricsPayload | null = null;
  let agentName = agentId;
  try {
    const [metricsRes, agentRes] = await Promise.all([
      fetch(
        `${AGENT_API_URL}/api/v1/agent/agents/${agentId}/canary/metrics?hours=${hours}`,
        { headers: scopeHeaders(scope), signal: AbortSignal.timeout(5000) },
      ),
      fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (metricsRes.ok) {
      metrics = (await metricsRes.json()) as CanaryMetricsPayload;
    }
    if (agentRes.ok) {
      const agent = (await agentRes.json()) as { name?: string };
      agentName = agent.name || agentId;
    }
  } catch {
    // fall through — empty state
  }

  const backPath = agentDetailPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { id: envParam },
    agentId,
  );

  return typedjson({ agentId, agentName, metrics, hours, backPath });
}

function formatCents(cents: number): string {
  // responseJson.cost_cents is already in cents (can be fractional). Render
  // as dollars for readability; keep 4 decimals so tiny per-message costs
  // don't round to $0.00.
  const dollars = cents / 100;
  return `$${dollars.toFixed(4)}`;
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export default function AgentCanaryMetricsPage() {
  const { agentId, agentName, metrics, hours, backPath } =
    useTypedLoaderData<typeof loader>();

  const perVersion = metrics?.perVersion ?? [];
  const canaryPercent = metrics?.canaryPercent ?? 0;

  return (
    <PageBody>
        <section className="mb-6">
          <Header3>
            Canary routing — last {hours}h
          </Header3>
          <Paragraph variant="small" className="mt-1">
            Traffic split:{" "}
            <span className="font-mono text-emerald-400">
              {canaryPercent}%
            </span>{" "}
            to canary,{" "}
            <span className="font-mono text-sky-400">
              {100 - canaryPercent}%
            </span>{" "}
            to current. Metrics pivot on{" "}
            <code className="font-mono text-xs">
              PlatosAgentMessage.responseJson.version_id
            </code>
            , which the runtime stamps on every turn. Try{" "}
            <a
              href={`?hours=1`}
              className="text-sky-400 hover:underline"
            >
              1h
            </a>
            {" · "}
            <a
              href={`?hours=24`}
              className="text-sky-400 hover:underline"
            >
              24h
            </a>
            {" · "}
            <a
              href={`?hours=168`}
              className="text-sky-400 hover:underline"
            >
              7d
            </a>
            .
          </Paragraph>
        </section>

        {perVersion.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/40 px-4 py-10 text-center text-sm text-text-dimmed">
            No messages yet in this window. Configure a canary split and send
            some traffic through the agent — then come back.
          </div>
        ) : (
          <div className="rounded-lg border border-charcoal-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-charcoal-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                    Version
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                    Messages
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                    Cost
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                    Avg latency
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                    Errors
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                    Error rate
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-700/60">
                {perVersion.map((row) => {
                  const label =
                    row.versionNumber != null
                      ? `v${row.versionNumber}`
                      : row.versionId
                        ? row.versionId.slice(0, 8)
                        : "(unversioned)";
                  const rowColor = row.isCanary
                    ? "bg-emerald-500/5"
                    : row.isCurrent
                      ? "bg-sky-500/5"
                      : "bg-charcoal-900/60";
                  return (
                    <tr key={row.versionId ?? "none"} className={`${rowColor} align-top`}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-text-bright">
                            {label}
                          </span>
                          {row.isCurrent && (
                            <Badge variant="small">current</Badge>
                          )}
                          {row.isCanary && (
                            <Badge variant="small">canary</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-text-bright">
                        {row.messageCount}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-bright">
                        {formatCents(row.totalCostCents)}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-bright">
                        {row.avgLatencyMs == null
                          ? "—"
                          : `${row.avgLatencyMs}ms`}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-bright">
                        {row.errorCount}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-bright">
                        {formatPct(row.errorRate)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Paragraph variant="small" className="mt-4 text-text-dimmed">
          Note: average latency is populated once E.2 observability lands a
          per-turn <code className="font-mono text-xs">latency_ms</code> on
          responseJson. Error rate uses a coarse heuristic (empty assistant
          content) and will sharpen with the E.2 error taxonomy.
        </Paragraph>
    </PageBody>
  );
}
