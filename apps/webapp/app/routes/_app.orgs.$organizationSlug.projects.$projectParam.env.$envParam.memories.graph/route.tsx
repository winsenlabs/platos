/**
 * Theme O.10 — knowledge graph visualization.
 *
 * Shows up to 50 entities + 100 relationships for the current user. Uses
 * a lightweight SVG circular layout — each entity becomes a node
 * positioned on a circle, edges draw straight lines with type labels,
 * nodes are coloured by entityType. Clicking an entity filters to its
 * 1-hop neighbourhood.
 *
 * A full force-directed layout (cytoscape + cytoscape-cola) is the
 * natural next step — the deps aren't in package.json today, and a
 * circular layout scales fine to 50 nodes which matches the defaults.
 * When we decide to ship cytoscape, the entry point is this file.
 */
import { ShareIcon } from "@heroicons/react/20/solid";
import { Link, useSearchParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, memoriesPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Memory Graph | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

type Entity = {
  id: string;
  entityKey: string;
  entityType: string;
  label: string;
  aliases: string[];
};

type Edge = {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  weight: number | null;
};

type LoaderData = {
  entities: Entity[];
  edges: Edge[];
  listPath: string;
  focusedId: string | null;
  agentReachable: boolean;
};

function scopeHeaders(scope: Scope) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

async function agentFetch<T>(path: string, scope: Scope): Promise<T | null> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      headers: scopeHeaders(scope),
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
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  const url = new URL(request.url);
  const focusedId = url.searchParams.get("focus");

  const entitiesData = await agentFetch<{ entities: Entity[] }>(
    `/api/v1/memory/graph/entities?userId=${encodeURIComponent(userId)}&limit=50`,
    scope,
  );
  const entities = entitiesData?.entities ?? [];

  // Pull relationships per entity (limited to the first 100 edges total).
  const edges: Edge[] = [];
  for (const e of entities) {
    if (edges.length >= 100) break;
    const details = await agentFetch<{
      entity: Entity;
      outbound: Array<{ relationship: Edge; to: Entity }>;
    }>(`/api/v1/memory/graph/entities/${encodeURIComponent(e.id)}/relationships`, scope);
    if (!details?.outbound) continue;
    for (const out of details.outbound) {
      if (edges.length >= 100) break;
      edges.push({
        id: out.relationship.id,
        fromEntityId: out.relationship.fromEntityId,
        toEntityId: out.relationship.toEntityId,
        relationshipType: out.relationship.relationshipType,
        weight: out.relationship.weight,
      });
    }
  }

  const listPath = memoriesPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  );

  const payload: LoaderData = {
    entities,
    edges,
    listPath,
    focusedId,
    agentReachable: !!entitiesData,
  };
  return typedjson(payload);
}

const typeColors: Record<string, string> = {
  person: "#60a5fa", // sky-400
  org: "#34d399", // emerald-400
  project: "#fbbf24", // amber-400
  concept: "#c084fc", // violet-400
  location: "#f472b6", // pink-400
  other: "#94a3b8", // slate-400
};

function colorForType(t: string): string {
  return typeColors[t] ?? typeColors.other;
}

export default function MemoryGraphPage() {
  const { entities, edges, listPath, focusedId, agentReachable } =
    useTypedLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const { nodes, visibleEdges, focused } = useMemo(() => {
    if (!focusedId) return { nodes: entities, visibleEdges: edges, focused: null as Entity | null };
    const focusEnt = entities.find((e) => e.id === focusedId) ?? null;
    const neighbourIds = new Set<string>([focusedId]);
    for (const ed of edges) {
      if (ed.fromEntityId === focusedId) neighbourIds.add(ed.toEntityId);
      if (ed.toEntityId === focusedId) neighbourIds.add(ed.fromEntityId);
    }
    return {
      nodes: entities.filter((e) => neighbourIds.has(e.id)),
      visibleEdges: edges.filter(
        (ed) => neighbourIds.has(ed.fromEntityId) && neighbourIds.has(ed.toEntityId),
      ),
      focused: focusEnt,
    };
  }, [entities, edges, focusedId]);

  // Circular layout — nodes evenly distributed on a circle.
  const WIDTH = 900;
  const HEIGHT = 620;
  const CX = WIDTH / 2;
  const CY = HEIGHT / 2;
  const RADIUS = Math.min(CX, CY) - 60;
  const positions = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    const n = nodes.length || 1;
    nodes.forEach((node, i) => {
      // Put the focused entity (if any) at the center.
      if (focusedId && node.id === focusedId) {
        out.set(node.id, { x: CX, y: CY });
        return;
      }
      const offset = focusedId ? 0 : -Math.PI / 2; // top when not focused
      const total = focusedId ? n - 1 : n;
      const idx = focusedId ? (i < nodes.findIndex((x) => x.id === focusedId) ? i : i - 1) : i;
      const angle = offset + (2 * Math.PI * idx) / Math.max(total, 1);
      out.set(node.id, {
        x: CX + RADIUS * Math.cos(angle),
        y: CY + RADIUS * Math.sin(angle),
      });
    });
    return out;
  }, [nodes, focusedId, CX, CY, RADIUS]);

  function setFocus(id: string | null) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("focus", id);
    else next.delete("focus");
    setSearchParams(next);
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Memory Graph" icon={<ShareIcon className="size-5 text-emerald-400" />} />
        <PageAccessories>
          <DocsLink slug="memory-graph" />
          <LinkButton to={listPath} variant="tertiary/small">
            List view
          </LinkButton>
          {focused ? (
            <button
              type="button"
              onClick={() => setFocus(null)}
              className="rounded border border-grid-dimmed px-2 py-1 text-xs text-text-bright hover:border-emerald-500"
            >
              Clear focus
            </button>
          ) : null}
        </PageAccessories>
      </NavBar>
      <PageBody>
        {!agentReachable ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4 mb-4">
            <Paragraph>
              The agent service is unreachable. The graph will appear once it comes back online.
            </Paragraph>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-4 mb-4">
          {Object.entries(typeColors).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-xs text-text-dimmed">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ backgroundColor: v }}
              />
              {k}
            </div>
          ))}
        </div>

        <div className="overflow-auto rounded border border-grid-dimmed bg-background-dimmed">
          {nodes.length === 0 ? (
            <div className="p-8 text-center">
              <Paragraph variant="small" className="text-text-dimmed">
                No entities in the graph yet. Use the <Link to={listPath} className="underline">memories list</Link> to add some, or wait for the extractor to populate from conversations.
              </Paragraph>
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="mx-auto"
              style={{ maxWidth: "100%", height: "auto", background: "transparent" }}
            >
              {/* Edges first so nodes overlap them */}
              {visibleEdges.map((ed) => {
                const from = positions.get(ed.fromEntityId);
                const to = positions.get(ed.toEntityId);
                if (!from || !to) return null;
                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;
                return (
                  <g key={ed.id}>
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="#64748b"
                      strokeOpacity="0.5"
                      strokeWidth={1.2}
                    />
                    <text
                      x={midX}
                      y={midY}
                      fontSize="10"
                      fill="#94a3b8"
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {ed.relationshipType}
                    </text>
                  </g>
                );
              })}
              {nodes.map((n) => {
                const p = positions.get(n.id);
                if (!p) return null;
                const color = colorForType(n.entityType);
                const isFocused = focusedId === n.id;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    onClick={() => setFocus(isFocused ? null : n.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      r={isFocused ? 22 : 16}
                      fill={color}
                      fillOpacity={isFocused ? 0.85 : 0.6}
                      stroke={color}
                      strokeWidth={isFocused ? 3 : 1}
                    />
                    <text
                      y={32}
                      fontSize="11"
                      fill="#e2e8f0"
                      textAnchor="middle"
                    >
                      {n.label.length > 22 ? `${n.label.slice(0, 22)}…` : n.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {focused ? (
          <section className="mt-6">
            <Header3>Focus: {focused.label}</Header3>
            <Paragraph variant="small" className="text-text-dimmed">
              Type: {focused.entityType} · Key: <code className="font-mono text-xs">{focused.entityKey}</code>
              {focused.aliases.length > 0 ? ` · Aliases: ${focused.aliases.join(", ")}` : null}
            </Paragraph>
            <Paragraph variant="small" className="mt-2 text-text-dimmed">
              Showing 1-hop neighbours: {nodes.length - 1} entities, {visibleEdges.length} relationships.
            </Paragraph>
          </section>
        ) : (
          <Paragraph variant="small" className="mt-4 text-text-dimmed">
            Click a node to focus on its 1-hop neighbourhood. Showing the first 50 entities + 100
            edges in this scope.
          </Paragraph>
        )}
      </PageBody>
    </PageContainer>
  );
}
