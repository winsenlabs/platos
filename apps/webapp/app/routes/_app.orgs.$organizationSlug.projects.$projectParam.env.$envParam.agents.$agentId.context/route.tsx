/**
 * PIFSP-7 — Context tab.
 *
 * Five sections:
 *   1. Dynamic Blocks — per-turn content blocks injected into <context>
 *   2. Prompt substitution variables (promptVars)
 *   3. Envelope keys (envelopeKeys) — forwarded in _context on every tool call
 *   4. Entity routing key (entityIdsKey) — narrows the tool matrix
 *   5. Tool argument injection (toolArgInjection) — 4-tier per-arg auto-fill
 *
 * Dynamic Blocks are the recommended home for user-specific / session-specific
 * content. They are NOT part of the cached system prompt — they go into the
 * <context> wrapper in the user message each turn, keeping the system prompt
 * fully static and Anthropic-cacheable.
 *
 * Persistence: contextMapping + dynamicBlocks saved directly via Prisma.
 */

import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { telemetry } from "~/services/telemetry.server";
import { useFetcher, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Prisma } from "@platos/database";
import { prisma } from "~/db.server";
import { PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { DynamicBlocksEditor } from "~/components/agents/DynamicBlocksEditor";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Context | Platos" }];

const ParamSchema = EnvironmentParamSchema.extend({ agentId: z.string() });

// ─── Types ────────────────────────────────────────────────────────────────────

type ContextMapping = {
  promptVars?: string[];
  envelopeKeys?: string[];
  entityIdsKey?: string;
  toolArgInjection?: Record<string, Record<string, string>>;
};

type DynamicBlock = {
  key: string;
  name: string;
  defaultContent: string;
  description?: string;
};

/**
 * PIFSP-19 — read-side defense. `dynamicBlocks` is an array column, but a
 * double-encoded write (a client sending `JSON.stringify(blocks)`) can land a
 * string scalar in the JSON column. A truthy string slips past `?? []` and the
 * editor then calls `.map` on it (`z.map is not a function`), crashing the
 * page. Parse-if-string, require-array, fall back to []. Belt to the write-path
 * braces in agent-crud.service.ts.
 */
function asBlockArray(raw: unknown): DynamicBlock[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as DynamicBlock[]) : [];
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const agentRow = await prisma.platosAgent.findFirst({
    where: {
      id: agentId,
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
    },
    select: { contextMapping: true, dynamicBlocks: true, name: true },
  });

  return typedjson({
    agentName: agentRow?.name ?? agentId,
    contextMapping: (agentRow?.contextMapping as ContextMapping | null) ?? null,
    dynamicBlocks: asBlockArray(agentRow?.dynamicBlocks),
    scope: {
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
    },
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const formData = await request.formData();

  const promptVarsRaw = String(formData.get("contextPromptVars") ?? "");
  const envelopeKeysRaw = String(formData.get("contextEnvelopeKeys") ?? "");
  const entityIdsKey = String(formData.get("contextEntityIdsKey") ?? "entity_ids").trim();
  const toolArgRaw = String(formData.get("contextToolArgInjectionJson") ?? "").trim();
  const dynamicBlocksRaw = String(formData.get("dynamicBlocksJson") ?? "[]").trim();

  const mapping: ContextMapping = {};

  const splitChips = (raw: string) => raw.split(",").map((s) => s.trim()).filter(Boolean);
  const promptVars = splitChips(promptVarsRaw);
  if (promptVars.length > 0) mapping.promptVars = promptVars;

  const envelopeKeys = splitChips(envelopeKeysRaw);
  if (envelopeKeys.length > 0) mapping.envelopeKeys = envelopeKeys;

  if (entityIdsKey && entityIdsKey !== "entity_ids") mapping.entityIdsKey = entityIdsKey;

  if (toolArgRaw.length > 0) {
    try {
      const parsed = JSON.parse(toolArgRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mapping.toolArgInjection = parsed as Record<string, Record<string, string>>;
      } else {
        return typedjson({ error: "toolArgInjection must be a JSON object" }, { status: 400 });
      }
    } catch (err) {
      return typedjson(
        { error: `toolArgInjection JSON parse failed: ${err instanceof Error ? err.message : "parse error"}` },
        { status: 400 },
      );
    }
  }

  // Parse dynamic blocks
  let dynamicBlocks: DynamicBlock[] = [];
  try {
    const parsed = JSON.parse(dynamicBlocksRaw);
    if (Array.isArray(parsed)) {
      dynamicBlocks = (parsed as unknown[]).filter(
        (b): b is DynamicBlock => !!b && typeof (b as any).key === "string" && !!(b as any).key && typeof (b as any).name === "string" && !!(b as any).name,
      );
    }
  } catch {
    return typedjson({ error: "dynamicBlocks JSON parse failed" }, { status: 400 });
  }

  const isEmpty = !mapping.promptVars && !mapping.envelopeKeys && !mapping.entityIdsKey && !mapping.toolArgInjection;

  try {
    const result = await prisma.platosAgent.updateMany({
      where: {
        id: agentId,
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
      },
      data: {
        contextMapping: isEmpty ? Prisma.JsonNull : (mapping as unknown as Prisma.InputJsonValue),
        dynamicBlocks: dynamicBlocks.length > 0
          ? (dynamicBlocks as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
    if (result.count === 0) {
      return typedjson({ error: "Agent not found in this scope" }, { status: 404 });
    }
    void telemetry.platos.agentUpdated({ organizationId: project.organizationId, agentId, field: "contextMapping" });
    return typedjson({ success: true, contextMapping: mapping });
  } catch (err) {
    return typedjson(
      { error: `Save failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 },
    );
  }
}

// ─── Preview helpers ──────────────────────────────────────────────────────────

function PreviewPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-charcoal-700 bg-charcoal-900 p-3 text-[11px] font-mono text-text-dimmed">
      {children}
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-5 space-y-4">
      <Header3>{title}</Header3>
      {children}
    </section>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AgentContextTab() {
  const { contextMapping, dynamicBlocks: savedBlocks } = useTypedLoaderData<typeof loader>();
  const ctxFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const isSaving = ctxFetcher.state !== "idle";

  // Section 1 — Dynamic Blocks
  const [dynamicBlocks, setDynamicBlocks] = useState<DynamicBlock[]>(
    Array.isArray(savedBlocks) ? savedBlocks : [],
  );

  // Section 2 — Prompt substitution variables
  const [promptVars, setPromptVars] = useState<string[]>(contextMapping?.promptVars ?? []);
  const [newPromptVar, setNewPromptVar] = useState("");

  // Section 3 — Envelope keys
  const [envelopeKeys, setEnvelopeKeys] = useState<string[]>(contextMapping?.envelopeKeys ?? []);
  const [newEnvelopeKey, setNewEnvelopeKey] = useState("");

  // Section 4 — Entity routing key
  const [entityIdsKey, setEntityIdsKey] = useState(contextMapping?.entityIdsKey ?? "entity_ids");

  // Section 5 — Tool arg injection
  const [toolArgJson, setToolArgJson] = useState(() => {
    const tai = contextMapping?.toolArgInjection;
    if (!tai || Object.keys(tai).length === 0) return "";
    return JSON.stringify(tai, null, 2);
  });

  const toolArgSummary = useMemo(() => {
    const raw = toolArgJson.trim();
    if (!raw) return { valid: true, message: "0 tools / 0 args mapped" };
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== "object" || Array.isArray(p)) return { valid: false, message: "must be a JSON object" };
      const tools = Object.keys(p).length;
      const args = Object.values(p as Record<string, Record<string, string>>).reduce(
        (acc, v) => acc + Object.keys(v).length, 0,
      );
      return { valid: true, message: `${tools} tool${tools !== 1 ? "s" : ""} / ${args} arg${args !== 1 ? "s" : ""} mapped` };
    } catch (e) {
      return { valid: false, message: e instanceof Error ? e.message : "parse failed" };
    }
  }, [toolArgJson]);

  // Prompt substitution preview — shows resolved value for a synthetic context
  const promptPreviewKey = promptVars[0] ?? "current_user.name";
  const promptPreviewValue = "Tejas";

  function addPromptVar() {
    const k = newPromptVar.trim();
    if (!k || promptVars.includes(k)) return;
    setPromptVars((p) => [...p, k]);
    setNewPromptVar("");
  }
  function addEnvelopeKey() {
    const k = newEnvelopeKey.trim();
    if (!k || envelopeKeys.includes(k)) return;
    setEnvelopeKeys((p) => [...p, k]);
    setNewEnvelopeKey("");
  }

  function handleSave() {
    const fd = new FormData();
    fd.set("dynamicBlocksJson", JSON.stringify(
      dynamicBlocks.filter((b) => b.key.trim() && b.name.trim()),
    ));
    fd.set("contextPromptVars", promptVars.join(","));
    fd.set("contextEnvelopeKeys", envelopeKeys.join(","));
    fd.set("contextEntityIdsKey", entityIdsKey);
    fd.set("contextToolArgInjectionJson", toolArgJson);
    ctxFetcher.submit(fd, { method: "post" });
  }

  return (
    <PageBody>
      {/* Sticky save bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-background-bright border-b border-charcoal-700 px-2 py-2 -mx-3 -mt-3 mb-4">
        <span className="text-xs text-text-dimmed">
          Context mapping — how session data flows into prompts and tool calls
        </span>
        <div className="flex items-center gap-3">
          {ctxFetcher.data?.success && (
            <span className="text-xs text-emerald-400">Saved.</span>
          )}
          {ctxFetcher.data?.error && (
            <span className="text-xs text-rose-400">{ctxFetcher.data.error}</span>
          )}
          <Button
            type="button"
            variant="primary/small"
            disabled={isSaving}
            onClick={handleSave}
          >
            {isSaving ? "Saving…" : "Save context"}
          </Button>
        </div>
      </div>

      <div className="max-w-3xl space-y-6">

        {/* ── Section 1: Dynamic Blocks ───────────────────────────── */}
        <SectionCard title="Dynamic blocks">
          <Paragraph variant="small">
            Dynamic blocks are <strong>per-turn content</strong> injected into a{" "}
            <code className="font-mono text-emerald-400">{"<context>"}</code> wrapper in the user
            message — NOT the system prompt. This means they are <strong>never cached</strong> by
            Anthropic and can safely contain session-specific data (current screen, user state,
            live metrics). Keep the system prompt fully static for maximum cache efficiency;
            put anything that changes per-turn here.
          </Paragraph>
          <Paragraph variant="small">
            Each block has a <strong>key</strong> (how your backend addresses it),{" "}
            a <strong>name</strong> (the heading the LLM sees), and a{" "}
            <strong>content template</strong> that can reference{" "}
            <code className="font-mono text-amber-300">{"{{session.context.keys}}"}</code>.
            In Postman mode, set those keys directly in the session context JSON to test
            substitution without a live backend.
          </Paragraph>

          <DynamicBlocksEditor blocks={dynamicBlocks} onChange={setDynamicBlocks} hideIntro />
        </SectionCard>

        {/* ── Section 2: Prompt substitution ──────────────────────── */}
        <SectionCard title="Prompt substitution variables">
          <Paragraph variant="small">
            When your backend sends context with each request (like{" "}
            <code className="font-mono text-amber-300">{"{ current_user: { name, role } }"}</code>),
            declare the dotted paths here and Platos substitutes them into your prompt using{" "}
            <code className="font-mono text-amber-300">{"{{path}}"}</code> syntax.{" "}
            Example: declare <code className="font-mono">current_user.name</code>, then write{" "}
            <code className="font-mono">{"Hello {{current_user.name}}"}</code> in any prompt block —
            the runtime replaces it with the actual value per turn. If a key isn&apos;t in session
            context at runtime, Platos replaces it with an empty string and logs a warning.
          </Paragraph>

          <div className="grid grid-cols-[1fr_auto] gap-4 items-start">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                {promptVars.length === 0 && (
                  <span className="text-xs italic text-text-dimmed">No variables declared.</span>
                )}
                {promptVars.map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300 font-mono"
                  >
                    {`{{${k}}}`}
                    <button type="button" onClick={() => setPromptVars((p) => p.filter((x) => x !== k))} className="hover:text-rose-400">
                      <TrashIcon className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  placeholder="e.g. current_user.name"
                  value={newPromptVar}
                  onChange={(e) => setNewPromptVar(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPromptVar(); } }}
                  className="flex-1 rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-text-bright font-mono"
                />
                <Button type="button" variant="tertiary/small" LeadingIcon={PlusIcon} onClick={addPromptVar}>
                  Add
                </Button>
              </div>
            </div>

            {/* Preview panel */}
            <div className="w-56 space-y-1">
              <p className="text-[10px] text-text-dimmed uppercase tracking-wider">Preview</p>
              <PreviewPane>
                <p className="text-text-dimmed">Prompt block:</p>
                <p className="text-amber-300">{`Hello {{${promptPreviewKey}}}`}</p>
                <p className="mt-2 text-text-dimmed">With {`{ ${promptPreviewKey}: "${promptPreviewValue}" }`}, LLM sees:</p>
                <p className="text-emerald-300">Hello {promptPreviewValue}</p>
              </PreviewPane>
            </div>
          </div>
        </SectionCard>

        {/* ── Section 3: Envelope keys ─────────────────────────────── */}
        <SectionCard title="Envelope keys">
          <Paragraph variant="small">
            When the agent calls a tool on your backend, Platos wraps the call with a{" "}
            <code className="font-mono text-amber-300">_context</code> envelope carrying the keys you
            list here. Use this for data your backend needs (like{" "}
            <code className="font-mono">tenantId</code>) but the LLM shouldn&apos;t know about.
            Envelope keys are forwarded as-is — the LLM never sees them.
          </Paragraph>

          <div className="grid grid-cols-[1fr_auto] gap-4 items-start">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                {envelopeKeys.length === 0 && (
                  <span className="text-xs italic text-text-dimmed">No envelope keys declared.</span>
                )}
                {envelopeKeys.map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-full border border-charcoal-600 px-2 py-0.5 text-xs text-text-bright font-mono"
                  >
                    {k}
                    <button type="button" onClick={() => setEnvelopeKeys((p) => p.filter((x) => x !== k))} className="hover:text-rose-400">
                      <TrashIcon className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  placeholder="e.g. tenant.id"
                  value={newEnvelopeKey}
                  onChange={(e) => setNewEnvelopeKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEnvelopeKey(); } }}
                  className="flex-1 rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-text-bright font-mono"
                />
                <Button type="button" variant="tertiary/small" LeadingIcon={PlusIcon} onClick={addEnvelopeKey}>
                  Add
                </Button>
              </div>
            </div>

            {/* Preview panel */}
            <div className="w-56 space-y-1">
              <p className="text-[10px] text-text-dimmed uppercase tracking-wider">Tool call frame</p>
              <PreviewPane>
                <p>{`{`}</p>
                <p className="ml-2">tool: <span className="text-amber-300">"send_email"</span>,</p>
                <p className="ml-2">args: {"{ ... }"},</p>
                <p className="ml-2">_context: {"{"}</p>
                <p className="ml-4">userId: <span className="text-emerald-300">"u123"</span>,</p>
                {envelopeKeys.slice(0, 3).map((k) => (
                  <p key={k} className="ml-4">
                    <span className="text-amber-300">{k}</span>: <span className="text-text-dimmed">"…"</span>,
                  </p>
                ))}
                {envelopeKeys.length === 0 && (
                  <p className="ml-4 italic text-text-dimmed">{"// no envelope keys"}</p>
                )}
                <p className="ml-2">{"}"}</p>
                <p>{"}"}</p>
              </PreviewPane>
            </div>
          </div>
        </SectionCard>

        {/* ── Section 4: Entity routing ────────────────────────────── */}
        <SectionCard title="Entity routing key">
          <Paragraph variant="small">
            When your agent is connected to multiple backend entities (e.g., FanDesk + HR + CRM),
            tell Platos where to find the list of entity IDs this request should route to. Your
            backend sends <code className="font-mono text-amber-300">sessionContext.entity_ids: ["fandesk-main"]</code>{" "}
            with every request; Platos narrows the tool matrix to only those entities. The default key
            is <code className="font-mono">entity_ids</code> — only change it if your backend already
            uses a different field name.
          </Paragraph>

          <div className="grid grid-cols-[1fr_auto] gap-4 items-start">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-dimmed font-medium w-32 flex-shrink-0">
                  Session context key
                </label>
                <input
                  value={entityIdsKey}
                  onChange={(e) => setEntityIdsKey(e.target.value)}
                  placeholder="entity_ids"
                  className="flex-1 rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-text-bright font-mono"
                />
              </div>
              <p className="text-[11px] text-text-dimmed">
                If missing from session context the turn uses the full tool matrix (no narrowing).
                PIFSP-11 makes this mandatory for agents with multiple entities.
              </p>
            </div>

            {/* Preview panel */}
            <div className="w-56 space-y-1">
              <p className="text-[10px] text-text-dimmed uppercase tracking-wider">Narrowing example</p>
              <PreviewPane>
                <p className="text-text-dimmed">sessionContext:</p>
                <p className="ml-2">
                  <span className="text-amber-300">{entityIdsKey || "entity_ids"}</span>:{" "}
                  <span className="text-emerald-300">["fandesk-main"]</span>
                </p>
                <p className="mt-2 text-text-dimmed">Tool matrix narrows to:</p>
                <p className="ml-2 text-emerald-300">fandesk-main tools only</p>
                <p className="ml-2 text-text-dimmed">← hr-system hidden</p>
                <p className="ml-2 text-text-dimmed">← crm-prod hidden</p>
              </PreviewPane>
            </div>
          </div>
        </SectionCard>

        {/* ── Section 5: Tool argument injection ───────────────────── */}
        <SectionCard title="Tool argument injection">
          <Paragraph variant="small">
            For each tool, Platos can auto-fill arguments from session context instead of letting the
            LLM guess. Priority order: <strong>Constant</strong> (hardcoded value) →{" "}
            <strong>Session override</strong> (pulled from session context by path) →{" "}
            <strong>Auto-match</strong> (name alias) → <strong>LLM fills</strong>. Arguments injected
            by constant or session override are stripped from the schema the LLM sees — saves tokens
            and prevents hallucination. Example: always pass{" "}
            <code className="font-mono text-amber-300">{'"userId": "user.id"'}</code> for{" "}
            <code className="font-mono">get_schedule</code> — the LLM never needs to know it exists.
          </Paragraph>

          <div className="grid grid-cols-[1fr_auto] gap-4 items-start">
            <div className="space-y-2">
              <textarea
                rows={8}
                value={toolArgJson}
                onChange={(e) => setToolArgJson(e.target.value)}
                placeholder={`{\n  "get_schedule": { "userId": "user.id" },\n  "create_task": { "ownerId": "user.id", "tenantId": "tenant.id" }\n}`}
                spellCheck={false}
                className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-2 text-xs text-text-bright font-mono resize-y"
              />
              <p className={`text-[11px] ${toolArgSummary.valid ? "text-emerald-400" : "text-rose-400"}`}>
                {toolArgSummary.valid ? "✓ " : "✗ "}
                {toolArgSummary.message}
              </p>
            </div>

            {/* Preview panel */}
            <div className="w-56 space-y-1">
              <p className="text-[10px] text-text-dimmed uppercase tracking-wider">Schema diff</p>
              <PreviewPane>
                <p className="text-text-dimmed">Original schema:</p>
                <p className="ml-2 text-text-bright">{"{ to, from, subject, body }"}</p>
                <p className="mt-2 text-text-dimmed">LLM-visible (from hidden):</p>
                <p className="ml-2 text-emerald-300">{"{ to, subject, body }"}</p>
                <p className="mt-2 text-text-dimmed">Injected at dispatch:</p>
                <p className="ml-2 text-amber-300">from ← sessionCtx.user.email</p>
              </PreviewPane>
            </div>
          </div>
        </SectionCard>

      </div>
    </PageBody>
  );
}
