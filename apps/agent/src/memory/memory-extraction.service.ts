import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { generateText } from "ai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { MemoryService, type ScopeTuple, type MemoryKind } from "./memory.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";
import { validateMemoryPayload } from "./memory-kind.validator";
import { CostService } from "../monitoring/cost.service";
import { preflightModelPricing } from "../monitoring/model-pricing-preflight";
import { ProviderRuntimeError } from "../providers/provider-runtime.error";
import { ProfileCacheService } from "./profile-cache.service";
import { env } from "../shared/env";

/**
 * Theme O.1 / O.3 — conversation → memory extractor.
 *
 * Pulls the last N messages of a thread, hands them to a judge LLM with a
 * strict JSON envelope, validates each candidate against the kind schema,
 * drops anything under the confidence threshold, then writes surviving
 * rows via `MemoryService.add` (which re-validates + embeds).
 *
 * Entity auto-detection (O.3):
 *   The same judge response carries `entities[]` and `relationships[]`.
 *   Each entity is upserted via `KnowledgeGraphService.upsertEntity`; each
 *   relationship is resolved to entity ids then created via
 *   `createRelationship`. When memories reference entity keys, the set
 *   is recorded on `memory.metadata.entities` so the trace back to the
 *   graph is O(1).
 *
 * Extraction provenance is stamped with clean Thread/Turn IDs. A database
 * uniqueness constraint plus content hash is authoritative for dedupe; the
 * Redis watermark is only a scheduler optimization.
 */

export const DEFAULT_EXTRACTION_MODEL = "anthropic:claude-haiku-4-5-20251001";
const EXTRACTOR_VERSION = "v1";

export interface ExtractionPolicy {
  enabled: boolean;
  kinds: MemoryKind[];
  confidenceThreshold: number;
  maxPerSession: number;
  minMessagesBeforeRun: number;
}

export const DEFAULT_EXTRACTION_POLICY: ExtractionPolicy = {
  enabled: true,
  kinds: ["fact", "preference", "event", "relationship"],
  confidenceThreshold: 0.6,
  maxPerSession: 10,
  minMessagesBeforeRun: 6,
};

export function resolveExtractionPolicy(raw: unknown): ExtractionPolicy {
  if (!raw || typeof raw !== "object") return DEFAULT_EXTRACTION_POLICY;
  const r = raw as Partial<ExtractionPolicy> & Record<string, unknown>;
  const kinds: MemoryKind[] = Array.isArray(r.kinds)
    ? (r.kinds as string[]).filter((k): k is MemoryKind =>
        k === "fact" || k === "preference" || k === "event" || k === "relationship",
      )
    : DEFAULT_EXTRACTION_POLICY.kinds;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_EXTRACTION_POLICY.enabled,
    kinds: kinds.length > 0 ? kinds : DEFAULT_EXTRACTION_POLICY.kinds,
    confidenceThreshold: clampNum(
      Number(r.confidenceThreshold ?? DEFAULT_EXTRACTION_POLICY.confidenceThreshold),
      0,
      1,
      DEFAULT_EXTRACTION_POLICY.confidenceThreshold,
    ),
    maxPerSession: clampInt(
      Number(r.maxPerSession ?? DEFAULT_EXTRACTION_POLICY.maxPerSession),
      1,
      100,
      DEFAULT_EXTRACTION_POLICY.maxPerSession,
    ),
    minMessagesBeforeRun: clampInt(
      Number(r.minMessagesBeforeRun ?? DEFAULT_EXTRACTION_POLICY.minMessagesBeforeRun),
      1,
      200,
      DEFAULT_EXTRACTION_POLICY.minMessagesBeforeRun,
    ),
  };
}

export interface ExtractFromThreadInput {
  threadId: string;
  /** Optional per-call policy override — mostly for the manual endpoint. */
  policyOverride?: Partial<ExtractionPolicy>;
  /** Bypass the no-new-activity watermark (manual extract-now kicks). */
  force?: boolean;
}

export interface ExtractFromThreadOutput {
  memoriesCreated: number;
  entitiesCreated: number;
  relationshipsCreated: number;
  skipped: number;
  reason?: string;
}

interface CandidateMemory {
  kind: string;
  content: string;
  metadata?: unknown;
  confidence?: number;
  entities?: string[];
}

interface CandidateEntity {
  entityKey?: string;
  name?: string;
  type?: string;
  aliases?: string[];
}

interface CandidateRelationship {
  from: string;
  to: string;
  type: string;
  weight?: number;
}

@Injectable()
export class MemoryExtractionService {
  private readonly logger = new Logger(MemoryExtractionService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly memoryService: MemoryService,
    private readonly graph: KnowledgeGraphService,
    private readonly costService: CostService,
    @Optional() private readonly scopedEnv?: ScopedEnvService,
    @Optional() private readonly profileCache?: ProfileCacheService,
    @Optional() @Inject(REDIS_TOKEN) private readonly redis?: any,
  ) {}

  async extractFromThread(
    scope: ScopeTuple,
    input: ExtractFromThreadInput,
  ): Promise<ExtractFromThreadOutput> {
    if (!input.threadId) throw new Error("extractFromThread: `threadId` is required");

    const thread = await this.prisma.thread.findFirst({
      where: {
        id: input.threadId,
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      select: {
        id: true,
        agentId: true,
        endUserId: true,
        endUser: {
          select: {
            identities: {
              where: { disabledAt: null },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { subject: true },
            },
          },
        },
      },
    });
    if (!thread) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "thread-not-found" };
    }
    const userId: string = thread.endUser.identities[0]?.subject ?? thread.endUserId;
    if (!userId) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "thread-has-no-user" };
    }

    // Resolve the agent's extraction policy (O.2).
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        environmentId: scope.environmentId,
        agentId: thread.agentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      select: { activeAgentVersion: { select: { memoryConfig: true } } },
    });
    if (!binding) throw new Error("Memory extraction AgentBinding not found or access denied");
    const memoryConfig = binding.activeAgentVersion.memoryConfig;
    const runtime = memoryConfig && typeof memoryConfig === "object" && !Array.isArray(memoryConfig)
      ? (memoryConfig as Record<string, unknown>).__runtime
      : null;
    const storedPolicy = runtime && typeof runtime === "object" && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>).extractionPolicy
      : null;
    const basePolicy = resolveExtractionPolicy(storedPolicy);
    const policy: ExtractionPolicy = input.policyOverride
      ? resolveExtractionPolicy({ ...basePolicy, ...input.policyOverride })
      : basePolicy;
    if (!policy.enabled) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "extraction-disabled" };
    }

    // Redis stores only a scheduler optimization keyed to the latest durable
    // Turn. Correctness does not depend on it: the clean Memory unique key is
    // the authoritative extraction-dedupe boundary.
    // Pull the last N messages (N = max(minMessagesBeforeRun * 2, 40) up to 80
    // to give the judge enough context without runaway token cost).
    const windowSize = Math.max(Math.min(policy.minMessagesBeforeRun * 2, 80), 20);
    const turns: Array<{
      id: string;
      sequence: number;
      inputText: string | null;
      outputText: string | null;
    }> = await this.prisma.turn.findMany({
      where: {
        threadId: input.threadId,
        status: "SUCCEEDED",
      },
      select: {
        id: true,
        sequence: true,
        inputText: true,
        outputText: true,
      },
      orderBy: { sequence: "desc" },
      take: Math.ceil(windowSize / 2),
    });
    const latestTurnId = turns[0]?.id ?? null;
    const wmKey = `memx:wm:${input.threadId}`;
    if (!input.force && this.redis && latestTurnId) {
      try {
        if (await this.redis.get(wmKey) === latestTurnId) {
          return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "no-new-activity" };
        }
      } catch (error: any) {
        this.logger.warn(`Memory extraction watermark read failed: ${error?.message ?? error}`);
      }
    }
    const messageCount = turns.reduce(
      (count, turn) => count + (turn.inputText ? 1 : 0) + (turn.outputText ? 1 : 0),
      0,
    );
    if (messageCount < policy.minMessagesBeforeRun) {
      return {
        memoriesCreated: 0,
        entitiesCreated: 0,
        relationshipsCreated: 0,
        skipped: 0,
        reason: "insufficient-messages",
      };
    }

    const ordered = [...turns].reverse();
    const transcript = ordered
      .flatMap((turn) => [
        ...(turn.inputText ? [`USER: ${turn.inputText}`] : []),
        ...(turn.outputText ? [`ASSISTANT: ${turn.outputText}`] : []),
      ])
      .join("\n\n");

    // Run the judge.
    const judge = await this.runJudge(scope, transcript, policy);
    if (!judge) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "judge-unavailable" };
    }

    // 1) Materialise entities first so memory.metadata.entities can reference them.
    let entitiesCreated = 0;
    const entityKeyToId = new Map<string, string>();
    for (const e of judge.entities ?? []) {
      const key = stableSlug(e.entityKey || e.name || "");
      if (!key) continue;
      const ent = await this.graph.upsertEntity(scope, {
        userId,
        agentId: thread.agentId,
        entityKey: key,
        entityType: e.type || "other",
        label: e.name || key,
        aliases: Array.isArray(e.aliases) ? e.aliases : [],
      });
      if (!entityKeyToId.has(key)) {
        entityKeyToId.set(key, ent.id);
        entitiesCreated += 1;
      }
    }

    // 2) Write memories. Validator-pass, kind-filter, threshold-filter, cap at maxPerSession.
    let memoriesCreated = 0;
    let skipped = 0;
    const sourceTurnIds = ordered.map((turn) => turn.id);
    const candidatesSorted = (judge.memories ?? [])
      .slice()
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    for (const cand of candidatesSorted) {
      if (memoriesCreated >= policy.maxPerSession) break;
      const confidence = typeof cand.confidence === "number" ? cand.confidence : 0;
      if (confidence < policy.confidenceThreshold) {
        skipped += 1;
        continue;
      }
      const kind = (cand.kind || "fact").toLowerCase();
      if (!policy.kinds.includes(kind as MemoryKind)) {
        skipped += 1;
        continue;
      }
      const checked = validateMemoryPayload({
        kind,
        content: cand.content,
        metadata: cand.metadata,
      });
      if (!checked.ok) {
        skipped += 1;
        this.logger.warn(`[memory-extraction] validator rejected candidate`, { errors: checked.errors });
        continue;
      }

      // Stamp entity ids on memory.metadata for traceability.
      const entityKeys: string[] = [];
      if (Array.isArray(cand.entities)) {
        for (const raw of cand.entities) {
          const slug = stableSlug(raw);
          if (slug) entityKeys.push(slug);
        }
      }
      const metadata = {
        ...(checked.metadata && typeof checked.metadata === "object"
          ? (checked.metadata as Record<string, unknown>)
          : {}),
        ...(entityKeys.length > 0 ? { entities: entityKeys } : {}),
      };

      await this.memoryService.add(scope, {
        userId,
        agentId: thread.agentId,
        kind: checked.kind,
        content: checked.content,
        metadata,
        source: "extracted",
        sourceThreadId: input.threadId,
        sourceTurnIds,
        extractorVersion: EXTRACTOR_VERSION,
        confidence,
      });
      memoriesCreated += 1;
    }

    // 3) Relationships — only create when both endpoints exist in entityKeyToId.
    let relationshipsCreated = 0;
    for (const rel of judge.relationships ?? []) {
      const fromKey = stableSlug(rel.from);
      const toKey = stableSlug(rel.to);
      if (!fromKey || !toKey || !rel.type) continue;
      const fromId = entityKeyToId.get(fromKey);
      const toId = entityKeyToId.get(toKey);
      if (!fromId || !toId) continue;
      await this.graph.createRelationship(scope, {
        userId,
        agentId: thread.agentId,
        fromEntityId: fromId,
        toEntityId: toId,
        relationshipType: rel.type,
        weight: typeof rel.weight === "number" ? rel.weight : null,
      });
      relationshipsCreated += 1;
    }

    // Transcript fully evaluated — stamp the watermark so unchanged threads
    // are skipped by subsequent sweeps.
    if (this.redis && latestTurnId) {
      this.redis.set(wmKey, latestTurnId, "EX", 60 * 60 * 24 * 14).catch((error: any) =>
        this.logger.warn(`Memory extraction watermark write failed: ${error?.message ?? error}`),
      );
    }

    // PROFILE SYNTHESIS — roll the user's atoms into the maintained narrative
    // profile (throttled per user+agent; best-effort, never fails extraction).
    // Awaited so it finishes within this async sweep, catch-guarded so a
    // synthesis failure can't undo the extraction that already committed.
    const synthesis = await this.synthesizeProfile(scope, userId, thread.agentId);
    if (!synthesis.ok && synthesis.reason && !["throttled", "too-few-atoms"].includes(synthesis.reason)) {
      this.logger.error(`Profile synthesis failed for thread ${thread.id}: ${synthesis.reason}`);
    }

    return {
      memoriesCreated,
      entitiesCreated,
      relationshipsCreated,
      skipped,
    };
  }

  /**
   * PROFILE SYNTHESIS — the consolidation step that makes the profile
   * self-maintain.
   *
   * The extraction judge only ever emitted fact/preference/event/relationship
   * atoms; the user PROFILE (kind="profile") was written ONLY by explicit
   * `update_user_profile` calls, so it never kept up on its own. This rolls the
   * user's accumulated atoms (for this agent) into a concise narrative and
   * stores it as a `kind="profile"` row keyed `_synthesized` — which the
   * turn-start `__user_profile` injector already reads. Throttled per
   * (user, agent); best-effort (never fails extraction). Agent-scoped, matching
   * the memory model (a coach's profile of a user ≠ an SDR's).
   */
  async synthesizeProfile(
    scope: ScopeTuple,
    userId: string,
    agentId: string,
    opts?: { force?: boolean; throttleMs?: number },
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!userId) return { ok: false, reason: "no-user" };
    const throttleMs = opts?.throttleMs ?? 60 * 60 * 1000; // once/hour by default
    try {
      const profiles = await this.memoryService.list(scope, {
        userId,
        agentId,
        kind: "profile",
        limit: 100,
        includeArchived: false,
      });
      const prior = profiles.find((memory) => {
        const metadata = memory.metadata;
        return metadata && typeof metadata === "object" && !Array.isArray(metadata)
          && (metadata as Record<string, unknown>).profileKey === "_synthesized";
      });
      if (!opts?.force && prior) {
        const synAt = (prior.metadata as { synthesizedAt?: string } | null)?.synthesizedAt;
        if (synAt && Date.now() - new Date(synAt).getTime() < throttleMs) {
          return { ok: false, reason: "throttled" };
        }
      }

      // The user's durable atoms for THIS agent (decrypted via list()).
      const all = await this.memoryService.list(scope, { userId, agentId, limit: 80 });
      const atoms = all.filter(
        (m) => ["fact", "preference", "event", "relationship"].includes(m.kind) && m.source !== "rag",
      );
      if (atoms.length < 4) return { ok: false, reason: "too-few-atoms" };

      const transcript = atoms.map((a) => `(${a.kind}) ${a.content}`).join("\n");
      const modelString = env.PLATOS_MEMORY_EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL;
      const price = await preflightModelPricing(this.costService, modelString);
      const envVar = apiKeyEnvVarFor(modelString);
      const apiKey = envVar && this.scopedEnv ? await this.scopedEnv.get(scope, envVar) : undefined;
      const resolved = resolveJudgeModel(modelString, apiKey);
      if (!resolved) return { ok: false, reason: "judge-unavailable" };

      const generated = await generateText({
        model: resolved,
        system:
          'You maintain a living profile of a user for an AI assistant. From the durable facts below, write a concise profile: who they are, their role and context, how they communicate and work, their key preferences, and the important people, projects, and organisations in their world. 2-4 short paragraphs, present tense, second person ("You are…"). State ONLY what the facts support — never invent. No preamble, no headings.',
        prompt: transcript,
      });
      await this.recordExtractionCost(scope, modelString, generated, price);
      const { text } = generated;
      const narrative = (text || "").trim();
      if (!narrative) return { ok: false, reason: "empty" };

      const metadata = {
        profileKey: "_synthesized",
        synthesizedAt: new Date().toISOString(),
        atomCount: atoms.length,
      };
      if (prior) {
        const updated = await this.memoryService.update(scope, prior.id, {
          kind: "profile",
          content: narrative,
          metadata,
          visibility: "private",
          agentVisible: true,
        }, userId);
        if (!updated) throw new Error("Synthesized profile disappeared during atomic update");
      } else {
        await this.memoryService.add(scope, {
          userId,
          agentId,
          kind: "profile",
          content: narrative,
          metadata,
          source: "manual",
          visibility: "private",
          agentVisible: true,
        });
      }
      await this.profileCache?.invalidate(scope, agentId, userId);
      this.logger.log(
        `[profile-synth] ${scope.organizationId}/${userId}/${agentId}: ${atoms.length} atoms -> ${narrative.length} chars`,
      );
      return { ok: true };
    } catch (err: any) {
      this.logger.error(`[profile-synth] failed for ${userId}/${agentId}: ${err?.message ?? err}`);
      return {
        ok: false,
        reason: err instanceof ProviderRuntimeError ? err.code : err?.message || "error",
      };
    }
  }

  /** Run the judge LLM and parse its JSON response. Returns null when the
   *  judge is unavailable (no API key) or parsing fails completely. */
  private async runJudge(
    scope: ScopeTuple,
    transcript: string,
    policy: ExtractionPolicy,
    /** PRELAUNCH-A2-9 — abort signal for the extraction-judge LLM call. */
    abortSignal?: AbortSignal,
  ): Promise<{
    memories: CandidateMemory[];
    entities: CandidateEntity[];
    relationships: CandidateRelationship[];
  } | null> {
    const modelString = env.PLATOS_MEMORY_EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL;
    const price = await preflightModelPricing(this.costService, modelString);
    const envVar = apiKeyEnvVarFor(modelString);
    const apiKey = envVar && this.scopedEnv ? await this.scopedEnv.get(scope, envVar) : undefined;
    const resolved = resolveJudgeModel(modelString, apiKey);
    if (!resolved) return null;

    const system =
      "You extract durable user memories from conversations. Respond ONLY with a JSON object of the shape:\n" +
      '{\n' +
      '  "memories": [{ "kind": "fact|preference|event|relationship", "content": "string", "metadata": { ... }, "confidence": 0..1, "entities": ["slug", ...] }],\n' +
      '  "entities": [{ "entityKey": "slug", "name": "Display", "type": "person|org|project|concept|location|other", "aliases": ["..."] }],\n' +
      '  "relationships": [{ "from": "slug", "to": "slug", "type": "works_at|owns|prefers|mentions|...", "weight": 0..1 }]\n' +
      "}\n" +
      "Rules:\n" +
      "- Only emit content the user genuinely stated about themselves or others.\n" +
      "- Never invent facts. Skip when unsure.\n" +
      "- Use stable lowercase-slug entityKeys (e.g. \"user_123\", \"acme_corp\").\n" +
      "- relationship-kind memories MUST carry metadata { from, to, type }.\n" +
      "- event metadata may include { at (ISO), location, participants }.\n" +
      "- confidence 0..1 reflects how durable/reliable the memory is.";
    const user =
      `Allowed kinds: ${policy.kinds.join(", ")}. ` +
      `Confidence threshold (for your reference): ${policy.confidenceThreshold}. ` +
      `Max memories: ${policy.maxPerSession}.\n\n` +
      `Conversation:\n\n${transcript}`;

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      // PRELAUNCH-A2-9 — propagate abort signal.
      result = await generateText({
        model: resolved,
        system,
        messages: [{ role: "user" as const, content: user }],
        abortSignal,
      });
    } catch (err: any) {
      this.logger.warn(`extractor judge call failed: ${err?.message || err}`);
      return null;
    }
    // Price attribution is outside the provider-error fallback. Once spend was
    // incurred, a rollup failure must surface rather than becoming an
    // indistinguishable "judge unavailable" result.
    await this.recordExtractionCost(scope, modelString, result, price);
    return parseExtractorJson(result.text);
  }

  /**
   * EOBD.33 — compute + persist extraction cost via CostService.
   * Uses the exact card resolved before invocation and awaits attribution.
   */
  private async recordExtractionCost(
    scope: ScopeTuple,
    modelString: string,
    result: any,
    price: Awaited<ReturnType<typeof preflightModelPricing>>,
  ): Promise<void> {
    if (!result) return;
    const usage = result.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: Record<string, unknown> | null;
          outputTokenDetails?: Record<string, unknown> | null;
        }
      | undefined;
    if (!usage) return;
    // AI SDK v6 — usage shape: `inputTokens` / `outputTokens` (was
    // `promptTokens` / `completionTokens` in v4).
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    if (inputTokens <= 0 && outputTokens <= 0) return;
    // PRELAUNCH-A1-7 (follow-up) — extract cache + reasoning telemetry
    // with provider fallbacks so the extraction LLM's cache_read /
    // reasoning spend is attributed on the governance dashboard.
    const meta = result.providerMetadata as Record<string, any> | undefined;
    const cacheRead =
      Number((usage.inputTokenDetails as any)?.cacheReadTokens ?? 0) ||
      Number(meta?.anthropic?.cacheReadInputTokens ?? 0) ||
      Number(meta?.openai?.cachedPromptTokens ?? 0) ||
      Number(meta?.google?.usageMetadata?.cachedContentTokenCount ?? 0) ||
      Number(meta?.vertex?.usageMetadata?.cachedContentTokenCount ?? 0);
    const cacheCreation =
      Number((usage.inputTokenDetails as any)?.cacheWriteTokens ?? 0) ||
      Number(meta?.anthropic?.cacheCreationInputTokens ?? 0) ||
      Number(meta?.vertex?.cacheCreationInputTokens ?? 0);
    const reasoning =
      Number((usage.outputTokenDetails as any)?.reasoningTokens ?? 0) ||
      Number(meta?.openai?.reasoningTokens ?? 0) ||
      Number(meta?.google?.usageMetadata?.thoughtsTokenCount ?? 0) ||
      Number(meta?.vertex?.usageMetadata?.thoughtsTokenCount ?? 0);
    try {
      const pricedUsage = this.costService.priceUsageFromSnapshot(
        modelString,
        price,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead,
      );
      if (pricedUsage.costCents > 0) {
        await this.costService.recordAuxiliaryCost({
          scope,
          kind: "extraction",
          model: modelString,
          costCents: pricedUsage.costCents,
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cacheRead > 0 ? cacheRead : undefined,
          cacheCreationInputTokens: cacheCreation > 0 ? cacheCreation : undefined,
          reasoningTokens: reasoning > 0 ? reasoning : undefined,
        });
      }
    } catch (error: any) {
      this.logger.warn(`[memory-extraction] auxiliary cost recording failed: ${error?.message ?? error}`);
      throw error;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function resolveJudgeModel(modelString: string, apiKey?: string) {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  const model = colonIdx > 0 ? modelString.slice(colonIdx + 1) : modelString;
  try {
    switch (provider) {
      case "anthropic":
        return apiKey ? createAnthropic({ apiKey })(model) : anthropic(model);
      case "openai":
        return apiKey ? createOpenAI({ apiKey })(model) : openai(model);
      case "google":
        return apiKey ? createGoogleGenerativeAI({ apiKey })(model) : google(model);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function apiKeyEnvVarFor(modelString: string): string | undefined {
  const colonIdx = modelString.indexOf(":");
  const provider = colonIdx > 0 ? modelString.slice(0, colonIdx) : "anthropic";
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    default:
      return undefined;
  }
}

function parseExtractorJson(raw: string): {
  memories: CandidateMemory[];
  entities: CandidateEntity[];
  relationships: CandidateRelationship[];
} {
  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1]);
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj?.[0]) candidates.push(obj[0]);
  candidates.push(raw);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") {
        return {
          memories: Array.isArray((parsed as any).memories) ? (parsed as any).memories : [],
          entities: Array.isArray((parsed as any).entities) ? (parsed as any).entities : [],
          relationships: Array.isArray((parsed as any).relationships)
            ? (parsed as any).relationships
            : [],
        };
      }
    } catch {
      // try next candidate
    }
  }
  return { memories: [], entities: [], relationships: [] };
}

/**
 * Theme O.3 — deterministic slug for entity keys. Lower-cased, alphanumeric,
 * dash-separated. Used both to generate a key when the extractor didn't
 * supply one and to look up relationship endpoints by name.
 */
export function stableSlug(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  return Math.min(Math.max(n, min), max);
}
function clampNum(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, min), max);
}
