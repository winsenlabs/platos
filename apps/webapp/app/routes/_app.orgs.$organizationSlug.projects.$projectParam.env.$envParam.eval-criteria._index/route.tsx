import {
  BeakerIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher, type MetaFunction } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [
  { title: "Eval Criteria | Platos" },
];

interface CriterionRow {
  id: string;
  agentId: string | null;
  name: string;
  description: string | null;
  judgePrompt: string;
  rubric: string | null;
  judgeModel: string | null;
  scoreScaleMin: number;
  scoreScaleMax: number;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

type LoaderData = {
  criteria: CriterionRow[];
  agents: Array<{ id: string; name: string; model: string }>;
  agentReachable: boolean;
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

async function resolveScope(request: Request, params: Record<string, unknown>) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  return {
    scope: {
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      userId,
    },
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { scope } = await resolveScope(request, params);
  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  let criteria: CriterionRow[] = [];
  let agents: Array<{ id: string; name: string; model: string }> = [];
  let agentReachable = false;
  try {
    const [critRes, agentsRes] = await Promise.all([
      fetch(`${AGENT_API_URL}/api/v1/agent/eval-criteria`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${AGENT_API_URL}/api/v1/agent/agents`, {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (critRes.ok) {
      const body = (await critRes.json()) as { criteria?: CriterionRow[] };
      criteria = body.criteria ?? [];
      agentReachable = true;
    }
    if (agentsRes.ok) {
      const body = (await agentsRes.json()) as {
        agents?: Array<{ id: string; name: string; model: string }>;
      };
      agents = body.agents ?? [];
    }
  } catch {
    // empty state
  }
  return typedjson({ criteria, agents, agentReachable } satisfies LoaderData);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { scope } = await resolveScope(request, params);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

  try {
    if (intent === "create") {
      const payload = {
        agentId: String(formData.get("agentId") || "") || null,
        name: String(formData.get("name") || ""),
        description: String(formData.get("description") || "") || null,
        judgePrompt: String(formData.get("judgePrompt") || ""),
        rubric: String(formData.get("rubric") || "") || null,
        judgeModel: String(formData.get("judgeModel") || "") || null,
      };
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/eval-criteria`, {
        method: "POST",
        headers: scopeHeaders(scope),
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return json({ error: body.error || "Create failed" }, { status: res.status });
      return json({ ok: true });
    }

    if (intent === "delete") {
      const criterionId = String(formData.get("criterionId") || "");
      if (!criterionId) return json({ error: "criterionId required" }, { status: 400 });
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/eval-criteria/${criterionId}`,
        { method: "DELETE", headers: scopeHeaders(scope) },
      );
      if (!res.ok) return json({ error: `HTTP ${res.status}` }, { status: res.status });
      return json({ ok: true });
    }

    if (intent === "toggle") {
      const criterionId = String(formData.get("criterionId") || "");
      const nextActive = formData.get("isActive") === "true";
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/eval-criteria/${criterionId}`,
        {
          method: "PATCH",
          headers: scopeHeaders(scope),
          body: JSON.stringify({ isActive: nextActive }),
        },
      );
      if (!res.ok) return json({ error: `HTTP ${res.status}` }, { status: res.status });
      return json({ ok: true });
    }

    return json({ error: `Unknown intent "${intent}"` }, { status: 400 });
  } catch (err: any) {
    return json({ error: err?.message || "Action failed" }, { status: 500 });
  }
}

export default function EvalCriteriaPage() {
  const { criteria, agents, agentReachable } =
    useTypedLoaderData<typeof loader>();
  const [showForm, setShowForm] = useState(false);
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setShowForm(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Eval Criteria"
          icon={<BeakerIcon className="size-5 text-emerald-500" />}
        />
        <PageAccessories>
          <DocsLink slug="evals" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="mb-4 flex items-center justify-between">
          <Paragraph variant="small" className="text-text-dimmed">
            Rubrics the judge LLM uses to score agent conversations. Theme J.3.
          </Paragraph>
          <Button
            variant="primary/small"
            onClick={() => setShowForm((v) => !v)}
            LeadingIcon={PlusIcon}
          >
            {showForm ? "Cancel" : "New criterion"}
          </Button>
        </div>

        {!agentReachable && (
          <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400">
            Agent service unreachable. Start `pnpm run dev --filter agent` or
            check `PLATOS_AGENT_API_URL`.
          </div>
        )}

        {showForm && (
          <fetcher.Form method="post" className="mb-6 rounded-lg border border-charcoal-700 bg-charcoal-900/40 p-4">
            <input type="hidden" name="intent" value="create" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-text-dimmed">
                Name
                <input
                  name="name"
                  required
                  placeholder="e.g. Professional tone"
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-dimmed">
                Agent (optional)
                <select
                  name="agentId"
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-sm text-text-bright"
                >
                  <option value="">Shared (all agents)</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {a.model}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-dimmed md:col-span-2">
                Description
                <input
                  name="description"
                  placeholder="What this criterion measures"
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-sm text-text-bright"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-dimmed md:col-span-2">
                Judge prompt (use {"{conversation}"} placeholder)
                <textarea
                  name="judgePrompt"
                  required
                  rows={4}
                  defaultValue={
                    "Rate this conversation on professional tone.\n\n{conversation}"
                  }
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 font-mono text-xs text-text-bright"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-dimmed md:col-span-2">
                Rubric (optional)
                <textarea
                  name="rubric"
                  rows={3}
                  placeholder="0=unacceptable, 50=neutral, 100=excellent. Penalize hallucinations heavily."
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-sm text-text-bright"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-dimmed">
                Judge model (blank = Haiku default)
                <input
                  name="judgeModel"
                  placeholder="anthropic:claude-haiku-4-5-20251001"
                  className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 font-mono text-xs text-text-bright"
                />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary/small" type="submit" disabled={fetcher.state !== "idle"}>
                {fetcher.state !== "idle" ? "Saving…" : "Save criterion"}
              </Button>
              {fetcher.data?.error && (
                <span className="text-xs text-red-400">{fetcher.data.error}</span>
              )}
            </div>
          </fetcher.Form>
        )}

        {criteria.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/40 px-4 py-10 text-center text-sm text-text-dimmed">
            No eval criteria defined yet. Click "New criterion" to create one.
          </div>
        ) : (
          <div className="rounded-lg border border-charcoal-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-charcoal-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">Name</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">Scope</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">Judge model</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-text-dimmed uppercase">Status</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-text-dimmed uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-700/60">
                {criteria.map((c) => {
                  const agentName = c.agentId
                    ? agents.find((a) => a.id === c.agentId)?.name ?? c.agentId
                    : "All agents";
                  return (
                    <tr key={c.id} className="align-top bg-charcoal-900/60">
                      <td className="px-3 py-2">
                        <div className="font-medium text-text-bright">{c.name}</div>
                        {c.description && (
                          <div className="text-xs text-text-dimmed">{c.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-text-dimmed">{agentName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-text-dimmed">
                        {c.judgeModel ?? "default (Haiku)"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={c.isActive ? "success" : "small"}>
                          {c.isActive ? "active" : "disabled"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <fetcher.Form method="post" className="inline-flex items-center gap-1">
                          <input type="hidden" name="criterionId" value={c.id} />
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="isActive" value={c.isActive ? "false" : "true"} />
                          <button type="submit" className="rounded-md p-1 text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright" aria-label="Toggle active">
                            <PencilSquareIcon className="size-4" />
                          </button>
                        </fetcher.Form>
                        <fetcher.Form method="post" className="inline-flex items-center gap-1">
                          <input type="hidden" name="criterionId" value={c.id} />
                          <input type="hidden" name="intent" value="delete" />
                          <button type="submit" className="rounded-md p-1 text-red-400 hover:bg-red-900/30" aria-label="Delete">
                            <TrashIcon className="size-4" />
                          </button>
                        </fetcher.Form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}
