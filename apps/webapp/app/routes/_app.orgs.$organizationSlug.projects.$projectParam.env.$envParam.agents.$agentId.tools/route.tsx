/**
 * Theme CTX.6 — Tools tab for the agent editor.
 *
 * Surfaces the per-tool, per-param resolution table returned by
 * `GET /api/v1/agent/agents/:id/tool-mappings`. Operators can:
 *   - Toggle `Auto ✓` / `LLM fills` / `Session: <key>` / `Constant` per param.
 *   - Edit the declared-context-key list that drives auto-match.
 *   - See a red "BLOCKED" badge when a required arg lives in LLM-fill and
 *     has no description — forces adding a description, a constant, or a
 *     session mapping before enabling the tool.
 *
 * All writes flow back through the agent PATCH endpoint mutating
 * `contextMapping` on `PlatosAgent`. Fail-open throughout.
 */
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  AdjustmentsHorizontalIcon,
  XCircleIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Tools | Platos" }];

const ParamSchema = EnvironmentParamSchema.extend({ agentId: z.string() });

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

// These shapes mirror the agent-service DTO. Kept local to avoid a cross-app
// type import (the webapp has no direct dependency on the agent service's
// context-automap module; we consume JSON over HTTP).
type ParamResolution =
  | { source: "constant"; value: unknown }
  | { source: "session"; key: string; reason: "override" | "global" | "auto" }
  | { source: "llm"; description?: string; required?: boolean };

type ToolMappingRow = {
  toolName: string;
  sourceEntity: string;
  enabled: boolean;
  health: string;
  params: Array<{
    name: string;
    resolution: ParamResolution;
    required: boolean;
  }>;
  mapped: number;
  total: number;
  warnings: string[];
};

type MappingsPayload = {
  tools: ToolMappingRow[];
  declaredKeys: string[];
  agentId: string;
  total: number;
};

// TL.3 — per-agent category descriptions. The Tools tab prefills the
// editor with userDescription (override) OR defaultDescription (the
// hardcoded one-liner the LLM sees today). An empty saved description
// means "use the default at render time".
type CategoryRow = {
  id: string;
  count: number;
  defaultDescription: string;
  userDescription: string | null;
};

type CategoriesPayload = {
  agentId: string;
  categories: CategoryRow[];
  enabledCategories: string[] | null;
  fetchedAt: string;
};

// TL.5 — read-only skills summary (install / import / enable still lives on
// the dedicated Skills tab). The shape mirrors what `/api/v1/agent/skills/agent/:id`
// returns — we keep the view liberal so future skill fields don't break this tab.
type EnabledSkill = {
  id: string;
  name?: string | null;
  category?: string | null;
  origin?: string | null;
  [key: string]: unknown;
};

type SkillsPayload = {
  skills: EnabledSkill[];
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
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method || "GET",
      headers: scopeHeaders(scope),
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const parsed = res.ok ? ((await res.json()) as T) : null;
    return { ok: res.ok, status: res.status, data: parsed };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function scopeFrom(request: Request, params: Record<string, string | undefined>) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  return { scope, agentId, organizationSlug, projectParam, envParam };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { scope, agentId, organizationSlug, projectParam, envParam } = await scopeFrom(request, params);
  const [mappings, agent, categories, skills] = await Promise.all([
    agentFetch<MappingsPayload>(
      `/api/v1/agent/agents/${agentId}/tool-mappings`,
      scope,
    ),
    // Pull current agent to read the full contextMapping + toolsBlockConfig
    // JSON (the mapping API returns a resolution-focused payload; we need
    // the raw JSON for round-trip edits so constants/_global/_auto don't get
    // clobbered). metaTools rides in the same response so the unified Tools
    // tab can toggle them without a separate endpoint.
    agentFetch<{
      id: string;
      name?: string;
      contextMapping?: Record<string, unknown> | null;
      toolsBlockConfig?: Record<string, unknown> | null;
      metaTools?: Record<string, boolean> | null;
      subAgentConfig?: Record<string, unknown> | null;
    }>(`/api/v1/agent/agents/${agentId}`, scope),
    // TL.3 — categories endpoint returns [{id, count, defaultDescription,
    // userDescription}] already merged + sorted. Orphan overrides (user
    // saved a description for a category that no longer appears in the
    // scoped matrix) show up with count=0 so the UI can clear them.
    agentFetch<CategoriesPayload>(
      `/api/v1/agent/agents/${agentId}/categories`,
      scope,
    ),
    // TL.5 — read-only skills summary. Install / import / enable / disable
    // still live in the dedicated Skills tab; we just surface the enabled
    // list here so operators see the full tool-layer picture in one place.
    agentFetch<SkillsPayload>(
      `/api/v1/agent/skills/agent/${agentId}`,
      scope,
    ),
  ]);
  return typedjson({
    reachable: mappings.ok && agent.ok,
    agentId,
    agentName: agent.data?.name ?? agentId,
    rawMapping: agent.data?.contextMapping ?? {},
    rawToolsBlockConfig: agent.data?.toolsBlockConfig ?? {},
    rawMetaTools: (agent.data?.metaTools ?? {}) as Record<string, boolean>,
    rawSubAgentConfig: (agent.data?.subAgentConfig ?? {}) as Record<string, unknown>,
    tools: mappings.data?.tools ?? [],
    declaredKeys: mappings.data?.declaredKeys ?? [],
    categories: categories.data?.categories ?? [],
    skills: skills.data?.skills ?? [],
    orgSlug: organizationSlug,
    projectSlug: projectParam,
    envSlug: envParam,
  });
}

const PatchMappingSchema = z.object({
  intent: z.literal("patch-mapping"),
  contextMapping: z.string(),
});

// TL.3 + TL.4 — the category editor and the pinned-tools picker both POST
// the full current toolsBlockConfig JSON (with their respective keys
// mutated). The action patches the whole block so pre-existing keys
// (displayMode, enabledCategories, etc.) are preserved.
const PatchToolsBlockConfigSchema = z.object({
  intent: z.literal("patch-tbc"),
  toolsBlockConfig: z.string(),
});

// TL.5 — meta-tool toggles landed on the agent's top-level `metaTools`
// record. The unified Tools tab posts the full record (checkboxes for
// every known key + any extras the server added) so the runtime sees a
// clean replacement rather than a partial merge.
const PatchMetaToolsSchema = z.object({
  intent: z.literal("patch-meta"),
  metaTools: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const { scope, agentId } = await scopeFrom(request, params);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "patch-mapping") {
    const parsed = PatchMappingSchema.safeParse({
      intent,
      contextMapping: formData.get("contextMapping"),
    });
    if (!parsed.success) {
      return typedjson({ error: "Invalid form" }, { status: 400 });
    }
    let mapping: unknown;
    try {
      mapping = JSON.parse(parsed.data.contextMapping);
    } catch {
      return typedjson({ error: "contextMapping must be valid JSON" }, { status: 400 });
    }
    const res = await agentFetch(
      `/api/v1/agent/agents/${agentId}`,
      scope,
      { method: "PATCH", body: { contextMapping: mapping } },
    );
    if (!res.ok) return typedjson({ error: "Patch failed" }, { status: res.status || 500 });
    return typedjson({ ok: true });
  }
  if (intent === "patch-tbc") {
    const parsed = PatchToolsBlockConfigSchema.safeParse({
      intent,
      toolsBlockConfig: formData.get("toolsBlockConfig"),
    });
    if (!parsed.success) {
      return typedjson({ error: "Invalid form" }, { status: 400 });
    }
    let tbc: unknown;
    try {
      tbc = JSON.parse(parsed.data.toolsBlockConfig);
    } catch {
      return typedjson({ error: "toolsBlockConfig must be valid JSON" }, { status: 400 });
    }
    const res = await agentFetch(
      `/api/v1/agent/agents/${agentId}`,
      scope,
      { method: "PATCH", body: { toolsBlockConfig: tbc } },
    );
    if (!res.ok) return typedjson({ error: "Patch failed" }, { status: res.status || 500 });
    return typedjson({ ok: true });
  }
  if (intent === "patch-meta") {
    const parsed = PatchMetaToolsSchema.safeParse({
      intent,
      metaTools: formData.get("metaTools"),
    });
    if (!parsed.success) {
      return typedjson({ error: "Invalid form" }, { status: 400 });
    }
    let meta: unknown;
    try {
      meta = JSON.parse(parsed.data.metaTools);
    } catch {
      return typedjson({ error: "metaTools must be valid JSON" }, { status: 400 });
    }
    const res = await agentFetch(
      `/api/v1/agent/agents/${agentId}`,
      scope,
      { method: "PATCH", body: { metaTools: meta } },
    );
    if (!res.ok) return typedjson({ error: "Patch failed" }, { status: res.status || 500 });
    return typedjson({ ok: true });
  }

  // PIFSP-8 — sub-agent config patch
  if (intent === "patch-subagent-config") {
    const raw = formData.get("subAgentConfig");
    let cfg: unknown;
    try {
      cfg = JSON.parse(raw as string);
    } catch {
      return typedjson({ error: "subAgentConfig must be valid JSON" }, { status: 400 });
    }
    const res = await agentFetch(
      `/api/v1/agent/agents/${agentId}`,
      scope,
      { method: "PATCH", body: { subAgentConfig: cfg } },
    );
    if (!res.ok) return typedjson({ error: "Patch failed" }, { status: res.status || 500 });
    return typedjson({ ok: true });
  }

  return typedjson({ error: "Unknown intent" }, { status: 400 });
}

// ─── UI helpers ────────────────────────────────────────────────────────────

const AUTO_SENTINEL = "__auto__";
const LLM_SENTINEL = "__llm__";
const CONSTANT_SENTINEL = "__constant__";
const CUSTOM_SENTINEL = "__custom__";

function resolutionLabel(r: ParamResolution): string {
  if (r.source === "constant") return `Constant: ${JSON.stringify(r.value)}`;
  if (r.source === "session") {
    if (r.reason === "auto") return `Auto: ${r.key}`;
    if (r.reason === "global") return `Global: ${r.key}`;
    return `Session: ${r.key}`;
  }
  return "LLM fills";
}

function isBlocked(row: ToolMappingRow): boolean {
  return row.params.some(
    (p) =>
      p.required &&
      p.resolution.source === "llm" &&
      (!(p.resolution as { description?: string }).description ||
        ((p.resolution as { description?: string }).description ?? "").trim().length === 0),
  );
}

export default function AgentToolsTab() {
  const {
    reachable,
    agentName,
    agentId,
    rawMapping,
    rawToolsBlockConfig,
    rawMetaTools,
    rawSubAgentConfig,
    tools,
    declaredKeys,
    categories,
    skills,
    orgSlug,
    projectSlug,
    envSlug,
  } = useTypedLoaderData<typeof loader>();
  const nav = useNavigation();
  const fetcher = useFetcher();
  const isSubmitting = nav.state !== "idle" || fetcher.state !== "idle";

  // Working copy of the raw mapping. Every per-param dropdown / declared-keys
  // edit mutates this state; Save button POSTs the full JSON so nested fields
  // outside the UI's control plane (promptVars, envelopeKeys, etc.) are
  // preserved untouched.
  const [draft, setDraft] = useState<Record<string, any>>(() => ({ ...rawMapping }));
  const [filter, setFilter] = useState<string>("all");
  const [entityFilter, setEntityFilter] = useState<string>("all");
  const entities = useMemo(() => {
    const s = new Set<string>();
    for (const t of tools) s.add(t.sourceEntity);
    return Array.from(s).sort();
  }, [tools]);

  const filteredTools = useMemo(() => {
    return tools.filter((t) => {
      if (entityFilter !== "all" && t.sourceEntity !== entityFilter) return false;
      if (filter === "blocked" && !isBlocked(t)) return false;
      if (filter === "unmapped" && t.mapped === t.total) return false;
      if (filter === "overrides") {
        const tai = draft?.toolArgInjection?.[t.toolName] as
          | Record<string, unknown>
          | undefined;
        const hasOverride = tai && Object.keys(tai).some((k) => k !== "_auto");
        if (!hasOverride) return false;
      }
      return true;
    });
  }, [tools, filter, entityFilter, draft]);

  function setParam(
    toolName: string,
    paramName: string,
    next: ParamResolution | null,
    customValue?: string,
  ) {
    setDraft((prev) => {
      const out = { ...prev } as Record<string, any>;
      out.toolArgInjection = { ...(out.toolArgInjection ?? {}) };
      out.constants = { ...(out.constants ?? {}) };
      const toolBlock = { ...(out.toolArgInjection[toolName] ?? {}) };
      const toolConst = { ...(out.constants[toolName] ?? {}) };

      // Clear prior binding for this (tool, param).
      delete toolBlock[paramName];
      delete toolConst[paramName];

      if (next == null || next.source === "llm") {
        // Explicit LLM marker tells the resolver "never auto-match this".
        toolBlock[paramName] = "LLM";
      } else if (next.source === "constant") {
        toolConst[paramName] = next.value ?? customValue ?? "";
      } else if (next.source === "session") {
        toolBlock[paramName] = customValue ?? next.key;
      }

      out.toolArgInjection[toolName] = toolBlock;
      if (Object.keys(toolConst).length > 0) out.constants[toolName] = toolConst;
      else delete out.constants[toolName];
      return out;
    });
  }

  function resetParam(toolName: string, paramName: string) {
    // "Reset to Auto" — drop both override + constant so the resolver falls
    // back through buckets 2→3→4.
    setDraft((prev) => {
      const out = { ...prev } as Record<string, any>;
      if (out.toolArgInjection?.[toolName]) {
        const block = { ...out.toolArgInjection[toolName] };
        delete block[paramName];
        if (Object.keys(block).length === 0) delete out.toolArgInjection[toolName];
        else out.toolArgInjection[toolName] = block;
      }
      if (out.constants?.[toolName]) {
        const block = { ...out.constants[toolName] };
        delete block[paramName];
        if (Object.keys(block).length === 0) delete out.constants[toolName];
        else out.constants[toolName] = block;
      }
      return out;
    });
  }

  function setDeclaredKeys(next: string[]) {
    setDraft((prev) => ({ ...prev, declaredKeys: next }));
  }

  const declaredFromDraft: string[] = Array.isArray(draft.declaredKeys)
    ? (draft.declaredKeys as unknown[]).filter((x): x is string => typeof x === "string")
    : declaredKeys;

  return (
    <PageBody>
        {!reachable ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4">
            <Paragraph>Agent service is unreachable. Refresh once it's back.</Paragraph>
          </div>
        ) : null}

        {/* Declared context keys panel */}
        <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
          <div className="flex items-center justify-between">
            <Header3>Declared session-context keys</Header3>
            <Badge variant="small">{declaredFromDraft.length}</Badge>
          </div>
          <Paragraph variant="small" className="mt-1 text-text-dimmed">
            Keys your frontend sends in <code>thread.sessionContext</code>. Drives
            the auto-match suggestion set ({`userId`} ⇄ {`user_id`} ⇄ {`user.id`}).
          </Paragraph>
          <DeclaredKeysEditor keys={declaredFromDraft} onChange={setDeclaredKeys} />
        </section>

        {/* CONSISTENCY (audit #5) — displayMode is what ACTUALLY governs tool
            inlining, but it had no control anywhere: the pinned-tools panel
            below even tells you to "set displayMode to hybrid" with no way to
            do it. This is its natural owner. */}
        <DisplayModePanel
          rawToolsBlockConfig={rawToolsBlockConfig as Record<string, unknown>}
        />

        {/* TL.3 — category descriptions editor */}
        <CategoryDescriptionsPanel
          categories={categories}
          rawToolsBlockConfig={rawToolsBlockConfig as Record<string, unknown>}
        />

        {/* TL.4 — hybrid pinned-tools picker */}
        <PinnedToolsPanel
          tools={tools}
          rawToolsBlockConfig={rawToolsBlockConfig as Record<string, unknown>}
        />

        {/* TL.5 — meta-tool toggles. Absorbs the old (broken) Meta Tools
            panel from the main agent editor. Saves through a dedicated
            PATCH path so the updateAgent DTO's `metaTools` field is the
            only source of truth. */}
        <MetaToolsPanel metaTools={rawMetaTools} />

        {/* TL.5 — read-only skills summary. Install / import / enable still
            lives on the dedicated Skills tab; this is just the list + link. */}
        <SkillsSummaryPanel
          skills={skills}
          agentId={agentId}
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          envSlug={envSlug}
        />

        {/* PIFSP-8 — Sub-agent configuration */}
        <SubAgentConfigPanel
          agentId={agentId}
          rawSubAgentConfig={rawSubAgentConfig}
        />

        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-text-dimmed">Filter:</label>
          {(["all", "auto-mapped", "overrides", "unmapped", "blocked"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded border px-2 py-1 text-xs ${
                filter === f
                  ? "border-text-bright bg-background text-text-bright"
                  : "border-grid-dimmed text-text-dimmed hover:text-text-bright"
              }`}
            >
              {f}
            </button>
          ))}
          <label className="ml-4 text-xs text-text-dimmed">Entity:</label>
          <select
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            className="rounded border border-grid-dimmed bg-background px-2 py-1 text-xs"
          >
            <option value="all">all</option>
            {entities.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <span className="ml-auto text-xs text-text-dimmed">
            {filteredTools.length} / {tools.length} tools
          </span>
        </div>

        {/* Save bar */}
        <Form method="post" className="mb-3 flex items-center gap-2">
          <input type="hidden" name="intent" value="patch-mapping" />
          <input
            type="hidden"
            name="contextMapping"
            value={JSON.stringify(draft)}
          />
          <Button variant="primary/small" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save mappings"}
          </Button>
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Changes are local until you save.
          </Paragraph>
        </Form>

        <div className="space-y-2">
          {filteredTools.map((t) => (
            <ToolRow
              key={`${t.sourceEntity}:${t.toolName}`}
              row={t}
              declaredKeys={declaredFromDraft}
              onSetParam={setParam}
              onResetParam={resetParam}
            />
          ))}
          {filteredTools.length === 0 ? (
            <Paragraph variant="small" className="text-text-dimmed">
              No tools match the current filter.
            </Paragraph>
          ) : null}
        </div>
    </PageBody>
  );
}

// TL.3 — panel that edits per-category descriptions inside the agent's
// `toolsBlockConfig.categoryDescriptions`. Textareas are PREFILLED with the
// user override if set, otherwise the hardcoded default so the operator
// sees the baseline the LLM gets today and can tweak inline. Clearing the
// textarea back to empty drops the override (blank reverts to default).
/**
 * CONSISTENCY (audit #5) — the displayMode control.
 *
 * `toolsBlockConfig.displayMode` is what ACTUALLY decides how much of the tool
 * layer the main LLM sees each turn (full schemas / summary / meta-tools only /
 * hybrid). It drove real runtime behaviour but was settable from NO screen —
 * the pinned-tools panel below literally instructs you to "set displayMode to
 * hybrid" with no control to do it, and the tool-call-method copy on the agent
 * editor wrongly claimed displayMode's behaviour for itself.
 *
 * Saves through the same `patch-tbc` intent as the other panels, spreading the
 * stored config so no sibling key is lost (and the backend now deep-merges too).
 */
function DisplayModePanel({
  rawToolsBlockConfig,
}: {
  rawToolsBlockConfig: Record<string, unknown>;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const stored = (rawToolsBlockConfig?.displayMode as string) ?? "full";
  const [mode, setMode] = useState(stored);
  const saving = fetcher.state !== "idle";
  const dirty = mode !== stored;

  const OPTIONS: Array<{ value: string; label: string; desc: string }> = [
    { value: "full", label: "Full", desc: "Every enabled tool's full schema is visible. Most capable, most tokens." },
    { value: "summary", label: "Summary", desc: "No tool schemas — meta-tools plus a category/count hint. Reach tools via find_tools." },
    { value: "meta-tool", label: "Meta-tools only", desc: "Pure discovery: meta-tools, no category hint. Fewest tokens." },
    { value: "hybrid", label: "Hybrid", desc: "Pinned tools in full, everything else via discovery. Set pinned tools below." },
  ];

  function save() {
    const nextTbc = { ...(rawToolsBlockConfig ?? {}), displayMode: mode };
    const fd = new FormData();
    fd.set("intent", "patch-tbc");
    fd.set("toolsBlockConfig", JSON.stringify(nextTbc));
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <div className="flex items-center gap-2">
        <Header3>Tool display mode</Header3>
        <Badge variant="small">{stored}</Badge>
      </div>
      <Paragraph variant="small" className="mt-1 mb-3">
        How much of the tool layer the agent sees each turn. This is the setting that
        controls schema inlining.
      </Paragraph>
      <div className="space-y-2">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-start gap-3 rounded border p-2.5 cursor-pointer ${
              mode === opt.value ? "border-emerald-500/60 bg-emerald-500/5" : "border-grid-dimmed"
            }`}
          >
            <input
              type="radio"
              name="displayMode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-0.5 accent-emerald-500"
            />
            <div>
              <p className="text-sm font-medium text-text-bright">{opt.label}</p>
              <p className="text-xs text-text-dimmed">{opt.desc}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="secondary/small" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save display mode"}
        </Button>
        {fetcher.data?.error ? (
          <span className="text-xs text-error">{fetcher.data.error}</span>
        ) : fetcher.data?.ok && !dirty ? (
          <span className="text-xs text-text-dimmed">Saved.</span>
        ) : null}
      </div>
    </section>
  );
}

function CategoryDescriptionsPanel({
  categories,
  rawToolsBlockConfig,
}: {
  categories: CategoryRow[];
  rawToolsBlockConfig: Record<string, unknown>;
}) {
  const fetcher = useFetcher();
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const c of categories) {
      out[c.id] =
        c.userDescription != null && c.userDescription.length > 0
          ? c.userDescription
          : c.defaultDescription;
    }
    return out;
  });
  const [open, setOpen] = useState<boolean>(categories.length > 0);

  const overrideCount = useMemo(() => {
    let n = 0;
    for (const c of categories) {
      const v = (draft[c.id] ?? "").trim();
      if (v.length > 0 && v !== c.defaultDescription) n++;
    }
    return n;
  }, [draft, categories]);

  function resetToDefault(id: string) {
    setDraft((p) => ({ ...p, [id]: categories.find((c) => c.id === id)?.defaultDescription ?? "" }));
  }

  function submit() {
    // Build the full toolsBlockConfig patch: merge existing config with a
    // fresh `categoryDescriptions`, keyed by category id. Blank values are
    // dropped so a cleared textarea removes the override entirely.
    const categoryDescriptions: Record<string, { description: string }> = {};
    for (const c of categories) {
      const v = (draft[c.id] ?? "").trim();
      if (v.length > 0 && v !== c.defaultDescription) {
        categoryDescriptions[c.id] = { description: v };
      }
    }
    const nextTbc = {
      ...(rawToolsBlockConfig ?? {}),
      categoryDescriptions,
    };
    const fd = new FormData();
    fd.set("intent", "patch-tbc");
    fd.set("toolsBlockConfig", JSON.stringify(nextTbc));
    fetcher.submit(fd, { method: "post" });
  }

  if (categories.length === 0) return null;
  const saving = fetcher.state !== "idle";
  return (
    <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3"
      >
        <div className="flex items-center gap-2">
          <Header3>Tool category descriptions</Header3>
          <Badge variant="small">{categories.length}</Badge>
          {overrideCount > 0 ? (
            <Badge variant="small">{overrideCount} overridden</Badge>
          ) : null}
        </div>
        <span className="text-xs text-text-dimmed">{open ? "hide" : "show"}</span>
      </button>
      <Paragraph variant="small" className="mt-1 text-text-dimmed">
        One-liners shown to the LLM beside each category in summary /
        hybrid display mode. Edit to tune how the model reasons about each
        bucket. Clear a field to revert to the default.
      </Paragraph>
      {open ? (
        <>
          <div className="mt-3 space-y-3">
            {categories.map((c) => {
              const current = draft[c.id] ?? "";
              const diverged = current.trim() !== c.defaultDescription.trim();
              return (
                <div key={c.id} className="grid grid-cols-[120px_1fr_auto] items-start gap-2">
                  <div className="pt-1">
                    <div className="text-xs font-medium">{c.id}</div>
                    <div className="text-[10px] text-text-dimmed">
                      {c.count} tool{c.count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <textarea
                    value={current}
                    onChange={(e) => setDraft((p) => ({ ...p, [c.id]: e.target.value }))}
                    rows={2}
                    className="w-full rounded border border-grid-dimmed bg-background px-2 py-1 text-xs"
                    placeholder={c.defaultDescription}
                  />
                  <button
                    type="button"
                    onClick={() => resetToDefault(c.id)}
                    disabled={!diverged}
                    className="rounded border border-grid-dimmed px-2 py-1 text-[10px] text-text-dimmed hover:text-text-bright disabled:opacity-40"
                  >
                    reset
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="primary/small"
              type="button"
              onClick={submit}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save category descriptions"}
            </Button>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Edits only take effect in display modes summary + hybrid.
            </Paragraph>
          </div>
        </>
      ) : null}
    </section>
  );
}

// TL.4 — hybrid pinned-tools picker. The agent's `toolsBlockConfig.pinnedTools`
// is a string[] of entity-tool names that the prompt-builder renders inline
// under the "Pinned tools: ..." line when displayMode === "hybrid". That
// bypasses the find_tools hop so the LLM knows it can call those tools
// directly via `execute_tools`. This panel lets the operator tick which tools
// are pinned, filter by entity, and save. Warning banner when displayMode is
// not set to hybrid (the array is still persisted but has no runtime effect).
function PinnedToolsPanel({
  tools,
  rawToolsBlockConfig,
}: {
  tools: ToolMappingRow[];
  rawToolsBlockConfig: Record<string, unknown>;
}) {
  const fetcher = useFetcher();
  const existingPinned = useMemo<string[]>(() => {
    const raw = (rawToolsBlockConfig as { pinnedTools?: unknown })?.pinnedTools;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string");
  }, [rawToolsBlockConfig]);
  const displayMode =
    typeof (rawToolsBlockConfig as { displayMode?: unknown })?.displayMode ===
    "string"
      ? ((rawToolsBlockConfig as { displayMode?: string }).displayMode ?? "full")
      : "full";
  const [draft, setDraft] = useState<Set<string>>(() => new Set(existingPinned));
  const [entityFilter, setEntityFilter] = useState<string>("all");
  const [query, setQuery] = useState<string>("");
  const [open, setOpen] = useState<boolean>(
    displayMode === "hybrid" || existingPinned.length > 0,
  );

  const entities = useMemo(() => {
    const s = new Set<string>();
    for (const t of tools) s.add(t.sourceEntity);
    return Array.from(s).sort();
  }, [tools]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (entityFilter !== "all" && t.sourceEntity !== entityFilter) return false;
      if (q.length > 0 && !t.toolName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tools, entityFilter, query]);

  function toggle(name: string) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function submit() {
    const pinnedTools = Array.from(draft).sort();
    const nextTbc = { ...(rawToolsBlockConfig ?? {}), pinnedTools };
    const fd = new FormData();
    fd.set("intent", "patch-tbc");
    fd.set("toolsBlockConfig", JSON.stringify(nextTbc));
    fetcher.submit(fd, { method: "post" });
  }

  if (tools.length === 0) return null;
  const saving = fetcher.state !== "idle";
  const isHybrid = displayMode === "hybrid";
  const dirty = (() => {
    if (draft.size !== existingPinned.length) return true;
    for (const n of existingPinned) if (!draft.has(n)) return true;
    return false;
  })();

  return (
    <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3"
      >
        <div className="flex items-center gap-2">
          <Header3>Pinned tools</Header3>
          <Badge variant="small">{draft.size}</Badge>
          {!isHybrid ? (
            <Badge variant="small">inactive (displayMode = {displayMode})</Badge>
          ) : null}
        </div>
        <span className="text-xs text-text-dimmed">{open ? "hide" : "show"}</span>
      </button>
      <Paragraph variant="small" className="mt-1 text-text-dimmed">
        Entity-tool names named directly in the prompt (under "Pinned
        tools:") when displayMode is <code>hybrid</code>. The LLM can call
        these via <code>execute_tools</code> without a <code>find_tools</code>
        hop. Use for the 3–6 tools an agent reaches for on most turns; leave
        everything else to the category summary.
      </Paragraph>
      {!isHybrid ? (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          displayMode is set to <code>{displayMode}</code>. Pinned tools are
          saved but not rendered into the system prompt until you switch
          displayMode to <code>hybrid</code>.
        </div>
      ) : null}
      {open ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs text-text-dimmed">Entity:</label>
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="rounded border border-grid-dimmed bg-background px-2 py-1 text-xs"
            >
              <option value="all">all</option>
              {entities.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter tools by name"
              className="h-7 w-56 text-xs"
            />
            <span className="ml-auto text-xs text-text-dimmed">
              {filtered.length} / {tools.length} tools
            </span>
          </div>
          <div className="mt-3 max-h-80 overflow-y-auto rounded border border-grid-dimmed">
            {filtered.map((t) => {
              const checked = draft.has(t.toolName);
              return (
                <label
                  key={`${t.sourceEntity}:${t.toolName}`}
                  className="flex items-center gap-2 border-b border-grid-dimmed px-3 py-1.5 text-xs last:border-b-0 hover:bg-background"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(t.toolName)}
                  />
                  <span className="font-medium">{t.toolName}</span>
                  <Badge variant="small">{t.sourceEntity}</Badge>
                  {!t.enabled ? <Badge variant="small">disabled</Badge> : null}
                </label>
              );
            })}
            {filtered.length === 0 ? (
              <div className="p-3 text-xs text-text-dimmed">
                No tools match the current filter.
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="primary/small"
              type="button"
              onClick={submit}
              disabled={saving || !dirty}
            >
              {saving ? "Saving..." : `Save ${draft.size} pinned tool${draft.size === 1 ? "" : "s"}`}
            </Button>
            {dirty ? (
              <Paragraph variant="extra-small" className="text-text-dimmed">
                Unsaved changes.
              </Paragraph>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

// TL.5 — meta-tool toggle panel. Reads the agent's current `metaTools`
// record and POSTs the full replacement object via `patch-meta`. Keys that
// the server surfaces (e.g. `find_tools`, `execute_tools`, `remember`) are
// shown even if their current value is false; new keys can't be added from
// here — they come from the agent bootstrap + server registry. This
// replaces the dead panel that used to live on the main agent editor
// (form fields were named `meta_*` but the action never parsed them).
function MetaToolsPanel({
  metaTools,
}: {
  metaTools: Record<string, boolean>;
}) {
  const fetcher = useFetcher();
  const keys = useMemo(
    () => Object.keys(metaTools ?? {}).sort((a, b) => a.localeCompare(b)),
    [metaTools],
  );
  const [draft, setDraft] = useState<Record<string, boolean>>(() => ({
    ...(metaTools ?? {}),
  }));
  const dirty = useMemo(() => {
    for (const k of keys) {
      if (!!draft[k] !== !!metaTools[k]) return true;
    }
    return false;
  }, [draft, metaTools, keys]);

  function toggle(key: string) {
    setDraft((p) => ({ ...p, [key]: !p[key] }));
  }
  function submit() {
    const fd = new FormData();
    fd.set("intent", "patch-meta");
    fd.set("metaTools", JSON.stringify(draft));
    fetcher.submit(fd, { method: "post" });
  }

  if (keys.length === 0) return null;
  const saving = fetcher.state !== "idle";
  const enabledCount = keys.filter((k) => draft[k]).length;

  return (
    <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <div className="flex items-center gap-2">
        <Header3>Meta-tools</Header3>
        <Badge variant="small">
          {enabledCount} / {keys.length}
        </Badge>
      </div>
      <Paragraph variant="small" className="mt-1 text-text-dimmed">
        Built-in Platos tools the LLM can always see (search / dispatch /
        memory / approvals / artifacts). Disable the ones this agent
        shouldn't reach for — the runtime skips them at turn build time.
      </Paragraph>
      <div className="mt-3 grid grid-cols-2 gap-1 md:grid-cols-3">
        {keys.map((k) => {
          const on = !!draft[k];
          return (
            <label
              key={k}
              className="flex cursor-pointer items-center gap-2 rounded border border-transparent px-2 py-1 text-xs hover:border-grid-dimmed"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(k)}
                className="accent-emerald-500"
              />
              <code className={on ? "text-text-bright" : "text-text-dimmed"}>
                {k}
              </code>
            </label>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary/small"
          type="button"
          onClick={submit}
          disabled={saving || !dirty}
        >
          {saving ? "Saving..." : "Save meta-tools"}
        </Button>
        {dirty ? (
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Unsaved changes.
          </Paragraph>
        ) : null}
      </div>
    </section>
  );
}

// TL.5 — read-only summary of the agent's enabled skills plus a link to
// the dedicated Skills tab for install / import / enable / disable flows.
// We intentionally do NOT rebuild the Skills-tab logic here — the unified
// Tools tab exists to give one-pane visibility; mutation happens on the
// PIFSP-8 — Sub-agent toolMode + prompt caching configuration.
function SubAgentConfigPanel({
  agentId,
  rawSubAgentConfig,
}: {
  agentId: string;
  rawSubAgentConfig: Record<string, unknown>;
}) {
  const fetcher = useFetcher();
  const toolMode = (rawSubAgentConfig?.toolMode as string | undefined) ?? "meta-tool";
  const promptCaching = rawSubAgentConfig?.promptCaching !== false; // default true

  const handleSave = (newToolMode: string, newPromptCaching: boolean) => {
    const fd = new FormData();
    fd.set("intent", "patch-subagent-config");
    fd.set("subAgentConfig", JSON.stringify({ ...rawSubAgentConfig, toolMode: newToolMode, promptCaching: newPromptCaching }));
    fetcher.submit(fd, { method: "POST" });
  };

  return (
    <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <Header3>Sub-agent configuration</Header3>
      <Paragraph variant="small" className="mt-1 mb-4 text-text-dimmed">
        When this agent operates in <strong>sub-agent</strong> mode (spawned by a parent), these settings control how it accesses tools and caches prompts.
      </Paragraph>

      <div className="flex flex-wrap gap-6">
        <div>
          <label className="text-xs font-medium text-text-dimmed block mb-1.5">Tool mode</label>
          <div className="flex gap-3">
            {(["meta-tool", "direct"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => handleSave(opt, promptCaching)}
                className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                  toolMode === opt
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                    : "border-charcoal-600 text-text-dimmed hover:border-charcoal-400"
                }`}
              >
                {opt === "meta-tool" ? "Meta-tool (find + execute)" : "Direct (full schemas)"}
              </button>
            ))}
          </div>
          <Paragraph variant="small" className="mt-1 text-text-dimmed">
            {toolMode === "direct" ? "Sub-agent sees full tool schemas — more context, higher token cost." : "Sub-agent uses find_tools + execute_tools — lower context, model must discover."}
          </Paragraph>
        </div>

        <div>
          <label className="text-xs font-medium text-text-dimmed block mb-1.5">Prompt caching</label>
          <button
            type="button"
            onClick={() => handleSave(toolMode, !promptCaching)}
            className={`rounded border px-3 py-1.5 text-xs transition-colors ${
              promptCaching
                ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                : "border-charcoal-600 text-text-dimmed hover:border-charcoal-400"
            }`}
          >
            {promptCaching ? "On (Layer 1 + Anthropic)" : "Off"}
          </button>
          <Paragraph variant="small" className="mt-1 text-text-dimmed">
            Layer 1: Redis memo (10-min TTL). Layer 2: Anthropic ephemeral cache (5-min window).
          </Paragraph>
        </div>
      </div>
    </section>
  );
}

// Skills tab so URL import + required-env checks stay in one place.
function SkillsSummaryPanel({
  skills,
  agentId,
  orgSlug,
  projectSlug,
  envSlug,
}: {
  skills: EnabledSkill[];
  agentId: string;
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}) {
  const manageHref = `/orgs/${orgSlug}/projects/${projectSlug}/env/${envSlug}/agents/${agentId}/skills`;
  return (
    <section className="mb-6 rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Header3>Skills</Header3>
          <Badge variant="small">{skills.length} enabled</Badge>
        </div>
        <a
          href={manageHref}
          className="text-xs text-text-dimmed hover:text-text-bright underline"
        >
          Manage skills →
        </a>
      </div>
      <Paragraph variant="small" className="mt-1 text-text-dimmed">
        Reusable behaviors (prompts + tools) the agent loads each turn.
        Install new ones, import from URL, or disable on the Skills tab.
      </Paragraph>
      {skills.length === 0 ? (
        <Paragraph variant="small" className="mt-3 text-text-dimmed">
          No skills enabled. Click <em>Manage skills</em> to add some.
        </Paragraph>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {skills.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 rounded-full border border-grid-dimmed bg-background px-2 py-0.5 text-xs"
            >
              <code>{s.name ?? s.id}</code>
              {s.category ? (
                <span className="text-text-dimmed">· {s.category}</span>
              ) : null}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function DeclaredKeysEditor({
  keys,
  onChange,
}: {
  keys: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {keys.map((k) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded-full border border-grid-dimmed bg-background px-2 py-0.5 text-xs"
        >
          <code>{k}</code>
          <button
            type="button"
            onClick={() => onChange(keys.filter((x) => x !== k))}
            aria-label={`remove ${k}`}
            className="text-text-dimmed hover:text-error"
          >
            <TrashIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <form
        className="inline-flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = input.trim();
          if (trimmed && !keys.includes(trimmed)) onChange([...keys, trimmed]);
          setInput("");
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="user.id"
          className="h-6 w-40 text-xs"
        />
        <button
          type="submit"
          className="inline-flex items-center gap-1 rounded border border-grid-dimmed px-2 py-0.5 text-xs text-text-dimmed hover:text-text-bright"
        >
          <PlusIcon className="h-3 w-3" /> add
        </button>
      </form>
    </div>
  );
}

function ToolRow({
  row,
  declaredKeys,
  onSetParam,
  onResetParam,
}: {
  row: ToolMappingRow;
  declaredKeys: string[];
  onSetParam: (
    tool: string,
    param: string,
    next: ParamResolution | null,
    customValue?: string,
  ) => void;
  onResetParam: (tool: string, param: string) => void;
}) {
  const [open, setOpen] = useState<boolean>(false);
  const blocked = isBlocked(row);
  const hasHealth = row.health && row.health !== "unknown";
  return (
    <div className="rounded-md border border-grid-dimmed bg-background-dimmed">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          <AdjustmentsHorizontalIcon className="h-4 w-4 text-text-dimmed" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{row.toolName}</span>
              <Badge variant="small">{row.sourceEntity}</Badge>
              {row.enabled ? null : <Badge variant="small">disabled</Badge>}
              {blocked ? (
                <span className="inline-flex items-center gap-1 rounded bg-error/20 px-1.5 py-0.5 text-xs text-error">
                  <XCircleIcon className="h-3 w-3" /> BLOCKED
                </span>
              ) : null}
            </div>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              {row.mapped}/{row.total} params mapped
              {hasHealth ? ` · health: ${row.health}` : ""}
            </Paragraph>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {row.warnings.length > 0 ? (
            <span title={row.warnings.join("\n")}>
              <ExclamationTriangleIcon className="h-4 w-4 text-warning" />
            </span>
          ) : (
            <CheckCircleIcon className="h-4 w-4 text-success" />
          )}
          <span className="text-text-dimmed">{open ? "▾" : "▸"}</span>
        </div>
      </button>
      {open ? (
        <div className="border-t border-grid-dimmed px-4 py-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-dimmed">
                <th className="pb-2">Param</th>
                <th className="pb-2">Current</th>
                <th className="pb-2">Source</th>
                <th className="pb-2">Custom</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {row.params.map((p) => (
                <ParamEditor
                  key={p.name}
                  toolName={row.toolName}
                  param={p}
                  declaredKeys={declaredKeys}
                  onSetParam={onSetParam}
                  onResetParam={onResetParam}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ParamEditor({
  toolName,
  param,
  declaredKeys,
  onSetParam,
  onResetParam,
}: {
  toolName: string;
  param: { name: string; resolution: ParamResolution; required: boolean };
  declaredKeys: string[];
  onSetParam: (
    tool: string,
    p: string,
    next: ParamResolution | null,
    customValue?: string,
  ) => void;
  onResetParam: (tool: string, p: string) => void;
}) {
  const current = param.resolution;
  const currentValue = (() => {
    if (current.source === "session" && current.reason === "auto") return AUTO_SENTINEL;
    if (current.source === "llm") return LLM_SENTINEL;
    if (current.source === "constant") return CONSTANT_SENTINEL;
    if (current.source === "session") {
      if (declaredKeys.includes(current.key)) return `key:${current.key}`;
      return CUSTOM_SENTINEL;
    }
    return AUTO_SENTINEL;
  })();
  const [mode, setMode] = useState<string>(currentValue);
  const [customKey, setCustomKey] = useState<string>(
    current.source === "session" ? current.key : "",
  );
  const [constantValue, setConstantValue] = useState<string>(
    current.source === "constant" ? JSON.stringify(current.value) : "",
  );

  function applyChange(nextMode: string) {
    setMode(nextMode);
    if (nextMode === AUTO_SENTINEL) {
      onResetParam(toolName, param.name);
      return;
    }
    if (nextMode === LLM_SENTINEL) {
      onSetParam(toolName, param.name, { source: "llm" });
      return;
    }
    if (nextMode === CONSTANT_SENTINEL) {
      let parsed: unknown = constantValue;
      try {
        parsed = JSON.parse(constantValue);
      } catch {
        // keep as string
      }
      onSetParam(toolName, param.name, { source: "constant", value: parsed });
      return;
    }
    if (nextMode.startsWith("key:")) {
      const key = nextMode.slice(4);
      onSetParam(toolName, param.name, {
        source: "session",
        key,
        reason: "override",
      });
      return;
    }
    if (nextMode === CUSTOM_SENTINEL) {
      // Wait for blur on the custom input.
      onSetParam(
        toolName,
        param.name,
        { source: "session", key: customKey || "", reason: "override" },
        customKey,
      );
    }
  }

  return (
    <tr className="border-t border-grid-dimmed/40">
      <td className="py-1.5 pr-3 align-top">
        <code>{param.name}</code>{" "}
        {param.required ? (
          <Badge variant="small">required</Badge>
        ) : null}
      </td>
      <td className="py-1.5 pr-3 align-top text-text-dimmed">
        {resolutionLabel(current)}
      </td>
      <td className="py-1.5 pr-3 align-top">
        <select
          value={mode}
          onChange={(e) => applyChange(e.target.value)}
          className="rounded border border-grid-dimmed bg-background px-2 py-1 text-xs"
        >
          <option value={AUTO_SENTINEL}>Auto ✓</option>
          <option value={LLM_SENTINEL}>LLM fills</option>
          <option value={CONSTANT_SENTINEL}>Constant…</option>
          {declaredKeys.map((k) => (
            <option key={k} value={`key:${k}`}>
              Session: {k}
            </option>
          ))}
          <option value={CUSTOM_SENTINEL}>Custom session key…</option>
        </select>
      </td>
      <td className="py-1.5 pr-3 align-top">
        {mode === CONSTANT_SENTINEL ? (
          <Input
            value={constantValue}
            placeholder='"value" or 42'
            onChange={(e) => setConstantValue(e.target.value)}
            onBlur={() => applyChange(CONSTANT_SENTINEL)}
            className="h-7 w-40 text-xs"
          />
        ) : mode === CUSTOM_SENTINEL ? (
          <Input
            value={customKey}
            placeholder="session.path.here"
            onChange={(e) => setCustomKey(e.target.value)}
            onBlur={() => applyChange(CUSTOM_SENTINEL)}
            className="h-7 w-40 text-xs"
          />
        ) : null}
      </td>
      <td className="py-1.5 align-top">
        {mode !== AUTO_SENTINEL ? (
          <button
            type="button"
            onClick={() => {
              setMode(AUTO_SENTINEL);
              onResetParam(toolName, param.name);
            }}
            className="text-xs text-text-dimmed hover:text-text-bright"
          >
            reset
          </button>
        ) : null}
      </td>
    </tr>
  );
}
