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
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { CostService } from "../monitoring/cost.service";
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
 * The extractor is idempotent-ish: the source threadId + message ids are
 * stamped on every row, so re-runs append duplicates rather than
 * mutating existing ones. The scheduled task keeps a per-thread "last run"
 * cursor in working memory so repeated runs only ingest new messages.
 */

const DEFAULT_EXTRACTION_MODEL = "anthropic:claude-haiku-4-5-20251001";
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
    @Optional() private readonly scopedEnv?: ScopedEnvService,
    @Optional() private readonly crypto?: MessageCryptoService,
    @Optional() private readonly costService?: CostService,
    @Optional() private readonly profileCache?: ProfileCacheService,
    @Optional() @Inject(REDIS_TOKEN) private readonly redis?: any,
  ) {}

  async extractFromThread(
    scope: ScopeTuple,
    input: ExtractFromThreadInput,
  ): Promise<ExtractFromThreadOutput> {
    if (!input.threadId) throw new Error("extractFromThread: `threadId` is required");

    const thread = await this.prisma.platosAgentThread.findFirst({
      where: {
        id: input.threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      select: { id: true, agentId: true, userId: true, platosEndUserId: true, updatedAt: true },
    });
    if (!thread) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "thread-not-found" };
    }
    const userId: string | null = thread.userId ?? null;
    if (!userId) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "thread-has-no-user" };
    }

    // Resolve the agent's extraction policy (O.2).
    let storedPolicy: unknown = null;
    if (thread.agentId) {
      const agent = await this.prisma.platosAgent.findFirst({
        where: {
          id: thread.agentId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { extractionPolicy: true },
      });
      storedPolicy = agent?.extractionPolicy ?? null;
    }
    const basePolicy = resolveExtractionPolicy(storedPolicy);
    const policy: ExtractionPolicy = input.policyOverride
      ? resolveExtractionPolicy({ ...basePolicy, ...input.policyOverride })
      : basePolicy;
    if (!policy.enabled) {
      return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "extraction-disabled" };
    }

    // Watermark — skip threads with no activity since the last extraction.
    // Without this, every hourly sweep re-judged the same window and wrote
    // near-duplicate memories (observed live: identical facts at 10:00,
    // 11:00, and 12:00 from one thread). Keyed on thread.updatedAt (bumps
    // on new messages); manual kicks pass `force` to bypass.
    const wmKey = `memx:wm:${input.threadId}`;
    const threadStamp = (thread as any).updatedAt ? new Date((thread as any).updatedAt).toISOString() : null;
    if (!input.force && this.redis && threadStamp) {
      try {
        const wm = await this.redis.get(wmKey);
        if (wm && wm >= threadStamp) {
          return { memoriesCreated: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, reason: "no-new-activity" };
        }
      } catch {
        // Redis hiccup — proceed without the watermark.
      }
    }
    const setWatermark = () => {
      if (this.redis && threadStamp) {
        this.redis.set(wmKey, threadStamp, "EX", 60 * 60 * 24 * 14).catch(() => undefined);
      }
    };

    // Pull the last N messages (N = max(minMessagesBeforeRun * 2, 40) up to 80
    // to give the judge enough context without runaway token cost).
    const windowSize = Math.max(Math.min(policy.minMessagesBeforeRun * 2, 80), 20);
    const messages: Array<{
      id: string;
      role: string;
      content: string | null;
      createdAt: Date;
      encKeyVersion: number | null;
    }> = await this.prisma.platosAgentMessage.findMany({
      where: {
        threadId: input.threadId,
        status: "active",
      },
      // EOBD.19 review follow-up — include encKeyVersion so the
      // transcript we feed the judge LLM is plaintext, not ciphertext.
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
        encKeyVersion: true,
      },
      orderBy: { createdAt: "desc" },
      take: windowSize,
    });
    if (messages.length < policy.minMessagesBeforeRun) {
      // Mark covered — new messages bump thread.updatedAt past the watermark.
      setWatermark();
      return {
        memoriesCreated: 0,
        entitiesCreated: 0,
        relationshipsCreated: 0,
        skipped: 0,
        reason: "insufficient-messages",
      };
    }

    const ordered = [...messages].reverse();
    const transcript = ordered
      .filter((m) => m.content)
      .map((m) => {
        const plain = this.crypto
          ? this.crypto.decryptIfNeeded(m.content, m.encKeyVersion ?? null)
          : m.content;
        return `${m.role.toUpperCase()}: ${plain}`;
      })
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
      try {
        const ent = await this.graph.upsertEntity(scope, {
          userId,
          entityKey: key,
          entityType: e.type || "other",
          label: e.name || key,
          aliases: Array.isArray(e.aliases) ? e.aliases : [],
        });
        if (!entityKeyToId.has(key)) {
          entityKeyToId.set(key, ent.id);
          entitiesCreated += 1;
        }
      } catch (err: any) {
        this.logger.warn(`entity upsert failed for "${key}": ${err?.message || err}`);
      }
    }

    // 2) Write memories. Validator-pass, kind-filter, threshold-filter, cap at maxPerSession.
    let memoriesCreated = 0;
    let skipped = 0;
    const sourceMessageIds = ordered.map((m) => m.id);
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

      try {
        await this.memoryService.add(scope, {
          userId,
          agentId: thread.agentId ?? null,
          platosEndUserId: (thread as any).platosEndUserId ?? null,
          kind: checked.kind,
          content: checked.content,
          metadata,
          source: "extracted",
          sourceThreadId: input.threadId,
          sourceMessageIds,
          extractorVersion: EXTRACTOR_VERSION,
        });
        memoriesCreated += 1;
      } catch (err: any) {
        skipped += 1;
        this.logger.warn(`memory add failed: ${err?.message || err}`);
      }
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
      try {
        await this.graph.createRelationship(scope, {
          userId,
          fromEntityId: fromId,
          toEntityId: toId,
          relationshipType: rel.type,
          weight: typeof rel.weight === "number" ? rel.weight : null,
        });
        relationshipsCreated += 1;
      } catch (err: any) {
        this.logger.warn(
          `relationship create failed (${fromKey} -${rel.type}-> ${toKey}): ${err?.message || err}`,
        );
      }
    }

    // Transcript fully evaluated — stamp the watermark so unchanged threads
    // are skipped by subsequent sweeps.
    setWatermark();

    // PROFILE SYNTHESIS — roll the user's atoms into the maintained narrative
    // profile (throttled per user+agent; best-effort, never fails extraction).
    // Awaited so it finishes within this async sweep, catch-guarded so a
    // synthesis failure can't undo the extraction that already committed.
    if (thread.userId) {
      await this.synthesizeProfile(scope, thread.userId, thread.agentId ?? "default").catch(
        () => undefined,
      );
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
      const prior = await this.prisma.platosMemory.findFirst({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId,
          agentId,
          kind: "profile",
          metadata: { path: ["profileKey"], equals: "_synthesized" },
        },
        select: { id: true, metadata: true },
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
      const envVar = apiKeyEnvVarFor(modelString);
      const apiKey = envVar && this.scopedEnv ? await this.scopedEnv.get(scope, envVar) : undefined;
      const resolved = resolveJudgeModel(modelString, apiKey);
      if (!resolved) return { ok: false, reason: "judge-unavailable" };

      const { text } = await generateText({
        model: resolved,
        system:
          'You maintain a living profile of a user for an AI assistant. From the durable facts below, write a concise profile: who they are, their role and context, how they communicate and work, their key preferences, and the important people, projects, and organisations in their world. 2-4 short paragraphs, present tense, second person ("You are…"). State ONLY what the facts support — never invent. No preamble, no headings.',
        prompt: transcript,
      });
      const narrative = (text || "").trim();
      if (!narrative) return { ok: false, reason: "empty" };

      // Supersede the prior synthesized row, then write the fresh one.
      if (prior) await this.memoryService.delete(scope, prior.id).catch(() => undefined);
      await this.memoryService.add(scope, {
        userId,
        agentId,
        kind: "profile",
        content: narrative,
        metadata: {
          profileKey: "_synthesized",
          synthesizedAt: new Date().toISOString(),
          atomCount: atoms.length,
        },
        source: "manual",
        visibility: "private",
        agentVisible: true,
      });
      await this.profileCache?.invalidate(scope, agentId, userId).catch(() => undefined);
      this.logger.log(
        `[profile-synth] ${scope.organizationId}/${userId}/${agentId}: ${atoms.length} atoms -> ${narrative.length} chars`,
      );
      return { ok: true };
    } catch (err: any) {
      this.logger.warn(`[profile-synth] failed for ${userId}/${agentId}: ${err?.message ?? err}`);
      return { ok: false, reason: err?.message || "error" };
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

    try {
      // PRELAUNCH-A2-9 — propagate abort signal.
      const result = await generateText({
        model: resolved,
        system,
        messages: [{ role: "user" as const, content: user }],
        abortSignal,
      });
      // EOBD.33 — record extraction cost against the scope so dashboards
      // don't undercount shadow LLM spend. Uses ai SDK's usage object
      // (promptTokens + completionTokens). Cost-per-token comes from
      // LiteLLM catalog (maintained by the litellm-cost-refresh task).
      // PRELAUNCH-A1-7 (follow-up) — pass full result so cache + reasoning
      // attribution lands on the dashboard slices.
      this.recordExtractionCost(scope, modelString, result).catch(() => undefined);
      const parsed = parseExtractorJson(result.text);
      return parsed;
    } catch (err: any) {
      this.logger.warn(`extractor judge call failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * EOBD.33 — compute + persist extraction cost via CostService.
   * Best-effort: the CostService calculates $-per-token from the
   * LiteLLM catalog (or a hard-coded fallback). Failure never breaks
   * extraction.
   */
  private async recordExtractionCost(
    scope: ScopeTuple,
    modelString: string,
    result: any,
  ): Promise<void> {
    if (!this.costService || !result) return;
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
      const costCents = await this.costService.calculateCost(
        modelString,
        inputTokens,
        outputTokens,
      );
      if (costCents > 0) {
        await this.costService.recordAuxiliaryCost({
          scope,
          kind: "extraction",
          model: modelString,
          costCents,
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cacheRead > 0 ? cacheRead : undefined,
          cacheCreationInputTokens: cacheCreation > 0 ? cacheCreation : undefined,
          reasoningTokens: reasoning > 0 ? reasoning : undefined,
        });
      }
    } catch {
      // Fire-and-forget: CostService hiccup should never fail extraction.
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
