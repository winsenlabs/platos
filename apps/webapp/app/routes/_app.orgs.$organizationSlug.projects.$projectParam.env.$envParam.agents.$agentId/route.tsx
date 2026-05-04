/**
 * PIFSP-6 — Agent detail persistent layout.
 *
 * Parent layout route for all agent sub-tabs. Renders the persistent
 * agent header (name + meta) and the 9-tab strip, then delegates
 * content to the matched child route via <Outlet />.
 *
 * Tab order (locked per PIFSP-6 spec):
 *   Basic configuration → Context → Skills → Tools → Evals →
 *   Traces → Versions → Conversations → Chat
 *
 * Child routes render only their <PageBody> content — the NavBar is
 * provided here. The layout is:
 *   ┌────────────────────────────────────────────────┐
 *   │ [← Agents]  AgentName  v3  ⬤ live  Canary 20% │ ← flex header
 *   │ [Basic][Context][Skills][Tools][Evals][…]       │ ← tab strip
 *   ├────────────────────────────────────────────────┤
 *   │  <Outlet /> — child provides scrollable body   │ ← flex-1 overflow
 *   └────────────────────────────────────────────────┘
 */

import { CpuChipIcon } from "@heroicons/react/20/solid";
import { Link, NavLink, Outlet, useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DocsLink } from "~/components/primitives/DocsLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentCanaryPath,
  agentChatPath,
  agentConversationsPath,
  agentEvalsABPath,
  agentPath,
  agentPostmanTemplatesPath,
  agentSkillsPath,
  agentToolMappingsPath,
  agentVersionsPath,
  agentsPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

const ParamSchema = EnvironmentParamSchema.extend({ agentId: z.string() });

// ─── Loader — lightweight agent meta for the persistent header ─────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);

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
  const headers = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  let agentMeta: { id: string; name: string; version?: number; canaryPercent?: number } = {
    id: agentId,
    name: agentId,
  };

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { name?: string; version?: number; canaryPercent?: number };
        agentMeta = {
          id: agentId,
          name: data.name ?? agentId,
          version: data.version,
          canaryPercent: data.canaryPercent,
        };
      }
    }
  } catch {
    // Agent service down — render with id as fallback name
  }

  return typedjson({
    agentMeta,
    org: { slug: organizationSlug },
    project: { slug: projectParam },
    environment: { slug: envParam },
  });
}

// ─── Layout ────────────────────────────────────────────────────────────────

const TAB_ACTIVE = "border-b-2 border-emerald-400 text-emerald-400 font-medium";
const TAB_INACTIVE = "border-b-2 border-transparent text-text-dimmed hover:text-text-bright hover:border-charcoal-500";
const TAB_BASE = "whitespace-nowrap px-3 py-2 text-sm transition-colors";

export default function AgentDetailLayout() {
  const { agentMeta, org, project, environment } = useTypedLoaderData<typeof loader>();
  const params = useParams();
  const agentId = params.agentId!;

  const envPath = (suffix: string) =>
    `${agentPath(org, project, environment, agentId)}${suffix ? `/${suffix}` : ""}`;

  const tabs: { label: string; to: string; end?: boolean }[] = [
    // Basic config = _index, served at the agent root URL
    { label: "Basic config", to: agentPath(org, project, environment, agentId), end: true },
    { label: "Context", to: `${agentPath(org, project, environment, agentId)}/context` },
    { label: "Skills", to: agentSkillsPath(org, project, environment, { id: agentId }) },
    { label: "Tools", to: agentToolMappingsPath(org, project, environment, { id: agentId }) },
    { label: "Evals", to: agentEvalsABPath(org, project, environment, agentId) },
    { label: "Versions", to: agentVersionsPath(org, project, environment, agentId) },
    { label: "Conversations", to: agentConversationsPath(org, project, environment, agentId) },
    { label: "Chat", to: agentChatPath(org, project, environment, agentId) },
    { label: "Postman Templates", to: agentPostmanTemplatesPath(org, project, environment, agentId) },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Persistent header */}
      <div className="flex-none border-b border-charcoal-700 bg-background-bright">
        {/* Top row: breadcrumb + agent name + meta */}
        <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
          <Link
            to={agentsPath(org, project, environment)}
            className="text-xs text-text-dimmed hover:text-text-bright"
          >
            ← Agents
          </Link>
          <span className="text-text-dimmed text-xs">/</span>
          <div className="flex items-center gap-2">
            <CpuChipIcon className="size-4 text-emerald-500 flex-shrink-0" />
            <span className="text-sm font-semibold text-text-bright">{agentMeta.name}</span>
          </div>
          {agentMeta.version !== undefined && (
            <span className="text-xs text-text-dimmed ml-1">v{agentMeta.version}</span>
          )}
          {agentMeta.canaryPercent !== undefined && agentMeta.canaryPercent > 0 && (
            <span className="ml-1 rounded-full bg-amber-500/20 border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-300">
              Canary {agentMeta.canaryPercent}%
            </span>
          )}
          <div className="ml-auto">
            <DocsLink slug="agents" />
          </div>
        </div>

        {/* Tab strip */}
        <nav className="flex items-end gap-0 px-4 overflow-x-auto">
          {tabs.map(({ label, to, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `${TAB_BASE} ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Child route content — overflow-y-auto so every nested tab can scroll */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
