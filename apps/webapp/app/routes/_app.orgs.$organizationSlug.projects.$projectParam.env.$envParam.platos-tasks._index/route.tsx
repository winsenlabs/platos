/**
 * PIFSP-12 — Platos custom tasks list.
 */
import {
  BoltIcon,
  ClockIcon,
  GlobeAltIcon,
  PlusIcon,
  TrashIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/20/solid";
import { Form, Link, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
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
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Custom Tasks | Platos" }];

type TaskRow = {
  id: string;
  taskId: string;
  displayName: string;
  description: string | null;
  triggerType: string;
  isActive: boolean;
  handlerVersion: number;
  lastRunAt: string | null;
  updatedAt: string;
};

type Scope = { organizationId: string; projectId: string; environmentId: string; userId: string };

async function agentFetch<T>(path: string, scope: Scope, opts?: { method?: string; body?: unknown }): Promise<T | null> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      },
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
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
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = { organizationId: project.organizationId, projectId: project.id, environmentId: environment.id, userId };

  const result = await agentFetch<{ tasks: TaskRow[] }>("/api/v1/agent/platos-tasks", scope);
  return typedjson({ tasks: result?.tasks ?? [], organizationSlug, projectParam, envParam });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = { organizationId: project.organizationId, projectId: project.id, environmentId: environment.id, userId };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "delete") {
    const id = String(form.get("id") ?? "");
    if (id) await agentFetch(`/api/v1/agent/platos-tasks/${id}`, scope, { method: "DELETE" });
  }

  if (intent === "run") {
    const id = String(form.get("id") ?? "");
    if (id) await agentFetch(`/api/v1/agent/platos-tasks/${id}/run`, scope, { method: "POST" });
  }

  return typedjson({ ok: true });
}

const TRIGGER_TYPE_ICONS: Record<string, React.ReactNode> = {
  manual: <WrenchScrewdriverIcon className="size-3.5" />,
  schedule: <ClockIcon className="size-3.5" />,
  webhook: <GlobeAltIcon className="size-3.5" />,
  "agent-spawn": <BoltIcon className="size-3.5" />,
};

export default function PlatosTasksList() {
  const { tasks, organizationSlug, projectParam, envParam } = useTypedLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const basePath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/platos-tasks`;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Custom Tasks" icon={<WrenchScrewdriverIcon className="size-5 text-emerald-500" />} />
        <div className="ml-auto flex items-center gap-2">
          <DocsLink slug="platos-tasks" />
          <LinkButton variant="primary/small" LeadingIcon={PlusIcon} to={`${basePath}/new`}>
            New task
          </LinkButton>
        </div>
      </NavBar>
      <PageBody>
        <Paragraph variant="small" className="mb-4 text-text-dimmed">
          Operator-authored JavaScript task handlers. Each task runs in an isolated Node vm sandbox with access to logger, fetch, and payload helpers.
        </Paragraph>

        {tasks.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-8 text-center">
            <WrenchScrewdriverIcon className="mx-auto mb-3 size-10 opacity-30" />
            <p className="text-sm text-text-bright">No custom tasks yet</p>
            <p className="mt-1 text-xs text-text-dimmed">Create a task to run custom JavaScript logic on demand, on a schedule, or from an agent.</p>
            <div className="mt-4">
              <LinkButton variant="primary/small" LeadingIcon={PlusIcon} to={`${basePath}/new`}>
                New task
              </LinkButton>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Task</TableHeaderCell>
                <TableHeaderCell>Trigger</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Last run</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link to={`${basePath}/${t.id}`} className="hover:underline">
                      <div className="font-medium text-text-bright">{t.displayName}</div>
                      <div className="font-mono text-[10px] text-text-dimmed">{t.taskId}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1 text-xs text-text-dimmed">
                      {TRIGGER_TYPE_ICONS[t.triggerType] ?? null}
                      {t.triggerType}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.isActive ? "success" : "error"}>
                      {t.isActive ? "active" : "error"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-dimmed">v{t.handlerVersion}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-dimmed">
                      {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {t.triggerType === "manual" && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="run" />
                          <input type="hidden" name="id" value={t.id} />
                          <Button variant="primary/small" type="submit" disabled={busy || !t.isActive}>
                            Run
                          </Button>
                        </Form>
                      )}
                      <Form method="post" onSubmit={(e) => !confirm("Delete this task?") && e.preventDefault()}>
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={t.id} />
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded p-1 text-text-dimmed hover:bg-charcoal-700 hover:text-rose-300 disabled:opacity-50"
                        >
                          <TrashIcon className="size-4" />
                        </button>
                      </Form>
                    </div>
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
