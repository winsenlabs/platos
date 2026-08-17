import { ChatBubbleLeftRightIcon, ClockIcon, TrashIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { agentConversationsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Conversations | Platos" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const agentId = params.agentId!;
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

  let conversations: Array<{
    id: string;
    title: string | null;
    status: string;
    turnCount: number;
    lastMessage: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];

  try {
    const { isAgentServiceAvailable, listThreads } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const result = await listThreads(scope, { agentId, allUsers: true });
      conversations = (result.threads || []).map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        turnCount: t.turnCount,
        lastMessage: null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    }
  } catch {
    // Agent service not running
  }

  return typedjson({ conversations, agentId });
}

export default function ConversationsPage() {
  const { conversations, agentId } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const basePath = agentConversationsPath(organization, project, environment, agentId);

  return (
    <PageBody>
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <ChatBubbleLeftRightIcon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="text-center max-w-md">
              No conversations yet. Start chatting with the agent to see conversation history here.
            </Paragraph>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Turns</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Last Activity</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversations.map((conv) => {
                const threadPath = `${basePath}/${conv.id}`;
                return (
                  <TableRow key={conv.id}>
                    <TableCell to={threadPath}>
                      <span className="font-medium">{conv.title || "Untitled"}</span>
                      {conv.lastMessage && (
                        <span className="block text-text-dimmed text-xs truncate max-w-md">{conv.lastMessage}</span>
                      )}
                    </TableCell>
                    <TableCell to={threadPath}>{conv.turnCount}</TableCell>
                    <TableCell to={threadPath}>
                      <Badge variant={conv.status === "active" ? "success" : "outline-rounded"}>
                        {conv.status}
                      </Badge>
                    </TableCell>
                    <TableCell to={threadPath}>{new Date(conv.updatedAt).toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
    </PageBody>
  );
}
