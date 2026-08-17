/**
 * PIFSP — Manage Postman Templates for a specific agent.
 *
 * Full CRUD management page. Lists all saved postman templates with
 * columns: Name | User ID | Default | Created. Supports inline create,
 * inline edit, delete, and "set as default" toggle.
 *
 * API:
 *   GET    /api/v1/agent/postman-templates?agentId=...
 *   POST   /api/v1/agent/postman-templates
 *   PUT    /api/v1/agent/postman-templates/:id
 *   DELETE /api/v1/agent/postman-templates/:id
 */

import {
  PencilIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { useFetcher, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Postman Templates | Platos" }];

const ParamSchema = EnvironmentParamSchema.extend({ agentId: z.string() });

type PostmanTemplate = {
  id: string;
  name: string;
  simulateUserId: string;
  sessionContext: unknown;
  isDefault: boolean;
  createdAt: string;
};

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
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

// ─── Loader ─────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  let templates: PostmanTemplate[] = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/postman-templates?agentId=${encodeURIComponent(agentId)}`,
        { headers: scopeHeaders(scope), signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { templates: PostmanTemplate[] };
        templates = data.templates ?? [];
      }
    }
  } catch {
    // agent service unavailable — return empty list
  }

  return typedjson({ agentId, templates, scope });
}

// ─── Action ─────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return { ok: false as const, error: "Project not found" };
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) return { ok: false as const, error: "Environment not found" };

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  if (intent === "create") {
    const name = String(fd.get("name") || "").trim();
    const simulateUserId = String(fd.get("simulateUserId") || "").trim();
    const rawCtx = String(fd.get("sessionContext") || "{}").trim();
    if (!name) return { ok: false as const, error: "Name is required" };
    let sessionContext: unknown;
    try {
      sessionContext = JSON.parse(rawCtx);
    } catch {
      return { ok: false as const, error: "Invalid JSON in session context" };
    }
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/postman-templates`, {
        method: "POST",
        headers: scopeHeaders(scope),
        body: JSON.stringify({ agentId, name, simulateUserId, sessionContext }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  if (intent === "update") {
    const templateId = String(fd.get("templateId") || "").trim();
    const name = String(fd.get("name") || "").trim();
    const simulateUserId = String(fd.get("simulateUserId") || "").trim();
    const rawCtx = String(fd.get("sessionContext") || "{}").trim();
    const isDefault = fd.get("isDefault") === "true";
    if (!templateId) return { ok: false as const, error: "templateId is required" };
    let sessionContext: unknown;
    try {
      sessionContext = JSON.parse(rawCtx);
    } catch {
      return { ok: false as const, error: "Invalid JSON in session context" };
    }
    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/postman-templates/${encodeURIComponent(templateId)}`,
        {
          method: "PUT",
          headers: scopeHeaders(scope),
          body: JSON.stringify({ name, simulateUserId, sessionContext, isDefault }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  if (intent === "delete") {
    const templateId = String(fd.get("templateId") || "").trim();
    if (!templateId) return { ok: false as const, error: "templateId is required" };
    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/postman-templates/${encodeURIComponent(templateId)}`,
        {
          method: "DELETE",
          headers: scopeHeaders(scope),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  if (intent === "set-default") {
    const templateId = String(fd.get("templateId") || "").trim();
    if (!templateId) return { ok: false as const, error: "templateId is required" };
    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/postman-templates/${encodeURIComponent(templateId)}`,
        {
          method: "PUT",
          headers: scopeHeaders(scope),
          body: JSON.stringify({ isDefault: true }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  return { ok: false as const, error: `Unknown intent: ${intent}` };
}

// ─── Inline create form ─────────────────────────────────────────────────────

function CreateTemplateRow({ onCancel }: { onCancel: () => void }) {
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post" className="flex flex-col gap-2 bg-charcoal-800/60 rounded border border-charcoal-700 p-3">
      <input type="hidden" name="intent" value="create" />
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-dimmed">Name *</label>
          <input
            type="text"
            name="name"
            required
            placeholder="e.g. Admin User"
            className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-dimmed">Simulate User ID</label>
          <input
            type="text"
            name="simulateUserId"
            placeholder="user_abc123"
            className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-dimmed">Session context (JSON)</label>
        <textarea
          name="sessionContext"
          rows={3}
          defaultValue="{}"
          className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono resize-y"
          placeholder='{"entity_ids": [], "user.name": "Alice"}'
        />
      </div>
      {fetcher.data && "error" in fetcher.data && (
        <p className="text-xs text-rose-400">{fetcher.data.error}</p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isBusy}
          className="text-xs bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-1.5 disabled:opacity-50"
        >
          {isBusy ? "Saving…" : "Create template"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-text-dimmed hover:text-text-bright px-2 py-1.5"
        >
          Cancel
        </button>
      </div>
    </fetcher.Form>
  );
}

// ─── Inline edit form ────────────────────────────────────────────────────────

function EditTemplateRow({
  template,
  onCancel,
}: {
  template: PostmanTemplate;
  onCancel: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post" className="flex flex-col gap-2 bg-charcoal-800/60 rounded border border-emerald-700/40 p-3">
      <input type="hidden" name="intent" value="update" />
      <input type="hidden" name="templateId" value={template.id} />
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-dimmed">Name</label>
          <input
            type="text"
            name="name"
            defaultValue={template.name}
            required
            className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-dimmed">Simulate User ID</label>
          <input
            type="text"
            name="simulateUserId"
            defaultValue={template.simulateUserId}
            className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-dimmed">Session context (JSON)</label>
        <textarea
          name="sessionContext"
          rows={3}
          defaultValue={template.sessionContext ? JSON.stringify(template.sessionContext, null, 2) : "{}"}
          className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono resize-y"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-text-dimmed">
        <input type="hidden" name="isDefault" value="false" />
        <input
          type="checkbox"
          name="isDefault"
          value="true"
          defaultChecked={template.isDefault}
          className="accent-emerald-500"
        />
        Set as default
      </label>
      {fetcher.data && "error" in fetcher.data && (
        <p className="text-xs text-rose-400">{fetcher.data.error}</p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isBusy}
          className="text-xs bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-1.5 disabled:opacity-50"
        >
          {isBusy ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-text-dimmed hover:text-text-bright px-2 py-1.5"
        >
          Cancel
        </button>
      </div>
    </fetcher.Form>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function PostmanTemplatesPage() {
  const { templates } = useTypedLoaderData<typeof loader>();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const deleteFetcher = useFetcher<typeof action>();
  const defaultFetcher = useFetcher<typeof action>();

  return (
    <PageBody>
      <div className="p-4 max-w-4xl mx-auto flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-bright">Postman Templates</h2>
            <p className="text-xs text-text-dimmed mt-0.5">
              Saved request configurations for Chat Postman mode. Each template pre-fills
              the User ID and session context, enabling repeatable API simulations.
            </p>
          </div>
          {!showCreate && (
            <Button
              variant="primary/small"
              onClick={() => setShowCreate(true)}
              LeadingIcon={PlusIcon}
            >
              New template
            </Button>
          )}
        </div>

        {/* Inline create form */}
        {showCreate && (
          <CreateTemplateRow onCancel={() => setShowCreate(false)} />
        )}

        {/* Templates table */}
        {templates.length === 0 && !showCreate ? (
          <div className="rounded border border-charcoal-700 bg-charcoal-900/40 px-4 py-8 text-center text-sm text-text-dimmed">
            No templates yet. Create one to pre-fill Postman mode settings.
          </div>
        ) : (
          <div className="rounded border border-charcoal-700 overflow-hidden">
            {/* Column header */}
            <div className="grid grid-cols-[1fr_1fr_6rem_9rem_7rem] gap-3 bg-charcoal-800/60 px-4 py-2 text-xs font-medium text-text-dimmed uppercase tracking-wide border-b border-charcoal-700">
              <span>Name</span>
              <span>User ID</span>
              <span>Default</span>
              <span>Created</span>
              <span className="text-right">Actions</span>
            </div>

            {templates.map((tpl) =>
              editingId === tpl.id ? (
                <div key={tpl.id} className="border-b border-charcoal-700 p-3">
                  <EditTemplateRow
                    template={tpl}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <div
                  key={tpl.id}
                  className="grid grid-cols-[1fr_1fr_6rem_9rem_7rem] gap-3 items-center px-4 py-3 border-b border-charcoal-700 last:border-b-0 hover:bg-charcoal-800/20 text-sm"
                >
                  {/* Name */}
                  <span className="text-text-bright font-medium truncate">{tpl.name}</span>

                  {/* User ID */}
                  <span className="font-mono text-xs text-text-dimmed truncate">
                    {tpl.simulateUserId || <span className="italic opacity-50">—</span>}
                  </span>

                  {/* Default badge */}
                  <span>
                    {tpl.isDefault ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-300">
                        <StarIcon className="size-2.5" /> default
                      </span>
                    ) : (
                      <defaultFetcher.Form method="post">
                        <input type="hidden" name="intent" value="set-default" />
                        <input type="hidden" name="templateId" value={tpl.id} />
                        <button
                          type="submit"
                          title="Set as default"
                          className="text-text-dimmed hover:text-amber-400 transition-colors"
                        >
                          <StarIcon className="size-4" />
                        </button>
                      </defaultFetcher.Form>
                    )}
                  </span>

                  {/* Created at */}
                  <span className="text-xs text-text-dimmed">
                    {new Date(tpl.createdAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      title="Edit"
                      onClick={() => setEditingId(tpl.id)}
                      className="text-text-dimmed hover:text-text-bright transition-colors"
                    >
                      <PencilIcon className="size-4" />
                    </button>
                    <deleteFetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="templateId" value={tpl.id} />
                      <button
                        type="submit"
                        title="Delete"
                        onClick={(e) => {
                          if (!confirm(`Delete template "${tpl.name}"?`)) e.preventDefault();
                        }}
                        className="text-text-dimmed hover:text-rose-400 transition-colors"
                      >
                        <TrashIcon className="size-4" />
                      </button>
                    </deleteFetcher.Form>
                  </div>
                </div>
              ),
            )}
          </div>
        )}

        {/* Action errors */}
        {deleteFetcher.data && "error" in deleteFetcher.data && (
          <p className="text-xs text-rose-400">{deleteFetcher.data.error}</p>
        )}
      </div>
    </PageBody>
  );
}
