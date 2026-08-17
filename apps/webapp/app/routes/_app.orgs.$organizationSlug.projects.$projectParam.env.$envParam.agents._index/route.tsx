import {
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  CpuChipIcon,
  DocumentDuplicateIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher, type MetaFunction } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentChatPath,
  agentConversationsPath,
  agentPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agents | Platos" }];

type AgentRow = {
  id: string;
  name: string;
  slug: string;
  model: string;
  toolMode: string;
  /** CONSISTENCY (audit #6) — the REAL tool-call method. `toolMode` is the
   *  dead legacy column (never written by the webapp), so the badge below
   *  reads this first and only falls back to the legacy value. */
  toolsBlockConfig?: { mode?: string } | null;
  isActive: boolean;
  threadCount: number;
  createdAt: string;
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
  } as const;
}

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

  // Load agents from platos-agent API (falls back to empty if service unavailable)
  let agents: AgentRow[] = [];

  try {
    const { isAgentServiceAvailable, listAgents } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const result = await listAgents(scope);
      agents = (result.agents || []) as AgentRow[];
    }
  } catch {
    // Agent service not running — show empty state
  }

  return typedjson({ agents });
}

// EOBD.73 + EOBD.74 — per-row delete + duplicate actions. Posts to this route
// with `intent=delete` or `intent=duplicate` and an `agentId`. Delete hits the
// agent API DELETE /api/v1/agent/agents/:agentId; duplicate fetches the source
// config and POSTs a new agent with a "-copy" slug suffix.
export async function action({ request, params }: ActionFunctionArgs) {
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

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  if (!agentId) {
    return typedjson({ error: "agentId is required" }, { status: 400 });
  }

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = scopeHeaders(scope);

  if (intent === "delete") {
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return typedjson({ error: `Delete failed: ${text || res.status}` }, { status: res.status });
    }
    // Stay on the list — loader re-runs and row disappears.
    return redirect(".");
  }

  if (intent === "duplicate") {
    // Fetch source + POST a clone with suffixed slug/name. CreateAgentDto only
    // accepts a subset of fields; whitelist them before forwarding.
    const sourceRes = await fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!sourceRes.ok) {
      return typedjson(
        { error: `Duplicate failed: source fetch HTTP ${sourceRes.status}` },
        { status: sourceRes.status },
      );
    }
    const source = (await sourceRes.json()) as Record<string, unknown>;
    const srcName = String(source.name ?? agentId);
    const srcSlug = String(source.slug ?? agentId);
    const clone: Record<string, unknown> = {
      name: `${srcName} (copy)`,
      slug: `${srcSlug}-copy-${Date.now().toString(36)}`,
      model: String(source.model ?? "anthropic:claude-sonnet-4-6"),
      systemPrompt: source.systemPrompt ?? undefined,
      promptBlocks: source.promptBlocks ?? undefined,
      dynamicBlocks: source.dynamicBlocks ?? undefined,
      maxSteps: source.maxSteps ?? undefined,
      contextLimit: source.contextLimit ?? undefined,
      historyMode: source.historyMode ?? undefined,
      compactThreshold: source.compactThreshold ?? undefined,
      enableUserProfiling: source.enableUserProfiling ?? undefined,
      toolMode: source.toolMode ?? undefined,
      toolsBlockConfig: source.toolsBlockConfig ?? undefined,
      subAgentConfig: source.subAgentConfig ?? undefined,
      memoryConfig: source.memoryConfig ?? undefined,
      metaTools: source.metaTools ?? undefined,
      outputSchema: source.outputSchema ?? undefined,
      extractionPolicy: source.extractionPolicy ?? undefined,
    };
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify(clone),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return typedjson(
        { error: `Duplicate failed: ${text || res.status}` },
        { status: res.status },
      );
    }
    return redirect(".");
  }

  return typedjson({ error: `Unknown intent: ${intent}` }, { status: 400 });
}

export default function AgentsPage() {
  const { agents } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Agents" icon={<CpuChipIcon className="size-5 text-emerald-500" />} />
        <PageAccessories>
          <DocsLink slug="agents" />
          <LinkButton
            to="new"
            variant="primary/small"
            LeadingIcon={PlusIcon}
          >
            New Agent
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <CpuChipIcon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="text-center max-w-md">
              No agents configured yet. Create your first agent to get started with
              AI-powered tool calling, conversations, and memory.
            </Paragraph>
            <LinkButton
              to="new"
              variant="primary/medium"
              LeadingIcon={PlusIcon}
            >
              Create Agent
            </LinkButton>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Tool-call method</TableHeaderCell>
                <TableHeaderCell>Conversations</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell to={agentPath(organization, project, environment, agent.id)}>
                    <span className="font-medium">{agent.name}</span>
                    <span className="text-text-dimmed ml-2 text-xs">{agent.slug}</span>
                  </TableCell>
                  <TableCell>{agent.model}</TableCell>
                  <TableCell>
                    <Badge variant="outline-rounded">{agent.toolsBlockConfig?.mode ?? agent.toolMode}</Badge>
                  </TableCell>
                  <TableCell>{agent.threadCount}</TableCell>
                  <TableCell>
                    <Badge variant={agent.isActive ? "success" : "outline-rounded"}>
                      {agent.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell alignment="right">
                    <AgentRowActions
                      agent={agent}
                      chatTo={agentChatPath(organization, project, environment, agent.id)}
                      monitorTo={agentConversationsPath(
                        organization,
                        project,
                        environment,
                        agent.id,
                      )}
                    />
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

// EOBD.74 — three-dot dropdown per agent row. Chat + Monitor are plain
// links; Duplicate is a simple Form POST (no extra UI); Delete opens a
// confirmation Dialog before POSTing because it's destructive.
function AgentRowActions({
  agent,
  chatTo,
  monitorTo,
}: {
  agent: AgentRow;
  chatTo: string;
  monitorTo: string;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const deleteFetcher = useFetcher();
  const duplicateFetcher = useFetcher();

  return (
    <div className="flex items-center justify-end">
      <Popover onOpenChange={setMenuOpen} open={menuOpen}>
        <PopoverVerticalEllipseTrigger aria-label={`Actions for ${agent.name}`} />
        <PopoverContent className="min-w-[10rem] p-1" align="end">
          <div className="flex flex-col gap-0.5">
            <PopoverMenuItem
              to={chatTo}
              title="Chat"
              icon={ChatBubbleLeftRightIcon}
              leadingIconClassName="text-cyan-500"
            />
            <PopoverMenuItem
              to={monitorTo}
              title="Monitor"
              icon={ChartBarIcon}
              leadingIconClassName="text-purple-500"
            />
            <duplicateFetcher.Form method="post" className="contents">
              <input type="hidden" name="intent" value="duplicate" />
              <input type="hidden" name="agentId" value={agent.id} />
              <PopoverMenuItem
                type="submit"
                title={duplicateFetcher.state !== "idle" ? "Duplicating..." : "Duplicate"}
                icon={DocumentDuplicateIcon}
                leadingIconClassName="text-amber-500"
                disabled={duplicateFetcher.state !== "idle"}
              />
            </duplicateFetcher.Form>
            <PopoverMenuItem
              type="button"
              title="Delete"
              icon={TrashIcon}
              onClick={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
              danger
            />
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Delete <span className="font-mono text-text-bright">{agent.slug}</span>?
            This cannot be undone. Existing conversations referencing this agent
            will be orphaned.
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="tertiary/medium"
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <deleteFetcher.Form method="post">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="agentId" value={agent.id} />
              <Button
                type="submit"
                variant="danger/medium"
                LeadingIcon={TrashIcon}
                disabled={deleteFetcher.state !== "idle"}
              >
                {deleteFetcher.state !== "idle" ? "Deleting..." : "Delete agent"}
              </Button>
            </deleteFetcher.Form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
