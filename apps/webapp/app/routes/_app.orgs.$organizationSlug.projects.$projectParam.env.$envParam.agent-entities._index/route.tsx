import {
  BuildingOffice2Icon,
  ExclamationTriangleIcon,
  PlusIcon,
  ServerStackIcon,
} from "@heroicons/react/20/solid";
import { Link, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
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
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { agentMcpEntityPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

// PIFSP-3 Deliverable 7 — orphan nudge threshold. An entity with
// `lastConnectedAt === null` AND `createdAt` older than this window gets
// an amber "Never connected — delete?" badge. 7 days is long enough that
// legitimate slow-rollout entities don't get flagged, short enough that
// dormant typos surface on the next visit.
const ORPHAN_NUDGE_AGE_DAYS = 7;
const ORPHAN_NUDGE_AGE_MS = ORPHAN_NUDGE_AGE_DAYS * 24 * 60 * 60 * 1000;

export const meta: MetaFunction = () => [{ title: "Connected Entities | Platos" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

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

  let entities: Array<{
    entityId: string;
    displayName: string;
    connectionStatus: string;
    toolCount: number;
    lastConnectedAt: string | null;
    // PIFSP-3 Deliverable 7 — `createdAt` is the OTHER half of the orphan
    // nudge rule. When the agent service isn't available we pull both from
    // Prisma so the badge still renders.
    createdAt: string | null;
    // UNIT D (MCP consumption) — transport discriminator + outbound-discovery
    // error surfaced on the list so operators can spot a broken mcp entity
    // without opening the detail page.
    connectionKind: "wire" | "mcp";
    discoveryError: string | null;
  }> = [];

  try {
    const { isAgentServiceAvailable, listEntities } = await import(
      "~/services/platosAgent.server"
    );
    if (await isAgentServiceAvailable()) {
      const result = await listEntities(scope);
      // Agent returns `{ entities: [...] }` post-PPR-69 rename.
      // Tolerate the legacy `orgs` key for one release so stale SDK
      // middleware doesn't break the list page.
      const rows = (result as any).entities ?? (result as any).orgs ?? [];
      entities = rows.map((o: any) => {
        const kind: "wire" | "mcp" = o.connectionKind === "mcp" ? "mcp" : "wire";
        // Wire status comes from the live WS connection; mcp status is stamped
        // by the outbound-discovery sweep (there is no WS), so fall back to the
        // persisted connectionStatus for mcp entities.
        const status =
          kind === "mcp"
            ? o.connectionStatus || "disconnected"
            : o.liveConnected
              ? "connected"
              : o.connectionStatus || "disconnected";
        return {
          entityId: o.entityId ?? o.orgId,
          displayName: o.displayName,
          connectionStatus: status,
          toolCount: 0, // filled in below via Prisma
          lastConnectedAt: o.lastConnectedAt,
          createdAt: o.createdAt ?? null,
          connectionKind: kind,
          discoveryError: o.mcpClient?.discoveryError ?? null,
        };
      });
    }
  } catch {
    // Agent service not running
  }

  // EOBD.78 — count the tool mappings per entity for this (org, project, env).
  // One grouped query, scope-filtered via PlatosConnectedEntity + the mapping's
  // environmentId. We key on the entity's human-readable slug to match the
  // shape returned by the agent service above.
  // PIFSP-3 Deliverable 7 — also pull `createdAt` + `lastConnectedAt` so the
  // orphan-nudge rule can render without a second round-trip.
  if (entities.length > 0) {
    try {
      const dbEntities = await prisma.platosConnectedEntity.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          entityId: { in: entities.map((e) => e.entityId) },
        },
        select: {
          entityId: true,
          createdAt: true,
          lastConnectedAt: true,
          toolMappings: {
            where: { environmentId: scope.environmentId },
            select: { id: true },
          },
        },
      });
      const metaBySlug = new Map<
        string,
        {
          count: number;
          createdAt: string | null;
          lastConnectedAt: string | null;
        }
      >();
      for (const e of dbEntities) {
        metaBySlug.set(e.entityId, {
          count: e.toolMappings.length,
          createdAt: e.createdAt ? e.createdAt.toISOString() : null,
          lastConnectedAt: e.lastConnectedAt
            ? e.lastConnectedAt.toISOString()
            : null,
        });
      }
      entities = entities.map((e) => {
        const meta = metaBySlug.get(e.entityId);
        return {
          ...e,
          toolCount: meta?.count ?? 0,
          // Agent payload is canonical for lastConnectedAt (reflects live
          // WS connections); only fall back to the DB value when absent.
          lastConnectedAt: e.lastConnectedAt ?? meta?.lastConnectedAt ?? null,
          createdAt: e.createdAt ?? meta?.createdAt ?? null,
        };
      });
    } catch {
      // DB temporarily unavailable — fall back to 0 counts rather than erroring.
    }
  }

  return typedjson({ entities, nowMs: Date.now(), organizationSlug, projectParam, envParam });
}

// PIFSP-3 Deliverable 7 — flag orphan entities (never connected, older
// than the nudge window) so the operator can clean them up. Pure function
// lives at module scope for clarity + testability.
function isOrphanEntity(
  entity: { lastConnectedAt: string | null; createdAt: string | null },
  nowMs: number,
): boolean {
  if (entity.lastConnectedAt) return false;
  if (!entity.createdAt) return false;
  const created = Date.parse(entity.createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > ORPHAN_NUDGE_AGE_MS;
}

export default function AgentEntitiesPage() {
  const { entities, nowMs, organizationSlug, projectParam, envParam } = useTypedLoaderData<typeof loader>();
  const org = { slug: organizationSlug };
  const project = { slug: projectParam };
  const environment = { id: envParam };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Connected Entities" icon={<BuildingOffice2Icon className="size-5 text-blue-500" />} />
        <PageAccessories>
          <DocsLink slug="connected-entities" />
          <LinkButton to="new" variant="primary/small" LeadingIcon={PlusIcon}>
            Connect Entity
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        {entities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <BuildingOffice2Icon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="text-center max-w-md">
              No entities connected yet. Register an entity to sync its
              tools and enable agent access to its backend.
            </Paragraph>
            <LinkButton to="new" variant="primary/medium" LeadingIcon={PlusIcon}>
              Connect Entity
            </LinkButton>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Entity</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Tools</TableHeaderCell>
                <TableHeaderCell>Last Connected</TableHeaderCell>
                <TableHeaderCell>MCP</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map((entity) => {
                const orphan = isOrphanEntity(entity, nowMs);
                return (
                  <TableRow key={entity.entityId}>
                    <TableCell to={entity.entityId}>
                      <span className="font-medium">{entity.displayName}</span>
                      <span className="text-text-dimmed ml-2 text-xs">{entity.entityId}</span>
                    </TableCell>
                    <TableCell to={entity.entityId}>
                      {/* UNIT D — transport discriminator. mcp = outbound MCP
                          client (Composio et al.); wire = inbound platools WS. */}
                      <Badge
                        variant="small"
                        className={
                          entity.connectionKind === "mcp"
                            ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                            : "border-charcoal-600 bg-charcoal-800 text-text-dimmed"
                        }
                      >
                        {entity.connectionKind === "mcp" ? "MCP client" : "Wire"}
                      </Badge>
                    </TableCell>
                    <TableCell to={entity.entityId}>
                      <div className="flex items-center gap-2">
                        <Badge variant={entity.connectionStatus === "connected" ? "success" : "error"}>
                          <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${
                            entity.connectionStatus === "connected" ? "bg-green-500" : "bg-red-500"
                          }`} />
                          {entity.connectionStatus}
                        </Badge>
                        {/* UNIT D — surface the last outbound-discovery failure
                            inline so a broken mcp entity is obvious. */}
                        {entity.connectionKind === "mcp" && entity.discoveryError && (
                          <Badge variant="small" className="border-red-500/40 bg-red-500/10 text-red-300">
                            <ExclamationTriangleIcon className="size-3 mr-1" />
                            discovery error
                          </Badge>
                        )}
                        {/* PIFSP-3 Deliverable 7 — orphan nudge. Amber badge
                            flags entities that never connected and are >7d
                            old. Clicking the row opens the detail page where
                            the operator can delete from the Danger Zone. */}
                        {orphan && (
                          <Badge variant="small" className="border-amber-500/40 bg-amber-500/10 text-amber-300">
                            <ExclamationTriangleIcon className="size-3 mr-1" />
                            Never connected — delete?
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell to={entity.entityId}>{entity.toolCount} tools</TableCell>
                    <TableCell to={entity.entityId}>{entity.lastConnectedAt || "Never"}</TableCell>
                    <TableCell>
                      <Link
                        to={agentMcpEntityPath(org, project, environment, entity.entityId)}
                        className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ServerStackIcon className="size-3" />
                        Configure MCP
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </PageContainer>
  );
}
