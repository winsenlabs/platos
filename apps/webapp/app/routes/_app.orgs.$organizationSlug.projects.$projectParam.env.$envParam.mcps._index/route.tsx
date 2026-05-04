/**
 * PIFSP-23 — MCPs list page.
 * Lists all connected entities with their MCP status.
 */
import { ShareIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import { Link, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
} from "~/components/primitives/Table";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { agentMcpEntityPath, agentEntitiesPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "MCPs | Platos" }];

type McpEntity = {
  entityId: string;
  entityPk: string;
  displayName: string;
  mcpEnabled: boolean;
  identityMode: string;
  toolCount: number;
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

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

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  let entities: McpEntity[] = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const res = await fetch(`${AGENT_API_URL}/mcp/entity`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()) as { entities: McpEntity[] };
        entities = data.entities ?? [];
      }
    }
  } catch { /* agent unreachable */ }

  return typedjson({
    entities,
    org: { slug: organizationSlug },
    project: { slug: projectParam },
    environment: { slug: envParam },
  });
}

export default function McpsListPage() {
  const { entities, org, project, environment } = useTypedLoaderData<typeof loader>();
  const [copied, setCopied] = useState<string | null>(null);
  const AGENT_API_URL = "https://test.platos.dev"; // runtime URL

  const copyUrl = (entityId: string) => {
    const url = `${AGENT_API_URL}/mcp/entity/${entityId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(entityId);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="MCPs" />
        <PageAccessories>
          <DocsLink slug="mcp-gateway" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        {entities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-dimmed">
            <ShareIcon className="size-10 opacity-40" />
            <Paragraph variant="small">
              No MCP endpoints configured.{" "}
              <Link
                to={agentEntitiesPath(org, project, environment)}
                className="text-emerald-400 hover:text-emerald-300"
              >
                Enable MCP on a connected entity →
              </Link>
            </Paragraph>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Entity</TableHeaderCell>
                <TableHeaderCell>MCP URL</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Identity</TableHeaderCell>
                <TableHeaderCell>Exposed tools</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map((e) => (
                <TableRow key={e.entityId} className="hover:bg-charcoal-800/50">
                  <TableCell>
                    <Link
                      to={agentMcpEntityPath(org, project, environment, e.entityId)}
                      className="text-emerald-400 hover:text-emerald-300 font-medium"
                    >
                      {e.displayName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs text-text-dimmed font-mono truncate max-w-[200px]">
                        /mcp/entity/{e.entityId}
                      </code>
                      <button
                        type="button"
                        onClick={() => copyUrl(e.entityId)}
                        className="text-text-dimmed hover:text-text-bright flex-shrink-0"
                        title="Copy MCP URL"
                      >
                        <ClipboardDocumentIcon className="size-3.5" />
                      </button>
                      {copied === e.entityId && (
                        <span className="text-xs text-emerald-400">Copied!</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={e.mcpEnabled ? "success" : "outline-rounded"}>
                      {e.mcpEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-dimmed">{e.identityMode || "—"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs">{e.toolCount}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </PageContainer>
  );
}
