import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Form, Link, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { DocsLink } from "~/components/primitives/DocsLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { agentClusterPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
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
  const { scope, AGENT_API_URL, headers } = await getScopeAndApi(request, params);
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (!(await isAgentServiceAvailable())) return typedjson({ clusters: [], error: null });
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/clusters`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return typedjson({ clusters: [], error: null });
    const data = await res.json() as { clusters?: any[] };
    return typedjson({ clusters: data.clusters ?? [], error: null });
  } catch {
    return typedjson({ clusters: [], error: null });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { AGENT_API_URL, headers } = await getScopeAndApi(request, params);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (!(await isAgentServiceAvailable())) return typedjson({ error: "Agent service unavailable" });

    if (intent === "create") {
      const name = (formData.get("name") as string).trim();
      const slug = (formData.get("slug") as string).trim();
      const description = (formData.get("description") as string | null)?.trim() || undefined;
      if (!name || !slug) return typedjson({ error: "Name and slug are required" });

      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/clusters`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, slug, description }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as { cluster?: any; error?: string };
      if (!res.ok) return typedjson({ error: data.error || "Create failed" });
      return typedjson({ error: null });
    }
  } catch (e: any) {
    return typedjson({ error: e?.message || "Request failed" });
  }

  return typedjson({ error: "Unknown action" });
}

export default function AgentClustersIndex() {
  const { clusters } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const [showCreate, setShowCreate] = useState(false);
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-bright">Agent Clusters</h1>
          <p className="text-sm text-text-dimmed mt-1">
            Group agents to share user memory and thread history across Chat and BGO agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DocsLink slug="agent-clusters" />
          <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          {showCreate ? "Cancel" : "+ New cluster"}
        </button>
        </div>
      </div>

      {/* Create cluster form */}
      {showCreate && (
        <Form method="post" className="mb-6 rounded-lg border border-charcoal-700 bg-charcoal-800/40 p-4 space-y-3">
          <input type="hidden" name="intent" value="create" />
          <h2 className="text-sm font-medium text-text-bright">Create cluster</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-dimmed mb-1">Name</label>
              <input
                name="name"
                required
                placeholder="Wally Cluster"
                className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2.5 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs text-text-dimmed mb-1">Slug (unique per env)</label>
              <input
                name="slug"
                required
                placeholder="wally-cluster"
                pattern="[a-z0-9-]+"
                className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2.5 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-dimmed mb-1">Description (optional)</label>
            <input
              name="description"
              placeholder="Wally Chat + Wally BGO sharing memory"
              className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2.5 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {isSubmitting ? "Creating…" : "Create cluster"}
          </button>
        </Form>
      )}

      {clusters.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-charcoal-700 bg-charcoal-800/30 py-16 text-center">
          <p className="text-text-dimmed text-sm">No clusters yet.</p>
          <p className="text-text-dimmed text-xs mt-1">
            Create a cluster above, then assign agents to it from their Settings tab.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {clusters.map((cluster: any) => (
            <Link
              key={cluster.id}
              to={agentClusterPath(organization, project, environment, cluster.id)}
              className="block rounded-lg border border-charcoal-700 bg-charcoal-800/30 px-4 py-3 hover:bg-charcoal-800/60 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-text-bright">{cluster.name}</span>
                  <span className="ml-2 text-xs font-mono text-text-dimmed">{cluster.slug}</span>
                </div>
                <span className="text-xs text-text-dimmed">
                  {cluster.agents?.length ?? 0} agent{(cluster.agents?.length ?? 0) !== 1 ? "s" : ""}
                </span>
              </div>
              {cluster.description && (
                <p className="text-xs text-text-dimmed mt-1">{cluster.description}</p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
