/**
 * PIFSP-12 — Create a new custom task.
 */
import { WrenchScrewdriverIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation, type MetaFunction } from "@remix-run/react";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "New Task | Platos" }];

type Scope = { organizationId: string; projectId: string; environmentId: string; userId: string };

async function agentFetch<T>(path: string, scope: Scope, opts?: { method?: string; body?: unknown }): Promise<{ ok: boolean; status: number; data: T | null }> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method ?? "POST",
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
  await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  return typedjson({ organizationSlug, projectParam, envParam });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = { organizationId: project.organizationId, projectId: project.id, environmentId: environment.id, userId };

  const form = await request.formData();
  const body = {
    taskId: String(form.get("taskId") ?? "").trim(),
    displayName: String(form.get("displayName") ?? "").trim(),
    description: String(form.get("description") ?? "").trim() || undefined,
    triggerType: String(form.get("triggerType") ?? "manual"),
    allowedAgentIds: String(form.get("allowedAgentIds") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    handler: String(form.get("handler") ?? ""),
    timeout: parseInt(String(form.get("timeout") ?? "300"), 10) || 300,
    maxRetries: parseInt(String(form.get("maxRetries") ?? "3"), 10) || 3,
  };

  const result = await agentFetch<{ task: { id: string }; syntaxError?: string | null }>(
    "/api/v1/agent/platos-tasks",
    scope,
    { method: "POST", body },
  );

  if (!result.ok) {
    const errMsg = (result.data as any)?.message ?? `Agent returned ${result.status}`;
    return typedjson({ error: errMsg, syntaxError: null });
  }

  const taskId = (result.data as any)?.task?.id;
  if (!taskId) return typedjson({ error: "Unexpected response from agent", syntaxError: null });

  return redirect(`/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/platos-tasks/${taskId}`);
}

const DEFAULT_HANDLER = `// Platos custom task handler
// The \`run\` function is called with (payload, ctx).
// ctx exposes: ctx.logger, ctx.fetch, ctx.output.set(), ctx.metadata.set()

async function run(payload, ctx) {
  ctx.logger.info("Task started", { payload });

  // Your logic here...
  const result = { processed: true, input: payload };

  ctx.output.set(result);
  return result;
}
`;

export default function NewTask() {
  const { organizationSlug, projectParam, envParam } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const basePath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/platos-tasks`;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="New task" icon={<WrenchScrewdriverIcon className="size-5 text-emerald-500" />} />
        <PageAccessories>
          <DocsLink slug="platos-tasks" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Form method="post" className="flex flex-col gap-4 max-w-3xl">
          {actionData?.error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {actionData.error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Task ID (slug) *</span>
              <input name="taskId" required placeholder="send-email" pattern="[a-z0-9-]{1,64}"
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <span className="text-[10px] text-text-dimmed">Lowercase alphanumeric + hyphens, 1-64 chars</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Display name *</span>
              <input name="displayName" required placeholder="Send Welcome Email"
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-dimmed">Description</span>
            <input name="description" placeholder="What does this task do?"
              className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500" />
          </label>

          <div className="grid grid-cols-3 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Trigger type</span>
              <select name="triggerType" defaultValue="manual"
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none">
                <option value="manual">Manual</option>
                <option value="agent-spawn">Agent-spawn</option>
                <option value="schedule">Schedule</option>
                <option value="webhook">Webhook</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Timeout (sec)</span>
              <input name="timeout" type="number" min="10" max="3600" defaultValue="300"
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none" />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-dimmed">Max retries</span>
              <input name="maxRetries" type="number" min="0" max="10" defaultValue="3"
                className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none" />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-dimmed">Allowed agent IDs (agent-spawn only, comma-separated)</span>
            <input name="allowedAgentIds" placeholder="agent-id-1, agent-id-2"
              className="rounded border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm font-mono text-text-bright focus:outline-none" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-dimmed">Handler (JavaScript) *</span>
            <span className="text-[10px] text-text-dimmed">
              Write a <code>run(payload, ctx)</code> function. Available: <code>ctx.logger</code>, <code>ctx.fetch</code>, <code>ctx.output.set()</code>, <code>ctx.metadata.set()</code>
            </span>
            <textarea
              name="handler"
              required
              rows={18}
              defaultValue={DEFAULT_HANDLER}
              spellCheck={false}
              className="rounded border border-charcoal-700 bg-charcoal-900 px-3 py-2 font-mono text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
            />
          </label>

          <div className="flex gap-3">
            <Button variant="primary/medium" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save task"}
            </Button>
            <LinkButton variant="tertiary/medium" to={basePath}>
              Cancel
            </LinkButton>
          </div>
        </Form>
      </PageBody>
    </PageContainer>
  );
}
