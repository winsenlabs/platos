/**
 * PIFSP-5 — Agent creation wizard (4-step linear flow).
 *
 * Steps:
 *   1. Identity  — name, provider, model, optional slug
 *   2. Prompt    — 5 prompt-block cards + declared-variables pill list
 *   3. Dynamic   — context limit, history mode, compact threshold,
 *                  user profiling, memory settings, extraction policy.
 *                  Bug fix: Next advances even when memory toggles are on.
 *   4. Tool-call method — direct / sub-agent / execute-tool + live prompt preview.
 *                  Create button submits.
 *
 * Tools config is NOT part of the wizard — belongs on agent detail.
 * Post-create redirect → agent detail Basic configuration tab.
 */

import { CpuChipIcon } from "@heroicons/react/20/solid";
import {
  Form,
  useActionData,
  useNavigation,
  type MetaFunction,
} from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ModelPicker, type ProviderForPicker } from "~/components/agents/ModelPicker";
import { ModelRoutesEditor } from "~/components/agents/ModelRoutesEditor";
import { PromptBlockEditor } from "~/components/agents/PromptBlockEditor";
import { DynamicBlocksEditor, type DynamicBlock } from "~/components/agents/DynamicBlocksEditor";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "New Agent | Platos" }];

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  let providers: ProviderForPicker[] = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/providers`, {
        headers: scopeHeaders(scope),
      });
      if (res.ok) {
        const payload = (await res.json()) as { providers?: ProviderForPicker[] };
        providers = payload.providers ?? [];
      }
    }
  } catch {}

  let defaultBlocks: unknown[] = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/prompt/defaults`, {
        headers: scopeHeaders(scope),
      });
      if (res.ok) {
        const data = (await res.json()) as { blocks?: unknown[] };
        defaultBlocks = data.blocks ?? [];
      }
    }
  } catch {}

  const providersPath = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  )}/agent-providers`;

  let providerKeys: Array<{ id: string; provider: string; label: string; envVarName: string }> = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const pkRes = await fetch(`${AGENT_API_URL}/api/v1/agent/providers/keys`, { headers: scopeHeaders(scope) });
      if (pkRes.ok) { const pkData = (await pkRes.json()) as { keys?: typeof providerKeys }; providerKeys = pkData.keys ?? []; }
    }
  } catch {}

  return typedjson({ providers, providersPath, defaultBlocks, providerKeys });
}

// ─── Action (unchanged from old form — all fields submitted on step 4 Create) ──

export async function action({ request, params }: ActionFunctionArgs) {
  const t0 = Date.now();
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
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

  const name = formData.get("name") as string;
  const model = formData.get("model") as string;
  const modelRoutesRaw = formData.get("modelRoutes") as string | null;
  let modelRoutes: any[] | undefined;
  if (modelRoutesRaw) { try { const parsed = JSON.parse(modelRoutesRaw); if (Array.isArray(parsed)) modelRoutes = parsed as any[]; } catch { /* ignore */ } }
  const systemPrompt = formData.get("systemPrompt") as string;
  const systemPromptBlocksRaw = formData.get("systemPromptBlocks") as string | null;
  const toolsBlockMode = (formData.get("toolsBlockMode") as string) || "direct";
  const maxSteps = parseInt(String(formData.get("maxSteps") || "20"), 10);

  const contextLimitRaw = formData.get("contextLimit") as string | null;
  const historyMode = (formData.get("historyMode") as string | null) || "rolling";
  const compactThresholdRaw = formData.get("compactThreshold") as string | null;
  const executionMode = formData.get("executionMode") as string | null;
  const enableUserProfiling = formData.get("enableUserProfiling") === "on";
  const enableSemanticMemory = formData.get("enableSemanticMemory") === "on";
  const enableKnowledgeGraph = formData.get("enableKnowledgeGraph") === "on";

  const subAgentModel = formData.get("subAgentModel") as string | null;
  const subAgentMaxStepsRaw = formData.get("subAgentMaxSteps") as string | null;
  const subAgentSystemPrompt = formData.get("subAgentSystemPrompt") as string | null;

  const dynamicBlocksJson = formData.get("dynamicBlocksJson") as string | null;

  let promptBlocks: unknown = undefined;
  if (systemPromptBlocksRaw) {
    try { promptBlocks = JSON.parse(systemPromptBlocksRaw); } catch {}
  }

  let dynamicBlocks: unknown[] = [];
  if (dynamicBlocksJson) {
    try { dynamicBlocks = JSON.parse(dynamicBlocksJson) as unknown[]; } catch {}
  }

  const toolsBlockConfig = {
    mode: toolsBlockMode,
    enabledTools: [] as string[],
    perToolPerms: {} as Record<string, unknown>,
  };
  const subAgentConfig =
    toolsBlockMode === "sub-agent"
      ? {
          model: subAgentModel || "anthropic:claude-haiku-4-5-20251001",
          maxSteps: subAgentMaxStepsRaw ? parseInt(subAgentMaxStepsRaw, 10) : 10,
          systemPrompt: subAgentSystemPrompt || undefined,
        }
      : undefined;

  const contextLimit = contextLimitRaw ? parseInt(contextLimitRaw, 10) : 20;
  const compactThreshold = compactThresholdRaw ? parseInt(compactThresholdRaw, 10) : 40;

  const extractEnabledRaw = formData.get("extract_enabled");
  const extractionPolicy =
    extractEnabledRaw !== null
      ? {
          enabled: extractEnabledRaw === "on",
          kinds:
            formData.getAll("extract_kind").map((v) => String(v)).length > 0
              ? formData.getAll("extract_kind").map((v) => String(v))
              : ["fact", "preference", "event", "relationship"],
          confidenceThreshold: formData.get("extract_confidenceThreshold")
            ? Number.parseFloat(String(formData.get("extract_confidenceThreshold")))
            : 0.6,
          maxPerSession: formData.get("extract_maxPerSession")
            ? Number.parseInt(String(formData.get("extract_maxPerSession")), 10)
            : 10,
          minMessagesBeforeRun: formData.get("extract_minMessagesBeforeRun")
            ? Number.parseInt(String(formData.get("extract_minMessagesBeforeRun")), 10)
            : 6,
        }
      : undefined;

  // When ModelRoutesEditor is used, `model` comes from the default route inside
  // `modelRoutes`; fall back gracefully when a bare `model` field is missing.
  const effectiveModel = model || (modelRoutes && modelRoutes.length > 0 ? modelRoutes.find((r: any) => r.isDefault)?.model ?? modelRoutes[0]?.model : undefined);
  if (!name || !effectiveModel) {
    return typedjson({ error: "Name and model are required" }, { status: 400 });
  }

  try {
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/agents`, {
      method: "POST",
      headers: scopeHeaders(scope),
      body: JSON.stringify({
        name,
        model: effectiveModel,
        systemPrompt,
        promptBlocks,
        maxSteps,
        toolsBlockConfig,
        subAgentConfig,
        contextLimit,
        historyMode,
        compactThreshold,
        enableUserProfiling,
        enableSemanticMemory,
        enableKnowledgeGraph,
        executionMode: executionMode || "direct",
        dynamicBlocks,
        ...(extractionPolicy ? { extractionPolicy } : {}),
        ...(modelRoutes ? { modelRoutes } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const error = await res.text();
      return typedjson({ error }, { status: res.status });
    }

    const agent = (await res.json()) as { id: string };
    console.log(`[agents.new] created ${agent.id} in ${Date.now() - t0}ms`);

    // PIFSP-5: Redirect to agent detail Basic configuration tab (not tools page).
    return redirect(
      `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/agents/${agent.id}`,
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return typedjson({ error: `Failed to create agent: ${msg}` }, { status: 500 });
  }
}

// ─── Wizard types ─────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4;

const STEPS: { step: WizardStep; label: string }[] = [
  { step: 1, label: "Identity" },
  { step: 2, label: "Prompt" },
  { step: 3, label: "Behavior" },
  { step: 4, label: "Tool-call method" },
];

// ─── Prompt preview ───────────────────────────────────────────────────────────

function buildPromptPreview(
  agentName: string,
  toolMode: string,
  userProfiling: boolean,
  blocks: unknown[],
): string {
  const lines: string[] = [];

  // Assembled blocks (simplified preview — just type labels).
  const typedBlocks = blocks as Array<{ type?: string; content?: string; enabled?: boolean }>;
  const enabledBlocks = typedBlocks.filter((b) => b.enabled !== false);
  if (enabledBlocks.length > 0) {
    for (const b of enabledBlocks) {
      const preview = (b.content ?? "").slice(0, 120).replace(/{{agent_name}}/g, agentName || "<agent>");
      lines.push(`[${b.type ?? "block"}] ${preview}${(b.content ?? "").length > 120 ? "…" : ""}`);
      lines.push("");
    }
  }

  // Memory guidance block (injected when profiling is on).
  if (userProfiling) {
    lines.push("[memory-guidance] You have access to a user memory system:");
    lines.push("  • update_user_profile — store facts about this user");
    lines.push("  • recall_user_profile — retrieve stored facts");
    lines.push("");
  }

  // Tool-call method block.
  switch (toolMode) {
    case "sub-agent":
      lines.push("[tools — sub-agent] You have a sub-agent available via delegate_to_sub_agent.");
      lines.push("Use find_tools to discover capabilities, then delegate.");
      break;
    case "execute-tool":
      lines.push("[tools — execute-tool] Use find_tools to search, then execute_tools to call.");
      lines.push("Tool schemas are NOT inlined — query by category or name.");
      break;
    default:
      lines.push("[tools — direct] Tools available:");
      lines.push("  [tool schemas will be inlined here based on linked entities + entity_ids routing]");
      break;
  }

  return lines.join("\n");
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewAgentPage() {
  const { providers, providersPath, defaultBlocks, providerKeys } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Wizard state.
  const [step, setStep] = useState<WizardStep>(1);

  // Step 1.
  const [agentName, setAgentName] = useState("");
  // Lifted from ModelRoutesEditor so the model survives step 1 unmounting.
  // Submitted as `modelRoutes` (+ a derived `model`) via hidden fields at step 4;
  // the action derives the default model from the routes.
  const [modelRoutes, setModelRoutes] = useState<any[]>([]);

  // Step 2.
  const [blocks, setBlocks] = useState(defaultBlocks || []);
  // Full dynamic (per-turn) blocks — same editor + shape as the Context tab, so
  // everything editable post-creation is also configurable at creation.
  const [dynamicBlocks, setDynamicBlocks] = useState<DynamicBlock[]>([]);

  // Step 3.
  const [contextLimit, setContextLimit] = useState(20);
  const [historyMode, setHistoryMode] = useState<"rolling" | "compact">("rolling");
  const [compactThreshold, setCompactThreshold] = useState(40);
  const [userProfiling, setUserProfiling] = useState(false);
  const [semanticMemory, setSemanticMemory] = useState(true);
  const [knowledgeGraph, setKnowledgeGraph] = useState(false);
  const [extractEnabled, setExtractEnabled] = useState(true);
  const [extractKinds, setExtractKinds] = useState(["fact", "preference", "event", "relationship"]);
  const [extractConfidence, setExtractConfidence] = useState(0.6);
  const [extractMax, setExtractMax] = useState(10);
  const [executionMode, setExecutionMode] = useState<"direct" | "durable">("direct");

  // Step 4.
  const [toolMode, setToolMode] = useState<"direct" | "sub-agent" | "execute-tool">("direct");

  const promptPreview = buildPromptPreview(agentName, toolMode, userProfiling, blocks as unknown[]);

  function canAdvance(s: WizardStep): boolean {
    // Step 1: only require agent name — model routes are configured via
    // ModelRoutesEditor (which posts `modelRoutes` JSON) so `model` state is
    // no longer a gate. The server validates that at least a default route is set.
    if (s === 1) return agentName.trim().length > 0;
    // Steps 2, 3, 4 always advanceable — PIFSP-5 bug fix: previously
    // memory toggles caused a silent validation failure. No per-step
    // validation beyond step 1.
    return true;
  }

  function advance() {
    if (!canAdvance(step)) return;
    setStep((prev) => Math.min(prev + 1, 4) as WizardStep);
  }

  function back() {
    setStep((prev) => Math.max(prev - 1, 1) as WizardStep);
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Create Agent" icon={<CpuChipIcon className="size-5 text-emerald-500" />} />
        <PageAccessories>
          <DocsLink slug="create-first-agent" kind="guides" label="Guide" />
        </PageAccessories>
      </NavBar>

      <PageBody>
        <div className="max-w-2xl">
          {/* Progress bar */}
          <div className="flex items-center gap-0 mb-8">
            {STEPS.map(({ step: s, label }) => (
              <div key={s} className="flex items-center flex-1 last:flex-none">
                <button
                  type="button"
                  onClick={() => s < step && setStep(s)}
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    s === step
                      ? "text-emerald-400"
                      : s < step
                      ? "text-text-bright cursor-pointer"
                      : "text-text-dimmed cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full text-[10px] border ${
                      s === step
                        ? "border-emerald-400 text-emerald-400"
                        : s < step
                        ? "border-text-bright bg-text-bright text-charcoal-900"
                        : "border-charcoal-600 text-charcoal-600"
                    }`}
                  >
                    {s < step ? "✓" : s}
                  </span>
                  {label}
                </button>
                {s < 4 && (
                  <div
                    className={`flex-1 h-px mx-2 ${s < step ? "bg-text-bright" : "bg-charcoal-700"}`}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Error from action */}
          {actionData?.error && (
            <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3">
              <p className="text-sm text-rose-400">{actionData.error}</p>
            </div>
          )}

          {/* ── Step 1: Identity ─────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-base font-semibold text-text-bright mb-0.5">Identity</h2>
                <Paragraph variant="small">Name this agent and choose the model that powers it.</Paragraph>
              </div>

              <section>
                <Header3>Agent Name</Header3>
                <Paragraph variant="small" className="mt-1 mb-2">
                  Appears in the dashboard, logs, and chat header.
                </Paragraph>
                <Fieldset>
                  <Input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="e.g., Support Bot, Research Assistant, Sales Copilot"
                    autoFocus
                  />
                </Fieldset>
              </section>

              <section>
                <Header3>Model</Header3>
                <Paragraph variant="small" className="mt-1 mb-2">
                  Only providers with env vars set and enabled on the Providers page are shown.
                </Paragraph>
                <ModelRoutesEditor
                  name="modelRoutes"
                  // Re-seed from the lifted state so returning to step 1 (the editor
                  // fully unmounts on step change) restores the picked model instead
                  // of resetting to the provider default. seed() prefers non-empty
                  // initialRoutes; it only runs in the mount initializer, so passing
                  // this while mounted is a no-op (no feedback loop).
                  initialRoutes={modelRoutes.length > 0 ? modelRoutes : undefined}
                  providers={providers}
                  providerKeys={providerKeys.map(k => ({ id: k.id, label: k.label, provider: k.provider, envVarName: k.envVarName }))}
                  providersPath={providersPath}
                  onChange={setModelRoutes}
                />
                {providers.length === 0 && (
                  <p className="mt-2 text-xs text-amber-300">
                    No providers linked yet.{" "}
                    <a href={providersPath} className="underline">
                      Link a provider first →
                    </a>
                  </p>
                )}
              </section>

              <div className="flex justify-end pt-2">
                <Button
                  type="button"
                  variant="primary/medium"
                  onClick={advance}
                  disabled={!canAdvance(1)}
                >
                  Next: Prompt →
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 2: Prompt ───────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-base font-semibold text-text-bright mb-0.5">Prompt</h2>
                <Paragraph variant="small">
                  Compose the system prompt from toggleable blocks. Declare template variables for
                  runtime injection.
                </Paragraph>
              </div>

              <PromptBlockEditor blocks={blocks as any[]} onChange={setBlocks} />

              {/* Dynamic (per-turn) blocks — full editor, same as the Context tab */}
              <section>
                <Header3>Dynamic blocks</Header3>
                <Paragraph variant="small" className="mt-1 mb-3">
                  Per-turn content injected into a{" "}
                  <code className="font-mono text-emerald-400">{"<context>"}</code> wrapper in the
                  user message (never cached). Configure the same blocks you can edit later on the
                  agent's Context tab.
                </Paragraph>
                <DynamicBlocksEditor blocks={dynamicBlocks} onChange={setDynamicBlocks} hideIntro />
              </section>

              <div className="flex justify-between pt-2">
                <Button type="button" variant="tertiary/medium" onClick={back}>
                  ← Back
                </Button>
                <Button type="button" variant="primary/medium" onClick={advance}>
                  Next: Behavior →
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 3: Dynamic behavior ─────────────────────────── */}
          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-base font-semibold text-text-bright mb-0.5">Dynamic behavior</h2>
                <Paragraph variant="small">
                  Context + history, user profiling, and memory extraction settings. These apply at
                  runtime — not cached in the agent config.
                </Paragraph>
              </div>

              {/* Conversation context */}
              <section>
                <Header3>Conversation context</Header3>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">
                      Context limit (messages) — {contextLimit}
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={50}
                      value={contextLimit}
                      onChange={(e) => setContextLimit(Number(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                    <span className="text-xs text-text-dimmed">Prior turns loaded per message</span>
                  </Fieldset>
                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">History mode</label>
                    <div className="flex gap-2 mt-1">
                      {(["rolling", "compact"] as const).map((m) => (
                        <label key={m} className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <input
                            type="radio"
                            checked={historyMode === m}
                            onChange={() => setHistoryMode(m)}
                            className="accent-emerald-500"
                          />
                          <span className="capitalize text-text-bright">{m}</span>
                        </label>
                      ))}
                    </div>
                  </Fieldset>
                </div>
                {historyMode === "compact" && (
                  <Fieldset className="mt-3">
                    <label className="text-xs text-text-dimmed font-medium">
                      Compact threshold — {compactThreshold}
                    </label>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={compactThreshold}
                      onChange={(e) => setCompactThreshold(Number(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                  </Fieldset>
                )}
              </section>

              {/* Turn execution (executionMode: in-process vs durable) */}
              <section>
                <Header3>Turn execution</Header3>
                <Paragraph variant="small" className="mt-1 mb-3">
                  How this agent's turns are executed.
                </Paragraph>
                <div className="space-y-2">
                  {(
                    [
                      {
                        value: "direct",
                        label: "In-process (streamed)",
                        desc: "Runs in-process, streamed live.",
                      },
                      {
                        value: "durable",
                        label: "Durable (Trigger.dev)",
                        desc: "Runs as a Trigger.dev run — survives restarts/redeploys and can suspend for human approval.",
                      },
                    ] as const
                  ).map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-3 rounded border p-3 cursor-pointer ${
                        executionMode === opt.value
                          ? "border-emerald-500/60 bg-emerald-500/5"
                          : "border-charcoal-700 hover:border-charcoal-600"
                      }`}
                    >
                      <input
                        type="radio"
                        name="executionModeChoice"
                        value={opt.value}
                        checked={executionMode === opt.value}
                        onChange={() => setExecutionMode(opt.value)}
                        className="mt-0.5 accent-emerald-500"
                      />
                      <div>
                        <p className="text-sm font-medium text-text-bright">{opt.label}</p>
                        <p className="text-xs text-text-dimmed">{opt.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </section>

              {/* User profiling + memory */}
              <section>
                <Header3>Memory</Header3>
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer text-text-bright">
                    <input
                      type="checkbox"
                      checked={userProfiling}
                      onChange={(e) => setUserProfiling(e.target.checked)}
                      className="accent-emerald-500"
                    />
                    Enable user profiling
                    <span className="text-xs text-text-dimmed">(update_user_profile / recall_user_profile tools)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer text-text-bright">
                    <input
                      type="checkbox"
                      checked={semanticMemory}
                      onChange={(e) => setSemanticMemory(e.target.checked)}
                      className="accent-emerald-500"
                    />
                    Semantic memory
                    <span className="text-xs text-text-dimmed">(vector similarity recall)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer text-text-bright">
                    <input
                      type="checkbox"
                      checked={knowledgeGraph}
                      onChange={(e) => setKnowledgeGraph(e.target.checked)}
                      className="accent-emerald-500"
                    />
                    Knowledge graph
                    <span className="text-xs text-text-dimmed">(entity relationships)</span>
                  </label>
                </div>
              </section>

              {/* Memory extraction */}
              <section>
                <details>
                  <summary className="cursor-pointer select-none">
                    <Header3 className="inline">Memory extraction</Header3>
                    <span className="ml-2 text-xs text-text-dimmed">(background pass)</span>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer text-text-bright">
                      <input
                        type="checkbox"
                        checked={extractEnabled}
                        onChange={(e) => setExtractEnabled(e.target.checked)}
                        className="accent-amber-500"
                      />
                      Enable automatic extraction
                    </label>
                    {extractEnabled && (
                      <>
                        <div className="flex flex-wrap gap-3 text-sm">
                          {["fact", "preference", "event", "relationship"].map((k) => (
                            <label key={k} className="flex items-center gap-2 text-text-bright cursor-pointer">
                              <input
                                type="checkbox"
                                checked={extractKinds.includes(k)}
                                onChange={(e) =>
                                  setExtractKinds((prev) =>
                                    e.target.checked ? [...prev, k] : prev.filter((x) => x !== k),
                                  )
                                }
                                className="accent-amber-500"
                              />
                              {k}
                            </label>
                          ))}
                        </div>
                        <Fieldset>
                          <label className="text-xs text-text-dimmed font-medium">
                            Confidence threshold — {extractConfidence.toFixed(2)}
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={extractConfidence}
                            onChange={(e) => setExtractConfidence(Number(e.target.value))}
                            className="w-full accent-amber-500"
                          />
                        </Fieldset>
                        <Fieldset>
                          <label className="text-xs text-text-dimmed font-medium">
                            Max memories per pass
                          </label>
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            value={extractMax}
                            onChange={(e) => setExtractMax(Number(e.target.value))}
                          />
                        </Fieldset>
                      </>
                    )}
                  </div>
                </details>
              </section>

              <div className="flex justify-between pt-2">
                <Button type="button" variant="tertiary/medium" onClick={back}>
                  ← Back
                </Button>
                {/* PIFSP-5 bug fix: always enabled regardless of memory toggle state */}
                <Button type="button" variant="primary/medium" onClick={advance}>
                  Next: Tool-call method →
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 4: Tool-call method + preview ─────────────────── */}
          {step === 4 && (
            <Form method="post">
              <div className="space-y-6">
                <div>
                  <h2 className="text-base font-semibold text-text-bright mb-0.5">Tool-call method</h2>
                  <Paragraph variant="small">
                    How this agent calls tools. The preview below shows the exact system prompt
                    Platos will send on turn 1.
                  </Paragraph>
                </div>

                <section>
                  <div className="space-y-2">
                    {(
                      [
                        {
                          value: "direct",
                          label: "Direct",
                          desc: "The agent calls tools itself. Default — best for <30 tools.",
                        },
                        {
                          value: "sub-agent",
                          label: "Sub-agent",
                          desc: "Dedicated tool-calling agent (Claude Haiku). Best for 100+ tools.",
                        },
                        {
                          value: "execute-tool",
                          label: "Execute-tool wrapper",
                          desc: "Minimalist — use find_tools then execute_tools. Max token savings.",
                        },
                      ] as const
                    ).map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-start gap-3 rounded border p-3 cursor-pointer ${
                          toolMode === opt.value
                            ? "border-emerald-500/60 bg-emerald-500/5"
                            : "border-charcoal-700 hover:border-charcoal-600"
                        }`}
                      >
                        <input
                          type="radio"
                          name="toolsBlockMode"
                          value={opt.value}
                          checked={toolMode === opt.value}
                          onChange={() => setToolMode(opt.value)}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <div>
                          <p className="text-sm font-medium text-text-bright">{opt.label}</p>
                          <p className="text-xs text-text-dimmed">{opt.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </section>

                {/* CONSISTENCY (audit #7) — sub-agent fields at CREATE.
                    The action has always parsed subAgentModel / subAgentMaxSteps
                    / subAgentSystemPrompt, but the wizard never rendered them:
                    picking "Sub-agent" here silently applied hardcoded defaults
                    and you only discovered the real config on the edit page.
                    Rendered conditionally so the create and edit flows expose
                    the same fields; blank inputs keep the same defaults the
                    action already applied. */}
                {toolMode === "sub-agent" && (
                  <section className="rounded border border-charcoal-700 p-3 space-y-3">
                    <Header3>Sub-agent configuration</Header3>
                    <Paragraph variant="small">
                      The dedicated tool-calling agent. Leave blank to use the defaults.
                    </Paragraph>
                    <div>
                      <label className="text-xs text-text-dimmed font-medium" htmlFor="subAgentModel">
                        Sub-agent model
                      </label>
                      <input
                        id="subAgentModel"
                        type="text"
                        name="subAgentModel"
                        placeholder="anthropic:claude-haiku-4-5-20251001"
                        className="mt-1 w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-text-dimmed font-medium" htmlFor="subAgentMaxSteps">
                        Max steps
                      </label>
                      <input
                        id="subAgentMaxSteps"
                        type="number"
                        name="subAgentMaxSteps"
                        min={1}
                        max={50}
                        placeholder="10"
                        className="mt-1 w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                      />
                    </div>
                    <div>
                      <label
                        className="text-xs text-text-dimmed font-medium"
                        htmlFor="subAgentSystemPrompt"
                      >
                        Sub-agent system prompt
                      </label>
                      <textarea
                        id="subAgentSystemPrompt"
                        name="subAgentSystemPrompt"
                        rows={3}
                        placeholder="Optional — instructions for the tool-calling sub-agent."
                        className="mt-1 w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                      />
                    </div>
                  </section>
                )}

                {/* Live prompt preview */}
                <section>
                  <Header3>System prompt preview</Header3>
                  <Paragraph variant="small" className="mt-1 mb-2">
                    This is what Platos will send to {agentName || "the LLM"} on turn 1 (simplified
                    — exact rendering may include resolved tool schemas and memory at runtime).
                  </Paragraph>
                  <pre className="max-h-64 overflow-y-auto rounded border border-charcoal-700 bg-charcoal-900 p-3 text-[11px] font-mono text-text-bright whitespace-pre-wrap leading-relaxed">
                    {promptPreview}
                  </pre>
                </section>

                {/* Hidden inputs carrying all accumulated wizard state */}
                <input type="hidden" name="name" value={agentName} />
                <input
                  type="hidden"
                  name="model"
                  value={modelRoutes.find((r: any) => r.isDefault)?.model ?? modelRoutes[0]?.model ?? ""}
                />
                <input type="hidden" name="modelRoutes" value={JSON.stringify(modelRoutes)} />
                <input type="hidden" name="systemPromptBlocks" value={JSON.stringify(blocks)} />
                <input
                  type="hidden"
                  name="dynamicBlocksJson"
                  value={JSON.stringify(dynamicBlocks.filter((b) => b.key.trim() && b.name.trim()))}
                />
                <input type="hidden" name="contextLimit" value={contextLimit} />
                <input type="hidden" name="historyMode" value={historyMode} />
                <input type="hidden" name="executionMode" value={executionMode} />
                <input type="hidden" name="compactThreshold" value={compactThreshold} />
                {userProfiling && <input type="hidden" name="enableUserProfiling" value="on" />}
                {semanticMemory && <input type="hidden" name="enableSemanticMemory" value="on" />}
                {knowledgeGraph && <input type="hidden" name="enableKnowledgeGraph" value="on" />}
                {extractEnabled && <input type="hidden" name="extract_enabled" value="on" />}
                {extractKinds.map((k) => (
                  <input key={k} type="hidden" name="extract_kind" value={k} />
                ))}
                <input type="hidden" name="extract_confidenceThreshold" value={extractConfidence} />
                <input type="hidden" name="extract_maxPerSession" value={extractMax} />
                <input type="hidden" name="maxSteps" value={20} />

                <div className="flex justify-between pt-2">
                  <Button type="button" variant="tertiary/medium" onClick={back}>
                    ← Back
                  </Button>
                  <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
                    {isSubmitting ? "Creating…" : "Create Agent →"}
                  </Button>
                </div>
              </div>
            </Form>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}
