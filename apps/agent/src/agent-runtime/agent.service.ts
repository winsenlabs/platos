import { Injectable, Inject, Optional, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  streamText,
  generateText,
  streamObject,
  generateObject,
  isStepCount,
  jsonSchema as aiJsonSchema,
  type ModelMessage,
  type Tool,
} from "ai";
// AI SDK v6 — `CoreMessage` renamed to `ModelMessage`, `CoreTool` renamed to
// `Tool`. Aliasing locally to avoid a sweeping rename across the file.
type CoreMessage = ModelMessage;
type CoreTool = Tool;
import {
  resolveTurnSchema,
  validateAgainstSchema,
  buildRetryCorrectionMessage,
  StructuredOutputError,
  type OutputSchemaInput,
  type NormalizedSchema,
} from "./structured-output";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { makeRetryFetch, DEFAULT_RETRY_RULES, type RetryRule } from "./retry-fetch";
import { hardenToolResults } from "./tool-result-sanitizer";
import { z } from "zod";
import * as crypto from "crypto";
import type { RequestScope } from "../auth/scope.guard";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { pickExternalId } from "../shared/end-user-id";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { ToolRouterService } from "../tool-gateway/tool-router.service";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { SkillRuntimeService } from "../skills/skill-runtime.service";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { approvalRedisKey } from "../monitoring/approval-keys";
import { CostService } from "../monitoring/cost.service";
import { SpansService } from "../monitoring/spans.service";
// Theme L — pgvector-backed semantic memory + knowledge-graph services.
// Both are @Optional so the existing unit-test harness that constructs
// AgentService directly without MemoryModule still boots; in production
// AgentRuntimeModule imports MemoryModule so they're always present.
import { MemoryService } from "../memory/memory.service";
import { KnowledgeGraphService } from "../memory/knowledge-graph.service";
import { fuseContextRetrieval } from "../memory/retrieval/context-retrieval";
// Theme O — memory extraction service for the manual `memory_extract`
// meta-tool. Optional so the unit-test harness without MemoryModule still
// boots.
import { MemoryExtractionService, resolveExtractionPolicy } from "../memory/memory-extraction.service";
// Theme M.3 — Redis projection cache for per-user profile reads. Optional
// for the same reason (test harness).
import { ProfileCacheService } from "../memory/profile-cache.service";
// W.1.2 — RunsBridgeService forwards trigger.dev run realtime events
// (including `metadata.progress` frames emitted by `platos-agent-batch`)
// into the spawning thread's Socket.IO room as `run_update` agent events.
// Injected via forwardRef because TriggerBridgeModule already imports
// AgentRuntimeModule for `/internal/batch-turn` access to AgentTaskService.
// W.1.2 — RunsBridgeService is NOT imported at module top level. A top-level
// import triggers a CJS require cycle: connections.gateway ← agent-task.service
// ← agent.service ← runs-bridge.service ← connections.gateway (partial),
// causing `design:paramtypes` metadata on RunsBridgeService to capture
// `ConnectionsGateway = undefined` → runtime DI failure with
// "argument at index [0] appears to be undefined at runtime". Use
// `import type` for TypeScript checking and `require(...)` inside
// getRunsBridge() after all modules are loaded.
import type { RunsBridgeService } from "../trigger-bridge/runs-bridge.service";
import {
  AttachmentsService,
  type ResolvedAttachment,
} from "./attachments.service";
import { PiiFilterService, type GovernanceConfig } from "../governance/pii-filter.service";
import {
  canRouteNatively,
  textFallbackDescription,
} from "./multimodal-adapter";
import { env } from "../shared/env";
import {
  SUBAGENT_MAX_DEPTH,
  isSpawnDepthAllowed,
  childSpawnDepth,
  normalizeSpawnDepth,
  narrowSpawnToolAcl,
  resolveMaxChildrenPerTurn,
  spawnDedupeKey,
} from "./subagent-guardrails";
import { type ArtifactKind } from "./artifact-meta";
// Theme CTX.2 — session-context auto-injection helpers. All fail-open on
// missing config so existing turns (no sessionContext / no contextMapping)
// keep their current behavior end-to-end.
import {
  buildEnvelope as buildCtxEnvelope,
  filterByEntityIds as filterToolsByEntityIds,
  injectArgs as injectCtxArgs,
  normalizeContextMapping,
  resolvePath as resolveCtxPath,
  substitutePromptVars,
  type ContextMapping,
} from "./context-resolver";
// Theme CTX.6 — 4-tier arg-resolution + auto-match + LLM-fill prompt hint.
// The resolver walks the agent's enabled tools once per turn and emits:
//   (a) a system-prompt block telling the LLM what args it must provide for
//       each tool that still has LLM-fill params after auto-injection.
//   (b) a per-tool resolution table consumed by the tool-executor to strip
//       injected args from the schema + inject constants/session values.
// Both hook points are append-only / cache-friendly — the block text is
// stable across turns that share the same (agent config × tool set × session
// key-set), so Anthropic prompt caching continues to hit.
import {
  buildLlmHintBlock as buildCtxLlmHintBlock,
  resolveToolMappings as resolveCtxToolMappingsForHint,
  type AgentContextMapping,
  type ResolvedTool,
} from "./context-automap.service";
// TL.2 — display-mode renderer for the "## Available tool categories" block.
// Pure fn; kept in prompt-builder.service so tests don't need the full Nest
// harness to verify the rendering.
import {
  renderCategorySummaryBlock,
  renderMemoryGuidanceBlock,
} from "./prompt-builder.service";
import type { PromptBuilderService } from "./prompt-builder.service";

// Trigger.dev SDK — used by `spawn_bgo` and related meta-tools.
// The API key is resolved per-scope from RuntimeEnvironment.apiKey so
// no TRIGGER_SECRET_KEY env var is needed. Platos IS trigger.dev —
// the webapp is the trigger.dev API; the agent talks to it directly
// using the environment's own key looked up from the shared DB.
const moduleLogger = new Logger("AgentService");
let triggerSdk: any = null;
// triggerConfigured is now always true — clients are built on demand.
const triggerConfigured = true;
try {
  triggerSdk = require("@trigger.dev/sdk");
  moduleLogger.log("[trigger.sdk] loaded — API keys resolved per-scope from DB");
} catch (err: any) {
  moduleLogger.warn("[trigger.sdk] not available:", err?.message);
}

// Cache of per-environment ApiClient instances (keyed by environmentId).
// Avoids a DB round-trip on every spawn_bgo call while still respecting
// per-environment key isolation.
const _triggerClientCache = new Map<string, any>();

async function getScopedTriggerClient(prisma: any, environmentId: string): Promise<any | null> {
  if (_triggerClientCache.has(environmentId)) {
    return _triggerClientCache.get(environmentId)!;
  }
  try {
    const env = await prisma.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: { apiKey: true },
    });
    if (!env?.apiKey) return null;
    const baseURL = process.env.TRIGGER_API_URL || "http://webapp:3030";
    const { ApiClient } = require("@trigger.dev/core");
    const client = new ApiClient(baseURL, env.apiKey);
    _triggerClientCache.set(environmentId, client);
    moduleLogger.log(`[trigger.sdk] resolved API key for env ${environmentId.slice(0, 12)}…`);
    return client;
  } catch (err: any) {
    moduleLogger.warn("[trigger.sdk] failed to resolve API key for env " + environmentId + ":", err?.message);
    return null;
  }
}

/**
 * Model provider registry — maps model strings to Vercel AI SDK providers.
 * User picks the model, no auto-escalation.
 */
/**
 * Model provider registry — maps model strings to Vercel AI SDK providers.
 *
 * Supported formats:
 *   "anthropic:claude-sonnet-4-6"
 *   "openai:gpt-4.1"
 *   "openai:gpt-oss-120b"
 *   "google:gemini-2.5-pro"               Google AI Studio — simple API key
 *   "google-vertex:gemini-2.5-pro"        Vertex AI — service account JSON
 *   "google-vertex:gemini-2.5-flash-001"
 *
 * For Vertex AI (google-vertex:), `apiKey` is the FULL content of a GCP
 * service-account JSON file stored as a string in the SecretStore under
 * GOOGLE_VERTEX_CREDENTIALS. No file path or container volume needed.
 * GOOGLE_VERTEX_PROJECT and GOOGLE_VERTEX_LOCATION are also read from the
 * scoped env / process.env (project extracted from the JSON when available).
 */
/**
 * Resolve a model string to a Vercel AI SDK LanguageModelV1. When an `apiKey`
 * is supplied (the normal case — sourced from the scoped env-var resolver),
 * constructs a per-scope provider client so the key bypasses `process.env`
 * entirely. Without an apiKey (e.g. ambient dev use), falls back to the
 * default singleton which reads `process.env`.
 */
// OpenAI-compatible providers that we proxy through `createOpenAI` with a
// custom `baseURL`. Mirrors `manifests/index.ts` — keep in sync.
const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  cerebras: "https://api.cerebras.ai/v1",
  perplexity: "https://api.perplexity.ai",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  // Sakana Fugu — multi-agent orchestration model (Fugu + Fugu Ultra) served
  // OpenAI-compatible. NOTE: Fugu orchestrates across a pool of frontier models
  // server-side BEFORE it streams, so first-token latency can be tens of
  // seconds (fugu) to minutes (fugu-ultra). The retry-aware fetch below + the
  // per-turn PLATOS_TURN_MAX_MS budget must be generous for fugu-ultra. Not
  // available in EU/EEA/UK/CH (geo-blocked upstream).
  sakana: "https://api.sakana.ai/v1",
};

function resolveModel(modelString: string, apiKey?: string, retryRules?: RetryRule[]) {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  const model = colonIdx > 0 ? modelString.slice(colonIdx + 1) : modelString;

  // LAUNCH-2 — every provider client gets a retry-aware fetch. Honors
  // `Retry-After` on 429s, exp-backoff on 5xx, fail-fast on auth errors. If
  // the agent passes its own rules, those win; else use sensible defaults.
  const retryFetch = makeRetryFetch(retryRules ?? DEFAULT_RETRY_RULES);

  // OpenAI-compatible upstreams (Groq, Mistral, xAI, DeepSeek, Cerebras,
  // Perplexity, Together, Fireworks) all speak the same `/v1/chat/completions`
  // shape, so one branch covers them — only the baseURL + apiKey differ.
  if (OPENAI_COMPAT_BASE_URLS[provider]) {
    // AI SDK v6: `createOpenAI(...)(model)` defaults to the OpenAI Responses
    // API (/v1/responses), which these third-party providers don't implement.
    // Use `.chat(model)` to pin chat/completions.
    return apiKey
      ? createOpenAI({ baseURL: OPENAI_COMPAT_BASE_URLS[provider], apiKey, fetch: retryFetch }).chat(model)
      : createOpenAI({ baseURL: OPENAI_COMPAT_BASE_URLS[provider], fetch: retryFetch }).chat(model);
  }

  switch (provider) {
    case "anthropic":
      return apiKey ? createAnthropic({ apiKey, fetch: retryFetch })(model) : anthropic(model);
    case "openai":
      return apiKey ? createOpenAI({ apiKey, fetch: retryFetch })(model) : openai(model);
    case "azure": {
      // Azure OpenAI deployments are reached via a per-resource baseURL of
      // the form `https://<resource>.openai.azure.com/openai/deployments/<deployment>`.
      // The user supplies the full URL via AZURE_OPENAI_BASE_URL and the model
      // string is the deployment name. Auth header is `api-key` (set by
      // createOpenAI when the host is azure.com — the SDK auto-detects this).
      if (!apiKey) {
        throw new Error("azure: AZURE_OPENAI_API_KEY required.");
      }
      const azureBase = process.env.AZURE_OPENAI_BASE_URL;
      if (!azureBase) {
        throw new Error(
          "azure: AZURE_OPENAI_BASE_URL must be set (e.g. https://<resource>.openai.azure.com).",
        );
      }
      // AI SDK v6 — `compatibility` option removed from OpenAIProviderSettings.
      // Azure's `api-key` header + per-resource baseURL are still honored;
      // the SDK now auto-detects Azure-shape responses from the URL pattern.
      return createOpenAI({
        baseURL: azureBase.replace(/\/$/, ""),
        apiKey,
        headers: { "api-key": apiKey },
        fetch: retryFetch,
      })(model);
    }
    case "google":
      return apiKey ? createGoogleGenerativeAI({ apiKey, fetch: retryFetch })(model) : google(model);
    case "google-vertex": {
      // apiKey is the full service-account JSON string stored in
      // GOOGLE_VERTEX_CREDENTIALS. Parse it to extract project + credentials.
      // Falls back to ambient ADC (gcloud auth / GOOGLE_APPLICATION_CREDENTIALS)
      // when no explicit credentials are provided (local dev convenience).
      if (!apiKey) {
        // Ambient ADC fallback — reads GOOGLE_VERTEX_PROJECT + GOOGLE_VERTEX_LOCATION
        // from process.env (e.g. set in docker-compose for local dev).
        return createVertex({})(model);
      }
      let creds: { project_id?: string; client_email?: string; private_key?: string };
      try {
        creds = JSON.parse(apiKey) as typeof creds;
      } catch {
        throw new Error(
          "google-vertex: GOOGLE_VERTEX_CREDENTIALS must be the full contents of a GCP " +
          "service account JSON file. Download it from GCP Console → IAM → Service Accounts " +
          "→ Keys → Create key (JSON), then paste the file content as the env var value.",
        );
      }
      const location =
        process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1";
      // Note: `@ai-sdk/google-vertex` 1.0.x doesn't accept a custom `fetch` —
      // it builds requests through google-auth-library which has its own
      // retry stack. Skipping retryFetch here is OK: Vertex's auth layer
      // already handles 5xx backoff + token refresh on 401.
      return createVertex({
        project: creds.project_id,
        location,
        googleAuthOptions: {
          credentials: {
            client_email: creds.client_email ?? "",
            // private_key may have literal \n sequences from env var encoding.
            private_key: (creds.private_key ?? "").replace(/\\n/g, "\n"),
          },
        },
      })(model);
    }
    default:
      throw new Error(
        `Unknown model provider: "${provider}". ` +
        `Supported: anthropic:, openai:, azure:, google:, google-vertex:, ` +
        `groq:, mistral:, xai:, deepseek:, cerebras:, perplexity:, together:, fireworks:`,
      );
  }
}

/** Canonical env-var name per provider. Mirrors `manifests/index.ts`. */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "google-vertex": "GOOGLE_VERTEX_CREDENTIALS",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  sakana: "SAKANA_API_KEY",
};

/** Which env-var holds the API key for each provider. */
function apiKeyEnvVarFor(modelString: string): string | undefined {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  return PROVIDER_API_KEY_ENV[provider];
}

/**
 * Streaming event protocol — discriminated union of every event the agent
 * emits over WebSocket / SSE. Keep this in sync with `@platos/react-hooks`
 * (mirrored in B.11). Do not add untyped fields; add a new variant instead.
 */
export type AgentStreamEvent =
  | { type: "status"; status: "connected" | "thinking" | "executing" | "generating"; agentId?: string }
  | { type: "meta"; thread_id?: string; agent_id?: string; usage?: AgentTokenUsage }
  | { type: "token"; text: string }
  | { type: "message_boundary" }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      name: string;
      params: Record<string, unknown>;
      callId: string;
    }
  | {
      type: "tool_result";
      name: string;
      result: unknown;
      callId: string;
      /** Optional UI hint produced by the tool (see PLATOS_SPEC §4.1). */
      display?: AgentDisplayHint;
    }
  | {
      type: "approval_needed";
      approvalId: string;
      action: string;
      details?: string;
      agentId?: string;
    }
  | {
      type: "safety_flags";
      flags: AgentSafetyFlag[];
    }
  | {
      type: "error";
      message: string;
      /** Populated on input-safety failures. */
      flags?: AgentSafetyFlag[];
      /**
       * Theme F.5 — structured-output failure payload. Present only when the
       * error stems from `StructuredOutputError` so UIs can render the
       * validation errors distinctly from generic runtime failures.
       *
       * PPR-65 — `provider_unavailable` is emitted when the selected model's
       * provider is not linked / env-ready for the current scope. The UI
       * can then prompt the user to link provider env vars instead of
       * showing a generic LLM error.
       */
      code?:
        | "structured_output_invalid"
        | "provider_unavailable"
        | "ENTITY_IDS_REQUIRED"
        | "rate_limit"
        | "budget_cap";
      validationErrors?: string[];
      attempts?: number;
      /** Populated on `provider_unavailable` errors. */
      model?: string;
      providerId?: string;
      /**
       * Rate-limit metadata. Populated when `code === "rate_limit"`.
       * `scope` distinguishes which bucket tripped so the UI can
       * choose between "wait and retry" and "wait until reset" copy.
       */
      retryAfterSeconds?: number;
      scope?: "user_per_minute" | "user_per_hour" | "user_per_day" | "org_per_minute" | "org_per_day";
      limit?: number;
    }
  | {
      /**
       * Theme F.5 — emitted after structured-output enforcement succeeds.
       * Carries the validated JSON object. The streaming path also emits
       * incremental `token` events for the raw JSON text so legacy
       * consumers keep working.
       */
      type: "structured_output";
      object: unknown;
      attempts: number;
    }
  | {
      /**
       * Theme F.7 — emitted when `generate_artifact` or `revise_artifact`
       * begins writing an artifact row. Consumers use this to open a
       * placeholder bubble in the UI before the content lands.
       *
       * `artifactId` is provisional: on `generate_artifact` this is a
       * client-generated pending id until the row commits; on
       * `revise_artifact` the service emits the resolved latest-revision
       * id so the UI can pin the stream to an existing artifact.
       */
      type: "artifact_start";
      artifactId: string;
      artifactKey: string;
      kind: ArtifactKind;
      revision: number;
      title?: string;
      language?: string;
      /** `generate` = new artifact (rev 1); `revise` = appends to existing key. */
      op: "generate" | "revise";
    }
  | {
      /**
       * Theme F.7 — content chunk for a streaming artifact. The current
       * meta-tools write the whole content in one shot, so we emit a
       * single-chunk `artifact_delta` mirroring the final content. Future
       * work can emit incremental deltas as the model streams artifact
       * body (F-follow-up).
       */
      type: "artifact_delta";
      artifactId: string;
      artifactKey: string;
      chunk: string;
    }
  | {
      /**
       * Theme F.7 — emitted once the artifact row is persisted. Carries
       * the canonical ids + the final content so consumers that missed a
       * `delta` event still render the completed artifact correctly.
       */
      type: "artifact_committed";
      artifactId: string;
      artifactKey: string;
      kind: ArtifactKind;
      revision: number;
      title?: string;
      language?: string;
      finalContent: string;
      createdAt: string;
    }
  | {
      /**
       * Theme F.7 — emitted when the artifact meta-tool fails (invalid
       * kind, content violates safety checks, scope check failed, etc.).
       * `artifactId` + `artifactKey` are populated when the failure
       * happened after identifying the target artifact.
       */
      type: "artifact_error";
      artifactId?: string;
      artifactKey?: string;
      code: "invalid_kind" | "invalid_content" | "not_found" | "scope_mismatch" | "persist_failed";
      message: string;
    }
  | {
      /**
       * PPR-26 — realtime trigger.dev run update forwarded by
       * RunsBridgeService into the thread + scope Socket.IO rooms. The
       * meta-tool (`spawn_bgo`, formerly `spawn_task`) hands out the
       * `runId`; consumers who want a progress UI subscribe via
       * `join_thread` and filter by `runId`.
       */
      type: "run_update";
      runId: string;
      status: string;
      metadata?: Record<string, unknown> | null;
      output?: unknown;
      error?: unknown;
    }
  | { type: "done"; usage?: AgentTokenUsage; stopped?: boolean }
  // EOBD.106 — keep-alive tick injected by the SSE controller's
  // heartbeat wrapper during long tool-step idle gaps. Clients render
  // nothing; exists purely to keep reverse-proxy idle timers from
  // closing the response.
  | { type: "heartbeat"; at: number };

export interface AgentTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  costCents?: number;
  /** Legacy aliases kept for the streaming protocol — the consumer SDK
   * mirrors both. Prefer `promptTokens` / `completionTokens`. */
  inputTokens?: number;
  outputTokens?: number;
  /** MC.1 — Anthropic prompt-cache telemetry, surfaced by Vercel AI SDK under
   * `providerMetadata.anthropic.{cacheCreationInputTokens,
   * cacheReadInputTokens}` on step-finish + final-finish events. Callers
   * accumulate these across steps so the agent-task layer can persist them
   * onto the assistant message row and fan them out to the Redis dashboard
   * counters. Absent on non-Anthropic providers; treat `undefined` === 0. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /**
   * PRELAUNCH-A1-3 — output-side reasoning tokens. Models with built-in
   * reasoning (OpenAI o1/o3/o4, DeepSeek R1, Perplexity reasoning, Gemini
   * 2.5 thinking) bill the reasoning span at the output rate. Surfaced by
   * v6 SDK via `usage.outputTokenDetails.reasoningTokens` (canonical) +
   * provider-specific fallbacks on `providerMetadata.{openai|google|vertex}.*`.
   * Absent on non-reasoning models; treat `undefined` === 0.
   */
  reasoningTokens?: number;
  /**
   * PRELAUNCH-A1-5 (follow-up 2026-05-04) — raw v6 token-details blobs.
   * Persisted onto `responseJson.usage` so the cost reconcile / post-hoc
   * audit pipeline can replay billing math against historical rate-table
   * shifts without re-running the LLM. Last observed (most-recent finish
   * step) shape — per-step shapes are accumulated separately as scalars.
   */
  inputTokenDetails?: Record<string, unknown> | null;
  outputTokenDetails?: Record<string, unknown> | null;
}

export interface AgentSafetyFlag {
  // Theme H — expanded taxonomy to cover groundedness, pre-tool-invoke param
  // scans, and enforcement-layer denials (rate limit, budget). The stream
  // payload shape stays back-compat: older fields unchanged, new union arms
  // tacked on so existing consumers keep type-checking.
  type: "pii" | "injection" | "exfiltration" | "grounded" | "tool_param" | "rate_limit" | "budget";
  severity: "low" | "medium" | "high";
  detail: string;
  matchedText?: string;
  piiType?: string;
  injectionPattern?: string;
}

export type AgentDisplayHint =
  | { kind: "card"; summary: string }
  | { kind: "table"; summary?: string; columns?: string[] }
  | { kind: "code"; language?: string; summary?: string }
  | { kind: "image-ref"; summary?: string; url?: string };

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  promptBlocks?: any[] | null;
  dynamicBlocks?: Array<{ key: string; name: string; defaultContent: string; description?: string; order?: number }> | null;
  maxSteps: number;
  contextLimit: number;
  historyMode: "rolling" | "compact";
  compactThreshold: number;
  enableUserProfiling: boolean;
  toolsBlockConfig?: {
    mode: "direct" | "sub-agent" | "execute-tool";
    enabledTools: string[];
    perToolPerms?: Record<string, { requiresApproval?: boolean; destructive?: boolean }>;
    /**
     * TL.2 — display-mode for the tool layer. See agent-crud.service.ts
     * `ToolDisplayMode`. Defaults to `"full"` (current behavior) when
     * undefined / malformed.
     */
    displayMode?: "full" | "summary" | "meta-tool" | "hybrid";
    /** TL.2 — hybrid-mode pin list (entity tools surfaced with full schema). */
    pinnedTools?: string[];
    /** TL.2 — category allowlist; null/undef = all, [] = none. */
    enabledCategories?: string[] | null;
    /** TL.3 — per-category description overrides for the summary block. */
    categoryDescriptions?: Record<string, { description?: string }>;
  } | null;
  subAgentConfig?: { model: string; maxSteps?: number; systemPrompt?: string } | null;
  metaTools: Record<string, boolean>;
  /**
   * Theme G.5 — id of the PlatosAgentVersion snapshot this config was
   * materialised from. `null` means "no version yet / legacy row / fallback
   * to defaults". The runtime writes this into PlatosAgentMessage.responseJson
   * so the canary metrics dashboard (G.6) can pivot cost/latency by version.
   */
  versionIdUsed?: string | null;
  /**
   * Theme F.5 — agent-level default output schema (JSON Schema or Zod).
   * When set, every turn routes through `streamObject` / `generateObject`
   * unless a per-turn override says otherwise. Per-turn override wins.
   */
  outputSchema?: OutputSchemaInput;
  /** PIFSP-14 — pinned PlatosProviderKey.id; null = use scope default. */
  providerKeyId?: string | null;
  /**
   * Per-request model routing table. When present + non-empty, the runtime
   * resolves `modelLabel` (from the request) against this list instead of
   * using `model` + `providerKeyId` directly. Null / empty = legacy behaviour.
   */
  modelRoutes?: import("./agent-crud.service").ModelRoute[] | null;
  /** PRA-AC: cluster this agent belongs to. When set, memory recall is cluster-wide. */
  clusteringId?: string | null;
  /**
   * Per-agent cap on how many spawn_bgo / agent_batch calls may be issued
   * within a single turn. Overrides PLATOS_MAX_BGOS_PER_TURN env var.
   * null / undefined = fall back to the env var (default 10).
   */
  maxBgosPerTurn?: number | null;
  /**
   * Subagent spawning — per-agent cap on how many `spawn_agent` children may
   * be spawned within a single turn (shares the per-turn `bgo_cap` Redis
   * counter with spawn_bgo / agent_batch). Overrides
   * PLATOS_MAX_CHILDREN_PER_TURN. null / undefined = env var (default 5).
   */
  maxChildrenPerTurn?: number | null;
  /**
   * LAUNCH-2 — per-agent retry/fallback waterfall. When set, each rule
   * overrides DEFAULT_RETRY_RULES for the matching trigger. When null,
   * the runtime falls back to the built-in defaults.
   */
  agentRetryConfig?: { rules: RetryRule[] } | null;
}

/**
 * TL.1 — hardcoded meta-tool → category map.
 *
 * Meta-tools are built inline by `buildMetaTools()` and never pass through
 * the central `ToolRegistryService`, so they don't pick up a category from
 * the DB path. This table is the single source of truth for display
 * grouping in the Tools tab + TL.2 display modes. Anything not explicitly
 * mapped falls back to `"utility"` via `categorizeMetaTool()`.
 *
 * Groups (locked by TL.1 subtask description):
 *   - memory       — long-term memory CRUD + graph primitives
 *   - discovery    — BM25 tool search + execute_tools bridge
 *   - orchestration — durable bgo spawns + batching
 *   - approvals    — in-the-loop + durable approval requests
 *   - artifacts    — artifact create/edit
 *   - profile      — per-user profile KV
 */
export const META_TOOL_CATEGORIES: Record<string, string> = {
  // memory — Theme L
  remember: "memory",
  recall: "memory",
  forget: "memory",
  list_memories: "memory",
  relate: "memory",
  memory_extract: "memory",
  // discovery — BM25 search + execute bridge
  find_tools: "discovery",
  execute_tools: "discovery",
  // orchestration — durable trigger.dev task spawning
  spawn_bgo: "orchestration",
  spawn_task: "orchestration",
  agent_batch: "orchestration",
  spawn_agent: "orchestration",
  // approvals — in-the-loop HITL
  request_approval: "approvals",
  request_durable_approval: "approvals",
  // profile — per-user KV
  remember_user_profile: "profile",
  recall_user_profile: "profile",
};

/**
 * TL.1 — resolve the category for a given meta-tool name. Falls back to
 * `"utility"` for anything unmapped so downstream never sees null.
 * Exported so the Tools tab route + MCP platform inventory + future
 * TL.5 consumers share a single derivation.
 */
export function categorizeMetaTool(name: string): string {
  return META_TOOL_CATEGORIES[name] ?? "utility";
}

/**
 * W.1 — filter a meta-tool dict down to a caller-supplied allowlist.
 *
 * Phase 1 review follow-up: `allowed_tools` can legitimately name EITHER
 * meta-tools (directly present as keys in `tools`) OR entity tools (which
 * ride through the `execute_tools` meta-tool's `calls[].tool` list). The
 * original implementation only saw meta-tools, so:
 *   - `allowed_tools: ["send_email"]` silently dropped to `{}` (entity
 *     tool was never in `tools` to begin with).
 *   - `allowed_tools: ["execute_tools"]` leaked every entity tool in
 *     scope because `execute_tools` does no per-call filtering.
 *
 * The fix:
 *   1. Keep the meta-tool filter on the top-level dict.
 *   2. If any name in the allowlist is NOT a meta-tool key AND is not
 *      `execute_tools` itself, treat it as an entity-tool name. Implicitly
 *      include `execute_tools` so the LLM has a path to reach those tools.
 *   3. Wrap the `execute_tools` handler so `calls[].tool` is filtered
 *      against the entity-tool subset. Calls to non-allowlisted entity
 *      tools return `{ error: "tool not in allowlist" }` without dispatch.
 *
 * Unknown names are harmless — they just never match any entity tool at
 * dispatch time (ToolExecutorService returns its own "not found" error).
 */
/**
 * TL.2 — filter a scoped tool matrix down to caller-supplied category ids.
 *
 * Contract (matches `toolsBlockConfig.enabledCategories`):
 *   - `null` / `undefined` → pass through (all categories visible).
 *   - `[]` empty array     → return empty list (explicit "no categories").
 *   - `["email","calendar"]` → narrow to those ids.
 *
 * Tools whose `category` is null (unclassified) only pass when
 * `"entity"` is in the allowlist — that matches the same fallback bucket
 * used by the summary renderer so counts and visibility stay in sync.
 */
function filterToolsByEnabledCategories<T extends { category: string | null }>(
  tools: T[],
  enabledCategories: string[] | null | undefined,
): T[] {
  if (enabledCategories == null) return tools;
  if (enabledCategories.length === 0) return [];
  const allow = new Set(enabledCategories);
  return tools.filter((t) => {
    const cat = t.category ?? "entity";
    return allow.has(cat);
  });
}

function filterToolsAllowlist(
  tools: Record<string, CoreTool>,
  allowed: string[],
): Record<string, CoreTool> {
  const allowSet = new Set(allowed);
  const metaToolKeys = new Set(Object.keys(tools));
  const out: Record<string, CoreTool> = {};

  // Pass 1 — meta-tools explicitly named.
  for (const [name, tool] of Object.entries(tools)) {
    if (allowSet.has(name)) out[name] = tool;
  }

  // Pass 2 — entity-tool allowlist. Any name in the allowlist that is
  // NOT a known meta-tool key is treated as an entity-tool name. If the
  // caller wants entity tools but didn't list `execute_tools` explicitly,
  // implicitly include it so the LLM can dispatch them.
  const entityAllowed = new Set<string>();
  for (const name of allowed) {
    if (!metaToolKeys.has(name)) entityAllowed.add(name);
  }

  // Wrap `execute_tools` to filter `calls[].tool` against entityAllowed
  // whenever an entity-tool allowlist is in force. When the caller named
  // `execute_tools` but no entity tools, we DO NOT apply the filter —
  // that mode preserves prior behaviour (unrestricted execute_tools).
  const execTool = tools.execute_tools;
  if (execTool && entityAllowed.size > 0) {
    const original = execTool.execute as (args: any, ...rest: any[]) => any;
    const wrapped: CoreTool = {
      ...execTool,
      execute: async (args: any, ...rest: any[]) => {
        const calls = Array.isArray(args?.calls) ? args.calls : [];
        const blocked: Array<{ tool: string; status: "failed"; error: string }> = [];
        const passthroughCalls: any[] = [];
        const originalIndexById: number[] = [];
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          const toolName = typeof c?.tool === "string" ? c.tool : "";
          if (!toolName || !entityAllowed.has(toolName)) {
            blocked.push({
              tool: toolName,
              status: "failed",
              error: "tool not in allowlist",
            });
            originalIndexById.push(-1);
          } else {
            passthroughCalls.push(c);
            originalIndexById.push(passthroughCalls.length - 1);
          }
        }
        let passthroughResults: any[] = [];
        if (passthroughCalls.length > 0) {
          const sub = await original({ ...args, calls: passthroughCalls }, ...rest);
          passthroughResults = Array.isArray(sub?.results) ? sub.results : [];
        }
        // Reassemble in original order so the model sees 1:1 correspondence.
        const results: any[] = [];
        let blockedCursor = 0;
        for (let i = 0; i < calls.length; i++) {
          const passIdx = originalIndexById[i];
          if (passIdx === -1) {
            results.push(blocked[blockedCursor++]);
          } else {
            results.push(
              passthroughResults[passIdx] ?? {
                tool: calls[i]?.tool,
                status: "failed",
                error: "executor returned no result",
              },
            );
          }
        }
        return { results };
      },
    };
    // Expose execute_tools implicitly if not already in the meta-tool slot.
    out.execute_tools = wrapped;
  }

  return out;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private prisma: any;

  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly scopedEnv: ScopedEnvService,
    // Required before any @Optional params to satisfy TS1016. Used by
    // getRunsBridge() for lazy RunsBridge lookup — avoids the 4-hop
    // constructor-injection cycle.
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly toolRegistry?: ToolRegistryService,
    @Optional() private readonly toolExecutor?: ToolExecutorService,
    // PIFSP-11 — ToolRouter primitive. Used by the entity_ids mandate
    // preflight to count the agent's visible entities + later by the MCP
    // gateway (PIFSP-21) as the single resolution surface for every tool
    // dispatch. Optional so the unit-test harness keeps booting.
    @Optional() private readonly toolRouter?: ToolRouterService,
    @Optional() private readonly approvalsService?: MonitoringApprovalsService,
    @Optional() private readonly costService?: CostService,
    @Optional() private readonly spansService?: SpansService,
    // PPR-65 — optional because the unit-test harness wires AgentService
    // without ProvidersModule; when absent the provider-unavailable gate
    // is a no-op and we fall back to the existing behaviour (API call
    // errors out with a "missing API key" message).
    @Optional() private readonly providerRegistry?: ProviderRegistryService,
    // Theme S.6 — optional so the test harness (which doesn't wire SkillsModule)
    // still boots. When present, enabled+env-ready skills contribute a prompt
    // block appended to the agent's systemPrompt for every turn.
    @Optional() private readonly skillRuntime?: SkillRuntimeService,
    // Theme L — semantic-memory services. Optional for test harness; when
    // wired, the `remember` / `recall` / `forget` / `list_memories` /
    // `relate` meta-tools delegate here instead of the legacy Redis stub.
    @Optional() private readonly memoryService?: MemoryService,
    @Optional() private readonly knowledgeGraph?: KnowledgeGraphService,
    // Theme O — memory extraction service. Optional for the same reason.
    @Optional() private readonly memoryExtraction?: MemoryExtractionService,
    // Theme M.3 — Redis projection cache for per-user profile blobs.
    @Optional() private readonly profileCache?: ProfileCacheService,
    // PIFSP-18 — PII governance: regex-based content filtering.
    @Optional() private readonly piiFilter?: PiiFilterService,
    // PIFSP-8 — Layer-1 static-prefix prompt cache (Redis memo, 10-min TTL).
    @Optional() private readonly promptCache?: import("./prompt-cache.service").PromptCacheService,
    /**
     * PRELAUNCH-A3-11 — RateLimitService for the per-(agent, user)
     * approval-event cap. Without this a misbehaving agent can fire
     * unbounded approval modals at one user. Optional so test harnesses
     * keep booting; when absent the cap is a no-op (existing behaviour).
     */
    @Optional() private readonly rateLimitService?: import("../monitoring/rate-limit.service").RateLimitService,
  ) {
    this.prisma = prisma;
  }

  private cachedRunsBridge: RunsBridgeService | null = null;
  private getRunsBridge(): RunsBridgeService | null {
    if (this.cachedRunsBridge) return this.cachedRunsBridge;
    try {
      // Deferred require — runs AFTER the CJS cycle has settled (app is
      // bootstrapped, all modules have finished loading). A top-level
      // import here would break the design:paramtypes metadata of
      // downstream services that reference ConnectionsGateway.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RunsBridgeService: Svc } = require("../trigger-bridge/runs-bridge.service");
      this.cachedRunsBridge = this.moduleRef.get(Svc, { strict: false });
      return this.cachedRunsBridge;
    } catch {
      return null;
    }
  }

  // RG.1.5 (follow-up) — lazy PromptBuilderService resolver. The service
  // lives in the same module but we avoid constructor injection to keep
  // this service's DI footprint narrow (and avoid the 4-hop cycle issues
  // that historically bit RunsBridge). Resolver is nullable: if the module
  // graph hasn't wired PromptBuilderService for any reason (test harness,
  // etc.) we silently skip async prompt assembly at turn time.
  private cachedPromptBuilder: PromptBuilderService | null = null;
  private getPromptBuilder(): PromptBuilderService | null {
    if (this.cachedPromptBuilder) return this.cachedPromptBuilder;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PromptBuilderService: Svc } = require("./prompt-builder.service");
      this.cachedPromptBuilder = this.moduleRef.get(Svc, { strict: false });
      return this.cachedPromptBuilder;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the LLM provider API key for a given model under a scope.
   * Reads the trigger.dev SecretStore first (webapp env-var UI), then falls
   * back to the agent container's own process.env. Returns undefined if
   * neither source has it — the caller decides whether to throw or proceed
   * anyway (e.g. google-vertex uses GOOGLE_VERTEX_CREDENTIALS instead).
   */
  private async resolveApiKey(
    modelString: string,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    providerKeyId?: string | null,
  ): Promise<string | undefined> {
    const envName = apiKeyEnvVarFor(modelString);
    if (!envName) return undefined;
    // PIFSP-14 — route through multi-key resolver when a pinned key or
    // default key is configured; falls back to legacy single-key path.
    const provider = modelString.split(":")[0] ?? "";
    return this.scopedEnv.getProviderApiKey(scope, provider, envName, providerKeyId);
  }

  /**
   * LAUNCH-4 — resolve the working route for this turn from a fallback chain.
   *
   * Behavior:
   * - Agent has no fallback rules (or no model routes): no-op; returns the
   *   primary {model, apiKey}. Zero extra cost — common case.
   * - Agent has fallback rules pointing at named model-route labels: build
   *   the candidate chain [primary, ...fallbackRoutes], do a 1-token
   *   `generateText` ping on each in order, return the first that responds.
   *   Pings cost ~$0.0001 per turn (<10 tokens). Latency +50-200ms.
   *
   * Why ping-then-stream and not mid-stream fallback: refactoring the
   * `result.fullStream` consumption loop to support mid-stream switching
   * is a multi-day rewrite with real risk to existing streaming semantics.
   * The ping pattern catches the most common failure modes (bad key,
   * provider 5xx outage, sustained rate-limit) at the cost of a small
   * pre-flight call. Mid-stream errors continue to surface to the user.
   *
   * If ALL routes fail their pings, returns the primary anyway so the
   * caller's existing error path still fires — UX is no worse than before.
   */
  private async resolveRouteWithFallback(
    agentConfig: AgentConfig,
    scope: RequestScope,
    retryRules: RetryRule[] | undefined,
  ): Promise<{
    apiKey: string | undefined;
    model: ReturnType<typeof resolveModel>;
    routeLabel: string | null;
  }> {
    const primaryApiKey = await this.resolveApiKey(
      agentConfig.model,
      scope,
      agentConfig.providerKeyId,
    );
    const primary = {
      apiKey: primaryApiKey,
      model: resolveModel(agentConfig.model, primaryApiKey, retryRules),
      routeLabel: null as string | null,
      modelString: agentConfig.model,
    };

    // Fast path — no fallback rules → no ping cost.
    const rules = agentConfig.agentRetryConfig?.rules ?? [];
    const fallbackLabels = Array.from(
      new Set(
        rules
          .filter((r) => r.action === "fallback" && typeof r.fallbackToRouteLabel === "string" && r.fallbackToRouteLabel.length > 0)
          .map((r) => r.fallbackToRouteLabel as string),
      ),
    );
    if (fallbackLabels.length === 0) return primary;

    const routes = (agentConfig.modelRoutes ?? []) as Array<{
      label: string;
      model: string;
      providerKeyId?: string | null;
    }>;
    const fallbackRoutes = fallbackLabels
      .map((label) => routes.find((r) => r.label === label))
      .filter((r): r is { label: string; model: string; providerKeyId?: string | null } => !!r);
    if (fallbackRoutes.length === 0) return primary;

    // Resolve all fallback API keys in parallel — saves ~50ms vs sequential.
    const fallbackCandidates = await Promise.all(
      fallbackRoutes.map(async (r) => {
        const k = await this.resolveApiKey(r.model, scope, r.providerKeyId ?? undefined);
        return {
          apiKey: k,
          model: resolveModel(r.model, k, retryRules),
          routeLabel: r.label as string | null,
          modelString: r.model,
        };
      }),
    );
    const candidates = [primary, ...fallbackCandidates];

    for (const c of candidates) {
      try {
        // Tiny ping. Retry-fetch (LAUNCH-2) will already retry transient
        // 429/5xx; this ping fails on permanent issues only (bad key,
        // sustained outage, unknown model). The 5s timeout caps how long
        // a single dead route can stall us before walking on.
        await generateText({
          model: c.model,
          prompt: ".",
          maxOutputTokens: 1,
          abortSignal: AbortSignal.timeout(5_000),
        });
        if (c.routeLabel) {
          this.logger.log(
            `[agent.stream] LAUNCH-4 ping selected fallback route '${c.routeLabel}' (model=${c.modelString})`,
          );
        }
        return { apiKey: c.apiKey, model: c.model, routeLabel: c.routeLabel };
      } catch (err: any) {
        this.logger.warn(
          `[agent.stream] LAUNCH-4 ping failed route='${c.routeLabel ?? "primary"}' model=${c.modelString} err=${(err?.message ?? String(err)).slice(0, 120)}`,
        );
      }
    }

    // All routes failed pre-stream pings. Return primary so the caller's
    // existing error handling fires — at worst the UX is identical to
    // pre-LAUNCH-4 behavior.
    this.logger.warn(
      `[agent.stream] LAUNCH-4 all ${candidates.length} routes failed ping; falling back to primary for the actual streamText (will surface real error)`,
    );
    return { apiKey: primary.apiKey, model: primary.model, routeLabel: null };
  }

  /**
   * Resolve the API key for a given provider in a scope. Used by monitoring
   * endpoints (e.g. AI summary generation) that need to call the LLM directly.
   */
  async resolvePublicApiKey(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    provider: "anthropic" | "openai" | "google",
  ): Promise<string | null> {
    const envVar =
      provider === "anthropic" ? "ANTHROPIC_API_KEY" :
      provider === "openai" ? "OPENAI_API_KEY" :
      "GOOGLE_GENERATIVE_AI_API_KEY";
    const val = await this.scopedEnv.getProviderApiKey(scope, provider, envVar, null);
    return val ?? null;
  }

  /**
   * Theme G.5 — resolve the exact config a turn should run with, honoring the
   * per-thread version lock.
   *
   * Rules (CLAUDE.md §8 "Model picker" + THEME_G §6):
   *   1. If `PlatosAgentThread.lockedVersionId` is set, load that snapshot —
   *      no matter what's changed on the agent row. This is the invariant that
   *      keeps a thread on one version for its lifetime even across rollback
   *      or canaryPercent tweaks mid-conversation.
   *   2. Otherwise, on the thread's FIRST turn, decide current-vs-canary by
   *      rolling a uniform random in [0, 100). If `hit < canaryPercent`, use
   *      `canaryVersionId`; else use `currentVersionId`. Write the chosen id
   *      to `lockedVersionId` so step 1 applies on every subsequent turn.
   *   3. If neither `currentVersionId` nor `canaryVersionId` resolve (legacy
   *      row, canary config broken), fall back to the live agent row fields.
   *
   * Returns both the resolved AgentConfig (with `versionIdUsed` set so
   * AgentTaskService can stamp it onto `PlatosAgentMessage.responseJson` for
   * the G.6 dashboard) and the routing decision for logging.
   */
  async resolveConfigForThread(
    agentId: string,
    threadId: string | null | undefined,
    scope?: { organizationId: string; projectId: string; environmentId: string },
  ): Promise<{ config: AgentConfig; versionIdUsed: string | null; bucket: "locked" | "canary" | "current" | "fallback" }> {
    // Fast path: no thread id yet (e.g. non-streaming unit path) → standard config.
    if (!threadId) {
      const config = await this.getAgentConfig(agentId, scope);
      return { config, versionIdUsed: config.versionIdUsed ?? null, bucket: "current" };
    }

    // PPR-11 (IDOR fix): `findFirst({where:{id}})` without scope filter lets
    // any valid-scope caller probe other orgs' agent configs by enumerating
    // cuids. Scope-filter when caller supplies scope (production path); keep
    // id-only for legacy callers without scope context.
    const agentWhere: Record<string, unknown> = { id: agentId };
    if (scope) {
      agentWhere.organizationId = scope.organizationId;
      agentWhere.projectId = scope.projectId;
      agentWhere.environmentId = scope.environmentId;
    }
    const agent = await this.prisma.platosAgent.findFirst({ where: agentWhere });
    if (!agent) {
      // Agent isn't in the caller's scope. Try a scope-less lookup so the
      // runtime can still serve the agent's CURRENT version snapshot
      // instead of hardcoded "helpful AI assistant" defaults — that
      // hardcoded default has been the source of "the agent has two
      // personalities" reports when scope detection is flaky on session-
      // token-authed paths. We still don't expose neighbor-tenant configs:
      // the snapshot is loaded by versionId+agentId pair, which is
      // public-keyed and not enumerable.
      const fallbackAgent = await this.prisma.platosAgent.findFirst({
        where: { id: agentId },
        select: { id: true, currentVersionId: true, modelRoutes: true, dynamicBlocks: true },
      });
      if (fallbackAgent?.currentVersionId) {
        const versionConfig = await this.loadVersionConfig(
          agentId,
          fallbackAgent.currentVersionId,
          fallbackAgent,
        );
        if (versionConfig) {
          return { config: versionConfig, versionIdUsed: fallbackAgent.currentVersionId, bucket: "current" };
        }
      }
      const config = await this.getAgentConfig(agentId, scope);
      return { config, versionIdUsed: null, bucket: "fallback" };
    }

    // PPR-11: same scope filter on the thread lookup. Cross-scope threadId
    // should fail closed.
    const threadWhere: Record<string, unknown> = { id: threadId };
    if (scope) {
      threadWhere.organizationId = scope.organizationId;
      threadWhere.projectId = scope.projectId;
      threadWhere.environmentId = scope.environmentId;
    }
    const thread = await this.prisma.platosAgentThread.findFirst({
      where: threadWhere,
      select: { id: true, lockedVersionId: true },
    });

    // Step 1 — thread already locked, load the snapshot.
    if (thread?.lockedVersionId) {
      const locked = await this.loadVersionConfig(agentId, thread.lockedVersionId, agent);
      if (locked) {
        this.logger.log(
          `[agent.resolveConfigForThread] agent=${agentId} thread=${threadId} → LOCKED v=${thread.lockedVersionId}`,
        );
        return { config: locked, versionIdUsed: thread.lockedVersionId, bucket: "locked" };
      }
      // Locked version pointer broken — fall through to current; do not re-roll canary.
      this.logger.warn(
        `[agent.resolveConfigForThread] thread=${threadId} lockedVersionId=${thread.lockedVersionId} not found; falling back to current`,
      );
    }

    // Step 2 — first turn on this thread (or broken lock). Decide canary vs current.
    const canaryPercent = Math.max(0, Math.min(100, Number(agent.canaryPercent ?? 0)));
    const canaryVersionId: string | null = agent.canaryVersionId ?? null;
    const currentVersionId: string | null = agent.currentVersionId ?? null;

    let pickedVersionId: string | null = null;
    let bucket: "canary" | "current" | "fallback" = "current";
    if (canaryPercent > 0 && canaryVersionId) {
      // Math.random ∈ [0,1) — uniform. Multiply by 100 to get percentile bucket.
      const hit = Math.random() * 100;
      if (hit < canaryPercent) {
        pickedVersionId = canaryVersionId;
        bucket = "canary";
      } else {
        pickedVersionId = currentVersionId;
        bucket = "current";
      }
    } else {
      pickedVersionId = currentVersionId;
      bucket = "current";
    }

    let config: AgentConfig | null = null;
    if (pickedVersionId) {
      config = await this.loadVersionConfig(agentId, pickedVersionId, agent);
    }
    if (!config && currentVersionId && currentVersionId !== pickedVersionId) {
      // pickedVersionId was a canary that vanished. Fall to current.
      config = await this.loadVersionConfig(agentId, currentVersionId, agent);
      if (config) {
        pickedVersionId = currentVersionId;
        bucket = "current";
      }
    }
    if (!config) {
      // No snapshot available — fall back to live agent row (legacy rows).
      config = await this.getAgentConfig(agentId);
      pickedVersionId = currentVersionId ?? null;
      bucket = "fallback";
    } else {
      config.versionIdUsed = pickedVersionId;
    }

    // Persist the thread lock on FIRST touch. updateMany so a concurrent turn
    // that beats us to the DB doesn't race to a different version.
    //
    // PPR-18 (version-lock race fix): `updateMany` with `lockedVersionId: null`
    // guard is atomic, but both concurrent callers had picked their own
    // `pickedVersionId` locally BEFORE this write. If we're the loser (the
    // updateMany affected 0 rows because another caller wrote first), we
    // must re-read the winner's version and switch to it, otherwise this
    // turn serves a response under a DIFFERENT version than what the thread
    // is now locked to — breaking Theme G.5's "never flip mid-thread"
    // invariant for the first few concurrent messages.
    if (thread && !thread.lockedVersionId && pickedVersionId) {
      try {
        const result = await this.prisma.platosAgentThread.updateMany({
          where: { id: threadId, lockedVersionId: null },
          data: { lockedVersionId: pickedVersionId },
        });
        if (result.count === 0) {
          // Another concurrent caller won the lock. Re-read the winning
          // version and re-load the snapshot so this turn serves under the
          // actual locked version.
          const reLocked = await this.prisma.platosAgentThread.findFirst({
            where: { id: threadId },
            select: { lockedVersionId: true },
          });
          const winnerVersionId = reLocked?.lockedVersionId ?? null;
          if (winnerVersionId && winnerVersionId !== pickedVersionId) {
            const winnerConfig = await this.loadVersionConfig(agentId, winnerVersionId, agent);
            if (winnerConfig) {
              config = winnerConfig;
              pickedVersionId = winnerVersionId;
              // Bucket the loser's turn as "locked" since the thread is now
              // committed to the winner's version. G.6 metrics will pivot
              // correctly.
              bucket = "current";
              winnerConfig.versionIdUsed = winnerVersionId;
              this.logger.log(
                `[agent.resolveConfigForThread] agent=${agentId} thread=${threadId} LOCK-RACE-LOSER → switched to winner v=${winnerVersionId}`,
              );
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `[agent.resolveConfigForThread] failed to persist lockedVersionId on thread ${threadId}: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `[agent.resolveConfigForThread] agent=${agentId} thread=${threadId} canaryPercent=${canaryPercent} → bucket=${bucket} v=${pickedVersionId}`,
    );
    return { config, versionIdUsed: pickedVersionId, bucket };
  }

  /**
   * Materialize an AgentConfig from a PlatosAgentVersion.snapshot. Falls back
   * to defaults for any missing field. Returns `null` when the version row
   * doesn't exist so callers can decide between current-row fallback vs error.
   */
  private async loadVersionConfig(
    agentId: string,
    versionId: string,
    agentRow: any,
  ): Promise<AgentConfig | null> {
    const row = await this.prisma.platosAgentVersion.findFirst({
      where: { id: versionId, agentId },
      select: { id: true, snapshot: true },
    });
    if (!row) return null;
    const snap = (row.snapshot as any) || {};
    const defaults = await this.getAgentConfig(agentId);
    return {
      model: snap.model || defaults.model,
      systemPrompt: snap.systemPrompt ?? defaults.systemPrompt,
      promptBlocks: snap.promptBlocks ?? defaults.promptBlocks ?? null,
      // Dynamic blocks are operational config — always prefer the live agent row
      // over the version snapshot. The snapshot may carry an empty array []
      // from when blocks didn't exist; ?? treats [] as truthy so the fallback
      // would never fire. Explicit length check avoids that trap.
      dynamicBlocks: (() => {
        const live = agentRow?.dynamicBlocks as any;
        if (Array.isArray(live) && live.length > 0) return live;
        const fromSnap = snap.dynamicBlocks as any;
        if (Array.isArray(fromSnap) && fromSnap.length > 0) return fromSnap;
        return defaults.dynamicBlocks ?? null;
      })(),
      maxSteps: snap.maxSteps ?? defaults.maxSteps,
      contextLimit: snap.contextLimit ?? defaults.contextLimit,
      historyMode: (snap.historyMode as "rolling" | "compact") ?? defaults.historyMode,
      compactThreshold: snap.compactThreshold ?? defaults.compactThreshold,
      enableUserProfiling: snap.enableUserProfiling ?? defaults.enableUserProfiling,
      toolsBlockConfig: snap.toolsBlockConfig ?? defaults.toolsBlockConfig ?? null,
      subAgentConfig: snap.subAgentConfig ?? defaults.subAgentConfig ?? null,
      metaTools: (snap.metaTools as Record<string, boolean>) ?? defaults.metaTools,
      versionIdUsed: row.id,
      // Theme F.5 — schema travels with the version snapshot so rolling back
      // restores the exact schema the agent was serving.
      outputSchema: (snap.outputSchema as any) ?? defaults.outputSchema ?? null,
      // modelRoutes lives on the live agent row (not versioned) so always
      // pull from agentRow — same as dynamicBlocks above.
      modelRoutes: (agentRow?.modelRoutes as any) ?? defaults.modelRoutes ?? null,
    };
    // `agentRow` is passed for future use (e.g. feature flags), kept to keep
    // call sites forward compatible.
    void agentRow;
  }

  /**
   * Get agent config — loads from PlatosAgent DB table with Redis cache (1h TTL).
   * Falls back to defaults if agent not in database.
   */
  async getAgentConfig(
    agentId: string,
    scope?: { organizationId: string; projectId: string; environmentId: string },
  ): Promise<AgentConfig> {
    // Check Redis cache first. PPR-11: cache key includes scope when
    // provided so a cross-scope query on the same agentId never serves a
    // cached neighbor-tenant config. When scope is absent (legacy callers),
    // we still use the un-scoped key to preserve compatibility.
    const cacheKey = scope
      ? `agent:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${agentId}:config`
      : `agent:${agentId}:config`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* fall through to reload */ }
    }

    const defaults: AgentConfig = {
      model: env.PLATOS_DEFAULT_MODEL || "anthropic:claude-sonnet-4-6",
      systemPrompt: "You are a helpful AI assistant powered by Platos.",
      promptBlocks: null,
      dynamicBlocks: null,
      maxSteps: 20,
      contextLimit: 20,
      historyMode: "rolling",
      compactThreshold: 40,
      enableUserProfiling: false,
      toolsBlockConfig: null,
      subAgentConfig: null,
      metaTools: {
        find_tools: true,
        execute_tools: true,
        remember: true,
        recall: true,
        // Theme L — additional memory meta-tools. Default enabled since
        // they share the same pgvector-backed store as `remember`/`recall`
        // and the store is always scope-guarded.
        forget: true,
        list_memories: true,
        relate: true,
        // Theme O — manual extraction trigger. Default off so agents don't
        // spontaneously kick an extraction pass; opt in per-agent.
        memory_extract: false,
        // Theme BGO — new primary names. Old names (`spawn_task`,
        // `list_tasks`, `trigger_with_delay`) are kept below as deprecated
        // aliases that resolve to the same handlers for one release.
        spawn_bgo: true,
        list_bgos: false,
        schedule_bgo: false,
        // Deprecated aliases — remove in next major. See docs/BGO_RENAME.md.
        spawn_task: true,
        list_tasks: false,
        trigger_with_delay: false,
        spawn_batch: false,
        // W.1 — agent_batch durable loop. Default-on.
        agent_batch: true,
        wait_for_runs: false,
        get_run_details: false,
        cancel_run: false,
        create_schedule: false,
        list_runs: false,
        // PPR-50 — new control-plane meta-tools. Default disabled (opt-in
        // per-agent via the metaTools map).
        replay_run: false,
        cancel_schedule: false,
        list_schedules: false,
        request_approval: true,
        // PPR-51 — durable variant of request_approval. Disabled by
        // default; opt in per-agent when a waitpoint must survive an
        // agent restart (up to 24h).
        request_durable_approval: false,
      },
    };

    try {
      // PPR-11 (IDOR fix): scope-filter the findFirst when caller supplied
      // a scope, same pattern as resolveConfigForThread above. Legacy
      // scope-less callers still get id-only lookup (kept for now — see
      // follow-up to remove this overload).
      const agentWhere: Record<string, unknown> = { id: agentId };
      if (scope) {
        agentWhere.organizationId = scope.organizationId;
        agentWhere.projectId = scope.projectId;
        agentWhere.environmentId = scope.environmentId;
      }
      const agent = await this.prisma.platosAgent.findFirst({ where: agentWhere });
      const config: AgentConfig = agent
        ? {
            model: agent.model || defaults.model,
            systemPrompt: agent.systemPrompt || defaults.systemPrompt,
            promptBlocks: (agent.promptBlocks as any) || null,
            dynamicBlocks: (agent.dynamicBlocks as any) || null,
            maxSteps: agent.maxSteps ?? 20,
            contextLimit: agent.contextLimit ?? 20,
            historyMode: (agent.historyMode as "rolling" | "compact") || "rolling",
            compactThreshold: agent.compactThreshold ?? 40,
            enableUserProfiling: agent.enableUserProfiling ?? false,
            toolsBlockConfig: (agent.toolsBlockConfig as any) || null,
            subAgentConfig: (agent.subAgentConfig as any) || null,
            metaTools: (agent.metaTools as Record<string, boolean>) || defaults.metaTools,
            // Theme F.5 — optional agent-level output schema (JSON Schema).
            // Nullable column; stays undefined on the config when unset so
            // `resolveTurnSchema` can short-circuit cleanly.
            outputSchema: (agent.outputSchema as any) ?? null,
            // PIFSP-14 — pinned provider key id.
            providerKeyId: agent.providerKeyId ?? null,
            // Per-request model routing table (null when not configured).
            modelRoutes: (agent.modelRoutes as any) ?? null,
            // PRA-AC: cluster membership for cluster-wide memory recall.
            clusteringId: agent.clusteringId ?? null,
            // Per-agent BGO cap — overrides PLATOS_MAX_BGOS_PER_TURN env var.
            maxBgosPerTurn: (agent as any).maxBgosPerTurn ?? null,
            // LAUNCH-2 — per-agent retry/fallback waterfall. Null = use
            // built-in DEFAULT_RETRY_RULES from retry-fetch.ts.
            agentRetryConfig: (agent as any).agentRetryConfig ?? null,
          }
        : defaults;

      // Cache for 1 hour. Use setex (single-step) — some Redis clients drop
      // multi-arg set + EX in pipelined modes; setex is atomic and reliable.
      await this.redis.setex(cacheKey, 60, JSON.stringify(config)); // 60s: live edits (dynamic blocks, context mapping) take effect within one turn
      this.logger.log(`[agent.config] loaded ${agentId} contextLimit=${config.contextLimit} historyMode=${config.historyMode} profiling=${config.enableUserProfiling} cached -> platos:agent:${agentId}:config`);
      return config;
    } catch (error: any) {
      this.logger.warn(`[agent.config] getAgentConfig error for ${agentId}: ${error?.message}`);
      return defaults;
    }
  }

  /**
   * Build the meta-tools available to the agent.
   *
   * Behaviour depends on config.toolsBlockConfig.mode:
   *   - "direct" (default): parent gets find_tools + execute_tools + memory + profile + spawn_bgo (alias: spawn_task)
   *   - "sub-agent":        parent gets delegate_to_sub_agent + memory + profile + spawn_bgo (alias: spawn_task)
   *                         (no execute_tools — delegation handles tool calling)
   *   - "execute-tool":     parent gets find_tools + execute_tools only (minimalist mode)
   */
  /**
   * Theme F.7 — optional sink for meta-tool-originated stream events. The
   * streaming path (`stream()`) passes a queue here so `generate_artifact`
   * / `revise_artifact` can push `artifact_start` / `artifact_delta` /
   * `artifact_committed` / `artifact_error` events that get drained on
   * `step-finish` alongside the existing `pendingToolResults` queue.
   *
   * Non-streaming callers (e.g. `run()`) may pass `undefined` — artifact
   * events are silently dropped in that path since there's no consumer.
   */
  /**
   * Resolve the agent-scoping filter for memory READS (recall / list /
   * injection). The product rule: an agent sees only its OWN memories unless
   * it is clustered, in which case it sees its cluster MEMBERS' memories.
   *   - no agentId (agent-less session) → {} (no agent identity to scope to)
   *   - standalone agent               → { agentId }
   *   - clustered agent                → { agentIds: [members…] }
   * Returned object is spread straight into the MemoryService read input.
   */
  private async memoryAgentFilter(
    agentId: string | undefined,
    clusteringId: string | null | undefined,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<{ agentId?: string; agentIds?: string[] }> {
    if (!agentId) return {};
    if (!clusteringId) return { agentId };
    try {
      const members: Array<{ id: string }> = await this.prisma.platosAgent.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          clusteringId,
        },
        select: { id: true },
      });
      const ids = members.map((m) => m.id);
      return ids.length > 0 ? { agentIds: ids } : { agentId };
    } catch {
      // On lookup failure, fail CLOSED to the single agent (never scope-wide).
      return { agentId };
    }
  }

  /**
   * MCP-as-connected-entity (design §3.1) — resolve the turn's end-user identity
   * (`PlatosEndUser.externalUserId`, i.e. Composio's `user_id`) for the tool-call
   * `origin`. Loads the thread's `platosEndUserId` FK (resolved earlier by
   * `ConversationService.resolveEndUser`), then that end user's `externalUserId`.
   * Returns `null` when unresolvable — a `{{endUserId}}`-templated MCP tool then
   * fails CLOSED at the dispatch boundary (§3.2). Both reads are scope-pinned;
   * any error → `null` (fail closed, never throw into the turn loop).
   */
  private async resolveOriginEndUserId(
    scope: RequestScope,
  ): Promise<string | null> {
    try {
      // IDENTITY-CORE §B.3 (G3) — server-stamped override short-circuit. When
      // `/internal/batch-turn` stamped `resolvedEndUserId`, the parent already
      // resolved + §C-gated it (including a deliberate `null`); return it
      // verbatim. Must test `!== undefined` — a `null` is a signal (gated
      // closed), NOT an absence. Only `undefined` falls through to the
      // thread-based path below.
      if (scope.resolvedEndUserId !== undefined) return scope.resolvedEndUserId;
      const threadId = scope.sessionId;
      if (!threadId) return null;
      const thread = await this.prisma.platosAgentThread.findFirst({
        where: {
          id: threadId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { platosEndUserId: true, singleEndUser: true },
      });
      // IDENTITY-CORE §C — single-end-user gate. A multi-human thread (shared
      // channel / group DM / non-Slack channel thread with no DM predicate) has
      // `singleEndUser === false`; fail CLOSED before reading the pinned person
      // so per-user Composio-MCP never runs as the wrong human. In a 1:1 thread
      // the single (adopted) pinned person IS the one human — correct by
      // construction, and composes with the §A resolver rule below.
      if (thread?.singleEndUser === false) return null;
      const endUserPk = thread?.platosEndUserId;
      if (!endUserPk) return null;
      const endUser = await this.prisma.platosEndUser.findFirst({
        where: {
          id: endUserPk,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { linkedExternalId: true, externalUserId: true },
      });
      if (!endUser) return null;
      // §A.2 frozen rule: prefer the adopted linkedExternalId; empty-string
      // guarded; null ⇒ fail closed downstream.
      return pickExternalId(endUser.linkedExternalId, endUser.externalUserId);
    } catch {
      return null;
    }
  }

  private buildMetaTools(
    scope: RequestScope,
    agentConfig?: AgentConfig,
    onArtifactEvent?: (event: AgentStreamEvent) => void,
    /**
     * TL.6 — holder read at sub-agent dispatch time (NOT at
     * buildMetaTools time). The CTX.6 hint block is computed AFTER this
     * method returns, but fires BEFORE the LLM invokes
     * `delegate_to_sub_agent`. The holder lets us stash the verbose
     * per-tool arg-expectations block and feed it into the sub-agent
     * system prompt so the sub-agent (which actually sees tool schemas)
     * gets the guidance. The parent in sub-agent mode only sees
     * find_tools + delegate_to_sub_agent — per-tool arg hints are useless
     * to it.
     */
    subAgentArgHintHolder?: { value: string },
    /**
     * TL.2 — write-through holder for the "## Available tool categories"
     * system-prompt addendum. Populated by this method when
     * `toolsBlockConfig.displayMode` is `"summary"` or `"hybrid"` and the
     * scoped matrix has at least one visible category. `stream()` /
     * `run()` append it to the per-turn systemPrompt AFTER skill blocks
     * so it rides the same cache-friendly prefix region as skills +
     * dynamic-block rendering (both are stable across turns that share
     * the same agent config × tool set).
     *
     * When the holder is absent the caller has opted out of the feature
     * (e.g. non-streaming legacy path) — display-mode still takes effect
     * on the tool matrix itself, but the addendum is lost.
     */
    systemPromptAddendumHolder?: { value: string },
    /**
     * PRELAUNCH-A2-6 — abort signal for nested sub-agent calls.
     * `delegate_to_sub_agent` runs a fresh `generateText` against the
     * provider; without this signal the parent's stop button closes the
     * outer stream but leaves the sub-agent provider call running +
     * billing.
     */
    abortSignal?: AbortSignal,
    /**
     * Closure index for skill tools — caller (stream/run) declares the
     * array AND populates it in the skill-registration block. find_tools
     * reads from it at call time so the search surface includes skill
     * tools alongside entity tools. Without this, find_tools answered
     * "No tools found" for any skill query.
     */
    skillToolIndex?: Array<{
      name: string;
      description: string;
      paramSchema:
        | { type?: string; properties?: Record<string, unknown> }
        | undefined;
      skillId: string;
    }>,
  ): Record<string, CoreTool> {
    const tools: Record<string, CoreTool> = {};
    const toolMode = agentConfig?.toolsBlockConfig?.mode || "direct";

    // find_tools — BM25 search over the tool registry.
    // `source` narrows the search to a single entity (e.g. "winsen-g0-prod-service").
    // When sessionContext carries entity_ids, that list is the authoritative
    // scope — find_tools auto-applies it so the LLM never sees tools from
    // entities it isn't meant to use.
    const _findToolsCtxMap = scope.contextMapping as ContextMapping | null | undefined;
    const _findToolsCtxBag = scope.sessionContext;
    const _findToolsEntityKey = _findToolsCtxMap?.entityIdsKey || "entity_ids";
    const _findToolsRawEntityIds = _findToolsCtxBag
      ? resolveCtxPath(_findToolsCtxBag, _findToolsEntityKey)
      : undefined;
    const _findToolsEntityIds: string[] = Array.isArray(_findToolsRawEntityIds)
      ? _findToolsRawEntityIds.filter((e): e is string => typeof e === "string" && e.length > 0)
      : [];

    // Build a dynamic description so the LLM knows which entities are in scope
    const _entityHint = _findToolsEntityIds.length > 0
      ? ` Available entities: ${_findToolsEntityIds.map((e) => `"${e}"`).join(", ")}. Pass source to restrict to one entity.`
      : "";

    // Skill tools register into the local `tools` dict AFTER find_tools
    // is defined — but in a different method (stream/run). The caller
    // passes in a `skillToolIndex` array that BOTH find_tools' execute
    // callback (here, at call time) AND the skill registration loop
    // (over there) close over. find_tools merges the skill index with
    // entity-tool matches; without this, find_tools answered "No tools
    // found" for skill queries and the LLM never tried execute_tools.
    const _skillToolIndex = skillToolIndex ?? [];

    tools.find_tools = {
      description:
        `Search for available tools by describing what you need. Returns matching tool names, descriptions, and parameter summaries.${_entityHint}`,
      inputSchema: z.object({
        query: z.string().describe("Natural language description of what tools you need"),
        source: z
          .string()
          .optional()
          .describe("Entity slug to restrict the search to. Omit for all entities in scope."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 15)."),
      }),
      execute: async ({ query, source, limit }) => {
        if (!this.toolRegistry) {
          return { query, source: source ?? null, results: [], message: "Tool registry not available" };
        }
        // When sessionContext carries exactly one entity and no explicit source
        // was passed by the LLM, auto-restrict to that entity so the LLM
        // doesn't need to know the entity slug.
        const effectiveSource = source ??
          (_findToolsEntityIds.length === 1 ? _findToolsEntityIds[0] : undefined);

        let matches = this.toolRegistry.findTools(
          query,
          scope,
          limit ?? 15,
          effectiveSource,
          scope.agentId,
        );
        // Skill tools — registered into the local tools dict and accessible
        // via execute_tools (which now routes locally first). They live
        // OUTSIDE the entity-tool registry, so we substring-match the
        // query against name+description here and append matches.
        if (!effectiveSource && _skillToolIndex.length > 0) {
          const q = query.toLowerCase().trim();
          const tokens: string[] = q.split(/\s+/).filter(Boolean);
          const skillMatches = _skillToolIndex
            .filter((t) => {
              if (q.length === 0) return true;
              const hay = `${t.name} ${t.description}`.toLowerCase();
              return tokens.some((tok: string) => hay.includes(tok));
            })
            .map((t) => ({
              toolName: t.name,
              description: t.description,
              paramSchema: t.paramSchema ?? {},
              category: "skill",
              sourceEntityId: t.skillId,
              relevance: 1,
            }));
          matches = [...matches, ...(skillMatches as unknown as typeof matches)];
        }
        // Post-filter by entity_ids for multi-entity scopes (ensures tools
        // from non-declared entities are never returned even if source was omitted).
        const ctxMap = _findToolsCtxMap;
        const ctxBag = _findToolsCtxBag;
        if (_findToolsEntityIds.length > 0) {
          matches = filterToolsByEntityIds(matches, _findToolsEntityIds);
        } else if (ctxMap && ctxBag) {
          const key = ctxMap.entityIdsKey || "entity_ids";
          const entityIds = resolveCtxPath(ctxBag, key);
          matches = filterToolsByEntityIds(matches, entityIds);
        }
        // Theme CTX.6 — Role 2 (tool-arg injection / schema strip). Walk the
        // 4-tier resolver per tool and HIDE every param bound to a
        // constant/session source. LLM-fill params remain visible. Fail-open
        // on any individual tool (surface the raw schema keys) so a bad
        // mapping can't blind the LLM to an entire tool.
        if (matches.length === 0) {
          return {
            query,
            source: effectiveSource ?? null,
            results: [],
            message: `No tools found for "${query}"${effectiveSource ? ` in entity "${effectiveSource}"` : ""}. Do NOT call find_tools again with the same or similar query — the capability is not available. Tell the user the tool is not connected.`,
          };
        }
        return {
          query,
          source: source ?? null,
          results: matches.map((m) => {
            const allProps = Object.keys((m.paramSchema as any)?.properties || {});
            let visibleProps = allProps;
            try {
              const resolved = resolveCtxToolMappingsForHint(
                { name: m.toolName, inputSchema: m.paramSchema },
                {
                  contextMapping:
                    (ctxMap as AgentContextMapping | null | undefined) ?? undefined,
                },
                ctxBag ?? null,
              );
              const stripped = new Set(
                resolved.params
                  .filter(
                    (p) =>
                      p.resolution.source === "constant" ||
                      p.resolution.source === "session",
                  )
                  .map((p) => p.name),
              );
              visibleProps = allProps.filter((k) => !stripped.has(k));
            } catch {
              // keep raw props on failure
            }
            return {
              name: m.toolName,
              description: m.description,
              params: visibleProps,
              category: m.category,
              entity: m.sourceEntityId,
            };
          }),
        };
      },
    };

    // MCP-as-connected-entity (design §3.1) — per-turn memo of the resolved
    // end-user identity (externalUserId → Composio user_id). Resolved lazily on
    // the first remote dispatch and reused for the whole turn so a turn with N
    // execute_tools calls does at most one thread+end-user lookup. `undefined` =
    // not yet resolved; `null` = resolved-to-none (fail closed downstream).
    let _originEndUserId: string | null | undefined;
    const resolveEndUserOnce = async (): Promise<string | null> => {
      if (_originEndUserId === undefined) {
        _originEndUserId = await this.resolveOriginEndUserId(scope);
      }
      return _originEndUserId;
    };

    // execute_tools — call tools on the org's backend
    tools.execute_tools = {
      description: "Execute one or more tools. Each tool call runs on the organization's backend and returns structured results.",
      inputSchema: z.object({
        calls: z.array(z.object({
          tool: z.string().describe("Tool name from find_tools results"),
          params: z.record(z.unknown()).describe("Tool parameters"),
          purpose: z.string().optional().describe("Why you're calling this tool (helps with param validation)"),
        })),
      }),
      execute: async ({ calls }) => {
        // Skills (e.g. platos.email_send) register their tools directly into
        // the local `tools` dict under namespaced names (e.g.
        // `platos_email_send__send_email`). The entity-tool registry that
        // `toolExecutor.executeBatch` looks up does NOT include skills, so
        // routing every call through it returned "Tool not found or not
        // enabled for scope" for skill calls. Route locally first when the
        // tool exists in the live tools dict; fall back to the entity
        // executor for everything else (entity-published tools).
        const startedAt = Date.now();
        const splitResults: Array<{
          idx: number;
          result: { tool: string; status: string; error?: string; result?: unknown; latencyMs: number };
        }> = [];
        const remoteCalls: Array<{
          idx: number;
          call: { tool: string; params: Record<string, unknown>; purpose?: string };
        }> = [];

        for (let i = 0; i < calls.length; i++) {
          const c = calls[i] as { tool: string; params: Record<string, unknown>; purpose?: string };
          const localTool = tools[c.tool];
          if (
            localTool &&
            typeof (localTool as unknown as { execute?: unknown }).execute === "function"
          ) {
            const t0 = Date.now();
            try {
              const out = await (
                localTool as unknown as { execute: (input: unknown) => Promise<unknown> }
              ).execute(c.params);
              splitResults.push({
                idx: i,
                result: {
                  tool: c.tool,
                  status: "success",
                  result: out,
                  latencyMs: Date.now() - t0,
                },
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              splitResults.push({
                idx: i,
                result: {
                  tool: c.tool,
                  status: "failed",
                  error: message,
                  latencyMs: Date.now() - t0,
                },
              });
            }
          } else {
            remoteCalls.push({ idx: i, call: c });
          }
        }

        if (remoteCalls.length > 0) {
          if (!this.toolExecutor) {
            for (const { idx, call } of remoteCalls) {
              splitResults.push({
                idx,
                result: {
                  tool: call.tool,
                  status: "failed",
                  error: "Tool executor not available",
                  latencyMs: Date.now() - startedAt,
                },
              });
            }
          } else {
            // Carry the resolved end user to mcpDispatch (design §3.1 row i).
            const endUserId = await resolveEndUserOnce();
            const remote = await this.toolExecutor.executeBatch(
              remoteCalls.map(({ call }) => ({
                tool: call.tool,
                params: call.params,
                purpose: call.purpose,
              })),
              scope,
              { source: "agent_turn", endUserId },
            );
            remote.forEach((r, j) => {
              const remoteEntry = remoteCalls[j];
              if (!remoteEntry) return;
              splitResults.push({
                idx: remoteEntry.idx,
                result: r as {
                  tool: string;
                  status: string;
                  error?: string;
                  result?: unknown;
                  latencyMs: number;
                },
              });
            });
          }
        }

        // Re-order to match the caller's input order.
        splitResults.sort((a, b) => a.idx - b.idx);
        return { results: splitResults.map((r) => r.result) };
      },
    };

    // ─────────────────────────────────────────────────────────────────
    // Theme L — memory meta-tools. Delegate to MemoryService /
    // KnowledgeGraphService when wired (production); fall back to the
    // legacy Redis stub when unavailable (test harness).
    // ─────────────────────────────────────────────────────────────────
    const scopeTuple = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    const memoryUserId = scope.userId;
    // Local enablement lookup — `metaEnabled` is declared further down in
    // this method (line ~1300) for the trigger.dev control-plane block.
    // Re-reading the same `agentConfig.metaTools` map here keeps the two
    // sets self-consistent without forcing a forward reference.
    const metaEnabledMemory = (name: string): boolean => {
      const m = agentConfig?.metaTools ?? {};
      // Enabled unless explicitly set to false — keeps defaults backwards
      // compatible for older agent rows that predate these tools.
      return m[name] !== false;
    };

    // remember — save a fact to long-term memory (pgvector-backed).
    tools.remember = {
      description:
        "Save an important fact to long-term memory. Use this when you learn something the user would want you to remember across conversations.",
      inputSchema: z.object({
        content: z
          .string()
          .describe("The fact, preference, or event to remember. One sentence."),
        kind: z
          .enum(["fact", "preference", "event", "relationship"])
          .optional()
          .describe("Classification — defaults to 'fact'."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Optional metadata (e.g. { source: 'thread-xyz' })."),
      }),
      execute: async ({ content, kind, metadata }) => {
        if (this.memoryService) {
          try {
            const row = await this.memoryService.add(scopeTuple, {
              userId: memoryUserId,
              agentId: scope.agentId ?? null,
              content,
              kind,
              metadata,
              source: "manual",
              sourceThreadId: (scope as any).threadId ?? null,
            });
            return { saved: true, id: row.id, kind: row.kind };
          } catch (err: any) {
            return { saved: false, error: err?.message || "remember failed" };
          }
        }
        // Legacy Redis stub — kept so test/dev without MemoryModule still
        // returns a sensible response.
        const key = `memory:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.agentId || "default"}`;
        const entry = JSON.stringify({
          content,
          kind: kind || "fact",
          metadata: metadata || null,
          userId: scope.userId,
          timestamp: new Date().toISOString(),
        });
        await this.redis.lpush(key, entry);
        await this.redis.ltrim(key, 0, 499);
        await this.redis.expire(key, 86400 * 90);
        return { saved: true, fallback: "redis", content };
      },
    };

    // recall — multi-signal (dense ⊕ graph) retrieval over long-term memory.
    tools.recall = {
      description:
        "Search your long-term memory for context relevant to the current conversation. Fuses semantic (cosine) recall with the knowledge graph: memories connected to people/orgs/projects in your query rank higher, and the related entities + relationships are returned alongside. Returns { results: [{ id, content, kind, score }], graph: { entities, relationships } }.",
      inputSchema: z.object({
        query: z.string().describe("What to search for in memory"),
        kind: z
          .enum(["fact", "preference", "event", "relationship"])
          .optional()
          .describe("Filter by memory kind (optional)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)."),
      }),
      execute: async ({ query, kind, limit }) => {
        if (this.memoryService) {
          try {
            // Agent/cluster scoping (fail-closed to single agent) — memory
            // crosses agents only within a cluster. Mirrors the single-agent
            // recall leak fix (Mark surfaced Ada's context) and the cluster
            // share rule, resolved in ONE place now.
            const filter = await this.memoryAgentFilter(
              scope.agentId,
              agentConfig?.clusteringId,
              scope,
            );
            const fused = await fuseContextRetrieval(
              { memory: this.memoryService, graph: this.knowledgeGraph },
              scopeTuple,
              { query, userId: memoryUserId, kind, limit, ...filter },
            );
            const results = fused.memories.map((h: any) => ({
              id: h.id,
              content: h.content,
              kind: h.kind,
              score: typeof h.score === "number" ? Number(h.score.toFixed(4)) : undefined,
              // Which signals surfaced this (dense / graph) — accounting.
              ...(Array.isArray(h.signals) ? { signals: h.signals } : {}),
              metadata: h.metadata,
              createdAt: h.createdAt,
            }));
            return {
              query,
              total: results.length,
              results,
              // The KG slice the situation resolved to — the graph now
              // PARTICIPATES in recall instead of being write-only.
              ...(fused.entities.length
                ? { graph: { entities: fused.entities, relationships: fused.relationships } }
                : {}),
              signals: fused.signals,
            };
          } catch (err: any) {
            return { query, total: 0, results: [], error: err?.message || "recall failed" };
          }
        }
        // Legacy Redis fallback (substring search).
        const key = `memory:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.agentId || "default"}`;
        const all = await this.redis.lrange(key, 0, 499);
        const queryLower = query.toLowerCase();
        const matches = all
          .map((raw: string) => {
            try { return JSON.parse(raw); } catch { return null; }
          })
          .filter((m: any) => m && typeof m.content === "string" && m.content.toLowerCase().includes(queryLower))
          .slice(0, limit ?? 10);
        return { query, results: matches, total: matches.length, fallback: "redis" };
      },
    };

    // forget — delete a memory row by id. Scope-guarded: deletes are
    // silent no-ops when the id lives in another scope.
    if (metaEnabledMemory("forget")) tools.forget = {
      description:
        "Delete a specific memory by id. Returns { deleted: boolean }. Use when the user asks you to forget something or when a memory is no longer accurate.",
      inputSchema: z.object({
        memoryId: z.string().describe("The memory id returned by remember() or recall()."),
      }),
      execute: async ({ memoryId }) => {
        if (!this.memoryService) return { deleted: false, error: "memory service unavailable" };
        try {
          const deleted = await this.memoryService.delete(scopeTuple, memoryId);
          return { deleted };
        } catch (err: any) {
          return { deleted: false, error: err?.message || "forget failed" };
        }
      },
    };

    // list_memories — paginate memories for a user.
    if (metaEnabledMemory("list_memories")) tools.list_memories = {
      description:
        "List memories for the current user. Returns an array of { id, content, kind, createdAt } without embeddings. Ordered by lastAccessedAt desc nulls last, then createdAt desc.",
      inputSchema: z.object({
        kind: z
          .enum(["fact", "preference", "event", "relationship"])
          .optional()
          .describe("Filter by kind (optional)."),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: async ({ kind, limit, offset }) => {
        if (!this.memoryService) return { memories: [], total: 0, error: "memory service unavailable" };
        try {
          const rows = await this.memoryService.list(scopeTuple, {
            userId: memoryUserId,
            kind,
            limit,
            offset,
            // Own agent, or cluster MEMBERS when clustered (never scope-wide).
            ...(await this.memoryAgentFilter(scope.agentId, agentConfig?.clusteringId, scope)),
          });
          return {
            total: rows.length,
            memories: rows.map((r) => ({
              id: r.id,
              content: r.content,
              kind: r.kind,
              metadata: r.metadata,
              createdAt: r.createdAt,
              lastAccessedAt: r.lastAccessedAt,
            })),
          };
        } catch (err: any) {
          return { memories: [], total: 0, error: err?.message || "list_memories failed" };
        }
      },
    };

    // relate — create a knowledge-graph edge between two entities.
    // Auto-upserts both endpoints so repeated calls with the same slugs
    // are idempotent — only the edge is new.
    if (metaEnabledMemory("relate")) tools.relate = {
      description:
        "Record a relationship between two entities in the knowledge graph (e.g. relate('user_alice', 'acme_corp', 'works_at')). Upserts both entities if they don't exist yet. Returns { relationshipId, fromEntityId, toEntityId }.",
      inputSchema: z.object({
        fromEntityKey: z.string().describe("Stable slug for the source entity (e.g. 'user_alice')."),
        toEntityKey: z.string().describe("Stable slug for the target entity (e.g. 'acme_corp')."),
        relationshipType: z
          .string()
          .describe("Edge type — e.g. 'works_at', 'owns', 'prefers', 'mentions'."),
        weight: z
          .number()
          .optional()
          .describe("Optional strength (0..1) — defaults to unset."),
        metadata: z.record(z.unknown()).optional(),
      }),
      execute: async ({ fromEntityKey, toEntityKey, relationshipType, weight, metadata }) => {
        if (!this.knowledgeGraph) {
          return { ok: false, error: "knowledge graph service unavailable" };
        }
        try {
          const [from, to] = await Promise.all([
            this.knowledgeGraph.upsertEntity(scopeTuple, {
              userId: memoryUserId,
              entityKey: fromEntityKey,
              entityType: "other",
              label: fromEntityKey,
            }),
            this.knowledgeGraph.upsertEntity(scopeTuple, {
              userId: memoryUserId,
              entityKey: toEntityKey,
              entityType: "other",
              label: toEntityKey,
            }),
          ]);
          const rel = await this.knowledgeGraph.createRelationship(scopeTuple, {
            userId: memoryUserId,
            fromEntityId: from.id,
            toEntityId: to.id,
            relationshipType,
            weight: typeof weight === "number" ? weight : null,
            metadata,
          });
          return {
            ok: true,
            relationshipId: rel.id,
            fromEntityId: from.id,
            toEntityId: to.id,
            relationshipType,
          };
        } catch (err: any) {
          return { ok: false, error: err?.message || "relate failed" };
        }
      },
    };

    // Theme O.1 — memory_extract meta-tool. Kicks a manual extraction
    // pass over a thread and returns counts. Scope-guarded through the
    // extractor service; rate-limited by the existing RateLimitGuard.
    if (metaEnabledMemory("memory_extract")) tools.memory_extract = {
      description:
        "Run the memory extractor over a thread NOW. Returns { memoriesCreated, entitiesCreated, relationshipsCreated, skipped }. Use sparingly — the hourly scheduled sweep normally handles this.",
      inputSchema: z.object({
        threadId: z
          .string()
          .describe("The thread id to extract memories from. Use the current thread unless the user asks for another."),
        policyOverride: z
          .object({
            confidenceThreshold: z.number().min(0).max(1).optional(),
            maxPerSession: z.number().int().min(1).max(100).optional(),
            kinds: z
              .array(z.enum(["fact", "preference", "event", "relationship"]))
              .optional(),
          })
          .optional()
          .describe("Optional per-call overrides for the agent's stored extraction policy."),
      }),
      execute: async ({ threadId, policyOverride }) => {
        if (!this.memoryExtraction) {
          return { ok: false, error: "memory extraction service unavailable" };
        }
        try {
          const out = await this.memoryExtraction.extractFromThread(scopeTuple, {
            force: true, // explicit memory_extract ask bypasses the watermark
            threadId,
            policyOverride,
          });
          return { ok: true, ...out };
        } catch (err: any) {
          return { ok: false, error: err?.message || "memory_extract failed" };
        }
      },
    };

    // update_user_profile — structured write to the per-agent-per-user profile store.
    // The LLM calls this when it learns something worth remembering about the user.
    // Only actually writes when enableUserProfiling=true on the agent config.
    //
    // Theme M.4 — the legacy PlatosAgentUserProfile blob is gone. This
    // meta-tool now delegates to the unified PlatosMemory store (kind=
    // "profile"), which is what the turn-start __user_profile injector +
    // recall_user_profile already read from. The meta-tool name is kept
    // for LLM-facing API stability (older serialized AgentConfig rows
    // may still reference it).
    //
    // A deprecation warning is logged once per agent session so operators
    // can migrate to the generic `remember({kind:"profile",...})` form.
    const updateUserProfileWarned = new Set<string>();
    tools.update_user_profile = {
      description: "Update the structured memory of what you know about the user (name, role, preferences, facts, etc). Call this when you learn something about the user worth remembering across conversations.",
      inputSchema: z.object({
        key: z.string().describe("The field to update (e.g., 'name', 'role', 'preferences', 'facts')"),
        value: z.string().describe("The value — can be a string, JSON-encoded object, or a short sentence. Agent-readable."),
      }),
      execute: async ({ key, value }) => {
        const agentId = scope.agentId || "default";
        // One-time deprecation breadcrumb — the LLM-facing name stays, but
        // the underlying store is now unified with `remember`.
        const warnKey = `${agentId}:update_user_profile`;
        if (!updateUserProfileWarned.has(warnKey)) {
          updateUserProfileWarned.add(warnKey);
          this.logger.warn(
            `[platos.profile] Meta-tool "update_user_profile" now delegates to PlatosMemory (kind="profile"). Consider migrating to remember({kind:"profile", content, metadata:{profileKey}}) directly.`,
          );
        }
        try {
          if (!this.memoryService) {
            return { saved: false, error: "memory service unavailable" };
          }
          if (!key || key.trim().length === 0 || key.startsWith("_")) {
            return { saved: false, error: "profile key must be non-empty and not start with '_'" };
          }
          // EOBD.16 parity — scope-verify the agent exists in THIS scope
          // before writing. Keeps a forged agentId from leaking into
          // another tenant's profile rows via the (agentId, userId)
          // composite key.
          const agentInScope = await this.prisma.platosAgent.findFirst({
            where: {
              id: agentId,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            select: { id: true },
          });
          if (!agentInScope && agentId !== "default") {
            return { saved: false, error: "Agent not found in this scope" };
          }

          const memoryContent = typeof value === "string" ? value : String(value);
          // Profile keys are idempotent at the (scope, userId, agentId,
          // profileKey) level — delete any prior row first so `add()`
          // inserts the new value. contentHash-based dedupe only triggers
          // when a sourceThreadId is set (extracted rows), so we manage
          // supersession here explicitly.
          const prior = await this.prisma.platosMemory.findFirst({
            where: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
              agentId,
              kind: "profile",
              metadata: {
                path: ["profileKey"],
                equals: key,
              },
            },
            select: { id: true },
          });
          if (prior) {
            await this.memoryService.delete(scopeTuple, prior.id);
          }
          await this.memoryService.add(scopeTuple, {
            userId: scope.userId,
            agentId,
            kind: "profile",
            content: memoryContent,
            metadata: {
              profileKey: key,
              blobSyncedAt: new Date().toISOString(),
            },
            source: "manual",
            visibility: "private",
            agentVisible: true,
          });
          // Invalidate the projection cache so the next reader (turn-
          // start injector or recall_user_profile) sees fresh data.
          await this.profileCache?.invalidate(scopeTuple, agentId, scope.userId);

          return { saved: true, key, value };
        } catch (err: any) {
          return { saved: false, error: err?.message || "Profile update failed" };
        }
      },
    };

    // recall_user_profile — read the per-user profile on demand.
    //
    // Theme M.4 — legacy PlatosAgentUserProfile blob is gone. This reads
    // exclusively from PlatosMemory rows (kind="profile"), reassembling
    // the blob shape from `metadata.profileKey`. Redis projection cache
    // handles the hot path (O(1) Redis vs O(N) Prisma on miss).
    tools.recall_user_profile = {
      description: "Look up what you know about the current user. Returns the full profile or a specific field.",
      inputSchema: z.object({
        key: z.string().optional().describe("Specific key to retrieve (optional — omit to return the full profile)"),
      }),
      execute: async ({ key }) => {
        const agentId = scope.agentId || "default";
        try {
          // Cache hit path — skip Prisma entirely when a fresh
          // projection is already in Redis.
          let data: Record<string, unknown> | null =
            (await this.profileCache?.get(scopeTuple, agentId, scope.userId)) ?? null;
          if (!data) {
            // Cache miss — rebuild from memory rows. Scope-gated to
            // (org, project, env, agentId, userId) so a forged agentId
            // can't leak another scope's data (EOBD.16 parity).
            const rows = await this.prisma.platosMemory.findMany({
              where: {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
                userId: scope.userId,
                agentId,
                kind: "profile",
              },
              select: { content: true, metadata: true },
            });
            data = {};
            for (const row of rows) {
              const meta = row.metadata as any;
              const profileKey =
                meta && typeof meta === "object" && typeof meta.profileKey === "string"
                  ? meta.profileKey
                  : null;
              if (profileKey) data[profileKey] = row.content;
            }
            // Populate cache for subsequent reads (within TTL).
            await this.profileCache?.set(scopeTuple, agentId, scope.userId, data);
          }
          const keyCount = Object.keys(data).length;
          if (keyCount === 0) return { found: false, profile: null };
          if (key) {
            return { found: key in data, key, value: (data as any)[key] };
          }
          return { found: true, profile: data };
        } catch (err: any) {
          return { found: false, error: err?.message || "Profile lookup failed" };
        }
      },
    };

    // Theme BGO — deprecated-alias bookkeeping. Old meta-tool names
    // (spawn_task / list_tasks / trigger_with_delay) are kept callable for
    // one release and route to the same handlers as the new names
    // (spawn_bgo / list_bgos / schedule_bgo). We emit a one-time console
    // warning per agent session per alias and add a `deprecation_notice`
    // field to the response. See docs/BGO_RENAME.md for the full rename
    // table + removal plan.
    const bgoAliasWarned = new Set<string>();
    const bgoAliasWarn = (oldName: string, newName: string) => {
      const key = `${scope.agentId || "default"}:${oldName}`;
      if (bgoAliasWarned.has(key)) return;
      bgoAliasWarned.add(key);
      this.logger.warn(
        `[platos.bgo] Meta-tool "${oldName}" is deprecated — use "${newName}" instead. Both names are supported for one release; "${oldName}" will be removed in the next major.`,
      );
    };
    const bgoDeprecation = (oldName: string, newName: string) =>
      `"${oldName}" is deprecated; use "${newName}". Both names currently resolve to the same handler.`;
    // Allow either the new OR the old key in AgentConfig.metaTools to enable
    // a BGO-renamed tool. Older serialized agent rows may only have the
    // old key; the `defaultOn` argument preserves pre-BGO behaviour for
    // tools (like `spawn_task`) that were previously registered
    // unconditionally — those stay on when neither key is present.
    const bgoMetaEnabled = (
      primary: string,
      alias: string,
      defaultOn: boolean,
    ): boolean => {
      const m = agentConfig?.metaTools ?? {};
      if (primary in m) return !!m[primary];
      if (alias in m) return !!m[alias];
      return defaultOn;
    };

    // spawn_bgo (Theme BGO — formerly `spawn_task`) — spawn a durable
    // background operation for long-running work. When TRIGGER_SECRET_KEY
    // is configured, fires a real trigger.dev task that runs with
    // checkpointing + retries. Otherwise falls back to a Redis stub so the
    // LLM gets a consistent response in local dev.
    //
    // Old name `spawn_task` is registered at the end of this block as a
    // deprecated alias pointing at the same handler (one-release compat).
    const spawnBgoHandler = async (
      args: { taskId: string; instruction: string; tools?: string[]; timeout?: string },
      opts: { emittedAs: "spawn_bgo" | "spawn_task" },
    ) => {
      const { taskId, instruction, tools: taskTools, timeout } = args;
      const deprecation_notice =
        opts.emittedAs === "spawn_task" ? bgoDeprecation("spawn_task", "spawn_bgo") : undefined;

      // EOBD.47 — per-turn spawn_bgo cap. Without this a runaway LLM
      // inside a single streamText step can queue thousands of bgos;
      // trigger.dev's cluster-level concurrencyLimit only bounds
      // dispatch, not the queue depth this originator creates.
      // Counter scoped to (org, project, env, thread) with TTL == turn
      // timeout + buffer so it self-expires after the turn closes.
      const maxBgosPerTurn = Math.max(
        1,
        agentConfig?.maxBgosPerTurn ?? env.PLATOS_MAX_BGOS_PER_TURN ?? 10,
      );
      const bgoCapKey = `bgo_cap:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.sessionId || "notread"}`;
      try {
        const count = await this.redis.incr(bgoCapKey);
        if (count === 1) {
          // First bump in this turn — attach TTL so we don't leak the
          // counter forever. 10 min covers the default 5-min turn
          // timeout + buffer for late async spawn_bgo calls inside the
          // same turn.
          await this.redis.expire(bgoCapKey, 600);
        }
        if (count > maxBgosPerTurn) {
          this.logger.warn(
            `[spawn_bgo] cap exceeded — turn=${scope.sessionId} count=${count} max=${maxBgosPerTurn}`,
          );
          return {
            spawned: false,
            error: "bgo_cap_exceeded",
            message: `spawn_bgo cap of ${maxBgosPerTurn} per turn reached. Stop spawning new background operations.`,
            ...(deprecation_notice ? { deprecation_notice } : {}),
          };
        }
      } catch {
        // Redis hiccup — fail-open (availability over strict cap).
      }

      // IDENTITY-CORE §B.1 (G2) — resolve the end user ONCE here (post-gate, so
      // `null` when §C closes the thread) and carry it down into the durable
      // payload. `spawn_bgo` uses the LEGACY top-level payload shape, which the
      // task's `normalizePayload` reconstructs into a fresh object — a top-level
      // `endUserId` only survives because that reconstruction now forwards it.
      // The legacy bgo payload's `origin.threadId=""` means server-side
      // re-resolution can't work anyway, so threading the id explicitly is the
      // only correct path.
      const endUserId = await this.resolveOriginEndUserId(scope);

      // Resolve API key from DB for this environment — no TRIGGER_SECRET_KEY needed.
      const _bgoClient = await getScopedTriggerClient(this.prisma, scope.environmentId);
      if (_bgoClient?.triggerTask) {
        try {
          const _bgoPayload = {
            taskId,
            instruction,
            tools: taskTools || [],
            timeout: timeout || "5m",
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
            agentId: scope.agentId || "default",
            endUserId,
          };
          const handle = await _bgoClient.triggerTask(
            "platos-agent-tool-block",
            {
              payload: _bgoPayload,
              options: {
                idempotencyKey: idemKey(`spawn_bgo:${taskId}`, args),
                tags: [
                  `org:${scope.organizationId}`,
                  `project:${scope.projectId}`,
                  `env:${scope.environmentId}`,
                  `agent:${scope.agentId || "default"}`,
                  `user:${scope.userId}`,
                ],
                metadata: {
                  organizationId: scope.organizationId,
                  projectId: scope.projectId,
                  environmentId: scope.environmentId,
                  userId: scope.userId,
                  agentId: scope.agentId || "default",
                  taskIdHint: taskId,
                },
                queue: {
                  name: `org:${scope.organizationId}`,
                  concurrencyLimit: parseInt(process.env.PLATOS_PER_ORG_CONCURRENCY ?? "100", 10),
                },
              },
            },
          );
          this.logger.log(`[spawn_bgo] triggered runId=${handle.id} for taskId=${taskId}`);
          return {
            spawned: true,
            durable: true,
            runId: handle.id,
            // Theme BGO — dual-emit `bgo_id` alongside `task_id`. Both
            // carry the identical identifier for one release. Agents on
            // the new name should read `bgo_id`; legacy consumers keep
            // reading `task_id`.
            bgo_id: taskId,
            task_id: taskId,
            taskId,
            message: `Background operation "${taskId}" triggered on trigger.dev with runId ${handle.id}. It will run durably with retries.`,
            ...(deprecation_notice ? { deprecation_notice } : {}),
          };
        } catch (err: any) {
          this.logger.warn(`[spawn_bgo] trigger.dev failed, falling back to Redis: ${err?.message}`);
          // Fall through to Redis stub
        }
      }

      // Fallback: Redis stub
      const taskKey = `task:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${Date.now()}`;
      await this.redis.set(taskKey, JSON.stringify({
        taskId,
        instruction,
        tools: taskTools || [],
        timeout: timeout || "5m",
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
        agentId: scope.agentId || "default",
        status: "queued",
        createdAt: new Date().toISOString(),
      }), "EX", 86400);
      return {
        spawned: true,
        durable: false,
        taskKey,
        bgo_id: taskId,
        task_id: taskId,
        taskId,
        message: `Background operation "${taskId}" queued (Redis stub — environment API key not found or trigger.dev unreachable).`,
        ...(deprecation_notice ? { deprecation_notice } : {}),
      };
    };

    const spawnBgoParameters = z.object({
      taskId: z.string().describe("Unique identifier for this background-operation type (e.g., 'deep-research', 'data-export'). This is the underlying trigger.dev task id — keep the arg name stable."),
      instruction: z.string().describe("What the background operation should do"),
      tools: z.array(z.string()).optional().describe("Tool names the operation should have access to"),
      timeout: z.string().optional().describe("Max duration (e.g., '5m', '1h'). Default: 5m"),
    });

    // `spawn_task` was previously registered unconditionally — preserve that
    // default so freshly-upgraded agent rows that never had either key in
    // their `metaTools` map still get the durable-spawn capability.
    if (bgoMetaEnabled("spawn_bgo", "spawn_task", true)) {
      tools.spawn_bgo = {
        description: "Spawn a durable background operation (BGO) for long-running work like deep research, data processing, or multi-step workflows. The operation runs independently with retries and checkpointing — it won't be lost if the server restarts. Use this for operations that might take more than 30 seconds.",
        inputSchema: spawnBgoParameters,
        execute: async (args) => spawnBgoHandler(args, { emittedAs: "spawn_bgo" }),
      };
      // Deprecated alias — same handler, emits deprecation notice.
      tools.spawn_task = {
        description: "[DEPRECATED — use spawn_bgo] Spawn a durable background operation for long-running work. Kept as an alias for one release; prefer spawn_bgo in new code.",
        inputSchema: spawnBgoParameters,
        execute: async (args) => {
          bgoAliasWarn("spawn_task", "spawn_bgo");
          return spawnBgoHandler(args, { emittedAs: "spawn_task" });
        },
      };
    }

    // W.1 — agent_batch — spawn a durable loop that runs an LLM turn +
    // restricted tool subset per item in a supplied list. Returns a
    // `{ batchRunId }` handle immediately; per-item progress streams back
    // into the spawning thread as `run_update` events carrying
    // `metadata.progress = { type: "batch_progress", ... }` frames
    // (forwarded by RunsBridgeService). Default-on alongside spawn_bgo
    // when trigger.dev is configured — falls back to a Redis stub when
    // it isn't so the LLM gets a consistent response.
    //
    // Checks `agentConfig.metaTools.agent_batch` inline (default true).
    // The `metaEnabled` helper isn't in scope yet — it's defined further
    // down next to the trigger.dev control-plane tools.
    const agentBatchEnabled =
      agentConfig?.metaTools?.agent_batch === undefined
        ? true
        : !!agentConfig.metaTools.agent_batch;
    if (agentBatchEnabled) {
      const agentBatchParameters = z.object({
        items: z
          .array(z.any())
          .min(1)
          .max(1000)
          .describe(
            "Array of items to iterate. Each is serialized and concatenated to `per_item_instructions` as the per-item message.",
          ),
        per_item_instructions: z
          .string()
          .min(1)
          .describe(
            "User-style instructions applied per item. The item body is appended below these instructions for each sub-turn.",
          ),
        allowed_tools: z
          .array(z.string())
          .optional()
          .describe(
            "Whitelist of tool names (meta-tools OR entity tools) the sub-LLM may call. If an entity tool is listed, `execute_tools` is implicitly enabled and its `calls[].tool` is filtered against this list. Must be a subset of the agent's current tool matrix. Omit to inherit the full matrix.",
          ),
        max_concurrency: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Reserved for parallel execution. v1 runs sequentially regardless (forced to 1).",
          ),
        label: z
          .string()
          .optional()
          .describe(
            "Optional human-readable name shown in the trigger.dev dashboard + progress UI.",
          ),
      });

      tools.agent_batch = {
        description:
          "Run an LLM + tool loop over a list of items durably. Each item gets its own sub-turn with an optional restricted tool subset; per-item progress streams back to this thread as run_update events. Use for bulk ops (enrich N contacts, process N rows, summarize N docs). Returns { batchRunId } immediately; the batch continues in the background.",
        inputSchema: agentBatchParameters,
        execute: async (args) => {
          const {
            items,
            per_item_instructions,
            allowed_tools,
            max_concurrency,
            label,
          } = args;

          // Phase 1 review follow-up — cap the total items payload at
          // 1 MB so a runaway LLM can't queue a massive JSON blob that
          // blows out the trigger.dev payload size limit (currently 3 MB)
          // or balloons the per-item turn prompt. Measured at the meta-tool
          // boundary before we even spawn a task.
          const ITEMS_PAYLOAD_MAX_BYTES = 1_000_000;
          try {
            const serialized = JSON.stringify(items ?? []);
            if (serialized.length > ITEMS_PAYLOAD_MAX_BYTES) {
              return {
                spawned: false,
                error: "items_payload_too_large",
                message: `items payload exceeds 1 MB (${serialized.length} chars); use shorter items or fewer`,
              };
            }
          } catch {
            // Unserializable input — let downstream validation surface it.
          }

          // EOBD.47-style per-turn guard — reuse the spawn_bgo cap so a
          // runaway LLM can't queue unbounded batches in a single step.
          const maxBgosPerTurn = Math.max(
            1,
            agentConfig?.maxBgosPerTurn ?? env.PLATOS_MAX_BGOS_PER_TURN ?? 10,
          );
          const bgoCapKey = `bgo_cap:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.sessionId || "notread"}`;
          try {
            const count = await this.redis.incr(bgoCapKey);
            if (count === 1) await this.redis.expire(bgoCapKey, 600);
            if (count > maxBgosPerTurn) {
              return {
                spawned: false,
                error: "bgo_cap_exceeded",
                message: `agent_batch cap of ${maxBgosPerTurn} per turn reached (shared with spawn_bgo).`,
              };
            }
          } catch {
            // Redis hiccup — fail-open.
          }

          const batchRunId = crypto.randomUUID();
          const parentThreadId = (scope as any).threadId ?? scope.sessionId ?? "";
          const parentAgentId = scope.agentId || "default";

          // IDENTITY-CORE §B.3 (G3) — resolve the end user ONCE here (post-§C-
          // gate, so `null` when the origin thread gated closed) and carry it
          // down. Batch mints a FRESH thread per item with no parentThreadId, so
          // §B.2's thread-copy does NOT apply — the id must be threaded
          // explicitly and stamped server-side onto each item's scope. ALWAYS
          // include the key, even when `null`: a `null` is a signal (gated
          // closed), and dropping it would let the item fall through to the
          // fresh-per-item thread path and resolve a live walleId (fail-OPEN
          // hazard G3).
          const endUserId = await this.resolveOriginEndUserId(scope);

          const payload = {
            batchRunId,
            scope: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
              agentId: parentAgentId,
              sessionId: scope.sessionId,
              userToken: scope.userToken,
              entityId: scope.entityId,
              traceId: scope.traceId,
              parentSpanId: scope.parentSpanId,
            },
            parentThreadId,
            parentAgentId,
            items,
            perItemInstructions: per_item_instructions,
            allowedTools: allowed_tools,
            // v1 is sequential — cap here plus the task-level enforcement
            // so raising `max_concurrency` later is a task-only change.
            maxConcurrency: 1,
            label: label ?? null,
            // §B.3 (G3) — always present (string | null), never omitted.
            endUserId,
          };

          if (triggerReady() && triggerSdk?.tasks?.trigger) {
            try {
              const handle = await triggerSdk.tasks.trigger(
                "platos-agent-batch",
                payload,
                {
                  idempotencyKey: idemKey("agent_batch", {
                    items,
                    per_item_instructions,
                    allowed_tools,
                    label,
                  }),
                  tags: scopeTags,
                  metadata: { ...scopeMetadata, batchRunId, label: label ?? null },
                  queue: {
                    name: `org:${scope.organizationId}:batch`,
                    concurrencyLimit: parseInt(process.env.PLATOS_PER_ORG_BATCH_CONCURRENCY ?? "20", 10),
                  },
                },
              );
              // W.1.2 — subscribe the batch run to the parent thread's
              // Socket.IO room so each `metadata.progress` frame emitted
              // by `platos-agent-batch` ({ type: "batch_progress" | ...,
              // index, total, status, ... }) lands on
              // `thread:<parentThreadId>` as an `agent_event`
              // `run_update` carrying the metadata verbatim. Clients
              // already join that room via `join_thread` for normal
              // streaming, so no additional wire changes are needed.
              // Module cycle resolved via the forwardRef pair between
              // AgentRuntimeModule and TriggerBridgeModule.
              const runsBridge = this.getRunsBridge();
              if (runsBridge && parentThreadId) {
                try {
                  runsBridge.subscribe(handle.id, scope, parentThreadId);
                } catch (err: any) {
                  this.logger.warn(
                    `[agent_batch] runsBridge.subscribe failed for runId=${handle.id}: ${err?.message}`,
                  );
                }
              }
              // TODO(W.1.1): honor max_concurrency > 1 once the task-side
              // parallel pool lands. The parameter is accepted today but
              // the durable executor forces 1 for deterministic ordering
              // + no cross-item race on scoped counters.
              void max_concurrency;
              return {
                spawned: true,
                durable: true,
                batchRunId,
                runId: handle.id,
                itemCount: items.length,
                message: `agent_batch queued with ${items.length} item(s) — progress streams to this thread as run_update events (batchRunId=${batchRunId}, runId=${handle.id}).`,
              };
            } catch (err: any) {
              this.logger.warn(
                `[agent_batch] trigger.dev failed, falling back to Redis stub: ${err?.message}`,
              );
              // Fall through to Redis stub.
            }
          }

          // Fallback: Redis stub (trigger.dev not configured or failed).
          const stubKey = `agent_batch:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${batchRunId}`;
          await this.redis.set(
            stubKey,
            JSON.stringify({ ...payload, status: "queued", createdAt: new Date().toISOString() }),
            "EX",
            86400,
          );
          return {
            spawned: true,
            durable: false,
            batchRunId,
            itemCount: items.length,
            message: `agent_batch queued in Redis stub (trigger.dev not configured). batchRunId=${batchRunId}.`,
          };
        },
      };
    }

    // ────────────────────────────────────────────────────────────────
    // spawn_agent — durable, multi-turn, autonomous subagent. Unlike
    // `delegate_to_sub_agent` (synchronous, inline, one turn) or `agent_batch`
    // (N items × one turn each), this spawns a FULL agent loop on a CHILD
    // thread (parentThreadId lineage) via `platos.agent.subrun`, and — in
    // background mode — reports back into THIS thread so the parent reasons
    // over the result. Composition of owned rails (spec: docs/subagent-spawning-spec.md).
    //
    // Guardrails (all enforced server-side here, never client-trusted):
    //   • scope INHERITED — the child payload copies the parent's tuple 1:1;
    //     the arg schema exposes NO scope fields, so the caller cannot choose it.
    //   • depth ≤ 2 — a grandchild (depth 2) may not spawn.
    //   • children cap per turn — shares the spawn_bgo `bgo_cap` Redis counter.
    //   • budget = shared pool — enforced inside the subrun loop (budgetCents)
    //     + the scope-wide BudgetService backstop (child inherits parent scope).
    //   • tool-ACL narrowing — child tools ⊆ parent tools ∩ spec.allowedTools.
    //   • dedupe — idempotencyKey on (parentThread, task-hash) so a retried
    //     parent turn doesn't double-spawn.
    //   • run tagged parentThreadId/parentRunId for the runs tree.
    const spawnAgentEnabled =
      agentConfig?.metaTools?.spawn_agent === undefined ? true : !!agentConfig.metaTools.spawn_agent;
    if (spawnAgentEnabled) {
      const spawnAgentParameters = z.object({
        agentId: z
          .string()
          .optional()
          .describe(
            "WHO (mode a): id of a real Platos agent to run as — gets its own memory/skills/config. Omit to use an ephemeral inline spec (mode b, the default/cheaper path).",
          ),
        spec: z
          .object({
            model: z.string().optional().describe("Model label for the ephemeral subagent (e.g. 'anthropic:claude-haiku')."),
            systemPrompt: z.string().optional().describe("System prompt for the ephemeral subagent."),
            allowedTools: z
              .array(z.string())
              .optional()
              .describe(
                "Tool names the subagent may use. NARROWED server-side to a strict subset of THIS agent's current tool matrix — you can never grant the child a tool you don't hold. Omit to inherit (still bounded by) the parent matrix.",
              ),
            skills: z.array(z.string()).optional().describe("Skill names to enable for the ephemeral subagent."),
          })
          .optional()
          .describe("WHO (mode b): ephemeral inline spec — disposable, no registry row."),
        task: z.string().min(1).describe("WHAT: the task for the subagent to accomplish autonomously."),
        context: z.string().optional().describe("Any context the subagent should start with (prior findings, constraints)."),
        mode: z
          .enum(["background", "wait"])
          .optional()
          .describe(
            "background (default): returns immediately; the subagent reports back into this thread when done and wakes you to reason over it. wait: blocks for a short subtask and returns the result as the tool result.",
          ),
        maxTurns: z.number().int().min(1).max(20).optional().describe("Max autonomous turns the subagent may take (default 6)."),
        budgetCents: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Shared-pool spend ceiling (cents) drawn from the parent's budget; the subagent stops cleanly with a partial report when exhausted (default 50)."),
      });

      tools.spawn_agent = {
        description:
          "Spawn a durable, autonomous, multi-turn subagent that works toward a task and REPORTS BACK so you reason over its result (research a topic, fix a bug, verify a claim). Runs the full agent loop on a child thread with retries + durability. Use this — not agent_batch — when you need the RESULT as input to further reasoning. Returns { spawned, runId } immediately in background mode.",
        inputSchema: spawnAgentParameters,
        execute: async (args) => {
          const {
            agentId: refAgentId,
            spec,
            task: spawnTask,
            context: spawnContext,
            mode: rawMode,
            maxTurns: rawMaxTurns,
            budgetCents: rawBudgetCents,
          } = args;
          const mode: "background" | "wait" = rawMode === "wait" ? "wait" : "background";
          const maxTurns = Math.max(1, Math.min(20, rawMaxTurns ?? 6));
          const budgetCents = Math.max(1, Math.min(10000, rawBudgetCents ?? 50));

          // GUARDRAIL — depth cap ≤ 2. Read the runtime-stamped depth of the
          // CURRENT turn (0 for root turns; set by /internal/subagent-turn for
          // child turns). A depth-2 grandchild may not spawn.
          const currentDepth = normalizeSpawnDepth((scope as any).spawnDepth);
          if (!isSpawnDepthAllowed(currentDepth)) {
            return {
              spawned: false,
              error: "depth_cap_exceeded",
              message: `Subagent depth cap (${SUBAGENT_MAX_DEPTH}) reached — a grandchild agent cannot spawn further agents.`,
            };
          }
          const spawnDepth = childSpawnDepth(currentDepth);

          // GUARDRAIL — children cap per turn. Reuse the SHARED spawn_bgo
          // per-turn Redis counter (bounds spawn_bgo + agent_batch + spawn_agent
          // combined per turn) but enforce spawn_agent's own lower ceiling.
          const maxChildren = resolveMaxChildrenPerTurn(
            agentConfig?.maxChildrenPerTurn,
            process.env.PLATOS_MAX_CHILDREN_PER_TURN,
          );
          const capKey = `bgo_cap:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.sessionId || "notread"}`;
          try {
            const count = await this.redis.incr(capKey);
            if (count === 1) await this.redis.expire(capKey, 600);
            if (count > maxChildren) {
              return {
                spawned: false,
                error: "children_cap_exceeded",
                message: `spawn_agent cap of ${maxChildren} children per turn reached (shared with spawn_bgo / agent_batch). Stop spawning.`,
              };
            }
          } catch {
            // Redis hiccup — fail-open (availability over strict cap), same as spawn_bgo.
          }

          // GUARDRAIL — tool-ACL narrowing. Child ENTITY tools ⊆ parent matrix ∩
          // spec.allowedTools. Computed here where we know the parent's
          // effective tool set; passed through to every child turn (narrows the
          // child's `execute_tools` dispatch surface).
          const parentTools = agentConfig?.toolsBlockConfig?.enabledTools ?? [];
          const childEntityTools = narrowSpawnToolAcl(parentTools, spec?.allowedTools);
          // Depth ≤ 2 is a REAL capability, not just a block: a first-level
          // child (depth 1) keeps `spawn_agent` so it may spawn once more; a
          // depth-2 grandchild is denied the tool here AND refused by the depth
          // guard in its own handler (belt + suspenders). The narrowed entity
          // subset above is unaffected — child entity tools stay ⊆ parent.
          const childAllowedTools =
            spawnDepth < SUBAGENT_MAX_DEPTH ? [...childEntityTools, "spawn_agent"] : childEntityTools;

          const parentThreadId = (scope as any).threadId ?? scope.sessionId ?? "";
          const parentAgentId = scope.agentId || "default";
          const parentRunId = (scope as any).runId ?? null;

          if (!triggerReady() || !triggerSdk?.tasks?.trigger) {
            return {
              spawned: false,
              error: "trigger_unavailable",
              message:
                "spawn_agent requires trigger.dev (durable execution), which is not configured for this environment. Use delegate_to_sub_agent for an inline delegation instead.",
            };
          }

          // GUARDRAIL — scope INHERITED, never chosen. Copy the parent tuple 1:1.
          const childScope = {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
            agentId: refAgentId || parentAgentId,
            sessionId: scope.sessionId,
            userToken: scope.userToken,
            entityId: scope.entityId,
            traceId: scope.traceId,
            parentSpanId: scope.parentSpanId,
          };

          const payload = {
            scope: childScope,
            parentThreadId,
            parentAgentId,
            parentRunId,
            spawnDepth,
            task: spawnTask,
            context: spawnContext ?? null,
            referencedAgentId: refAgentId ?? null,
            spec: spec
              ? { model: spec.model ?? null, systemPrompt: spec.systemPrompt ?? null, skills: spec.skills ?? null }
              : null,
            allowedTools: childAllowedTools,
            maxTurns,
            budgetCents,
            mode,
          };

          // GUARDRAIL — dedupe. idempotencyKey on (parentThread, task-hash) so a
          // retried parent turn returns the existing child run.
          const idempotencyKey = spawnDedupeKey({
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            parentThreadId,
            task: spawnTask,
            spec: spec ?? refAgentId ?? null,
          });

          // GUARDRAIL — run tagged parentThreadId/parentRunId for the runs tree.
          const spawnTags = [
            ...scopeTags,
            `parentThread:${parentThreadId || "unscoped"}`,
            `spawnDepth:${spawnDepth}`,
            "kind:subagent",
            ...(parentRunId ? [`parentRun:${parentRunId}`] : []),
          ];
          const spawnMetadata = {
            ...scopeMetadata,
            parentThreadId,
            spawnDepth,
            kind: "subagent",
            task: spawnTask.slice(0, 200),
          };
          const queue = {
            name: `org:${scope.organizationId}:subagent`,
            concurrencyLimit: parseInt(process.env.PLATOS_PER_ORG_SUBAGENT_CONCURRENCY ?? "20", 10),
          };

          try {
            const handle = await triggerSdk.tasks.trigger("platos.agent.subrun", payload, {
              idempotencyKey,
              tags: spawnTags,
              metadata: spawnMetadata,
              queue,
            });

            // Stream child progress into the PARENT thread's room (agent_batch
            // pattern) so the parent conversation shows the subagent working.
            const runsBridge = this.getRunsBridge();
            if (runsBridge && parentThreadId) {
              try {
                runsBridge.subscribe(handle.id, scope, parentThreadId);
              } catch (err: any) {
                this.logger.warn(`[spawn_agent] runsBridge.subscribe failed for runId=${handle.id}: ${err?.message}`);
              }
            }

            if (mode === "wait") {
              // Short subtask — poll the run to terminal (bounded) and return
              // its output as the tool result. Degrades to background semantics
              // (result reported into the thread) if the poll times out.
              const TERMINAL = new Set([
                "COMPLETED",
                "FAILED",
                "CANCELED",
                "CRASHED",
                "TIMED_OUT",
                "SYSTEM_FAILURE",
              ]);
              const waitTimeoutMs = Math.min(180_000, Math.max(20_000, maxTurns * 20_000));
              const deadline = Date.now() + waitTimeoutMs;
              while (Date.now() < deadline) {
                if (abortSignal?.aborted) break;
                let run: any = null;
                try {
                  run = await triggerSdk.runs?.retrieve?.(handle.id);
                } catch {
                  // retrieve unavailable/transient — fall through to poll again.
                }
                const status = String(run?.status ?? "");
                if (TERMINAL.has(status)) {
                  return {
                    spawned: true,
                    durable: true,
                    waited: true,
                    runId: handle.id,
                    status,
                    result: run?.output ?? null,
                    message: `Subagent finished (${status}).`,
                  };
                }
                await new Promise((r) => setTimeout(r, 2500));
              }
              return {
                spawned: true,
                durable: true,
                waited: false,
                runId: handle.id,
                message:
                  "Subagent wait timed out; it continues in the background and will report back into this thread when done.",
              };
            }

            return {
              spawned: true,
              durable: true,
              runId: handle.id,
              mode,
              spawnDepth,
              allowedTools: childAllowedTools,
              message: `spawn_agent dispatched (runId=${handle.id}, depth=${spawnDepth}). The subagent runs durably on a child thread and will report back into this thread when done — you'll be able to reason over its result then.`,
            };
          } catch (err: any) {
            this.logger.warn(`[spawn_agent] trigger.dev dispatch failed: ${err?.message}`);
            return {
              spawned: false,
              error: "dispatch_failed",
              message: `Failed to dispatch subagent: ${err?.message ?? String(err)}`,
            };
          }
        },
      };
    }

    // request_approval — HITL waitpoint. LLM calls this before a destructive or
    // high-stakes action. Emits approval_needed to the thread's Socket.IO room,
    // waits up to 5 minutes for an approve/deny response via Redis BLPOP on a
    // unique approval key. UI resolves via POST /api/v1/agent/approvals/:id or
    // via socket `approval_response` event.
    tools.request_approval = {
      description: "Pause and request human approval before a sensitive action (sending emails, making purchases, deleting data, calling external APIs with side effects). Returns { approved: true/false, comment?: string }. Times out after 5 minutes (returns { approved: false, reason: 'timeout' }).",
      inputSchema: z.object({
        action: z.string().describe("What you want to do — one-line description shown to the user"),
        details: z.string().optional().describe("Additional context (params, target, impact) to help the user decide"),
      }),
      execute: async ({ action, details }) => {
        // PRELAUNCH-A3-11 — per-(agent, user) approval-rate cap. Default
        // 20/hr (configurable via PLATOS_AGENT_USER_APPROVAL_PER_HOUR).
        // Prevents a misbehaving agent from DoS-ing one user with
        // unbounded approval modals.
        if (this.rateLimitService && scope.agentId && scope.userId) {
          try {
            const rl = await this.rateLimitService.checkApprovalEvent(
              {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
              },
              scope.agentId,
              scope.userId,
            );
            if (!rl.allowed) {
              return {
                approved: false,
                reason: `approval rate limit exceeded (limit ${rl.limit}/hour). Retry in ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s).`,
              };
            }
          } catch {
            // Fail-open: don't block the approval flow on a rate-limit backend
            // hiccup.
          }
        }
        const approvalId = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.agentId || "default"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        // EOBD.15 — scoped Redis namespace. See ../monitoring/approval-keys.
        const redisKey = approvalRedisKey(scope, approvalId);
        const timeoutSeconds = 300; // 5 minutes

        // Persist the pending approval to the governance ledger BEFORE we
        // publish — ensures /monitoring/approvals never shows a waitpoint
        // that has no row (Theme E.6).
        await this.approvalsService?.record({
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          approvalId,
          source: "request_approval",
          agentId: scope.agentId || null,
          threadId: (scope as any).threadId || null,
          requestedBy: scope.userId,
          action,
          details: details ?? null,
          timeoutSeconds,
        });

        // Publish the approval request to the thread's Socket.IO room via Redis pub/sub.
        // The ConnectionsGateway subscribes to `platos:approval:event` and forwards to the right room.
        await this.redis.publish(
          "approval:event",
          JSON.stringify({
            type: "approval_needed",
            approvalId,
            action,
            details,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            agentId: scope.agentId || "default",
            userId: scope.userId,
          }),
        );

        // Wait on Redis list (BLPOP — blocks until something is pushed, with timeout).
        //
        // CRITICAL: ioredis serializes commands on a single connection. If we
        // BLPOP on `this.redis`, every other Redis op in the agent process
        // (publishes, rpushes from the resolve handler, list ops) queues
        // behind it for the full 5-minute window. The user's HTTP-resolve POST
        // *does* hit the agent, but its `redis.rpush(redisKey, payload)` waits
        // 5 minutes before firing — by which time the frontend's 15s timeout
        // has long since aborted. Use a dedicated duplicate connection per
        // call so the block stays isolated to that socket. Cheap (one TCP
        // open/close per request_approval) and correct.
        const blockClient = (this.redis as any).duplicate?.() ?? this.redis;
        const usingDuplicate = blockClient !== this.redis;
        try {
          const result = await blockClient.blpop(redisKey, timeoutSeconds);
          if (!result) {
            await this.approvalsService?.resolve({
              scope: {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
              },
              approvalId,
              status: "timed_out",
            });
            // Wake any UI cards still showing the spinner — without this the
            // browser modal stays "Approving…" forever after the agent moved on.
            await this.redis.publish(
              "approval:event",
              JSON.stringify({
                type: "approval_resolved",
                approvalId,
                status: "timed_out",
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
                agentId: scope.agentId || "default",
                // SECURITY (audit H4 regression) — carry requester userId so
                // the timeout reaches their user room (they left the scope room).
                userId: scope.userId ?? null,
              }),
            ).catch(() => {});
            return { approved: false, reason: "timeout", message: "User did not respond within 5 minutes" };
          }
          const [, payload] = result;
          const parsed = JSON.parse(payload);
          // The HTTP / socket resolver persists its own transition, but we
          // double-write here too so the ledger is consistent even if the
          // resolver's persistence path fails (best-effort + idempotent).
          await this.approvalsService?.resolve({
            scope: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            approvalId,
            status: parsed.approved ? "approved" : "rejected",
            respondedBy: parsed.respondedBy ?? null,
            comment: parsed.comment ?? null,
          });
          return {
            // Normalize optional fields to null so the returned object never
            // carries an `undefined` property into the tool-result part (the
            // hardenToolResults boundary also enforces this, defence in depth).
            approved: !!parsed.approved,
            comment: parsed.comment ?? null,
            respondedBy: parsed.respondedBy ?? null,
          };
        } catch (err: any) {
          return { approved: false, reason: "error", message: err?.message || "Approval wait failed" };
        } finally {
          // Cleanup: delete the key if still there. Use the unblocked main
          // client; the duplicate is about to be torn down.
          await this.redis.del(redisKey).catch(() => {});
          if (usingDuplicate) {
            try { (blockClient as any).disconnect?.(); } catch { /* ignore */ }
          }
        }
      },
    };

    // ────────────────────────────────────────────────────────────────
    // Trigger.dev control plane meta-tools (Theme B.5)
    //
    // Every call carries the scope via `tags` + `metadata` so runs can be
    // filtered and attributed downstream. Each call gets a deterministic
    // idempotency key derived from (scope, toolName, JSON payload) — if the
    // model retries the same call, trigger.dev returns the existing run
    // handle instead of firing a duplicate.
    //
    // Individual control-plane tools are opt-in via `agentConfig.metaTools`
    // so agents that shouldn't schedule / cancel runs don't get the capability.
    // ────────────────────────────────────────────────────────────────
    const enabledMetaTools = agentConfig?.metaTools ?? {};
    const metaEnabled = (name: string): boolean => !!enabledMetaTools[name];

    const scopeTags = [
      `org:${scope.organizationId}`,
      `project:${scope.projectId}`,
      `env:${scope.environmentId}`,
      `agent:${scope.agentId || "default"}`,
      `thread:${(scope as any).threadId || "unscoped"}`,
      `user:${scope.userId}`,
    ];
    const scopeMetadata = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: scope.userId,
      agentId: scope.agentId || "default",
      threadId: (scope as any).threadId || null,
    };
    const idemKey = (toolName: string, payload: unknown) => {
      const body = JSON.stringify(payload ?? {});
      return crypto
        .createHash("sha256")
        .update(`${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${toolName}:${body}`)
        .digest("hex")
        .slice(0, 32);
    };
    const triggerReady = () => triggerConfigured && !!triggerSdk?.tasks?.trigger;

    // PIFSP-12 — run_platos_task: execute an operator-authored custom task.
    // Gated on metaTools.run_platos_task (default off).
    // Only tasks with triggerType "agent-spawn" and the current agentId in
    // allowedAgentIds can be dispatched by the agent.
    if (metaEnabled("run_platos_task")) {
      tools.run_platos_task = {
        description: "Run an operator-authored custom task defined in the Platos task editor. Use this when the user wants to trigger a specific workflow or automation. The task must have triggerType=agent-spawn and allow this agent.",
        inputSchema: z.object({
          taskId: z.string().describe("The task slug (e.g. 'send-email', 'process-payment')"),
          payload: z.record(z.unknown()).optional().describe("Input data for the task"),
        }),
        execute: async (args: { taskId: string; payload?: Record<string, unknown> }) => {
          const prisma = (this as any).prisma as any;
          const taskRow = await prisma.platosTask.findFirst({
            where: {
              taskId: args.taskId,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              isActive: true,
            },
            select: { id: true, taskId: true, displayName: true, triggerType: true, allowedAgentIds: true },
          });
          if (!taskRow) return { error: `Task "${args.taskId}" not found or inactive in this scope.` };
          if (taskRow.triggerType !== "agent-spawn") {
            return { error: `Task "${args.taskId}" has triggerType "${taskRow.triggerType}" — only agent-spawn tasks can be invoked via run_platos_task.` };
          }
          const agentId = scope.agentId as string | undefined;
          if (agentId && taskRow.allowedAgentIds.length > 0 && !taskRow.allowedAgentIds.includes(agentId)) {
            return { error: `Agent is not in the allowedAgentIds list for task "${args.taskId}".` };
          }
          if (!triggerReady()) {
            return { queued: false, message: "TRIGGER_SECRET_KEY not configured — task execution unavailable." };
          }
          try {
            const run = await triggerSdk!.tasks.trigger("platos-custom-task", {
              taskRowId: taskRow.id,
              payload: args.payload ?? {},
              scope: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId, userId: scope.userId },
              invokedBy: "agent",
              agentId,
            }, {
              // L7 — tag the run with scope so get_run_details / replay_run can
              // verify ownership on retrieve. This was the ONE trigger site that
              // carried scope only inside the payload, leaving its runs
              // unverifiable (and thus rejected by the fail-closed check above).
              // scopeTags/scopeMetadata are the same consts every other site uses.
              tags: scopeTags,
              metadata: { ...scopeMetadata, taskIdHint: taskRow.taskId },
            });
            return { queued: true, runId: run.id, taskId: taskRow.taskId, displayName: taskRow.displayName };
          } catch (err: any) {
            return { error: `Failed to queue task: ${err?.message}` };
          }
        },
      };
    }

    // PPR-51 — request_durable_approval — HITL waitpoint that survives a
    // restart. Unlike `request_approval` (Redis BLPOP, in-process), this
    // fires a trigger.dev task (`platos-agent-durable-approval-wait`) that
    // pauses at `wait.forToken`. The UI resolves via
    // `POST /api/v1/agent/durable-approvals/:token/resolve`, which wakes
    // the task. Records via MonitoringApprovalsService so the approval
    // shows up on the existing dashboard (Theme E.6 pattern).
    if (metaEnabled("request_durable_approval")) tools.request_durable_approval = {
      description: "Pause for human approval with a durable waitpoint (up to 7 days). Unlike request_approval this survives a process restart. Returns { approved, comment?, reason? }. Use for long-running approval windows — e.g. sending a scheduled email or triggering an expensive batch job overnight.",
      inputSchema: z.object({
        action: z.string().describe("What you want to do — one-line description shown to the user"),
        details: z.string().optional().describe("Additional context (params, target, impact) to help the user decide"),
        timeoutSeconds: z.number().int().min(60).max(86400 * 7).optional().describe("Max wait in seconds (default 86400 = 1 day, max 7 days)"),
      }),
      execute: async ({ action, details, timeoutSeconds }) => {
        if (!triggerReady() || !triggerSdk?.tasks?.triggerAndWait || !triggerSdk?.wait?.createToken) {
          return { approved: false, reason: "unavailable", message: "trigger.dev not configured — durable approvals disabled" };
        }
        const effectiveTimeout = Math.max(60, Math.min(timeoutSeconds ?? 86400, 86400 * 7));
        const approvalId = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${scope.agentId || "default"}:durable:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        // 1. Record the pending approval so the governance dashboard shows
        //    it alongside in-process approvals. Best-effort (never blocks
        //    the tool).
        await this.approvalsService?.record({
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          approvalId,
          source: "request_approval",
          agentId: scope.agentId || null,
          threadId: (scope as any).threadId || null,
          requestedBy: scope.userId,
          action,
          details: details ?? null,
          timeoutSeconds: effectiveTimeout,
        });

        try {
          // 2. Mint the waitpoint token. We embed the scope in `tags` so
          //    the resolve endpoint can scope-check the token before
          //    completing it.
          const tokenHandle = await triggerSdk.wait.createToken({
            timeout: `${effectiveTimeout}s`,
            tags: [
              `org:${scope.organizationId}`,
              `project:${scope.projectId}`,
              `env:${scope.environmentId}`,
              `approval:${approvalId}`,
              `agent:${scope.agentId || "default"}`,
            ],
          });
          const token = typeof tokenHandle === "string" ? tokenHandle : tokenHandle?.id;
          if (!token) {
            return { approved: false, reason: "error", message: "Token mint failed" };
          }

          // 3. Publish approval_needed through the same Redis channel that
          //    in-process approvals use. `durableToken` tells the UI to
          //    POST to `/durable-approvals/:token/resolve` instead of the
          //    in-process endpoint.
          await this.redis.publish(
            "approval:event",
            JSON.stringify({
              type: "approval_needed",
              approvalId,
              action,
              details,
              durableToken: token,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              agentId: scope.agentId || "default",
              userId: scope.userId,
            }),
          );

          // 4. Fire the wait task. `triggerAndWait` blocks the outer
          //    agent turn until the UI resolves the token (or timeout).
          const handle = await triggerSdk.tasks.triggerAndWait(
            "platos-agent-durable-approval-wait",
            {
              token,
              approvalId,
              action,
              details,
              timeoutSeconds: effectiveTimeout,
              scope: {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
                userId: scope.userId,
                agentId: scope.agentId || "default",
                threadId: (scope as any).threadId ?? null,
              },
            },
            {
              tags: scopeTags,
              metadata: { ...scopeMetadata, approvalId, durableToken: token },
              idempotencyKey: idemKey("request_durable_approval", { approvalId, token }),
            },
          );

          if (!handle?.ok) {
            await this.approvalsService?.resolve({
              scope: {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
              },
              approvalId,
              status: "timed_out",
            });
            return { approved: false, reason: "timeout", message: "No response before deadline" };
          }
          const out = handle.output as {
            approved: boolean;
            reason?: string;
            comment?: string | null;
            respondedBy?: string | null;
          };
          await this.approvalsService?.resolve({
            scope: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            approvalId,
            status: out.approved ? "approved" : out.reason === "timeout" ? "timed_out" : "rejected",
            respondedBy: out.respondedBy ?? null,
            comment: out.comment ?? null,
          });
          return {
            approved: !!out.approved,
            reason: out.reason,
            comment: out.comment ?? null,
            respondedBy: out.respondedBy ?? null,
          };
        } catch (err: any) {
          return { approved: false, reason: "error", message: err?.message || "Durable approval failed" };
        }
      },
    };

    // spawn_batch — fire N runs of the same task with distinct payloads.
    if (metaEnabled("spawn_batch")) tools.spawn_batch = {
      description:
        "Fire a batch of trigger.dev runs of the same task with different payloads. Returns { batchId, runs: [...] } so you can later call wait_for_runs to aggregate. Each run is tagged with the current scope and inherits idempotency based on its payload.",
      inputSchema: z.object({
        taskId: z.string().describe("trigger.dev task identifier to run for every payload"),
        payloads: z.array(z.record(z.unknown())).min(1).describe("Payload for each run"),
      }),
      execute: async ({ taskId, payloads }) => {
        if (!triggerReady() || !triggerSdk?.tasks?.batchTrigger) {
          return { status: "skipped", reason: "trigger.dev not configured", runs: [] };
        }
        try {
          const items = payloads.map((payload: Record<string, unknown>) => ({
            payload,
            options: {
              tags: scopeTags,
              metadata: { ...scopeMetadata, taskIdHint: taskId },
              idempotencyKey: idemKey(`spawn_batch:${taskId}`, payload),
            },
          }));
          const handle = await triggerSdk.tasks.batchTrigger(taskId, items);
          return {
            status: "triggered",
            batchId: handle.batchId,
            runs: handle.runs?.map((r: any) => ({ id: r.id, taskIdentifier: r.taskIdentifier })) ?? [],
          };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "spawn_batch failed" };
        }
      },
    };

    // wait_for_runs — poll trigger.dev for run completion, stream progress.
    if (metaEnabled("wait_for_runs")) tools.wait_for_runs = {
      description:
        "Wait for a list of trigger.dev runs to complete. Polls status every 2s up to the timeout (default 5 minutes). Returns per-run { id, status, output? } when all resolve or the timeout fires.",
      inputSchema: z.object({
        runIds: z.array(z.string()).min(1).describe("Run ids from spawn_bgo / spawn_batch / schedule_bgo (or deprecated aliases spawn_task / trigger_with_delay)"),
        timeoutSeconds: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .optional()
          .describe("Max wait time in seconds (default 300)."),
      }),
      execute: async ({ runIds, timeoutSeconds }) => {
        if (!triggerReady() || !triggerSdk?.runs?.retrieve) {
          return { status: "skipped", reason: "trigger.dev not configured" };
        }
        const deadline = Date.now() + (timeoutSeconds ?? 300) * 1000;
        const pending = new Set<string>(runIds as string[]);
        const settled: Record<string, unknown> = {};
        while (pending.size > 0 && Date.now() < deadline) {
          const ids = Array.from(pending);
          const snapshots = await Promise.all(
            ids.map((id) => triggerSdk.runs.retrieve(id).catch(() => null)),
          );
          for (let i = 0; i < ids.length; i++) {
            const snap = snapshots[i];
            if (!snap) continue;
            if (["COMPLETED", "FAILED", "CANCELED", "CRASHED", "TIMED_OUT", "SYSTEM_FAILURE"].includes(snap.status)) {
              settled[ids[i]] = { status: snap.status, output: snap.output ?? null };
              pending.delete(ids[i]);
            }
          }
          if (pending.size > 0) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        return {
          status: pending.size === 0 ? "completed" : "timeout",
          settled,
          stillPending: Array.from(pending),
        };
      },
    };

    // get_run_details — status + output + recent logs.
    if (metaEnabled("get_run_details")) tools.get_run_details = {
      description: "Fetch the current status, output, tags and metadata for a single trigger.dev run.",
      inputSchema: z.object({
        runId: z.string().describe("Run id (e.g. returned by spawn_bgo / the deprecated spawn_task alias)"),
      }),
      execute: async ({ runId }) => {
        if (!triggerReady() || !triggerSdk?.runs?.retrieve) {
          return { status: "skipped", reason: "trigger.dev not configured" };
        }
        try {
          const snap = await triggerSdk.runs.retrieve(runId);
          // L7 — verify the retrieved run belongs to the caller's scope. Runs
          // are tagged with { organizationId, projectId, environmentId } at
          // trigger time (scopeMetadata); reject cross-scope inspection so a
          // caller can't read another scope's run by guessing its id.
          const _md = (snap.metadata ?? {}) as Record<string, any>;
          if (
            _md.organizationId !== scope.organizationId ||
            _md.projectId !== scope.projectId ||
            _md.environmentId !== scope.environmentId
          ) {
            return { status: "denied", reason: "run not in caller scope" };
          }
          return {
            id: snap.id,
            taskIdentifier: snap.taskIdentifier,
            status: snap.status,
            output: snap.output ?? null,
            error: snap.error ?? null,
            tags: snap.tags ?? [],
            metadata: snap.metadata ?? {},
            startedAt: snap.startedAt,
            completedAt: snap.completedAt,
          };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "get_run_details failed" };
        }
      },
    };

    // cancel_run — pause a running task. Approval-gated by default.
    if (metaEnabled("cancel_run")) tools.cancel_run = {
      description:
        "Cancel a running trigger.dev run. Approval-gated by default — the caller pauses for up to 5 minutes while a human approves/denies in the UI. Set `skipApproval:true` only for obviously non-destructive cancellations.",
      inputSchema: z.object({
        runId: z.string().describe("Run id to cancel"),
        reason: z.string().optional().describe("Why cancelling — shown in the approval prompt"),
        skipApproval: z.boolean().optional().describe("Bypass the HITL gate (default false)"),
      }),
      execute: async ({ runId, reason, skipApproval }) => {
        if (!triggerReady() || !triggerSdk?.runs?.cancel) {
          return { status: "skipped", reason: "trigger.dev not configured" };
        }
        if (!skipApproval) {
          const approvalId = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:cancel:${runId}:${Date.now()}`;
          const timeoutSeconds = 300;
          // Persist the pending cancel-approval to the governance ledger
          // (Theme E.6) before publishing so the UI never sees a waitpoint
          // without a row.
          await this.approvalsService?.record({
            scope: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            approvalId,
            source: "cancel_run",
            agentId: scope.agentId || null,
            threadId: (scope as any).threadId || null,
            requestedBy: scope.userId,
            action: `Cancel run ${runId}`,
            details: reason || "Cancel request from agent",
            timeoutSeconds,
          });
          await this.redis.publish(
            "approval:event",
            JSON.stringify({
              type: "approval_needed",
              approvalId,
              action: `Cancel run ${runId}`,
              details: reason || "Cancel request from agent",
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              agentId: scope.agentId || "default",
              userId: scope.userId,
            }),
          );
          // EOBD.15 — scoped Redis namespace.
          const redisKey = approvalRedisKey(scope, approvalId);
          // See `request_approval` above for why BLPOP needs its own
          // connection — running it on `this.redis` blocks every other Redis
          // command in the agent process for the full timeout window,
          // including the resolve handler's rpush that's supposed to wake us.
          const blockClient = (this.redis as any).duplicate?.() ?? this.redis;
          const usingDuplicate = blockClient !== this.redis;
          try {
            const result = await blockClient.blpop(redisKey, timeoutSeconds);
            if (!result) {
              await this.approvalsService?.resolve({
                scope: {
                  organizationId: scope.organizationId,
                  projectId: scope.projectId,
                  environmentId: scope.environmentId,
                },
                approvalId,
                status: "timed_out",
              });
              await this.redis.publish(
                "approval:event",
                JSON.stringify({
                  type: "approval_resolved",
                  approvalId,
                  status: "timed_out",
                  organizationId: scope.organizationId,
                  projectId: scope.projectId,
                  environmentId: scope.environmentId,
                  agentId: scope.agentId || "default",
                  // SECURITY (audit H4 regression) — carry requester userId so
                  // the timeout reaches their user room (they left the scope room).
                  userId: scope.userId ?? null,
                }),
              ).catch(() => {});
              return { status: "denied", reason: "timeout" };
            }
            const parsed = JSON.parse(result[1]);
            await this.approvalsService?.resolve({
              scope: {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
              },
              approvalId,
              status: parsed.approved ? "approved" : "rejected",
              respondedBy: parsed.respondedBy ?? null,
              comment: parsed.comment ?? null,
            });
            if (!parsed.approved) return { status: "denied", reason: "rejected", comment: parsed.comment };
          } finally {
            await this.redis.del(redisKey).catch(() => {});
            if (usingDuplicate) {
              try { (blockClient as any).disconnect?.(); } catch { /* ignore */ }
            }
          }
        }
        try {
          await triggerSdk.runs.cancel(runId);
          return { status: "cancelled", runId };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "cancel_run failed" };
        }
      },
    };

    // create_schedule — register a cron-scheduled run.
    if (metaEnabled("create_schedule")) tools.create_schedule = {
      description:
        "Register a cron-scheduled trigger.dev run. The schedule is tagged with the current scope and will execute the target task with the given payload on each firing.",
      inputSchema: z.object({
        taskId: z.string().describe("Task identifier to run on each firing"),
        cron: z.string().describe("Cron expression (5 or 6 fields)"),
        payload: z.record(z.unknown()).optional().describe("Payload sent on every firing"),
        timezone: z.string().optional().describe("IANA tz (e.g. 'America/Los_Angeles'). Default UTC."),
      }),
      execute: async ({ taskId, cron, payload, timezone }) => {
        if (!triggerSdk?.schedules?.create) {
          return { status: "skipped", reason: "trigger.dev schedules API not available" };
        }
        try {
          const schedule = await triggerSdk.schedules.create({
            task: taskId,
            cron,
            timezone: timezone || "UTC",
            externalId: `platos:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${taskId}:${idemKey("schedule", { cron, payload })}`,
            deduplicationKey: idemKey("schedule", { taskId, cron, payload, timezone: timezone || "UTC" }),
            // payload passed via trigger.dev schedule payload
          });
          return { status: "created", scheduleId: schedule.id, nextRun: schedule.nextRun ?? null };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "create_schedule failed" };
        }
      },
    };

    // list_bgos (Theme BGO — formerly `list_tasks`) — background-operation
    // catalog discovery scoped by the current project. Old name
    // `list_tasks` is registered below as a deprecated alias pointing at
    // the same handler for one release.
    const listBgosParameters = z.object({
      filter: z.string().optional().describe("Substring match on background-operation slug"),
      limit: z.number().int().min(1).max(200).optional(),
    });
    const listBgosHandler = async (
      args: { filter?: string; limit?: number },
      opts: { emittedAs: "list_bgos" | "list_tasks" },
    ) => {
      const { filter, limit } = args;
      const deprecation_notice =
        opts.emittedAs === "list_tasks" ? bgoDeprecation("list_tasks", "list_bgos") : undefined;
      try {
        // PPR-20 — scope filter MUST include runtimeEnvironmentId. Before
        // this fix an agent in env=dev could enumerate prod tasks by
        // project alone (Theme B + Runtime reviews flagged as cross-env
        // leak). `runtimeEnvironmentId` dropped from the select too so the
        // leak isn't visible in the response even if the where clause ever
        // regresses.
        const where: Record<string, unknown> = {
          projectId: scope.projectId,
          runtimeEnvironmentId: scope.environmentId,
        };
        if (filter) (where as any).slug = { contains: filter };
        const rows = await this.prisma.backgroundWorkerTask.findMany({
          where,
          select: {
            slug: true,
            filePath: true,
            triggerSource: true,
            description: true,
          },
          distinct: ["slug"],
          orderBy: { slug: "asc" },
          take: limit ?? 50,
        });
        // Theme BGO — dual-emit `bgos` + `tasks` (identical array) for one
        // release so callers on either name see the rows.
        return {
          bgos: rows,
          tasks: rows,
          ...(deprecation_notice ? { deprecation_notice } : {}),
        };
      } catch (err: any) {
        return { status: "failed", error: err?.message || `${opts.emittedAs} failed` };
      }
    };
    // `list_tasks` was previously gated on `metaEnabled("list_tasks")` with
    // default-false; preserve that (opt-in) default under the new name.
    if (bgoMetaEnabled("list_bgos", "list_tasks", false)) {
      tools.list_bgos = {
        description:
          "List background operations (BGOs) available in the current project/env. Returns `{ bgos: [{ slug, filePath?, triggerSource, description? }] }`. Optional text filter. Backed by the underlying trigger.dev task catalog.",
        inputSchema: listBgosParameters,
        execute: async (args) => listBgosHandler(args, { emittedAs: "list_bgos" }),
      };
      tools.list_tasks = {
        description:
          "[DEPRECATED — use list_bgos] List background operations available in the current project/env. Kept as an alias for one release; prefer list_bgos in new code.",
        inputSchema: listBgosParameters,
        execute: async (args) => {
          bgoAliasWarn("list_tasks", "list_bgos");
          return listBgosHandler(args, { emittedAs: "list_tasks" });
        },
      };
    }

    // list_runs — recent runs for the current scope, with optional filter.
    if (metaEnabled("list_runs")) tools.list_runs = {
      description:
        "List recent trigger.dev runs for the current project + environment. Optionally filter by taskId or status. Returns `{ runs: [{ id, taskIdentifier, status, startedAt, completedAt }] }`.",
      inputSchema: z.object({
        taskId: z.string().optional().describe("Filter by trigger.dev task slug"),
        status: z.string().optional().describe("Filter by run status (e.g. 'COMPLETED', 'FAILED')"),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 25)"),
      }),
      execute: async ({ taskId, status, limit }) => {
        try {
          const where: Record<string, unknown> = {
            projectId: scope.projectId,
            runtimeEnvironmentId: scope.environmentId,
          };
          if (taskId) (where as any).taskIdentifier = taskId;
          if (status) (where as any).status = status;
          const rows = await this.prisma.taskRun.findMany({
            where,
            select: {
              friendlyId: true,
              taskIdentifier: true,
              status: true,
              createdAt: true,
              completedAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: limit ?? 25,
          });
          return {
            runs: rows.map((r: any) => ({
              id: r.friendlyId,
              taskIdentifier: r.taskIdentifier,
              status: r.status,
              startedAt: r.createdAt,
              completedAt: r.completedAt,
            })),
          };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "list_runs failed" };
        }
      },
    };

    // schedule_bgo (Theme BGO — formerly `trigger_with_delay`) — schedule a
    // single-shot background operation to fire after a delay (e.g. '5m',
    // '2h', '24h' or ISO timestamp). Uses trigger.dev's `delay` option so
    // the run is queued but starts after the wait. Old name
    // `trigger_with_delay` is kept as a deprecated alias for one release.
    const scheduleBgoParameters = z.object({
      taskId: z.string().describe("Background-operation identifier to trigger (underlying trigger.dev task id)"),
      payload: z.record(z.unknown()).optional().describe("Payload for the run"),
      after: z.string().describe("Delay string (e.g. '5m', '1h') or ISO-8601 date"),
    });
    const scheduleBgoHandler = async (
      args: { taskId: string; payload?: Record<string, unknown>; after: string },
      opts: { emittedAs: "schedule_bgo" | "trigger_with_delay" },
    ) => {
      const { taskId, payload, after } = args;
      const deprecation_notice =
        opts.emittedAs === "trigger_with_delay"
          ? bgoDeprecation("trigger_with_delay", "schedule_bgo")
          : undefined;
      if (!triggerReady()) {
        return {
          status: "skipped",
          reason: "trigger.dev not configured",
          ...(deprecation_notice ? { deprecation_notice } : {}),
        };
      }
      try {
        const handle = await triggerSdk.tasks.trigger(taskId, payload ?? {}, {
          delay: after,
          tags: scopeTags,
          metadata: { ...scopeMetadata, taskIdHint: taskId, delayedUntil: after },
          idempotencyKey: idemKey(`schedule_bgo:${taskId}:${after}`, payload ?? {}),
        });
        return {
          status: "scheduled",
          runId: handle.id,
          after,
          ...(deprecation_notice ? { deprecation_notice } : {}),
        };
      } catch (err: any) {
        return {
          status: "failed",
          error: err?.message || `${opts.emittedAs} failed`,
          ...(deprecation_notice ? { deprecation_notice } : {}),
        };
      }
    };
    // `trigger_with_delay` was previously gated on
    // `metaEnabled("trigger_with_delay")` with default-false; preserve
    // opt-in behaviour under the new name.
    if (bgoMetaEnabled("schedule_bgo", "trigger_with_delay", false)) {
      tools.schedule_bgo = {
        description:
          "Schedule a single-shot background operation to fire after a delay (e.g. '5m', '2h', '24h' or ISO timestamp). The run is queued immediately but execution starts after the wait.",
        inputSchema: scheduleBgoParameters,
        execute: async (args) => scheduleBgoHandler(args, { emittedAs: "schedule_bgo" }),
      };
      tools.trigger_with_delay = {
        description:
          "[DEPRECATED — use schedule_bgo] Schedule a single-shot background operation to fire after a delay. Kept as an alias for one release; prefer schedule_bgo in new code.",
        inputSchema: scheduleBgoParameters,
        execute: async (args) => {
          bgoAliasWarn("trigger_with_delay", "schedule_bgo");
          return scheduleBgoHandler(args, { emittedAs: "trigger_with_delay" });
        },
      };
    }

    // PPR-50 — replay_run — re-fire a previously executed run (COMPLETED or
    // FAILED) with the same payload. Returns the new run handle. Mirrors
    // the scope-filter + idem-key pattern of spawn_bgo / cancel_run.
    // Default disabled in `defaults.metaTools`.
    if (metaEnabled("replay_run")) tools.replay_run = {
      description:
        "Replay a previously executed trigger.dev run. Re-enqueues the same task + payload and returns a fresh run id. Useful for recovering from transient failures or re-running a COMPLETED job.",
      inputSchema: z.object({
        runId: z.string().describe("Run id to replay (e.g. from list_runs)"),
      }),
      execute: async ({ runId }) => {
        if (!triggerReady() || !triggerSdk?.runs?.replay || !triggerSdk?.runs?.retrieve) {
          return { status: "skipped", reason: "trigger.dev not configured" };
        }
        try {
          // L7 — verify the run belongs to the caller's scope BEFORE replaying,
          // so a caller can't re-fire another scope's run by guessing its id.
          // This is the more dangerous of the two run tools (it re-executes the
          // job, not just reads it).
          const _orig = await triggerSdk.runs.retrieve(runId);
          const _md = (_orig?.metadata ?? {}) as Record<string, any>;
          if (
            _md.organizationId !== scope.organizationId ||
            _md.projectId !== scope.projectId ||
            _md.environmentId !== scope.environmentId
          ) {
            return { status: "denied", reason: "run not in caller scope" };
          }
          const handle = await triggerSdk.runs.replay(runId);
          return {
            status: "replayed",
            originalRunId: runId,
            runId: handle?.id ?? null,
          };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "replay_run failed" };
        }
      },
    };

    // PPR-50 — cancel_schedule — deactivate a cron schedule previously
    // registered via create_schedule. Default disabled.
    if (metaEnabled("cancel_schedule")) tools.cancel_schedule = {
      description:
        "Deactivate a cron-scheduled trigger.dev schedule. After this the schedule stops firing. Idempotent — deactivating an already-inactive schedule is a no-op.",
      inputSchema: z.object({
        scheduleId: z.string().describe("Schedule id (returned by create_schedule or list_schedules)"),
      }),
      execute: async ({ scheduleId }) => {
        if (!triggerSdk?.schedules?.deactivate) {
          return { status: "skipped", reason: "trigger.dev schedules API not available" };
        }
        try {
          await triggerSdk.schedules.deactivate(scheduleId);
          return { status: "deactivated", scheduleId };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "cancel_schedule failed" };
        }
      },
    };

    // PPR-50 — list_schedules — enumerate schedules the agent can see,
    // scope-filtered by project + environment via the trigger.dev SDK's
    // filters (mirrors the list_bgos / list_runs pattern). Default disabled.
    if (metaEnabled("list_schedules")) tools.list_schedules = {
      description:
        "List trigger.dev schedules registered in the current project + environment. Returns `{ schedules: [{ id, task, cron, nextRun, active }] }`. Optional text filter applied to task slug.",
      inputSchema: z.object({
        filter: z.string().optional().describe("Substring match on task slug"),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ filter, limit }) => {
        if (!triggerSdk?.schedules?.list) {
          return { status: "skipped", reason: "trigger.dev schedules API not available" };
        }
        try {
          // The SDK's schedules.list takes an object with pagination; we
          // pass through project + env when supported so the server-side
          // filter matches the other meta-tools.
          const page = await triggerSdk.schedules.list({
            projectRef: scope.projectId,
            environmentId: scope.environmentId,
            perPage: Math.min(limit ?? 25, 200),
          }).catch(async () =>
            // Fallback for SDK versions that don't accept project/env filters —
            // filter client-side. Still scope-safe because every schedule we
            // create is tagged with the scope via externalId above.
            triggerSdk.schedules.list({ perPage: Math.min(limit ?? 25, 200) }),
          );
          const rows = (page?.data ?? page?.schedules ?? page ?? []) as any[];
          const filtered = rows.filter((s: any) => {
            if (filter && !String(s.task ?? s.taskIdentifier ?? "").includes(filter)) return false;
            // Best-effort scope guard: prefer externalId prefix we wrote
            // in create_schedule; if the SDK version returned items from
            // other scopes, drop them.
            if (s.externalId && typeof s.externalId === "string") {
              const prefix = `platos:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:`;
              return s.externalId.startsWith(prefix);
            }
            return true;
          });
          return {
            schedules: filtered.slice(0, limit ?? 25).map((s: any) => ({
              id: s.id,
              task: s.task ?? s.taskIdentifier ?? null,
              cron: s.cron ?? s.generatorExpression ?? null,
              nextRun: s.nextRun ?? null,
              active: s.active ?? s.enabled ?? null,
            })),
          };
        } catch (err: any) {
          return { status: "failed", error: err?.message || "list_schedules failed" };
        }
      },
    };

    // delegate_to_sub_agent — when toolsBlockConfig.mode === "sub-agent", the
    // parent LLM's only way to invoke tools is to delegate an intent to a
    // dedicated cheap sub-agent (default Haiku) that has actual tool schemas
    // in its context. The sub-agent runs a nested streamText loop, calls
    // tools precisely, and returns an aggregated answer. The parent continues
    // with that answer as tool_result.
    if (toolMode === "sub-agent") {
      const subCfg = agentConfig?.subAgentConfig;
      const enabledTools = agentConfig?.toolsBlockConfig?.enabledTools || [];
      tools.delegate_to_sub_agent = {
        description: `Delegate a task to the tool-calling sub-agent. The sub-agent has access to ${enabledTools.length} tools and will execute what you describe, returning a summary. Use this for any operation requiring actual tool calls (search, fetch, write actions). Describe the intent clearly — the sub-agent is focused and literal.`,
        inputSchema: z.object({
          intent: z.string().describe("What you want accomplished — describe the goal, not the tool to use. e.g., 'Find all deals closing this month and summarize their status'"),
          context: z.string().optional().describe("Any relevant context the sub-agent should know (user info, prior findings, constraints)"),
        }),
        execute: async ({ intent, context }) => {
          try {
            const result = await this.runSubAgent({
              intent,
              context,
              parentConfig: agentConfig!,
              subAgentConfig: subCfg,
              enabledTools,
              scope,
              // TL.6 — pass the full CTX.6 arg-expectations block through
              // to the sub-agent systemPrompt. Holder is populated AFTER
              // buildMetaTools returns but BEFORE any delegate dispatch
              // (see stream() CTX.6 block).
              argExpectationsHint: subAgentArgHintHolder?.value || "",
              // PRELAUNCH-A2-6 — parent stream's abort signal (closure capture
              // from buildMetaTools). When the user clicks stop, the abort
              // cascades into the sub-agent's generateText call.
              abortSignal,
            });
            return result;
          } catch (err: any) {
            return { status: "failed", error: err?.message || "Sub-agent failed" };
          }
        },
      };
    }

    // Remove execute_tools in sub-agent mode — parent shouldn't see it
    if (toolMode === "sub-agent") {
      delete tools.execute_tools;
    }

    // ─────────────────────────────────────────────────────────────────
    // TL.2 — display-mode routing.
    //
    // Fail-open: any parse error, missing registry, or "full" mode falls
    // through to the existing behavior (current caller contract).
    //
    // Ordering:
    //   1. Compute the display mode + the (enabledCategories-filtered)
    //      entity-tool matrix counts so we can render the addendum.
    //   2. For summary / hybrid modes, render + stash the addendum.
    //   3. For summary mode, drop every non-meta tool key from the map
    //      (entity tools aren't exposed as first-class CoreTools today —
    //      they live behind `execute_tools` — so "drop non-meta" is a
    //      no-op on the `tools` dict. We still keep the `find_tools` +
    //      `execute_tools` entries so the LLM can reach the long tail.)
    //   4. For meta-tool mode, guarantee no schema hint is emitted (no
    //      addendum). Same "meta-tools only" logical matrix as today's
    //      sub-agent default.
    //   5. Hybrid mode: addendum + meta-tools + pinned-tool signal via
    //      `execute_tools` description + an inline "pinned tools" hint
    //      appended to the addendum so the LLM knows which entity-tool
    //      names it can call WITHOUT going through find_tools.
    //
    // enabledCategories filtering is ALSO applied to the `find_tools`
    // result set below — we walk the already-built tool, swap its
    // `execute` to post-filter the scoped matrix. Meta-tools are always
    // visible (their category is informational only).
    // ─────────────────────────────────────────────────────────────────
    const tlb = agentConfig?.toolsBlockConfig ?? null;
    const displayModeRaw = (tlb?.displayMode ?? "full") as string;
    const displayMode: "full" | "summary" | "meta-tool" | "hybrid" =
      displayModeRaw === "summary" ||
      displayModeRaw === "meta-tool" ||
      displayModeRaw === "hybrid"
        ? (displayModeRaw as "summary" | "meta-tool" | "hybrid")
        : "full";
    const enabledCategories = tlb?.enabledCategories;
    const pinnedTools = Array.isArray(tlb?.pinnedTools) ? tlb!.pinnedTools! : [];
    const categoryDescriptions = tlb?.categoryDescriptions;

    // Apply the category allowlist to the find_tools execute path. We
    // also re-derive the per-category counts from the same filtered set
    // so the addendum matches what the LLM would actually see via
    // find_tools. Wrapped in try/catch so a registry hiccup can't kill
    // the whole turn.
    let categoryCounts: Array<{ id: string; count: number }> = [];
    try {
      if (this.toolRegistry) {
        // Theme EA — pass agentId so category counts reflect only the
        // tools visible to THIS agent. Mirrors the find_tools filter
        // above so the category summary block the LLM sees matches what
        // find_tools would actually return.
        const scoped = this.toolRegistry.getScopedTools(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          { enabledOnly: true, agentId: scope.agentId },
        );
        const allowed = filterToolsByEnabledCategories(scoped, enabledCategories);
        const byCategory = new Map<string, number>();
        for (const row of allowed) {
          const cat = row.category || "entity";
          byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
        }
        categoryCounts = Array.from(byCategory.entries())
          .map(([id, count]) => ({ id, count }))
          .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
      }
    } catch (err: any) {
      this.logger.warn(
        `[agent.buildMetaTools] TL.2 category count failed: ${err?.message ?? err}`,
      );
    }

    // Wrap find_tools with the enabledCategories post-filter when a
    // non-null allowlist is set. Empty array (explicit "no categories")
    // still returns the empty set.
    if (
      tools.find_tools &&
      Array.isArray(enabledCategories)
    ) {
      const original = tools.find_tools.execute as (args: any, ...rest: any[]) => any;
      const allowSet = new Set(enabledCategories);
      tools.find_tools = {
        ...tools.find_tools,
        execute: async (args: any, ...rest: any[]) => {
          const out = await original(args, ...rest);
          if (!out || !Array.isArray(out.results)) return out;
          const filtered = out.results.filter((r: any) => {
            const cat = r?.category;
            if (!cat) return false; // "entity" fallback when category is null — still visible if "entity" allow-listed
            return allowSet.has(cat);
          });
          return { ...out, results: filtered };
        },
      };
    }

    // Render + stash the system-prompt addendum for summary + hybrid
    // modes. Fail-open: empty matrix → no addendum.
    if (
      systemPromptAddendumHolder &&
      (displayMode === "summary" || displayMode === "hybrid") &&
      categoryCounts.length > 0
    ) {
      let block = renderCategorySummaryBlock(
        categoryCounts,
        categoryDescriptions,
      );
      if (displayMode === "hybrid" && pinnedTools.length > 0) {
        // Name the pinned tools inline so the LLM knows which entity
        // names it can dispatch without a `find_tools` hop.
        const pinnedLine = `\n\nPinned tools (callable directly via \`execute_tools\`): ${pinnedTools
          .map((n) => `\`${n}\``)
          .join(", ")}.`;
        block = `${block}${pinnedLine}`;
      }
      if (block.length > 0) {
        systemPromptAddendumHolder.value = block;
      }
    }

    return tools;
  }

  /**
   * Run a nested sub-agent streamText call. Used by delegate_to_sub_agent.
   * Aggregates the sub-agent's response + tool calls into a single result.
   */
  private async runSubAgent(args: {
    intent: string;
    context?: string;
    parentConfig: AgentConfig;
    subAgentConfig?: AgentConfig["subAgentConfig"];
    enabledTools: string[];
    scope: RequestScope;
    /**
     * TL.6 — CTX.6 "Tool argument expectations" block. In sub-agent mode
     * the parent's system prompt gets a 1-liner (it only sees find_tools
     * + delegate_to_sub_agent — per-tool hints are useless to it). The
     * verbose block is plumbed here so the sub-agent (which actually
     * sees tool schemas) gets the guidance. Empty string means skip.
     */
    argExpectationsHint?: string;
    /** PRELAUNCH-A2-6 — parent stream's abort signal. */
    abortSignal?: AbortSignal;
  }): Promise<{ status: "success" | "failed"; text: string; toolCalls: any[]; steps: number; error?: string }> {
    const subModel = args.subAgentConfig?.model || "anthropic:claude-haiku-4-5-20251001";
    const maxSteps = args.subAgentConfig?.maxSteps || 10;
    const baseSystemPrompt = args.subAgentConfig?.systemPrompt ||
      `You are a dedicated tool-calling sub-agent. You receive an intent from a parent agent and execute it using the available tools. Be precise, literal, and efficient. Return a concise summary of what you did and the results. Do not add commentary or soft language.`;
    // TL.6 — splice the CTX.6 arg-expectations block into the sub-agent's
    // prompt so it knows which params the LLM is responsible for providing
    // per enabled tool. Parent in sub-agent mode loses this hint (useless
    // for find_tools/delegate_to_sub_agent) — sub-agent gains it.
    const systemPrompt = args.argExpectationsHint && args.argExpectationsHint.length > 0
      ? `${baseSystemPrompt}\n\n${args.argExpectationsHint}`
      : baseSystemPrompt;

    const subApiKey = await this.resolveApiKey(subModel, args.scope);
    // LAUNCH-9 review fix — sub-agent inherits the parent agent's retry
    // waterfall instead of always using DEFAULT_RETRY_RULES. Without this,
    // a per-agent retry config configured by the operator silently does
    // not apply to delegate_to_sub_agent invocations.
    const model = resolveModel(subModel, subApiKey, args.parentConfig.agentRetryConfig?.rules);

    // Sub-agent gets execute_tools with the enabled tools list.
    // Note: for now the sub-agent uses execute_tools meta-tool (which calls
    // ToolExecutorService). Full Mode 2 direct-schema-injection would inject
    // the enabled tool schemas directly — a Block 2 polish later.
    const subTools: Record<string, CoreTool> = {};
    if (this.toolRegistry && this.toolExecutor) {
      subTools.execute_tools = {
        description: `Execute one of the ${args.enabledTools.length} available tools.`,
        inputSchema: z.object({
          calls: z.array(z.object({
            tool: z.string(),
            params: z.record(z.unknown()),
          })),
        }),
        execute: async ({ calls }) => {
          // Filter by enabled tools
          const allowed = calls.filter((c: any) => args.enabledTools.includes(c.tool));
          const blocked = calls.filter((c: any) => !args.enabledTools.includes(c.tool));
          // Carry the owning thread's end user to mcpDispatch (design §3.1 row v).
          const endUserId = await this.resolveOriginEndUserId(args.scope);
          const results = await this.toolExecutor!.executeBatch(
            allowed.map((c: any) => ({ tool: c.tool, params: c.params })),
            args.scope,
            { source: "skill_invocation", endUserId },
          );
          return {
            results,
            blocked: blocked.length > 0 ? blocked.map((c: any) => ({ tool: c.tool, reason: "Not in enabled tools list for this agent" })) : undefined,
          };
        },
      };
    }

    const intentMessage = args.context
      ? `Intent: ${args.intent}\n\nContext from parent:\n${args.context}`
      : args.intent;

    // PIFSP-8 — Layer 2 Anthropic cacheControl on the sub-agent system message.
    // The sub-agent uses a messages array (not raw `system`) so providerOptions
    // can be attached per Vercel AI SDK's per-message pattern.
    const subProvider = subModel.split(":")[0] ?? "anthropic";
    const subCacheOpts = subProvider === "anthropic"
      ? { anthropic: { cacheControl: { type: "ephemeral" as const } } }
      : undefined;

    const subMessages: Array<{ role: "system" | "user"; content: string; providerOptions?: Record<string, unknown> }> = [
      ...(systemPrompt
        ? [{
            role: "system" as const,
            content: systemPrompt,
            ...(subCacheOpts ? { providerOptions: subCacheOpts } : {}),
          }]
        : []),
      { role: "user" as const, content: intentMessage },
    ];

    const subStartNs = Date.now() * 1_000_000;
    // TOOL-RESULT BOUNDARY — harden the sub-agent's execute_tools return too
    // (see stream() for rationale). Its `blocked: undefined` branch and raw
    // executeBatch results pass through the same serialization guard.
    hardenToolResults(subTools);
    // PRELAUNCH-A2-6 — propagate parent's abort signal to the nested LLM call.
    const result = await generateText({
      model,
      messages: subMessages as any,
      tools: subTools,
      stopWhen: isStepCount(maxSteps),
      abortSignal: args.abortSignal,
      // Sub-agent prompt rides in `messages[]` (not the top-level `system:`)
      // specifically so we can attach `providerOptions.anthropic.cacheControl`
      // on the system message (see subCacheOpts above). Suppresses the
      // AI SDK v6 warning that nudges toward top-level `system:`.
      allowSystemInMessages: true,
    });
    const subEndNs = Date.now() * 1_000_000;

    // Theme E.9 — record the sub-agent LLM call's cost against the PARENT
    // agent's turn (THEME_E §E.9: "the cost attributes to whichever agent's
    // turn it was"). The parent's turn is the enclosing unit of work, so
    // sub-agent model tokens roll up into the parent's billing row while
    // still keeping the model dimension (e.g. Haiku vs Sonnet) visible via
    // the per-agent×per-model Redis hash. Best-effort — failures here must
    // never break a sub-agent invocation.
    const parentAgentId = args.scope.agentId || "default";
    const threadId = args.scope.sessionId || undefined;
    const subPromptTokens = result.usage?.inputTokens ?? 0;
    const subCompletionTokens = result.usage?.outputTokens ?? 0;
    // MC.1 — sum cache tokens from step provider metadata for sub-agent turns.
    // PRELAUNCH-A1-13 — generalized to all providers. Prefer normalized v6
    // `usage.{input,output}TokenDetails` first, then fall back to provider-
    // specific metadata for Anthropic / OpenAI / Google / Vertex. Without
    // this generalization, sub-agent runs on non-Anthropic providers lost
    // cache + reasoning attribution at this rollup line.
    // Billing attribution stays on the parent agent per Theme E.9; the
    // telemetry just rides along so the parent's rollup sees the sub-agent's
    // cache hits.
    let subCacheCreation = 0;
    let subCacheRead = 0;
    let subReasoning = 0;
    for (const step of result.steps ?? []) {
      const meta = (step as any).providerMetadata;
      const usage = (step as any).usage;
      subCacheRead +=
        Number(usage?.inputTokenDetails?.cacheReadTokens ?? 0) ||
        Number(meta?.anthropic?.cacheReadInputTokens ?? 0) ||
        Number(meta?.openai?.cachedPromptTokens ?? 0) ||
        Number(meta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
        Number(meta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
      subCacheCreation +=
        Number(usage?.inputTokenDetails?.cacheWriteTokens ?? 0) ||
        Number(meta?.anthropic?.cacheCreationInputTokens ?? 0) ||
        Number(meta?.vertex?.cacheCreationInputTokens ?? 0);
      subReasoning +=
        Number(usage?.outputTokenDetails?.reasoningTokens ?? 0) ||
        Number(meta?.openai?.reasoningTokens ?? 0) ||
        Number(meta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
        Number(meta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
    }
    // PRELAUNCH-A1-13 (follow-up 2026-05-04) — `subReasoning` is now plumbed
    // into `recordUsage`'s reasoningTokens option so the parent agent's
    // billing rollup picks up sub-agent reasoning spend (o-series / R1 /
    // Gemini-2.5-thinking). Previously the value was computed and `void`'d
    // — losing 100% of sub-agent reasoning attribution on the parent.
    let subCostCents = 0;
    if (this.costService && threadId) {
      try {
        const rec = await this.costService.recordUsage(
          {
            organizationId: args.scope.organizationId,
            projectId: args.scope.projectId,
            environmentId: args.scope.environmentId,
          },
          threadId,
          parentAgentId,
          subModel,
          subPromptTokens,
          subCompletionTokens,
          {
            subAgentLabel: "sub-agent",
            cacheCreationInputTokens: subCacheCreation,
            cacheReadInputTokens: subCacheRead,
            reasoningTokens: subReasoning,
          },
        );
        subCostCents = rec.costCents;
      } catch (err: any) {
        this.logger.warn(
          `[agent.runSubAgent] cost recordUsage failed: ${err?.message ?? String(err)}`,
        );
      }
    }

    // Theme E.9 — emit a child `llm.inference.sub_agent` span under the turn
    // trace so the trace viewer shows the sub-agent call in context. Scope
    // attributes carry the parent agent id (billing agent); the sub-agent
    // model name is an attribute so sub-vs-parent model breakdowns remain
    // queryable. Best-effort.
    if (this.spansService && args.scope.traceId) {
      try {
        const subSpanId = this.spansService.nextSpanId();
        // PPR-48 — `platos.subagent.id` + `.label` attributes. Before this,
        // the trace viewer showed sub-agent spans under the parent turn but
        // couldn't distinguish between multiple sub-agent invocations in the
        // same turn (all spans carried identical model + parent-agent-id).
        // `.id` is the span id itself — unique per invocation. `.label` is a
        // human-readable name: the configured systemPrompt hint slug if set,
        // else the model. That gives the UI a stable string to render in
        // the trace tree (e.g. "sub:haiku" or "sub:researcher").
        const rawLabel =
          args.subAgentConfig?.systemPrompt
            ?.split("\n")[0]
            ?.slice(0, 48)
            .trim() || subModel;
        const subLabel = rawLabel.length > 0 ? rawLabel : subModel;
        await this.spansService.record(
          {
            organizationId: args.scope.organizationId,
            projectId: args.scope.projectId,
            environmentId: args.scope.environmentId,
            agentId: parentAgentId,
            threadId,
            userId: args.scope.userId,
            sessionContext: (args.scope as any).sessionContext as
              | { user?: { name?: string; email?: string } }
              | null
              | undefined,
          },
          {
            traceId: args.scope.traceId,
            spanId: subSpanId,
            parentSpanId: args.scope.parentSpanId,
            name: "llm.inference.sub_agent",
            kind: "client",
            startTimeUnixNano: subStartNs,
            endTimeUnixNano: subEndNs,
            durationMs: Math.round((subEndNs - subStartNs) / 1_000_000),
            status: "ok",
            attributes: {
              "platos.model": subModel,
              "platos.input_tokens": subPromptTokens,
              "platos.output_tokens": subCompletionTokens,
              "platos.cost_cents": subCostCents,
              "platos.sub_agent": true,
              "platos.sub_agent.steps": result.steps?.length ?? 1,
              "platos.subagent.id": subSpanId,
              "platos.subagent.label": subLabel,
            },
          },
        );
      } catch (err: any) {
        this.logger.warn(
          `[agent.runSubAgent] span record failed: ${err?.message ?? String(err)}`,
        );
      }
    }

    return {
      status: "success",
      text: result.text,
      toolCalls: result.toolCalls || [],
      steps: result.steps?.length ?? 1,
    };
  }

  /**
   * Stream a response from the agent.
   * Uses Vercel AI SDK's streamText with multi-step tool loop.
   *
   * Yields AgentStreamEvents that the ConnectionsModule pushes to the frontend.
   *
   * `attachments` (Theme D) — when present, gets routed into the user message
   * as Vercel AI SDK multimodal content parts (ImagePart / FilePart). If the
   * selected model doesn't support a given attachment kind, a text fallback
   * description replaces it — see `multimodal-adapter.ts`.
   */
  async *stream(
    message: string,
    conversationHistory: CoreMessage[],
    agentConfig: AgentConfig,
    scope: RequestScope,
    dynamicContext?: Record<string, string>,
    attachments?: ResolvedAttachment[],
    /**
     * Theme F.5 — per-turn overrides. `systemPromptOverride` swaps the
     * agent's stored systemPrompt for this single turn (never mutates the
     * agent config), and `outputSchema` forces structured-output mode for
     * this turn. Per-turn schema wins over `agentConfig.outputSchema`.
     */
    turnOverrides?: {
      systemPromptOverride?: string | null;
      outputSchema?: OutputSchemaInput;
      /**
       * EOBD.26/27 — composed stop + timeout signal plumbed from
       * agent-task.service.executeStreamingTurn. When aborted the
       * streamText call terminates and we yield an aborted error.
       */
      abortSignal?: AbortSignal;
      /**
       * W.1 — whitelist of meta-tool names the sub-LLM may call. Used by
       * the `agent_batch` durable executor so per-item turns run with a
       * caller-specified tool subset. `undefined` leaves the full matrix
       * intact (normal turn path).
       */
      allowedTools?: string[];
    },
  ): AsyncGenerator<AgentStreamEvent> {
    // Provider credentials (API keys, service accounts) are resolved
    // per-scope from the trigger.dev SecretStore (what the webapp env-var
    // UI writes to), falling back to the agent container's own process.env
    // for admin-seeded defaults. Per-scope resolution is required because
    // different envs (dev / prod) have different keys — one container,
    // many tenant scopes.

    try {
    // Theme CTX.2 — load per-turn session context + the agent's declared
    // context mapping. Both are JSONB columns added by CTX.1 and may be
    // null on any legacy row → fail-open: leave the scope untouched and
    // downstream helpers become no-ops. Populated BEFORE the provider
    // gate so everything below (prompt substitution, matrix filter, WS
    // envelope via tool-executor) can read off `scope`.
    let sessionContext: Record<string, unknown> | null = null;
    let contextMapping: ContextMapping | null = null;
    // PIFSP-9 Postman mode: if the caller pre-populated scope.sessionContext
    // (WS message with sessionContextOverride), skip the DB lookup and use
    // the override directly. The contextMapping still loads from DB.
    if (scope.sessionContext) {
      sessionContext = scope.sessionContext;
    }
    if (scope.sessionId && scope.agentId) {
      try {
        if (!sessionContext) {
          const ctxRow = await this.prisma.platosAgentThread.findFirst({
            where: {
              id: scope.sessionId,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            select: { sessionContext: true },
          });
          if (ctxRow?.sessionContext && typeof ctxRow.sessionContext === "object") {
            sessionContext = ctxRow.sessionContext as Record<string, unknown>;
          }
        }
        const agentRow = await this.prisma.platosAgent.findFirst({
          where: {
            id: scope.agentId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { contextMapping: true },
        });
        contextMapping = normalizeContextMapping(agentRow?.contextMapping ?? null);
      } catch (err: any) {
        // Fail-open — a broken DB read must not take down the turn.
        this.logger.warn(
          `[agent.stream] session-context load failed, proceeding without it: ${err?.message ?? String(err)}`,
        );
      }
      // Auto-inject a base sessionContext layer from the Platos User row so
      // that {{user.name}}, {{user.email}}, {{user.id}}, {{user.current_time}}
      // always resolve even when the caller never provided sessionContext.
      // Caller-supplied values win (merged on top of base).
      try {
        const userRow = await this.prisma.user.findFirst({
          where: { id: scope.userId },
          select: { id: true, name: true, displayName: true, email: true },
        });
        if (userRow) {
          // If the caller (Postman or entity SDK) already provided user.* flat keys,
          // honour them inside the nested user object too so {{user.name}} and
          // "user.name" (flat) resolve to the same value. DB values are the fallback.
          const ctx = sessionContext as Record<string, unknown> | null;
          const baseCtx: Record<string, unknown> = {
            user: {
              id:           ctx?.["user.id"]           ?? userRow.id,
              name:         ctx?.["user.name"]         ?? userRow.displayName ?? userRow.name ?? userRow.email ?? userRow.id,
              email:        ctx?.["user.email"]        ?? userRow.email,
              current_time: ctx?.["user.current_time"] ?? new Date().toISOString(),
            },
          };
          // Merge: base is the floor; existing sessionContext (DB or override) wins.
          sessionContext = sessionContext
            ? { ...baseCtx, ...sessionContext }
            : baseCtx;
        }
      } catch {
        // Fail-open — missing user row must not crash the turn.
      }

      scope.sessionContext = sessionContext;
      scope.contextMapping = contextMapping;
    }

    // PIFSP-11 — entity_ids mandate preflight.
    //
    // When the agent is linked to 2+ connected entities, the developer MUST
    // pass `entity_ids` on the per-turn sessionContext. Without it, Platos
    // would have to load the cartesian product of every entity's tools into
    // the prompt — token-prohibitive AND semantically wrong (a request
    // coming from "customer A" should never see "customer B"'s tools).
    //
    // Gate policy:
    //   - Explicit opt-in: `agentConfig.toolsBlockConfig?.entityIdsRequired ===
    //     true` → always enforce.
    //   - Explicit opt-out: `=== false` → never enforce (operator knows what
    //     they're doing, e.g. a single-tenant single-entity agent).
    //   - Default (undefined): enforce iff the agent has more than one
    //     visible entity in its scoped matrix (auto-tightens as the scope
    //     grows without requiring operator action per-entity).
    //
    // When the mandate is on + entity_ids is missing/empty, we yield a
    // structured error + `done` and abort the turn. The webapp / Chat tab
    // renders this with a CTA to the Context tab. No changes are made to the
    // turn state (no thread mutations, no partial messages).
    if (this.toolRouter && agentConfig) {
      const tlbGate: { entityIdsRequired?: boolean } =
        (agentConfig as { toolsBlockConfig?: { entityIdsRequired?: boolean } })
          .toolsBlockConfig ?? {};
      // PIFSP-11.1 — default is now explicit opt-in. Previously we auto-
      // enforced whenever `visibleEntitiesForAgent` returned >1, which
      // surprised single-purpose agents the moment any second entity (a
      // test backend, a sample one) appeared in the project. Multi-tenant
      // operators who actually need narrowing set `entityIdsRequired: true`
      // explicitly; the absence of that opt-in means "this agent doesn't
      // care about per-turn entity narrowing."
      const mandated = tlbGate.entityIdsRequired === true;
      if (mandated) {
        const entityIdsKey =
          (scope.contextMapping as ContextMapping | null | undefined)
            ?.entityIdsKey || "entity_ids";
        const entityIds = scope.sessionContext
          ? resolveCtxPath(scope.sessionContext, entityIdsKey)
          : null;
        const list = Array.isArray(entityIds)
          ? (entityIds as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        if (list.length === 0) {
          this.logger.warn(
            `[agent.stream] ENTITY_IDS_REQUIRED agent=${scope.agentId ?? "?"} scope=${scope.organizationId}:${scope.projectId}:${scope.environmentId} key=${entityIdsKey}`,
          );
          yield {
            type: "error",
            code: "ENTITY_IDS_REQUIRED",
            message: `This agent requires \`${entityIdsKey}\` in sessionContext. Add one or more entity IDs to the per-turn context (see the agent's Context tab for the configured key name).`,
          } as AgentStreamEvent;
          yield { type: "done" } as AgentStreamEvent;
          return;
        }
      }
    }

    // PIFSP-18 — Choke-point A: user message PII filter.
    // Runs BEFORE the provider gate so blocked messages never reach the LLM.
    if (this.piiFilter && agentConfig) {
      const govCfg = (agentConfig as any).governanceConfig as GovernanceConfig | null | undefined;
      const piiResult = await this.piiFilter.scan(message, govCfg, "user_message", {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        agentId: scope.agentId ?? "default",
      });
      if (piiResult.action === "block") {
        const kinds = [...new Set(piiResult.hits.map((h) => h.kind))];
        yield {
          type: "error",
          code: "PII_BLOCKED",
          message: `Your message contained content that's blocked for this agent (${kinds.join(", ")}). Please rephrase and try again.`,
        } as any;
        yield { type: "done" } as AgentStreamEvent;
        return;
      }
      if (piiResult.action === "redact") {
        // Replace the raw message with the redacted version before LLM sees it.
        // The original message is persisted (audit) — see agent-task.service.ts
        // which persists the original BEFORE calling stream().
        // eslint-disable-next-line no-param-reassign
        message = piiResult.filteredText;
      }
      // warn: continue with original text; safety event logged by PiiFilterService.
    }

    // PPR-65 — pre-stream provider gate. If the configured model's provider
    // isn't in this scope's `availableModels` list (i.e. env vars missing or
    // the provider was toggled off on the `/agent-providers` page), we fail
    // the turn up-front with a structured `provider_unavailable` error
    // instead of letting the Vercel AI SDK throw a generic "invalid API key"
    // mid-stream. The UI already renders this code with a "Link env vars"
    // CTA — see PPR-65 on the trace / playground views.
    if (this.providerRegistry) {
      const colonIdx = agentConfig.model.indexOf(":");
      const providerId =
        colonIdx > 0 ? agentConfig.model.slice(0, colonIdx) : "anthropic";
      try {
        const groups = await this.providerRegistry.availableModels({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        });
        const hit = groups.find((g) => g.provider === providerId);
        // Manifests list models with the provider prefix (e.g.
        // "anthropic:claude-sonnet-4-6"), so match against the full model
        // string. Fall back to the bare model for legacy configs that
        // omit the prefix.
        const bareModel =
          colonIdx > 0 ? agentConfig.model.slice(colonIdx + 1) : agentConfig.model;
        const modelMatches =
          !!hit &&
          (hit.models.includes(agentConfig.model) ||
            hit.models.includes(bareModel));
        if (!hit || !modelMatches) {
          yield {
            type: "error",
            code: "provider_unavailable",
            message: hit
              ? `Model "${agentConfig.model}" is not in the scope-filtered catalog for provider "${providerId}". Update the agent's model or link a compatible provider.`
              : `Provider "${providerId}" is not linked or its required env vars are missing in this environment. Link it under Agent Providers before running the agent.`,
            model: agentConfig.model,
            providerId,
          };
          yield { type: "done" };
          return;
        }
      } catch (err: any) {
        // Registry lookup itself failed — log + fall through to the old
        // behaviour (the downstream API call will surface the real error).
        this.logger.warn(
          `[agent.stream] provider-registry availability check failed, proceeding: ${err?.message ?? String(err)}`,
        );
      }
    }

    // LAUNCH-2 — per-agent retry rules override the built-in defaults.
    const agentRetryRules = agentConfig.agentRetryConfig?.rules;
    // LAUNCH-4 — fallback chains. When the agent has explicit `fallback`
    // rules in agentRetryConfig pointing at one or more model-route labels,
    // do a 1-token ping on the primary then each fallback target until one
    // responds. The first responder is used for the actual streaming turn.
    // Cost: one ~10-token round-trip when fallback is configured (~$0.0001).
    // No cost when an agent has no fallback rules — the helper returns the
    // primary route immediately.
    const { apiKey, model, routeLabel } = await this.resolveRouteWithFallback(
      agentConfig,
      scope,
      agentRetryRules,
    );
    if (routeLabel) {
      this.logger.log(
        `[agent.stream] LAUNCH-4 fallback route '${routeLabel}' selected after primary failed pre-stream ping`,
      );
    }
    // Theme F.7 — events from `generate_artifact` / `revise_artifact` land
    // on this queue synchronously (from inside the Vercel AI SDK
    // `execute()` callback) and get drained on each `step-finish` boundary
    // alongside `pendingToolResults`. That ordering matches the existing
    // tool_result protocol: placeholder → tool_call → artifact_start →
    // artifact_delta → artifact_committed → tool_result.
    const pendingArtifactEvents: AgentStreamEvent[] = [];
    // TL.6 — holder for the CTX.6 arg-expectations block. Populated AFTER
    // buildMetaTools returns (hint block is computed further down) but
    // BEFORE the LLM fires `delegate_to_sub_agent`. In sub-agent mode the
    // parent's systemPrompt gets a 1-liner instead; this holder shuttles
    // the verbose per-tool hint into runSubAgent so the sub-agent (which
    // sees real tool schemas) actually benefits from it.
    const subAgentArgHintHolder: { value: string } = { value: "" };
    // TL.2 — write-through holder for the "## Available tool categories"
    // addendum. buildMetaTools populates this when
    // `toolsBlockConfig.displayMode` is `"summary"` or `"hybrid"` AND the
    // scoped matrix has at least one visible category. We splice it into
    // the per-turn systemPrompt AFTER skill blocks + BEFORE the CTX.6
    // hint block so the cache-friendly prefix region carries it.
    const displayModeAddendumHolder: { value: string } = { value: "" };
    // Captured + populated by the skill-registration block below; read
    // by find_tools' execute callback at call time so skill tools show
    // up alongside entity tools in the meta-tool search surface.
    const skillToolIndex: Array<{
      name: string;
      description: string;
      paramSchema:
        | { type?: string; properties?: Record<string, unknown> }
        | undefined;
      skillId: string;
    }> = [];
    let tools = this.buildMetaTools(
      scope,
      agentConfig,
      (event) => {
        pendingArtifactEvents.push(event);
      },
      subAgentArgHintHolder,
      displayModeAddendumHolder,
      // PRELAUNCH-A2-6 — closure-captured for delegate_to_sub_agent dispatch.
      turnOverrides?.abortSignal,
      skillToolIndex,
    );
    // W.1 — per-turn tool allowlist plumbed from the batch executor. When
    // set, narrows the meta-tool matrix down to exactly the supplied
    // names. Entity tools are gated by their own scope/permission check
    // on dispatch; the allowlist here governs which meta-tools the model
    // can see at turn-plan time.
    if (turnOverrides?.allowedTools && Array.isArray(turnOverrides.allowedTools)) {
      tools = filterToolsAllowlist(tools, turnOverrides.allowedTools);
    }

    yield { type: "status", status: "connected", agentId: scope.agentId || "default" };

    const provider = agentConfig.model.split(":")[0] || "anthropic";
    // Theme F — per-turn systemPromptOverride wins over agent config for THIS
    // turn only. Empty-string treated as "no override" — null is the explicit
    // clear signal. The agent config is never mutated.
    let systemPrompt =
      turnOverrides?.systemPromptOverride &&
      turnOverrides.systemPromptOverride.length > 0
        ? turnOverrides.systemPromptOverride
        : agentConfig.systemPrompt;

    // PIFSP-8 — Layer-1 prompt-prefix cache. Check Redis before assembleAsync
    // + skill augmentation. Only read cache when there is no per-turn override
    // (static agents; retrieval-block agents skip via hasRetrievalBlocks below).
    // Cache miss → assemble as normal → write to cache after.
    const _promptCacheAgentId = scope.agentId ?? "";
    const _promptCacheVersionId = agentConfig.versionIdUsed ?? null;
    const _promptCacheMode = (agentConfig.toolsBlockConfig?.mode ?? "direct") as string;
    let promptCacheHit = false;
    if (this.promptCache && _promptCacheAgentId && !turnOverrides?.systemPromptOverride) {
      const cacheStart = Date.now();
      const cached = await this.promptCache.get(
        _promptCacheAgentId,
        _promptCacheVersionId,
        _promptCacheMode,
        false,
      );
      if (cached) {
        systemPrompt = cached;
        promptCacheHit = true;
        this.logger.debug(
          `[prompt-cache] agent=${_promptCacheAgentId} versionId=${_promptCacheVersionId ?? "current"} mode=${_promptCacheMode} main HIT rebuild_skipped=true`,
        );
      } else {
        this.logger.debug(
          `[prompt-cache] agent=${_promptCacheAgentId} versionId=${_promptCacheVersionId ?? "current"} mode=${_promptCacheMode} main MISS rebuild_ms=${Date.now() - cacheStart}`,
        );
      }
    }

    // RG.1.5 (follow-up) — if the agent has any retrieval blocks declared in
    // its saved `promptBlocks`, re-assemble the system prompt at turn time
    // via `promptBuilder.assembleAsync` so the retrieval tool fires AGAINST
    // THE INCOMING MESSAGE (not the pre-saved placeholder). Skipped under:
    //   - a per-turn systemPromptOverride (operator wants a frozen prompt)
    //   - missing blocks / no retrieval entries (static prompt still works)
    //   - skillRuntime unavailable (test harness or skills disabled)
    // Fail-open throughout: any resolver error leaves the retrieval section
    // empty but the rest of the prompt still assembles (the sync pre-saved
    // `systemPrompt` string is the fallback).
    const pb = this.getPromptBuilder();
    const savedBlocks = Array.isArray(agentConfig.promptBlocks)
      ? (agentConfig.promptBlocks as Array<{ type?: string; enabled?: boolean }>)
      : [];
    const hasRetrievalBlock = savedBlocks.some(
      (b) => b && b.type === "retrieval" && b.enabled !== false,
    );
    if (
      pb &&
      hasRetrievalBlock &&
      !promptCacheHit && // PIFSP-8: skip retrieval re-assemble when cache warm
      this.skillRuntime &&
      !(turnOverrides?.systemPromptOverride &&
        turnOverrides.systemPromptOverride.length > 0)
    ) {
      try {
        const skillRuntime = this.skillRuntime;
        const agentIdForResolver = scope.agentId ?? null;
        const threadIdForResolver = scope.sessionId ?? null;
        const retrievalResolver = async (
          _toolCall: string,
          resolvedArgs: Record<string, unknown>,
        ) => {
          return await skillRuntime.invokeTool(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
            },
            {
              skillSlug: "platos.platos_rag",
              toolName: "rag_retrieve",
              handler: "skill:platos.platos_rag:rag_retrieve",
              provider: null,
            },
            resolvedArgs,
            { agentId: agentIdForResolver, threadId: threadIdForResolver },
          );
        };
        const variables: Record<string, unknown> = {
          user_message: typeof message === "string" ? message : "",
          thread_id: scope.sessionId ?? "",
          user_id: scope.userId ?? "",
        };
        const reAssembled = await pb.assembleAsync(
          agentConfig.promptBlocks as unknown as Parameters<PromptBuilderService["assembleAsync"]>[0],
          variables,
          undefined,
          retrievalResolver,
        );
        if (reAssembled && reAssembled.trim().length > 0) {
          systemPrompt = reAssembled;
        }
      } catch (err: any) {
        this.logger.warn(
          `[agent.stream] RG.1.5 turn-time retrieval assemble failed — falling back to saved systemPrompt: ${err?.message ?? err}`,
        );
      }
    }

    // Theme O.8 — per-turn memory injection. Before skill blocks (so
    // memories appear higher up in the system prompt) we run a top-K
    // semantic search for the incoming user message and inline a
    // compact "Things I remember about this user" section.
    //
    // Gated on:
    //   - memory service is wired (prod) — test harness skips.
    //   - scope.userId is set — meta-tool paths without a user skip.
    //   - extraction policy says `enabled` — lets users kill injection for
    //     an agent without nuking the `remember`/`recall` meta-tools.
    //   - the current message is non-empty.
    //
    // Token-budget aware — estimate at `str.length / 4` per memory and
    // cap the block at PLATOS_MEMORY_INJECT_BUDGET_TOKENS (default 800).
    // Memories are prioritized by score (from the semantic search) and
    // then by recency of access.
    let memoryBlock: string | null = null;
    if (
      this.memoryService &&
      scope.userId &&
      typeof message === "string" &&
      message.trim().length > 0
    ) {
      try {
        let policyEnabled = true;
        let injectClusteringId: string | null = null;
        if (scope.agentId) {
          const agentRow = await this.prisma.platosAgent.findFirst({
            where: {
              id: scope.agentId,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            select: { extractionPolicy: true, clusteringId: true },
          });
          const policy = resolveExtractionPolicy(agentRow?.extractionPolicy ?? null);
          policyEnabled = policy.enabled;
          injectClusteringId = (agentRow as any)?.clusteringId ?? null;
        }
        if (policyEnabled) {
          const budget = Math.max(100, env.PLATOS_MEMORY_INJECT_BUDGET_TOKENS ?? 800);
          // Memory injection is best-effort and must NEVER block the response.
          // semanticSearch embeds the query (an external provider HTTP call) +
          // hits pgvector; a slow embedding key once stalled a turn ~64s
          // pre-LLM. Race it against a hard timeout (default 5s). On timeout
          // the catch below logs + proceeds with no memory block — the LLM
          // still answers, just without the "things I remember" enrichment.
          const injectTimeoutMs = env.PLATOS_MEMORY_INJECT_TIMEOUT_MS ?? 5000;
          // Multi-signal retrieval (dense ⊕ graph) for the AUTOMATIC injection
          // — the knowledge graph now participates in EVERY turn's context,
          // not just explicit recall(). Memories connected to people/orgs in
          // the message rank higher, and the resolved entity/relationship
          // slice is injected too. Still raced against the hard inject timeout
          // so a slow embedding key can never stall the turn pre-LLM.
          const fused = await Promise.race([
            fuseContextRetrieval(
              { memory: this.memoryService, graph: this.knowledgeGraph },
              {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
              },
              {
                query: message,
                userId: scope.userId,
                limit: 8,
                minScore: 0.35,
                // Defaults exclude "private"; pass agent-visible + hidden.
                visibilityIn: ["agent_visible", "hidden"],
                // Agent-scoped injection: own agent, or cluster MEMBERS when
                // clustered — never scope-wide (the Mark/Ada leak fix). RAG
                // chunks are excluded inside the fusion so raw document text
                // never eats the injection budget.
                ...(await this.memoryAgentFilter(scope.agentId, injectClusteringId, scope)),
              },
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `memory retrieval exceeded ${injectTimeoutMs}ms inject budget`,
                    ),
                  ),
                injectTimeoutMs,
              ),
            ),
          ]);
          const hits = fused.memories;
          // Theme M.5 — drop memories flagged by a thumbs-down rating.
          // The metadata.flaggedByRating marker is written by
          // MemoryFeedbackService.applyRating; we treat it as "quarantined
          // pending human review" and exclude it from retrieval entirely.
          const notFlagged = hits.filter((h) => {
            const m = h.metadata;
            if (!m || typeof m !== "object" || Array.isArray(m)) return true;
            const flag = (m as Record<string, unknown>).flaggedByRating;
            return !flag;
          });
          // Theme M.5 — rating-weighted ranking. Apply the confidence
          // boost BEFORE sorting so high-confidence memories outrank
          // marginally-closer-but-unconfirmed ones. Formula:
          //     rankedScore = cosineScore * (1 + confidence * 0.25)
          // confidence ∈ [0, 1] → up to a 25% boost; NULL confidence
          // (pre-M.1 + manual rows) stays at 1x (no boost, no penalty).
          // Tie-break by lastAccessedAt desc — the SQL already bumps it
          // fire-and-forget for each returned row.
          const prioritized = notFlagged.slice().sort((a, b) => {
            const ac = typeof a.confidence === "number" ? a.confidence : 0;
            const bc = typeof b.confidence === "number" ? b.confidence : 0;
            const aRanked = a.score * (1 + ac * 0.25);
            const bRanked = b.score * (1 + bc * 0.25);
            if (bRanked !== aRanked) return bRanked - aRanked;
            const ta = a.lastAccessedAt ? a.lastAccessedAt.getTime() : 0;
            const tb = b.lastAccessedAt ? b.lastAccessedAt.getTime() : 0;
            return tb - ta;
          });
          const lines: string[] = [];
          let tokenTotal = 0;
          for (const h of prioritized) {
            const line = `- (${h.kind}) ${h.content}`;
            const est = Math.ceil(line.length / 4);
            if (tokenTotal + est > budget) break;
            lines.push(line);
            tokenTotal += est;
          }
          if (lines.length > 0) {
            memoryBlock = `## Things I remember about this user\n\n${lines.join("\n")}`;
          }
          // Inject the KG slice the message resolved to — the people/orgs in
          // the situation + how they relate. Compact + capped; gives the agent
          // "who and what is involved, and how" without needing a recall()
          // call. Labels/relationships are decrypted EntityRows.
          if (fused.entities.length > 0) {
            const entLines = fused.entities.slice(0, 8).map((e) => `- ${e.label} (${e.type})`);
            const relLines = fused.relationships
              .slice(0, 10)
              .map((r) => `- ${r.from} —${r.type}→ ${r.to}`);
            const parts = [`### People & things involved\n${entLines.join("\n")}`];
            if (relLines.length > 0) parts.push(`### How they relate\n${relLines.join("\n")}`);
            const graphBlock = `## Related in your world\n\n${parts.join("\n\n")}`;
            memoryBlock = memoryBlock ? `${memoryBlock}\n\n${graphBlock}` : graphBlock;
          }
        }
      } catch (err: any) {
        this.logger.warn(`[agent.stream] memory injection failed: ${err?.message ?? err}`);
      }
    }
    if (memoryBlock) {
      // Cache-correctness fix — same architectural issue the datetime block
      // hit. Memory rows match different items per turn (different user
      // queries → different semantic-search results), so concatenating the
      // memory block into `systemPrompt` (which gets `cacheControl: ephemeral`)
      // invalidates Anthropic's prompt cache every single turn — every turn
      // pays full cache_creation_input_tokens instead of the 90%-discounted
      // cache_read. Inject the memory block into `dynamicContext` instead so
      // it lands in the user-message <context> wrap, AFTER the cache
      // breakpoint. The LLM still sees the memories at the start of every
      // turn; the cache stays warm.
      if (!dynamicContext) dynamicContext = {};
      (dynamicContext as Record<string, string>)["__memory"] = memoryBlock;
    }

    // Theme S.6 — append enabled+env-ready skill prompt blocks. Skipped on
    // cache hit (skills are already baked into the cached stable prefix).
    if (!promptCacheHit && this.skillRuntime && scope.agentId) {
      try {
        const skillPayload = await this.skillRuntime.loadForAgent(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          scope.agentId,
        );
        if (skillPayload.promptBlock) {
          systemPrompt = this.skillRuntime.composeSystemPrompt(
            systemPrompt ?? undefined,
            skillPayload.promptBlock,
          );
        }
        // Wire skill-provided tools into the live tool dict so the LLM can
        // actually CALL them — not just read about them in the system prompt.
        const registeredToolNames: string[] = [];
        for (const pt of skillPayload.providedTools) {
          try {
            const skillRuntime = this.skillRuntime;
            const scopeTuple = {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
            };
            const _handler = pt.handler ?? `skill:${pt.skillId}:${pt.name}`;
            const _toolName = _handler.match(/^skill:[^:]+:(.+)$/)?.[1] ?? pt.name;
            const _params =
              pt.inputSchema && Object.keys(pt.inputSchema).length > 0
                ? aiJsonSchema(pt.inputSchema as Parameters<typeof aiJsonSchema>[0])
                : z.record(z.unknown());
            tools[pt.name] = {
              description: pt.description,
              inputSchema: _params,
              execute: async (input: Record<string, unknown>) => {
                return skillRuntime.invokeTool(
                  scopeTuple,
                  { skillSlug: pt.skillId, toolName: _toolName, handler: _handler },
                  input,
                  // audit L5 — this in-process registration passed no context,
                  // so the acting agent never reached the handler and RAG
                  // ingest could not stamp `agentId` (the dedicated
                  // rag_retrieve resolver above already threads it).
                  { agentId: scope.agentId ?? null, threadId: scope.sessionId ?? null },
                );
              },
            } as CoreTool;
            registeredToolNames.push(pt.name);
            // Populate the closure index that find_tools reads — keeps
            // skill tools discoverable through the meta-tool surface.
            skillToolIndex.push({
              name: pt.name,
              description: pt.description,
              paramSchema: pt.inputSchema as
                | { type?: string; properties?: Record<string, unknown> }
                | undefined,
              skillId: pt.skillId,
            });
          } catch (toolErr: any) {
            this.logger.warn(
              `[agent.stream] skill tool "${pt.name}" registration failed, skipping: ${toolErr?.message ?? toolErr}`,
            );
          }
        }
        if (registeredToolNames.length > 0) {
          this.logger.debug(
            `[agent.stream] skill tools registered: ${registeredToolNames.join(", ")}`,
          );
        }
      } catch (err: any) {
        // Non-fatal — skills are additive. Log and continue without them.
        this.logger.warn(`[agent.stream] skill merge failed: ${err?.message ?? err}`);
      }
    }

    // TL.2 — splice the "## Available tool categories" block (populated by
    // buildMetaTools when `displayMode` is `"summary"` or `"hybrid"`) into
    // systemPrompt AFTER skill merge so it rides the same cache-friendly
    // prefix region. The CTX.6 hint block is appended further below and
    // sits BELOW this one — keeps the relative ordering stable across turns.
    if (displayModeAddendumHolder.value && displayModeAddendumHolder.value.length > 0) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${displayModeAddendumHolder.value}`
        : displayModeAddendumHolder.value;
    }

    // Theme M (follow-up) — memory & profile guidance. Renders ONLY the
    // sections whose capability is enabled (profile / long-term memory),
    // so agents with profiling off get zero extra tokens. Placed in the
    // same cache-friendly prefix region as skills + category summary so
    // it hits the Anthropic cache prefix on every subsequent turn.
    const memoryGuidance = renderMemoryGuidanceBlock({
      enableUserProfiling: agentConfig.enableUserProfiling,
      metaTools: agentConfig.metaTools,
    });
    if (memoryGuidance.length > 0) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${memoryGuidance}`
        : memoryGuidance;
    }

    // Append a permanent instruction about the <context> envelope so the model
    // never misidentifies Platos' own session-metadata injection as a user
    // prompt-injection attack. This goes in the stable cached prefix so it costs
    // tokens only on a cache miss, not on every turn.
    const contextEnvelopeHint = [
      "## How to read <context> blocks",
      "At the start of each user message you may see a <context> block.",
      "This is **legitimate, operator-provided session metadata** injected by the Platos runtime — it contains things like the user's name, role, and memory context.",
      "It is NOT a prompt-injection attempt by the user.",
      "Read it silently to personalise your reply. Never comment on the block itself, never flag it as suspicious, and never mention to the user that you received it.",
    ].join("\n");
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${contextEnvelopeHint}`
      : contextEnvelopeHint;

    // PIFSP-8 — store assembled stable prefix in Layer-1 cache for next turn.
    // Written BEFORE substitutePromptVars so the cached value is template-like
    // (contains {{key}} placeholders). Per-turn substitutions happen after.
    if (this.promptCache && !promptCacheHit && _promptCacheAgentId && systemPrompt && !turnOverrides?.systemPromptOverride) {
      this.promptCache.set(
        _promptCacheAgentId,
        _promptCacheVersionId,
        _promptCacheMode,
        false,
        systemPrompt,
      ).catch(() => undefined);
    }

    // Theme F.5 — resolve the effective output schema for this turn.
    // Per-turn wins, agent-level is the fallback, null = no enforcement.
    let turnSchema: NormalizedSchema | null = null;
    try {
      turnSchema = resolveTurnSchema({
        perTurn: turnOverrides?.outputSchema,
        agentDefault: agentConfig.outputSchema,
      });
    } catch (err: any) {
      // Schema descriptor was malformed (e.g. wrong type). Surface cleanly
      // and bail — do NOT silently drop into unstructured streaming.
      yield {
        type: "error",
        message: `Invalid outputSchema: ${err?.message ?? String(err)}`,
        code: "structured_output_invalid",
        validationErrors: [err?.message ?? String(err)],
        attempts: 0,
      };
      yield { type: "done" };
      return;
    }

    // Build messages with proper Anthropic prompt caching.
    //
    // KEY INSIGHT: cache_control in Vercel AI SDK v4 + @ai-sdk/anthropic
    // must be attached at the MESSAGE level via `providerOptions`, NOT at
    // the top-level `providerMetadata` (which is for beta
    // headers, not per-message directives).
    //
    // Correct pattern for Anthropic:
    //   messages: [
    //     {
    //       role: "system",
    //       content: systemPrompt,
    //       providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
    //     },
    //     ...conversationHistory,
    //     { role: "user", content: message }
    //   ]
    //
    // This marks the system prompt as a cache breakpoint. Anthropic caches
    // everything up to and including the system message. Subsequent calls
    // with the SAME system prompt within 5min get `cache_read_input_tokens`
    // > 0 (90% discount on those tokens).
    //
    // GOTCHA: Anthropic's minimum cacheable prefix is 1024 tokens (Sonnet/Opus)
    // or 2048 tokens (Haiku). Short system prompts won't cache. Build rich
    // system prompts with examples + instructions to cross the threshold.
    //
    // OpenAI: automatic prefix caching, no code needed.
    // Google/Vertex: implicit caching.

    const anthropicCacheOpts = provider === "anthropic"
      ? { anthropic: { cacheControl: { type: "ephemeral" as const } } }
      : undefined;

    // Dedup defensively: if the last history entry is the same user message,
    // skip re-appending (history loaded BEFORE user-message persist should
    // prevent this, but keep the guard).
    const lastEntry = conversationHistory[conversationHistory.length - 1] as any;
    const alreadyEndsWithCurrent =
      lastEntry?.role === "user" &&
      typeof lastEntry.content === "string" &&
      lastEntry.content === message;

    // Theme CTX.6 — "Tool argument expectations" augmentation. Append a
    // per-tool bullet list enumerating which params the LLM is responsible
    // for providing (bucket #4 — not constants, not auto-injected). Inserted
    // AFTER the agent's skill-augmented systemPrompt and BEFORE prompt-var
    // substitution so it travels with the cache-friendly prefix.
    //
    // Walks the scoped tool matrix once + resolves per-tool; cost is linear
    // in the number of enabled tools. Safe on an empty matrix (returns "").
    //
    // TL.6 — sub-agent mode routing. When `toolsBlockConfig.mode ===
    // "sub-agent"` the parent LLM only sees `find_tools` +
    // `delegate_to_sub_agent`; the actual tool schemas live in the
    // sub-agent's context. Per-tool arg hints are useless to the parent
    // and only cost tokens. In that mode: the parent gets a 1-line hint
    // describing the delegation pattern, and the verbose per-tool block
    // is parked in `subAgentArgHintHolder` so `runSubAgent` can splice it
    // into the sub-agent's systemPrompt at dispatch time.
    const isSubAgentMode =
      agentConfig?.toolsBlockConfig?.mode === "sub-agent" ||
      agentConfig?.subAgentConfig != null;
    let ctxHintBlock = "";
    try {
      if (this.toolRegistry && (contextMapping || sessionContext)) {
        const scopedTools = this.toolRegistry.getScopedTools(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          // Theme EA — CTX.6 arg-expectations block should only describe
          // tools this agent can actually see, else we waste tokens hinting
          // at tools the LLM will never be offered.
          { enabledOnly: true, agentId: scope.agentId },
        );
        const resolvedList: ResolvedTool[] = scopedTools.map((t: any) =>
          resolveCtxToolMappingsForHint(
            { name: t.toolName, inputSchema: t.paramSchema },
            { contextMapping: (contextMapping as AgentContextMapping | null) ?? undefined },
            sessionContext,
          ),
        );
        ctxHintBlock = buildCtxLlmHintBlock(resolvedList);
      }
    } catch (err: any) {
      this.logger.warn(
        `[agent.stream] CTX.6 hint-block build failed, skipping: ${err?.message ?? err}`,
      );
    }
    if (ctxHintBlock && ctxHintBlock.length > 0) {
      if (isSubAgentMode) {
        // TL.6 — stash the verbose block for the sub-agent; parent gets
        // a minimal 1-liner about the delegation pattern.
        subAgentArgHintHolder.value = ctxHintBlock;
        const parentHint =
          "You have `find_tools` + `delegate_to_sub_agent`. Describe the intent to the sub-agent — it handles individual tool arg specifics.";
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${parentHint}` : parentHint;
      } else {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${ctxHintBlock}` : ctxHintBlock;
      }
    }

    // Theme CTX.2 — Role 1 (prompt substitution). Run AFTER all other prompt
    // composition (memory, skills, per-turn overrides) so `{{user.name}}`
    // style placeholders introduced anywhere — agent systemPrompt,
    // dynamicBlocks, skill prompt blocks — resolve against
    // `thread.sessionContext`. Fail-open: absent sessionContext OR no
    // matching key → placeholder stays verbatim.
    if (sessionContext && systemPrompt) {
      const before = [...systemPrompt.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
      systemPrompt = substitutePromptVars(
        systemPrompt,
        sessionContext,
        contextMapping?.promptVars,
      );
      const after = [...systemPrompt.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
      if (before.length > 0 || after.length > 0) {
        this.logger.log(
          `[agent.stream] promptVar: resolved=${JSON.stringify(before.filter(p => !after.includes(p)))} unresolved=${JSON.stringify(after)}`,
        );
      }
    }

    // Assemble dynamic context string (if any). This lives AFTER the cache
    // breakpoint — fresh per turn, not cached. Ordered: compacted summary →
    // user profile → caller-provided blocks → (current user message).
    // Cache-correctness fix — datetime block. If the agent has an enabled
    // `datetime` prompt block, inject a FRESH timestamp into dynamicContext
    // here (post-cache-breakpoint) instead of letting it sit inside the
    // cached `systemPrompt`. Otherwise the timestamp varies per turn → the
    // single ephemeral cacheControl on systemPrompt invalidates → every turn
    // pays full cache_creation_input_tokens instead of cache_read.
    {
      const promptBlocks = (agentConfig.promptBlocks ?? []) as Array<{
        type?: string;
        enabled?: boolean;
      }>;
      const hasEnabledDateTimeBlock = promptBlocks.some(
        (b) => b && b.type === "datetime" && b.enabled !== false,
      );
      const pb = this.getPromptBuilder();
      if (hasEnabledDateTimeBlock && pb) {
        try {
          const dt = pb.renderDateTimeBlockText({
            user_timezone: (sessionContext as any)?.user_timezone,
          });
          if (!dynamicContext) dynamicContext = {};
          (dynamicContext as Record<string, string>)["__datetime"] = dt;
        } catch (err: any) {
          this.logger.warn(
            `[agent.stream] datetime block injection failed: ${err?.message ?? err}`,
          );
        }
      }
    }

    let dynamicContextText = "";
    if (dynamicContext && Object.keys(dynamicContext).length > 0) {
      const ctx = dynamicContext;
      const parts: string[] = [];
      // Stable order: known keys first, then alphabetical
      const orderedKeys = [
        "__datetime",
        "__compacted_summary",
        "__user_profile",
        "__memory",
        ...Object.keys(ctx).filter(k => !k.startsWith("__")).sort(),
      ].filter(k => ctx[k] !== undefined);
      for (const k of orderedKeys) {
        parts.push(ctx[k]);
      }
      if (parts.length > 0) {
        dynamicContextText = parts.join("\n\n");
        // CTX.2 Role 1 — dynamic blocks are user-authored (agent.dynamicBlocks
        // defaults / caller overrides) so they can carry `{{...}}` too.
        if (sessionContext) {
          dynamicContextText = substitutePromptVars(
            dynamicContextText,
            sessionContext,
            contextMapping?.promptVars,
          );
        }
      }
    }

    // Build final user content. When dynamic context exists, prepend it to the
    // current user message inside a clearly-delimited context block so the LLM
    // knows it's situational metadata, not part of the user's turn.
    const baseText = dynamicContextText
      ? `<context>\n${dynamicContextText}\n</context>\n\n${message}`
      : message;

    // PIFSP-15 — Theme D multimodal routing. If the model supports every
    // attachment kind, pass native ImagePart/FilePart content. If not, surface
    // an explicit ATTACHMENT_UNSUPPORTED error event (not a silent drop) AND
    // still include a text fallback so the LLM can acknowledge the file.
    let finalUserContent: string | Array<any> = baseText;
    if (attachments && attachments.length > 0) {
      const native = canRouteNatively(agentConfig.model, attachments);
      this.logger.log(
        `[attachments] resolving ${attachments.length} attachment(s) for model=${agentConfig.model} native=${native}`,
      );
      if (native) {
        // MULTIMODAL FIX (ai@7): image/file parts require `mediaType` — v7
        // renamed `mimeType`, and for FileParts the field is mandatory, so the
        // old inline builder here (which still sent `mimeType`) made every
        // non-image attachment throw "Media type is missing for file part"
        // and fail the whole turn. Images only survived via magic-byte
        // inference. Route through the single canonical, v7-correct assembler
        // so the part shape can never drift from the SDK again.
        finalUserContent = AttachmentsService.toMultimodalContent(baseText, attachments);
        for (const a of attachments) {
          this.logger.log(
            `[attachments] built ${a.kind} part: id=${a.id} mediaType=${a.mimeType} bytes=${a.bytes}`,
          );
        }
        this.logger.log(
          `[attachments] multimodal native: ${attachments.length} part(s) routed to provider=${provider}`,
        );
      } else {
        // PIFSP-15: surface an explicit error so the user knows the
        // attachment wasn't processed natively — never silent-drop.
        const unsupportedKinds = [...new Set(attachments.map((a) => a.kind))];
        yield {
          type: "error",
          code: "ATTACHMENT_UNSUPPORTED",
          message:
            `The current model (${agentConfig.model}) doesn't support ` +
            `${unsupportedKinds.join(", ")} attachments. ` +
            `Switch to claude-sonnet-4-6, gpt-4o, or gemini-2.0-flash for full multimodal support. ` +
            `A text description of the attachment has been included instead.`,
        } as any;
        const fallbackNote = attachments
          .map((a) => textFallbackDescription(a))
          .join("\n");
        finalUserContent = `${fallbackNote}\n\n${baseText}`;
        this.logger.warn(
          `[attachments] unsupported kind(s) ${unsupportedKinds.join(",")} for model=${agentConfig.model}; text fallback used`,
        );
      }
    }

    const messages: CoreMessage[] = [
      // System prompt as first message with cache_control breakpoint
      ...(systemPrompt
        ? [{
            role: "system" as const,
            content: systemPrompt,
            ...(anthropicCacheOpts ? { providerOptions: anthropicCacheOpts } : {}),
          }]
        : []),
      ...conversationHistory,
      ...(alreadyEndsWithCurrent
        ? []
        : [{ role: "user" as const, content: finalUserContent as any }]),
    ];

      // ===== VERBOSE PAYLOAD LOGGING (BLOCK 1 prompt caching verification) =====
      const promptChars = systemPrompt?.length || 0;
      const promptTokensEst = Math.ceil(promptChars / 4); // rough char → token
      this.logger.debug("=".repeat(80));
      this.logger.debug(`[agent.stream] ===== OUTBOUND REQUEST =====`);
      this.logger.debug(`[agent.stream] org=${scope.organizationId} project=${scope.projectId} env=${scope.environmentId} agentId=${scope.agentId || "default"} userId=${scope.userId}`);
      this.logger.debug(`[agent.stream] model=${agentConfig.model} provider=${provider}`);
      this.logger.debug(`[agent.stream] systemPrompt chars=${promptChars} est_tokens=${promptTokensEst} (Anthropic cache threshold: 1024 tokens for Sonnet/Opus, 2048 for Haiku)`);
      this.logger.debug(`[agent.stream] conversation history messages=${conversationHistory.length}`);
      this.logger.debug(`[agent.stream] current user message chars=${message.length}`);
      this.logger.debug(`[agent.stream] messages array (structure):`);
      messages.forEach((m, i) => {
        const contentPreview = typeof m.content === "string" ? m.content.slice(0, 120) : "[array content]";
        const hasProviderOpts = !!(m as any).providerOptions;
        this.logger.debug(`[agent.stream]   [${i}] role=${m.role} chars=${typeof m.content === "string" ? m.content.length : 0} providerOptions=${hasProviderOpts ? JSON.stringify((m as any).providerOptions) : "NONE"}`);
        this.logger.debug(`[agent.stream]        content: ${contentPreview}${typeof m.content === "string" && m.content.length > 120 ? "…" : ""}`);
      });
      this.logger.debug(`[agent.stream] tool count=${Object.keys(tools).length}`);
      this.logger.debug(`[agent.stream] ============================`);

      // Emit inspector trace event — carries the full outbound request so the
      // Platos chat inspector panel can render it without SSH'ing into logs.
      yield {
        type: "trace_request",
        model: agentConfig.model,
        provider,
        systemPrompt: systemPrompt ?? "",
        systemPromptChars: promptChars,
        systemPromptTokensEst: promptTokensEst,
        historyMessageCount: conversationHistory.length,
        toolNames: Object.keys(tools),
        toolCount: Object.keys(tools).length,
        sessionContext: sessionContext ?? undefined,
        timestamp: new Date().toISOString(),
      } as any;

      // Queue for tool results
      const pendingToolResults: AgentStreamEvent[] = [];

      // ─── Theme F.5 — structured output enforcement branch ───────────────
      // When a schema is in play, we bypass the tool-calling streamText loop
      // and route through `streamObject`. Tools aren't compatible with
      // structured-output mode in Vercel AI SDK v4 (the provider is locked
      // into JSON-mode / single-tool-call), so we intentionally don't pass
      // them through here — the contract is "this turn returns JSON, not
      // a tool-loop conversation".
      //
      // Validation + retry-once happens here inline. On the retry attempt we
      // stay in non-streaming mode (`generateObject`) to keep the correction
      // prompt bounded — the UI already showed a progress spinner for the
      // first attempt; the retry finishes fast or the turn fails closed.
      if (turnSchema) {
        this.logger.log(
          `[agent.stream] structured-output mode: schema present, routing through streamObject (provider=${provider})`,
        );
        let attempts = 0;
        let lastRawText: string | undefined;
        let lastErrors: string[] = [];
        // The messages we send this attempt — on retry, we append a correction
        // user message carrying the prior validation errors.
        let attemptMessages: CoreMessage[] = messages;

        while (attempts < 2) {
          attempts++;
          let rawText = "";
          let parsedObject: unknown = undefined;

          try {
            if (attempts === 1) {
              // Stream the first attempt so the UI shows progress.
              // AI SDK v6 — `mode: "auto"` removed; provider-specific output
              // mode is now controlled per-provider (e.g. Anthropic
              // `structuredOutputMode`) or defaults to JSON tool-call.
              // PRELAUNCH-A2-3 — propagate the caller's abort signal.
              // Without this, clicking "stop" closes the local stream but
              // Anthropic / OpenAI / Google keep generating + billing the
              // structured-output turn upstream.
              const streamResult = streamObject({
                model,
                messages: attemptMessages as any,
                schema: turnSchema as any,
                abortSignal: turnOverrides?.abortSignal,
                onFinish: (event: any) => {
                  this.logger.log(
                    `[agent.stream.structured] onFinish attempt=${attempts} usage=${JSON.stringify(event?.usage ?? {})}`,
                  );
                },
              });

              // Forward raw JSON text tokens so legacy consumers still see
              // text-delta events. Downstream (AgentTaskService) accumulates
              // them into `content` for persistence.
              for await (const chunk of streamResult.textStream) {
                rawText += chunk;
                yield { type: "token", text: chunk };
              }
              // Resolve the final parsed object. If the SDK itself couldn't
              // parse the text at all, `.object` rejects with
              // NoObjectGeneratedError — we catch below, count it as an
              // attempt, and retry with the raw text fed back.
              parsedObject = await streamResult.object;
              const usage = await streamResult.usage;
              // PRELAUNCH-A1-3 / A1-4 — extract cache + reasoning telemetry
              // with full provider fallback chain. v6 canonical path is
              // `usage.{input,output}TokenDetails`; provider metadata
              // (anthropic / openai / google / vertex) provides the
              // fallbacks for in-flight v4-shape responses.
              const provMeta = (await (streamResult as any).providerMetadata) as
                | Record<string, any>
                | undefined;
              const cacheRead =
                Number((usage as any)?.inputTokenDetails?.cacheReadTokens ?? 0) ||
                Number(provMeta?.anthropic?.cacheReadInputTokens ?? 0) ||
                Number(provMeta?.openai?.cachedPromptTokens ?? 0) ||
                Number(provMeta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
                Number(provMeta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
              const cacheCreation =
                Number((usage as any)?.inputTokenDetails?.cacheWriteTokens ?? 0) ||
                Number(provMeta?.anthropic?.cacheCreationInputTokens ?? 0) ||
                Number(provMeta?.vertex?.cacheCreationInputTokens ?? 0);
              const reasoning =
                Number((usage as any)?.outputTokenDetails?.reasoningTokens ?? 0) ||
                Number(provMeta?.openai?.reasoningTokens ?? 0) ||
                Number(provMeta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
                Number(provMeta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
              yield {
                type: "meta",
                usage: {
                  inputTokens: usage?.inputTokens,
                  outputTokens: usage?.outputTokens,
                  cacheCreationInputTokens: cacheCreation > 0 ? cacheCreation : undefined,
                  cacheReadInputTokens: cacheRead > 0 ? cacheRead : undefined,
                  reasoningTokens: reasoning > 0 ? reasoning : undefined,
                },
              };
            } else {
              // Retry attempt — non-streaming for a bounded correction.
              // PRELAUNCH-A2-4 — same abort propagation as the streaming
              // branch above. Stop button must cancel the retry leg too.
              const genResult = await generateObject({
                model,
                messages: attemptMessages as any,
                schema: turnSchema as any,
                abortSignal: turnOverrides?.abortSignal,
              });
              parsedObject = genResult.object;
              // Emit the final JSON as a single token so the UI has the text.
              rawText = JSON.stringify(parsedObject);
              yield { type: "token", text: rawText };
              // PRELAUNCH-A1-3 / A1-4 — full provider fallback chain
              // mirroring the streamObject branch above.
              const genProvMeta = (genResult as any).providerMetadata as
                | Record<string, any>
                | undefined;
              const genUsage = genResult.usage as any;
              const genCacheRead =
                Number(genUsage?.inputTokenDetails?.cacheReadTokens ?? 0) ||
                Number(genProvMeta?.anthropic?.cacheReadInputTokens ?? 0) ||
                Number(genProvMeta?.openai?.cachedPromptTokens ?? 0) ||
                Number(genProvMeta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
                Number(genProvMeta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
              const genCacheCreation =
                Number(genUsage?.inputTokenDetails?.cacheWriteTokens ?? 0) ||
                Number(genProvMeta?.anthropic?.cacheCreationInputTokens ?? 0) ||
                Number(genProvMeta?.vertex?.cacheCreationInputTokens ?? 0);
              const genReasoning =
                Number(genUsage?.outputTokenDetails?.reasoningTokens ?? 0) ||
                Number(genProvMeta?.openai?.reasoningTokens ?? 0) ||
                Number(genProvMeta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
                Number(genProvMeta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
              yield {
                type: "meta",
                usage: {
                  inputTokens: genResult.usage?.inputTokens,
                  outputTokens: genResult.usage?.outputTokens,
                  cacheCreationInputTokens: genCacheCreation > 0 ? genCacheCreation : undefined,
                  cacheReadInputTokens: genCacheRead > 0 ? genCacheRead : undefined,
                  reasoningTokens: genReasoning > 0 ? genReasoning : undefined,
                },
              };
            }
          } catch (err: any) {
            // SDK couldn't even produce a parseable object — retry with
            // raw text feedback if we have budget.
            lastRawText = (err?.text as string | undefined) ?? lastRawText;
            lastErrors = [
              `model produced non-JSON output: ${err?.message ?? String(err)}`,
            ];
            this.logger.warn(
              `[agent.stream.structured] attempt=${attempts} parse-fail: ${err?.message ?? String(err)}`,
            );
            if (attempts >= 2) break;
            attemptMessages = [
              ...attemptMessages,
              {
                role: "user" as const,
                content: buildRetryCorrectionMessage(lastRawText, lastErrors),
              },
            ];
            continue;
          }

          // Second-chance validation — some providers ignore the schema
          // hint even when the SDK thinks the JSON "fits". Run our own
          // validator so Zod refinements / JSON-Schema `format` checks
          // actually enforce.
          const check = validateAgainstSchema(turnSchema, parsedObject);
          if (check.success) {
            yield {
              type: "structured_output",
              object: check.value,
              attempts,
            };
            yield { type: "done" };
            this.logger.log(
              `[agent.stream.structured] SUCCESS attempts=${attempts}`,
            );
            return;
          }

          // Invalid — prep retry or surface error.
          lastErrors = check.errors;
          lastRawText = rawText;
          this.logger.warn(
            `[agent.stream.structured] attempt=${attempts} validation-fail: ${check.errors.length} error(s): ${check.errors.slice(0, 3).join("; ")}`,
          );
          if (attempts >= 2) break;
          attemptMessages = [
            ...attemptMessages,
            {
              role: "user" as const,
              content: buildRetryCorrectionMessage(lastRawText, lastErrors),
            },
          ];
        }

        // Both attempts failed — surface as a StructuredOutputError.
        const soErr = new StructuredOutputError(
          "Agent failed to produce output matching the required schema after 1 retry.",
          {
            attempts,
            validationErrors: lastErrors,
            rawText: lastRawText,
          },
        );
        yield {
          type: "error",
          message: soErr.message,
          code: "structured_output_invalid",
          validationErrors: soErr.validationErrors,
          attempts: soErr.attempts,
        };
        yield { type: "done" };
        return;
      }
      // ─── end structured-output branch ────────────────────────────────────

      // MC.1 — accumulate Anthropic cache tokens across step-finish events.
      // The final `finish` chunk carries step totals (ok for 1-step turns)
      // but sub-step cache attribution only arrives on `onStepFinish`. We
      // keep a running sum here and surface it on the terminal `meta` event
      // so the agent-task layer can persist + bill the cumulative numbers.
      let cacheCreationTotal = 0;
      let cacheReadTotal = 0;
      // PRELAUNCH-A1-3 — reasoning-token accumulator. Models with built-in
      // reasoning (OpenAI o1/o3/o4, DeepSeek R1, Perplexity reasoning,
      // Gemini 2.5 thinking) bill the reasoning span at the output rate;
      // it lands on outputTokenDetails or in provider metadata.
      let reasoningTotal = 0;
      // PRELAUNCH-A1-5 — capture the LAST observed raw v6 token-details
      // blobs so they can ride out on the terminal `meta` event and be
      // persisted onto responseJson.usage for post-hoc cost audit.
      let lastInputTokenDetails: Record<string, unknown> | null = null;
      let lastOutputTokenDetails: Record<string, unknown> | null = null;
      // TOOL-RESULT BOUNDARY — coerce every tool `execute` return into a valid,
      // JSON-serializable tool-result part before the SDK's multi-step loop can
      // embed it in the next step's ModelMessage[]. Prevents an undefined /
      // non-serializable return (e.g. a skill handler that resolves undefined)
      // from throwing AI_InvalidPromptError on tool turns. Idempotent + mutates
      // the same `tools` object the call below reads.
      hardenToolResults(tools);
      const result = streamText({
        model,
        messages,
        tools,
        // Main agent turn — system prompt rides in `messages[]` so
        // per-message `providerOptions` (anthropic cacheControl) can be
        // attached. Suppresses the AI SDK v6 warning nudge.
        allowSystemInMessages: true,
        // AI SDK v6 — `maxSteps: N` removed; use `stopWhen` predicate.
        // `isStepCount(N)` halts the tool-calling loop after N steps.
        stopWhen: isStepCount(agentConfig.maxSteps),
        // EOBD.26/27 — caller's abort signal: closes on stop button
        // OR turn timeout. Vercel AI SDK propagates this to the
        // underlying provider HTTP stream.
        abortSignal: turnOverrides?.abortSignal,
        onStepEnd: (event) => {
          // AI SDK v6 — `tr.result` renamed to `tr.output` on tool-result chunks.
          const results = event.toolResults as Array<{ toolName: string; output: unknown; toolCallId: string }> | undefined;
          if (results) {
            for (const tr of results) {
              pendingToolResults.push({
                type: "tool_result",
                name: tr.toolName,
                result: tr.output,
                callId: tr.toolCallId,
              });
            }
          }
          const usage = (event as any).usage;
          const providerMeta = (event as any).providerMetadata;
          // PRELAUNCH-A1-4 — accumulate cache tokens with full provider
          // fallback chain. Prefer the normalized v6 `usage.input/outputTokenDetails`
          // when present; fall back to provider-specific metadata for
          // OpenAI / Google / Vertex / Anthropic. Vertex specifically
          // exposes the metadata under the `vertex` key when running
          // Gemini through `@ai-sdk/google-vertex` — the older `google`
          // key keeps working for direct Gemini API calls.
          const stepCacheRead =
            Number((usage as any)?.inputTokenDetails?.cacheReadTokens ?? 0) ||
            Number(providerMeta?.anthropic?.usage?.cache_read_input_tokens ?? 0) ||
            Number(providerMeta?.anthropic?.cacheReadInputTokens ?? 0) ||
            Number(providerMeta?.openai?.cachedPromptTokens ?? 0) ||
            Number(providerMeta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
            Number(providerMeta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
          const stepCacheCreation =
            Number((usage as any)?.inputTokenDetails?.cacheWriteTokens ?? 0) ||
            Number(providerMeta?.anthropic?.usage?.cache_creation_input_tokens ?? 0) ||
            Number(providerMeta?.anthropic?.cacheCreationInputTokens ?? 0) ||
            Number(providerMeta?.vertex?.cacheCreationInputTokens ?? 0);
          cacheCreationTotal += stepCacheCreation;
          cacheReadTotal += stepCacheRead;
          // PRELAUNCH-A1-3 — reasoning tokens. Canonical v6 path is
          // `outputTokenDetails.reasoningTokens`; provider fallbacks for
          // OpenAI o-series, Google 2.5-series thinking, Vertex.
          const stepReasoning =
            Number((usage as any)?.outputTokenDetails?.reasoningTokens ?? 0) ||
            Number(providerMeta?.openai?.reasoningTokens ?? 0) ||
            Number(providerMeta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
            Number(providerMeta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
          reasoningTotal += stepReasoning;
          // PRELAUNCH-A1-5 — capture the last observed raw token-details
          // blobs. The most recent step's view is what we persist (each
          // step carries the cumulative shape on v6 SDK).
          if ((usage as any)?.inputTokenDetails) {
            lastInputTokenDetails = (usage as any).inputTokenDetails as Record<string, unknown>;
          }
          if ((usage as any)?.outputTokenDetails) {
            lastOutputTokenDetails = (usage as any).outputTokenDetails as Record<string, unknown>;
          }
          const finishReason = (event as any).finishReason;
          this.logger.debug(`[agent.stream] ----- STEP FINISH -----`);
          this.logger.debug(`[agent.stream] finish_reason=${finishReason}`);
          this.logger.debug(`[agent.stream] usage: prompt=${usage?.inputTokens ?? 0} completion=${usage?.outputTokens ?? 0} total=${usage?.totalTokens ?? 0}`);
          this.logger.debug(`[agent.stream] anthropic CACHE: creation=${stepCacheCreation} read=${stepCacheRead} (read>0 means 90% discount hit)`);
          if (providerMeta?.anthropic) {
            const cr = providerMeta.anthropic.cacheCreationInputTokens;
            const rd = providerMeta.anthropic.cacheReadInputTokens;
            this.logger.debug(`[agent.stream] anthropic CACHE: creation=${cr ?? 0} read=${rd ?? 0} (read>0 means 90% discount hit)`);
            this.logger.debug(`[agent.stream] full provider metadata: ${JSON.stringify(providerMeta.anthropic)}`);
          } else {
            this.logger.debug(`[agent.stream] no anthropic provider metadata in response (check model is Anthropic)`);
          }
          if (results && results.length > 0) {
            this.logger.debug(`[agent.stream] tool calls this step: ${results.map((r: any) => r.toolName).join(", ")}`);
          }
          this.logger.debug(`[agent.stream] -----------------------`);
        },
        onEnd: (event: any) => {
          this.logger.debug(`[agent.stream] ===== FINAL USAGE =====`);
          this.logger.debug(`[agent.stream] total usage: ${JSON.stringify(event.usage)}`);
          this.logger.debug(`[agent.stream] steps: ${event.steps?.length ?? 1}`);
          this.logger.debug(`[agent.stream] =======================`);
        },
      });

      // Stream tokens as they arrive
      let currentStepToolCalls: string[] = [];

      for await (const chunk of result.stream) {
        switch (chunk.type) {
          case "text-delta":
            yield { type: "token", text: chunk.text };
            break;

          case "tool-call":
            currentStepToolCalls.push(chunk.toolName);
            yield {
              type: "tool_call",
              name: chunk.toolName,
              params: chunk.input,
              callId: chunk.toolCallId,
            };
            break;

          // PRELAUNCH-A2-5 — `case "tool-result"` is now handled below as
          // a separate stream chunk for provider-executed tool calls
          // (Anthropic web_search, Google codeExecution). Step-attributed
          // tool results still come through onStepFinish via the
          // `pendingToolResults` queue and drain on `finish-step`.

          // AI SDK v6 — `step-finish` event renamed to `finish-step`.
          // Same payload shape (usage, finishReason, providerMetadata).
          case "finish-step":
            // Theme F.7 — drain artifact events BEFORE tool_result so the
            // consumer sees `artifact_start` → `artifact_delta` →
            // `artifact_committed` land in the correct order relative to
            // the tool_result for the same callId. Artifact events are
            // pushed synchronously from inside the meta-tool `execute()`,
            // so by the time we reach step-finish the queue has all
            // events from tools that completed in this step.
            while (pendingArtifactEvents.length > 0) {
              yield pendingArtifactEvents.shift()!;
            }
            // Tool results are handled by Vercel AI SDK internally (fed back
            // to the model for the next step). We emit tool_result events
            // from the onStepFinish callback via the pendingToolResults queue.
            while (pendingToolResults.length > 0) {
              yield pendingToolResults.shift()!;
            }
            // Emit per-step trace for the inspector panel.
            {
              const stepUsage = (chunk as any).usage ?? {};
              const stepMeta = (chunk as any).providerMetadata?.anthropic ?? {};
              // AI SDK v6 moved cache token counts. Try every path the
              // Anthropic adapter has used through v3+:
              //   1. usage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens} (v6 canonical)
              //   2. providerMetadata.anthropic.usage.{cache_read_input_tokens,cache_creation_input_tokens} (raw passthrough)
              //   3. providerMetadata.anthropic.{cacheReadInputTokens,cacheCreationInputTokens} (legacy v4-shape)
              const cacheRead =
                Number((stepUsage as any).inputTokenDetails?.cacheReadTokens ?? 0) ||
                Number(stepMeta.usage?.cache_read_input_tokens ?? 0) ||
                Number(stepMeta.cacheReadInputTokens ?? 0);
              const cacheCreation =
                Number((stepUsage as any).inputTokenDetails?.cacheWriteTokens ?? 0) ||
                Number(stepMeta.usage?.cache_creation_input_tokens ?? 0) ||
                Number(stepMeta.cacheCreationInputTokens ?? 0);
              yield {
                type: "trace_step",
                finishReason: (chunk as any).finishReason ?? "unknown",
                usage: {
                  inputTokens: stepUsage.inputTokens ?? 0,
                  outputTokens: stepUsage.outputTokens ?? 0,
                  totalTokens: stepUsage.totalTokens ?? 0,
                  inputTokenDetails: (stepUsage as any).inputTokenDetails,
                },
                cacheCreation,
                cacheRead,
                toolCalls: [...currentStepToolCalls],
                timestamp: new Date().toISOString(),
              } as any;
            }
            // If the step had tool calls and there's another step coming,
            // emit a message boundary so the frontend can start a new bubble
            if (currentStepToolCalls.length > 0) {
              yield { type: "message_boundary" };
              currentStepToolCalls = [];
            }
            break;

          // AI SDK v6 — `reasoning` event split into start/delta/end. The
          // delta event carries the actual text chunks. Start/end are
          // signal-only and we don't surface them to the client.
          case "reasoning-delta":
            yield { type: "thinking", text: (chunk as any).text };
            break;

          case "finish":
            // MC.1 — include cumulative Anthropic cache tokens (accumulated in
            // onStepFinish). The `finish` chunk's usage carries step-total
            // prompt/completion but cache fields only live on provider
            // metadata; we emit them alongside input/output so the consumer
            // (agent-task) can fan them out to the cost counters.
            // AI SDK v6 — `finish` chunk's `usage` field renamed to
            // `totalUsage` (carries the cumulative inputTokens/outputTokens
            // across all steps in the turn). Per-step usage still comes
            // through onStepFinish via `event.usage`.
            // PRELAUNCH-A1-3 — surface reasoning tokens accumulated across steps.
            // PRELAUNCH-A1-5 — surface the LAST observed v6 token-details
            // blobs (inputTokenDetails / outputTokenDetails) so the agent-
            // task can persist them on responseJson.usage for post-hoc cost
            // audit. These are pass-through from the SDK.
            yield {
              type: "meta",
              usage: {
                // AI SDK v7 keeps `totalUsage` on the stream `finish` part; the
                // `?? .usage` fallback guards against a silent field move (v7
                // flipped the awaited `result.usage` to mean total-across-steps).
                inputTokens: (chunk as any).totalUsage?.inputTokens ?? (chunk as any).usage?.inputTokens,
                outputTokens: (chunk as any).totalUsage?.outputTokens ?? (chunk as any).usage?.outputTokens,
                cacheCreationInputTokens: cacheCreationTotal > 0 ? cacheCreationTotal : undefined,
                cacheReadInputTokens: cacheReadTotal > 0 ? cacheReadTotal : undefined,
                reasoningTokens: reasoningTotal > 0 ? reasoningTotal : undefined,
                inputTokenDetails: lastInputTokenDetails ?? undefined,
                outputTokenDetails: lastOutputTokenDetails ?? undefined,
              },
            };
            break;

          // PRELAUNCH-A2-5 — six v6 chunk types previously dropped silently.

          case "source":
            // Anthropic citations + OpenAI URL annotations + Google grounding
            // all come through here as `{ type: "source", source: {...} }`.
            // The frontend chat route already has a `case "citation":` slot
            // (route.tsx:1268) that renders the inline citation badge; the
            // agent just needs to forward the payload.
            yield {
              type: "citation",
              source: (chunk as any).source ?? chunk,
            } as any;
            break;

          case "file":
            // Gemini-generated images, Anthropic web_search file artifacts.
            // Surface as a generic artifact event keyed by the file kind so
            // the consumer can render via the existing PlatosArtifact path.
            yield {
              type: "artifact",
              kind: "file",
              file: (chunk as any).file ?? chunk,
            } as any;
            break;

          case "tool-result":
            // Provider-executed tool calls: Anthropic web_search_tool_result,
            // Google codeExecutionResult. The previous code path relied on
            // onStepFinish for ALL tool results — wrong for v6, where
            // provider-executed tool results stream as their own chunks
            // BEFORE the step finishes. Forward with `providerExecuted: true`
            // so the consumer can distinguish from step-attributed results.
            yield {
              type: "tool_result",
              name: (chunk as any).toolName,
              result: (chunk as any).output ?? (chunk as any).result,
              callId: (chunk as any).toolCallId,
              providerExecuted: true,
            } as any;
            break;

          case "tool-error":
            // Tool returned an error result. Frontend currently renders the
            // wrapper JSON as a normal output; with `isError: true` it can
            // light up a "tool failed" indicator on the same toolCallId.
            yield {
              type: "tool_result",
              name: (chunk as any).toolName,
              result: (chunk as any).error ?? (chunk as any).output ?? null,
              callId: (chunk as any).toolCallId,
              isError: true,
            } as any;
            break;

          case "tool-output-denied":
            // v6 native `tool.needsApproval` deny path. Consumer surfaces
            // this as a non-fatal error so the user sees the deny without
            // the turn ending mid-stream.
            yield {
              type: "error",
              code: "tool_output_denied",
              message: `Tool output denied: ${(chunk as any).toolName ?? "unknown"}`,
            } as any;
            break;

          case "abort":
            // Stream-level abort frame. Previously relied on the catch
            // block; emitting an explicit `error` keeps the contract clean
            // even if v6 changes closure timing on cancellation.
            yield {
              type: "error",
              code: "aborted",
              message: "Stream aborted",
            } as any;
            break;

          case "error":
            yield { type: "error", message: String(chunk.error) };
            break;
        }
      }

      // Theme F.7 — flush any artifact events that landed after the last
      // step-finish (e.g. a meta-tool running in the final step that
      // completed after the loop's final step-finish chunk).
      while (pendingArtifactEvents.length > 0) {
        yield pendingArtifactEvents.shift()!;
      }

      yield { type: "done" };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      yield { type: "error", message: msg };
      yield { type: "done" };
    }
  }

  /**
   * Non-streaming response (for REST API fallback).
   *
   * Theme F.5 — when the agent config or the per-turn override declares an
   * `outputSchema`, routes through `generateObject` with inline validation
   * and retry-once-on-invalid. Raises `StructuredOutputError` (never yields
   * text) after the second failed attempt so callers can branch on
   * `err.code === "structured_output_invalid"`.
   */
  async run(
    message: string,
    conversationHistory: CoreMessage[],
    agentConfig: AgentConfig,
    scope: RequestScope,
    turnOverrides?: {
      systemPromptOverride?: string | null;
      outputSchema?: OutputSchemaInput;
      /** W.1 — see `stream()` for semantics. */
      allowedTools?: string[];
      /**
       * PRELAUNCH-A2-13 — abort signal for the non-streaming path. When the
       * caller (test harness, batch executor, MCP simulate_turn) wires a
       * signal here, every nested LLM call (generateText, generateObject,
       * delegate_to_sub_agent) propagates it to the provider.
       */
      abortSignal?: AbortSignal;
    },
  ): Promise<any> {
    const apiKey = await this.resolveApiKey(agentConfig.model, scope, agentConfig.providerKeyId);
    // LAUNCH-2 — per-agent retry rules override the built-in defaults.
    const model = resolveModel(agentConfig.model, apiKey, agentConfig.agentRetryConfig?.rules);
    // TL.2 — same display-mode addendum holder as stream(). Populated by
    // buildMetaTools when the agent is in summary / hybrid mode.
    const runDisplayModeAddendumHolder: { value: string } = { value: "" };
    let tools = this.buildMetaTools(
      scope,
      agentConfig,
      undefined,
      undefined,
      runDisplayModeAddendumHolder,
      // PRELAUNCH-A2-6/13 — propagate abort signal into delegate_to_sub_agent.
      turnOverrides?.abortSignal,
    );
    if (turnOverrides?.allowedTools && Array.isArray(turnOverrides.allowedTools)) {
      tools = filterToolsAllowlist(tools, turnOverrides.allowedTools);
    }

    let systemPrompt =
      turnOverrides?.systemPromptOverride &&
      turnOverrides.systemPromptOverride.length > 0
        ? turnOverrides.systemPromptOverride
        : agentConfig.systemPrompt;

    // RG.1.5 (follow-up) — mirror the stream() retrieval assembly into the
    // non-streaming run() path so batch / run-once callers also re-resolve
    // retrieval blocks against the incoming message. See the stream() copy
    // for the full rationale and fail-open contract.
    {
      const pb = this.getPromptBuilder();
      const savedBlocks = Array.isArray(agentConfig.promptBlocks)
        ? (agentConfig.promptBlocks as Array<{ type?: string; enabled?: boolean }>)
        : [];
      const hasRetrievalBlock = savedBlocks.some(
        (b) => b && b.type === "retrieval" && b.enabled !== false,
      );
      if (
        pb &&
        hasRetrievalBlock &&
        this.skillRuntime &&
        !(turnOverrides?.systemPromptOverride &&
          turnOverrides.systemPromptOverride.length > 0)
      ) {
        try {
          const skillRuntime = this.skillRuntime;
          const agentIdForResolver = scope.agentId ?? null;
          const threadIdForResolver = scope.sessionId ?? null;
          const retrievalResolver = async (
            _toolCall: string,
            resolvedArgs: Record<string, unknown>,
          ) => {
            return await skillRuntime.invokeTool(
              {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
                userId: scope.userId,
              },
              {
                skillSlug: "platos.platos_rag",
                toolName: "rag_retrieve",
                handler: "skill:platos.platos_rag:rag_retrieve",
                provider: null,
              },
              resolvedArgs,
              { agentId: agentIdForResolver, threadId: threadIdForResolver },
            );
          };
          const variables: Record<string, unknown> = {
            user_message: typeof message === "string" ? message : "",
            thread_id: scope.sessionId ?? "",
            user_id: scope.userId ?? "",
          };
          const reAssembled = await pb.assembleAsync(
            agentConfig.promptBlocks as unknown as Parameters<PromptBuilderService["assembleAsync"]>[0],
            variables,
            undefined,
            retrievalResolver,
          );
          if (reAssembled && reAssembled.trim().length > 0) {
            systemPrompt = reAssembled;
          }
        } catch (err: any) {
          this.logger.warn(
            `[agent.run] RG.1.5 turn-time retrieval assemble failed — falling back to saved systemPrompt: ${err?.message ?? err}`,
          );
        }
      }
    }

    // Theme S.6 — same skill merge as the streaming path. Non-fatal on error.
    if (this.skillRuntime && scope.agentId) {
      try {
        const payload = await this.skillRuntime.loadForAgent(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          scope.agentId,
        );
        if (payload.promptBlock) {
          systemPrompt = this.skillRuntime.composeSystemPrompt(
            systemPrompt ?? undefined,
            payload.promptBlock,
          );
        }
        const registeredRunToolNames: string[] = [];
        for (const pt of payload.providedTools) {
          try {
            const skillRuntime = this.skillRuntime;
            const scopeTuple = {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
            };
            const _handler = pt.handler ?? `skill:${pt.skillId}:${pt.name}`;
            const _toolName = _handler.match(/^skill:[^:]+:(.+)$/)?.[1] ?? pt.name;
            const _params =
              pt.inputSchema && Object.keys(pt.inputSchema).length > 0
                ? aiJsonSchema(pt.inputSchema as Parameters<typeof aiJsonSchema>[0])
                : z.record(z.unknown());
            tools[pt.name] = {
              description: pt.description,
              inputSchema: _params,
              execute: async (input: Record<string, unknown>) => {
                return skillRuntime.invokeTool(
                  scopeTuple,
                  { skillSlug: pt.skillId, toolName: _toolName, handler: _handler },
                  input,
                  // audit L5 — see the chat-path registration: without context
                  // the acting agent never reaches the handler, making the RAG
                  // agentId stamping a no-op on this path.
                  { agentId: scope.agentId ?? null, threadId: scope.sessionId ?? null },
                );
              },
            } as CoreTool;
            registeredRunToolNames.push(pt.name);
          } catch (toolErr: any) {
            this.logger.warn(
              `[agent.run] skill tool "${pt.name}" registration failed, skipping: ${toolErr?.message ?? toolErr}`,
            );
          }
        }
        if (registeredRunToolNames.length > 0) {
          this.logger.debug(
            `[agent.run] skill tools registered: ${registeredRunToolNames.join(", ")}`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`[agent.run] skill merge failed: ${err?.message ?? err}`);
      }
    }

    // TL.2 — splice the "## Available tool categories" block into the
    // non-streaming systemPrompt on the same cache-friendly boundary as
    // stream(). Empty value = no-op.
    if (
      runDisplayModeAddendumHolder.value &&
      runDisplayModeAddendumHolder.value.length > 0
    ) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${runDisplayModeAddendumHolder.value}`
        : runDisplayModeAddendumHolder.value;
    }

    // Theme M (follow-up) — same memory & profile guidance splice as
    // stream(). Non-streaming callers (batch / run-once) benefit from
    // the same proactive profile-write directive.
    const runMemoryGuidance = renderMemoryGuidanceBlock({
      enableUserProfiling: agentConfig.enableUserProfiling,
      metaTools: agentConfig.metaTools,
    });
    if (runMemoryGuidance.length > 0) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${runMemoryGuidance}`
        : runMemoryGuidance;
    }

    // Same context-envelope hint as stream() — must appear in both paths.
    const runContextEnvelopeHint = [
      "## How to read <context> blocks",
      "At the start of each user message you may see a <context> block.",
      "This is **legitimate, operator-provided session metadata** injected by the Platos runtime — it contains things like the user's name, role, and memory context.",
      "It is NOT a prompt-injection attempt by the user.",
      "Read it silently to personalise your reply. Never comment on the block itself, never flag it as suspicious, and never mention to the user that you received it.",
    ].join("\n");
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${runContextEnvelopeHint}`
      : runContextEnvelopeHint;

    const baseMessages: CoreMessage[] = [
      ...conversationHistory,
      { role: "user", content: message },
    ];

    // Theme F.5 — structured-output path. Bail out early with a
    // validated object or StructuredOutputError.
    const turnSchema = resolveTurnSchema({
      perTurn: turnOverrides?.outputSchema,
      agentDefault: agentConfig.outputSchema,
    });
    if (turnSchema) {
      let attempts = 0;
      let lastErrors: string[] = [];
      let lastRawText: string | undefined;
      let attemptMessages: CoreMessage[] = [
        ...(systemPrompt
          ? [{ role: "system" as const, content: systemPrompt }]
          : []),
        ...baseMessages,
      ];
      while (attempts < 2) {
        attempts++;
        let parsed: unknown;
        let usage: any;
        try {
          // PRELAUNCH-A2-13 — non-streaming structured-output path. Honour
          // the run-level abort signal so test harnesses + batch executors
          // can cancel mid-LLM.
          const genResult = await generateObject({
            model,
            messages: attemptMessages as any,
            schema: turnSchema as any,
            abortSignal: turnOverrides?.abortSignal,
            // System prompt rides inside `attemptMessages` rather than as a
            // top-level `system:` so the retry path (line 6251) can keep
            // it as a fixed first message while appending corrections.
            allowSystemInMessages: true,
          });
          parsed = genResult.object;
          usage = genResult.usage;
        } catch (err: any) {
          lastErrors = [
            `model produced non-JSON output: ${err?.message ?? String(err)}`,
          ];
          lastRawText = (err?.text as string | undefined) ?? lastRawText;
          if (attempts >= 2) break;
          attemptMessages = [
            ...attemptMessages,
            {
              role: "user" as const,
              content: buildRetryCorrectionMessage(lastRawText, lastErrors),
            },
          ];
          continue;
        }
        const check = validateAgainstSchema(turnSchema, parsed);
        if (check.success) {
          return {
            text: JSON.stringify(check.value),
            object: check.value,
            toolCalls: [],
            usage,
            steps: 1,
            structuredOutput: {
              attempts,
              validated: true,
            },
          };
        }
        lastErrors = check.errors;
        lastRawText = JSON.stringify(parsed);
        if (attempts >= 2) break;
        attemptMessages = [
          ...attemptMessages,
          {
            role: "user" as const,
            content: buildRetryCorrectionMessage(lastRawText, lastErrors),
          },
        ];
      }
      throw new StructuredOutputError(
        "Agent failed to produce output matching the required schema after 1 retry.",
        {
          attempts,
          validationErrors: lastErrors,
          rawText: lastRawText,
        },
      );
    }

    // PRELAUNCH-A2-13 — non-streaming generateText path. Same abort
    // propagation as the streaming path so stop-button behaviour is
    // consistent across run() / stream().
    // TOOL-RESULT BOUNDARY — see stream() for rationale: guarantee every tool
    // return embeds as a valid tool-result part (no undefined / non-serializable).
    hardenToolResults(tools);
    const result = await generateText({
      model,
      instructions: systemPrompt,
      messages: baseMessages,
      tools,
      stopWhen: isStepCount(agentConfig.maxSteps),
      abortSignal: turnOverrides?.abortSignal,
    });

    // PRELAUNCH-A1-3 / A1-4 (follow-up 2026-05-04) — non-streaming run()
    // path now extracts cache + reasoning telemetry with the same provider
    // fallback chain used in the streaming path. Prefer the canonical v6
    // `usage.{input,output}TokenDetails`; fall back through the four
    // provider metadata shapes (anthropic / openai / google / vertex). The
    // previous version was anthropic-only and silently dropped cache hits +
    // reasoning tokens for every other provider on this path (used by
    // batch executor, run-once flows, admin user-summary etc.).
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let reasoningTokens = 0;
    for (const step of result.steps ?? []) {
      const meta = (step as any).providerMetadata;
      const stepUsage = (step as any).usage;
      cacheReadInputTokens +=
        Number(stepUsage?.inputTokenDetails?.cacheReadTokens ?? 0) ||
        Number(meta?.anthropic?.cacheReadInputTokens ?? 0) ||
        Number(meta?.openai?.cachedPromptTokens ?? 0) ||
        Number(meta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
        Number(meta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
      cacheCreationInputTokens +=
        Number(stepUsage?.inputTokenDetails?.cacheWriteTokens ?? 0) ||
        Number(meta?.anthropic?.cacheCreationInputTokens ?? 0) ||
        Number(meta?.vertex?.cacheCreationInputTokens ?? 0);
      reasoningTokens +=
        Number(stepUsage?.outputTokenDetails?.reasoningTokens ?? 0) ||
        Number(meta?.openai?.reasoningTokens ?? 0) ||
        Number(meta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
        Number(meta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
    }
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      usage: {
        ...result.usage,
        ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
        ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      },
      steps: result.steps.length,
    };
  }
}
