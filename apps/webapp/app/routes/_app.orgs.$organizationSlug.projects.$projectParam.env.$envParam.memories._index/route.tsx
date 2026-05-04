/**
 * Theme O.5 / O.6 / O.9 — /memories viewer + editor.
 *
 * Lists every memory for the current user, grouped by kind. Supports:
 *   - filter by kind, source, agent
 *   - search within content (client-side substring)
 *   - in-place edit (content + metadata + visibility)
 *   - delete
 *   - add a manual memory
 *   - export/import the user's memory bundle
 */
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  LightBulbIcon,
  PlusIcon,
  TrashIcon,
  PencilSquareIcon,
  EyeIcon,
  EyeSlashIcon,
  LockClosedIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  Link,
  useActionData,
  useNavigation,
  type MetaFunction,
} from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  memoriesGraphPath,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Memories | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

// Theme M.4 — the legacy PlatosAgentUserProfile blob is gone. Profile
// rows now live in PlatosMemory with kind="profile" and surface under
// the `profile` chip in the main list below, same as any other memory.
const MEMORY_KINDS = ["fact", "preference", "event", "relationship", "profile"] as const;
type MemoryKind = (typeof MEMORY_KINDS)[number];
type MemoryVisibility = "agent_visible" | "hidden" | "private";

export type MemoryRow = {
  id: string;
  agentId: string | null;
  userId: string;
  kind: string;
  content: string;
  metadata: unknown;
  agentVisible: boolean;
  visibility: MemoryVisibility;
  source: string;
  sourceThreadId: string | null;
  sourceMessageIds: string[];
  extractorVersion: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
};

type AgentRef = { id: string; name: string };

// Theme M.4 — the dedicated "User profiles" section + UserProfileRow
// type were dropped along with the PlatosAgentUserProfile blob. Profile
// rows now surface under the kind="profile" chip in the unified
// memories list (see MEMORY_KINDS above).

type LoaderData = {
  memories: MemoryRow[];
  agents: AgentRef[];
  agentReachable: boolean;
  graphPath: string;
  exportHref: string;
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

async function agentFetch<T>(
  path: string,
  scope: Scope,
  opts?: { method?: string; body?: unknown },
): Promise<T | null> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method || "GET",
      headers: scopeHeaders(scope),
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
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  // EOBD.77 — ?action=export triggers a browser download of the current
  // user's memory bundle. Proxies the agent service's /api/v1/memory/export
  // endpoint (scope-gated via X-Platos-* headers) and streams JSON back
  // with a Content-Disposition attachment so the browser saves the file.
  const url = new URL(request.url);
  if (url.searchParams.get("action") === "export") {
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const targetUser = url.searchParams.get("userId") || userId;
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/memory/export?userId=${encodeURIComponent(targetUser)}`,
      {
        method: "GET",
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(30000),
      },
    ).catch(() => null);
    if (!res || !res.ok) {
      throw new Response(
        JSON.stringify({ error: "Agent service unreachable or export failed" }),
        { status: res?.status ?? 502, headers: { "Content-Type": "application/json" } },
      );
    }
    const body = await res.text();
    const filename = `platos-memories-${targetUser}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    // EOBD.77 — `throw` the Response so Remix short-circuits rendering
    // and streams the download directly. `return` would widen the
    // loader's inferred return type to include `Response`, breaking
    // `useTypedLoaderData<typeof loader>` in the component below.
    throw new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const mem = await agentFetch<{ memories: MemoryRow[] }>(
    `/api/v1/memory?userId=${encodeURIComponent(userId)}&limit=200`,
    scope,
  );
  const agentsData = await agentFetch<{ agents: AgentRef[] }>("/api/v1/agent/agents", scope);

  const graphPath = memoriesGraphPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  );

  const exportHref = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  )}/memories?action=export`;

  const payload: LoaderData = {
    memories: mem?.memories ?? [],
    agents: agentsData?.agents ?? [],
    agentReachable: !!mem,
    graphPath,
    exportHref,
  };
  return typedjson(payload);
}

type ActionResult =
  | { ok: true; message?: string }
  | { error: string; validationErrors?: string[] };

function isActionError(data: unknown): data is { error: string; validationErrors?: string[] } {
  return (
    !!data && typeof data === "object" && "error" in (data as Record<string, unknown>) &&
    typeof (data as { error: unknown }).error === "string"
  );
}

function isActionSuccess(data: unknown): data is { ok: true; message?: string } {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return rec.ok === true;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return typedjson<ActionResult>({ error: "Project not found" }, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return typedjson<ActionResult>({ error: "Environment not found" }, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const content = String(formData.get("content") ?? "").trim();
    if (!content) return typedjson<ActionResult>({ error: "Content is required" }, { status: 400 });
    const kind = String(formData.get("kind") ?? "fact");
    const visibility = (String(formData.get("visibility") ?? "agent_visible") as MemoryVisibility);
    const metaRaw = String(formData.get("metadataJson") ?? "").trim();
    let metadata: unknown = undefined;
    if (metaRaw.length > 0) {
      try {
        metadata = JSON.parse(metaRaw);
      } catch {
        return typedjson<ActionResult>({ error: "metadataJson must be valid JSON" }, { status: 400 });
      }
    }
    const result = await agentFetch<{ memory?: MemoryRow; error?: string; validationErrors?: string[] }>(
      "/api/v1/memory",
      scope,
      {
        method: "POST",
        body: { content, kind, visibility, metadata, source: "manual" },
      },
    );
    if (!result) return typedjson<ActionResult>({ error: "Agent service unreachable" }, { status: 502 });
    if (result.error)
      return typedjson<ActionResult>({ error: result.error, validationErrors: result.validationErrors }, { status: 400 });
    return typedjson<ActionResult>({ ok: true, message: "Memory saved" });
  }

  if (intent === "update") {
    const id = String(formData.get("memoryId") ?? "");
    if (!id) return typedjson<ActionResult>({ error: "memoryId is required" }, { status: 400 });
    const content = String(formData.get("content") ?? "");
    const kind = String(formData.get("kind") ?? "") as MemoryKind;
    const visibility = String(formData.get("visibility") ?? "agent_visible") as MemoryVisibility;
    const metaRaw = String(formData.get("metadataJson") ?? "").trim();
    let metadata: unknown = undefined;
    if (metaRaw.length > 0) {
      try {
        metadata = JSON.parse(metaRaw);
      } catch {
        return typedjson<ActionResult>({ error: "metadataJson must be valid JSON" }, { status: 400 });
      }
    }
    const result = await agentFetch<{ memory?: MemoryRow; error?: string; validationErrors?: string[] }>(
      `/api/v1/memory/${encodeURIComponent(id)}`,
      scope,
      {
        method: "POST",
        body: { content, kind, visibility, metadata },
      },
    );
    if (!result) return typedjson<ActionResult>({ error: "Agent service unreachable" }, { status: 502 });
    if (result.error)
      return typedjson<ActionResult>({ error: result.error, validationErrors: result.validationErrors }, { status: 400 });
    return typedjson<ActionResult>({ ok: true, message: "Memory updated" });
  }

  if (intent === "delete") {
    const id = String(formData.get("memoryId") ?? "");
    if (!id) return typedjson<ActionResult>({ error: "memoryId is required" }, { status: 400 });
    await agentFetch(`/api/v1/memory/${encodeURIComponent(id)}`, scope, { method: "DELETE" });
    return typedjson<ActionResult>({ ok: true, message: "Memory deleted" });
  }

  // Theme M.4 — the `delete-profile` intent was dropped along with the
  // legacy PlatosAgentUserProfile blob. Profile rows are now regular
  // PlatosMemory rows (kind="profile") and use the standard `delete`
  // intent above.

  if (intent === "import") {
    const mode = String(formData.get("mode") ?? "merge") === "replace" ? "replace" : "merge";
    const raw = String(formData.get("bundleJson") ?? "").trim();
    if (!raw) return typedjson<ActionResult>({ error: "Paste the bundle JSON first" }, { status: 400 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return typedjson<ActionResult>({ error: "Bundle must be valid JSON" }, { status: 400 });
    }
    const result = await agentFetch<{ ok?: boolean; error?: string }>(
      "/api/v1/memory/import",
      scope,
      { method: "POST", body: { version: 1, bundle: parsed, mode } },
    );
    if (!result) return typedjson<ActionResult>({ error: "Agent service unreachable" }, { status: 502 });
    if (result.error) return typedjson<ActionResult>({ error: result.error }, { status: 400 });
    return typedjson<ActionResult>({ ok: true, message: `Imported (${mode})` });
  }

  return typedjson<ActionResult>({ error: "Unknown intent" }, { status: 400 });
}

function visibilityIcon(v: MemoryVisibility) {
  if (v === "private") return LockClosedIcon;
  if (v === "hidden") return EyeSlashIcon;
  return EyeIcon;
}

export default function MemoriesPage() {
  const {
    memories,
    agents,
    agentReachable,
    graphPath,
    exportHref,
  } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const agentsById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );

  const [searchText, setSearchText] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return memories.filter((m) => {
      if (agentFilter !== "all" && (m.agentId ?? "") !== agentFilter) return false;
      if (sourceFilter !== "all" && m.source !== sourceFilter) return false;
      if (q && !m.content.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [memories, searchText, agentFilter, sourceFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, MemoryRow[]>();
    for (const k of MEMORY_KINDS) map.set(k, []);
    for (const m of filtered) {
      const bucket = map.get(m.kind) ?? [];
      bucket.push(m);
      map.set(m.kind, bucket);
    }
    return map;
  }, [filtered]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Memories" icon={<LightBulbIcon className="size-5 text-amber-400" />} />
        <PageAccessories>
          <DocsLink slug="memory" />
          <LinkButton to={graphPath} variant="tertiary/small">
            Graph view
          </LinkButton>
          {/* EOBD.77 — browser-native export. The Remix loader handles
              `?action=export` by proxying agent's /api/v1/memory/export with
              the scope headers and streaming the bundle back with a
              Content-Disposition attachment. The `download` hint prompts the
              browser to save the JSON rather than navigating to it. */}
          <a
            href={exportHref}
            download
            className="inline-flex items-center gap-1 rounded border border-grid-dimmed px-2 py-1 text-xs text-text-bright hover:border-emerald-500"
          >
            <ArrowDownTrayIcon className="size-4" /> Export
          </a>
          <Button
            variant="tertiary/small"
            LeadingIcon={ArrowUpTrayIcon}
            onClick={() => setShowImportForm((s) => !s)}
          >
            Import
          </Button>
          <Button
            variant="primary/small"
            LeadingIcon={PlusIcon}
            onClick={() => setShowAddForm((s) => !s)}
          >
            Add memory
          </Button>
        </PageAccessories>
      </NavBar>
      <PageBody>
        {!agentReachable ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4 mb-4">
            <Paragraph>
              The agent service is unreachable. Memories will appear here once it comes back online.
            </Paragraph>
          </div>
        ) : null}

        {actionData && isActionError(actionData) ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 mb-4">
            <Paragraph variant="small">{actionData.error}</Paragraph>
            {actionData.validationErrors && actionData.validationErrors.length > 0 ? (
              <ul className="mt-1 list-inside list-disc text-xs text-text-dimmed">
                {actionData.validationErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {isActionSuccess(actionData) && actionData.message ? (
          <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 mb-4">
            <Paragraph variant="small">{actionData.message}</Paragraph>
          </div>
        ) : null}

        {/* Theme M.4 — the legacy "User profiles" section was removed.
            Profile rows now appear inline under the `profile` kind chip
            in the main memories list below. */}

        {showAddForm ? (
          <Form method="post" className="rounded border border-grid-dimmed bg-background-dimmed p-4 mb-6 space-y-3">
            <input type="hidden" name="intent" value="create" />
            <div className="flex gap-2">
              <select
                name="kind"
                className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                defaultValue="fact"
              >
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select
                name="visibility"
                className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                defaultValue="agent_visible"
              >
                <option value="agent_visible">Agent visible</option>
                <option value="hidden">Hidden (agent only, UI hides)</option>
                <option value="private">Private (neither)</option>
              </select>
            </div>
            <textarea
              name="content"
              placeholder="What should I remember?"
              rows={2}
              className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
              required
            />
            <textarea
              name="metadataJson"
              placeholder='Optional JSON metadata (e.g. {"topic":"work"}). Relationship kind REQUIRES {from,to,type}.'
              rows={2}
              className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm font-mono text-text-bright"
            />
            <div className="flex justify-end gap-2">
              <Button variant="tertiary/small" type="button" onClick={() => setShowAddForm(false)}>
                Cancel
              </Button>
              <Button variant="primary/small" type="submit" disabled={isSubmitting}>
                Save memory
              </Button>
            </div>
          </Form>
        ) : null}

        {showImportForm ? (
          <Form method="post" className="rounded border border-grid-dimmed bg-background-dimmed p-4 mb-6 space-y-3">
            <input type="hidden" name="intent" value="import" />
            <Header3>Import bundle</Header3>
            <Paragraph variant="small" className="text-text-dimmed">
              Paste a JSON bundle from GET /api/v1/memory/export. The import always uses the CURRENT scope + userId, never the bundle's original user.
            </Paragraph>
            <textarea
              name="bundleJson"
              rows={8}
              className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs font-mono text-text-bright"
              placeholder='{"version":1,"memories":[...],"entities":[...],"relationships":[...]}'
            />
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-text-dimmed">
                <input type="radio" name="mode" value="merge" defaultChecked /> Merge (append)
              </label>
              <label className="flex items-center gap-2 text-xs text-text-dimmed">
                <input type="radio" name="mode" value="replace" /> Replace (delete prior first)
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary/small" type="button" onClick={() => setShowImportForm(false)}>
                Cancel
              </Button>
              <Button variant="primary/small" type="submit" disabled={isSubmitting}>
                Import
              </Button>
            </div>
          </Form>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Input
            placeholder="Search memory content..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="max-w-xs"
          />
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
          >
            <option value="all">All agents</option>
            <option value="">(unscoped)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
          >
            <option value="all">All sources</option>
            <option value="manual">Manual</option>
            <option value="extracted">Extracted</option>
            <option value="imported">Imported</option>
          </select>
          <span className="text-xs text-text-dimmed">
            {filtered.length} of {memories.length} memories
          </span>
        </div>

        {Array.from(grouped.entries()).map(([kind, rows]) => (
          <section key={kind} className="mb-6">
            <Header3 className="capitalize">{kind}s ({rows.length})</Header3>
            {rows.length === 0 ? (
              <Paragraph variant="small" className="text-text-dimmed">
                No {kind} memories in view.
              </Paragraph>
            ) : (
              <ul className="mt-2 space-y-2">
                {rows.map((m) => {
                  const VisIcon = visibilityIcon(m.visibility);
                  const isExpanded = expandedId === m.id;
                  return (
                    <li key={m.id} className="rounded border border-grid-dimmed bg-background-dimmed p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs text-text-dimmed">
                            <Badge variant="small">{m.kind}</Badge>
                            <Badge variant="small">{m.source}</Badge>
                            <VisIcon className="size-3" />
                            <span className="truncate">{m.visibility}</span>
                            {m.agentId ? (
                              <span className="truncate">
                                agent: {agentsById.get(m.agentId)?.name ?? m.agentId}
                              </span>
                            ) : null}
                          </div>
                          <Paragraph className="mt-1 break-words">{m.content}</Paragraph>
                          {isExpanded ? (
                            <div className="mt-3 space-y-2 rounded bg-charcoal-900 p-3 text-xs text-text-dimmed">
                              <div>
                                Created {new Date(m.createdAt).toLocaleString()} · Updated{" "}
                                {new Date(m.updatedAt).toLocaleString()}
                              </div>
                              {m.sourceThreadId ? (
                                <div>
                                  Source thread:{" "}
                                  <Link className="underline" to={`../conversations/${m.sourceThreadId}`}>
                                    {m.sourceThreadId}
                                  </Link>
                                  {m.sourceMessageIds.length > 0 ? (
                                    <span> · {m.sourceMessageIds.length} messages</span>
                                  ) : null}
                                </div>
                              ) : null}
                              {m.extractorVersion ? (
                                <div>Extractor: {m.extractorVersion}</div>
                              ) : null}
                              <Form method="post" className="space-y-2 pt-2">
                                <input type="hidden" name="intent" value="update" />
                                <input type="hidden" name="memoryId" value={m.id} />
                                <div className="flex gap-2">
                                  <select
                                    name="kind"
                                    defaultValue={m.kind}
                                    className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-text-bright"
                                  >
                                    {MEMORY_KINDS.map((k) => (
                                      <option key={k} value={k}>
                                        {k}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    name="visibility"
                                    defaultValue={m.visibility}
                                    className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-text-bright"
                                  >
                                    <option value="agent_visible">Agent visible</option>
                                    <option value="hidden">Hidden</option>
                                    <option value="private">Private</option>
                                  </select>
                                </div>
                                <textarea
                                  name="content"
                                  defaultValue={m.content}
                                  rows={2}
                                  className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-text-bright"
                                />
                                <textarea
                                  name="metadataJson"
                                  defaultValue={m.metadata ? JSON.stringify(m.metadata, null, 2) : ""}
                                  rows={2}
                                  className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 font-mono text-xs text-text-bright"
                                />
                                <div className="flex justify-end gap-2">
                                  <Button variant="primary/small" type="submit" disabled={isSubmitting}>
                                    Save
                                  </Button>
                                </div>
                              </Form>
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <Button
                            variant="tertiary/small"
                            type="button"
                            LeadingIcon={PencilSquareIcon}
                            onClick={() => setExpandedId(isExpanded ? null : m.id)}
                          >
                            {isExpanded ? "Close" : "Edit"}
                          </Button>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="memoryId" value={m.id} />
                            <Button
                              variant="tertiary/small"
                              type="submit"
                              LeadingIcon={TrashIcon}
                              disabled={isSubmitting}
                            >
                              Delete
                            </Button>
                          </Form>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </PageBody>
    </PageContainer>
  );
}
