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
import { Callout } from "~/components/primitives/Callout";
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
  let entitiesAvailable = true;
  let liveStatusAvailable = false;

  try {
    const rows = await prisma.entity.findMany({
      where: { projectId: scope.projectId },
      orderBy: { createdAt: "desc" },
      select: {
        externalId: true,
        displayName: true,
        connectionStatus: true,
        connectionKind: true,
        lastConnectedAt: true,
        createdAt: true,
        mcpClient: { select: { discoveryError: true } },
        environmentTools: {
          where: { environmentId: scope.environmentId },
          select: { id: true },
        },
      },
    });
    entities = rows.map((entity) => ({
      entityId: entity.externalId,
      displayName: entity.displayName,
      connectionStatus: entity.connectionStatus || "disconnected",
      toolCount: entity.environmentTools.length,
      lastConnectedAt: entity.lastConnectedAt?.toISOString() ?? null,
      createdAt: entity.createdAt.toISOString(),
      connectionKind: entity.connectionKind === "mcp" ? "mcp" : "wire",
      discoveryError: entity.mcpClient?.discoveryError ?? null,
    }));
  } catch {
    entitiesAvailable = false;
  }

  if (entitiesAvailable) {
    try {
      const { listEntities } = await import("~/services/platosAgent.server");
      const result = await listEntities(scope);
      const liveByExternalId = new Map(
        (result.entities ?? []).map((entity) => [String(entity.entityId), entity])
      );
      entities = entities.map((entity) => {
        const live = liveByExternalId.get(entity.entityId);
        if (!live) return entity;
        const connectionKind = live.connectionKind === "mcp" ? "mcp" : entity.connectionKind;
        return {
          ...entity,
          connectionStatus:
            connectionKind === "wire" && live.liveConnected
              ? "connected"
              : live.connectionStatus || entity.connectionStatus,
          lastConnectedAt: live.lastConnectedAt ?? entity.lastConnectedAt,
          discoveryError: live.mcpClient?.discoveryError ?? entity.discoveryError,
        };
      });
      liveStatusAvailable = true;
    } catch {
      liveStatusAvailable = false;
    }
  }

  return typedjson({
    entities,
    entitiesAvailable,
    liveStatusAvailable,
    nowMs: Date.now(),
    organizationSlug,
    projectParam,
    envParam,
  });
}

// PIFSP-3 Deliverable 7 — flag orphan entities (never connected, older
// than the nudge window) so the operator can clean them up. Pure function
// lives at module scope for clarity + testability.
function isOrphanEntity(
  entity: { lastConnectedAt: string | null; createdAt: string | null },
  nowMs: number
): boolean {
  if (entity.lastConnectedAt) return false;
  if (!entity.createdAt) return false;
  const created = Date.parse(entity.createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > ORPHAN_NUDGE_AGE_MS;
}

export default function AgentEntitiesPage() {
  const {
    entities,
    entitiesAvailable,
    liveStatusAvailable,
    nowMs,
    organizationSlug,
    projectParam,
    envParam,
  } = useTypedLoaderData<typeof loader>();
  const org = { slug: organizationSlug };
  const project = { slug: projectParam };
  const environment = { id: envParam };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Connected Entities"
          icon={<BuildingOffice2Icon className="size-5 text-blue-500" />}
        />
        <PageAccessories>
          <DocsLink slug="connected-entities" />
          <LinkButton to="new" variant="primary/small" LeadingIcon={PlusIcon}>
            Connect Entity
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        {!entitiesAvailable ? (
          <Callout variant="warning">
            Connected entities are temporarily unavailable. Your selected scope is unchanged; try
            again when the database is reachable.
          </Callout>
        ) : entities.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <BuildingOffice2Icon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="max-w-md text-center">
              No entities connected yet. Register an entity to sync its tools and enable agent
              access to its backend.
            </Paragraph>
            <LinkButton to="new" variant="primary/medium" LeadingIcon={PlusIcon}>
              Connect Entity
            </LinkButton>
          </div>
        ) : (
          <>
            {!liveStatusAvailable && (
              <Callout variant="warning" className="mb-4">
                Live connection status is unavailable. Showing the latest persisted state for this
                project and environment.
              </Callout>
            )}
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
                        <span className="ml-2 text-xs text-text-dimmed">{entity.entityId}</span>
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
                          <Badge
                            variant={entity.connectionStatus === "connected" ? "success" : "error"}
                          >
                            <span
                              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                                entity.connectionStatus === "connected"
                                  ? "bg-green-500"
                                  : "bg-red-500"
                              }`}
                            />
                            {entity.connectionStatus}
                          </Badge>
                          {/* UNIT D — surface the last outbound-discovery failure
                            inline so a broken mcp entity is obvious. */}
                          {entity.connectionKind === "mcp" && entity.discoveryError && (
                            <Badge
                              variant="small"
                              className="border-red-500/40 bg-red-500/10 text-red-300"
                            >
                              <ExclamationTriangleIcon className="mr-1 size-3" />
                              discovery error
                            </Badge>
                          )}
                          {/* PIFSP-3 Deliverable 7 — orphan nudge. Amber badge
                            flags entities that never connected and are >7d
                            old. Clicking the row opens the detail page where
                            the operator can delete from the Danger Zone. */}
                          {orphan && (
                            <Badge
                              variant="small"
                              className="border-amber-500/40 bg-amber-500/10 text-amber-300"
                            >
                              <ExclamationTriangleIcon className="mr-1 size-3" />
                              Never connected — delete?
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell to={entity.entityId}>{entity.toolCount} tools</TableCell>
                      <TableCell to={entity.entityId}>
                        {entity.lastConnectedAt || "Never"}
                      </TableCell>
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
          </>
        )}
      </PageBody>
    </PageContainer>
  );
}
