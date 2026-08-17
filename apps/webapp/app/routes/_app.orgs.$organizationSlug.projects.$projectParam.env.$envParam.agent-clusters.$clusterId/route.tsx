import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Form, Link, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { DocsLink } from "~/components/primitives/DocsLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { agentPath, agentClustersPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";

async function getScopeAndApi(request: Request, params: Record<string, string | undefined>) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope = { organizationId: project.organizationId, projectId: project.id, environmentId: environment.id, userId };
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
  return { scope, AGENT_API_URL, headers };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { AGENT_API_URL, headers } = await getScopeAndApi(request, params);
  const clusterId = params.clusterId!;

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (!(await isAgentServiceAvailable())) return typedjson({ cluster: null, allAgents: [] });

    const [clusterRes, agentsRes] = await Promise.all([
      fetch(`${AGENT_API_URL}/api/v1/agent/clusters/${clusterId}`, { headers, signal: AbortSignal.timeout(3000) }),
      fetch(`${AGENT_API_URL}/api/v1/agent/agents`, { headers, signal: AbortSignal.timeout(3000) }),
    ]);

    const cluster = clusterRes.ok ? ((await clusterRes.json()) as { cluster?: any }).cluster ?? null : null;
    const allAgents = agentsRes.ok ? ((await agentsRes.json()) as { agents?: any[] }).agents ?? [] : [];

    return typedjson({ cluster, allAgents });
  } catch {
    return typedjson({ cluster: null, allAgents: [] });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { AGENT_API_URL, headers } = await getScopeAndApi(request, params);
  const clusterId = params.clusterId!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (!(await isAgentServiceAvailable())) return typedjson({ error: "Agent service unavailable" });

    if (intent === "remove_agent") {
      const agentId = formData.get("agentId") as string;
      await fetch(`${AGENT_API_URL}/api/v1/agent/clusters/${clusterId}/agents/${agentId}`, {
        method: "DELETE", headers, signal: AbortSignal.timeout(5000),
      });
      return typedjson({ error: null });
    }

    if (intent === "add_agent") {
      const agentId = formData.get("agentId") as string;
      const role = (formData.get("role") as string | null)?.trim() || undefined;
      await fetch(`${AGENT_API_URL}/api/v1/agent/clusters/${clusterId}/agents`, {
        method: "POST", headers, body: JSON.stringify({ agentId, role }), signal: AbortSignal.timeout(5000),
      });
      return typedjson({ error: null });
    }

    if (intent === "set_primary") {
      const agentId = formData.get("agentId") as string;
      await fetch(`${AGENT_API_URL}/api/v1/agent/clusters/${clusterId}`, {
        method: "PATCH", headers, body: JSON.stringify({ primaryAgentId: agentId }), signal: AbortSignal.timeout(5000),
      });
      return typedjson({ error: null });
    }

    if (intent === "delete") {
      await fetch(`${AGENT_API_URL}/api/v1/agent/clusters/${clusterId}`, {
        method: "DELETE", headers, signal: AbortSignal.timeout(5000),
      });
      // Redirect back to clusters list after delete
      const { redirect } = await import("@remix-run/server-runtime");
      const { v3EnvironmentPath } = await import("~/utils/pathBuilder");
      // We can't use hooks here — return a redirect response
      return redirect("../");
    }
  } catch (e: any) {
    return typedjson({ error: e?.message || "Request failed" });
  }

  return typedjson({ error: "Unknown action" });
}

export default function AgentClusterDetail() {
  const { cluster, allAgents } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isSubmitting = navigation.state === "submitting";

  if (!cluster) {
    return (
      <div className="p-6">
        <p className="text-text-dimmed">Cluster not found.</p>
        <Link to={agentClustersPath(organization, project, environment)} className="text-xs text-emerald-400 hover:underline mt-2 inline-block">
          ← Back to clusters
        </Link>
      </div>
    );
  }

  const meta = (cluster.metadata ?? {}) as Record<string, any>;
  const primaryAgentId = meta.primaryAgentId as string | undefined;
  const roles = (meta.roles ?? {}) as Record<string, string>;
  const memberIds = new Set((cluster.agents ?? []).map((a: any) => a.id));
  const nonMembers = allAgents.filter((a: any) => !memberIds.has(a.id));

  return (
    <div className="p-6 max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link to={agentClustersPath(organization, project, environment)} className="text-xs text-text-dimmed hover:text-text-bright">
            ← Clusters
          </Link>
          <h1 className="text-2xl font-semibold text-text-bright mt-2">{cluster.name}</h1>
          <p className="text-sm font-mono text-text-dimmed">{cluster.slug}</p>
          {cluster.description && <p className="text-sm text-text-dimmed mt-1">{cluster.description}</p>}
        </div>
        <div className="flex items-center gap-3">
          <DocsLink slug="agent-clusters" />
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-rose-400 hover:text-rose-300"
            >
              Delete cluster
            </button>
          ) : (
            <Form method="post" className="flex items-center gap-2">
              <input type="hidden" name="intent" value="delete" />
              <span className="text-xs text-rose-300">Are you sure?</span>
              <button type="submit" className="text-xs text-rose-400 hover:text-rose-300 font-medium" disabled={isSubmitting}>
                Yes, delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-xs text-text-dimmed hover:text-text-bright">
                Cancel
              </button>
            </Form>
          )}
        </div>
      </div>

      {/* Members */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-medium text-text-bright">
            Members ({cluster.agents?.length ?? 0})
          </h2>
          {nonMembers.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAddAgent((v) => !v)}
              className="text-xs text-emerald-400 hover:text-emerald-300"
            >
              {showAddAgent ? "Cancel" : "+ Add agent"}
            </button>
          )}
        </div>

        {/* Add agent form */}
        {showAddAgent && (
          <Form method="post" className="mb-3 rounded-lg border border-charcoal-700 bg-charcoal-800/40 p-3 space-y-2">
            <input type="hidden" name="intent" value="add_agent" />
            <div className="flex gap-2">
              <select
                name="agentId"
                required
                className="flex-1 rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="">Select agent…</option>
                {nonMembers.map((a: any) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <input
                name="role"
                placeholder="Role (e.g. chat, bgo)"
                className="w-36 rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </Form>
        )}

        {(cluster.agents?.length ?? 0) === 0 ? (
          <p className="text-sm text-text-dimmed">No agents yet. Click "+ Add agent" above.</p>
        ) : (
          <div className="space-y-2">
            {(cluster.agents ?? []).map((agent: any) => (
              <div
                key={agent.id}
                className="flex items-center justify-between rounded-lg border border-charcoal-700 bg-charcoal-800/30 px-4 py-2.5"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-text-bright text-sm">{agent.name}</span>
                  {agent.id === primaryAgentId && (
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">Primary</span>
                  )}
                  {roles[agent.id] && (
                    <span className="rounded bg-charcoal-700 px-1.5 py-0.5 text-[10px] text-text-dimmed capitalize">{roles[agent.id]}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {agent.id !== primaryAgentId && (
                    <Form method="post" className="inline">
                      <input type="hidden" name="intent" value="set_primary" />
                      <input type="hidden" name="agentId" value={agent.id} />
                      <button type="submit" className="text-xs text-text-dimmed hover:text-emerald-400" disabled={isSubmitting}>
                        Set primary
                      </button>
                    </Form>
                  )}
                  <Link to={agentPath(organization, project, environment, agent.id)} className="text-xs text-text-dimmed hover:text-text-bright">
                    Settings →
                  </Link>
                  <Form method="post" className="inline">
                    <input type="hidden" name="intent" value="remove_agent" />
                    <input type="hidden" name="agentId" value={agent.id} />
                    <button type="submit" className="text-xs text-rose-400 hover:text-rose-300" disabled={isSubmitting}>
                      Remove
                    </button>
                  </Form>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Shared context summary */}
      <section>
        <h2 className="text-base font-medium text-text-bright mb-2">Shared context</h2>
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-800/30 px-4 py-3 text-sm text-text-dimmed space-y-1">
          <p>✓ User memory (facts, preferences, events) shared across all agents</p>
          <p>✓ Thread history visible to all cluster members</p>
          <p>✓ Message attribution via <code className="text-xs font-mono">authorAgentId</code></p>
          <p className="text-text-dimmed/60 text-xs mt-2">Each agent retains its own model, system prompt, tools, and version lock.</p>
        </div>
      </section>
    </div>
  );
}
