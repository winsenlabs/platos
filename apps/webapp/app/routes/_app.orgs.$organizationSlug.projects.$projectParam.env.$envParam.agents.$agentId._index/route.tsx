import {
  AcademicCapIcon,
  AdjustmentsHorizontalIcon,
  BookOpenIcon,
  ClipboardDocumentIcon,
  CpuChipIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  ClipboardDocumentListIcon,
  MagnifyingGlassCircleIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useActionData, useFetcher, useNavigation, useParams, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Prisma } from "@platos/database";
import { prisma } from "~/db.server";
import { ModelPicker, type ProviderForPicker } from "~/components/agents/ModelPicker";
import { ModelRoutesEditor } from "~/components/agents/ModelRoutesEditor";
import { PromptBlockEditor } from "~/components/agents/PromptBlockEditor";
import { RetryRulesEditor, type RetryRule } from "~/components/agents/RetryRulesEditor";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { cacheRatesFor } from "~/utils/cacheRates";
import {
  agentCanaryPath,
  agentChatPath,
  agentConversationsPath,
  agentEvalsABPath,
  agentSkillsPath,
  agentToolMappingsPath,
  agentVersionsPath,
  EnvironmentParamSchema,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Config | Platos" }];

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

/**
 * PIFSP-19 — read-side defense for block-list columns (promptBlocks /
 * dynamicBlocks). These are array columns, but a double-encoded write (a client
 * sending `JSON.stringify(blocks)`) can land a string scalar. A truthy string
 * slips past `|| []` and the editor then calls `.map` on it
 * (`z.map is not a function`), crashing the agent detail page. Parse-if-string,
 * require-array, fall back to []. Belt to the write-path braces in
 * agent-crud.service.ts.
 */
function asBlockArray<T>(raw: unknown): T[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const agentId = params.agentId!;
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

  // Load agent config from platos-agent API
  const defaults = {
    id: agentId,
    name: agentId === "default" ? "Default Agent" : agentId,
    slug: agentId,
    model: "anthropic:claude-sonnet-4-6",
    systemPrompt: "You are a helpful AI assistant powered by Platos.",
    maxSteps: 20,
    toolMode: "direct",
    memoryConfig: { conversation: true, working: true, semantic: { enabled: false }, graph: { enabled: false } },
    metaTools: { find_tools: true, execute_tools: true, remember: true, recall: true },
    isActive: true,
    threadCount: 0,
    createdAt: new Date().toISOString(),
    contextLimit: 20,
    historyMode: "rolling",
    compactThreshold: 40,
    executionMode: "direct",
    enableUserProfiling: false,
    toolsBlockConfig: null as null | { mode: string; enabledTools?: string[]; perToolPerms?: Record<string, unknown> },
    subAgentConfig: null as null | { model: string; maxSteps: number; systemPrompt?: string },
    dynamicBlocks: [] as Array<{ key: string; name: string; defaultContent: string; description?: string }>,
    // Theme O.2 — per-agent memory extraction policy. Null means "enabled with
    // defaults" at the runtime layer.
    extractionPolicy: null as null | {
      enabled: boolean;
      kinds: string[];
      confidenceThreshold: number;
      maxPerSession: number;
      minMessagesBeforeRun: number;
    },
  };

  let agent = defaults;
  let promptBlocks: any[] = [];
  try {
    const { isAgentServiceAvailable, getAgent } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const result = await getAgent(agentId, scope);
      agent = { ...defaults, ...result };

      // Use saved blocks if agent has them; else synthesize from
      // `systemPrompt` so MCP-created agents (which set the raw
      // systemPrompt column but not promptBlocks) render what's
      // actually stored, not a generic template. Fall through to
      // generic defaults only when BOTH are empty (e.g. brand-new
      // agent via the builder wizard before the first save).
      if (Array.isArray((result as any)?.promptBlocks) && (result as any).promptBlocks.length > 0) {
        promptBlocks = (result as any).promptBlocks;
      } else if ((result as any)?.systemPrompt && typeof (result as any).systemPrompt === "string") {
        promptBlocks = [
          {
            id: "identity",
            type: "custom",
            name: "System Prompt",
            content: (result as any).systemPrompt,
            enabled: true,
            editable: true,
            order: 0,
          },
        ];
      } else {
        const blocksRes = await fetch(`${AGENT_API_URL}/api/v1/agent/prompt/defaults?agentName=${encodeURIComponent(agent.name)}`, {
          headers: scopeHeaders(scope),
          signal: AbortSignal.timeout(5000),
        });
        if (blocksRes.ok) {
          const data = (await blocksRes.json()) as { blocks?: any[] };
          promptBlocks = data.blocks || [];
        }
      }
    }
  } catch {
    // Agent service not running — use defaults
  }

  // Load provider states for the scope-aware model picker.
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

  const providersPath = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  )}/agent-providers`;

  // Detect orphaned agent.model — its provider is no longer enabled + envReady.
  const selectedProviderId = agent.model?.split(":")[0] ?? "";
  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const orphanedConfig =
    providers.length > 0 &&
    (!selectedProvider || !selectedProvider.envReady || !selectedProvider.enabled);

  // PIFSP-14 — load named provider keys so the key picker can show options.
  let providerKeys: Array<{ id: string; provider: string; label: string; envVarName: string; isDefault: boolean; envVarSet?: boolean }> = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const pkRes = await fetch(`${AGENT_API_URL}/api/v1/agent/providers/keys`, {
        headers: scopeHeaders(scope),
      });
      if (pkRes.ok) {
        const pkData = (await pkRes.json()) as { keys?: typeof providerKeys };
        providerKeys = pkData.keys ?? [];
      }
    }
  } catch {}

  // PRA-AC — load available clusters so the agent settings cluster picker is populated.
  let availableClusters: Array<{ id: string; name: string; slug: string }> = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const clRes = await fetch(`${AGENT_API_URL}/api/v1/agent/clusters`, { headers: scopeHeaders(scope) });
      if (clRes.ok) {
        const clData = (await clRes.json()) as { clusters?: typeof availableClusters };
        availableClusters = clData.clusters ?? [];
      }
    }
  } catch {}

  // CTX.4 — pull `contextMapping` from the scoped agent row so the Context
  // section can round-trip the operator's edits. Scope-gated via the full
  // (id, org, project, env) tuple — a cross-tenant id lookup just returns
  // null and the section renders an empty mapping.
  const agentRow = await prisma.platosAgent.findFirst({
    where: {
      id: agentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
    select: { contextMapping: true, providerKeyId: true, modelRoutes: true, clusteringId: true, enableThreading: true, agentRetryConfig: true },
  });
  const contextMapping =
    (agentRow?.contextMapping as ContextMapping | null) ?? null;

  // MC.4 — per-agent cache hit rate series for the last 7 days. Failures
  // here are non-fatal; the section renders a neutral state if the agent
  // endpoint is unreachable or returns a non-2xx.
  let cacheRange: CacheRangePayload | null = null;
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/agent/${encodeURIComponent(agentId)}/cache-range?days=7`,
        {
          headers: scopeHeaders(scope),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (res.ok) {
        cacheRange = (await res.json()) as CacheRangePayload;
      }
    }
  } catch {
    // agent service hiccup — keep section in neutral state
  }

  return typedjson({
    agent,
    promptBlocks,
    providers,
    providersPath,
    orphanedConfig,
    contextMapping,
    cacheRange,
    providerKeys,
    agentProviderKeyId: agentRow?.providerKeyId ?? null,
    agentModelRoutes: (agentRow?.modelRoutes as any[] | null) ?? null,
    agentRetryRules: ((agentRow as any)?.agentRetryConfig?.rules ?? null) as RetryRule[] | null,
    agentClusteringId: agentRow?.clusteringId ?? null,
    agentEnableThreading: agentRow?.enableThreading ?? false,
    availableClusters,
  });
}

/**
 * MC.4 — per-agent cache hit rate payload from the agent-service endpoint.
 * See apps/agent/src/agent-runtime/agent.controller.ts `agentCacheRange`.
 */
type CacheRangePayload = {
  agentId: string;
  days: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  costWithCacheCents: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  perDay: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    costCents: number;
    costWithCacheCents: number;
  }>;
  fetchedAt: string;
};

/**
 * CTX.4 — shape of the per-agent session-context declaration. Mirrors the
 * type used by the chat playground loader so the two surfaces stay in sync.
 */
type ContextMapping = {
  promptVars?: string[];
  toolArgInjection?: Record<string, Record<string, string>>;
  envelopeKeys?: string[];
  entityIdsKey?: string;
};

/**
 * CTX.4 — normalise whatever the operator types into a canonical
 * ContextMapping object. Missing / empty sub-fields are dropped so the stored
 * JSON stays minimal. Returns `{ ok: false, error }` on shape violations so
 * the action can preserve the form state and surface the error.
 */
function parseContextMappingPayload(input: {
  promptVarsRaw: string;
  toolArgInjectionJson: string;
  envelopeKeysRaw: string;
  entityIdsKey: string;
}): { ok: true; mapping: ContextMapping } | { ok: false; error: string } {
  const mapping: ContextMapping = {};

  const splitChips = (raw: string): string[] =>
    raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const promptVars = splitChips(input.promptVarsRaw);
  if (promptVars.length > 0) mapping.promptVars = promptVars;

  const envelopeKeys = splitChips(input.envelopeKeysRaw);
  if (envelopeKeys.length > 0) mapping.envelopeKeys = envelopeKeys;

  const entityIdsKey = input.entityIdsKey.trim();
  if (entityIdsKey.length > 0) mapping.entityIdsKey = entityIdsKey;

  const toolArgRaw = input.toolArgInjectionJson.trim();
  if (toolArgRaw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolArgRaw);
    } catch (err) {
      return {
        ok: false,
        error: `toolArgInjection is not valid JSON: ${
          err instanceof Error ? err.message : "parse failed"
        }`,
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "toolArgInjection must be a JSON object keyed by tool name",
      };
    }
    const normalised: Record<string, Record<string, string>> = {};
    for (const [toolName, argMap] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (argMap === null || typeof argMap !== "object" || Array.isArray(argMap)) {
        return {
          ok: false,
          error: `toolArgInjection.${toolName} must be an object of { argName: contextKey }`,
        };
      }
      const row: Record<string, string> = {};
      for (const [argName, ctxKey] of Object.entries(
        argMap as Record<string, unknown>,
      )) {
        if (typeof ctxKey !== "string") {
          return {
            ok: false,
            error: `toolArgInjection.${toolName}.${argName} must be a string context key`,
          };
        }
        row[argName] = ctxKey;
      }
      if (Object.keys(row).length > 0) normalised[toolName] = row;
    }
    if (Object.keys(normalised).length > 0) mapping.toolArgInjection = normalised;
  }

  return { ok: true, mapping };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const agentId = params.agentId!;
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

  // Theme G.7 — feature-flags editor posts with `intent=set-feature-flags`
  // and a single JSON blob. The agent API has a dedicated endpoint
  // (PATCH /agents/:id/feature-flags) that replaces the whole map.
  const intent = formData.get("intent") as string | null;
  if (intent === "set-feature-flags") {
    const raw = (formData.get("featureFlagsJson") as string | null) || "{}";
    let parsed: Record<string, boolean> | null = null;
    try {
      const maybe = JSON.parse(raw);
      if (maybe && typeof maybe === "object" && !Array.isArray(maybe)) {
        parsed = {};
        for (const [k, v] of Object.entries(maybe)) {
          if (typeof k === "string" && k.length > 0) {
            parsed[k] = !!v;
          }
        }
      }
    } catch {
      return typedjson(
        { error: "Feature flags must be a JSON object of { flag: boolean }." },
        { status: 400 },
      );
    }
    if (!parsed) {
      return typedjson(
        { error: "Feature flags must be a JSON object of { flag: boolean }." },
        { status: 400 },
      );
    }
    try {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/agents/${agentId}/feature-flags`,
        {
          method: "PATCH",
          headers: scopeHeaders(scope),
          body: JSON.stringify({ featureFlags: parsed }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) {
        const errorText = await res.text();
        return typedjson(
          { error: errorText || "Feature flags update failed" },
          { status: res.status },
        );
      }
      return typedjson({ success: true, featureFlags: parsed });
    } catch (error: any) {
      return typedjson(
        { error: `Feature flags update failed: ${error?.message || "unknown"}` },
        { status: 500 },
      );
    }
  }

  // CTX.4 — persist the per-agent session-context mapping. Scope double-gate
  // via the full tuple on `updateMany`; cross-tenant id replay is a no-op
  // (count === 0 → fail-open error, no plaintext leaked).
  if (intent === "save-context-mapping") {
    const payload = {
      promptVarsRaw: String(formData.get("contextPromptVars") ?? ""),
      toolArgInjectionJson: String(formData.get("contextToolArgInjectionJson") ?? ""),
      envelopeKeysRaw: String(formData.get("contextEnvelopeKeys") ?? ""),
      entityIdsKey: String(formData.get("contextEntityIdsKey") ?? ""),
    };
    const parsed = parseContextMappingPayload(payload);
    if (!parsed.ok) {
      return typedjson(
        { error: parsed.error, submitted: payload },
        { status: 400 },
      );
    }
    const isEmpty =
      !parsed.mapping.promptVars &&
      !parsed.mapping.toolArgInjection &&
      !parsed.mapping.envelopeKeys &&
      !parsed.mapping.entityIdsKey;
    try {
      const result = await prisma.platosAgent.updateMany({
        where: {
          id: agentId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        data: {
          contextMapping: isEmpty
            ? Prisma.JsonNull
            : (parsed.mapping as unknown as Prisma.InputJsonValue),
        },
      });
      if (result.count === 0) {
        return typedjson(
          { error: "Agent not found in this scope", submitted: payload },
          { status: 404 },
        );
      }
      return typedjson({ success: true, contextMapping: parsed.mapping });
    } catch (error: any) {
      return typedjson(
        {
          error: `Context mapping save failed: ${error?.message || "unknown"}`,
          submitted: payload,
        },
        { status: 500 },
      );
    }
  }

  const name = formData.get("name") as string | null;
  const slug = formData.get("slug") as string | null;
  const model = formData.get("model") as string | null;
  const providerKeyId = formData.get("providerKeyId") as string | null;
  const systemPrompt = formData.get("systemPrompt") as string | null;
  const systemPromptBlocksRaw = formData.get("systemPromptBlocks") as string | null;
  const toolsBlockMode = formData.get("toolsBlockMode") as string | null;
  const maxStepsRaw = formData.get("maxSteps") as string | null;

  const contextLimitRaw = formData.get("contextLimit") as string | null;
  const historyMode = formData.get("historyMode") as string | null;
  const compactThresholdRaw = formData.get("compactThreshold") as string | null;
  const executionMode = formData.get("executionMode") as string | null;
  const enableUserProfiling = formData.get("enableUserProfiling") === "on";
  const enableThreading = formData.get("enableThreading") === "on";
  const clusterMode = formData.get("clusterMode") as string | null;
  const clusteringIdRaw = formData.get("clusteringId") as string | null;

  const subAgentModel = formData.get("subAgentModel") as string | null;
  const subAgentMaxStepsRaw = formData.get("subAgentMaxSteps") as string | null;
  const subAgentSystemPrompt = formData.get("subAgentSystemPrompt") as string | null;

  const dynamicBlocksJson = formData.get("dynamicBlocksJson") as string | null;

  let promptBlocks: any = undefined;
  if (systemPromptBlocksRaw) {
    try { promptBlocks = JSON.parse(systemPromptBlocksRaw); } catch {}
  }

  let dynamicBlocks: any = undefined;
  if (dynamicBlocksJson) {
    try { dynamicBlocks = JSON.parse(dynamicBlocksJson); } catch {}
  }

  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  if (model) body.model = model;
  if (systemPrompt !== null) body.systemPrompt = systemPrompt;
  if (promptBlocks !== undefined) body.promptBlocks = promptBlocks;
  if (maxStepsRaw) body.maxSteps = parseInt(maxStepsRaw, 10);

  // CONSISTENCY (audit #2) — send ONLY the fields this form owns. It used to
  // rebuild the whole toolsBlockConfig ({mode, enabledTools: [], perToolPerms:
  // {}}), which silently wiped everything the Tools tab maintains
  // (displayMode, pinnedTools, enabledCategories, categoryDescriptions, ...)
  // on every save of the Basic form — two screens fighting over one JSON
  // column, and this one always lost data. The backend now deep-merges
  // toolsBlockConfig/subAgentConfig (agent-crud.service.ts), so a partial
  // patch preserves every key it doesn't mention.
  // HARMONISATION — this form now owns `toolExposure` alongside `mode`, so the
  // Basic screen and the wizard describe tools the same way. Still a PARTIAL
  // patch (deep-merged server-side), so keys owned by the Tools tab —
  // displayMode, pinnedTools, enabledCategories — are untouched.
  const toolExposureRaw = formData.get("toolExposure") as string | null;
  if (toolsBlockMode || toolExposureRaw) {
    body.toolsBlockConfig = {
      ...(toolsBlockMode ? { mode: toolsBlockMode } : {}),
      ...(toolExposureRaw ? { toolExposure: toolExposureRaw === "direct" ? "direct" : "meta" } : {}),
    };
  }

  if (toolsBlockMode === "sub-agent") {
    body.subAgentConfig = {
      model: subAgentModel || "anthropic:claude-haiku-4-5-20251001",
      maxSteps: subAgentMaxStepsRaw ? parseInt(subAgentMaxStepsRaw, 10) : 10,
      // Explicit null, never omission (Fable verify B2): under the merge
      // semantics above, an OMITTED key preserves the stored value — so
      // clearing this textarea would silently leave the old prompt steering
      // the sub-agent. A null value survives the shallow merge and reads as
      // "unset" downstream.
      systemPrompt: subAgentSystemPrompt || null,
    };
  }

  if (contextLimitRaw) body.contextLimit = parseInt(contextLimitRaw, 10);
  if (historyMode) body.historyMode = historyMode;
  if (compactThresholdRaw) body.compactThreshold = parseInt(compactThresholdRaw, 10);
  if (executionMode) body.executionMode = executionMode;
  body.enableUserProfiling = enableUserProfiling;
  body.enableThreading = enableThreading;
  // PRA-AC: null clears cluster membership; non-empty string sets it.
  if (clusterMode === "standalone") body.clusteringId = null;
  else if (clusteringIdRaw) body.clusteringId = clusteringIdRaw;

  // PIFSP-6 memory bug fix: read memory_semantic + memory_graph from form
  // and include in the body as the canonical nested shape the agent service
  // expects. Previously these checkboxes were submitted but never read,
  // causing a silent no-op on every save that involved memory toggles.
  const semanticEnabled = formData.get("memory_semantic") === "on";
  const graphEnabled = formData.get("memory_graph") === "on";
  body.memoryConfig = {
    conversation: true,
    working: true,
    semantic: { enabled: semanticEnabled },
    graph: { enabled: graphEnabled },
  };

  if (dynamicBlocks !== undefined) body.dynamicBlocks = dynamicBlocks;

  // PIFSP-14 — per-agent provider key pin. null string means "clear the pin".
  if (providerKeyId !== undefined) {
    body.providerKeyId = providerKeyId === "" ? null : providerKeyId;
  }

  const modelRoutesRaw = formData.get("modelRoutes") as string | null;
  if (modelRoutesRaw !== null && modelRoutesRaw !== undefined) {
    try { body.modelRoutes = JSON.parse(modelRoutesRaw); } catch { /* ignore */ }
  }

  // LAUNCH-2 phase 2 — per-agent retry/fallback waterfall. Empty string means
  // "no rules, use defaults" — persist as null so the runtime falls back to
  // DEFAULT_RETRY_RULES from retry-fetch.ts.
  const agentRetryConfigRaw = formData.get("agentRetryConfig") as string | null;
  if (agentRetryConfigRaw !== null && agentRetryConfigRaw !== undefined) {
    if (agentRetryConfigRaw.trim() === "") {
      body.agentRetryConfig = null;
    } else {
      try { body.agentRetryConfig = JSON.parse(agentRetryConfigRaw); } catch { /* ignore */ }
    }
  }

  // Theme O.2 — extraction policy. The builder submits each knob as a
  // separate form field prefixed `extract_`. Null out the policy if the
  // "enabled" checkbox is off AND nothing else was explicitly set, so the
  // runtime falls back to defaults for existing rows.
  const extractEnabledRaw = formData.get("extract_enabled");
  if (extractEnabledRaw !== null) {
    const kindValues = formData.getAll("extract_kind").map((v) => String(v));
    const confidence = formData.get("extract_confidenceThreshold");
    const maxPer = formData.get("extract_maxPerSession");
    const minMsg = formData.get("extract_minMessagesBeforeRun");
    body.extractionPolicy = {
      enabled: extractEnabledRaw === "on",
      kinds: kindValues.length > 0 ? kindValues : ["fact", "preference", "event", "relationship"],
      confidenceThreshold: confidence ? Number.parseFloat(String(confidence)) : 0.6,
      maxPerSession: maxPer ? Number.parseInt(String(maxPer), 10) : 10,
      minMessagesBeforeRun: minMsg ? Number.parseInt(String(minMsg), 10) : 6,
    };
  }

  try {
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
      method: "PATCH",
      headers: scopeHeaders(scope),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const errorText = await res.text();
      return typedjson({ error: errorText || "Failed to save" }, { status: res.status });
    }
    void telemetry.platos.agentUpdated({ organizationId: scope.organizationId, agentId, field: "config" });
    return typedjson({ success: true });
  } catch (error: any) {
    return typedjson({ error: `Failed to save: ${error?.message || "unknown"}` }, { status: 500 });
  }
}

// EOBD.99 — styled 404 for deleted/missing agents.
export { RouteNotFoundBoundary as ErrorBoundary } from "~/components/platos/RouteNotFoundBoundary";

export default function AgentDetailPage() {
  const {
    agent,
    promptBlocks: initialBlocks,
    providers,
    providersPath,
    orphanedConfig,
    contextMapping,
    cacheRange,
    providerKeys,
    agentProviderKeyId,
    agentModelRoutes,
    agentRetryRules,
    agentClusteringId,
    agentEnableThreading,
    availableClusters,
  } = useTypedLoaderData<typeof loader>();
  // Main config Form save feedback. The <Form method="post"> below submits via
  // navigation (not a fetcher), so its result lands in useActionData and its
  // in-flight state in useNavigation. Fetcher-based sub-forms (feature flags,
  // context mapping) do NOT populate these, so this only reflects the main save.
  const mainActionData = useActionData<{ success?: boolean; error?: string }>();
  const mainNavigation = useNavigation();
  // A main-form submit has no `intent` field (the intent-tagged branches are
  // fetcher sub-forms), so this distinguishes it from those.
  const isSavingConfig =
    mainNavigation.state !== "idle" && !mainNavigation.formData?.get("intent");
  const [blocks, setBlocks] = useState(initialBlocks || []);
  const [toolExposure, setToolExposure] = useState<"meta" | "direct">(
    ((agent as any).toolsBlockConfig?.toolExposure === "direct" ? "direct" : "meta"),
  );
  const [toolsBlockMode, setToolsBlockMode] = useState<string>(
    (agent as any).toolsBlockConfig?.mode || "direct"
  );
  const [dynamicBlocks, setDynamicBlocks] = useState<
    Array<{ key: string; name: string; defaultContent: string; description?: string }>
  >(asBlockArray((agent as any).dynamicBlocks));
  // Theme G.7 — local state for the feature flags editor. Seed from the
  // saved value; the PATCH action replaces the whole map on submit.
  const initialFlags = useMemo<Record<string, boolean>>(
    () => ((agent as any).featureFlags as Record<string, boolean> | null) || {},
    [agent],
  );
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>(initialFlags);
  const [newFlagKey, setNewFlagKey] = useState("");
  const flagsFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const flagEntries = Object.entries(featureFlags).sort(([a], [b]) => a.localeCompare(b));

  const addFlag = () => {
    const key = newFlagKey.trim();
    if (!key) return;
    if (key in featureFlags) return;
    setFeatureFlags((prev) => ({ ...prev, [key]: true }));
    setNewFlagKey("");
  };
  const removeFlag = (key: string) => {
    setFeatureFlags((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  const toggleFlag = (key: string, value: boolean) => {
    setFeatureFlags((prev) => ({ ...prev, [key]: value }));
  };

  // CTX.4 — context mapping editor. Local state for the three sub-sections
  // (chip lists + JSON textarea + entity-ids key). On submit we post to the
  // `save-context-mapping` action which writes `PlatosAgent.contextMapping`
  // via a scope-gated `updateMany`. On server error the form state is
  // preserved via `submitted` echoed back in the fetcher data.
  const initialPromptVars = useMemo<string[]>(
    () => contextMapping?.promptVars ?? [],
    [contextMapping],
  );
  const initialEnvelopeKeys = useMemo<string[]>(
    () => contextMapping?.envelopeKeys ?? [],
    [contextMapping],
  );
  const initialToolArgInjectionJson = useMemo<string>(() => {
    const tai = contextMapping?.toolArgInjection;
    if (!tai || Object.keys(tai).length === 0) return "";
    return JSON.stringify(tai, null, 2);
  }, [contextMapping]);
  const initialEntityIdsKey = useMemo<string>(
    () => contextMapping?.entityIdsKey ?? "entity_ids",
    [contextMapping],
  );

  const [promptVars, setPromptVars] = useState<string[]>(initialPromptVars);
  const [newPromptVar, setNewPromptVar] = useState("");
  const [envelopeKeys, setEnvelopeKeys] = useState<string[]>(initialEnvelopeKeys);
  const [newEnvelopeKey, setNewEnvelopeKey] = useState("");
  const [toolArgInjectionJson, setToolArgInjectionJson] = useState<string>(
    initialToolArgInjectionJson,
  );
  const [entityIdsKey, setEntityIdsKey] = useState<string>(initialEntityIdsKey);
  const ctxFetcher = useFetcher<{
    success?: boolean;
    error?: string;
    submitted?: {
      promptVarsRaw: string;
      toolArgInjectionJson: string;
      envelopeKeysRaw: string;
      entityIdsKey: string;
    };
  }>();

  const addPromptVar = () => {
    const k = newPromptVar.trim();
    if (!k || promptVars.includes(k)) return;
    setPromptVars((prev) => [...prev, k]);
    setNewPromptVar("");
  };
  const removePromptVar = (k: string) => {
    setPromptVars((prev) => prev.filter((x) => x !== k));
  };
  const addEnvelopeKey = () => {
    const k = newEnvelopeKey.trim();
    if (!k || envelopeKeys.includes(k)) return;
    setEnvelopeKeys((prev) => [...prev, k]);
    setNewEnvelopeKey("");
  };
  const removeEnvelopeKey = (k: string) => {
    setEnvelopeKeys((prev) => prev.filter((x) => x !== k));
  };

  // Live validator for the toolArgInjection JSON editor. Returns a summary
  // string or a parse error.
  const toolArgInjectionSummary = useMemo<{
    valid: boolean;
    message: string;
  }>(() => {
    const raw = toolArgInjectionJson.trim();
    if (raw.length === 0) {
      return { valid: true, message: "0 tools / 0 args mapped" };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { valid: false, message: "must be a JSON object" };
      }
      let toolCount = 0;
      let argCount = 0;
      for (const [, row] of Object.entries(parsed)) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
          return { valid: false, message: "each tool must map to an object" };
        }
        toolCount++;
        argCount += Object.keys(row as Record<string, unknown>).length;
      }
      return {
        valid: true,
        message: `${toolCount} tool${toolCount === 1 ? "" : "s"} / ${argCount} arg${
          argCount === 1 ? "" : "s"
        } mapped`,
      };
    } catch (err) {
      return {
        valid: false,
        message: err instanceof Error ? err.message : "parse failed",
      };
    }
  }, [toolArgInjectionJson]);

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const updateBlock = (
    i: number,
    patch: Partial<{ key: string; name: string; defaultContent: string; description?: string }>
  ) => {
    setDynamicBlocks((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  };
  const removeBlock = (i: number) => {
    setDynamicBlocks((prev) => prev.filter((_, idx) => idx !== i));
  };
  const addBlock = () => {
    setDynamicBlocks((prev) => [...prev, { key: "", name: "", defaultContent: "", description: "" }]);
  };

  // PIFSP-6: Parent layout (agents.$agentId/route.tsx) provides the
  // persistent header + tab strip. This _index route (basic config tab)
  // just renders its scrollable body content via PageBody.
  return (
    <PageBody>
        <Form method="post" className="max-w-2xl">
          <div className="space-y-6">
            {/* Basic Info */}
            <section>
              <Header3>Basic Configuration</Header3>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Name</label>
                  <Input name="name" defaultValue={agent.name} placeholder="My Agent" />
                </Fieldset>
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Slug</label>
                  <Input name="slug" defaultValue={agent.slug} placeholder="my-agent" />
                </Fieldset>
              </div>
            </section>

            {/* Model */}
            <section>
              <Header3>Model</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                The LLM that powers this agent. User picks the model — no auto-escalation.
              </Paragraph>
              {orphanedConfig && (
                <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                  This agent is configured with <code className="font-mono">{agent.model}</code>,
                  whose provider is not currently enabled for this environment. Pick a ready model
                  below or update provider links.
                </div>
              )}
              <ModelRoutesEditor
                name="modelRoutes"
                initialRoutes={agentModelRoutes ?? undefined}
                legacyModel={agent?.model}
                legacyProviderKeyId={agentProviderKeyId}
                providers={providers}
                providerKeys={providerKeys.map(k => ({ id: k.id, label: k.label, provider: k.provider, envVarName: k.envVarName }))}
                providersPath={providersPath}
              />
            </section>

            {/* LAUNCH-2 — Reliability / retry waterfall */}
            <section>
              <Header3>Reliability</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                Declarative retry + fallback rules applied to every model invocation. Honors
                <code className="font-mono mx-1 text-emerald-300">Retry-After</code> headers,
                falls back across model routes when configured. Leave empty to use built-in
                defaults.
              </Paragraph>
              <RetryRulesEditor
                name="agentRetryConfig"
                initialRules={agentRetryRules ?? undefined}
                routeLabels={(agentModelRoutes ?? []).map((r: any) => r.label).filter(Boolean)}
              />
            </section>

            {/* System Prompt Block Editor */}
            <section>
              {blocks.length > 0 ? (
                <PromptBlockEditor
                  blocks={blocks}
                  onChange={setBlocks}
                />
              ) : (
                <>
                  <Header3>System Prompt</Header3>
                  <Paragraph variant="small" className="mt-1 mb-3">
                    Instructions that define the agent's personality and behavior.
                  </Paragraph>
                  <Fieldset>
                    <textarea
                      name="systemPrompt"
                      defaultValue={agent.systemPrompt || ""}
                      rows={6}
                      className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright font-mono resize-y"
                      placeholder="You are a helpful AI assistant..."
                    />
                  </Fieldset>
                </>
              )}
            </section>

            {/* Tool exposure (toolsBlockConfig.toolExposure) — what the model
                can CALL. Kept adjacent to tool-call method so the two are read
                together; they were previously split across screens, which is
                how an operator could pick "Direct" here and still get
                meta-tools at runtime. */}
            <Fieldset>
              <label className="text-xs text-text-dimmed font-medium">Tools</label>
              <select
                name="toolExposure"
                value={toolExposure}
                onChange={(e) => setToolExposure(e.target.value as "meta" | "direct")}
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
              >
                <option value="direct">
                  Direct — connected-entity tools given to the agent as callable tools
                </option>
                <option value="meta">
                  Meta tools — agent gets find_tools + execute_tools and reaches entity tools through them
                </option>
              </select>
              <Paragraph variant="small" className="mt-1">
                {toolExposure === "direct"
                  ? "Every tool under Connected Entities is provided directly, with its full schema, inside the cached prompt prefix. find_tools and execute_tools are not injected. Context tools (memory, profile, artifacts, schedules) stay exposed as ticked."
                  : "The agent discovers entity tools via find_tools and calls them via execute_tools. If a connected entity is itself a gateway with its own search/execute pair, this stacks two layers of indirection."}
              </Paragraph>
            </Fieldset>

            {/* Tool-call method (toolsBlockConfig.mode) */}
            <section>
              <Header3>Tool-call method</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                How this agent calls tools. Sub-agent mode uses Claude Haiku for precision tool calling.
              </Paragraph>
              <Fieldset>
                <select
                  name="toolsBlockMode"
                  value={toolsBlockMode}
                  onChange={(e) => setToolsBlockMode(e.target.value)}
                  className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
                >
                  {/* Labels avoid "Direct" — the Tools control above uses it for
                      EXPOSURE, and two controls offering "Direct" for different
                      things is exactly the confusion being removed here. The
                      tool-count guidance is gone: it implied schema inlining
                      scaled with tool count, which this setting never did. */}
                  <option value="direct">This agent calls tools itself (default)</option>
                  <option value="sub-agent">Delegate to a sub-agent — it invokes tools and reports back</option>
                  <option value="execute-tool">Minimal meta-tools only — keeps find_tools + execute_tools, drops the rest</option>
                </select>
              </Fieldset>
            </section>

            {/* Sub-agent Configuration (conditional) */}
            {toolsBlockMode === "sub-agent" && (
              <section className="ml-4 border-l-2 border-emerald-500/40 pl-4">
                <Header3>Sub-Agent Configuration</Header3>
                <div className="space-y-3 mt-2">
                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">Sub-agent model</label>
                    <ModelPicker
                      name="subAgentModel"
                      providers={providers}
                      providersPath={providersPath}
                      defaultValue={
                        (agent as any).subAgentConfig?.model || "anthropic:claude-haiku-4-5-20251001"
                      }
                      restrictToModels={[
                        "anthropic:claude-haiku-4-5-20251001",
                        "anthropic:claude-sonnet-4-6",
                        "openai:gpt-4.1-mini",
                        "openai:gpt-oss-120b",
                      ]}
                    />
                  </Fieldset>
                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">Max steps</label>
                    <Input
                      name="subAgentMaxSteps"
                      type="number"
                      min={1}
                      max={30}
                      defaultValue={(agent as any).subAgentConfig?.maxSteps || 10}
                    />
                  </Fieldset>
                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">System prompt (optional, override)</label>
                    <textarea
                      name="subAgentSystemPrompt"
                      rows={3}
                      defaultValue={(agent as any).subAgentConfig?.systemPrompt || ""}
                      placeholder="Leave empty to use Platos default"
                      className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright font-mono resize-y"
                    />
                  </Fieldset>
                </div>
              </section>
            )}

            {/* DYNAMIC section header */}
            <div className="border-t border-charcoal-700 pt-6 mt-8">
              <h2 className="text-sm font-semibold text-text-bright uppercase tracking-wider mb-1">
                Dynamic Configuration
              </h2>
              <p className="text-xs text-text-dimmed mb-4">
                These settings change per conversation — not cached, evaluated at call time.
              </p>
            </div>

            {/* Conversation Context */}
            <section>
              <Header3>Conversation Context</Header3>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Context limit (messages)</label>
                  <Input
                    name="contextLimit"
                    type="number"
                    min={1}
                    max={100}
                    defaultValue={(agent as any).contextLimit ?? 20}
                  />
                  <span className="text-xs text-text-dimmed">How many prior turns to load per message</span>
                </Fieldset>
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">History mode</label>
                  <select
                    name="historyMode"
                    defaultValue={(agent as any).historyMode || "rolling"}
                    className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
                  >
                    <option value="rolling">Rolling — drop oldest past limit</option>
                    <option value="compact">Compact — summarize oldest into a block</option>
                  </select>
                </Fieldset>
              </div>
              <Fieldset className="mt-3">
                <label className="text-xs text-text-dimmed font-medium">Compaction threshold (only if mode = compact)</label>
                <Input
                  name="compactThreshold"
                  type="number"
                  min={5}
                  max={200}
                  defaultValue={(agent as any).compactThreshold ?? 40}
                />
                <span className="text-xs text-text-dimmed">Thread length at which compaction fires</span>
              </Fieldset>
            </section>

            {/* Execution mode (executionMode: in-process vs durable) */}
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
                    className="flex items-start gap-3 rounded border border-charcoal-700 p-3 cursor-pointer hover:border-charcoal-600"
                  >
                    <input
                      type="radio"
                      name="executionMode"
                      value={opt.value}
                      defaultChecked={
                        ((agent as any).executionMode || "direct") === opt.value
                      }
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

            {/* User Profiling */}
            <section>
              <Header3>User Profiling</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                When enabled, the agent maintains a per-user profile (what it knows about the user) and can call update_user_profile / recall_user_profile tools.
              </Paragraph>
              <label className="flex items-center gap-2 mt-3 text-sm text-text-bright">
                <input
                  type="checkbox"
                  name="enableUserProfiling"
                  defaultChecked={(agent as any).enableUserProfiling || false}
                  className="accent-emerald-500"
                />
                Enable user profiling
              </label>
            </section>

            {/* PRA-TC: Threaded conversations toggle */}
            <section>
              <Header3>Threaded conversations</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                Enables Slack-style threading. Users can reply to specific messages in a side panel. Sub-thread replies are included in memory extraction but not injected into the main conversation timeline.
              </Paragraph>
              <label className="flex items-center gap-2 mt-3 text-sm text-text-bright">
                <input
                  type="checkbox"
                  name="enableThreading"
                  defaultChecked={agentEnableThreading}
                  className="accent-emerald-500"
                />
                Enable threaded conversations
              </label>
            </section>

            {/* PRA-AC: Cluster settings */}
            <section>
              <Header3>Agent Cluster</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                Assign this agent to a cluster to share memory and thread history with other agents. All agents in a cluster read from the same user memory pool. Each agent keeps its own model, system prompt, and tools.
              </Paragraph>
              <div className="space-y-2">
                {availableClusters.length === 0 ? (
                  <div className="space-y-1">
                    <Paragraph variant="small" className="text-text-dimmed">
                      No clusters yet.{" "}
                      <a href={`../../agent-clusters`} className="text-emerald-400 hover:underline">
                        Create a cluster
                      </a>{" "}
                      first, then assign this agent here.
                    </Paragraph>
                    {/* Still allow clearing existing assignment */}
                    {agentClusteringId && (
                      <>
                        <Paragraph variant="small" className="text-amber-400">
                          Currently assigned to cluster: <span className="font-mono text-xs">{agentClusteringId}</span>
                        </Paragraph>
                        <input type="hidden" name="clusteringId" value="" />
                        <input type="hidden" name="clusterMode" value="standalone" />
                      </>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label className="block text-xs text-text-dimmed">Cluster membership</label>
                    <select
                      name="clusteringId"
                      defaultValue={agentClusteringId ?? ""}
                      className="w-full max-w-sm rounded border border-charcoal-600 bg-charcoal-900 px-2.5 py-1.5 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      onChange={(e) => {
                        // Set clusterMode based on selection so action handler works correctly
                        const modeInput = e.currentTarget.form?.elements.namedItem("clusterMode") as HTMLInputElement | null;
                        if (modeInput) modeInput.value = e.currentTarget.value ? "cluster" : "standalone";
                      }}
                    >
                      <option value="">Standalone (no cluster)</option>
                      {availableClusters.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>
                      ))}
                    </select>
                    <input type="hidden" name="clusterMode" defaultValue={agentClusteringId ? "cluster" : "standalone"} />
                    <Paragraph variant="small" className="text-text-dimmed">
                      Changing cluster membership takes effect on the next conversation turn.
                    </Paragraph>
                  </div>
                )}
              </div>
            </section>

            {/* Theme O.2 — Memory extraction policy. */}
            <section>
              <details>
                <summary className="cursor-pointer">
                  <Header3 className="inline">Memory extraction</Header3>
                </summary>
                <Paragraph variant="small" className="mt-2 mb-3 text-text-dimmed">
                  Controls the background pass that reads conversations and writes durable memories. Defaults: enabled, all kinds, confidence 0.6, 10 per session, 6 min messages.
                </Paragraph>
                {(() => {
                  const ep = ((agent as any).extractionPolicy as null | {
                    enabled?: boolean;
                    kinds?: string[];
                    confidenceThreshold?: number;
                    maxPerSession?: number;
                    minMessagesBeforeRun?: number;
                  }) || null;
                  const enabledDefault = ep?.enabled ?? true;
                  const kindsDefault = ep?.kinds ?? ["fact", "preference", "event", "relationship"];
                  const threshold = ep?.confidenceThreshold ?? 0.6;
                  const maxPer = ep?.maxPerSession ?? 10;
                  const minMsg = ep?.minMessagesBeforeRun ?? 6;
                  const allKinds = ["fact", "preference", "event", "relationship"];
                  return (
                    <div className="mt-3 space-y-3">
                      <label className="flex items-center gap-2 text-sm text-text-bright">
                        <input
                          type="checkbox"
                          name="extract_enabled"
                          defaultChecked={enabledDefault}
                          className="accent-amber-500"
                        />
                        Enable automatic extraction
                      </label>
                      <div className="flex flex-wrap gap-3 text-sm">
                        {allKinds.map((k) => (
                          <label key={k} className="flex items-center gap-2 text-text-bright">
                            <input
                              type="checkbox"
                              name="extract_kind"
                              value={k}
                              defaultChecked={kindsDefault.includes(k)}
                              className="accent-amber-500"
                            />
                            {k}
                          </label>
                        ))}
                      </div>
                      <Fieldset>
                        <label className="text-xs text-text-dimmed font-medium">
                          Confidence threshold (0–1) — default 0.6
                        </label>
                        <Input
                          name="extract_confidenceThreshold"
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          defaultValue={threshold}
                        />
                      </Fieldset>
                      <Fieldset>
                        <label className="text-xs text-text-dimmed font-medium">
                          Max memories per extraction pass — default 10
                        </label>
                        <Input
                          name="extract_maxPerSession"
                          type="number"
                          min={1}
                          max={100}
                          defaultValue={maxPer}
                        />
                      </Fieldset>
                      <Fieldset>
                        <label className="text-xs text-text-dimmed font-medium">
                          Minimum messages before a run — default 6
                        </label>
                        <Input
                          name="extract_minMessagesBeforeRun"
                          type="number"
                          min={1}
                          max={200}
                          defaultValue={minMsg}
                        />
                      </Fieldset>
                    </div>
                  );
                })()}
              </details>
            </section>

            {/* Dynamic Blocks */}
            <section>
              <Header3>Dynamic Blocks</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                Declare keys the frontend can provide at request time (e.g., current_screen, active_entity). These get injected into every message's context.
              </Paragraph>
              <div className="space-y-2 mt-3">
                {dynamicBlocks.map((b, i) => (
                  <div
                    key={i}
                    className="rounded border border-charcoal-700 bg-charcoal-800 p-3 flex items-start gap-3"
                  >
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <input
                        placeholder="key (e.g., current_screen)"
                        value={b.key}
                        onChange={(e) => updateBlock(i, { key: e.target.value })}
                        className="rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                      />
                      <input
                        placeholder="display name"
                        value={b.name}
                        onChange={(e) => updateBlock(i, { name: e.target.value })}
                        className="rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                      />
                      <textarea
                        placeholder="default content"
                        rows={2}
                        value={b.defaultContent}
                        onChange={(e) => updateBlock(i, { defaultContent: e.target.value })}
                        className="col-span-2 rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright font-mono resize-y"
                      />
                      <input
                        placeholder="description (optional)"
                        value={b.description || ""}
                        onChange={(e) => updateBlock(i, { description: e.target.value })}
                        className="col-span-2 rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                      />
                    </div>
                    <button type="button" onClick={() => removeBlock(i)} className="p-1">
                      <TrashIcon className="size-4 text-red-400" />
                    </button>
                  </div>
                ))}
              </div>
              <Button
                variant="tertiary/small"
                type="button"
                onClick={addBlock}
                className="mt-3"
                LeadingIcon={PlusIcon}
              >
                Add dynamic block
              </Button>
              <input type="hidden" name="dynamicBlocksJson" value={JSON.stringify(dynamicBlocks)} />
            </section>

            {/* Memory */}
            <section>
              <Header3>Memory</Header3>
              <div className="mt-3 space-y-2">
                <label className="flex items-center gap-2 text-sm text-text-bright">
                  <input type="checkbox" name="memory_conversation" defaultChecked={true} disabled className="accent-emerald-500" />
                  Conversation History (always on)
                </label>
                <label className="flex items-center gap-2 text-sm text-text-bright">
                  <input type="checkbox" name="memory_working" defaultChecked={true} disabled className="accent-emerald-500" />
                  Working Memory (always on)
                </label>
                <label className="flex items-center gap-2 text-sm text-text-bright">
                  <input type="checkbox" name="memory_semantic" defaultChecked={agent.memoryConfig?.semantic?.enabled || false} className="accent-emerald-500" />
                  Semantic Memory (remember facts across conversations)
                </label>
                <label className="flex items-center gap-2 text-sm text-text-bright">
                  <input type="checkbox" name="memory_graph" defaultChecked={agent.memoryConfig?.graph?.enabled || false} className="accent-emerald-500" />
                  Knowledge Graph (entity extraction + relationship tracking)
                </label>
              </div>
            </section>

            {/* PIFSP-1 — Integration panel */}
            <IntegrationPanel agentId={(agent as any).id ?? ""} />

            {/* Max Steps */}
            <section>
              <Header3>Limits</Header3>
              <div className="mt-3">
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Max Steps per Turn</label>
                  <Input name="maxSteps" type="number" defaultValue={agent.maxSteps} min={1} max={50} />
                </Fieldset>
              </div>
            </section>

            <FormButtons
              confirmButton={
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    variant="primary/medium"
                    disabled={isSavingConfig}
                  >
                    {isSavingConfig ? "Saving…" : "Save Configuration"}
                  </Button>
                  {mainNavigation.state === "idle" && mainActionData?.success && (
                    <span className="text-xs text-emerald-400">Saved.</span>
                  )}
                  {mainNavigation.state === "idle" && mainActionData?.error && (
                    <span className="text-xs text-rose-400">
                      {mainActionData.error}
                    </span>
                  )}
                </div>
              }
            />
          </div>
        </Form>

        {/* PIFSP-7: Context mapping → agents.$agentId.context/route.tsx */}

        {/* Feature Flags (Theme G.7) — separate form so it can POST to the
            dedicated feature-flags endpoint without touching the main agent
            config save path. */}
        <section className="max-w-2xl mt-10 border-t border-charcoal-700 pt-6">
          <Header3>Feature Flags</Header3>
          <Paragraph variant="small" className="mt-1 mb-3">
            Per-agent boolean switches. Gate experimental meta-tools or
            behaviour per agent — the runtime reads{" "}
            <code className="font-mono text-xs">config.featureFlags</code> at
            every turn.
          </Paragraph>

          <flagsFetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="set-feature-flags" />
            <input
              type="hidden"
              name="featureFlagsJson"
              value={JSON.stringify(featureFlags)}
            />

            {flagEntries.length === 0 && (
              <p className="text-xs italic text-text-dimmed">
                No feature flags defined yet. Add one below.
              </p>
            )}

            <ul className="space-y-2">
              {flagEntries.map(([key, value]) => (
                <li
                  key={key}
                  className="flex items-center gap-3 rounded-md border border-charcoal-700 bg-charcoal-900/40 px-3 py-2"
                >
                  <label className="flex flex-1 items-center gap-3 text-sm text-text-bright">
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => toggleFlag(key, e.target.checked)}
                      className="accent-emerald-500"
                    />
                    <span className="font-mono">{key}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeFlag(key)}
                    className="p-1"
                    aria-label={`Remove ${key}`}
                  >
                    <TrashIcon className="size-4 text-red-400" />
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center gap-2">
              <input
                placeholder="flag_key (e.g. enable_code_interpreter)"
                value={newFlagKey}
                onChange={(e) => setNewFlagKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addFlag();
                  }
                }}
                className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-1.5 text-sm text-text-bright font-mono"
              />
              <Button
                type="button"
                variant="tertiary/small"
                LeadingIcon={PlusIcon}
                onClick={addFlag}
              >
                Add flag
              </Button>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <Button
                type="submit"
                variant="primary/small"
                disabled={flagsFetcher.state !== "idle"}
              >
                {flagsFetcher.state !== "idle" ? "Saving…" : "Save flags"}
              </Button>
              {flagsFetcher.data?.success && (
                <span className="text-xs text-emerald-400">Saved.</span>
              )}
              {flagsFetcher.data?.error && (
                <span className="text-xs text-red-400">
                  {flagsFetcher.data.error}
                </span>
              )}
            </div>
          </flagsFetcher.Form>
        </section>

        {/* MC.4 — per-agent cache hit rate. Reads the Redis per-agent daily
            counters via /monitoring/agent/:agentId/cache-range?days=7. A
            single sparkline + one headline number is enough — deeper cost
            analytics live on the agent-monitoring page. Section only
            renders when the agent service is reachable; renders a neutral
            empty state when there's no cache activity yet. */}
        <section className="max-w-2xl mt-10 border-t border-charcoal-700 pt-6">
          <Header3>Cache Hit Rate (last 7 days)</Header3>
          <Paragraph variant="small" className="mt-1 mb-3">
            Anthropic prompt-cache telemetry — `cache_read /
            (cache_read + cache_creation + input)`. Higher is better;
            cache hits are billed at 10% of the normal input rate.
          </Paragraph>
          <CacheHitRateSection cacheRange={cacheRange} model={agent.model} />
        </section>
    </PageBody>
  );
}

// ═══════════════════════════════════════════════════════
// MC.4 — Cache hit rate section
// ═══════════════════════════════════════════════════════

function CacheHitRateSection({
  cacheRange,
  model,
}: {
  cacheRange: CacheRangePayload | null;
  model?: string | null;
}) {
  if (!cacheRange) {
    return (
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4 text-xs text-text-dimmed">
        Cache metrics unavailable — agent service not reachable.
      </div>
    );
  }
  const totalRead = cacheRange.cacheReadInputTokens;
  const totalCreated = cacheRange.cacheCreationInputTokens;
  const totalInput = cacheRange.inputTokens;
  const denom = totalRead + totalCreated + totalInput;
  const hitRatePct = denom > 0 ? (totalRead / denom) * 100 : 0;

  if (denom === 0) {
    return (
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4 text-xs text-text-dimmed">
        No traffic recorded for this agent in the last 7 days. Cache hit rate
        will appear here once the agent starts taking turns.
      </div>
    );
  }

  // PRELAUNCH-A1-2 / A1-9 — provider-aware cache savings calc. Anthropic's
  // 90% discount was previously hard-coded as `* 0.9`, which over-reported
  // savings by 1.8× on OpenAI and 1.2× on Gemini. Resolve the discount
  // factor (1 − read multiplier) per provider.
  const cacheRates = cacheRatesFor(model);
  const cacheDiscountFactor = 1 - cacheRates.read;
  const savingsCents =
    totalRead > 0 && totalInput > 0
      ? // back into the avg input rate from naiveCents / inputTokens
        (totalRead / 1_000_000) *
        ((cacheRange.costCents / totalInput) * 1_000_000) *
        cacheDiscountFactor
      : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-6 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
        <div>
          <p className="text-xs text-text-dimmed">Hit rate</p>
          <p className="font-mono text-2xl text-text-bright">
            {hitRatePct.toFixed(1)}%
          </p>
        </div>
        <div>
          <p className="text-xs text-text-dimmed">Read tokens</p>
          <p className="font-mono text-sm text-text-bright">
            {totalRead.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-dimmed">Written tokens</p>
          <p className="font-mono text-sm text-text-bright">
            {totalCreated.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-dimmed">Savings</p>
          <p className="font-mono text-sm text-emerald-300">
            {savingsCents > 0
              ? savingsCents < 100
                ? `$${(savingsCents / 100).toFixed(4)}`
                : `$${(savingsCents / 100).toFixed(2)}`
              : "$0.00"}
          </p>
        </div>
      </div>
      <CacheHitSparkline perDay={cacheRange.perDay} />
    </div>
  );
}

function CacheHitSparkline({
  perDay,
}: {
  perDay: CacheRangePayload["perDay"];
}) {
  if (!perDay || perDay.length === 0) return null;
  // oldest → newest for a left-to-right reading
  const days = [...perDay].reverse();
  const maxRate = Math.max(
    1,
    ...days.map((d) => {
      const denom = d.cacheReadInputTokens + d.cacheCreationInputTokens + d.inputTokens;
      return denom > 0 ? (d.cacheReadInputTokens / denom) * 100 : 0;
    }),
  );
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
      <p className="mb-2 text-xs text-text-dimmed">Hit rate per day (%)</p>
      <div className="flex h-16 items-end gap-1">
        {days.map((d) => {
          const denom =
            d.cacheReadInputTokens + d.cacheCreationInputTokens + d.inputTokens;
          const rate = denom > 0 ? (d.cacheReadInputTokens / denom) * 100 : 0;
          const h = Math.max(2, Math.round((rate / maxRate) * 60));
          return (
            <div
              key={d.date}
              className="flex flex-1 flex-col items-center gap-1"
            >
              <div
                className="w-full rounded-sm bg-emerald-500/60 hover:bg-emerald-400"
                style={{ height: `${h}px` }}
                title={`${d.date}: ${rate.toFixed(1)}% (read=${d.cacheReadInputTokens.toLocaleString()}, written=${d.cacheCreationInputTokens.toLocaleString()}, input=${d.inputTokens.toLocaleString()})`}
              />
              <span className="text-[9px] text-text-dimmed">
                {d.date.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── PIFSP-1 — Integration panel ─────────────────────────────────────────

function IntegrationPanel({ agentId }: { agentId: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  if (!agentId) return null;

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const wsUrl = `wss://<your-platos-host>/agent/${agentId}`;
  const sseUrl = `/api/v1/agent/agents/${agentId}/chat/stream?threadId=<id>&message=<text>`;
  const restUrl = `POST /api/v1/agent/agents/${agentId}/messages`;
  const mintCurl = `curl -X POST https://<host>/api/v1/entities/<entityId>/session-tokens \\
  -H "Authorization: Bearer <serviceSecret>" \\
  -H "Content-Type: application/json" \\
  -d '{"userId":"<end-user-id>","agentId":"${agentId}","expiresIn":3600}'`;

  const slackSnippet = `import { App } from "@slack/bolt";
import { io } from "socket.io-client";

const app = new App({ /* ... */ });

app.message(async ({ message, say }) => {
  // Mint a session token from your backend
  const { sessionToken } = await mintToken({ userId: message.user, agentId: "${agentId}" });

  // Connect to the per-agent Socket.IO namespace
  const sock = io("wss://<host>/agent/${agentId}", { auth: { sessionToken } });
  let reply = "";
  sock.on("connect", () => {
    sock.emit("message", { message: message.text, agentId: "${agentId}" });
  });
  sock.on("agent_event", (e) => {
    if (e.type === "token") reply += e.text;
    if (e.type === "done") { say(reply); sock.disconnect(); }
  });
});`;

  const urlRow = (key: string, label: string, value: string) => (
    <div key={key} className="flex items-center gap-2 py-1.5 border-b border-charcoal-700/50 last:border-0">
      <span className="text-xs text-text-dimmed w-24 flex-shrink-0">{label}</span>
      <code className="text-xs font-mono text-emerald-300 flex-1 truncate">{value}</code>
      <button
        type="button"
        onClick={() => copy(key, value)}
        className="flex-shrink-0 text-text-dimmed hover:text-text-bright"
        title="Copy"
      >
        <ClipboardDocumentIcon className="size-3.5" />
      </button>
      {copied === key && <span className="text-xs text-emerald-400 flex-shrink-0">Copied!</span>}
    </div>
  );

  return (
    <section className="border border-charcoal-700 rounded-lg p-4 bg-charcoal-800/20">
      <Header3>Integration</Header3>
      <Paragraph variant="small" className="mt-1 mb-3 text-text-dimmed">
        Mint a session token from your entity backend, then use any of these URLs to drive this agent from your app.
      </Paragraph>

      <div className="space-y-1 mb-4">
        {urlRow("ws", "Socket.IO", wsUrl)}
        {urlRow("sse", "SSE stream", sseUrl)}
        {urlRow("rest", "HTTP REST", restUrl)}
      </div>

      <div className="mb-4">
        <p className="text-xs font-medium text-text-dimmed mb-1.5">Session token (agent-scoped)</p>
        <div className="relative">
          <pre className="text-xs font-mono text-text-bright bg-charcoal-900 rounded p-3 overflow-x-auto whitespace-pre-wrap">{mintCurl}</pre>
          <button
            type="button"
            onClick={() => copy("mint", mintCurl)}
            className="absolute top-2 right-2 text-text-dimmed hover:text-text-bright"
          >
            <ClipboardDocumentIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-text-dimmed hover:text-text-bright">
          Slack bot quick start ›
        </summary>
        <div className="mt-2 relative">
          <pre className="text-xs font-mono text-text-bright bg-charcoal-900 rounded p-3 overflow-x-auto whitespace-pre-wrap">{slackSnippet}</pre>
          <button
            type="button"
            onClick={() => copy("slack", slackSnippet)}
            className="absolute top-2 right-2 text-text-dimmed hover:text-text-bright"
          >
            <ClipboardDocumentIcon className="size-3.5" />
          </button>
        </div>
      </details>
    </section>
  );
}

