import {
  ArrowUturnLeftIcon,
  ClockIcon,
  CpuChipIcon,
} from "@heroicons/react/20/solid";
import { Form, useActionData, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  agentPath as agentDetailPath,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Versions | Platos" }];

interface AgentVersionSnapshot {
  model: string;
  systemPrompt: string | null;
  promptBlocks: unknown[] | null;
  dynamicBlocks: unknown[] | null;
  maxSteps: number;
  contextLimit: number;
  historyMode: string;
  compactThreshold: number;
  enableUserProfiling: boolean;
  toolMode: string;
  toolsBlockConfig: Record<string, unknown> | null;
  subAgentConfig: Record<string, unknown> | null;
  memoryConfig: Record<string, unknown> | null;
  metaTools: Record<string, boolean> | null;
  featureFlags: Record<string, boolean> | null;
}

interface AgentVersion {
  id: string;
  versionNumber: number;
  createdBy: string;
  note: string | null;
  snapshot: AgentVersionSnapshot;
  createdAt: string;
  isCurrent?: boolean;
  isCanary?: boolean;
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
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  let versions: AgentVersion[] = [];
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
      const payload = (await versionsRes.json()) as { versions?: AgentVersion[] };
      versions = payload.versions ?? [];
    }
    if (agentRes.ok) {
      const agent = (await agentRes.json()) as { name?: string };
      agentName = agent.name || agentId;
    }
  } catch {
    // fall through — page renders with empty state
  }

  // Theme J.9 — overlay eval + satisfaction scores on the version timeline
  // so users can see the impact of each edit at a glance. Both endpoints
  // are best-effort; the page still renders without them.
  let evalByVersion: Record<string, { meanScore: number; sampleCount: number }> = {};
  let satisfactionByVersion: Record<string, { score: number; total: number }> = {};
  try {
    const [aggRes, satRes] = await Promise.all([
      fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}/evals/aggregate?days=30`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}/satisfaction?days=30`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (aggRes.ok) {
      const body = (await aggRes.json()) as {
        rows?: Array<{
          agentVersionId: string | null;
          meanScore: number;
          sampleCount: number;
        }>;
      };
      // Mean across criteria per version — rough "overall eval health" score.
      const tmp = new Map<string, { scoreSum: number; sampleSum: number; count: number }>();
      for (const r of body.rows ?? []) {
        if (!r.agentVersionId) continue;
        const b = tmp.get(r.agentVersionId) ?? { scoreSum: 0, sampleSum: 0, count: 0 };
        b.scoreSum += r.meanScore;
        b.sampleSum += r.sampleCount;
        b.count += 1;
        tmp.set(r.agentVersionId, b);
      }
      for (const [id, b] of tmp) {
        evalByVersion[id] = {
          meanScore: b.count === 0 ? 0 : b.scoreSum / b.count,
          sampleCount: b.sampleSum,
        };
      }
    }
    if (satRes.ok) {
      const body = (await satRes.json()) as {
        rows?: Array<{ agentVersionId: string | null; score: number; total: number }>;
      };
      for (const r of body.rows ?? []) {
        if (!r.agentVersionId) continue;
        satisfactionByVersion[r.agentVersionId] = { score: r.score, total: r.total };
      }
    }
  } catch {
    // best effort — render without overlay
  }

  const backPath = agentDetailPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
    agentId,
  );

  return typedjson({
    agentId,
    agentName,
    versions,
    backPath,
    evalByVersion,
    satisfactionByVersion,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const agentId = params.agentId!;
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const versionId = formData.get("versionId") as string;

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

  if (intent === "rollback" && versionId) {
    try {
      // Theme G invariant (CLAUDE.md §8): rollback must not downgrade the
      // model to one whose provider isn't enabled + envReady in the target
      // environment. Pre-fetch the target version snapshot and the scoped
      // provider list; if the target model's provider is missing, bounce
      // with a clear error so the user links the env var first.
      const force = formData.get("force") === "true";
      if (!force) {
        try {
          const [versionRes, providersRes] = await Promise.all([
            fetch(
              `${AGENT_API_URL}/api/v1/agent/agents/${agentId}/versions/${versionId}`,
              { headers: scopeHeaders(scope), signal: AbortSignal.timeout(5000) },
            ),
            fetch(`${AGENT_API_URL}/api/v1/agent/providers`, {
              headers: scopeHeaders(scope),
              signal: AbortSignal.timeout(5000),
            }),
          ]);
          if (versionRes.ok && providersRes.ok) {
            const version = (await versionRes.json()) as {
              snapshot?: { model?: string };
              versionNumber?: number;
            };
            const providersPayload = (await providersRes.json()) as {
              providers?: Array<{ id: string; enabled?: boolean; envReady?: boolean }>;
            };
            const targetModel = version.snapshot?.model || "";
            const providerId = targetModel.split(":")[0] || "";
            const provider = providersPayload.providers?.find(
              (p) => p.id === providerId,
            );
            const envReady = !!provider?.envReady;
            const enabled = !!provider?.enabled;
            if (providerId && (!provider || !envReady || !enabled)) {
              return typedjson(
                {
                  error: `Cannot roll back to v${version.versionNumber}: its model "${targetModel}" uses provider "${providerId}" which is not enabled + env-ready in this environment. Link the env var on the Providers page or re-submit with force=true to override.`,
                  requiresForce: true,
                  blockedVersionId: versionId,
                },
                { status: 409 },
              );
            }
          }
        } catch {
          // If the provider check itself fails, fall through to the rollback
          // attempt — the agent service can also refuse inside its update path.
        }
      }

      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/agents/${agentId}/versions/${versionId}/rollback`,
        {
          method: "POST",
          headers: scopeHeaders(scope),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) {
        const errorText = await res.text();
        return typedjson({ error: errorText || "Rollback failed" }, { status: res.status });
      }
      // Redirect back to the detail page to see the rolled-back config.
      return redirect(
        agentDetailPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam },
          agentId,
        ),
      );
    } catch (error: any) {
      return typedjson(
        { error: `Rollback failed: ${error?.message ?? "unknown"}` },
        { status: 500 },
      );
    }
  }

  if (intent === "set-canary") {
    const canaryVersionId = (formData.get("canaryVersionId") as string) || null;
    const canaryPercent = parseInt(
      (formData.get("canaryPercent") as string) || "0",
      10,
    );
    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/agents/${agentId}/canary`,
        {
          method: "PATCH",
          headers: scopeHeaders(scope),
          body: JSON.stringify({
            canaryVersionId,
            canaryPercent: isNaN(canaryPercent) ? 0 : canaryPercent,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) {
        const errorText = await res.text();
        return typedjson({ error: errorText || "Canary update failed" }, { status: res.status });
      }
      return typedjson({ success: true });
    } catch (error: any) {
      return typedjson(
        { error: `Canary update failed: ${error?.message ?? "unknown"}` },
        { status: 500 },
      );
    }
  }

  return typedjson({ error: "Unknown intent" }, { status: 400 });
}

/**
 * Compute a shallow diff between two snapshots. Keys that differ are
 * returned with `{ before, after }` values; equal keys are omitted.
 * Object-typed fields are JSON-stringified for equality comparison.
 */
function diffSnapshots(
  a: AgentVersionSnapshot | null,
  b: AgentVersionSnapshot,
): Array<{ key: string; before: unknown; after: unknown }> {
  if (!a) {
    return Object.entries(b).map(([key, after]) => ({ key, before: undefined, after }));
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows: Array<{ key: string; before: unknown; after: unknown }> = [];
  for (const key of keys) {
    const before = (a as any)[key];
    const after = (b as any)[key];
    const ba = typeof before === "object" ? JSON.stringify(before) : before;
    const bb = typeof after === "object" ? JSON.stringify(after) : after;
    if (ba !== bb) rows.push({ key, before, after });
  }
  rows.sort((x, y) => x.key.localeCompare(y.key));
  return rows;
}

function renderValue(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function AgentVersionsPage() {
  const { agentId, agentName, versions, backPath, evalByVersion, satisfactionByVersion } =
    useTypedLoaderData<typeof loader>();
  const actionData = useActionData<{
    error?: string;
    requiresForce?: boolean;
    blockedVersionId?: string;
    success?: boolean;
  }>();

  // Pick the default compare pair: newest vs second-newest. Falls back to the
  // single version if only one exists.
  const [leftVersionId, setLeftVersionId] = useState<string>(
    versions.length > 1 ? versions[1].id : versions[0]?.id || "",
  );
  const [rightVersionId, setRightVersionId] = useState<string>(
    versions[0]?.id || "",
  );

  const left = useMemo(
    () => versions.find((v) => v.id === leftVersionId) ?? null,
    [versions, leftVersionId],
  );
  const right = useMemo(
    () => versions.find((v) => v.id === rightVersionId) ?? null,
    [versions, rightVersionId],
  );

  const diff = useMemo(
    () => (right ? diffSnapshots(left?.snapshot ?? null, right.snapshot) : []),
    [left, right],
  );

  return (
    <PageBody>
        {actionData?.error && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-sm text-amber-300">{actionData.error}</p>
            {actionData.requiresForce && actionData.blockedVersionId && (
              <Form method="post" className="mt-2">
                <input type="hidden" name="intent" value="rollback" />
                <input type="hidden" name="versionId" value={actionData.blockedVersionId} />
                <input type="hidden" name="force" value="true" />
                <Button type="submit" variant="tertiary/small">
                  Force rollback anyway
                </Button>
              </Form>
            )}
          </div>
        )}
        <div className="grid grid-cols-12 gap-6">
          {/* Left column: version list */}
          <section className="col-span-4">
            <Header3>
              <span className="inline-flex items-center gap-2">
                <ClockIcon className="size-4 text-text-dimmed" />
                History ({versions.length})
              </span>
            </Header3>
            <Paragraph variant="small" className="mt-1 mb-3">
              Every save, rollback, and canary change creates an immutable snapshot.
              Select any two to diff, or roll back to any prior state.
            </Paragraph>
            <ul className="space-y-2">
              {versions.length === 0 && (
                <li className="text-sm text-text-dimmed italic">
                  No versions yet. Save the agent to create v1.
                </li>
              )}
              {versions.map((v) => {
                const isLeft = v.id === leftVersionId;
                const isRight = v.id === rightVersionId;
                const selectionColor = isRight
                  ? "border-emerald-500/60"
                  : isLeft
                    ? "border-sky-500/60"
                    : "border-charcoal-700";
                return (
                  <li
                    key={v.id}
                    className={`rounded-lg border ${selectionColor} bg-charcoal-900/40 p-3`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-bright">
                          v{v.versionNumber}
                        </span>
                        {v.isCurrent && (
                          <Badge variant="small">current</Badge>
                        )}
                        {v.isCanary && (
                          <Badge variant="small">canary</Badge>
                        )}
                      </div>
                      <span className="text-xs text-text-dimmed">
                        {new Date(v.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-dimmed line-clamp-2">
                      {v.note || <span className="italic">(no note)</span>}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-text-dimmed">
                      by {v.createdBy.slice(0, 12)}
                    </p>
                    {/* Theme J.9 — eval + satisfaction overlay. Shows mean
                        judge score (30d) and thumbs-up rate inline so the
                        user can correlate config edits with score shifts. */}
                    {(evalByVersion[v.id] || satisfactionByVersion[v.id]) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                        {evalByVersion[v.id] && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border border-charcoal-700 px-1.5 py-0.5 font-mono ${
                              evalByVersion[v.id].meanScore >= 80
                                ? "text-emerald-400"
                                : evalByVersion[v.id].meanScore >= 60
                                  ? "text-sky-400"
                                  : evalByVersion[v.id].meanScore >= 40
                                    ? "text-amber-400"
                                    : "text-red-400"
                            }`}
                            title="Mean judge-LLM score across criteria (last 30d)"
                          >
                            eval {evalByVersion[v.id].meanScore.toFixed(0)}
                            <span className="text-text-dimmed">
                              /{evalByVersion[v.id].sampleCount}
                            </span>
                          </span>
                        )}
                        {satisfactionByVersion[v.id] && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border border-charcoal-700 px-1.5 py-0.5 font-mono ${
                              satisfactionByVersion[v.id].score >= 0.7
                                ? "text-emerald-400"
                                : satisfactionByVersion[v.id].score >= 0.4
                                  ? "text-amber-400"
                                  : "text-red-400"
                            }`}
                            title="Thumbs-up share across all users (last 30d)"
                          >
                            👍 {(satisfactionByVersion[v.id].score * 100).toFixed(0)}%
                            <span className="text-text-dimmed">
                              /{satisfactionByVersion[v.id].total}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setRightVersionId(v.id)}
                        className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-[11px] text-text-bright hover:border-emerald-500/40"
                      >
                        Set RIGHT
                      </button>
                      <button
                        type="button"
                        onClick={() => setLeftVersionId(v.id)}
                        className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-[11px] text-text-bright hover:border-sky-500/40"
                      >
                        Set LEFT
                      </button>
                      {!v.isCurrent && (
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="rollback" />
                          <input type="hidden" name="versionId" value={v.id} />
                          <Button
                            type="submit"
                            variant="tertiary/small"
                            LeadingIcon={ArrowUturnLeftIcon}
                          >
                            Roll back
                          </Button>
                        </Form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Right column: diff view */}
          <section className="col-span-8">
            <Header3>Diff</Header3>
            <Paragraph variant="small" className="mt-1 mb-3">
              Comparing{" "}
              <span className="text-sky-400 font-mono">
                v{left?.versionNumber ?? "—"}
              </span>{" "}
              →{" "}
              <span className="text-emerald-400 font-mono">
                v{right?.versionNumber ?? "—"}
              </span>
              . Keys that match between the two are hidden.
            </Paragraph>

            {diff.length === 0 ? (
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/40 px-4 py-8 text-center text-sm text-text-dimmed">
                No field differences between these versions.
              </div>
            ) : (
              <div className="rounded-lg border border-charcoal-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-charcoal-800">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">
                        Field
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-sky-400 uppercase">
                        v{left?.versionNumber ?? "—"}
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-emerald-400 uppercase">
                        v{right?.versionNumber ?? "—"}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-charcoal-700/60">
                    {diff.map((d) => (
                      <tr key={d.key} className="bg-charcoal-900/60 align-top">
                        <td className="px-3 py-2 font-mono text-xs text-text-bright">
                          {d.key}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-sky-300 whitespace-pre-wrap break-all">
                          {renderValue(d.before)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-emerald-300 whitespace-pre-wrap break-all">
                          {renderValue(d.after)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
    </PageBody>
  );
}
