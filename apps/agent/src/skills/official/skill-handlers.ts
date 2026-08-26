import { Injectable, Logger, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Sandbox } from "@e2b/code-interpreter";
import { ScopedEnvService } from "../../providers/scoped-env.service";
import type { ScopeTuple } from "../skill-registry.service";
import {
  validatePublicUrl,
  describeUrlValidationError,
  fetchWithValidatedRedirects,
} from "../../shared/url-validator";
import { MemoryService, RAG_MEMORY_SOURCE } from "../../memory/memory.service";
import {
  environmentScopeWhere,
  resolveEndUser,
} from "../../memory/memory-scope";
import { VercelSandboxService } from "../vercel-sandbox.service";
import { configureExternalTriggerSdk } from "../../shared/external-trigger-config";

/**
 * Theme S.7–S.10 — Runtime handlers for the 4 official skills.
 *
 * These are intentionally minimal MVP implementations:
 *   - `platos.web_search` : Tavily HTTP API (required_env: TAVILY_API_KEY)
 *   - `platos.code_execution` : E2B API (required_env: E2B_API_KEY)
 *   - `platos.file_operations` : MinIO via @aws-sdk/client-s3 (already a dep)
 *   - `platos.image_generation` : Black Forest Labs Flux (required_env: BFL_API_KEY)
 *
 * Each handler is shaped to accept the validated `input` object from the skill
 * manifest's inputSchema and returns a plain JSON result (the runtime wraps it
 * for the LLM). All env-var resolution goes through ScopedEnvService — the
 * secrets never live in memory.
 *
 * Invariant: env-var presence is re-checked here (defense-in-depth even though
 * SkillRegistry checks at enable-time; env vars can be removed mid-conversation).
 */
@Injectable()
export class OfficialSkillHandlers {
  private readonly logger = new Logger(OfficialSkillHandlers.name);

  constructor(
    private readonly scopedEnv: ScopedEnvService,
    /** RG.1 — MemoryService is wired in SkillsModule (imports MemoryModule) so
     *  the `platos.platos_rag` skill can upsert + semantic-search chunk rows
     *  scoped to (org, project, env, userId). Optional so unit tests that
     *  exercise the handler in isolation still boot. */
    @Optional() private readonly memoryService?: MemoryService,
    /** RG.1 — ModuleRef is used to resolve AttachmentsService lazily. Direct
     *  injection would introduce a DI cycle (AgentRuntimeModule imports
     *  SkillsModule). The `_rag_ingest_document_` path only needs it when
     *  an `attachmentId:*` source is passed. */
    @Optional() private readonly moduleRef?: ModuleRef,
    /** CE.3 — Vercel Sandbox backend for run_shell, selected via
     *  PLATOS_SANDBOX_PROVIDER=vercel. Optional so the E2B-only default (and
     *  isolated unit tests) still boot when the service isn't provided. */
    @Optional() private readonly vercelSandbox?: VercelSandboxService,
  ) {}

  /** Route a skill tool call to its handler. Handler string format:
   *   "skill:<skillId>:<toolName>"  e.g. "skill:platos.web_search:web_search"
   */
  async dispatch(
    scope: ScopeTuple,
    handler: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const match = handler.match(/^skill:([^:]+):(.+)$/);
    if (!match) {
      throw new Error(`Invalid skill handler reference: ${handler}`);
    }
    const [, skillId, toolName] = match;

    switch (skillId) {
      case "platos.web_search":
        if (toolName === "web_search") return this.webSearch(scope, input);
        if (toolName === "fetch_url") return this.fetchUrl(scope, input);
        break;
      case "platos.code_execution":
        if (toolName === "run_python") return this.runCode(scope, "python", input);
        if (toolName === "run_node") return this.runCode(scope, "node", input);
        if (toolName === "run_shell") return this.runShell(scope, input);
        if (toolName === "install_package") return this.installPackage(scope, input);
        if (toolName === "upload_to_sandbox") return this.uploadToSandbox(scope, input);
        break;
      case "platos.file_operations":
        if (toolName === "read_file") return this.readFile(scope, input);
        if (toolName === "write_file") return this.writeFile(scope, input);
        if (toolName === "list_dir") return this.listDir(scope, input);
        break;
      case "platos.image_generation":
        if (toolName === "generate_image") return this.generateImage(scope, input);
        break;
      case "platos.parallel_web":
        if (toolName === "parallel_search") return this.parallelSearch(scope, input);
        if (toolName === "parallel_extract") return this.parallelExtract(scope, input);
        if (toolName === "parallel_deep_research")
          return this.parallelDeepResearch(scope, input);
        if (toolName === "parallel_deep_research_result")
          return this.parallelDeepResearchResult(scope, input);
        if (toolName === "parallel_findall") return this.parallelFindall(scope, input);
        if (toolName === "parallel_monitor_create")
          return this.parallelMonitorCreate(scope, input);
        break;
      case "platos.csv_ops":
        if (toolName === "csv_list_sheets") return this.csvListSheets(scope, input);
        if (toolName === "csv_read_sheet") return this.csvReadSheet(scope, input);
        if (toolName === "csv_read_line") return this.csvReadLine(scope, input);
        if (toolName === "csv_write_cell") return this.csvWriteCell(scope, input);
        break;
      case "platos.platos_rag":
        if (toolName === "rag_ingest_document") return this.ragIngestDocument(scope, input);
        if (toolName === "rag_retrieve") return this.ragRetrieve(scope, input);
        if (toolName === "rag_delete_source") return this.ragDeleteSource(scope, input);
        if (toolName === "rag_list_sources") return this.ragListSources(scope, input);
        if (toolName === "rag_reindex") return this.ragReindex(scope, input);
        break;
      case "platos.email_send":
        if (toolName === "send_email") return this.sendEmail(scope, input);
        break;
    }
    throw new Error(`Unknown skill handler: ${handler}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.email_send — Resend transactional email.
  // Resolves RESEND_API_KEY (required) + RESEND_FROM_EMAIL (optional default
  // sender) via ScopedEnvService so per-scope keys override the container
  // env. Failure modes (unverified sender, malformed payload, Resend
  // rate-limit) bubble up as structured `{ ok: false, error }` so the LLM
  // can surface the reason to the user instead of causing retry loops.
  // ──────────────────────────────────────────────────────────────────────────

  private async sendEmail(scope: ScopeTuple, input: Record<string, unknown>) {
    const apiKey = await this.scopedEnv.get(scope, "RESEND_API_KEY");
    if (!apiKey) {
      throw new Error(
        "send_email: RESEND_API_KEY is not set in this scope. Add it via Settings → " +
          "Environment Variables, then enable the Email Send skill on this agent.",
      );
    }

    const subject = String(input.subject ?? "").trim();
    if (!subject) throw new Error("send_email: subject is required");

    const html = typeof input.html === "string" ? input.html : undefined;
    const text = typeof input.text === "string" ? input.text : undefined;
    if (!html && !text) {
      throw new Error("send_email: at least one of `html` or `text` is required");
    }

    const fromOverride = typeof input.from === "string" ? input.from : undefined;
    const fromDefault = (await this.scopedEnv.get(scope, "RESEND_FROM_EMAIL")) ?? undefined;
    const from = fromOverride ?? fromDefault;
    if (!from) {
      throw new Error(
        "send_email: no sender resolved. Pass `from` explicitly or set RESEND_FROM_EMAIL " +
          "in the scope env. The address must be on a domain verified at https://resend.com/domains.",
      );
    }

    const to = Array.isArray(input.to) ? (input.to as string[]) : input.to;
    if (!to || (Array.isArray(to) && to.length === 0)) {
      throw new Error("send_email: `to` is required");
    }

    const body: Record<string, unknown> = { from, to, subject };
    if (html) body.html = html;
    if (text) body.text = text;
    if (input.replyTo !== undefined) body.reply_to = input.replyTo;
    if (Array.isArray(input.cc) && input.cc.length > 0) body.cc = input.cc;
    if (Array.isArray(input.bcc) && input.bcc.length > 0) body.bcc = input.bcc;
    if (Array.isArray(input.tags) && input.tags.length > 0) body.tags = input.tags;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message =
        typeof json?.message === "string"
          ? json.message
          : `Resend API ${res.status}`;
      this.logger.warn(
        `[email_send] resend rejected scope=${scope.organizationId}/${scope.projectId}/${scope.environmentId} ` +
          `from=${from} status=${res.status} msg=${message}`,
      );
      return { ok: false, error: message, status: res.status };
    }
    return {
      ok: true,
      id: typeof json.id === "string" ? json.id : undefined,
      from,
      to,
      subject,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.platos_rag — retrieval-augmented generation helpers.
  //
  // Storage strategy: every ingested chunk is a clean `Memory` row. We set
  //   - kind = "fact"      (memory-kind.validator only accepts the 4-way
  //                        taxonomy; `rag` is tracked in metadata instead)
  //   - metadata = {
  //       __rag: true,     marker so list/delete queries can filter
  //       sourceUrl,       logical source identifier
  //       chunkIndex,      zero-based position of this chunk
  //       tags: string[],  optional user tags
  //       ingestedAt       ISO timestamp for list ordering
  //     }
  //
  // TODO(RG.1.1): rerank:true path. Today rag_retrieve returns a warning but
  //               still runs the simple semantic search.
  // TODO(RG.1.2): MemoryService has no `deleteWhere({ metadata: {...} })` and
  //               `semanticSearch` accepts `kind` but not arbitrary metadata
  //               filters. rag_delete_source lists rows first then deletes
  //               them one by one; rag_retrieve post-filters by tag in-JS.
  // TODO(RG.1.3): `userId` is sourced from the handler `scope` (passed as an
  //               extra field on the RequestScope tuple). The base ScopeTuple
  //               type used by SkillRegistryService doesn't include userId,
  //               so we coerce through `Record<string, unknown>`.
  // ──────────────────────────────────────────────────────────────────────────

  private readonly RAG_MAX_SYNC_SOURCES = 5;
  private readonly RAG_METADATA_MARKER = "__rag";

  /** Resolve userId from the widened scope tuple passed in at runtime. */
  private ragResolveUserId(scope: ScopeTuple): string {
    const uid = (scope as Record<string, unknown>)["userId"];
    if (typeof uid === "string" && uid.trim()) return uid;
    // Fail closed (audit H8). RAG rows are per-user; a turn that reaches a
    // RAG op with no acting userId is either a wiring bug or an
    // unauthenticated caller. Silently pooling every such call into a shared
    // "default" bucket leaked one user's corpus into another's retrieve/list.
    // Refuse rather than pool. Genuine system paths must pass an explicit
    // userId on the scope handed to SkillRuntimeService.invokeTool.
    throw new Error(
      "rag: no acting userId on scope — RAG operations require an authenticated " +
        "user. Ensure the turn scope carries userId at the invokeTool call site.",
    );
  }

  /**
   * audit L5 — resolve the acting agentId from the widened scope tuple, the
   * same channel `userId` travels on. SkillRuntimeService.invokeTool merges
   * `context.agentId` into the scope before dispatch.
   *
   * Soft-fails to null, unlike ragResolveUserId which fails CLOSED. Rationale:
   * userId is the isolation boundary — pooling users is a leak. agentId is
   * provenance/scoping within an already-authenticated user's own corpus, and
   * a null agentId is strictly LESS visible (it drops out of the agentId-
   * equality injection filter entirely), so a missing agentId degrades to the
   * pre-existing behaviour rather than widening exposure. Throwing here would
   * break ingest on any legitimate path that has no agent.
   */
  private ragResolveAgentId(scope: ScopeTuple): string | null {
    const aid = (scope as Record<string, unknown>)["agentId"];
    return typeof aid === "string" && aid.trim() ? aid : null;
  }

  /** Sentence-boundary aware splitter. Zero-dep. */
  private ragChunkText(
    text: string,
    chunkSize: number,
    overlap: number,
  ): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    // Split on sentence boundaries — `.`, `!`, `?` followed by whitespace.
    // Keep the delimiter by using a capturing regex and re-stitching.
    const sentences = trimmed.split(/(?<=[.!?])\s+/);
    const chunks: string[] = [];
    let buffer = "";
    for (const s of sentences) {
      if (!s.trim()) continue;
      const tentative = buffer ? `${buffer} ${s}` : s;
      if (tentative.length >= chunkSize) {
        chunks.push(tentative);
        // Carry an overlap tail from the end of this chunk.
        if (overlap > 0 && tentative.length > overlap) {
          buffer = tentative.slice(tentative.length - overlap);
        } else {
          buffer = "";
        }
      } else {
        buffer = tentative;
      }
    }
    if (buffer.trim().length > 0) chunks.push(buffer);
    // Defensive: if the input had no sentence terminators and is larger than
    // chunkSize, hard-slice so we don't return one giant chunk.
    if (chunks.length === 0 && trimmed.length > 0) {
      for (let i = 0; i < trimmed.length; i += Math.max(1, chunkSize - overlap)) {
        chunks.push(trimmed.slice(i, i + chunkSize));
      }
    }
    return chunks;
  }

  /** Fetch + extract a single source (URL or attachmentId:*) to plain text. */
  private async ragResolveSource(
    scope: ScopeTuple,
    source: string,
  ): Promise<{ sourceUrl: string; text: string }> {
    const trimmed = source.trim();
    if (!trimmed) throw new Error("rag_ingest_document: empty source");

    if (trimmed.startsWith("attachmentId:")) {
      const id = trimmed.slice("attachmentId:".length).trim();
      if (!id) throw new Error("rag_ingest_document: attachmentId ref missing id");
      // This skill receives Environment scope only, not the canonical Agent,
      // Thread, and EndUser boundary persisted on pending attachments. Never
      // weaken that boundary by resolving an id from Environment scope alone.
      throw new Error("rag_ingest_document: attachment source requires an authenticated Agent and Thread boundary");
    }

    if (!/^https?:\/\//.test(trimmed)) {
      throw new Error(
        `rag_ingest_document: unsupported source "${trimmed}" — expected http(s) URL or attachmentId:<id>`,
      );
    }

    // Prefer Parallel extract when PARALLEL_API_KEY is set — better JS-rendered
    // + PDF handling. Fall back to the built-in fetch_url path.
    const parallelKey = await this.scopedEnv.get(scope, "PARALLEL_API_KEY");
    if (parallelKey) {
      try {
        const extracted = (await this.parallelFetch(scope, "/extract", {
          method: "POST",
          body: {
            urls: [trimmed],
            objective: "Extract the full readable content for downstream chunking + embedding.",
          },
          timeoutMs: 30_000,
        })) as {
          extractions?: Array<{ url?: string; content?: string; excerpts?: string[] }>;
        } | null;
        const ex = extracted?.extractions?.[0];
        const text =
          (typeof ex?.content === "string" && ex.content) ||
          (Array.isArray(ex?.excerpts) ? ex.excerpts.join("\n\n") : "");
        if (text && text.trim().length > 0) {
          return { sourceUrl: trimmed, text };
        }
        // Empty extraction — fall through to fetch_url.
        this.logger.warn(
          `rag_ingest_document: parallel_extract returned no text for ${trimmed}, falling back to fetch_url`,
        );
      } catch (err: any) {
        this.logger.warn(
          `rag_ingest_document: parallel_extract failed for ${trimmed} (${err?.message ?? err}) — falling back to fetch_url`,
        );
      }
    }

    // Built-in fetch_url path — shares the SSRF allowlist + redirect validation.
    const fetched = (await this.fetchUrl(scope, { url: trimmed })) as {
      url: string;
      text: string;
    };
    return { sourceUrl: fetched.url, text: fetched.text };
  }

  /** Ingest a single source: fetch → chunk → upsert. Returns chunk count. */
  private async ragIngestOne(
    scope: ScopeTuple,
    userId: string,
    source: string,
    tags: string[],
    chunkSize: number,
    overlap: number,
  ): Promise<{ sourceUrl: string; chunkCount: number }> {
    if (!this.memoryService) {
      throw new Error(
        "rag_ingest_document: MemoryService unavailable — ensure MemoryModule is imported by SkillsModule",
      );
    }
    const { sourceUrl, text } = await this.ragResolveSource(scope, source);
    const chunks = this.ragChunkText(text, chunkSize, overlap);
    const ingestedAt = new Date().toISOString();
    // audit L5 — stamp the acting agent on every chunk of this ingest.
    const agentId = this.ragResolveAgentId(scope);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;
      // content is capped at 4000 chars by memory-kind validator — clamp
      // defensively so an over-eager chunkSize never blocks the ingest.
      const safeContent = chunk.length > 4000 ? chunk.slice(0, 4000) : chunk;
      try {
        await this.memoryService.add(scope, {
          userId,
          // audit L5 (CLOSED) — RAG chunks are now agent-scoped. This was
          // previously left NULL because these chunks derive visibility
          // "agent_visible" (normalizeVisibility default) and carry kind
          // "fact", so stamping agentId made them eligible for the AUTOMATIC
          // memory injection (agent.service.ts ~5000, limit 8 / minScore 0.35)
          // — raw document text would consume every turn's prompt budget.
          // The injection query now passes `excludeRag: true`, which filters on
          // `source = "rag"` below, so the NULL agentId is no longer load-
          // bearing and the row can be properly scoped.
          //
          // ORDER MATTERS: the excludeRag predicate must ship WITH or BEFORE
          // this stamping. Reverting the injection-side edit alone silently
          // re-opens the prompt-budget bug.
          //
          // rag_retrieve passes neither agentId nor excludeRag, so it still
          // finds every chunk, old (agentId NULL) and new alike.
          agentId,
          // memory-kind.validator restricts kind to fact|preference|event|relationship.
          // TODO(RG.1.2): add a first-class "rag" kind when the validator grows one.
          kind: "fact",
          content: safeContent,
          metadata: {
            [this.RAG_METADATA_MARKER]: true,
            sourceUrl,
            chunkIndex: i,
            tags,
            ingestedAt,
          },
          // audit L5 — was "imported", which is shared with GDPR import and
          // the memory controller's import path and so cannot discriminate RAG
          // rows. `source` is the only PLAINTEXT column available for the
          // exclusion predicate: `metadata` is envelope-encrypted at rest, so
          // the __rag marker above is unreadable from SQL. The marker stays —
          // rag_retrieve/rag_delete_source post-filter on it in JS after
          // decryption. No migration: the column is a bare String.
          source: RAG_MEMORY_SOURCE,
        }, { trustedSource: "rag" });
      } catch (err: any) {
        this.logger.warn(
          `rag_ingest_document: chunk ${i} of ${sourceUrl} failed to upsert: ${err?.message ?? err}`,
        );
      }
    }
    return { sourceUrl, chunkCount: chunks.length };
  }

  private async ragIngestDocument(
    scope: ScopeTuple,
    input: Record<string, unknown>,
  ) {
    const sourceRaw = input.source;
    const sources: string[] = Array.isArray(sourceRaw)
      ? sourceRaw.map((s) => String(s)).filter((s) => s.trim().length > 0)
      : typeof sourceRaw === "string" && sourceRaw.trim()
        ? [sourceRaw.trim()]
        : [];
    if (sources.length === 0) {
      throw new Error("rag_ingest_document: source is required (string or array)");
    }
    const tagsRaw = input.tags;
    const tags: string[] = Array.isArray(tagsRaw)
      ? tagsRaw.map((t) => String(t)).filter((t) => t.trim().length > 0)
      : [];
    const chunkSize = Math.max(
      200,
      Math.min(4000, Math.floor(Number(input.chunkSize ?? 1000))),
    );
    const overlap = Math.max(
      0,
      Math.min(
        1000,
        Math.floor(Number(input.overlap ?? 200)),
      ),
    );
    const userId = this.ragResolveUserId(scope);

    // >5 sources → fan out via agent_batch (durable, stream progress). Fall
    // back to sync in-handler if trigger.dev isn't configured.
    if (sources.length > this.RAG_MAX_SYNC_SOURCES) {
      const batchRunId = `rag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        // Lazy require — keeps this file free of top-level trigger-bridge imports.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const triggerSdk = require("@trigger.dev/sdk");
        const triggerReady =
          configureExternalTriggerSdk(triggerSdk).status === "configured" &&
          !!triggerSdk?.tasks?.trigger;
        if (triggerReady) {
          const items = sources.map((s) => ({ source: s, tags, chunkSize, overlap }));
          const perItemInstructions = [
            "You are running one iteration of a batched RAG ingest.",
            "Call `platos_platos_rag__rag_ingest_document` with the `source`, `tags`, `chunkSize`, and `overlap` from the item below.",
            "Do not call any other tool. Do not summarise — just ingest and return the tool's response verbatim.",
          ].join(" ");
          const parentAgentId =
            (scope as Record<string, unknown>)["agentId"];
          const parentThreadId =
            (scope as Record<string, unknown>)["threadId"] ?? "";
          const handle = await triggerSdk.tasks.trigger("platos-agent-batch", {
            batchRunId,
            scope: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId,
              agentId: (parentAgentId as string | undefined) ?? "default",
            },
            parentThreadId: String(parentThreadId ?? ""),
            parentAgentId: (parentAgentId as string | undefined) ?? "default",
            items,
            perItemInstructions,
            allowedTools: ["platos_platos_rag__rag_ingest_document"],
            maxConcurrency: 1,
            label: `rag_ingest (${sources.length} sources)`,
          });
          return {
            batchRunId,
            runId: handle.id,
            queued: true,
            itemCount: sources.length,
            message: `rag_ingest_document queued ${sources.length} sources via agent_batch (batchRunId=${batchRunId}).`,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `rag_ingest_document: agent_batch spawn failed (${err?.message ?? err}) — falling back to sync ingest.`,
        );
      }
      // Fall-through to sync ingest when trigger.dev is unavailable.
    }

    const ingested: Array<{ sourceUrl: string; chunkCount: number }> = [];
    let totalChunks = 0;
    for (const s of sources) {
      try {
        const r = await this.ragIngestOne(scope, userId, s, tags, chunkSize, overlap);
        ingested.push(r);
        totalChunks += r.chunkCount;
      } catch (err: any) {
        ingested.push({
          sourceUrl: s,
          chunkCount: 0,
        });
        this.logger.warn(
          `rag_ingest_document: source ${s} failed: ${err?.message ?? err}`,
        );
      }
    }
    return { ingested, totalChunks };
  }

  private async ragRetrieve(scope: ScopeTuple, input: Record<string, unknown>) {
    if (!this.memoryService) {
      throw new Error("rag_retrieve: MemoryService unavailable");
    }
    const query = String(input.query ?? "").trim();
    if (!query) throw new Error("rag_retrieve: query is required");
    const topK = Math.max(1, Math.min(50, Math.floor(Number(input.topK ?? 8))));
    const filterTagsRaw = input.filterTags;
    const filterTags: string[] = Array.isArray(filterTagsRaw)
      ? filterTagsRaw.map((t) => String(t)).filter((t) => t.trim().length > 0)
      : [];
    const rerank = input.rerank === true;
    const userId = this.ragResolveUserId(scope);

    // Over-fetch when filterTags is set so the in-JS post-filter still
    // returns topK results. Cap at 50 (MemoryService.semanticSearch max).
    const searchLimit = filterTags.length > 0 ? Math.min(50, topK * 4) : topK;
    const hits = await this.memoryService.semanticSearch(scope, {
      query,
      userId,
      kind: "fact", // TODO(RG.1.2): filter by metadata.__rag instead once MemoryService grows it
      limit: searchLimit,
      agentVisibleOnly: true,
    });

    // Post-filter: only RAG rows, optional tag filter. MemoryService doesn't
    // yet accept a metadata JSON-path filter (TODO(RG.1.2)).
    const filtered = hits.filter((h) => {
      const m = (h.metadata ?? {}) as Record<string, unknown>;
      if (m[this.RAG_METADATA_MARKER] !== true) return false;
      if (filterTags.length === 0) return true;
      const rowTags = Array.isArray(m.tags) ? (m.tags as unknown[]).map(String) : [];
      return filterTags.some((t) => rowTags.includes(t));
    });

    const chunks = filtered.slice(0, topK).map((h) => {
      const m = (h.metadata ?? {}) as Record<string, unknown>;
      return {
        content: h.content,
        sourceUrl: typeof m.sourceUrl === "string" ? m.sourceUrl : null,
        chunkIndex: typeof m.chunkIndex === "number" ? m.chunkIndex : 0,
        score: Number(h.score.toFixed(4)),
      };
    });

    const result: Record<string, unknown> = {
      chunks,
      totalChunks: chunks.length,
      reranked: false,
    };
    if (rerank) {
      // TODO(RG.1.1): wire a cross-encoder reranker (Cohere, Voyage, or a
      // local BGE). For now surface a warning so the LLM knows the flag
      // was ignored.
      result.warning =
        "rerank=true is not yet implemented — returning simple semantic search. TODO(RG.1.1).";
    }
    return result;
  }

  /** List RAG rows for this user (no embeddings), paginated internally. */
  private async ragListRagRows(scope: ScopeTuple, userId: string) {
    if (!this.memoryService) {
      throw new Error("rag_list: MemoryService unavailable");
    }
    // Memory list doesn't support metadata filters — fetch fact rows and
    // post-filter to the RAG marker. Cap at 200 per page; we page until
    // exhausted or we hit a hard ceiling of 5 pages (1000 rows) so a
    // broken agent can't DoS this path.
    const PAGE = 200;
    const MAX_PAGES = 5;
    const all: Array<{
      id: string;
      content: string;
      metadata: Record<string, unknown>;
      createdAt: Date;
    }> = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const rows = await this.memoryService.list(scope, {
        userId,
        kind: "fact",
        limit: PAGE,
        offset: p * PAGE,
        agentVisibleOnly: true,
        visibilityIn: ["agent_visible"],
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const m = (r.metadata ?? {}) as Record<string, unknown>;
        if (m[this.RAG_METADATA_MARKER] === true) {
          all.push({
            id: r.id,
            content: r.content,
            metadata: m,
            createdAt: r.createdAt,
          });
        }
      }
      if (rows.length < PAGE) break;
    }
    return all;
  }

  private async ragDeleteSource(scope: ScopeTuple, input: Record<string, unknown>) {
    if (!this.memoryService) {
      throw new Error("rag_delete_source: MemoryService unavailable");
    }
    const sourceUrl = String(input.sourceUrl ?? "").trim();
    if (!sourceUrl) throw new Error("rag_delete_source: sourceUrl is required");
    const userId = this.ragResolveUserId(scope);

    // TODO(RG.1.2): MemoryService has no deleteWhere({ metadata }) — list
    // RAG rows, filter by sourceUrl, delete by id one-by-one.
    const rows = await this.ragListRagRows(scope, userId);
    const toDelete = rows.filter((r) => r.metadata.sourceUrl === sourceUrl);
    let deleted = 0;
    for (const r of toDelete) {
      try {
        const ok = await this.memoryService.delete(scope, r.id);
        if (ok) deleted++;
      } catch (err: any) {
        this.logger.warn(
          `rag_delete_source: delete ${r.id} failed: ${err?.message ?? err}`,
        );
      }
    }
    return { deleted, sourceUrl };
  }

  private async ragListSources(scope: ScopeTuple, _input: Record<string, unknown>) {
    const userId = this.ragResolveUserId(scope);
    const rows = await this.ragListRagRows(scope, userId);
    const by = new Map<
      string,
      { sourceUrl: string; chunkCount: number; tags: Set<string>; firstIngestedAt: string }
    >();
    for (const r of rows) {
      const src = typeof r.metadata.sourceUrl === "string" ? r.metadata.sourceUrl : "";
      if (!src) continue;
      const rowTags = Array.isArray(r.metadata.tags)
        ? (r.metadata.tags as unknown[]).map(String)
        : [];
      const ingestedAt =
        typeof r.metadata.ingestedAt === "string"
          ? r.metadata.ingestedAt
          : r.createdAt.toISOString();
      const existing = by.get(src);
      if (existing) {
        existing.chunkCount += 1;
        for (const t of rowTags) existing.tags.add(t);
        if (ingestedAt < existing.firstIngestedAt) existing.firstIngestedAt = ingestedAt;
      } else {
        by.set(src, {
          sourceUrl: src,
          chunkCount: 1,
          tags: new Set(rowTags),
          firstIngestedAt: ingestedAt,
        });
      }
    }
    const sources = Array.from(by.values()).map((s) => ({
      sourceUrl: s.sourceUrl,
      chunkCount: s.chunkCount,
      tags: Array.from(s.tags),
      firstIngestedAt: s.firstIngestedAt,
    }));
    sources.sort((a, b) => a.firstIngestedAt.localeCompare(b.firstIngestedAt));
    return { sources };
  }

  private async ragReindex(scope: ScopeTuple, input: Record<string, unknown>) {
    const sourceUrl = String(input.sourceUrl ?? "").trim();
    if (!sourceUrl) throw new Error("rag_reindex: sourceUrl is required");
    const userId = this.ragResolveUserId(scope);

    // Capture existing tags so the reindex preserves them.
    const rows = await this.ragListRagRows(scope, userId);
    const existing = rows.filter((r) => r.metadata.sourceUrl === sourceUrl);
    const preservedTags = new Set<string>();
    for (const r of existing) {
      const rowTags = Array.isArray(r.metadata.tags)
        ? (r.metadata.tags as unknown[]).map(String)
        : [];
      for (const t of rowTags) preservedTags.add(t);
    }

    // Delete existing chunks first.
    const deleteResult = await this.ragDeleteSource(scope, { sourceUrl });

    // Re-ingest with the preserved tag set.
    const ingestResult = (await this.ragIngestDocument(scope, {
      source: sourceUrl,
      tags: Array.from(preservedTags),
    })) as {
      ingested?: Array<{ sourceUrl: string; chunkCount: number }>;
      totalChunks?: number;
    };
    return {
      deleted: (deleteResult as { deleted: number }).deleted,
      reingested: ingestResult.ingested ?? [],
      totalChunks: ingestResult.totalChunks ?? 0,
      tags: Array.from(preservedTags),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.web_search
  // ──────────────────────────────────────────────────────────────────────────

  private async webSearch(scope: ScopeTuple, input: Record<string, unknown>) {
    const query = String(input.query ?? "");
    const maxResults = Number(input.maxResults ?? 5);
    if (!query.trim()) throw new Error("web_search: query is required");
    const apiKey = await this.scopedEnv.get(scope, "TAVILY_API_KEY");
    if (!apiKey) throw new Error("web_search: TAVILY_API_KEY not set in scope");

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.max(1, Math.min(20, maxResults)),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily search failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as any;
    const results = Array.isArray(body?.results)
      ? body.results.map((r: any) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          score: r.score,
        }))
      : [];
    return { query, results };
  }

  private async fetchUrl(scope: ScopeTuple, input: Record<string, unknown>) {
    const url = String(input.url ?? "");
    if (!/^https?:\/\//.test(url)) throw new Error("fetch_url: url must be http(s)");
    void scope;
    // EOBD.10 follow-up — LLM-directed `platos.fetch_url` is the single
    // highest-risk SSRF surface in the agent: a prompt-injected agent
    // can target AWS IMDS / internal services / any localhost admin
    // endpoint. Validate against the shared allowlist before fetch.
    const urlCheck = await validatePublicUrl(url);
    if (!urlCheck.ok) {
      throw new Error(
        `fetch_url rejected: ${describeUrlValidationError(urlCheck.error)}`,
      );
    }
    // Re-validate on any 3xx redirect target so a public hostname
    // redirecting to 127.0.0.1 is also caught. `redirect: "manual"`
    // stops fetch from automatically chasing; we follow up to 3 hops
    // explicitly, validating each Location.
    const res = await fetchWithValidatedRedirects(url, 3);
    if (!res.ok) throw new Error(`fetch_url failed: ${res.status}`);
    const text = await res.text();
    // Lightweight HTML → text extraction (strip scripts/tags). Keeps payload
    // reasonable for the LLM context without pulling in jsdom.
    const cleaned = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, text: cleaned.slice(0, 32_000) };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.code_execution
  // ──────────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // Persistent per-thread sandbox session (CE.2).
  //
  // The original code_execution skill created a throwaway sandbox per call and
  // killed it in `finally` — so files, cwd, installed packages, and `git clone`
  // results never survived between tool calls. That makes real CLI workflows
  // (clone → cd → install → test, or write data → transform → export)
  // impossible.
  //
  // This binds ONE sandbox to the PlatosAgentThread, reused across every tool
  // call in that thread. We need no new table or Redis: E2B sandboxes carry
  // `metadata` and are discoverable via `Sandbox.list({ query: { metadata } })`.
  // We tag each session sandbox with the threadId, look it up + `connect` on the
  // next call, and bump its idle timeout. When the thread has no id (meta-tool
  // paths), we fall back to an ephemeral per-call sandbox (killed by the caller).
  //
  // Lifetime is governed by E2B's own idle timeout (default 5m, bumped on each
  // use) — when the thread goes quiet the sandbox auto-reaps server-side, so
  // there is no orphan-reaper to run. Network egress is deny-by-default unless
  // the agent's E2B_SANDBOX_ALLOW_INTERNET env opts in.
  // ──────────────────────────────────────────────────────────────────────────

  private static readonly SESSION_TIMEOUT_MS = 600_000; // 10 min idle ceiling per use

  private threadIdFromScope(scope: ScopeTuple): string {
    const raw = (scope as Record<string, unknown>)["threadId"];
    return typeof raw === "string" ? raw.trim() : "";
  }

  /**
   * CE.3 — true when PLATOS_SANDBOX_PROVIDER=vercel. The flag switches the
   * WHOLE code_execution filesystem surface (run_shell + install_package +
   * upload_to_sandbox) to the Vercel backend so those tools keep sharing one
   * per-thread filesystem. run_python / run_node have no Vercel equivalent
   * (E2B's code-interpreter API) and error clearly under the flag instead of
   * silently writing to a different E2B filesystem.
   */
  private static vercelProviderSelected(): boolean {
    return (process.env.PLATOS_SANDBOX_PROVIDER ?? "").trim().toLowerCase() === "vercel";
  }

  /** Resolve the Vercel backend or throw a clear, actionable error. */
  private requireVercelSandbox(tool: string): VercelSandboxService {
    const svc = this.vercelSandbox;
    if (!svc) {
      throw new Error(`${tool}: Vercel Sandbox backend is not available in this build.`);
    }
    if (!svc.isConfigured()) {
      throw new Error(
        `${tool}: Vercel Sandbox is selected (PLATOS_SANDBOX_PROVIDER=vercel) but not configured. ` +
        "Set VERCEL_TEAM_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN (a no-expiration Vercel access token) " +
        "in the process environment.",
      );
    }
    return svc;
  }

  /**
   * Resolve the sandbox for this thread: reconnect to the live session if one
   * exists, otherwise create + tag a fresh one. Returns the sandbox plus an
   * `ephemeral` flag — ephemeral sandboxes (no threadId) MUST be killed by the
   * caller; session sandboxes are left running for the next tool call.
   */
  private async resolveSandbox(
    scope: ScopeTuple,
    apiKey: string,
  ): Promise<{ sandbox: Sandbox; ephemeral: boolean }> {
    const threadId = this.threadIdFromScope(scope);
    const template = await this.scopedEnv.get(scope, "E2B_SANDBOX_TEMPLATE");
    const allowInternet =
      (await this.scopedEnv.get(scope, "E2B_SANDBOX_ALLOW_INTERNET")) === "true";

    // Ephemeral fallback when there's no thread to anchor to.
    if (!threadId) {
      const sandbox = await (template
        ? Sandbox.create(template, { apiKey, allowInternetAccess: allowInternet })
        : Sandbox.create({ apiKey, allowInternetAccess: allowInternet }));
      return { sandbox, ephemeral: true };
    }

    const metaTag = `platos-thread:${threadId}`;

    // Try to reconnect to an existing running session for this thread.
    try {
      const paginator = Sandbox.list({
        query: { metadata: { platosThread: threadId }, state: ["running"] },
        apiKey,
      });
      const running = await paginator.nextItems();
      if (running.length > 0) {
        const sandbox = await Sandbox.connect(running[0].sandboxId, { apiKey });
        await sandbox
          .setTimeout(OfficialSkillHandlers.SESSION_TIMEOUT_MS)
          .catch(() => { /* best effort idle bump */ });
        return { sandbox, ephemeral: false };
      }
    } catch (err: any) {
      // List/connect failure → fall through to create a fresh session.
      this.logger.debug(
        `[code_execution] session reconnect miss for ${metaTag}: ${err?.message ?? err}`,
      );
    }

    // No live session → create one, tagged so the next call finds it.
    const opts = {
      apiKey,
      metadata: { platosThread: threadId, platos: "session" },
      timeoutMs: OfficialSkillHandlers.SESSION_TIMEOUT_MS,
      allowInternetAccess: allowInternet,
    };
    const sandbox = await (template
      ? Sandbox.create(template, opts)
      : Sandbox.create(opts));
    return { sandbox, ephemeral: false };
  }

  private async runCode(
    scope: ScopeTuple,
    lang: "python" | "node",
    input: Record<string, unknown>,
  ) {
    // CE.3 — under the Vercel provider the thread's filesystem lives in a
    // Vercel sandbox. Running this tool on E2B anyway would silently use a
    // DIFFERENT filesystem (files uploaded / packages installed there would be
    // invisible to run_shell), so fail loudly with a workaround instead.
    if (OfficialSkillHandlers.vercelProviderSelected()) {
      throw new Error(
        `run_${lang}: not available while PLATOS_SANDBOX_PROVIDER=vercel. ` +
        "The Vercel backend powers run_shell / install_package / upload_to_sandbox on one shared " +
        "per-thread filesystem, but has no code-interpreter equivalent for this tool, and falling " +
        "back to E2B would use a different filesystem. Use run_shell (e.g. `node -e ...` or a " +
        "heredoc) in the shared sandbox instead, or unset PLATOS_SANDBOX_PROVIDER to use E2B.",
      );
    }

    const apiKey = await this.scopedEnv.get(scope, "E2B_API_KEY");
    if (!apiKey) {
      throw new Error(
        `run_${lang}: E2B_API_KEY is not set in this environment. ` +
        `Add it via Settings → Environment Variables, then enable the Code Execution skill on this agent.`,
      );
    }

    const code = String(input.code ?? "");
    if (!code.trim()) throw new Error(`run_${lang}: code is required`);

    const timeoutMs = Math.max(1000, Math.min(60_000, Number(input.timeoutMs ?? 15_000)));

    const { sandbox, ephemeral } = await this.resolveSandbox(scope, apiKey);
    const startedAt = Date.now();

    try {
      const execution = lang === "python"
        ? await sandbox.runCode(code, { timeoutMs })
        : await sandbox.runCode(code, { timeoutMs, language: "js" });

      const latencyMs = Date.now() - startedAt;
      const stdout = execution.logs.stdout.join("\n").trim();
      const stderr = execution.logs.stderr.join("\n").trim();
      const hasError = execution.error != null;

      this.logger.debug(
        `[code_execution] run_${lang} session=${!ephemeral} exitOk=${!hasError} latencyMs=${latencyMs} ` +
        `stdout_chars=${stdout.length} stderr_chars=${stderr.length}`,
      );

      return {
        lang,
        stdout: stdout || null,
        stderr: stderr || null,
        error: hasError ? (execution.error?.value ?? "Execution error") : null,
        latencyMs,
        // Surface whether state persists so the LLM knows it can build on prior calls.
        sessionPersistent: !ephemeral,
      };
    } finally {
      // Only tear down ephemeral (no-thread) sandboxes. Session sandboxes stay
      // alive for the next tool call and auto-reap on idle.
      if (ephemeral) await sandbox.kill().catch(() => { /* best effort */ });
    }
  }

  /**
   * CE.2 — run an arbitrary shell command in the thread's persistent sandbox.
   * This is what turns "code interpreter" into "CLI on demand": `git`, `psql`,
   * `ffmpeg`, `duckdb`, `pnpm test`, etc. all run here, with cwd + filesystem
   * surviving across calls. Output is byte-capped; exit code is surfaced so the
   * LLM can branch on failure.
   */
  private async runShell(scope: ScopeTuple, input: Record<string, unknown>) {
    // CE.3 — provider switch. PLATOS_SANDBOX_PROVIDER=vercel routes the whole
    // filesystem surface (run_shell here, plus install_package and
    // upload_to_sandbox) to the Vercel Sandbox backend so cross-tool workflows
    // keep sharing one per-thread filesystem; run_python / run_node error
    // clearly under the flag (no Vercel code-interpreter). Anything else
    // (default/unset) falls through to the EXACT E2B path below, untouched.
    if (OfficialSkillHandlers.vercelProviderSelected()) {
      return this.runShellVercel(scope, input);
    }

    const apiKey = await this.scopedEnv.get(scope, "E2B_API_KEY");
    if (!apiKey) throw new Error("run_shell: E2B_API_KEY is not set in this environment.");

    const cmd = String(input.command ?? "").trim();
    if (!cmd) throw new Error("run_shell: command is required");

    const timeoutMs = Math.max(1000, Math.min(120_000, Number(input.timeoutMs ?? 30_000)));
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    const MAX_OUT = 100_000; // cap each stream so a runaway command can't blow the context window

    const { sandbox, ephemeral } = await this.resolveSandbox(scope, apiKey);
    const startedAt = Date.now();
    try {
      const result = await sandbox.commands.run(cmd, {
        timeoutMs,
        ...(cwd ? { cwd } : {}),
      });
      const clip = (s: string) =>
        s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s;
      return {
        command: cmd,
        exitCode: result.exitCode,
        stdout: clip(result.stdout ?? "").trim() || null,
        stderr: clip(result.stderr ?? "").trim() || null,
        latencyMs: Date.now() - startedAt,
        sessionPersistent: !ephemeral,
      };
    } catch (err: any) {
      // E2B throws CommandExitError on non-zero exit — surface it as a result,
      // not a thrown skill error, so the LLM can read stderr + branch.
      const exitCode = typeof err?.exitCode === "number" ? err.exitCode : 1;
      const stderr = typeof err?.stderr === "string" ? err.stderr : (err?.message ?? String(err));
      const stdout = typeof err?.stdout === "string" ? err.stdout : "";
      return {
        command: cmd,
        exitCode,
        stdout: stdout.slice(0, MAX_OUT).trim() || null,
        stderr: stderr.slice(0, MAX_OUT).trim() || null,
        latencyMs: Date.now() - startedAt,
        sessionPersistent: !ephemeral,
      };
    } finally {
      if (ephemeral) await sandbox.kill().catch(() => { /* best effort */ });
    }
  }

  /**
   * CE.3 — run_shell on the Vercel Sandbox backend. Shapes its result to the
   * EXACT contract the E2B path returns ({ command, exitCode, stdout, stderr,
   * latencyMs, sessionPersistent }) so the provider swap is invisible to the
   * agent. install_package and upload_to_sandbox route to the SAME per-thread
   * sandbox, so the skill's shared-filesystem contract holds; run_python /
   * run_node error under the flag. Persistence is the one intended improvement:
   * a thread's named sandbox snapshots its filesystem on stop() and survives
   * long idle gaps.
   */
  private async runShellVercel(scope: ScopeTuple, input: Record<string, unknown>) {
    const svc = this.requireVercelSandbox("run_shell");

    const cmd = String(input.command ?? "").trim();
    if (!cmd) throw new Error("run_shell: command is required");

    // Mirror the E2B clamp exactly so timeout semantics stay identical for the
    // agent (the service enforces its own 10-min absolute ceiling on top).
    const timeoutMs = Math.max(1000, Math.min(120_000, Number(input.timeoutMs ?? 30_000)));
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    // Vercel runs the whole script under `bash -lc`, so the E2B `cwd` option maps
    // to a `cd` prefix to preserve identical behaviour.
    const script = cwd ? `cd ${JSON.stringify(cwd)} && ${cmd}` : cmd;

    const threadId = this.threadIdFromScope(scope);
    const MAX_OUT = 100_000; // cap each stream so a runaway command can't blow the context window
    const clip = (s: string) =>
      s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s;

    const startedAt = Date.now();
    const result = await svc.runShell({
      threadId: threadId || undefined,
      script,
      timeoutMs,
    });
    return {
      command: cmd,
      exitCode: result.exitCode,
      stdout: clip(result.stdout ?? "").trim() || null,
      stderr: clip(result.stderr ?? "").trim() || null,
      latencyMs: Date.now() - startedAt,
      // Thread-anchored Vercel sandboxes persist (snapshot on stop); ephemeral
      // (no-thread) ones do not — matches the E2B `sessionPersistent` semantics.
      sessionPersistent: Boolean(threadId),
    };
  }

  private async installPackage(scope: ScopeTuple, input: Record<string, unknown>) {
    const packages = Array.isArray(input.packages)
      ? (input.packages as unknown[]).map(String)
      : [String(input.packages ?? input.package ?? "")];
    const validPackages = packages.filter((p) => /^[a-zA-Z0-9_\-\.]+([><=!]{1,2}[0-9.*]+)?$/.test(p.trim()));
    if (validPackages.length === 0) throw new Error("install_package: no valid package names provided.");

    const manager = String(input.manager ?? "pip");

    // CE.3 — under the Vercel provider, install into the SAME per-thread Vercel
    // sandbox that run_shell uses (installing into E2B here would silently put
    // the packages on a filesystem run_shell can't see).
    if (OfficialSkillHandlers.vercelProviderSelected()) {
      return this.installPackageVercel(scope, validPackages, manager);
    }

    const apiKey = await this.scopedEnv.get(scope, "E2B_API_KEY");
    if (!apiKey) throw new Error("install_package: E2B_API_KEY not set.");
    const code = manager === "npm"
      ? `const { execSync } = require('child_process'); execSync('npm install ${validPackages.join(" ")}', { stdio: 'inherit' });`
      : `import subprocess; subprocess.run(['pip', 'install', '--quiet', ${validPackages.map((p) => `'${p}'`).join(", ")}], check=True); print("Installed: ${validPackages.join(", ")}")`;

    // Install into the thread's persistent session so the packages are still
    // there on the next run_python / run_node / run_shell call.
    const { sandbox, ephemeral } = await this.resolveSandbox(scope, apiKey);
    try {
      const execution = manager === "npm"
        ? await sandbox.runCode(code, { language: "js", timeoutMs: 60_000 })
        : await sandbox.runCode(code, { timeoutMs: 60_000 });
      return {
        packages: validPackages,
        manager,
        stdout: execution.logs.stdout.join("\n").trim() || null,
        stderr: execution.logs.stderr.join("\n").trim() || null,
        error: execution.error?.value ?? null,
        sessionPersistent: !ephemeral,
      };
    } finally {
      if (ephemeral) await sandbox.kill().catch(() => { /* best effort */ });
    }
  }

  /**
   * CE.3 — install_package on the Vercel backend: a plain shell install in the
   * thread's named sandbox, so packages land on the same filesystem run_shell
   * uses. Package names are already regex-validated (no shell metacharacters
   * beyond version-range chars), and each is quoted so `>=`-style specifiers
   * can't be parsed as shell redirects.
   */
  private async installPackageVercel(
    scope: ScopeTuple,
    validPackages: string[],
    manager: string,
  ) {
    const svc = this.requireVercelSandbox("install_package");
    const quoted = validPackages.map((p) => JSON.stringify(p.trim())).join(" ");
    const script = manager === "npm"
      ? `npm install ${quoted}`
      : `python3 -m pip install --quiet ${quoted} && echo "Installed: ${validPackages.join(", ")}"`;

    const threadId = this.threadIdFromScope(scope);
    const result = await svc.runShell({
      threadId: threadId || undefined,
      script,
      timeoutMs: 60_000,
    });
    return {
      packages: validPackages,
      manager,
      stdout: result.stdout.trim() || null,
      stderr: result.stderr.trim() || null,
      error: result.exitCode === 0 ? null : `install exited with code ${result.exitCode}`,
      sessionPersistent: Boolean(threadId),
    };
  }

  private async resolveSandboxAttachment(
    scope: ScopeTuple,
    attachmentId: string,
    attachmentsSvc: unknown,
  ): Promise<{ id: string; storageKey: string; filename: string; bytes: number }> {
    const prisma = (attachmentsSvc as any).prisma;
    if (!prisma?.messageAttachment) {
      throw new Error("upload_to_sandbox: clean MessageAttachment adapter unavailable.");
    }
    const agentId = this.ragResolveAgentId(scope);
    if (!agentId) throw new Error("upload_to_sandbox: acting Agent is required.");
    const threadId = this.threadIdFromScope(scope);
    if (!threadId) throw new Error("upload_to_sandbox: acting Thread is required.");
    const endUser = await resolveEndUser(prisma, scope, this.ragResolveUserId(scope));
    const row = await prisma.messageAttachment.findFirst({
      where: {
        id: attachmentId,
        endUserId: endUser.id,
        agentId,
        threadId,
        turnId: { not: null },
        ...environmentScopeWhere(scope),
      },
      select: { id: true, storageKey: true, originalName: true, bytes: true },
    });
    if (!row) {
      throw new Error(`upload_to_sandbox: attachment ${attachmentId} not found in scope.`);
    }
    return {
      id: row.id,
      storageKey: row.storageKey,
      filename: row.originalName ?? row.id,
      bytes: row.bytes,
    };
  }

  private async uploadToSandbox(scope: ScopeTuple, input: Record<string, unknown>) {
    // CE.3 — under the Vercel provider the download happens inside the thread's
    // Vercel sandbox (same filesystem as run_shell / install_package); E2B and
    // its API key are not involved at all.
    const useVercel = OfficialSkillHandlers.vercelProviderSelected();
    const apiKey = useVercel ? null : await this.scopedEnv.get(scope, "E2B_API_KEY");
    if (!useVercel && !apiKey) throw new Error("upload_to_sandbox: E2B_API_KEY not set.");

    const attachmentId = String(input.attachmentId ?? "").trim();
    if (!attachmentId) throw new Error("upload_to_sandbox: attachmentId is required.");

    const destPath = String(input.destPath ?? `/tmp/${attachmentId}`).trim();

    // Resolve presigned URL via AttachmentsService (lazy via ModuleRef to avoid DI cycle)
    const { AttachmentsService } = await import("../../agent-runtime/attachments.service");
    const attachmentsSvc = this.moduleRef
      ? await this.moduleRef.resolve(AttachmentsService)
      : null;
    if (!attachmentsSvc) throw new Error("upload_to_sandbox: AttachmentsService not available.");

    const row = await this.resolveSandboxAttachment(scope, attachmentId, attachmentsSvc);

    const presignedUrl = await attachmentsSvc.getPresignedDownloadUrl(row.storageKey);

    if (useVercel) {
      // Download inside the thread's Vercel sandbox via a node one-liner (the
      // runtime is node24; python is not guaranteed). Args are passed via
      // process.argv — with `node -e`, argv[1] is the first extra arg — and
      // every shell-facing string is single-quote-escaped.
      const svc = this.requireVercelSandbox("upload_to_sandbox");
      const nodeCode =
        'const fs=require("node:fs");const path=require("node:path");' +
        "const url=process.argv[1],dest=process.argv[2];" +
        'fs.mkdirSync(path.dirname(dest)||".",{recursive:true});' +
        'fetch(url).then(async r=>{if(!r.ok)throw new Error("HTTP "+r.status);' +
        "const b=Buffer.from(await r.arrayBuffer());fs.writeFileSync(dest,b);" +
        'console.log("Downloaded "+b.length+" bytes to "+dest);})' +
        ".catch(e=>{console.error(String((e&&e.message)||e));process.exit(1);});";
      const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const script = `node -e ${shq(nodeCode)} ${shq(presignedUrl)} ${shq(destPath)}`;

      const threadId = this.threadIdFromScope(scope);
      const result = await svc.runShell({
        threadId: threadId || undefined,
        script,
        timeoutMs: 60_000,
      });
      return {
        attachmentId,
        filename: row.filename,
        bytes: row.bytes,
        sandboxPath: destPath,
        stdout: result.stdout.trim() || null,
        error:
          result.exitCode === 0
            ? null
            : result.stderr.trim() || `download exited with code ${result.exitCode}`,
        sessionPersistent: Boolean(threadId),
      };
    }

    // E2B path — apiKey was validated above; re-assert for type narrowing.
    if (!apiKey) throw new Error("upload_to_sandbox: E2B_API_KEY not set.");

    // Download presigned URL into E2B sandbox via Python urllib (no server-side bytes)
    const code = `
import urllib.request, os
os.makedirs(os.path.dirname('${destPath}') or '.', exist_ok=True)
urllib.request.urlretrieve('${presignedUrl.replace(/'/g, "\\'")}', '${destPath}')
print(f"Downloaded {os.path.getsize('${destPath}')} bytes to ${destPath}")
`.trim();

    // Download into the thread's persistent session so the file is available to
    // every subsequent run_python / run_node / run_shell call.
    const { sandbox, ephemeral } = await this.resolveSandbox(scope, apiKey);
    try {
      const execution = await sandbox.runCode(code, { timeoutMs: 60_000 });
      return {
        attachmentId,
        filename: row.filename,
        bytes: row.bytes,
        sandboxPath: destPath,
        stdout: execution.logs.stdout.join("\n").trim() || null,
        error: execution.error?.value ?? null,
        sessionPersistent: !ephemeral,
      };
    } finally {
      if (ephemeral) await sandbox.kill().catch(() => { /* best effort */ });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.file_operations (MinIO)
  // ──────────────────────────────────────────────────────────────────────────

  private async readFile(scope: ScopeTuple, input: Record<string, unknown>) {
    void scope;
    void input;
    // The AttachmentsService (Theme D) already provides S3-backed file access —
    // this handler will delegate to it in a follow-up so we stay on a single
    // credential path. MVP returns a clear stub so agents get a helpful error.
    return {
      stub: true,
      message:
        "file_operations.read_file is scaffolded. Wire AttachmentsService integration in a follow-up.",
    };
  }

  private async writeFile(scope: ScopeTuple, input: Record<string, unknown>) {
    void scope;
    void input;
    return {
      stub: true,
      message:
        "file_operations.write_file is scaffolded. Wire AttachmentsService integration in a follow-up.",
    };
  }

  private async listDir(scope: ScopeTuple, input: Record<string, unknown>) {
    void scope;
    void input;
    return {
      stub: true,
      files: [],
      message:
        "file_operations.list_dir is scaffolded. Wire AttachmentsService integration in a follow-up.",
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.image_generation
  // ──────────────────────────────────────────────────────────────────────────

  private async generateImage(scope: ScopeTuple, input: Record<string, unknown>) {
    const prompt = String(input.prompt ?? "");
    if (!prompt.trim()) throw new Error("generate_image: prompt is required");
    const key = await this.scopedEnv.get(scope, "BFL_API_KEY");
    if (!key) {
      throw new Error("generate_image: BFL_API_KEY not set in scope");
    }
    // MVP stub — the live Flux API is polling-based. We surface a clear stub
    // shape so the runtime + manifest wiring can be tested without a live key.
    return {
      stub: true,
      prompt,
      message:
        "image_generation is scaffolded. Wire the Flux polling + MinIO upload pipeline in a follow-up.",
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.parallel_web — Parallel.ai search / extract / task-runs / findall / monitors
  //
  // Single env var (`PARALLEL_API_KEY`) auth'd via `x-api-key` header.
  // Base URL: https://api.parallel.ai/v1 (docs.parallel.ai, verified 2026-04-22).
  //
  // Each handler surfaces the API error body on non-2xx so the LLM can
  // reason about failure rather than seeing an opaque HTTP status.
  // ──────────────────────────────────────────────────────────────────────────

  private readonly PARALLEL_BASE = "https://api.parallel.ai/v1";

  private async parallelFetch(
    scope: ScopeTuple,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  ): Promise<unknown> {
    const apiKey = await this.scopedEnv.get(scope, "PARALLEL_API_KEY");
    if (!apiKey) {
      throw new Error(
        "parallel_web: PARALLEL_API_KEY not set in scope — link it under Settings → Environment Variables.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      const res = await fetch(`${this.PARALLEL_BASE}${path}`, {
        method: init.method,
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Surface the raw error body so the model can choose to retry /
        // change inputs. Truncate defensively.
        throw new Error(
          `Parallel ${init.method} ${path} failed: ${res.status} ${text.slice(0, 2000)}`,
        );
      }
      return (await res.json()) as unknown;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(
          `Parallel ${init.method} ${path} timed out after ${init.timeoutMs}ms.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async parallelSearch(scope: ScopeTuple, input: Record<string, unknown>) {
    const objective = String(input.objective ?? "").trim();
    const queriesRaw = input.searchQueries;
    if (!objective) throw new Error("parallel_search: objective is required");
    if (!Array.isArray(queriesRaw) || queriesRaw.length === 0) {
      throw new Error("parallel_search: searchQueries must be a non-empty array");
    }
    const searchQueries = queriesRaw
      .map((q) => String(q))
      .filter((q) => q.trim().length > 0)
      .slice(0, 10);
    if (searchQueries.length === 0) {
      throw new Error("parallel_search: searchQueries must contain at least one non-empty string");
    }

    const body = await this.parallelFetch(scope, "/search", {
      method: "POST",
      body: { objective, search_queries: searchQueries },
      timeoutMs: 30_000,
    });
    return body;
  }

  private async parallelExtract(scope: ScopeTuple, input: Record<string, unknown>) {
    const urlsRaw = input.urls;
    const objective = String(input.objective ?? "").trim();
    if (!Array.isArray(urlsRaw) || urlsRaw.length === 0) {
      throw new Error("parallel_extract: urls must be a non-empty array");
    }
    if (!objective) throw new Error("parallel_extract: objective is required");
    const urls = urlsRaw
      .map((u) => String(u))
      .filter((u) => /^https?:\/\//.test(u))
      .slice(0, 5);
    if (urls.length === 0) {
      throw new Error("parallel_extract: urls must contain at least one http(s) URL");
    }

    // Extraction is slower than search — JS-rendered pages and PDFs can take
    // 45-120s on Parallel.ai. Use a 90s timeout.
    const body = await this.parallelFetch(scope, "/extract", {
      method: "POST",
      body: { urls, objective },
      timeoutMs: 90_000,
    });
    return body;
  }

  private async parallelDeepResearch(scope: ScopeTuple, input: Record<string, unknown>) {
    const instructions = String(input.instructions ?? "").trim();
    if (!instructions) {
      throw new Error("parallel_deep_research: instructions is required");
    }
    const processor = String(input.processor ?? "base");
    const allowedProcessors = new Set(["lite", "base", "core", "pro", "ultra", "ultra8x"]);
    if (!allowedProcessors.has(processor)) {
      throw new Error(
        `parallel_deep_research: unknown processor "${processor}" (allowed: ${[...allowedProcessors].join(", ")})`,
      );
    }

    const runBody: Record<string, unknown> = { input: instructions, processor };
    if (input.outputSchema !== undefined && input.outputSchema !== null) {
      runBody.output_schema = input.outputSchema;
    }

    // 1. Kick off the run (fast, ~2s).
    const created = (await this.parallelFetch(scope, "/tasks/runs", {
      method: "POST",
      body: runBody,
      timeoutMs: 30_000,
    })) as { run_id?: string; id?: string; status?: string } | null;

    const runId = created?.run_id ?? created?.id;
    if (!runId) {
      throw new Error(
        `parallel_deep_research: Parallel did not return a run_id (got ${JSON.stringify(created).slice(0, 500)})`,
      );
    }

    // 2. Poll with 15-second long-poll intervals, up to 5 minutes total.
    //    This keeps individual HTTP requests short so no NestJS/proxy timeout
    //    is hit. If research takes longer than 5 min, return the runId so
    //    the LLM can call parallel_deep_research_result to check back.
    const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes
    const POLL_TIMEOUT_S = 15;
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      try {
        const result = (await this.parallelFetch(
          scope,
          `/tasks/runs/${encodeURIComponent(runId)}/result?timeout=${POLL_TIMEOUT_S}`,
          { method: "GET", timeoutMs: (POLL_TIMEOUT_S + 5) * 1000 },
        )) as { status?: string; output?: unknown; result?: unknown } | null;

        // Parallel returns 200 with the result when done, or may return a
        // status field indicating still running.
        if (result && (result.output !== undefined || result.result !== undefined)) {
          return { runId, result: result.output ?? result.result };
        }
        if (result?.status && result.status !== "running" && result.status !== "pending") {
          return { runId, result };
        }
        // Still running — loop continues.
      } catch (pollErr: any) {
        // Timeout from this poll interval — continue polling.
        if (pollErr?.name === "AbortError" || (pollErr?.message ?? "").includes("timed out")) {
          continue;
        }
        throw pollErr;
      }
    }

    // Still running after 5 minutes. Return the runId so the LLM can check
    // back using parallel_deep_research_result.
    return {
      runId,
      status: "running",
      message:
        "Deep research is still running after 5 minutes. Call `parallel_deep_research_result` with this `runId` to check for completion. Parallel Pro/Ultra tasks can take 10–30 minutes.",
    };
  }

  private async parallelDeepResearchResult(scope: ScopeTuple, input: Record<string, unknown>) {
    const runId = String(input.runId ?? "").trim();
    if (!runId) throw new Error("parallel_deep_research_result: runId is required");

    // Short poll — wait up to 30 seconds for the result.
    try {
      const result = (await this.parallelFetch(
        scope,
        `/tasks/runs/${encodeURIComponent(runId)}/result?timeout=30`,
        { method: "GET", timeoutMs: 35_000 },
      )) as { status?: string; output?: unknown; result?: unknown } | null;

      if (result && (result.output !== undefined || result.result !== undefined)) {
        return { runId, status: "done", result: result.output ?? result.result };
      }
      return { runId, status: result?.status ?? "running", raw: result };
    } catch (err: any) {
      if (err?.name === "AbortError" || (err?.message ?? "").includes("timed out")) {
        return { runId, status: "running", message: "Still running. Try again in a minute." };
      }
      throw err;
    }
  }

  private async parallelFindall(scope: ScopeTuple, input: Record<string, unknown>) {
    const criteria = String(input.criteria ?? "").trim();
    const schema = input.schema;
    if (!criteria) throw new Error("parallel_findall: criteria is required");
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error("parallel_findall: schema must be a JSON Schema object");
    }

    // 1. Kick off the find-all run.
    const created = (await this.parallelFetch(scope, "/findall_runs", {
      method: "POST",
      body: { criteria, schema },
      timeoutMs: 30_000,
    })) as { run_id?: string } | null;
    const runId = created?.run_id;
    if (!runId) {
      throw new Error(
        `parallel_findall: Parallel did not return a run_id (got ${JSON.stringify(created).slice(0, 500)})`,
      );
    }

    // 2. Fetch the result. findall is typically faster than deep research;
    //    cap at 30min durable-await.
    const result = await this.parallelFetch(
      scope,
      `/findall_runs/${encodeURIComponent(runId)}/result`,
      { method: "GET", timeoutMs: 1_800_000 },
    );
    return { runId, result };
  }

  private async parallelMonitorCreate(scope: ScopeTuple, input: Record<string, unknown>) {
    const url = String(input.url ?? "").trim();
    // Accept both `criteria` (manifest field name) and `query` (API field name).
    const query = String(input.query ?? input.criteria ?? "").trim();
    const webhookUrl =
      typeof input.webhookUrl === "string" && input.webhookUrl.trim()
        ? String(input.webhookUrl).trim()
        : undefined;
    const frequency = input.frequency ?? undefined;
    if (!/^https?:\/\//.test(url)) {
      throw new Error("parallel_monitor_create: url must be http(s)");
    }
    if (!query) throw new Error("parallel_monitor_create: criteria (query) is required");
    if (webhookUrl !== undefined && !/^https?:\/\//.test(webhookUrl)) {
      throw new Error("parallel_monitor_create: webhookUrl must be http(s) if provided");
    }

    // Parallel.ai v1alpha monitors API: POST /v1alpha/monitors
    // Note: PARALLEL_BASE is already "https://api.parallel.ai/v1" so we
    // construct the v1alpha path by stripping the /v1 suffix and prepending /v1alpha.
    const apiKey = await this.scopedEnv.get(scope, "PARALLEL_API_KEY");
    if (!apiKey) {
      throw new Error(
        "parallel_web: PARALLEL_API_KEY not set in scope — link it under Settings → Environment Variables.",
      );
    }
    const monitorBody: Record<string, unknown> = { url, query };
    if (frequency !== undefined) monitorBody.frequency = frequency;
    if (webhookUrl) monitorBody.webhook_url = webhookUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Record<string, unknown> | null = null;
    try {
      const httpRes = await fetch("https://api.parallel.ai/v1alpha/monitors", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(monitorBody),
        signal: controller.signal,
      });
      if (!httpRes.ok) {
        const text = await httpRes.text().catch(() => "");
        throw new Error(
          `Parallel POST /v1alpha/monitors failed: ${httpRes.status} ${text.slice(0, 2000)}`,
        );
      }
      res = (await httpRes.json()) as Record<string, unknown>;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error("Parallel POST /v1alpha/monitors timed out after 15000ms.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const monitorId = res?.monitor_id ?? res?.id;
    if (!monitorId) {
      throw new Error(
        `parallel_monitor_create: Parallel did not return a monitor_id (got ${JSON.stringify(res).slice(0, 500)})`,
      );
    }
    return { monitorId, raw: res };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // platos.csv_ops — CSV / TSV / XLSX / Google Sheets
  //
  // V1 scope:
  //   - .csv / .tsv : full support via native string parsing (no papaparse dep
  //     in the agent tree — keeps the skill zero-dep).
  //   - .xlsx : TODO(W.2.1) — needs a parser dep (exceljs / xlsx) before we
  //     can list sheets or read rows. Returns a clear not-yet-supported error.
  //   - Google Sheets read : public CSV export (`/export?format=csv&gid=<gid>`).
  //   - Google Sheets write : TODO(W.2.2) — requires googleapis + OAuth. Needs
  //     GOOGLE_SHEETS_CREDENTIALS at execution time; env is declared
  //     `required_env` on the manifest but only enforced for gsheet ops here.
  //   - s3:// : explicit not-supported error.
  //
  // Per-tool timeouts:
  //   - csv_list_sheets : 10s
  //   - csv_read_sheet  : 60s
  //   - csv_read_line   : 20s
  //   - csv_write_cell  : 15s
  //
  // All outbound HTTP goes through fetchWithValidatedRedirects so the source
  // can't be pointed at internal IPs / AWS IMDS. Same SSRF posture as
  // platos.web_search:fetch_url.
  // ──────────────────────────────────────────────────────────────────────────

  /** Parsed representation of a spreadsheet source location. */
  private parseCsvSource(source: string): {
    kind: "csv" | "tsv" | "xlsx" | "gsheet" | "s3" | "unknown";
    url?: string;
    sheetId?: string;
  } {
    const trimmed = source.trim();
    if (!trimmed) return { kind: "unknown" };

    if (trimmed.startsWith("s3://")) {
      return { kind: "s3" };
    }

    // gsheet://<sheetId>
    if (trimmed.startsWith("gsheet://")) {
      const sheetId = trimmed.slice("gsheet://".length).split("/")[0]?.trim();
      return { kind: "gsheet", sheetId };
    }

    // https://docs.google.com/spreadsheets/d/<id>/...
    const gsheetMatch = trimmed.match(
      /^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/i,
    );
    if (gsheetMatch) {
      return { kind: "gsheet", sheetId: gsheetMatch[1], url: trimmed };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const path = trimmed.split("?")[0].toLowerCase();
      if (path.endsWith(".tsv")) return { kind: "tsv", url: trimmed };
      if (path.endsWith(".xlsx")) return { kind: "xlsx", url: trimmed };
      // Default any other http(s) source to CSV — common for
      // content-disposition downloads without an extension.
      return { kind: "csv", url: trimmed };
    }

    return { kind: "unknown" };
  }

  /** Build the public Google Sheets CSV export URL for a given sheetId + gid. */
  private gsheetCsvExportUrl(sheetId: string, gid: string = "0"): string {
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
      sheetId,
    )}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  }

  /**
   * Parse a CSV/TSV string into headers + rows. Handles:
   *   - Quoted fields with embedded delimiters + newlines
   *   - Escaped quotes ("")
   *   - CRLF + LF line endings
   *   - Empty trailing lines
   *
   * Conforms to RFC 4180 for the common cases. Deliberately zero-dep — if
   * the agent tree ever adds papaparse, swap this out for `Papa.parse`.
   */
  private parseCsvText(
    text: string,
    delimiter: "," | "\t",
  ): { headers: string[]; rows: string[][] } {
    const records: string[][] = [];
    let field = "";
    let record: string[] = [];
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < n && text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === delimiter) {
        record.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (ch === "\r") {
        // Swallow CRLF as a single newline.
        if (i + 1 < n && text[i + 1] === "\n") i += 1;
        record.push(field);
        records.push(record);
        field = "";
        record = [];
        i += 1;
        continue;
      }
      if (ch === "\n") {
        record.push(field);
        records.push(record);
        field = "";
        record = [];
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }

    // Flush final field/record if the file didn't end on a newline.
    if (field.length > 0 || record.length > 0) {
      record.push(field);
      records.push(record);
    }

    // Drop trailing blank records (single empty field, no content).
    while (
      records.length > 0 &&
      records[records.length - 1].length === 1 &&
      records[records.length - 1][0] === ""
    ) {
      records.pop();
    }

    if (records.length === 0) {
      return { headers: [], rows: [] };
    }
    const [headerRow, ...rest] = records;
    return { headers: headerRow.map((h) => h.trim()), rows: rest };
  }

  /**
   * Parse an A1 range like "A2:D50" into zero-indexed row + column bounds.
   * Open-ended sides (e.g. "A2:A") are supported by returning Infinity.
   * Returns null if the range is malformed.
   */
  private parseA1Range(range: string): {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  } | null {
    const m = range
      .trim()
      .toUpperCase()
      .match(/^([A-Z]+)?(\d+)?:([A-Z]+)?(\d+)?$/);
    if (!m) return null;
    const [, startColStr, startRowStr, endColStr, endRowStr] = m;
    const colToIndex = (s?: string) => {
      if (!s) return undefined;
      let n = 0;
      for (const c of s) n = n * 26 + (c.charCodeAt(0) - 64);
      return n - 1;
    };
    const startRow = startRowStr ? Number(startRowStr) - 1 : 0;
    const endRow = endRowStr ? Number(endRowStr) - 1 : Number.POSITIVE_INFINITY;
    const startCol = colToIndex(startColStr) ?? 0;
    const endCol = colToIndex(endColStr) ?? Number.POSITIVE_INFINITY;
    return { startRow, endRow, startCol, endCol };
  }

  /**
   * Fetch + parse a CSV/TSV source into `{headers, rows}`. Throws a clear
   * error for xlsx (deferred), s3 (out of scope), gsheet-without-id, and
   * SSRF-flagged URLs.
   *
   * When `gsheetCredentials` is required (write path), the caller must
   * gate that separately — this helper does read-only work via the public
   * CSV export for Google Sheets.
   */
  private async loadCsvFromSource(
    source: string,
    opts: { timeoutMs: number; gsheetGid?: string },
  ): Promise<{
    kind: "csv" | "tsv" | "gsheet";
    headers: string[];
    rows: string[][];
  }> {
    const parsed = this.parseCsvSource(source);
    switch (parsed.kind) {
      case "s3":
        throw new Error("csv_ops: s3:// sources are not supported yet.");
      case "unknown":
        throw new Error(
          "csv_ops: source must be an http(s) URL to .csv/.tsv/.xlsx, `gsheet://<id>`, or a Google Sheets URL.",
        );
      case "xlsx":
        throw new Error(
          "csv_ops: XLSX reads are not supported yet — TODO(W.2.1) ship xlsx parser. Export the sheet as CSV for now.",
        );
      case "csv":
      case "tsv": {
        if (!parsed.url) throw new Error("csv_ops: missing URL for http source.");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        try {
          const res = await fetchWithValidatedRedirects(parsed.url, 3, {
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new Error(
              `csv_ops: fetch failed (${res.status}) for ${parsed.url}`,
            );
          }
          const text = await res.text();
          const delimiter = parsed.kind === "tsv" ? "\t" : ",";
          const { headers, rows } = this.parseCsvText(text, delimiter);
          return { kind: parsed.kind, headers, rows };
        } catch (err: any) {
          if (err?.name === "AbortError") {
            throw new Error(
              `csv_ops: fetch timed out after ${opts.timeoutMs}ms for ${parsed.url}`,
            );
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
      case "gsheet": {
        if (!parsed.sheetId) {
          throw new Error("csv_ops: could not extract sheet id from source.");
        }
        const exportUrl = this.gsheetCsvExportUrl(
          parsed.sheetId,
          opts.gsheetGid ?? "0",
        );
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        try {
          const res = await fetchWithValidatedRedirects(exportUrl, 3, {
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new Error(
              `csv_ops: Google Sheets export failed (${res.status}). Ensure the sheet is shared publicly or that a credentialed read path is wired (TODO W.2.2).`,
            );
          }
          const text = await res.text();
          const { headers, rows } = this.parseCsvText(text, ",");
          return { kind: "gsheet", headers, rows };
        } catch (err: any) {
          if (err?.name === "AbortError") {
            throw new Error(
              `csv_ops: Google Sheets export timed out after ${opts.timeoutMs}ms`,
            );
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }

  private async csvListSheets(scope: ScopeTuple, input: Record<string, unknown>) {
    const source = String(input.source ?? "").trim();
    if (!source) throw new Error("csv_list_sheets: source is required");
    const parsed = this.parseCsvSource(source);

    // gsheet with credentials would list all tabs via googleapis — deferred.
    // For V1 we list only the default tab (gid=0).
    void scope;
    if (parsed.kind === "xlsx") {
      throw new Error(
        "csv_list_sheets: XLSX sheet listing is not supported yet — TODO(W.2.1).",
      );
    }
    if (parsed.kind === "s3") {
      throw new Error("csv_list_sheets: s3:// sources are not supported yet.");
    }
    if (parsed.kind === "unknown") {
      throw new Error(
        "csv_list_sheets: source must be an http(s) URL to .csv/.tsv/.xlsx, `gsheet://<id>`, or a Google Sheets URL.",
      );
    }

    const loaded = await this.loadCsvFromSource(source, { timeoutMs: 10_000 });
    const syntheticName = parsed.kind === "gsheet" ? "Sheet1" : "Sheet1";
    // For gsheets, listing every tab requires googleapis (TODO W.2.2). V1
    // returns the default export tab with a note so the LLM knows.
    return {
      sheets: [
        {
          name: syntheticName,
          rowCount: loaded.rows.length,
          note:
            parsed.kind === "gsheet"
              ? "Only the default tab (gid=0) is enumerated in V1. TODO(W.2.2) adds full tab enumeration via googleapis."
              : undefined,
        },
      ],
    };
  }

  private async csvReadSheet(scope: ScopeTuple, input: Record<string, unknown>) {
    void scope;
    const source = String(input.source ?? "").trim();
    if (!source) throw new Error("csv_read_sheet: source is required");
    const maxRowsRaw = Number(input.maxRows ?? 5000);
    const maxRows = Math.max(1, Math.min(100_000, Math.floor(maxRowsRaw)));
    const rangeStr = typeof input.range === "string" ? input.range : undefined;
    const sheetName = typeof input.sheet === "string" ? input.sheet : undefined;
    // V1: `sheet` parameter is accepted but ignored for CSV/TSV and for
    // gsheet (default tab). TODO(W.2.2) honours it via googleapis.
    void sheetName;

    const loaded = await this.loadCsvFromSource(source, { timeoutMs: 60_000 });
    let { headers, rows } = loaded;
    let startRow = 0;

    if (rangeStr) {
      const range = this.parseA1Range(rangeStr);
      if (!range) {
        throw new Error(
          `csv_read_sheet: invalid A1 range "${rangeStr}" — expected e.g. "A2:D50".`,
        );
      }
      // Range row indexes are 1-indexed including the header in A1 world.
      // We treat row 1 as the header row and data rows as 0-indexed in `rows`.
      // If range starts at row 1, include headers as-is; otherwise shift.
      const dataStart = Math.max(0, range.startRow - 1);
      const dataEnd =
        range.endRow === Number.POSITIVE_INFINITY
          ? rows.length
          : Math.max(0, range.endRow); // exclusive upper bound after -1+1
      rows = rows.slice(dataStart, dataEnd);
      startRow = dataStart;
      if (Number.isFinite(range.endCol) || range.startCol > 0) {
        const endCol =
          range.endCol === Number.POSITIVE_INFINITY
            ? headers.length
            : range.endCol + 1;
        const startCol = range.startCol;
        headers = headers.slice(startCol, endCol);
        rows = rows.map((r) => r.slice(startCol, endCol));
      }
    }

    const totalRows = rows.length;
    const truncated = totalRows > maxRows;
    const sliced = truncated ? rows.slice(0, maxRows) : rows;
    const objectRows: Array<Record<string, string>> = sliced.map((r) => {
      const o: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        o[headers[i] || `col_${i}`] = r[i] ?? "";
      }
      return o;
    });

    return {
      headers,
      rows: objectRows,
      totalRows,
      truncated,
      startRow,
    };
  }

  private async csvReadLine(scope: ScopeTuple, input: Record<string, unknown>) {
    void scope;
    const source = String(input.source ?? "").trim();
    const lineNumber = Math.floor(Number(input.lineNumber ?? 0));
    if (!source) throw new Error("csv_read_line: source is required");
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      throw new Error("csv_read_line: lineNumber must be an integer >= 1");
    }

    const loaded = await this.loadCsvFromSource(source, { timeoutMs: 20_000 });
    const { headers, rows } = loaded;
    const idx = lineNumber - 1;
    if (idx >= rows.length) {
      throw new Error(
        `csv_read_line: lineNumber ${lineNumber} is out of range (source has ${rows.length} data rows).`,
      );
    }
    const r = rows[idx];
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i] || `col_${i}`] = r[i] ?? "";
    }
    return { row, headers };
  }

  private async csvWriteCell(scope: ScopeTuple, input: Record<string, unknown>) {
    const source = String(input.source ?? "").trim();
    const sheetName = String(input.sheet ?? "").trim();
    const cell = String(input.cell ?? "").trim();
    const value = String(input.value ?? "");
    if (!source) throw new Error("csv_write_cell: source is required");
    if (!sheetName) throw new Error("csv_write_cell: sheet is required");
    if (!/^[A-Za-z]+[0-9]+$/.test(cell)) {
      throw new Error(
        'csv_write_cell: cell must be an A1 reference like "B3".',
      );
    }

    const parsed = this.parseCsvSource(source);
    if (parsed.kind !== "gsheet") {
      throw new Error(
        "csv_write_cell: only Google Sheets sources are writable. Plain CSV/TSV/XLSX URLs are read-only.",
      );
    }

    const credentials = await this.scopedEnv.get(scope, "GOOGLE_SHEETS_CREDENTIALS");
    if (!credentials) {
      throw new Error(
        "csv_write_cell: GOOGLE_SHEETS_CREDENTIALS not set in scope — link it under Settings → Environment Variables.",
      );
    }

    // TODO(W.2.2): implement the live write path via googleapis
    //   (spreadsheets.values.update, range `<sheetName>!<cell>`). V1 surfaces
    //   a clear "not yet implemented" error rather than silently succeeding.
    this.logger.warn(
      `csv_write_cell called (sheetId=${parsed.sheetId} sheet=${sheetName} cell=${cell}) but googleapis write path is not yet wired.`,
    );
    return {
      stub: true,
      sheetId: parsed.sheetId,
      sheet: sheetName,
      cell,
      valuePreview: value.slice(0, 200),
      message:
        "csv_write_cell is scaffolded with credential + scope validation. Wire the googleapis spreadsheets.values.update call in a follow-up (TODO W.2.2).",
    };
  }
}
