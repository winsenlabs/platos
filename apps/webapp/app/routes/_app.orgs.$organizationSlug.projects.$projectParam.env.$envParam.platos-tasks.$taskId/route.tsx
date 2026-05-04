/**
 * PIFSP-12 — Edit / view a custom task.
 */
import { WrenchScrewdriverIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: `${(data as any)?.task?.displayName ?? "Task"} | Platos` },
];

const ParamSchema = EnvironmentParamSchema.extend({ taskId: z.string() });

type Scope = { organizationId: string; projectId: string; environmentId: string; userId: string };

type PlatosTask = {
  id: string;
  taskId: string;
  displayName: string;
  description: string | null;
  triggerType: string;
  scheduleCron: string | null;
  scheduleTimezone: string | null;
  allowedAgentIds: string[];
  handler: string;
  handlerVersion: number;
  timeout: number;
  maxRetries: number;
  isActive: boolean;
  lastRunAt: string | null;
  updatedAt: string;
};

async function agentFetch<T>(path: string, scope: Scope, opts?: { method?: string; body?: unknown }): Promise<{ ok: boolean; status: number; data: T | null }> {
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
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: data as T };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, taskId } = ParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = { organizationId: project.organizationId, projectId: project.id, environmentId: environment.id, userId };

  const result = await agentFetch<{ task: PlatosTask }>(`/api/v1/agent/platos-tasks/${taskId}`, scope);
  if (!result.ok || !result.data?.task) throw new Response(undefined, { status: 404 });

  return typedjson({ task: result.data.task, organizationSlug, projectParam, envParam });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, taskId } = ParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = { organizationId: project.organizationId, projectId: project.id, environmentId: environment.id, userId };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "run") {
    await agentFetch(`/api/v1/agent/platos-tasks/${taskId}/run`, scope, {
      method: "POST",
      body: {},
    });
    return typedjson({ ok: true, ran: true, error: null, syntaxError: null });
  }

  if (intent === "save") {
    const body: Record<string, unknown> = {
      displayName: String(form.get("displayName") ?? "").trim(),
      description: String(form.get("description") ?? "").trim() || null,
      triggerType: String(form.get("triggerType") ?? "manual"),
      allowedAgentIds: String(form.get("allowedAgentIds") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean),
      handler: String(form.get("handler") ?? ""),
      timeout: parseInt(String(form.get("timeout") ?? "300"), 10) || 300,
      maxRetries: parseInt(String(form.get("maxRetries") ?? "3"), 10) || 3,
    };

    const result = await agentFetch<{ task: PlatosTask; syntaxError?: string | null }>(
      `/api/v1/agent/platos-tasks/${taskId}`,
      scope,
      { method: "PATCH", body },
    );

    if (!result.ok) {
      const errMsg = (result.data as any)?.message ?? `Agent returned ${result.status}`;
      return typedjson({ ok: false, ran: false, error: errMsg, syntaxError: null });
    }

    return typedjson({ ok: true, ran: false, error: null, syntaxError: (result.data as any)?.syntaxError ?? null });
  }

  return typedjson({ ok: false, ran: false, error: "Unknown intent", syntaxError: null });
}

export default function EditTask() {
  const { task, organizationSlug, projectParam, envParam } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const basePath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/platos-tasks`;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={task.displayName} icon={<WrenchScrewdriverIcon className="size-5 text-emerald-500" />} />
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={task.isActive ? "success" : "error"}>{task.isActive ? "active" : "syntax error"}</Badge>
          <span className="text-xs text-text-dimmed">v{task.handlerVersion}</span>
          <DocsLink slug="platos-tasks" />
        </div>
      </NavBar>
      <PageBody>
        <Form method="post" className="flex flex-col gap-4 max-w-3xl">
          {actionData?.error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {actionData.error}
            </div>
          )}
          {actionData?.syntaxError && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              Syntax error — handler saved but task is inactive: {actionData.syntaxError}
            </div>
          )}
          {actionData?.ok && !actionData.ran && !actionData.error && !actionData.syntaxError && (
            <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              Task saved successfully.
            </div>
          )}
          {actionData?.ran && (
            <div className="rounded border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-300">
              Task queued — check Runs tab for execution status.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Task ID</span>
              <input value={task.taskId} readOnly
                className="rounded border border-charcoal-700 bg-charcoal-800/50 px-3 py-2 font-mono text-sm text-text-dimmed" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Display name *</span>
              <input name="displayName" required defaultValue={task.displayName}
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-dimmed">Description</span>
            <input name="description" defaultValue={task.description ?? ""}
              className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500" />
          </label>

          <div className="grid grid-cols-3 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Trigger type</span>
              <select name="triggerType" defaultValue={task.triggerType}
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none">
                <option value="manual">Manual</option>
                <option value="agent-spawn">Agent-spawn</option>
                <option value="schedule">Schedule</option>
                <option value="webhook">Webhook</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Timeout (sec)</span>
              <input name="timeout" type="number" min="10" max="3600" defaultValue={task.timeout}
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Max retries</span>
              <input name="maxRetries" type="number" min="0" max="10" defaultValue={task.maxRetries}
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none" />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-dimmed">Allowed agent IDs (agent-spawn only, comma-separated)</span>
            <input name="allowedAgentIds" defaultValue={task.allowedAgentIds.join(", ")}
              className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm font-mono text-text-bright focus:outline-none" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-dimmed">Handler (JavaScript)</span>
            <span className="text-[10px] text-text-dimmed">
              Write a <code>run(payload, ctx)</code> function. Available: <code>ctx.logger</code>, <code>ctx.fetch</code>, <code>ctx.output.set()</code>, <code>ctx.metadata.set()</code>
            </span>
            <textarea
              name="handler"
              required
              rows={20}
              defaultValue={task.handler}
              spellCheck={false}
              className="rounded border border-charcoal-700 bg-charcoal-900 px-3 py-2 font-mono text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
            />
          </label>

          <div className="flex items-center gap-3">
            <button type="submit" name="intent" value="save" disabled={busy}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy && nav.formData?.get("intent") === "save" ? "Saving…" : "Save"}
            </button>

            {task.triggerType === "manual" && task.isActive && (
              <button type="submit" name="intent" value="run" disabled={busy}
                className="rounded border border-blue-600 px-4 py-2 text-sm font-medium text-blue-300 hover:bg-blue-600/10 disabled:opacity-50">
                {busy && nav.formData?.get("intent") === "run" ? "Queuing…" : "Run now"}
              </button>
            )}

            <LinkButton variant="tertiary/medium" to={basePath}>
              Back to list
            </LinkButton>
          </div>

          {task.lastRunAt && (
            <p className="text-[11px] text-text-dimmed">
              Last run: {new Date(task.lastRunAt).toLocaleString()} · Updated: {new Date(task.updatedAt).toLocaleString()}
            </p>
          )}
        </Form>
      </PageBody>
    </PageContainer>
  );
}
